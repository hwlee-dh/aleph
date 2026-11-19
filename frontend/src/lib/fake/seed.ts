/* 처음 상태. 작업 둘과 지난 대화 둘을, 실제로 그렇게 쓴 것처럼 차례대로 만들어 둔다. */
import { BRIEF, BUS_STOP_SVG, BUS_STOP_URL, CHARACTER, fill, IMAGE_LINE, PLACE, PLAN, SEED_SCENES, seedProviders, UPLOADED_TEXT } from "./data";
import {
  addScene,
  appendEvent,
  attachSummary,
  conversationOf,
  createChapter,
  createConversation,
  effectiveModel,
  expandIncludes,
  MAIN,
  nameFromRequest,
  newSession,
  now,
  patchScene,
  record,
  setClock,
  writeDoc,
  writeInput,
  writeOutput,
  type FakeConversation,
  type FakeSession,
  type FakeState,
} from "./state";
import type { RunEvent } from "../types";

const HOUR = 3_600_000;

export function seedState(): FakeState {
  const st: FakeState = { v: 3, providers: seedProviders(), presets: {}, sessions: [], counter: 2 };
  // 쓰기마다 시각이 조금씩 흐르게 해서 버전 기록이 그럴듯한 순서로 남게 한다.
  let t = Date.now() - 50 * HOUR;
  setClock(() => new Date((t += 47_000)).toISOString());
  try {
    st.sessions.push(
      winter(st, () => (t = Date.now() - 21 * HOUR)),
      homecoming(st),
    );
  } finally {
    setClock(null);
  }
  return st;
}

function winter(st: FakeState, nextDay: () => void): FakeSession {
  const s = newSession(st, "fake-1", "겨울 정류장", "basic");
  const scene = (i: number) => fill(SEED_SCENES[i], "서윤", "종점 정류장");

  writeDoc(s, "자료/브리프", BRIEF, "user");
  writeDoc(s, "자료/인물/서윤", CHARACTER, "user");
  writeDoc(s, "자료/장소/종점 정류장", PLACE, "agent");
  const image = "자료/삽화/정류장.svg";
  s.materials[image] = { kind: "image", content: "", data: BUS_STOP_URL, size: BUS_STOP_SVG.length, updated_at: now(), by: "user" };
  record(s, "write", image, "", "user");

  const c1 = createChapter(s, {});
  const first = addScene(s, { content: scene(0), chapter: c1.id }, "tool:compose");
  const second = addScene(s, { content: scene(1), chapter: c1.id }, "tool:compose");
  // 내가 첫 문단 뒤에 삽화를 넣었다.
  const paragraphs = scene(0).split("\n\n");
  writeDoc(s, first.path, [paragraphs[0], IMAGE_LINE, ...paragraphs.slice(1)].join("\n\n"), "user");
  writeDoc(s, "자료/계획", PLAN, "agent");
  // 요약 상태를 고루 둔다: 첫 장면은 에이전트가 붙인 것, 둘째는 내가 직접 쓴 것, 아래의 셋째는 아직 없다.
  attachSummary(s, first.id, "막차가 끊긴 종점 정류장에서 서윤이 귤이 든 봉투를 쥐고 앉아 십 년 전을 떠올린다.");
  patchScene(s, second.id, { summary: "첫차를 기다리며 귤을 반만 먹고, 남은 반쪽을 빈 옆자리에 올려 둔다." });

  // 다음 날: 에이전트에게 다음 장면을 시켰고, 나온 글을 내가 새 장으로 옮겼다.
  nextDay();
  seedRun(st, s, `원고/${second.id}`, scene(2));
  addScene(s, { from_output: true, new_chapter: true }, "user");

  // 그 뒤에 새 대화를 열어 짧게 물었다. 화면은 기록이 긴 첫 대화를 보고 있다.
  seedQuestion(st, s);
  s.state.conversation = MAIN;

  s.flags["자료/장소"] = { locked: true };
  return s;
}

/** 씨앗 실행 하나의 이벤트를 대화에 붙이는 함수를 만든다. */
function recorder(s: FakeSession, conv: FakeConversation, runId: string): (e: RunEvent) => void {
  return (e) => appendEvent(conv, { ...e, seq: ++s.seq, run_id: runId, conversation_id: conv.id, timestamp: now() });
}

