/* 가짜 API의 상태 모양과, 그 상태를 다루는 함수들. 화면도 타이머도 저장소도 모른다. */
import { ApiError } from "../errors";
import type { ConversationList, FlagPatch, NewScene } from "../api";
import type {
  By,
  Chapter,
  Conversation,
  DocContent,
  Flags,
  HistoryEntry,
  Material,
  Mode,
  Preset,
  PresetSummary,
  Provider,
  ResolvedRef,
  RunEvent,
  SessionState,
  SummaryState,
  ToolRun,
  Workspace,
} from "../types";
import { BUILTIN_PRESETS } from "./data";

/* ───────── 모양 ───────── */

export interface FakeMaterial {
  kind: "text" | "image" | "file";
  content: string; // 글 문서의 본문
  data: string; // 이미지의 data URL. 큰 이미지는 비어 있고 주소는 메모리에만 있다
  size: number;
  updated_at: string | null;
  by: By;
}

export interface FakeScene {
  id: string;
  summary: string;
  summary_state: SummaryState;
  content: string;
  updated_at: string | null;
  by: By;
}

export interface FakeChapter {
  id: string;
  summary: string;
  scenes: string[]; // 장면 id. 이 순서가 원고의 순서다
}

/** 대화 하나. 화면 기록과 컨텍스트의 크기는 대화마다 따로 있다. */
export interface FakeConversation {
  id: string;
  name: string; // 비어 있으면 아직 한 번도 보내지 않은 대화다
  created_at: string;
  updated_at: string; // 마지막으로 기록이 붙은 때
  events: RunEvent[];
  contextTokens: number;
}

export interface FakeSession {
  id: string;
  name: string;
  created_at: string;
  state: { preset_id: string; mode: Mode; bypass_locks: boolean; auto_compact: boolean; conversation: string };
  input: { content: string; updated_at: string | null; by: By };
  output: { content: string; updated_at: string | null; by: By; tool: string };
  materials: Record<string, FakeMaterial>; // 경로(확장자 포함) → 문서
  /** 사용자가 만든 폴더. 안이 비어도 남는다 (그 밖의 폴더는 문서의 경로에서 나온다). */
  folders?: string[];
  flags: Record<string, Flags>; // 직접 건 설정만
  chapters: FakeChapter[];
  scenes: Record<string, FakeScene>;
  nextScene: number;
  nextChapter: number;
  history: HistoryEntry[];
  versions: Record<string, string>; // hash → 그때의 글
  historySeq: number;
  toolRuns: ToolRun[];
  conversations: FakeConversation[]; // 만든 순서. 언제나 하나는 있다
  seq: number; // 이벤트 번호. 실행의 흐름이 작업에 하나라서 대화를 가리지 않고 센다
  run: { run_id: string | null; conversation_id: string | null; running: boolean; status: string; waiting: boolean };
  variant: number; // 대본 글을 차례로 고르는 번호
}

export interface FakeState {
  v: 3;
  providers: Provider[];
  presets: Record<string, Preset>; // 사용자본. 기본 제공본과 id가 같으면 그것을 덮는다
  sessions: FakeSession[];
  counter: number;
}

export type Extra = Partial<Pick<HistoryEntry, "origin" | "tool_run" | "proposal">>;

/* ───────── 작은 도우미 ───────── */

let clock: (() => string) | null = null;
/** 씨앗 데이터를 만들 때만 시각을 바꿔 끼운다. */
export function setClock(fn: (() => string) | null): void {
  clock = fn;
}
export const now = (): string => (clock ? clock() : new Date().toISOString());

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;
const SCENE_ROOT = "원고";
const MATERIAL_ROOT = "자료";

/** 경로를 한 가지 모양으로: 역슬래시와 앞뒤·겹친 슬래시를 없앤다. */
export function norm(path: string): string {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");
}

