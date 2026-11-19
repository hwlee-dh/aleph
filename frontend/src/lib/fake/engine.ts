/*
 * 실행 흉내. 실제 모델은 없고, 보낸 말에서 낱말을 찾아 정해 둔 대본대로 이벤트를 흘린다.
 * 이벤트의 모양과 순서는 backend/API.md 6절을 따른다.
 */
import { ApiError } from "../errors";
import { SUMMARY_TOOL, type Compacted, type Mode, type Preset, type RunEvent, type ToolDef, type ToolRun } from "../types";
import { agentToolLabel, COMPOSE_POOL, CONTINUE_POOL, CRITIQUE_POOL, fill, josa, META, REWRITES } from "./data";
import { db, save, session } from "./persist";
import {
  addScene,
  appendEvent,
  attachSummary,
  baseName,
  chapterName,
  clone,
  closeLostRun,
  conversationOf,
  cutText,
  effectiveModel,
  expandIncludes,
  findIncludes,
  firstSentence,
  getPreset,
  headOf,
  isLocked,
  joinPieces,
  locate,
  manuscriptChars,
  mergeScenes,
  modelUsable,
  moveScene,
  nameFromRequest,
  now,
  orderedScenes,
  sceneName,
  scenesToSummarize,
  splitScene,
  textOf,
  writeDoc,
  writeInput,
  writeOutput,
  type Extra,
  type FakeConversation,
  type FakeScene,
  type FakeSession,
} from "./state";

const APPROVE = "승인";
const REJECT = "반려";

/** 중단되면 기다리던 자리에서 이것이 던져진다. */
class Stopped extends Error {}

type Zone = "input" | "material" | "manuscript";
type Outcome = { status: "done"; changed: string[] } | { status: "locked"; path: string } | { status: "rejected"; reason: string };
type ProposalFields = Pick<RunEvent, "action" | "path" | "dest" | "old" | "new" | "description" | "position" | "pieces" | "scenes">;
type Emitted = Omit<RunEvent, "seq" | "run_id" | "timestamp">;
/** 에이전트 도구 하나의 결과. trail은 읽기 에이전트가 본 것이다. */
type CallResult = { result: string; ok?: boolean; changed?: string[]; trail?: string[] };

/* ───────── 구독 ───────── */

interface Sub {
  runId: string;
  conversationId: string; // 그 실행이 도는 대화. 이벤트는 여기에 쌓인다
  index: number; // 다음에 볼 이벤트의 자리
  onEvent: (e: RunEvent) => void;
  onEnd: () => void;
  closed: boolean;
}

const runs = new Map<string, Run>(); // 작업 id → 진행 중인 실행. 작업에 하나뿐이다
const subs = new Map<string, Set<Sub>>();

function flush(s: FakeSession, sub: Sub): void {
  const events = s.conversations.find((c) => c.id === sub.conversationId)?.events ?? [];
  while (!sub.closed && sub.index < events.length) {
    const e = events[sub.index++];
    if (e.run_id !== sub.runId) continue;
    try {
      sub.onEvent(clone(e));
    } catch (err) {
      console.error(err);
    }
  }
  if (!sub.closed && !(s.run.running && s.run.run_id === sub.runId)) endSub(s.id, sub);
}

function endSub(sessionId: string, sub: Sub): void {
  sub.closed = true;
  subs.get(sessionId)?.delete(sub);
  try {
    sub.onEnd();
  } catch (err) {
    console.error(err);
  }
}

function notify(s: FakeSession): void {
  for (const sub of [...(subs.get(s.id) ?? [])]) flush(s, sub);
}

/** 진행 중인 실행의 이벤트를 처음부터 받는다. 이미 지난 것은 바로 오고, 끝나면 onEnd. */
export function subscribe(sessionId: string, onEvent: (e: RunEvent) => void, onEnd: () => void): () => void {
  const s = db().sessions.find((x) => x.id === sessionId);
  if (s) reconcile(s);
  const sub: Sub = { runId: s?.run.run_id ?? "", conversationId: s?.run.conversation_id ?? "", index: 0, onEvent, onEnd, closed: false };
  const events = s?.conversations.find((c) => c.id === sub.conversationId)?.events;
  if (!s || !events || !s.run.running || !s.run.run_id) {
    // 진행 중인 실행이 없으면 보낼 것도 없다.
    void Promise.resolve().then(() => {
      if (!sub.closed) endSub(sessionId, sub);
    });
  } else {
    sub.index = Math.max(0, events.findIndex((e) => e.run_id === sub.runId));
    if (!subs.has(sessionId)) subs.set(sessionId, new Set());
    subs.get(sessionId)!.add(sub);
    // 돌려준 함수를 받기도 전에 불리지 않도록 한 박자 늦춘다.
    void Promise.resolve().then(() => {
      if (!sub.closed) flush(s, sub);
    });
  }
  return () => {
    sub.closed = true;
    subs.get(sessionId)?.delete(sub);
  };
}

/* ───────── 실행 하나 ───────── */

class Run {
  readonly id: string;
  readonly s: FakeSession;
  readonly conv: FakeConversation; // 이 실행의 기록이 붙는 대화
  readonly kind: "agent" | "tool";
  readonly preset: Preset;
  readonly mode: Mode;
  readonly bypass: boolean;
  readonly model: string;
  readonly started = Date.now();
  cancelled = false;
  abort: (() => void) | null = null; // 지금 기다리는 것을 끊는다
  pending: { eventId: string; resolve: (response: string) => void } | null = null;
  calls = 0;
  private parts = 0;
  private chars = 0; // 이번 실행에서 모델이 읽고 쓴 글자 수 (컨텍스트가 늘어나는 양)
  private written = 0;

  constructor(s: FakeSession, conv: FakeConversation, kind: "agent" | "tool") {
    const st = db();
    this.id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.s = s;
    this.conv = conv;
    this.kind = kind;
    // 모드, 모델, 프리셋, 권한 무시는 시작할 때의 작업 상태에서 읽는다.
    this.preset = getPreset(st, s.state.preset_id);
    this.mode = s.state.mode;
    this.bypass = s.state.bypass_locks;
    this.model = effectiveModel(st, s);
  }

  /** 중단 여부와 상관없이 이벤트를 남긴다. */
  push(e: Emitted): RunEvent {
    const s = this.s;
    const event: RunEvent = { ...e, seq: ++s.seq, run_id: this.id, conversation_id: this.conv.id, timestamp: now() };
    appendEvent(this.conv, event);
    save();
    notify(s);
    return event;
  }