/** 첫 대화의 한 차례: 입력을 준비하고 `집필`을 돌려 출력에 썼다. */
function seedRun(st: FakeState, s: FakeSession, previous: string, text: string): void {
  const runId = "seed-run-1";
  const model = effectiveModel(st, s);
  const goal = "2장의 첫 장면을 써 줘. 눈이 그치고 첫차가 온다.";
  const conv = conversationOf(s, MAIN);
  nameFromRequest(conv, goal);
  const push = recorder(s, conv, runId);
  const call = (n: number, tool: string, label: string, args: Record<string, unknown>, user_tool = false) =>
    push({ type: "tool_call", tool, label, tool_call_id: `${runId}-c${n}`, args, tool_call_index: n, user_tool });
  const result = (n: number, tool: string, text_: string, changed: string[]) =>
    push({ type: "tool_result", tool, tool_call_id: `${runId}-c${n}`, result: text_, ok: true, changed });

  push({ type: "run_started", kind: "agent", mode: "auto", agent_model: model, preset_name: "기본", bypass_locks: false });
  push({ type: "user_message", text: goal });

  call(1, "read", "문서 읽기", { path: "자료/브리프" });
  result(1, "read", `${BRIEF.length}자를 읽었습니다.`, []);

  const input = `@include:자료/브리프\n@include:자료/인물/서윤\n\n앞 장면:\n@include:${previous}\n\n요청: ${goal}`;
  call(2, "write_input", "입력 쓰기", { content: input });
  writeInput(s, input, "agent", { origin: { tool_call_id: `${runId}-c2`, model } });
  result(2, "write_input", `입력을 ${input.length}자로 썼습니다.`, ["입력"]);

  call(3, "compose", "집필", {}, true);
  const size = Math.ceil(text.length / 4);
  for (let i = 0; i < text.length; i += size) push({ type: "tool_stream", tool: "compose", tool_call_id: `${runId}-c3`, delta: text.slice(i, i + size) });
  const duration_ms = 8200;
  s.toolRuns.push({
    seq: 1,
    timestamp: now(),
    tool: "compose",
    label: "집필",
    by: "agent",
    model,
    duration_ms,
    input: expandIncludes(s, input),
    input_raw: input,
    output: text,
    error: null,
    target: null,
    tool_call_id: `${runId}-c3`,
  });
  writeOutput(s, text, "tool:compose", "compose", {
    origin: { tool_call_id: `${runId}-c3`, model },
    tool_run: { tool: "compose", label: "집필", model, duration_ms, run_seq: 1 },
  });
  result(3, "compose", `${text.length}자를 출력에 썼습니다.`, ["출력"]);

  push({ type: "text", id: `${runId}-p1`, text: "〈집필〉 도구로 2장의 첫 장면을 출력에 썼습니다. 원고에 넣으려면 말씀해 주세요." });
  push({
    type: "done",
    status: "completed",
    total_tool_calls: 3,
    elapsed_sec: 11.4,
    usage: { agent_model: model, prompt_tokens: 18400, output_tokens: 620, cache_read_tokens: 15100, cost_usd: 0.0131, context_tokens: 18400 },
  });
  conv.contextTokens = 18400;
  s.run = { run_id: runId, conversation_id: conv.id, running: false, status: "completed", waiting: false };
}

/** 둘째 대화: 도구 없이 묻고 답만 들었다. */
function seedQuestion(st: FakeState, s: FakeSession): void {
  const runId = "seed-run-2";
  const model = effectiveModel(st, s);
  const goal = "3장은 어디서 시작하면 좋을까?";
  const conv = createConversation(s);
  nameFromRequest(conv, goal);
  const push = recorder(s, conv, runId);

  push({ type: "run_started", kind: "agent", mode: "auto", agent_model: model, preset_name: "기본", bypass_locks: false });
  push({ type: "user_message", text: goal });
  push({ type: "text", id: `${runId}-p1`, text: "2장이 첫차가 오는 데서 끝나니, 3장은 서윤이 버스에서 내리는 곳에서 시작하면 자연스럽습니다. 쓰려면 말씀해 주세요." });
  push({
    type: "done",
    status: "completed",
    total_tool_calls: 0,
    elapsed_sec: 2.1,
    usage: { agent_model: model, prompt_tokens: 2100, output_tokens: 48, cache_read_tokens: 0, cost_usd: 0.0006, context_tokens: 2100 },
  });
  conv.contextTokens = 2100;
  s.run = { run_id: runId, conversation_id: conv.id, running: false, status: "completed", waiting: false };
}

function homecoming(st: FakeState): FakeSession {
  const s = newSession(st, "fake-2", "돌아오는 길", "continue");
  writeDoc(s, "자료/올린 글/돌아오는 길", UPLOADED_TEXT, "user");
  return s;
}