export function baseName(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

function byteSize(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

/* ───────── 프리셋과 모델 ───────── */

export function builtinPreset(id: string): Preset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

/** 작업이 쓰는 프리셋. 지워진 프리셋을 가리키면 기본으로 돌아간다. */
export function getPreset(st: FakeState, id: string): Preset {
  return clone(st.presets[id] ?? builtinPreset(id) ?? BUILTIN_PRESETS[0]);
}

export function presetSummaries(st: FakeState): PresetSummary[] {
  const out: PresetSummary[] = BUILTIN_PRESETS.map((b) => {
    const p = st.presets[b.id] ?? b;
    return { id: p.id, name: p.name, description: p.description, builtin: !st.presets[b.id], has_builtin: true };
  });
  for (const p of Object.values(st.presets))
    if (!builtinPreset(p.id)) out.push({ id: p.id, name: p.name, description: p.description, builtin: false, has_builtin: false });
  return out;
}

/** '제공자:모델'이 지금 쓸 수 있는가. */
export function modelUsable(st: FakeState, model: string): boolean {
  if (!model || !model.includes(":")) return false;
  const provider = st.providers.find((p) => p.id === model.split(":")[0]);
  return !!provider && provider.ready;
}

/** 실제로 쓰일 모델: 프리셋에 적힌 모델. 비었거나 그 제공자를 쓸 수 없으면 빈 문자열이고, 그때는 실행할 수 없다. */
export function effectiveModel(st: FakeState, s: FakeSession): string {
  const model = getPreset(st, s.state.preset_id).model;
  return modelUsable(st, model) ? model : "";
}

export function sessionState(st: FakeState, s: FakeSession): SessionState {
  return { ...s.state, model: getPreset(st, s.state.preset_id).model, effective_model: effectiveModel(st, s) };
}

/* ───────── 대화 ───────── */

/** 첫 대화의 id. 마지막 대화를 지웠을 때 남는 빈 대화도 이 id다. */
export const MAIN = "main";

export function newConversation(id: string, name = ""): FakeConversation {
  const at = now();
  return { id, name, created_at: at, updated_at: at, events: [], contextTokens: 0 };
}

/** 대화 하나. id를 안 주면 지금 보고 있는 대화다. */
export function conversationOf(s: FakeSession, id?: string | null): FakeConversation {
  const conv = s.conversations.find((c) => c.id === (id || s.state.conversation));
  if (!conv) throw new ApiError(404, `그런 대화가 없습니다: ${id || s.state.conversation}`);
  return conv;
}

export function conversationView(s: FakeSession, c: FakeConversation): Conversation {
  return {
    id: c.id,
    name: c.name,
    created_at: c.created_at,
    updated_at: c.updated_at,
    context_tokens: c.contextTokens,
    running: s.run.running && s.run.conversation_id === c.id,
  };
}

export function conversationList(s: FakeSession): ConversationList {
  return { conversations: s.conversations.map((c) => conversationView(s, c)), current: s.state.conversation };
}

const NAME_LIMIT = 80;

/** 새 대화를 만든다. 그것이 보고 있는 대화가 된다. id는 소문자와 숫자 8자다. */
export function createConversation(s: FakeSession, name = ""): FakeConversation {
  let id = "";
  do id = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  while (s.conversations.some((c) => c.id === id));
  const conv = newConversation(id, name.trim().slice(0, NAME_LIMIT));
  s.conversations.push(conv);
  s.state.conversation = id;
  return conv;
}

export function renameConversation(s: FakeSession, id: string, name: string): FakeConversation {
  const conv = conversationOf(s, id);
  conv.name = name.trim().slice(0, NAME_LIMIT);
  return conv;
}

/** 대화를 지운다. 마지막 대화였으면 빈 대화 하나가 남고, 보고 있던 대화였으면 남은 것 가운데 마지막으로 만든 것을 본다. */
export function deleteConversation(s: FakeSession, id: string): void {
  const conv = conversationOf(s, id);
  s.conversations = s.conversations.filter((c) => c !== conv);
  if (!s.conversations.length) s.conversations.push(newConversation(MAIN));
  if (!s.conversations.some((c) => c.id === s.state.conversation)) s.state.conversation = s.conversations[s.conversations.length - 1].id;
}

/** 대화에 이벤트를 붙인다. */
export function appendEvent(conv: FakeConversation, event: RunEvent): void {
  conv.events.push(event);
  conv.updated_at = event.timestamp ?? now();
}

/** 이름이 없는 대화에 첫 요청의 첫 줄(40자까지)을 이름으로 붙인다. */
export function nameFromRequest(conv: FakeConversation, request: string): void {
  if (conv.name) return;
  conv.name = (request.trim().split("\n")[0] ?? "").trim().slice(0, 40);
}

/** 모든 대화의 기록을 시간 순서로 합친 것. 제작 기록에 쓴다. */
export function allEvents(s: FakeSession): RunEvent[] {
  return s.conversations
    .flatMap((c) => c.events)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.timestamp ?? "").localeCompare(b.e.timestamp ?? "") || a.i - b.i)
    .map((x) => x.e);
}

/**
 * 실행 중이라고 적혀 있는데 실제로 도는 것이 없는 실행(새로 고쳐서 타이머가 사라진 것 등)을 중단된 것으로 맺는다.
 * 맺는 이벤트는 그 실행이 돌던 대화에 붙는다.
 */
export function closeLostRun(s: FakeSession): void {
  const conv = s.conversations.find((c) => c.id === s.run.conversation_id);
  if (conv)
    appendEvent(conv, {
      type: "done",
      seq: ++s.seq,
      run_id: s.run.run_id ?? undefined,
      conversation_id: conv.id,
      timestamp: now(),
      status: "stopped",
      total_tool_calls: 0,
      elapsed_sec: 0,
      usage: { context_tokens: conv.contextTokens },
    });
  s.run = { ...s.run, running: false, status: "stopped", waiting: false };
}

/* ───────── 경로 찾기 ───────── */

export type Located =
  | { type: "input" }
  | { type: "output" }
  | { type: "scene"; id: string }
  | { type: "material"; path: string }
  | { type: "folder"; path: string }
  | { type: "new"; path: string } // 자료 아래의 아직 없는 글 문서
  | { type: "none"; path: string };

export function isFolder(s: FakeSession, path: string): boolean {
  if (path === MATERIAL_ROOT) return true;
  return Object.keys(s.materials).some((p) => p.startsWith(path + "/")) || (s.folders ?? []).some((f) => f === path || f.startsWith(path + "/"));
}

/** 자료의 폴더 전부 (안쪽 폴더까지, 이름순). 문서의 경로에서 나오는 것과 사용자가 만들어 둔 것(비어도 남는다)을 합친다. */
export function folderList(s: FakeSession): string[] {
  const all = new Set<string>();
  const add = (folder: string) => {
    for (let p = folder; p !== MATERIAL_ROOT && p.startsWith(MATERIAL_ROOT + "/"); p = p.slice(0, p.lastIndexOf("/"))) all.add(p);
  };
  for (const p of Object.keys(s.materials)) add(p.slice(0, p.lastIndexOf("/")));
  for (const f of s.folders ?? []) add(f);
  return [...all].sort((a, b) => a.localeCompare(b, "ko"));
}

/** 자료에 빈 폴더를 만든다. 이미 있으면 그대로 둔다. */
export function addFolder(s: FakeSession, raw: string): string {
  const path = norm(raw);
  if (!path.startsWith(MATERIAL_ROOT + "/")) throw new ApiError(400, "자료 아래에만 폴더를 만들 수 있습니다");
  if (s.materials[path] || s.materials[path + ".md"]) throw new ApiError(409, `같은 이름의 문서가 이미 있습니다: ${path}`);
  if (!(s.folders ?? []).includes(path)) s.folders = [...(s.folders ?? []), path];
  return path;
}

/** 경로가 무엇을 가리키는지. 글 문서는 확장자 없이 적어도 찾는다. */
export function locate(s: FakeSession, raw: string): Located {
  const p = norm(raw);
  if (p === "입력") return { type: "input" };
  if (p === "출력") return { type: "output" };
  if (p.startsWith(SCENE_ROOT + "/")) {
    const id = p.slice(SCENE_ROOT.length + 1);
    return s.scenes[id] ? { type: "scene", id } : { type: "none", path: p };
  }
  if (p === MATERIAL_ROOT) return { type: "folder", path: p };
  if (p.startsWith(MATERIAL_ROOT + "/")) {
    if (s.materials[p]) return { type: "material", path: p };
    if (s.materials[p + ".md"]) return { type: "material", path: p + ".md" };
    if (isFolder(s, p)) return { type: "folder", path: p };
    return { type: "new", path: /\.md$/i.test(p) ? p : p + ".md" };
  }
  return { type: "none", path: p };
}