  emit(e: Emitted): RunEvent {
    if (this.cancelled) throw new Stopped();
    return this.push(e);
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Stopped());
      const timer = setTimeout(() => {
        this.abort = null;
        resolve();
      }, ms);
      this.abort = () => {
        clearTimeout(timer);
        reject(new Stopped());
      };
    });
  }

  private async stream(type: "text" | "thinking", text: string): Promise<void> {
    const id = `${this.id}-p${++this.parts}`;
    const steps = Math.min(7, Math.max(2, Math.ceil(text.length / 14)));
    const size = Math.ceil(text.length / steps);
    for (let i = 0; i < text.length; i += size) {
      await this.wait(65);
      this.emit({ type: type === "text" ? "text_delta" : "thinking_delta", id, delta: text.slice(i, i + size) });
    }
    this.emit({ type, id, text });
    this.written += text.length;
    this.chars += text.length;
  }

  /** 에이전트의 말. */
  say(text: string): Promise<void> {
    return this.stream("text", text);
  }

  think(text: string): Promise<void> {
    return this.stream("thinking", text);
  }

  askId(): string {
    return `${this.id}-q${++this.parts}`;
  }

  /** 사용자에게 묻고 답을 기다린다. */
  ask(payload: Omit<Emitted, "type">, event_id = this.askId()): Promise<string> {
    this.s.run.waiting = true;
    this.emit({ ...payload, type: "user_input_required", event_id });
    return new Promise<string>((resolve, reject) => {
      this.pending = { eventId: event_id, resolve };
      this.abort = () => reject(new Stopped());
    });
  }

  /** 에이전트의 기본 도구 호출 하나. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    work: (toolCallId: string) => Promise<CallResult> | CallResult,
  ): Promise<void> {
    const tool_call_id = `${this.id}-c${++this.calls}`;
    this.emit({
      type: "tool_call",
      tool,
      label: agentToolLabel(tool),
      tool_call_id,
      args,
      tool_call_index: this.calls,
      user_tool: false,
    });
    await this.wait(380);
    const r = await work(tool_call_id);
    this.chars += r.result.length;
    this.emit({ type: "tool_result", tool, tool_call_id, result: r.result, ok: r.ok !== false, changed: r.changed ?? [], ...(r.trail ? { trail: r.trail } : {}) });
  }

  /** 이 모드에서 확인을 받아야 하는 변경인가. */
  private needsConfirm(zone: Zone): boolean {
    if (this.mode === "manual") return true;
    if (this.mode === "auto") return zone === "manuscript";
    return false;
  }

  /** 에이전트의 문서 변경 하나: 수정 방지를 보고, 모드에 따라 확인을 받고, 적용한다. */
  async change(opts: {
    tool: string;
    args: Record<string, unknown>;
    zone: Zone;
    lockPaths: string[];
    proposal: ProposalFields;
    result: string;
    apply: (extra: Extra) => string[];
  }): Promise<Outcome> {
    let outcome: Outcome = { status: "done", changed: [] };
    await this.call(opts.tool, opts.args, async (toolCallId) => {
      const lockedPath = this.bypass ? undefined : opts.lockPaths.find((p) => isLocked(this.s, p));
      if (lockedPath) {
        outcome = { status: "locked", path: lockedPath };
        return { result: `수정 방지가 걸려 있어 바꾸지 못했습니다: ${lockedPath}`, ok: false };
      }
      const extra: Extra = { origin: { tool_call_id: toolCallId, model: this.model } };
      if (this.needsConfirm(opts.zone)) {
        const pendingId = this.askId();
        const answer = (
          await this.ask(
            {
              kind: "proposal",
              question: opts.proposal.description,
              options: [APPROVE, REJECT],
              dest: null,
              old: null,
              new: null,
              by: "agent",
              ...opts.proposal,
            },
            pendingId,
          )
        ).trim();
        if (answer !== APPROVE) {
          const reason = answer === REJECT ? "" : answer;
          outcome = { status: "rejected", reason };
          return { result: `사용자가 이 변경을 반려했습니다${reason ? ` — ${reason}` : ""}. 아무것도 바뀌지 않았습니다.`, ok: false };
        }
        extra.proposal = { id: pendingId, status: "accepted", note: "" };
      }
      const changed = opts.apply(extra);
      outcome = { status: "done", changed };
      return { result: opts.result, changed };
    });
    return outcome;
  }

  /** 도구가 쓸 모델: 도구에 적힌 것 → 프리셋의 보조 모델 → 에이전트 모델. 쓸 수 없는 것은 건너뛴다. */
  toolModel(def: ToolDef): string {
    return [def.model, this.preset.auxiliary_model].find((m) => modelUsable(db(), m)) ?? this.model;
  }

  /** 사용자가 만든 도구를 돌린다. 입력을 읽고 출력에 쓴다. */
  async tool(def: ToolDef, by: "agent" | "user"): Promise<Outcome> {
    const s = this.s;
    const raw = s.input.content;
    const input = expandIncludes(s, raw);
    const tool_call_id = `${this.id}-c${++this.calls}`;
    const model = this.toolModel(def);
    this.emit({
      type: "tool_call",
      tool: def.name,
      label: def.label,
      tool_call_id,
      args: {},
      tool_call_index: this.calls,
      user_tool: true,
    });
    if (by === "agent" && this.mode === "manual") {
      const answer = (
        await this.ask({ kind: "tool_confirm", tool: def.name, label: def.label, input, question: `〈${def.label}〉 도구를 돌릴까요?`, options: [APPROVE, REJECT] })
      ).trim();
      if (answer !== APPROVE) {
        const reason = answer === REJECT ? "" : answer;
        this.emit({ type: "tool_result", tool: def.name, tool_call_id, result: `사용자가 실행을 반려했습니다${reason ? ` — ${reason}` : ""}.`, ok: false, changed: [] });
        return { status: "rejected", reason };
      }
    }
    const started = Date.now();
    await this.wait(300);
    const text = produce(def, s, raw, input, model);
    const steps = 32;
    const size = Math.max(1, Math.ceil(text.length / steps));
    for (let i = 0; i < text.length; i += size) {
      await this.wait(100);
      this.emit({ type: "tool_stream", tool: def.name, tool_call_id, delta: text.slice(i, i + size) });
    }
    const duration_ms = Date.now() - started;
    const run_seq = logToolRun(s, { tool: def.name, label: def.label, by, model, duration_ms, input, input_raw: raw, output: text, error: null, target: null, tool_call_id });
    writeOutput(s, text, `tool:${def.name}`, def.name, {
      origin: { tool_call_id, model },
      tool_run: { tool: def.name, label: def.label, model, duration_ms, run_seq },
    });
    this.chars += input.length + text.length;
    this.written += text.length;
    this.emit({ type: "tool_result", tool: def.name, tool_call_id, result: `${text.length}자를 출력에 썼습니다.`, ok: true, changed: ["출력"] });
    return { status: "done", changed: ["출력"] };
  }

  /** 실행을 맺는다. 그 대화의 컨텍스트는 실행마다 조금씩 늘어난다. */
  finish(status: "completed" | "stopped" | "error"): void {
    const s = this.s;
    const conv = this.conv;
    if (runs.get(s.id) !== this) return;
    runs.delete(s.id);
    const before = conv.contextTokens;
    conv.contextTokens = before + 350 + Math.round(this.chars * 0.7);
    s.run = { run_id: this.id, conversation_id: conv.id, running: false, status, waiting: false };
    this.push({
      type: "done",
      status,
      total_tool_calls: this.calls,
      elapsed_sec: Math.round((Date.now() - this.started) / 100) / 10,
      usage: {
        agent_model: this.model,
        prompt_tokens: conv.contextTokens,
        output_tokens: Math.round(this.written * 0.7),
        cache_read_tokens: Math.round(before * 0.9),
        cost_usd: Math.round((conv.contextTokens * 1.25 + this.written * 7) / 100) / 10000,
        context_tokens: conv.contextTokens,
      },
    });
  }
}

/** 도구 실행 기록에 한 줄을 더하고 그 번호를 돌려준다. 백 줄을 넘으면 오래된 것부터 버린다. */
function logToolRun(s: FakeSession, row: Omit<ToolRun, "seq" | "timestamp">): number {
  const seq = (s.toolRuns[s.toolRuns.length - 1]?.seq ?? 0) + 1;
  s.toolRuns.push({ seq, timestamp: now(), ...row });
  if (s.toolRuns.length > 100) s.toolRuns.splice(0, s.toolRuns.length - 100);
  return seq;
}

/**
 * 실행을 시작한다. 요청을 받은 대화가 보고 있는 대화가 되고, 이름이 없었으면 `request`의 첫 줄이 이름이 된다.
 * 돌려주는 값에는 실제 엔진처럼 그 대화의 id도 있다.
 */
