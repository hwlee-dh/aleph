/* 엔진과 화면 사이의 약속(backend/API.md)을 그대로 옮긴 타입. */

export type Mode = "manual" | "auto" | "autonomous" | "plan";
export type Thinking = "default" | "off" | "low" | "medium" | "high";

export interface ExtraField {
  name: string;
  label: string;
  placeholder: string;
  env: string | null;
  secret: boolean;
  multiline: boolean;
}

export interface ProviderKind {
  id: string;
  label: string;
  group: "direct" | "platform" | "aggregator" | "local" | "custom";
  needs_key: boolean;
  key_optional: boolean;
  env_key: string | null;
  default_base_url: string | null;
  base_url_editable: boolean;
  tested: boolean;
  note: string;
  key_url: string;
  extra: ExtraField[];
}

export interface Provider {
  id: string;
  kind: string;
  label: string;
  base_url: string;
  effective_base_url: string;
  extra: Record<string, string>;
  secrets: Record<string, { set: boolean; summary: string }>;
  enabled: boolean;
  has_key: boolean;
  key_source: "config" | "env" | null;
  ready: boolean;
  tested: boolean;
}

export interface ModelEntry {
  id: string;
  label: string;
  context?: number;
  price_in?: number;
  price_out?: number;
}

/** 요약 도구의 영문 이름. 프리셋에 이 이름의 도구가 없으면 `+ 도구`에서 다시 넣을 수 있다 (`meta.summary_tool`). */
export const SUMMARY_TOOL = "summarize";

/**
 * 도구는 언제나 입력을 읽고 출력에 쓴다.
 * 모델, 온도, 추론 수준, 최대 출력은 비우면 프리셋의 보조 값을 따른다.
 */
export interface ToolDef {
  name: string; // 영문 id. 비워 보내면 서버가 정한다
  label: string; // 화면에 보이는 이름. `/집필`의 그 이름
  description: string; // 에이전트가 읽는 설명
  prompt: string; // 지시문
  model: string; // ""이면 보조 모델
  temperature: number | null; // null이면 보조의 온도
  thinking: Thinking | ""; // ""이면 보조의 추론 수준. "default"는 모델의 기본값
  max_tokens: number | null; // 최대 출력. null이면 보조의 최대 출력
  enabled: boolean;
}

/** 프리셋은 지침, 모델 설정(에이전트와 보조 두 묶음), 도구 한 벌이다. 모델 설정은 프리셋에만 있다. */
export interface Preset {
  id: string;
  name: string;
  description: string;
  instruction: string;
  tools: ToolDef[];
  // 에이전트
  model: string; // '제공자:모델'. 비면 실행할 수 없다 (채팅창에서 고르면 여기에 적힌다)
  temperature: number | null; // null이면 모델의 기본값 (아래의 null도 같다)
  thinking: Thinking;
  max_output_tokens: number | null;
  context_budget: number; // 대화가 이 토큰 수를 넘으면 앞부분을 줄인다. 0이면 줄이지 않는다
  // 보조: 도구가 따로 정하지 않았을 때 쓰는 값. 대화 압축도 이 모델로 한다
  auxiliary_model: string; // 비면 에이전트 모델과 같다
  auxiliary_temperature: number | null;
  auxiliary_thinking: Thinking;
  auxiliary_max_output_tokens: number | null;
  auxiliary_max_input_tokens: number | null; // 도구에 넘기는 글이 이것을 넘으면 돌리지 않고 오류로 알린다
  /**
   * 그림을 만드는 모델 ('제공자:모델'. 비면 없음). 에이전트 모델과 따로 둔다: 그림을 만드는 모델은 보통 도구를 쓰지 못한다.
   * 정해 두면 에이전트가 `이미지 만들기`(generate_image) 도구를 받는다.
   */
  image_model: string;
  /** 제공자가 실행하는 도구 (기본 false). 그림은 여기가 아니라 위의 image_model로 만든다. */
  web_search: boolean;
  web_fetch: boolean;
  /**
   * 이 프리셋으로 새 작업을 만들 때의 모드. 비면 정하지 않은 것이다 (앱의 기본값 `auto`로 열린다).
   * 만들 때 한 번만 쓰인다. 그 뒤에는 채팅창에서 바꾼 모드가 남고, 작업의 프리셋을 바꿔도 모드는 그대로다.
   */
  start_mode: Mode | "";
}