/* ───────── 수정 방지와 노트 (상속) ───────── */

/** 안쪽부터 바깥쪽까지 차례로 보고, 처음으로 직접 건 값을 쓴다. 아무 데도 없으면 끔. */
function inherited(s: FakeSession, chain: string[], key: keyof Flags): boolean {
  for (const k of chain) {
    const v = s.flags[k]?.[key];
    if (v !== undefined) return v;
  }
  return false;
}

/** `자료/인물/서윤.md` → [그 문서, `자료/인물`, `자료`] */
function materialChain(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = parts.length; i >= 1; i--) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function chapterOf(s: FakeSession, sceneId: string): FakeChapter | undefined {
  return s.chapters.find((c) => c.scenes.includes(sceneId));
}

function sceneChain(s: FakeSession, id: string): string[] {
  const ch = chapterOf(s, id);
  return [`${SCENE_ROOT}/${id}`, ...(ch ? [`${SCENE_ROOT}/${ch.id}`] : []), SCENE_ROOT];
}

export const materialLocked = (s: FakeSession, path: string) => inherited(s, materialChain(path), "locked");
export const materialNote = (s: FakeSession, path: string) => inherited(s, materialChain(path), "note");
export const sceneLocked = (s: FakeSession, id: string) => inherited(s, sceneChain(s, id), "locked");
export const chapterLocked = (s: FakeSession, id: string) => inherited(s, [`${SCENE_ROOT}/${id}`, SCENE_ROOT], "locked");
export const manuscriptLocked = (s: FakeSession) => inherited(s, [SCENE_ROOT], "locked");

/** 경로가 가리키는 것에 수정 방지가 걸려 있는가. 아직 없는 문서는 들어갈 폴더를 따른다. */
export function isLocked(s: FakeSession, raw: string): boolean {
  const p = norm(raw);
  if (p === SCENE_ROOT) return manuscriptLocked(s);
  if (p.startsWith(SCENE_ROOT + "/")) {
    const id = p.slice(SCENE_ROOT.length + 1);
    if (s.scenes[id]) return sceneLocked(s, id);
    return chapterLocked(s, id);
  }
  const t = locate(s, p);
  if (t.type === "material" || t.type === "folder" || t.type === "new") return materialLocked(s, t.path);
  return false;
}

/** 설정을 걸 자리의 이름. 문서는 확장자가 붙은 실제 경로로 적는다. */
function flagKey(s: FakeSession, raw: string): string {
  const p = norm(raw);
  if (p === SCENE_ROOT) return p;
  if (p.startsWith(SCENE_ROOT + "/")) {
    const id = p.slice(SCENE_ROOT.length + 1);
    if (s.scenes[id] || s.chapters.some((c) => c.id === id)) return p;
    throw new ApiError(404, `그런 장이나 장면이 없습니다: ${p}`);
  }
  const t = locate(s, p);
  if (t.type === "material" || t.type === "folder") return t.path;
  throw new ApiError(404, `그런 문서나 폴더가 없습니다: ${p}`);
}

export function setFlags(s: FakeSession, raw: string, patch: FlagPatch): void {
  const key = flagKey(s, raw);
  if (patch.note === true && !key.startsWith(MATERIAL_ROOT)) throw new ApiError(400, "노트는 자료에만 걸 수 있습니다");
  const next: Flags = { ...(s.flags[key] ?? {}) };
  for (const name of ["locked", "note"] as const) {
    const v = patch[name];
    if (v === null) delete next[name];
    else if (typeof v === "boolean") next[name] = v;
  }
  if (Object.keys(next).length) s.flags[key] = next;
  else delete s.flags[key];
}

/* ───────── 버전 기록 ───────── */

const HISTORY_LIMIT = 400;

function lastHash(s: FakeSession, path: string): string | null {
  for (let i = s.history.length - 1; i >= 0; i--) {
    const e = s.history[i];
    if ((e.path === path || e.to === path) && e.hash) return e.hash;
  }
  return null;
}

export function record(
  s: FakeSession,
  action: HistoryEntry["action"],
  path: string,
  content: string,
  by: By,
  extra: Extra = {},
  to: string | null = null,
): HistoryEntry {
  const prev = lastHash(s, path);
  const seq = ++s.historySeq;
  let hash = prev ?? "";
  if (action === "write") {
    hash = `v${seq}-${Math.random().toString(36).slice(2, 10)}`;
    s.versions[hash] = content;
  }
  const entry: HistoryEntry = {
    seq,
    timestamp: now(),
    action,
    path,
    to,
    by,
    hash,
    prev_hash: prev,
    chars: action === "delete" ? 0 : content.length,
    ...extra,
  };
  s.history.push(entry);
  if (s.history.length > HISTORY_LIMIT) {
    s.history.splice(0, s.history.length - HISTORY_LIMIT);
    const used = new Set<string>();
    for (const e of s.history) {
      used.add(e.hash);
      if (e.prev_hash) used.add(e.prev_hash);
    }
    for (const h of Object.keys(s.versions)) if (!used.has(h)) delete s.versions[h];
  }
  return entry;
}

/** 경로를 확장자까지 맞춰, 그 문서의 버전 기록을 돌려준다. 지워진 문서도 찾는다. */
export function historyOf(s: FakeSession, raw: string): HistoryEntry[] {
  const t = locate(s, raw);
  const p = t.type === "input" ? "입력" : t.type === "output" ? "출력" : t.type === "scene" ? `${SCENE_ROOT}/${t.id}` : t.path;
  return s.history.filter((e) => e.path === p || e.to === p);
}

/* ───────── 문서 읽고 쓰기 ───────── */

export function writeInput(s: FakeSession, content: string, by: By, extra?: Extra): boolean {
  if (s.input.content === content) return false;
  s.input = { content, updated_at: now(), by };
  record(s, "write", "입력", content, by, extra);
  return true;
}