function launch(
  s: FakeSession,
  conv: FakeConversation,
  kind: "agent" | "tool",
  request: string,
  first: Emitted[],
  body: (r: Run) => Promise<void>,
): { run_id: string; conversation_id: string } {
  const r = new Run(s, conv, kind);
  runs.set(s.id, r);
  s.run = { run_id: r.id, conversation_id: conv.id, running: true, status: "running", waiting: false };
  s.state.conversation = conv.id;
  nameFromRequest(conv, request);
  r.push({ type: "run_started", kind, mode: r.mode, agent_model: r.model, preset_name: r.preset.name, bypass_locks: r.bypass });
  for (const e of first) r.push(e);
  void Promise.resolve()
    .then(() => body(r))
    .then(
      () => r.finish("completed"),
      (err: unknown) => {
        if (err instanceof Stopped) return; // 중단은 stopRun이 이미 맺었다
        console.error(err);
        r.push({ type: "error", error: err instanceof Error ? err.message : String(err) });
        r.finish("error");
      },
    );
  return { run_id: r.id, conversation_id: conv.id };
}

/**
 * 저장된 상태는 '실행 중'인데 실제로 도는 것이 없으면(개발 중에 이 파일만 새로 읽힌 경우 등) 중단된 것으로 맺는다.
 * 그러지 않으면 구독이 끝나지 않는다.
 */
export function reconcile(s: FakeSession): void {
  if (!s.run.running || runs.has(s.id)) return;
  closeLostRun(s);
  save();
  notify(s);
}

/** 한 작업에서는 한 번에 하나만 돈다. 입력과 출력이 작업에 하나뿐이라, 다른 대화에서 도는 중이어도 받지 않는다. */
function ensureIdle(s: FakeSession, conv: FakeConversation): void {
  reconcile(s);
  if (!runs.has(s.id)) return;
  throw new ApiError(
    409,
    s.run.conversation_id === conv.id ? "실행 중입니다. 끝나거나 멈춘 뒤에 다시 보내야 합니다" : "다른 대화에서 실행 중입니다. 끝나거나 멈춘 뒤에 다시 보내야 합니다",
  );
}

function ensureModel(s: FakeSession): void {
  if (!effectiveModel(db(), s)) throw new ApiError(400, "모델을 골라야 합니다. 프리셋에 모델이 없거나 그 모델의 제공자를 쓸 수 없습니다");
}

/** 에이전트에게 보내기. 대화를 안 적으면 지금 보고 있는 대화로 간다. */
export function startRun(sessionId: string, body: { goal: string; tool?: string; conversation?: string }): { run_id: string; conversation_id: string } {
  const s = session(sessionId);
  const conv = conversationOf(s, body.conversation);
  ensureIdle(s, conv);
  const goal = String(body.goal ?? "").trim();
  const preset = getPreset(db(), s.state.preset_id);
  const def = body.tool ? preset.tools.find((t) => t.name === body.tool) : undefined;
  if (body.tool && !def) throw new ApiError(404, `그런 도구가 없습니다: ${body.tool}`);
  if (!goal && !def) throw new ApiError(400, "보낼 말이 없습니다");
  ensureModel(s);
  const message: Emitted = { type: "user_message", text: goal, ...(def ? { tool: def.name } : {}) };
  return launch(s, conv, "agent", goal || `/${def?.label ?? ""}`, [message], (r) => agentScript(r, goal, def));
}

/** 에이전트를 거치지 않고 지금 입력으로 도구를 돌린다. 기록은 `conversation`(안 적으면 보고 있는 대화)에 붙는다. */
export function runTool(sessionId: string, name: string, conversation?: string): { run_id: string; conversation_id: string } {
  const s = session(sessionId);
  const conv = conversationOf(s, conversation);
  ensureIdle(s, conv);
  const def = getPreset(db(), s.state.preset_id).tools.find((t) => t.name === name);
  if (!def) throw new ApiError(404, `그런 도구가 없습니다: ${name}`);
  if (!s.input.content.trim()) throw new ApiError(400, "입력이 비어 있습니다. 입력에 글을 적은 뒤에 돌려야 합니다");
  ensureModel(s);
  return launch(s, conv, "tool", `/${def.label}`, [], async (r) => {
    await r.wait(250);
    await r.tool(def, "user");
  });
}

export function respond(sessionId: string, eventId: string, response: string): void {
  const r = runs.get(sessionId);
  if (!r || !r.pending || r.pending.eventId !== eventId) throw new ApiError(409, "답을 기다리는 질문이 아니다");
  const pending = r.pending;
  r.pending = null;
  r.abort = null;
  r.s.run.waiting = false;
  // 지금 엔진처럼 답을 대화에 먼저 남기고 기다리던 것을 푼다.
  r.push({ type: "user_message", text: response, in_reply_to: eventId });
  r.push({ type: "user_input_resolved", event_id: eventId, response });
  pending.resolve(response);
}