export interface PresetSummary {
  id: string;
  name: string;
  description: string;
}

export interface Meta {
  /** 앱의 버전 번호 (`"0.4.0"` 꼴). 메인 화면의 로고 아래에 적는다. */
  version: string;
  /** 그 번호를 올린 날 (`"2026-11-17"` 꼴). 엔진이 모르면 빈 문자열이고, 그때는 번호만 보인다. */
  version_date: string;
  provider_kinds: ProviderKind[];
  modes: { id: Mode; label: string; description: string }[];
  agent_tools: { name: string; label: string }[];
  /** 요약 도구의 기본 꼴. 사용자가 지운 요약 도구를 `+ 도구`에서 다시 넣을 때 이것을 채워 넣는다. */
  summary_tool: ToolDef;
}

export interface SessionSummary {
  id: string;
  name: string;
  created_at: string | null;
  /** 문서나 원고의 순서가 마지막으로 바뀐 때. 바뀐 적이 없으면 만든 때다. */
  updated_at: string | null;
  running: boolean;
  preset_id: string;
  /** 원고의 글자 수. */
  chars: number;
  /** 자료의 수 (글, 이미지, 파일을 다 센다. 폴더는 세지 않는다). */
  materials: number;
}

export interface SessionState {
  preset_id: string;
  mode: Mode;
  bypass_locks: boolean;
  /** 대화가 컨텍스트 한도를 넘으면 알아서 줄인다. 채팅창의 원그래프에서 켜고 끈다. */
  auto_compact: boolean;
  /** 지금 보고 있는 대화의 id. 화면에서 대화를 고르면 적어 둔다 (새로 고쳐도 그 대화가 열린다). */
  conversation?: string;
  /** 읽기 전용. 프리셋에 적힌 에이전트 모델 (쓸 수 없는 것이어도 그대로). 모델은 프리셋에서 고친다. */
  model: string;
  /** 읽기 전용. 실제로 쓰일 모델. 비었으면 골라야 한다 (프리셋의 모델이 비었거나 그 제공자가 없다). */
  effective_model: string;
  /** 지금 모델에서 되는 제공자 도구. 안 되는 것은 프리셋에서 켜 두어도 조용히 빠진다. */
  available?: { web_search?: boolean; web_fetch?: boolean };
}

/** 파일(`.aleph`, `.alephpreset`)을 가져온 결과. 서버가 파일 안을 보고 작업인지 프리셋인지 가린다. */
export type Imported = { kind: "work"; id: string; name: string; preset_id: string } | { kind: "preset"; preset: Preset };

/**
 * 작업 안의 대화 하나. 문서와 원고, 입력과 출력, 프리셋은 작업의 것이고 대화들이 같이 쓴다.
 * 대화마다 따로 있는 것은 화면 기록과 에이전트의 기억, 컨텍스트의 크기다. 첫 대화의 id는 `main`이다.
 */
export interface Conversation {
  id: string;
  /** 비어 있으면 아직 한 번도 보내지 않은 대화다 (`새 대화`로 보인다). 첫 요청의 첫 줄이 이름이 된다. */
  name: string;
  created_at: string;
  updated_at: string; // 마지막으로 기록이 붙은 때
  context_tokens: number;
  /** 지금 이 대화에서 실행 중인가. 한 작업에서는 한 번에 하나만 돈다. */
  running: boolean;
}

/** `지금 압축`의 결과. 줄일 대화가 없으면 compacted가 false이고 나머지 값은 없다. */
export interface Compacted {
  compacted: boolean;
  kind?: "cleared" | "summary";
  dropped_messages?: number;
  kept_messages?: number;
  tokens_before?: number;
  tokens_after?: number;
  summary?: string;
}

/** 가장 최근의 실행과, 그것을 되돌리면 무엇이 돌아가는지. */
export interface LastRun {
  run_id: string | null;
  /** 그 실행이 돈 대화. 되돌리기는 작업에서 마지막으로 돈 실행이 대상이라, 보고 있는 대화의 것이 아닐 수 있다. */
  conversation_id?: string;
  kind?: "agent" | "tool";
  goal?: string;
  status?: string;
  revertible: boolean;
  reason: string;
  /**
   * structure: 글은 그대로고 원고의 순서만 바뀌었다 (path는 `원고`).
   * title: 사람이 알아볼 이름 (장면은 자리 `1장 1번째 장면`, 그 실행이 지운 장면은 "지운 장면").
   */
  changes: { path: string; action: "write" | "delete" | "move" | "structure"; title?: string }[];
  /** 그 실행이 바꾼 문서 가운데, 그 뒤에 사용자가 직접 고친 것. */
  touched_later: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  zone: "manuscript" | "material";
  line: number; // 1부터
  start: number; // 그 줄에서의 글자 위치
  text: string; // 그 줄
}