/** 출력을 덮는다. 도구가 쓴 글은 내용이 같아도 기록한다. */
export function writeOutput(s: FakeSession, content: string, by: By, tool: string, extra?: Extra): void {
  if (s.output.content === content && !by.startsWith("tool:")) return;
  s.output = content ? { content, updated_at: now(), by, tool } : { content: "", updated_at: null, by: "", tool: "" };
  record(s, "write", "출력", content, by, extra);
}

function markSceneChanged(sc: FakeScene, content: string, by: By): void {
  sc.content = content;
  sc.updated_at = now();
  sc.by = by;
  // 직접 쓴 요약은 본문이 바뀌어도 그대로 둔다.
  if (sc.summary_state !== "manual") sc.summary_state = sc.summary ? "stale" : "none";
}

/** 문서 하나를 쓴다. 입력·출력·장면·자료를 가리지 않는다. */
export function writeDoc(s: FakeSession, raw: string, content: string, by: By, extra?: Extra): { path: string; created: boolean } {
  const t = locate(s, raw);
  switch (t.type) {
    case "input":
      writeInput(s, content, by, extra);
      return { path: "입력", created: false };
    case "output":
      writeOutput(s, content, by, by.startsWith("tool:") ? by.slice(5) : s.output.tool, extra);
      return { path: "출력", created: false };
    case "scene": {
      const sc = s.scenes[t.id];
      const path = `${SCENE_ROOT}/${t.id}`;
      if (sc.content !== content) {
        markSceneChanged(sc, content, by);
        record(s, "write", path, content, by, extra);
      }
      return { path, created: false };
    }
    case "material": {
      const m = s.materials[t.path];
      if (m.kind !== "text") throw new ApiError(400, "글 문서가 아니라서 글로 쓸 수 없습니다");
      if (m.content !== content) {
        s.materials[t.path] = { ...m, content, size: byteSize(content), updated_at: now(), by };
        record(s, "write", t.path, content, by, extra);
      }
      return { path: t.path, created: false };
    }
    case "new":
      s.materials[t.path] = { kind: "text", content, data: "", size: byteSize(content), updated_at: now(), by };
      record(s, "write", t.path, content, by, extra);
      return { path: t.path, created: true };
    case "folder":
      throw new ApiError(400, "폴더에는 글을 쓸 수 없습니다. 문서 이름까지 적어야 합니다");
    default:
      if (t.path.startsWith(SCENE_ROOT)) throw new ApiError(404, `그런 장면이 없습니다: ${t.path}`);
      throw new ApiError(400, "문서는 입력, 출력, 자료, 원고에만 쓸 수 있습니다");
  }
}

export function readDoc(s: FakeSession, raw: string): DocContent {
  const t = locate(s, raw);
  switch (t.type) {
    case "input":
      return { path: "입력", content: s.input.content, kind: "text", locked: false, note: false };
    case "output":
      return { path: "출력", content: s.output.content, kind: "text", locked: false, note: false };
    case "scene":
      return { path: `${SCENE_ROOT}/${t.id}`, content: s.scenes[t.id].content, kind: "text", locked: sceneLocked(s, t.id), note: false };
    case "material": {
      const m = s.materials[t.path];
      return { path: t.path, content: m.kind === "text" ? m.content : "", kind: m.kind, locked: materialLocked(s, t.path), note: materialNote(s, t.path) };
    }
    default:
      throw new ApiError(404, `문서가 없습니다: ${norm(raw)}`);
  }
}

/** 문서의 글. 없으면 null. */
export function textOf(s: FakeSession, raw: string): string | null {
  const t = locate(s, raw);
  if (t.type === "input") return s.input.content;
  if (t.type === "output") return s.output.content;
  if (t.type === "scene") return s.scenes[t.id].content;
  if (t.type === "material" && s.materials[t.path].kind === "text") return s.materials[t.path].content;
  return null;
}

function dropFlags(s: FakeSession, path: string, withChildren: boolean): void {
  for (const k of Object.keys(s.flags)) if (k === path || (withChildren && k.startsWith(path + "/"))) delete s.flags[k];
}

/** 자료 문서나 폴더를 지운다. 지운 경로들을 돌려준다. */
export function deleteDoc(s: FakeSession, raw: string, by: By): string[] {
  const t = locate(s, raw);
  if (t.type === "input") {
    writeInput(s, "", by);
    return ["입력"];
  }
  if (t.type === "output") {
    writeOutput(s, "", by, "");
    return ["출력"];
  }
  if (t.type === "scene") throw new ApiError(400, "장면은 원고에서 지웁니다");
  if (t.type === "material") {
    const m = s.materials[t.path];
    record(s, "delete", t.path, m.content, by);
    delete s.materials[t.path];
    dropFlags(s, t.path, false);
    return [t.path];
  }
  if (t.type === "folder") {
    if (t.path === MATERIAL_ROOT) throw new ApiError(400, "자료 전체는 한 번에 지울 수 없습니다");
    const paths = Object.keys(s.materials).filter((p) => p.startsWith(t.path + "/"));
    for (const p of paths) {
      record(s, "delete", p, s.materials[p].content, by);
      delete s.materials[p];
    }
    // 만들어 둔 폴더(빈 폴더, 안쪽 폴더)도 같이 없어진다.
    s.folders = (s.folders ?? []).filter((f) => f !== t.path && !f.startsWith(t.path + "/"));
    dropFlags(s, t.path, true);
    return paths;
  }
  throw new ApiError(404, `문서가 없습니다: ${norm(raw)}`);
}

/** 같은 이름이 있으면 뒤에 번호를 붙인다. */
export function uniquePath(s: FakeSession, path: string): string {
  if (!s.materials[path]) return path;
  const m = path.match(/^(.*?)(\.[^./]+)?$/)!;
  for (let n = 2; ; n++) {
    const candidate = `${m[1]} ${n}${m[2] ?? ""}`;
    if (!s.materials[candidate]) return candidate;
  }
}

function moveOne(s: FakeSession, from: string, to: string, by: By): void {
  const m = s.materials[from];
  delete s.materials[from];
  s.materials[to] = { ...m, updated_at: now() };
  if (s.flags[from]) {
    s.flags[to] = s.flags[from];
    delete s.flags[from];
  }
  // 기록이 문서를 따라가게 옛 줄의 경로를 고쳐 둔다.
  for (const e of s.history) if (e.path === from && e.action !== "move") e.path = to;
  record(s, "move", from, m.content, by, {}, to);
}