export function stopRun(sessionId: string): boolean {
  const r = runs.get(sessionId);
  if (!r) return false;
  r.cancelled = true;
  const abort = r.abort;
  r.abort = null;
  r.pending = null;
  r.finish("stopped");
  abort?.();
  return true;
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

const KEPT_MESSAGES = 4;

/**
 * 대화 앞부분을 요약으로 바꾼 흉내. 최근의 넷은 남긴다.
 * 마지막으로 줄인 뒤의 대화가 그보다 길지 않으면 줄일 것이 없어 null이고, 아무것도 바뀌지 않는다.
 */
function shrink(s: FakeSession, conv: FakeConversation): Required<Omit<Compacted, "compacted">> | null {
  const from = conv.events.reduce((at, e, i) => (e.type === "compaction" ? i + 1 : at), 0);
  const messages = conv.events.slice(from).filter((e) => ["user_message", "text", "tool_call", "tool_result"].includes(e.type)).length;
  if (messages <= KEPT_MESSAGES) return null;
  const tokens_before = conv.contextTokens;
  conv.contextTokens = Math.round(tokens_before * 0.35);
  return {
    kind: "summary",
    dropped_messages: messages - KEPT_MESSAGES,
    kept_messages: KEPT_MESSAGES,
    tokens_before,
    tokens_after: conv.contextTokens,
    summary: `지금까지의 대화를 줄였다. 원고는 ${s.chapters.length}장, ${orderedScenes(s).length}장면이다.`,
  };
}

/**
 * 지금 압축. 대화 하나(안 적으면 보고 있는 대화)를 한도를 넘지 않았어도 줄인다.
 * 그 대화의 기록 끝에 실행에 딸리지 않은 이벤트(seq와 run_id가 없다)로 남는다.
 */
export function compact(sessionId: string, conversation?: string): Compacted {
  const s = session(sessionId);
  const conv = conversationOf(s, conversation);
  reconcile(s);
  if (runs.has(s.id)) throw new ApiError(409, "실행 중에는 압축할 수 없습니다. 끝난 뒤에 해야 합니다");
  ensureModel(s);
  const info = shrink(s, conv);
  if (!info) return { compacted: false };
  appendEvent(conv, { type: "compaction", manual: true, conversation_id: conv.id, cleared_results: 0, ...info, timestamp: now() });
  return { compacted: true, ...info };
}

/** 처음 상태로 돌릴 때: 돌던 것을 모두 끊는다. */
export function stopAll(): void {
  for (const id of [...runs.keys()]) stopRun(id);
  for (const [id, set] of subs) for (const sub of [...set]) endSub(id, sub);
  subs.clear();
}

/* ───────── 도구가 내는 글 ───────── */

/** 요약 흉내: 앞의 두 문단에서 첫 문장을 하나씩 딴다. 문장을 못 찾으면 글의 첫 줄. */
function gist(text: string): string {
  const lines = text
    .split(/\n{2,}/)
    .map(firstSentence)
    .filter((l) => l.length > 8)
    .slice(0, 2);
  return lines.join(" ") || headOf(text);
}

function produce(def: ToolDef, s: FakeSession, raw: string, input: string, model: string): string {
  const pick = (re: RegExp, fallback: string) => (input.match(re)?.[1] ?? "").trim() || fallback;
  const name = pick(/주인공[ \t]*[:：][ \t]*([^\n,]*)/, "서윤");
  const place = pick(/장소[ \t]*[:：][ \t]*([^\n,]*)/, "종점 정류장");
  const n = s.variant++;
  switch (def.name) {
    case "compose":
      return fill(COMPOSE_POOL[n % COMPOSE_POOL.length], name, place);
    case "continue":
      return CONTINUE_POOL[n % CONTINUE_POOL.length];
    case "critique": {
      const found = findIncludes(s, raw).filter((x) => x.target.kind !== "missing");
      const doc = found.length ? found[found.length - 1].target.title : "입력";
      return CRITIQUE_POOL[n % CRITIQUE_POOL.length].replace("{doc}", doc);
    }
    case SUMMARY_TOOL:
      return gist(input) || "요약할 글이 입력에 없습니다.";
    default: {
      const prompt = def.prompt.trim().replace(/\s+/g, " ");
      return `[${def.label}] 대본 출력\n\n입력 ${input.length.toLocaleString()}자를 받았다.\n지시문: ${prompt ? prompt.slice(0, 140) : "비어 있음"}\n\n실제 실행에서는 이 자리에 ${josa(model, "이", "가")} 쓴 글이 들어간다.`;
    }
  }
}

/* ───────── 대본 ───────── */

const quote = (text: string) => `“${text}”`;
const modeLabel = (mode: Mode) => META.modes.find((m) => m.id === mode)?.label ?? mode;
const tidyPath = (path: string) => path.replace(/\.md$/i, "");

/** `열쇠: 값` 줄을 고치거나, 없으면 끝에 붙인다. */
function setLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: ${value}`;
  if (re.test(text)) return text.replace(re, () => line);
  const head = text.replace(/\s+$/, "");
  return head ? `${head}\n\n${line}` : line;
}

function largestUpload(s: FakeSession): string | null {
  const paths = Object.keys(s.materials).filter((p) => p.startsWith("자료/올린 글/") && s.materials[p].kind === "text" && s.materials[p].content.trim());
  paths.sort((a, b) => s.materials[b].content.length - s.materials[a].content.length);
  return paths[0] ?? null;
}

/** 도구에 넘길 입력을 새로 짠다: 브리프, 인물, 앞 장면, 그리고 요청. */
function prepareInput(s: FakeSession, goal: string): string {
  const includes: string[] = [];
  if (locate(s, "자료/브리프").type === "material") includes.push("@include:자료/브리프");
  Object.keys(s.materials)
    .filter((p) => p.startsWith("자료/인물/") && s.materials[p].kind === "text")
    .sort((a, b) => a.localeCompare(b, "ko"))
    .slice(0, 3)
    .forEach((p) => includes.push(`@include:${tidyPath(p)}`));
  const scenes = orderedScenes(s);
  const last = scenes[scenes.length - 1];
  const upload = largestUpload(s);
  if (!includes.length && !last && upload) includes.push(`@include:${tidyPath(upload)}`);
  const blocks: string[] = [];
  if (includes.length) blocks.push(includes.join("\n"));
  if (last) blocks.push(`앞 장면:\n@include:원고/${last.id}`);
  blocks.push(`요청: ${goal}`);
  return blocks.join("\n\n");
}

/** 문단 경계 가운데, 조각이 `target`자쯤 되는 자리들. 돌려주는 값은 다음 문단이 시작하는 글자 위치다. */
export function paragraphCuts(text: string, target: number): number[] {
  const cuts: number[] = [];
  let last = 0;
  for (const m of text.matchAll(/\n[ \t]*\n\s*/g)) {
    const pos = (m.index ?? 0) + m[0].length;
    if (pos - last >= target && text.length - pos >= target / 2) {
      cuts.push(pos);
      last = pos;
    }
  }
  return cuts;
}

/** 글의 한가운데에 가장 가까운 문단 경계. */
export function middleCut(text: string): number[] {
  let best = -1;
  for (const m of text.matchAll(/\n[ \t]*\n\s*/g)) {
    const pos = (m.index ?? 0) + m[0].length;
    if (pos >= text.length) continue;
    if (best === -1 || Math.abs(pos - text.length / 2) < Math.abs(best - text.length / 2)) best = pos;
  }
  return best === -1 ? [] : [best];
}

const firstLine = (text: string) => {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 60 ? line.slice(0, 58) + "…" : line;
};
/** 나누기 확인에 싣는 조각 하나 (API.md 6절의 `pieces`). 조각에 제목은 없다. */
const pieceOf = (text: string) => ({ chars: text.length, head: firstLine(text), new_chapter: false });

/** 말에 적힌 장·장면 번호로 장면을 고른다. 없으면 마지막 장면. */
function pickScene(s: FakeSession, goal: string): FakeScene | null {
  const scenes = orderedScenes(s);
  if (!scenes.length) return null;
  const chapterN = goal.match(/(\d+)\s*장(?!면)/);
  const sceneMatch = goal.match(/장면\s*(\d+)|(\d+)\s*번째\s*장면/);
  const sceneN = sceneMatch ? Number(sceneMatch[1] ?? sceneMatch[2]) : 0;
  if (chapterN) {
    const ch = s.chapters[Number(chapterN[1]) - 1];
    if (ch?.scenes.length) return s.scenes[ch.scenes[sceneN - 1] ?? ch.scenes[ch.scenes.length - 1]];
  }
  if (sceneN && scenes[sceneN - 1]) return scenes[sceneN - 1];
  return scenes[scenes.length - 1];
}

let turn = 0;

async function agentScript(r: Run, goal: string, def?: ToolDef): Promise<void> {
  const s = r.s;
  await r.wait(350);

  // 자동 압축: 켜 둔 작업에서 이 대화가 프리셋의 한도를 넘었을 때만. 한도가 0이면 줄이지 않는다.
  const budget = r.preset.context_budget;
  if (s.state.auto_compact && budget > 0 && r.conv.contextTokens > budget) {
    const info = shrink(s, r.conv);
    if (info) r.emit({ type: "compaction", cleared_results: 0, ...info });
  }

  if (r.preset.thinking !== "off" && turn++ % 2 === 0) {
    const scenes = orderedScenes(s).length;
    await r.think(
      `요청은 ${quote(goal || `/${def?.label ?? ""}`)}. 진행 방식은 ${modeLabel(r.mode)}. 원고는 ${scenes}장면이고 출력은 ${s.output.content ? `${s.output.content.length}자` : "비어 있다"}. 필요한 문서만 읽고 진행한다.`,
    );
  }

  if (def) return toolFlow(r, goal, def);
  if (/요약/.test(goal)) return summaryFlow(r, goal);
  if (/훑어|어긋나|일관|어떻게 그려|어디에 나오/.test(goal) && orderedScenes(s).length) return exploreFlow(r, goal);
  if (/나눠|나누/.test(goal)) return splitFlow(r, goal);
  if (/합쳐/.test(goal)) return mergeFlow(r, goal);
  if (/순서|앞으로|뒤로/.test(goal)) return reorderFlow(r, goal);
  if (/원고/.test(goal) && /넣|올려|옮겨|반영/.test(goal)) return insertFlow(r, goal);
  if (/고쳐|수정|바꿔/.test(goal) && orderedScenes(s).length) return editFlow(r, goal);
  if (/자료|정리|메모|계획/.test(goal)) return materialFlow(r, goal);
  if (/물어|질문/.test(goal)) return questionFlow(r, goal);
  return defaultFlow(r, goal);
}

/** 계획 모드: 도구나 원고가 필요한 일은 하지 않고, 할 일을 자료/계획에 적는다. */
async function planInstead(r: Run, goal: string, steps: string[]): Promise<void> {
  const s = r.s;
  const path = "자료/계획";
  const old = textOf(s, path) ?? "";
  const title = goal.length > 40 ? goal.slice(0, 38) + "…" : goal || "할 일";
  const next = `${old.trim() ? old.replace(/\s+$/, "") + "\n\n" : "# 계획\n\n"}## ${title}\n\n${steps.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n`;
  const out = await r.change({
    tool: "write",
    args: { path, content: next },
    zone: "material",
    lockPaths: [path],
    proposal: { action: "write", path: "자료/계획.md", old: old || null, new: next, description: "자료/계획에 할 일 적기" },
    result: `자료/계획을 ${next.length}자로 썼습니다.`,
    apply: (extra) => [writeDoc(s, path, next, "agent", extra).path],
  });
  if (out.status === "done") await r.say("계획 모드라 도구와 원고는 건드리지 않았습니다. 할 일을 자료/계획에 적었습니다.");
  else if (out.status === "locked") await r.say("계획 모드라 도구와 원고는 건드리지 않았습니다. 자료/계획에는 수정 방지가 걸려 있어 계획도 적지 못했습니다.");
  else await r.say("계획을 적지 않았습니다.");
}