/** 이 작업에서 쓴 토큰과 비용. 비용을 모르면 null. */
export interface Usage {
  runs: number;
  agent: { prompt_tokens: number; output_tokens: number; cost_usd: number | null };
  tools: { tool: string; label: string; calls: number; total_tokens: number; cost_usd: number | null }[];
  auxiliary: { calls: number; total_tokens: number; cost_usd: number | null };
  total_cost_usd: number | null;
  /** false면 단가를 모르는 모델의 호출이 빠져 있어 실제보다 적다. */
  cost_complete: boolean;
}

/** 찾아 바꾸기 확인의 문서 하나. */
export interface ReplaceItem {
  path: string;
  title: string;
  count: number;
  samples: { before: string; after: string }[];
}

/** 마지막으로 쓴 주체: user | agent | tool:<도구 이름> | preset | "" */
export type By = string;

export interface Material {
  path: string;
  kind: "text" | "image" | "file";
  chars: number;
  size: number;
  locked: boolean;
  note: boolean;
  updated_at: string | null;
  by: By;
}

export type SummaryState = "ok" | "stale" | "manual" | "none";

export interface Scene {
  id: string;
  path: string;
  number: number;
  summary: string;
  summary_state: SummaryState;
  /** 본문의 첫 줄(80자까지). 요약이 아직 없을 때 목록에서 대신 보인다. */
  head: string;
  chars: number;
  locked: boolean;
  updated_at: string | null;
  by: By;
}

export interface Chapter {
  id: string;
  number: number;
  summary: string;
  locked: boolean;
  scenes: Scene[];
}

export interface Flags {
  locked?: boolean;
  note?: boolean;
}

export interface Workspace {
  state: SessionState;
  input: { chars: number; updated_at: string | null; by: By };
  output: { chars: number; updated_at: string | null; by: By; tool: string };
  materials: Material[];
  /** 자료의 폴더 전부 (안쪽 폴더까지). 문서가 든 폴더는 materials의 경로에서도 알 수 있지만, 빈 폴더는 여기에만 나온다. */
  folders?: string[];
  /** 직접 건 설정만. 없는 키는 "상속". */
  flags: Record<string, Flags>;
  manuscript: { chars: number; locked: boolean; chapters: Chapter[] };
  /** 컨텍스트의 크기는 대화마다 다르다. conversation_id는 이 값이 어느 대화의 것인지. */
  context: { conversation_id?: string; tokens: number; budget: number };
}

export interface DocContent {
  path: string;
  content: string;
  kind: "text" | "image" | "file";
  locked: boolean;
  note: boolean;
}

export interface HistoryEntry {
  seq: number;
  timestamp: string;
  action: "write" | "delete" | "move";
  path: string;
  to: string | null;
  by: By;
  hash: string;
  prev_hash: string | null;
  chars: number;
  origin?: Record<string, unknown>;
  tool_run?: { tool: string; label: string; model: string; duration_ms: number; run_seq: number };
  proposal?: { id: string; status: "pending" | "accepted" | "rejected"; note: string };
}

export interface ToolRun {
  seq: number;
  timestamp: string;
  tool: string;
  label: string;
  by: "agent" | "user";
  model: string;
  duration_ms: number;
  input: string; // @include가 풀린 뒤
  input_raw: string; // 입력에 적혀 있던 그대로
  output: string;
  error: string | null;
  /** 시험 실행(출력을 건드리지 않은 것)이면 true. */
  trial?: boolean;
  /** 다시 쓴 입력의 원래 실행 번호. 없으면 null. */
  base_seq?: number | null;
  /** 묶음 요약이 돌린 것이면 그 장면이나 장의 경로(`원고/s3`, `원고/c1`), 아니면 null. */
  target?: string | null;
  /** 이 실행을 낸 도구 호출. 묶음 요약은 장면마다 한 줄씩 남기므로 같은 값끼리 한 묶음이다. */
  tool_call_id?: string;
}