/** 자료 안에서 옮기기·이름 바꾸기, 폴더째 옮기기, 출력을 자료로 옮기기. */
export function moveDoc(s: FakeSession, source: string, destination: string, by: By): { path: string; moved: [string, string][] } {
  let dest = norm(destination);
  if (!dest.startsWith(MATERIAL_ROOT + "/")) throw new ApiError(400, "자료 아래로만 옮길 수 있습니다");
  const t = locate(s, source);

  if (t.type === "output") {
    if (!s.output.content) throw new ApiError(400, "출력이 비어 있습니다");
    if (isFolder(s, dest) && !s.materials[dest]) dest = `${dest}/${s.output.tool ? "출력" : "새 문서"}`;
    if (!/\.md$/i.test(dest)) dest += ".md";
    if (s.materials[dest]) throw new ApiError(409, `같은 이름의 문서가 이미 있습니다: ${dest}`);
    const content = s.output.content;
    const author = s.output.by || by;
    s.materials[dest] = { kind: "text", content, data: "", size: byteSize(content), updated_at: now(), by: author };
    record(s, "write", dest, content, author);
    s.output = { content: "", updated_at: null, by: "", tool: "" };
    record(s, "move", "출력", content, by, {}, dest);
    return { path: dest, moved: [] };
  }

  if (t.type === "material") {
    const ext = t.path.match(/\.[^./]+$/)?.[0] ?? "";
    // 폴더를 가리키면 그 안으로 넣는다.
    if (isFolder(s, dest) && !s.materials[dest]) dest = `${dest}/${t.path.split("/").pop()}`;
    else if (ext && !dest.toLowerCase().endsWith(ext.toLowerCase())) dest += ext;
    if (dest === t.path) return { path: dest, moved: [] };
    if (s.materials[dest]) throw new ApiError(409, `같은 이름의 문서가 이미 있습니다: ${dest}`);
    moveOne(s, t.path, dest, by);
    return { path: dest, moved: [[t.path, dest]] };
  }

  if (t.type === "folder") {
    if (t.path === MATERIAL_ROOT) throw new ApiError(400, "자료 전체는 옮길 수 없습니다");
    if (dest === t.path) return { path: dest, moved: [] };
    if (dest.startsWith(t.path + "/")) throw new ApiError(400, "폴더를 자기 안으로 옮길 수 없습니다");
    const pairs = Object.keys(s.materials)
      .filter((p) => p.startsWith(t.path + "/"))
      .map((p) => [p, dest + p.slice(t.path.length)] as [string, string]);
    const clash = pairs.find(([, to]) => s.materials[to]);
    if (clash) throw new ApiError(409, `같은 이름의 문서가 이미 있습니다: ${clash[1]}`);
    for (const [from, to] of pairs) moveOne(s, from, to, by);
    // 빈 폴더와 안에 든 폴더도 같이 간다. 옮긴 폴더는 안이 비어도 남게 적어 둔다.
    s.folders = [...new Set([...(s.folders ?? []).map((f) => (f === t.path || f.startsWith(t.path + "/") ? dest + f.slice(t.path.length) : f)), dest])];
    for (const k of Object.keys(s.flags)) {
      if (k === t.path || k.startsWith(t.path + "/")) {
        s.flags[dest + k.slice(t.path.length)] = s.flags[k];
        delete s.flags[k];
      }
    }
    return { path: dest, moved: pairs };
  }

  if (t.type === "scene") throw new ApiError(400, "장면은 원고에서 옮깁니다");
  throw new ApiError(404, `문서가 없습니다: ${norm(source)}`);
}

/** 예전 버전으로 되돌린다. 지워진 문서나 장면이면 다시 만든다. */
export function restore(s: FakeSession, raw: string, hash: string, by: By): { path: string } {
  const content = s.versions[hash];
  if (content === undefined) throw new ApiError(404, "그 버전을 찾지 못했습니다");
  const p = norm(raw);
  const sceneId = p.startsWith(SCENE_ROOT + "/") ? p.slice(SCENE_ROOT.length + 1) : "";
  if (sceneId && !s.scenes[sceneId]) {
    // 지워진 장면은 같은 id로 마지막 장 끝에 되살린다.
    if (!/^s\d+$/.test(sceneId)) throw new ApiError(404, `그런 장면이 없습니다: ${p}`);
    const ch = s.chapters[s.chapters.length - 1] ?? createChapter(s, {});
    s.scenes[sceneId] = { id: sceneId, summary: "", summary_state: "none", content, updated_at: now(), by };
    ch.scenes.push(sceneId);
    record(s, "write", p, content, by);
    return { path: p };
  }
  return { path: writeDoc(s, p, content, by).path };
}

/* ───────── 원고 ───────── */

export function orderedScenes(s: FakeSession): FakeScene[] {
  return s.chapters.flatMap((c) => c.scenes.map((id) => s.scenes[id]).filter(Boolean));
}

export function manuscriptChars(s: FakeSession): number {
  return orderedScenes(s).reduce((n, sc) => n + sc.content.length, 0);
}

function findChapter(s: FakeSession, id: string): FakeChapter {
  const ch = s.chapters.find((c) => c.id === id);
  if (!ch) throw new ApiError(404, `그런 장이 없습니다: ${id}`);
  return ch;
}

function findScene(s: FakeSession, id: string): FakeScene {
  const sc = s.scenes[id];
  if (!sc) throw new ApiError(404, `그런 장면이 없습니다: ${id}`);
  return sc;
}

/** `after`의 뜻: 안 주면 맨 끝, null이면 맨 앞, id면 그것 뒤. */
function insertAt(list: string[], id: string, after: string | null | undefined, what: string): void {
  if (after === undefined) list.push(id);
  else if (after === null) list.unshift(id);
  else {
    const i = list.indexOf(after);
    if (i === -1) throw new ApiError(400, `${what}에 그런 자리가 없습니다: ${after}`);
    list.splice(i + 1, 0, id);
  }
}

export function createChapter(s: FakeSession, body: { after?: string | null }): FakeChapter {
  const ch: FakeChapter = { id: `c${s.nextChapter++}`, summary: "", scenes: [] };
  const ids = s.chapters.map((c) => c.id);
  insertAt(ids, ch.id, body.after, "원고");
  const all = [...s.chapters, ch];
  s.chapters = ids.map((id) => all.find((c) => c.id === id)!);
  return ch;
}