/** 입력을 고쳐 쓴다. 바뀔 것이 없으면 아무것도 하지 않는다. */
async function writeInputStep(r: Run, next: string, description: string): Promise<Outcome> {
  const s = r.s;
  const old = s.input.content;
  if (old === next) return { status: "done", changed: [] };
  return r.change({
    tool: "write_input",
    args: { content: next },
    zone: "input",
    lockPaths: [],
    proposal: { action: "write", path: "입력", old: old || null, new: next, description },
    result: `입력을 ${next.length}자로 썼습니다.`,
    apply: (extra) => (writeInput(s, next, "agent", extra) ? ["입력"] : []),
  });
}

/** 입력을 쓰고 도구를 돌린다. 끝까지 갔으면 true. */
async function inputThenTool(r: Run, input: string, description: string, def: ToolDef): Promise<boolean> {
  const wrote = await writeInputStep(r, input, description);
  if (wrote.status === "rejected") {
    await r.say(`${wrote.reason ? `${quote(wrote.reason)} — 알겠습니다. ` : ""}입력을 그대로 두었고 도구는 돌리지 않았습니다.`);
    return false;
  }
  const ran = await r.tool(def, "agent");
  if (ran.status === "rejected") {
    await r.say(`${ran.reason ? `${quote(ran.reason)} — 알겠습니다. ` : ""}〈${def.label}〉 도구는 돌리지 않았습니다. 준비한 입력은 그대로 있습니다.`);
    return false;
  }
  return true;
}

/** 1. 사용자가 도구를 지정했다: 말을 반영해 입력을 고치고 그 도구를 돌린다. */
async function toolFlow(r: Run, goal: string, def: ToolDef): Promise<void> {
  const s = r.s;
  if (r.mode === "plan")
    return planInstead(r, goal || `/${def.label}`, [
      goal ? `입력을 고쳐 ${josa(quote(goal), "을", "를")} 반영한다.` : "입력을 준비한다.",
      `〈${def.label}〉 도구를 돌려 출력에 쓴다.`,
    ]);
  // 말이 없으면 입력은 있는 그대로 쓴다. 비어 있을 때만 새로 짠다.
  const current = s.input.content;
  const next = !current.trim() ? prepareInput(s, goal || `〈${def.label}〉`) : goal ? setLine(current, "요청", goal) : current;
  const description = goal ? `입력에 ${quote(goal)} 반영하기` : "도구에 넘길 입력 준비하기";
  if (await inputThenTool(r, next, description, def))
    await r.say(`${goal ? "요청을 입력에 반영하고 " : ""}〈${def.label}〉 도구를 돌렸습니다. 결과를 출력에 썼습니다.`);
}

/** 8. 그 밖: 입력을 준비하고 켜져 있는 첫 도구를 돌린다. */
async function defaultFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  const def = r.preset.tools.find((t) => t.enabled);
  if (!def) return r.say("켜져 있는 도구가 없습니다. 에이전트 패널에서 도구를 켜거나 만들어 주세요.");
  if (r.mode === "plan")
    return planInstead(r, goal, ["입력에 브리프와 인물 자료, 앞 장면을 불러 둔다.", `〈${def.label}〉 도구를 돌려 출력에 쓴다.`, "출력을 확인받고 원고에 넣는다."]);
  const brief = textOf(s, "자료/브리프");
  if (brief !== null) await r.call("read", { path: "자료/브리프" }, () => ({ result: `${brief.length}자를 읽었습니다.` }));
  if (await inputThenTool(r, prepareInput(s, goal), "도구에 넘길 입력 준비하기", def))
    await r.say(`입력을 준비하고 〈${def.label}〉 도구를 돌렸습니다. 출력에 썼습니다. 원고에 넣으려면 말씀해 주세요.`);
}