/** 지워진 채로 있는 글 문서나 장면. hash를 복원에 넘긴다. */
export interface DeletedItem {
  path: string;
  kind: "scene" | "doc";
  deleted_at: string;
  by: By;
  hash: string;
  chars: number;
  head: string; // 글의 첫 줄. 지운 장면이 무엇인지는 이것으로 알아본다
}

export interface ResolvedRef {
  kind: "doc" | "folder" | "scene" | "chapter" | "manuscript" | "missing";
  path: string;
  title: string;
}

export interface UploadResult {
  path: string;
  kind: "text" | "image" | "file";
  chars: number;
  note: string;
}

/** 사용자가 올린 폰트 파일 하나 (API.md 9.8의 FontFace. 브라우저의 FontFace와 이름이 겹쳐서 달리 부른다). */
export interface FontFile {
  id: string;
  /** 폰트 이름. 같은 이름의 파일들이 한 폰트다. */
  family: string;
  style: string; // 파일 안에 적힌 모양 이름 ("Regular", "Bold" …)
  weight: [number, number]; // 굵기의 범위. 가변 폰트는 [100, 900]
  italic: boolean;
  format: "truetype" | "opentype" | "woff" | "woff2";
  size: number;
  file: string;
  url: string;
}

export interface RunStatus {
  running: boolean;
  run_id: string | null;
  /** 그 실행이 도는(돌았던) 대화. 실행은 작업에 하나뿐이다. */
  conversation_id?: string;
  status?: string;
  waiting_for_user?: boolean;
}

export type ProposalAction = "write" | "delete" | "move" | "insert" | "split" | "merge" | "reorder" | "replace";

/** 서버가 내보내는 실행 이벤트. */
export interface RunEvent {
  type:
    | "run_started"
    | "user_message"
    | "text_delta"
    | "text"
    | "thinking_delta"
    | "thinking"
    | "tool_call"
    | "tool_stream"
    | "tool_result"
    | "user_input_required"
    | "user_input_resolved"
    | "compaction"
    | "notice"
    | "error"
    | "done"
    | "reverted"; // 실행 하나를 되돌렸다 (target_run_id)
  seq?: number;
  run_id?: string;
  /** 이 이벤트가 붙는 대화. 스트림은 작업에 하나라서, 보고 있는 대화의 것이 아닐 수 있다. */
  conversation_id?: string;
  timestamp?: string;
  // 아래는 종류에 따라 있는 값들
  id?: string;
  text?: string;
  delta?: string;
  /** run_started: agent | tool, user_input_required: question | proposal | tool_confirm, compaction: cleared | summary */
  kind?: "agent" | "tool" | "question" | "proposal" | "tool_confirm" | "cleared" | "summary";
  mode?: Mode;
  agent_model?: string;
  preset_name?: string;
  bypass_locks?: boolean;
  in_reply_to?: string;
  tool?: string;
  label?: string;
  tool_call_id?: string;
  args?: Record<string, unknown>;
  /** 이 실행에서 몇 번째 도구 호출인지. 한도는 없다. */
  tool_call_index?: number;
  user_tool?: boolean;
  result?: string;
  ok?: boolean;
  changed?: string[];
  /** tool_result(읽기 에이전트): 본 것이 차례로 (`["읽기: 원고/s3", "찾기: 서윤"]`). 도는 동안의 tool_stream과 달리 기록에 남는다. */
  trail?: string[];
  /** tool_result: 사용자가 확인에서 반려해 하지 않은 호출이면 true. 아니면 키가 없다. */
  rejected?: boolean;
  /** user_message: 실행 중에 끼워 넣은 말이면 true. */
  steer?: boolean;
  /** run_started·tool_call·tool_result: 시험 실행(출력을 건드리지 않음)이면 true. */
  trial?: boolean;
  /** tool_call·tool_result: 제공자가 실행하는 도구(웹 검색, 웹 페이지 읽기)면 true. */
  native?: boolean;
  /** reverted: 되돌린 실행, 되돌린 경로들, 사용자가 고쳐서 그대로 둔 경로들. */
  target_run_id?: string;
  reverted?: string[];
  kept?: string[];
  /** 찾아 바꾸기 확인(action: replace). */
  query?: string;
  replacement?: string;
  items?: ReplaceItem[];
  event_id?: string;
  question?: string;
  options?: string[];
  // 문서 변경 확인
  action?: ProposalAction;
  path?: string;
  dest?: string | null;
  old?: string | null;
  new?: string | null;
  description?: string;
  by?: By;
  position?: ProposalPosition;
  pieces?: ProposalPiece[];
  scenes?: string[];
  // 도구 실행 확인
  input?: string;
  tool_label?: string;
  direct?: boolean;
  /**
   * compaction. cleared: 오래된 도구 결과를 비웠다(cleared_results개). summary: 앞부분을 요약으로 바꿨다(dropped_messages개).
   * manual이면 사용자가 `지금 압축`으로 돌린 것이다 (seq와 run_id가 없다).
   */
  cleared_results?: number;
  dropped_messages?: number;
  kept_messages?: number;
  tokens_before?: number;
  tokens_after?: number;
  manual?: boolean;
  summary?: string;
  level?: string;
  error?: string;
  /**
   * stalled: 에이전트가 헛돌아서(같은 호출을 되풀이) 엔진이 멈췄다.
   * interrupted: 실행 도중에 서버가 꺼졌다. 엔진이 다음에 켜질 때 기록 끝에 붙인다 (seq와 usage가 없다).
   */
  status?: "completed" | "stopped" | "stalled" | "interrupted" | "error";
  total_tool_calls?: number;
  elapsed_sec?: number;
  usage?: {
    agent_model?: string;
    prompt_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cost_usd?: number;
    context_tokens?: number;
  };
}