export function patchChapter(s: FakeSession, id: string, body: { summary?: string }): void {
  const ch = findChapter(s, id);
  if (body.summary !== undefined) ch.summary = body.summary;
}

export function moveChapter(s: FakeSession, id: string, after: string | null): void {
  const ch = findChapter(s, id);
  if (after === id) return;
  const rest = s.chapters.filter((c) => c.id !== id);
  const ids = rest.map((c) => c.id);
  insertAt(ids, id, after, "원고");
  s.chapters = ids.map((x) => (x === id ? ch : rest.find((c) => c.id === x)!));
}

export function deleteChapter(s: FakeSession, id: string): void {
  const ch = findChapter(s, id);
  if (ch.scenes.length) throw new ApiError(409, "장면이 있는 장은 지울 수 없습니다. 장면을 먼저 옮기거나 지워야 합니다");
  s.chapters = s.chapters.filter((c) => c.id !== id);
  delete s.flags[`${SCENE_ROOT}/${id}`];
}

/** 장면을 넣는다. `by`는 한 주체이고, 출력에서 가져온 글은 그 글을 쓴 주체가 남는다. */
export function addScene(s: FakeSession, body: NewScene, by: By, extra?: Extra): { id: string; path: string; chapter: string } {
  let content = body.content ?? "";
  let author = by;
  if (body.from_output) {
    if (!s.output.content) throw new ApiError(400, "출력이 비어 있습니다");
    content = s.output.content;
    author = s.output.by || by;
  }
  const ch = body.new_chapter
    ? createChapter(s, {})
    : body.chapter !== undefined
      ? findChapter(s, body.chapter)
      : (s.chapters[s.chapters.length - 1] ?? createChapter(s, {}));
  if (typeof body.after === "string" && !ch.scenes.includes(body.after)) throw new ApiError(400, `그 장에 그런 장면이 없습니다: ${body.after}`);
  const id = `s${s.nextScene++}`;
  s.scenes[id] = { id, summary: "", summary_state: "none", content, updated_at: now(), by: author };
  insertAt(ch.scenes, id, body.new_chapter ? undefined : body.after, "장");
  const path = `${SCENE_ROOT}/${id}`;
  record(s, "write", path, content, author, extra);
  if (body.from_output) {
    s.output = { content: "", updated_at: null, by: "", tool: "" };
    record(s, "move", "출력", content, by, {}, path);
  }
  return { id, path, chapter: ch.id };
}

export function patchScene(s: FakeSession, id: string, body: { summary?: string | null }): void {
  const sc = findScene(s, id);
  if (body.summary === null) {
    // 직접 쓴 요약을 지운다. 에이전트나 도구가 다시 붙일 수 있게 된다.
    sc.summary = "";
    sc.summary_state = "none";
  } else if (body.summary !== undefined) {
    sc.summary = body.summary;
    sc.summary_state = "manual";
  }
}

export function moveScene(s: FakeSession, id: string, to: { chapter: string; after: string | null }): void {
  findScene(s, id);
  const target = findChapter(s, to.chapter);
  if (to.after === id) return;
  if (typeof to.after === "string" && !target.scenes.includes(to.after)) throw new ApiError(400, `그 장에 그런 장면이 없습니다: ${to.after}`);
  for (const c of s.chapters) c.scenes = c.scenes.filter((x) => x !== id);
  insertAt(target.scenes, id, to.after, "장");
}

/**
 * 글을 주어진 글자 위치에서 자른다. 자른 자리의 빈 줄은 어느 조각에도 넣지 않는다
 * (합칠 때 빈 줄 하나로 잇기 때문이다). 문단 경계에서 자르면 조각을 빈 줄로 이은 것이 원문과 같다.
 */
export function cutText(text: string, at: number[]): string[] {
  const cuts = [...new Set(at.map((n) => Math.floor(n)).filter((n) => n > 0 && n < text.length))].sort((a, b) => a - b);
  const raw: string[] = [];
  let from = 0;
  for (const c of [...cuts, text.length]) {
    raw.push(text.slice(from, c));
    from = c;
  }
  return raw
    .map((piece, i) => {
      let t = piece;
      if (i > 0) t = t.replace(/^\s+/, "");
      if (i < raw.length - 1) t = t.replace(/\s+$/, "");
      return t;
    })
    .filter((piece) => piece.length > 0);
}

/** 조각들을 다시 잇는다. `cutText`의 짝이다. */
export function joinPieces(pieces: string[]): string {
  return pieces.filter((p) => p.length > 0).join("\n\n");
}

/** 장면을 나눈다. 첫 조각이 원래 id를 갖고, 나머지는 바로 뒤에 차례로 들어간다. */
export function splitScene(s: FakeSession, id: string, at: number[], by: By, extra?: Extra): { ids: string[] } {
  const sc = findScene(s, id);
  const pieces = cutText(sc.content, at);
  if (pieces.length < 2) throw new ApiError(400, "나눌 자리가 없습니다. 글의 처음과 끝 사이의 위치를 줘야 합니다");
  const ch = chapterOf(s, id);
  const path = `${SCENE_ROOT}/${id}`;
  markSceneChanged(sc, pieces[0], sc.by);
  record(s, "write", path, pieces[0], by, extra);
  const ids = [id];
  let after = id;
  for (const piece of pieces.slice(1)) {
    const nid = `s${s.nextScene++}`;
    s.scenes[nid] = { id: nid, summary: "", summary_state: "none", content: piece, updated_at: now(), by: sc.by };
    if (ch) insertAt(ch.scenes, nid, after, "장");
    record(s, "write", `${SCENE_ROOT}/${nid}`, piece, by, extra);
    ids.push(nid);
    after = nid;
  }
  return { ids };
}