/** 2. 나누기: 올린 통짜 글을 장면들로, 또는 가장 긴 장면을 둘로. */
async function splitFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  const scenes = orderedScenes(s);
  const upload = largestUpload(s);
  const fromMaterial = !!upload && (/자료|올린/.test(goal) || !scenes.length);
  if (!fromMaterial && !scenes.length) return r.say("나눌 글이 없습니다. 원고가 비어 있고 자료/올린 글에도 글이 없습니다.");

  if (fromMaterial && upload) {
    const text = s.materials[upload].content;
    const title = baseName(upload);
    if (r.mode === "plan") return planInstead(r, goal, [`자료의 ${josa(quote(title), "을", "를")} 문단 경계에서 장면으로 나눈다.`, "나눈 장면을 원고에 차례로 넣는다."]);
    await r.call("read", { path: tidyPath(upload) }, () => ({ result: `${text.length}자를 읽었습니다. 문단은 ${text.split(/\n[ \t]*\n/).length}개입니다.` }));
    // 짧은 글은 250자쯤마다, 긴 글은 많아야 열두 조각쯤 되게 자른다.
    const at = paragraphCuts(text, Math.max(250, Math.ceil(text.length / 12)));
    const pieces = cutText(text, at);
    if (pieces.length < 2) return r.say(`${quote(title)}에서 나눌 문단 경계를 찾지 못했습니다. 글이 짧거나 문단이 하나뿐입니다.`);
    const lastChapter = s.chapters[s.chapters.length - 1];
    const out = await r.change({
      tool: "split",
      args: { path: tidyPath(upload), at },
      zone: "manuscript",
      lockPaths: [lastChapter ? `원고/${lastChapter.id}` : "원고"],
      proposal: {
        action: "split",
        path: upload,
        pieces: pieces.map(pieceOf),
        description: `${josa(quote(title), "을", "를")} 장면 ${pieces.length}개로 나눠 원고에 넣기`,
      },
      result: `장면 ${pieces.length}개로 나눠 원고에 넣었습니다.`,
      apply: (extra) => {
        let chapter = lastChapter?.id;
        return pieces.map((piece) => {
          const made = addScene(s, { content: piece, chapter }, "agent", extra);
          chapter = made.chapter;
          return made.path;
        });
      },
    });
    if (out.status === "done") await r.say(`${josa(quote(title), "을", "를")} 장면 ${pieces.length}개로 나눠 원고에 넣었습니다. 글은 고치지 않았고, 자료의 원문도 그대로 두었습니다.`);
    else if (out.status === "locked") await r.say("원고에 수정 방지가 걸려 있어 장면을 넣지 않았습니다.");
    else await r.say(`${out.reason ? `${quote(out.reason)} — 알겠습니다. ` : ""}나누지 않았습니다. 어디서 끊으면 좋을지 알려 주시면 다시 나누겠습니다.`);
    return;
  }

  const target = scenes.reduce((a, b) => (b.content.length > a.content.length ? b : a));
  const name = sceneName(s, target.id);
  const path = `원고/${target.id}`;
  if (r.mode === "plan") return planInstead(r, goal, [`가장 긴 장면인 ${josa(name, "을", "를")} 문단 경계에서 둘로 나눈다.`]);
  await r.call("read", { path }, () => ({ result: `${target.content.length}자를 읽었습니다.` }));
  const at = middleCut(target.content);
  const pieces = cutText(target.content, at);
  if (pieces.length < 2) return r.say(`${name}에는 문단이 하나뿐이라 나눌 자리를 찾지 못했습니다.`);
  const out = await r.change({
    tool: "split",
    args: { path, at },
    zone: "manuscript",
    lockPaths: [path],
    proposal: { action: "split", path, old: target.content, pieces: pieces.map(pieceOf), description: `${josa(name, "을", "를")} 둘로 나누기` },
    result: `${josa(name, "을", "를")} ${pieces.length}개로 나눴습니다.`,
    apply: (extra) => splitScene(s, target.id, at, "agent", extra).ids.map((id) => `원고/${id}`),
  });
  if (out.status === "done") await r.say(`가장 긴 장면인 ${josa(name, "을", "를")} 둘로 나눴습니다. 글은 고치지 않았습니다.`);
  else if (out.status === "locked") await r.say(`${name}에 수정 방지가 걸려 있어 나누지 않았습니다.`);
  else await r.say(`${out.reason ? `${quote(out.reason)} — 알겠습니다. ` : ""}나누지 않았습니다.`);
}

/** 3-1. 합치기: 한 장 안의 마지막 두 장면. */
async function mergeFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  const ch = [...s.chapters].reverse().find((c) => c.scenes.length >= 2);
  if (!ch) return r.say("한 장 안에 장면이 둘 이상 있어야 합칠 수 있습니다.");
  const [a, b] = ch.scenes.slice(-2);
  const names = `${josa(sceneName(s, a), "과", "와")} ${sceneName(s, b)}`;
  if (r.mode === "plan") return planInstead(r, goal, [`${josa(names, "을", "를")} 한 장면으로 합친다.`]);
  const merged = joinPieces([s.scenes[a].content, s.scenes[b].content]);
  const out = await r.change({
    tool: "merge_scenes",
    args: { scenes: [a, b] },
    zone: "manuscript",
    lockPaths: [`원고/${a}`, `원고/${b}`],
    proposal: { action: "merge", path: `원고/${a}`, scenes: [a, b], new: merged, description: `${names} 합치기` },
    result: `두 장면을 원고/${a}에 합쳤습니다.`,
    apply: (extra) => {
      mergeScenes(s, [a, b], "agent", extra);
      return [`원고/${a}`, `원고/${b}`];
    },
  });
  if (out.status === "done") await r.say(`두 장면을 ${josa(sceneName(s, a), "으로", "로")} 합쳤습니다.`);
  else if (out.status === "locked") await r.say(`${out.path}에 수정 방지가 걸려 있어 합치지 않았습니다.`);
  else await r.say(`${out.reason ? `${quote(out.reason)} — 알겠습니다. ` : ""}합치지 않았습니다.`);
}

/** 3-2. 순서 바꾸기: 마지막 장면을 한 칸 앞으로, "뒤로"면 첫 장면을 한 칸 뒤로. */
async function reorderFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  const back = /뒤로/.test(goal);
  const ch = (back ? s.chapters : [...s.chapters].reverse()).find((c) => c.scenes.length >= 2);
  if (!ch) return r.say("한 장 안에 장면이 둘 이상 있어야 순서를 바꿀 수 있습니다.");
  const list = ch.scenes;
  const id = back ? list[0] : list[list.length - 1];
  const after = back ? list[1] : (list[list.length - 3] ?? null);
  const order = list.filter((x) => x !== id);
  order.splice(after === null ? 0 : order.indexOf(after) + 1, 0, id);
  const name = sceneName(s, id);
  const where = back ? `${sceneName(s, list[1])} 뒤로` : `${sceneName(s, list[list.length - 2])} 앞으로`;
  if (r.mode === "plan") return planInstead(r, goal, [`${josa(name, "을", "를")} ${where} 옮긴다.`]);
  const out = await r.change({
    tool: "move_scene",
    args: { scene: id, chapter: ch.id, after },
    zone: "manuscript",
    lockPaths: [`원고/${id}`],
    proposal: { action: "reorder", path: `원고/${id}`, position: { chapter: ch.id, after }, scenes: order, description: `${josa(name, "을", "를")} ${where} 옮기기` },
    result: `${josa(name, "을", "를")} 옮겼습니다.`,
    apply: () => {
      moveScene(s, id, { chapter: ch.id, after });
      return [`원고/${id}`];
    },
  });
  if (out.status === "done") await r.say(`옮겼습니다. 지금은 ${sceneName(s, id)}입니다.`);
  else if (out.status === "locked") await r.say(`${name}에 수정 방지가 걸려 있어 옮기지 않았습니다.`);
  else await r.say(`${out.reason ? `${quote(out.reason)} — 알겠습니다. ` : ""}순서는 그대로 두었습니다.`);
}

/** 4. 출력을 원고에 장면으로 넣는다. 사유와 함께 반려되면 그 사유를 반영해 다시 쓴다. */
async function insertFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  if (r.mode === "plan") return planInstead(r, goal, ["출력의 글을 원고의 마지막 장 끝에 장면으로 넣는다.", "넣은 뒤 출력을 비운다."]);
  if (!s.output.content.trim()) return r.say("출력이 비어 있어서 원고에 넣을 글이 없습니다. 먼저 도구로 글을 써야 합니다.");
  const ch = s.chapters[s.chapters.length - 1];
  const after = ch?.scenes[ch.scenes.length - 1] ?? null;
  const where = ch ? `${chapterName(s, ch.id)} 끝` : "원고의 첫 장";
  const text = s.output.content;
  const source = s.output.tool;
  const out = await r.change({
    tool: "insert_scene",
    args: { from_output: true, chapter: ch?.id ?? null, after },
    zone: "manuscript",
    lockPaths: [ch ? `원고/${ch.id}` : "원고"],
    proposal: { action: "insert", path: "원고", new: text, position: { chapter: ch?.id ?? null, after }, description: `출력의 글을 ${where}에 장면으로 넣기` },
    result: `출력의 ${text.length}자를 원고에 넣고 출력을 비웠습니다.`,
    apply: (extra) => [addScene(s, { from_output: true, chapter: ch?.id }, "agent", extra).path, "출력"],
  });
  if (out.status === "done") {
    const made = out.changed[0].slice(3);
    return r.say(`출력의 글을 원고에 넣었습니다. ${sceneName(s, made)}입니다. 출력은 비웠습니다.`);
  }
  if (out.status === "locked") return r.say(`${ch ? chapterName(s, ch.id) : "원고"}에 수정 방지가 걸려 있어 넣지 않았습니다. 출력은 그대로 있습니다.`);
  if (!out.reason) return r.say("넣지 않았습니다. 출력은 그대로 있습니다.");

  // 사유가 왔다: 입력에 적어 두고, 그 글을 쓴 도구를 다시 돌린다.
  const def = r.preset.tools.find((t) => t.name === source && t.enabled) ?? r.preset.tools.find((t) => t.enabled);
  if (!def) return r.say(`${quote(out.reason)} — 알겠습니다. 다시 쓸 도구가 켜져 있지 않아 출력은 그대로 두었습니다.`);
  await r.say(`${quote(out.reason)} — 알겠습니다. 그 점을 반영해 〈${def.label}〉 도구로 다시 쓰겠습니다.`);
  const base = s.input.content.trim() ? s.input.content : prepareInput(s, goal);
  if (await inputThenTool(r, setLine(base, "고칠 점", out.reason), "입력에 고칠 점 적기", def)) await r.say("고쳐서 출력에 다시 썼습니다. 원고에 넣으려면 말씀해 주세요.");
}