/** 장면이 놓일 자리. chapter는 장 id(없으면 마지막 장), after는 그 장면 뒤(null이면 장의 맨 앞), end면 장의 끝. */
export interface ProposalPosition {
  chapter: string | null;
  after: string | null;
  end?: boolean;
  new_chapter?: boolean;
}
/** 나누기의 조각 하나. head는 조각의 첫 줄. */
export interface ProposalPiece {
  chars: number;
  head: string;
  new_chapter?: boolean;
}

export interface Proposal {
  action: ProposalAction;
  path: string;
  dest: string | null;
  old: string | null;
  next: string | null;
  description: string;
  by: By;
  position?: ProposalPosition;
  pieces?: ProposalPiece[];
  scenes?: string[];
  // 찾아 바꾸기
  query?: string;
  replacement?: string;
  items?: ReplaceItem[];
}

/**
 * 모든 대화 항목에 붙는 것. 요청 단위로 되돌리려면 항목이 어느 실행의 것인지 알아야 한다.
 * run은 그 항목을 만든 이벤트의 run_id, reverted는 그 실행을 되돌렸다는 표시(흐리게 그린다).
 */
interface ItemOrigin {
  run?: string;
  reverted?: boolean;
}

/** 화면에 그리는 대화 항목. 이벤트 여러 개가 항목 하나로 합쳐진다. */
export type Item = ItemOrigin &
  (
  // trial: 시험 실행 (되돌리기의 대상이 아니다)
  | { kind: "run"; key: string; runKind: "agent" | "tool"; trial?: boolean; mode?: Mode; model?: string; preset?: string; bypass?: boolean; at?: string }
  // steer: 실행 중에 끼워 넣은 말
  | { kind: "user"; key: string; text: string; tool?: string; toolLabel?: string; reply: boolean; steer?: boolean }
  | { kind: "text"; key: string; text: string; streaming: boolean }
  | { kind: "thinking"; key: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
      tool: string;
      label: string;
      userTool: boolean;
      args: Record<string, unknown>;
      index?: number;
      result?: string;
      ok?: boolean;
      changed?: string[];
      trail?: string[]; // 읽기 에이전트가 본 것
      rejected?: boolean; // 사용자가 확인에서 반려해 하지 않았다
      native?: boolean; // 제공자가 실행하는 도구 (웹 검색, 웹 페이지 읽기)
      trial?: boolean; // 시험 실행: 출력을 건드리지 않았다
      stream?: string; // 도구 안에서 모델이 쓰고 있는 글
      startedAt?: string;
      endedAt?: string;
    }
  | {
      kind: "ask";
      key: string;
      eventId: string;
      askKind: "question" | "proposal" | "tool_confirm";
      question: string;
      options: string[];
      answered: boolean;
      reply?: string; // 내가 한 답
      proposal?: Proposal;
      tool?: string;
      label?: string;
      input?: string;
    }
  | { kind: "note"; key: string; tone: "info" | "warn" | "error"; text: string; detail?: string }
  | { kind: "done"; key: string; event: RunEvent }
  );