/** 적힌 순서대로 첫 장면에 합친다. 나머지 장면은 없어진다. */
export function mergeScenes(s: FakeSession, ids: string[], by: By, extra?: Extra): { id: string } {
  const list = [...new Set(ids)];
  if (list.length < 2) throw new ApiError(400, "합칠 장면을 둘 이상 줘야 합니다");
  const scenes = list.map((id) => findScene(s, id));
  const first = scenes[0];
  const merged = joinPieces(scenes.map((sc) => sc.content));
  markSceneChanged(first, merged, first.by);
  record(s, "write", `${SCENE_ROOT}/${first.id}`, merged, by, extra);
  for (const sc of scenes.slice(1)) removeScene(s, sc.id, by);
  return { id: first.id };
}

function removeScene(s: FakeSession, id: string, by: By): void {
  const sc = findScene(s, id);
  record(s, "delete", `${SCENE_ROOT}/${id}`, sc.content, by);
  for (const c of s.chapters) c.scenes = c.scenes.filter((x) => x !== id);
  delete s.scenes[id];
  delete s.flags[`${SCENE_ROOT}/${id}`];
}

export function deleteScene(s: FakeSession, id: string, by: By): void {
  removeScene(s, id, by);
}

/** 요약 흉내: 본문의 첫 문장. 이미지 줄과 제목 줄은 건너뛴다. */
export function firstSentence(text: string): string {
  const body = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^!\[[^\]]*\]\([^)]*\)$/.test(l) && !l.startsWith("#"))
    .join(" ");
  const m = body.match(/^.*?[.!?…。]["”’')\]]*(?=\s|$)/);
  let out = (m ? m[0] : body).trim();
  if (out.length > 90) out = out.slice(0, 88).trimEnd() + "…";
  return out;
}

/** 요약을 붙여야 하는 장면들: 글이 있고, 요약이 없거나 낡았다. 직접 쓴 요약은 들지 않는다. */
export function scenesToSummarize(s: FakeSession): FakeScene[] {
  return orderedScenes(s).filter((sc) => sc.content.trim() && (sc.summary_state === "none" || sc.summary_state === "stale"));
}

/** 에이전트나 도구가 만든 요약을 붙인다. 직접 쓴 요약은 덮지 않는다. 붙였으면 true. */
export function attachSummary(s: FakeSession, id: string, summary: string): boolean {
  const sc = s.scenes[id];
  if (!sc || sc.summary_state === "manual" || !summary.trim()) return false;
  sc.summary = summary.trim();
  sc.summary_state = "ok";
  return true;
}

/** 사람에게 보일 장면 이름. 제목이 없으니 자리뿐이다: `1장 2번째 장면` */
export function sceneName(s: FakeSession, id: string): string {
  const ci = s.chapters.findIndex((c) => c.scenes.includes(id));
  if (ci === -1) return id;
  return `${ci + 1}장 ${s.chapters[ci].scenes.indexOf(id) + 1}번째 장면`;
}

export function chapterName(s: FakeSession, id: string): string {
  const ci = s.chapters.findIndex((c) => c.id === id);
  return ci === -1 ? id : `${ci + 1}장`;
}

/** 글의 첫 줄(80자까지). 요약이 아직 없는 장면을 목록에서 알아보는 데 쓴다. */
export function headOf(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 80);
}

/* ───────── @include ───────── */

/** `@include:` 뒤에 적힌 것이 무엇을 가리키는지. */
export function resolveRef(s: FakeSession, raw: string): ResolvedRef {
  const ref = norm(String(raw ?? "").replace(/^@include:/, ""));
  const missing: ResolvedRef = { kind: "missing", path: ref, title: "" };
  if (!ref || ref === "입력") return missing;
  if (ref === "출력") return { kind: "doc", path: "출력", title: "출력" };
  if (ref === SCENE_ROOT) return { kind: "manuscript", path: SCENE_ROOT, title: "원고" };
  if (ref.startsWith(SCENE_ROOT + "/")) {
    const rest = ref.slice(SCENE_ROOT.length + 1);
    const nth = rest.match(/^(\d+)장$/);
    const ch = nth ? s.chapters[Number(nth[1]) - 1] : s.chapters.find((c) => c.id === rest);
    if (ch) return { kind: "chapter", path: `${SCENE_ROOT}/${ch.id}`, title: chapterName(s, ch.id) };
    if (s.scenes[rest]) return { kind: "scene", path: `${SCENE_ROOT}/${rest}`, title: sceneName(s, rest) };
    return missing;
  }
  const t = locate(s, ref);
  if (t.type === "material") return { kind: "doc", path: t.path, title: baseName(t.path) };
  if (t.type === "folder") return { kind: "folder", path: t.path, title: baseName(t.path) };
  return missing;
}

function chapterText(s: FakeSession, ch: FakeChapter): string {
  return joinPieces(ch.scenes.map((id) => s.scenes[id]?.content ?? ""));
}

/** 가리킨 것의 내용. 도구에 들어갈 글이다. */
export function refContent(s: FakeSession, target: ResolvedRef): string {
  switch (target.kind) {
    case "doc": {
      if (target.path === "출력") return s.output.content;
      const m = s.materials[target.path];
      if (!m) return "";
      return m.kind === "text" ? m.content : `![${baseName(target.path).replace(/\.[^.]+$/, "")}](${target.path})`;
    }
    case "folder":
      return Object.keys(s.materials)
        .filter((p) => p.startsWith(target.path + "/") && s.materials[p].kind === "text")
        .sort((a, b) => a.localeCompare(b, "ko"))
        .map((p) => `## ${p.slice(target.path.length + 1).replace(/\.md$/i, "")}\n\n${s.materials[p].content}`)
        .join("\n\n");
    case "scene":
      return s.scenes[target.path.slice(SCENE_ROOT.length + 1)]?.content ?? "";
    case "chapter": {
      const ch = s.chapters.find((c) => `${SCENE_ROOT}/${c.id}` === target.path);
      return ch ? chapterText(s, ch) : "";
    }
    case "manuscript":
      return s.chapters
        .filter((c) => c.scenes.length)
        .map((c) => `## ${chapterName(s, c.id)}\n\n${chapterText(s, c)}`)
        .join("\n\n");
    default:
      return `[없는 문서: ${target.path}]`;
  }
}

export interface IncludeSpan {
  start: number; // `@include:`의 시작
  end: number; // 경로의 끝
  ref: string;
  target: ResolvedRef;
}