/** 5. 장면의 한 문단을 고친다. */
async function editFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  const target = pickScene(s, goal);
  if (!target) return defaultFlow(r, goal);
  const name = sceneName(s, target.id);
  const path = `원고/${target.id}`;
  if (r.mode === "plan") return planInstead(r, goal, [`${josa(name, "을", "를")} 읽고 고칠 문단을 고른다.`, "그 문단만 고쳐 쓰고 확인을 받는다."]);
  await r.call("read", { path }, () => ({ result: `${target.content.length}자를 읽었습니다.` }));

  // 문단과 그 사이의 빈 줄을 번갈아 들고, 문단 하나만 바꿔 다시 잇는다.
  const parts = target.content.split(/(\n[ \t]*\n\s*)/);
  const candidates = parts.map((p, i) => ({ p, i })).filter(({ p, i }) => i % 2 === 0 && p.trim() && !/^!\[[^\]]*\]\([^)]*\)$/.test(p.trim()));
  if (!candidates.length) return r.say(`${name}에 고칠 글이 없습니다.`);
  const n = s.variant++;
  const chosen = candidates[Math.min(candidates.length - 1, 2 + (n % 2))];
  const order = candidates.indexOf(chosen) + 1;
  const sentences = chosen.p.match(/[^.!?…]+[.!?…]+["”’]?\s*/g) ?? [chosen.p];
  const rewritten = (sentences.length > 1 ? sentences.slice(0, -1).join("") : "") + REWRITES[n % REWRITES.length];
  const next = parts.map((p, i) => (i === chosen.i ? rewritten : p)).join("");

  const out = await r.change({
    tool: "edit",
    args: { path, old: chosen.p, new: rewritten },
    zone: "manuscript",
    lockPaths: [path],
    proposal: { action: "write", path, old: target.content, new: next, description: `${name}의 ${order}번째 문단 고치기` },
    result: `${name}의 ${order}번째 문단을 고쳤습니다.`,
    apply: (extra) => [writeDoc(s, path, next, "agent", extra).path],
  });
  if (out.status === "done") await r.say(`${name}의 ${order}번째 문단을 고쳤습니다. 끝 문장만 바꿨고 나머지는 그대로입니다.`);
  else if (out.status === "locked") await r.say(`${name}에 수정 방지가 걸려 있어 고치지 않았습니다. 수정 방지를 풀거나 권한 무시를 켜면 고칠 수 있습니다.`);
  else await r.say(`${out.reason ? `${quote(out.reason)} — 알겠습니다. ` : ""}${josa(name, "은", "는")} 그대로 두었습니다.`);
}

/** 6. 자료 문서 하나를 쓰거나 고친다: 계획, 메모, 아니면 자료 목록. */
async function materialFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  const today = new Date();
  const date = `${today.getMonth() + 1}월 ${today.getDate()}일`;
  let path: string;
  let next: string;
  if (/계획/.test(goal)) {
    path = "자료/계획";
    const old = textOf(s, path) ?? "";
    const scenes = orderedScenes(s);
    const lines = [
      `- 원고: ${s.chapters.length}장 ${scenes.length}장면, ${manuscriptChars(s).toLocaleString()}자`,
      `- 출력: ${s.output.content ? `${s.output.content.length}자가 원고에 들어가기를 기다린다` : "비어 있다"}`,
      `- 다음에 할 일: ${scenes.length ? `${sceneName(s, scenes[scenes.length - 1].id)}에 이어지는 장면을 쓴다` : "첫 장면을 쓴다"}`,
    ];
    next = `${old.trim() ? old.replace(/\s+$/, "") + "\n\n" : "# 계획\n\n"}## 지금 상태 (${date})\n\n${lines.join("\n")}\n`;
    await r.call("read", { path }, () => ({ result: old ? `${old.length}자를 읽었습니다.` : "아직 없는 문서입니다." }));
  } else if (/메모/.test(goal)) {
    path = "자료/메모";
    const old = textOf(s, path) ?? "";
    next = `${old.trim() ? old.replace(/\s+$/, "") + "\n" : "# 메모\n\n"}- (${date}) ${goal}\n`;
    await r.call("read", { path }, () => ({ result: old ? `${old.length}자를 읽었습니다.` : "아직 없는 문서입니다." }));
  } else {
    path = "자료/자료 목록";
    const paths = Object.keys(s.materials)
      .filter((p) => p !== "자료/자료 목록.md")
      .sort((a, b) => a.localeCompare(b, "ko"));
    next = `# 자료 목록\n\n${paths
      .map((p) => {
        const m = s.materials[p];
        const label = tidyPath(p).slice(3);
        // 글 문서는 제목 줄을 뺀 첫 줄을 한 줄 소개로 쓴다.
        const gist = (m.content.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "").replace(/^[-*]\s*/, "").trim();
        if (m.kind !== "text") return `- ${label} (${m.kind === "image" ? "이미지" : "파일"})`;
        return `- ${label}: ${gist ? (gist.length > 48 ? gist.slice(0, 46) + "…" : gist) : "(비어 있음)"}`;
      })
      .join("\n")}\n`;
    await r.call("list", { path: "자료" }, () => ({ result: `문서 ${paths.length}개가 있습니다.` }));
  }
  const real = locate(s, path);
  const before = textOf(s, path);
  if (before === next) return r.say(`${josa(path, "은", "는")} 이미 지금 상태와 같아서 고치지 않았습니다.`);
  const out = await r.change({
    tool: "write",
    args: { path, content: next },
    zone: "material",
    lockPaths: [path],
    proposal: { action: "write", path: real.type === "material" ? real.path : `${path}.md`, old: before, new: next, description: `${path} ${before === null ? "새로 쓰기" : "고치기"}` },
    result: `${josa(path, "을", "를")} ${next.length}자로 썼습니다.`,
    apply: (extra) => [writeDoc(s, path, next, "agent", extra).path],
  });
  if (out.status === "done") await r.say(`${josa(path, "을", "를")} ${before === null ? "새로 썼습니다" : "고쳤습니다"}.`);
  else if (out.status === "locked") await r.say(`${path}에 수정 방지가 걸려 있어 고치지 않았습니다.`);
  else await r.say(`${out.reason ? `${quote(out.reason)} — 알겠습니다. ` : ""}${josa(path, "은", "는")} 그대로 두었습니다.`);
}