/**
 * 글 안의 `@include:경로`를 찾는다. 경로에 빈칸이 있을 수 있어서(`자료/장소/종점 정류장`),
 * 줄 끝까지를 후보로 잡고 실제로 있는 문서가 나올 때까지 뒤에서부터 낱말을 덜어 본다.
 */
export function findIncludes(s: FakeSession, text: string): IncludeSpan[] {
  const out: IncludeSpan[] = [];
  const marker = "@include:";
  let i = text.indexOf(marker);
  while (i !== -1) {
    const from = i + marker.length;
    const nl = text.indexOf("\n", from);
    const line = text.slice(from, nl === -1 ? text.length : nl);
    let found: IncludeSpan | null = null;
    let cand = line.replace(/\s+$/, "");
    while (cand && !found) {
      for (const c of [cand, cand.replace(/[.,;:!?)\]"'’”]+$/, "")]) {
        const target = c ? resolveRef(s, c) : null;
        if (target && target.kind !== "missing") {
          found = { start: i, end: from + c.length, ref: c, target };
          break;
        }
      }
      const cut = cand.search(/\s+\S*$/);
      cand = cut > 0 ? cand.slice(0, cut) : "";
    }
    if (!found) {
      const word = line.match(/^\S*/)?.[0] ?? "";
      found = { start: i, end: from + word.length, ref: word, target: { kind: "missing", path: norm(word), title: "" } };
    }
    out.push(found);
    i = text.indexOf(marker, Math.max(found.end, from));
  }
  return out;
}

/** 입력의 `@include`를 실제 내용으로 바꾼다. 불러온 글 안의 `@include`는 다시 풀지 않는다. */
export function expandIncludes(s: FakeSession, text: string): string {
  let out = "";
  let pos = 0;
  for (const span of findIncludes(s, text)) {
    out += text.slice(pos, span.start) + refContent(s, span.target);
    pos = span.end;
  }
  return out + text.slice(pos);
}

/* ───────── 한 번에 받는 작업 공간 ───────── */

/** `conv`는 컨텍스트의 크기를 볼 대화다. 나머지는 작업의 것이라 어느 대화로 받아도 같다. */
export function buildWorkspace(st: FakeState, s: FakeSession, conv: FakeConversation): Workspace {
  const materials: Material[] = Object.keys(s.materials)
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((path) => {
      const m = s.materials[path];
      return {
        path,
        kind: m.kind,
        chars: m.kind === "text" ? m.content.length : 0,
        size: m.size,
        locked: materialLocked(s, path),
        note: materialNote(s, path),
        updated_at: m.updated_at,
        by: m.by,
      };
    });
  const chapters: Chapter[] = s.chapters.map((c, ci) => ({
    id: c.id,
    number: ci + 1,
    summary: c.summary,
    locked: chapterLocked(s, c.id),
    scenes: c.scenes
      .map((id) => s.scenes[id])
      .filter(Boolean)
      .map((sc, si) => ({
        id: sc.id,
        path: `${SCENE_ROOT}/${sc.id}`,
        number: si + 1,
        summary: sc.summary,
        summary_state: sc.summary_state,
        head: headOf(sc.content),
        chars: sc.content.length,
        locked: sceneLocked(s, sc.id),
        updated_at: sc.updated_at,
        by: sc.by,
      })),
  }));
  return {
    state: sessionState(st, s),
    input: { chars: s.input.content.length, updated_at: s.input.updated_at, by: s.input.by },
    output: { chars: s.output.content.length, updated_at: s.output.updated_at, by: s.output.by, tool: s.output.tool },
    materials,
    folders: folderList(s),
    flags: clone(s.flags),
    manuscript: { chars: manuscriptChars(s), locked: manuscriptLocked(s), chapters },
    context: { conversation_id: conv.id, tokens: conv.contextTokens, budget: getPreset(st, s.state.preset_id).context_budget },
  };
}

/* ───────── 내보내기 ───────── */

/**
 * 원고를 한 파일의 글로. `txt`는 글만, `md`는 이미지 경로가 남는다.
 * 장이 둘 이상이면 장마다 번호(`1장`)가 머리로 들어간다. `chapters`가 false면 넣지 않는다.
 */
export function exportText(s: FakeSession, format: "md" | "txt", chapters = true): string {
  const isImage = (l: string) => /^!\[[^\]]*\]\([^)]*\)$/.test(l.trim());
  const blocks: string[] = [format === "md" ? `# ${s.name}` : s.name];
  const numbered = chapters && s.chapters.length > 1;
  s.chapters.forEach((c, i) => {
    if (numbered) blocks.push(format === "md" ? `## ${i + 1}장` : `${i + 1}장`);
    for (const id of c.scenes) {
      let body = s.scenes[id]?.content ?? "";
      if (format === "txt")
        body = body
          .split("\n")
          .filter((l) => !isImage(l))
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      if (body.trim()) blocks.push(body);
    }
  });
  return blocks.join("\n\n") + "\n";
}

/** 새 작업 하나. 프리셋의 시작 자료가 깔린다. */
export function newSession(st: FakeState, id: string, name: string, presetId: string): FakeSession {
  const preset = getPreset(st, presetId);
  const s: FakeSession = {
    id,
    name,
    created_at: now(),
    // 프리셋이 시작 모드를 정해 두었으면 그것으로 연다. 만들 때 한 번뿐이다 (그 뒤에 프리셋을 바꿔도 모드는 그대로다).
    state: { preset_id: preset.id, mode: preset.start_mode || "auto", bypass_locks: false, auto_compact: true, conversation: MAIN },
    input: { content: "", updated_at: null, by: "" },
    output: { content: "", updated_at: null, by: "", tool: "" },
    materials: {},
    flags: {},
    chapters: [],
    scenes: {},
    nextScene: 1,
    nextChapter: 1,
    history: [],
    versions: {},
    historySeq: 0,
    toolRuns: [],
    conversations: [newConversation(MAIN)],
    seq: 0,
    run: { run_id: null, conversation_id: null, running: false, status: "", waiting: false },
    variant: 0,
  };
  for (const [path, content] of Object.entries(preset.starter)) writeDoc(s, path, content, "preset");
  for (const path of preset.starter_notes) {
    const t = locate(s, path);
    if (t.type === "material") s.flags[t.path] = { ...(s.flags[t.path] ?? {}), note: true };
  }
  return s;
}