/** 7. 질문하고, 답을 받아 이어 간다. 자율 모드에서는 묻지 않는다. */
async function questionFlow(r: Run, goal: string): Promise<void> {
  if (r.mode === "autonomous") {
    await r.say("자율 모드에서는 질문하지 않습니다. 지금 문체 그대로 진행하겠습니다.");
    return defaultFlow(r, goal);
  }
  const question = "다음 글을 어느 쪽으로 쓸까요?";
  const options = ["지금 문체 그대로", "문장을 더 짧게", "대사를 조금 넣어서"];
  let answer = "";
  await r.call("ask_user", { question, options }, async () => {
    answer = (await r.ask({ kind: "question", question, options })).trim();
    return { result: answer || "(답 없음)" };
  });
  await r.say(answer ? `${quote(answer)} — 그렇게 진행하겠습니다.` : "답이 없어서 지금 문체 그대로 진행하겠습니다.");
  return defaultFlow(r, answer ? `${goal} (${answer})` : goal);
}

/**
 * 9. 요약 붙이기: 요약이 없거나 낡은 장면에 요약 도구를 한꺼번에 돌린다 (묶음 요약).
 * 입력과 출력은 건드리지 않고, 장면마다 도구 실행 기록이 한 줄씩 남는다.
 * 프리셋에 쓸 수 있는 요약 도구가 없으면 장면마다 요약을 직접 적는다.
 */
async function summaryFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  if (r.mode === "plan") return planInstead(r, goal, ["요약이 없거나 낡은 장면을 찾는다.", "그 장면마다 요약을 붙인다."]);
  const targets = scenesToSummarize(s);
  const def = r.preset.tools.find((t) => t.name === SUMMARY_TOOL && t.enabled && t.prompt.trim());

  if (!def) {
    if (!targets.length) return r.say("요약은 전부 최신입니다. 붙일 곳이 없습니다.");
    for (const sc of targets) {
      const path = `원고/${sc.id}`;
      const summary = gist(sc.content);
      await r.call("set_summary", { target: path, summary }, () =>
        attachSummary(s, sc.id, summary)
          ? { result: `${sceneName(s, sc.id)}에 요약을 붙였습니다.`, changed: ["원고", path] }
          : { result: `요약을 붙이지 못했습니다: ${path}`, ok: false },
      );
    }
    return r.say(`요약 도구가 없어서 장면 ${targets.length}개에 요약을 직접 적었습니다. 원고 목록에서 확인해 주세요.`);
  }

  let closing = "요약은 전부 최신입니다. 붙일 곳이 없습니다.";
  await r.call("summarize_scenes", { targets: [], tool: def.name }, async (tool_call_id) => {
    if (!targets.length) return { result: "요약할 장면이 없습니다. 요약이 없거나 낡은 장면이 없습니다." };
    if (r.mode === "manual") {
      const answer = (
        await r.ask({
          kind: "tool_confirm",
          tool: def.name,
          label: def.label,
          input: targets.map((sc) => sceneName(s, sc.id)).join("\n"),
          question: `〈${def.label}〉 도구를 ${targets.length}곳에 돌려 요약을 붙일까요?`,
          options: [APPROVE, REJECT],
        })
      ).trim();
      if (answer !== APPROVE) {
        const reason = answer === REJECT ? "" : answer;
        closing = `${reason ? `${quote(reason)} — 알겠습니다. ` : ""}요약을 붙이지 않았습니다.`;
        return { result: `사용자가 실행을 반려했습니다${reason ? ` — ${reason}` : ""}. 요약을 붙이지 않았습니다.`, ok: false };
      }
    }
    const model = r.toolModel(def);
    const changed: string[] = [];
    for (const sc of targets) {
      const started = Date.now();
      await r.wait(220);
      const path = `원고/${sc.id}`;
      const summary = gist(sc.content);
      // 기다리는 사이에 사용자가 지웠거나 요약을 직접 쓴 장면은 건너뛴다.
      if (!attachSummary(s, sc.id, summary)) continue;
      logToolRun(s, {
        tool: def.name,
        label: def.label,
        by: "agent",
        model,
        duration_ms: Date.now() - started,
        input: sc.content,
        input_raw: `@include:${path}`,
        output: summary,
        error: null,
        target: path,
        tool_call_id,
      });
      changed.push(path);
    }
    closing = `요약이 없거나 낡은 장면 ${changed.length}개에 요약을 붙였습니다. 원고 목록에서 확인해 주세요.`;
    return { result: `〈${def.label}〉 도구로 ${changed.length}곳에 요약을 붙였습니다.`, changed: changed.length ? ["원고", ...changed] : [] };
  });
  await r.say(closing);
}

/**
 * 10. 읽기 에이전트: 원고를 훑어야 답할 수 있는 일을 맡기고 답만 돌려받는다.
 * 읽기만 하므로 어느 모드에서든 확인 없이 돌고, 도구 실행 기록에는 남지 않는다.
 * 무엇을 보는지 한 줄씩 흘리고, 이어서 답을 흘린다.
 */
async function exploreFlow(r: Run, goal: string): Promise<void> {
  const s = r.s;
  // 찾을 낱말: 요청에 나온 인물. 없으면 인물 자료의 첫 사람.
  const names = Object.keys(s.materials)
    .filter((p) => p.startsWith("자료/인물/") && s.materials[p].kind === "text")
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map(baseName);
  const word = names.find((n) => goal.includes(n)) ?? names[0] ?? "";
  const task = `원고의 장면을 처음부터 끝까지 읽고 이 요청에 답해 줘: ${quote(goal)} 근거가 된 장면의 경로를 같이 적어 줘.`;
  let closing = "";
  await r.call("explore", { task }, async (tool_call_id) => {
    const stream = async (delta: string, ms: number) => {
      await r.wait(ms);
      r.emit({ type: "tool_stream", tool: "explore", tool_call_id, delta });
    };
    // 본 것은 흘려보내면서 따로 모아 둔다. 흐름은 기록에 남지 않으므로 결과의 trail로도 준다.
    const trail: string[] = [];
    const look = async (line: string, ms: number) => {
      trail.push(line);
      await stream(`${line}\n`, ms);
    };
    const scenes = orderedScenes(s);
    await look("목록 보기: 전체", 200);
    for (const sc of scenes) await look(`읽기: 원고/${sc.id}`, 160);
    if (word) await look(`찾기: ${word}`, 200);

    const hits = word ? scenes.filter((sc) => sc.content.includes(word)).length : 0;
    const head = word ? `${josa(word, "은", "는")} 장면 ${scenes.length}개 가운데 ${hits}개에 나온다.` : `장면 ${scenes.length}개를 읽었다.`;
    const lines = scenes.map((sc) => `- ${sceneName(s, sc.id)} (원고/${sc.id}): ${firstSentence(sc.content) || "빈 장면이다."}`);
    const answer = `${head}\n\n${lines.join("\n")}\n\n서로 어긋나는 곳은 찾지 못했다. (대본으로 낸 답이다. 실제 모델은 장면을 읽고 답한다.)`;
    const size = Math.ceil(answer.length / 6);
    for (let i = 0; i < answer.length; i += size) await stream(answer.slice(i, i + size), 110);

    closing = `읽기 에이전트가 원고의 장면 ${scenes.length}개를 훑었습니다. ${word ? `${josa(word, "은", "는")} ${hits}개 장면에 나오고, ` : ""}서로 어긋나는 곳은 찾지 못했습니다.`;
    return { result: answer, trail };
  });
  await r.say(closing);
}
