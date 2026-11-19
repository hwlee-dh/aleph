import { create } from "zustand";
import { api, ApiError } from "./lib/api";
import { isStatic } from "./lib/snapshot";
import { attention } from "./lib/attention";
import { applyEvent, buildItems } from "./lib/events";
import { barePath, findScene, parseCommand, pathLabel, withQuote } from "./lib/labels";
import type {
  Conversation,
  Imported,
  Item,
  Meta,
  Preset,
  PresetSummary,
  Provider,
  RunEvent,
  RunStatus,
  SessionState,
  SessionSummary,
  ToolDef,
  UploadResult,
  Workspace,
} from "./lib/types";

/** 메인 화면(작업 카드들)인가, 작업 하나를 연 화면인가. */
export type View = "home" | "work";
/** 작업 화면의 가운데에 놓이는 것. 이 둘뿐이고, 나머지는 옆 패널과 팝업이다. */
export type Screen = "chat" | "manuscript";
export type LeftTab = "manuscript" | "materials";
export type RightTab = "chat" | "work" | "agent";

/** 오른쪽에서 밀려 나오는 넓은 패널에 띄울 것. */
export type Drawer =
  | { kind: "doc"; path: string } // 입력, 출력, 자료/…, 원고/s3
  | { kind: "runs"; seq?: number } // 도구 실행 기록 (이전 입력·출력)
  | { kind: "compare"; seq?: number } // 같은 입력으로 돌린 결과들을 나란히 (seq는 그 입력을 처음 쓴 실행)
  | { kind: "history"; path: string }; // 버전 기록

/** 문서 안의 한 자리. 찾기 결과를 눌렀을 때 그 문서를 열고 이 자리를 보인다. */
export interface Locate {
  path: string; // `.md` 뗀 경로
  line: number; // 1부터
  start: number; // 그 줄에서의 글자 위치
  length: number; // 칠할 길이
  tick: number;
}

export type DialogState =
  | { type: "new" }
  | { type: "settings"; provider?: string } // provider: 펼친 채로 열 제공자 (모델 고르기의 `키 넣기`)
  | { type: "tool"; name: string | null } // null이면 새 도구
  | { type: "presets" }
  | { type: "text"; field: "instruction" } // 지침을 크게 고치기
  | null;

/** 지워진 채로 있는 장면이나 자료 문서 (누가 지웠든). 버전 기록으로 가는 길을 남겨 둔다. */
export interface Deleted {
  path: string; // `.md` 뗀 경로
  label: string; // 메뉴에 보일 이름
  at: string;
}

export interface Quote {
  path: string;
  label: string;
  text: string;
}

type PanelKey = "left" | "right" | "drawer";
const WIDTH_LIMIT: Record<PanelKey, [number, number]> = { left: [220, 520], right: [280, 640], drawer: [360, 1100] };
const WIDTH_DEFAULT: Record<PanelKey, number> = { left: 300, right: 380, drawer: 560 };

interface State {
  ready: boolean;
  fatal: string | null;
  toast: { text: string; tone: "info" | "error" } | null;

  meta: Meta | null;
  providers: Provider[];
  presets: PresetSummary[];
  /** 지금 작업이 쓰는 프리셋. 고치면 바로 저장된다. */
  preset: Preset | null;

  /**
   * 지금 보이는 화면. 앱을 켜면 메인 화면이고, 작업 화면에서 새로 고치면 그 작업이 그대로 열린다.
   * 메인 화면으로 돌아와도 보던 작업은 골라진 채로 둔다 (sessionId): 같은 카드를 누르면 다시 읽지 않고 바로 돌아간다.
   */
  view: View;
  sessions: SessionSummary[];
  sessionId: string | null;
  ws: Workspace | null;
  /** 문서가 바뀐 횟수(경로별, `.md` 뗀 경로). 열려 있는 편집기가 이 값을 보고 다시 읽는다. */
  rev: Record<string, number>;
  /** 그 변경을 낸 편집기의 id. 자기가 저장한 것은 다시 읽지 않는다. */
  revBy: Record<string, string>;

  /** 이 작업의 대화들 (만든 순서). 문서와 프리셋은 작업의 것이고, 대화마다 따로 있는 것은 기록과 에이전트의 기억이다. */
  conversations: Conversation[];
  /** 보고 있는 대화. 작업을 읽기 전에는 빈 문자열이다. */
  conversationId: string;
  /** 보고 있는 대화의 기록. */
  items: Item[];
  /** 이 작업에서 실행 중인가 (어느 대화에서든. 한 번에 하나만 돈다). */
  running: boolean;
  /** 가장 최근의 실행이 돈(도는) 대화. 되돌리기와 "다른 대화에서 실행 중"을 가릴 때 본다. */
  runConversation: string | null;
  /** 지금 실행의 기록 (어느 대화의 것이든). 작업 패널의 도구 흐름과 확인 대기 표시는 이것을 본다. */
  live: Item[];
  starting: boolean;
  /** `지금 압축`이 도는 중이다. 엔진이 요약을 기다리는 동안에는 이 작업에서 실행을 시작할 수 없다 (보내면 409). */
  compacting: boolean;

  screen: Screen;
  leftTab: LeftTab;
  rightTab: RightTab;
  leftOpen: boolean;
  rightOpen: boolean;
  width: Record<PanelKey, number>;
  drawer: Drawer | null;
  /** 창이 좁아 넓은 패널이 가운데를 덮고 있다 (App이 정한다). */
  drawerOver: boolean;
  /** 창이 좁아 왼쪽 패널이 가운데 위에 겹쳐 떠 있다 (App이 정한다). */
  leftOver: boolean;
  dialog: DialogState;

  /** 채팅창에 쓰고 있는 글. 화면을 오가도 남는다. */
  draft: string;
  /** 값이 바뀌면 채팅창이 초점을 가져간다. */
  focusTick: number;
  /** 값이 바뀌면 채팅창의 모델 고르기가 열린다 (모델이 없어서 보내지 못했을 때). */
  modelTick: number;
  quote: Quote | null;
  /** 원고 화면이 이 장면으로 스크롤한다. */
  jump: { scene: string; tick: number } | null;
  /** 값이 바뀌면 그 문서를 보이는 편집기가 이 자리로 스크롤하고 그 글귀를 고른다. */
  locate: Locate | null;
  /** 지운 장면·문서 (지금 작업, 최신이 앞). */
  deleted: Deleted[];
  /** 원고를 내보낼 때 장마다 번호(`1장`)를 넣는가. 이 브라우저에 기억한다. */
  exportChapters: boolean;

  init: () => Promise<void>;
  notify: (text: string, tone?: "info" | "error") => void;
  fail: (e: unknown) => void;
  refreshProviders: () => Promise<void>;

  refreshPresets: () => Promise<void>;
  /** 저장을 기다리는 프리셋 변경을 지금 저장한다. */
  flushPreset: () => Promise<void>;
  /** 프리셋을 고친다. 잠깐 뒤에 저장된다. */
  editPreset: (patch: Partial<Preset>) => void;
  /**
   * 채팅창에서 모델·추론 수준을 바꾼다. 프리셋의 그 칸만 바로 고친다 (PATCH).
   * 에이전트 패널의 모델 칸과 같은 값이라 한쪽을 바꾸면 다른 쪽도 바로 바뀐다.
   */
  changeModel: (patch: Pick<Partial<Preset>, "model" | "thinking">) => Promise<void>;
  /** 도구를 고치거나(original이 그 도구의 name) 새로 더한다(original이 null). */
  saveTool: (original: string | null, tool: ToolDef) => void;
  removeTool: (name: string) => void;
  /**
   * 도구의 영문 이름(모델이 부르는 함수 이름)을 바꾼다. 바로 저장하고, 엔진이 거절하면 그 이유를 돌려준다 (되면 null).
   * 거절되면 화면의 프리셋은 그대로다. 그 도구의 창이 열려 있으면 새 이름을 따라간다.
   */
  renameTool: (from: string, to: string) => Promise<string | null>;
  /** 이 작업의 프리셋을 바꾼다. */
  choosePreset: (id: string) => Promise<void>;
  /** 빈 프리셋을 만들어 이 작업의 프리셋으로 삼는다. */
  createPreset: () => Promise<void>;
  /** id 없이 부르면 지금 프리셋을 다른 이름으로 저장하고 그리로 바꾼다. id를 주면 그 프리셋의 사본만 만든다(복제). */
  duplicatePreset: (name?: string, id?: string) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  /**
   * 내보낸 파일(`.aleph`, `.alephpreset`)을 들여온다. 작업이면 그 작업으로 옮겨 가고, 프리셋이면 목록에 더한다.
   * 어느 자리에서 넣었든 파일 안의 종류대로 들어온다. 무엇이 들어왔는지 돌려준다 (실패하면 null).
   */
  importFile: (file: File) => Promise<Imported | null>;

  refreshSessions: () => Promise<void>;
  /** 메인 화면으로 간다. 분량과 고친 때가 바뀌었을 수 있으니 작업 목록을 다시 받는다. */
  goHome: () => void;
  /** 작업 화면으로 간다. 이미 골라져 있던 작업이면 다시 읽지 않는다. */
  openWork: (id: string) => Promise<void>;
  /** 작업을 골라 읽는다. 고르면 작업 화면이 되고, null이면(남은 작업이 없다) 메인 화면이 된다. */
  selectSession: (id: string | null) => Promise<void>;
  createSession: (name: string, presetId?: string) => Promise<string | null>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  refreshWorkspace: () => Promise<void>;
  /** 모드, 권한 무시, 자동 압축. (모델과 추론 수준은 작업의 상태가 아니라 프리셋에 있다) */
  setSessionState: (patch: Partial<SessionState>) => Promise<void>;
  /** 지금 작업에 대고 API를 부른다. 실패하면 알리고 undefined, 성공하면 작업 공간을 다시 읽는다. */
  act: <T>(fn: (sessionId: string) => Promise<T>) => Promise<T | undefined>;
  /** 문서가 바뀌었다고 알린다. origin은 그 변경을 낸 편집기의 id. */
  touch: (paths: string[], origin?: string) => void;
  /** 파일을 자료에 올린다. folder는 `자료` 아래 폴더(안 주면 서버가 정한다). 결과는 한 번에 알린다. */
  uploadFiles: (files: File[], folder?: string) => Promise<UploadResult[]>;

  setScreen: (screen: Screen) => void;
  setExportChapters: (on: boolean) => void;
  setLeftTab: (tab: LeftTab) => void;
  setRightTab: (tab: RightTab) => void;
  togglePanel: (side: "left" | "right") => void;
  setWidth: (key: PanelKey, px: number) => void;
  openDrawer: (drawer: Drawer) => void;
  closeDrawer: () => void;
  /** 문서를 연다. 원고 화면에서 장면이면 그 자리로 가고, 그 밖에는 넓은 패널에 띄운다. */
  openDoc: (path: string) => void;
  jumpToScene: (scene: string) => void;
  /** 문서를 열고(openDoc과 같은 규칙) 그 안의 한 자리를 보인다. */
  openAt: (path: string, line: number, start: number, length: number) => void;
  openDialog: (dialog: DialogState) => void;
  closeDialog: () => void;

  setDraft: (text: string) => void;
  focusComposer: () => void;
  /** 채팅창에 `/도구이름 `을 넣는다. */
  insertCommand: (label: string) => void;
  setQuote: (quote: Quote | null) => void;

  send: () => Promise<boolean>;
  stop: () => Promise<void>;
  answer: (eventId: string, text: string) => Promise<void>;
  /** 실행 중인 에이전트에게 말을 끼워 넣는다 (중단하지 않는다). 붙여 둔 인용도 같이 간다. */
  steer: (text: string) => Promise<boolean>;
  /** 화면 밖에서(시험 실행 등) 이미 시작한 실행의 흐름에 붙는다. */
  attachRun: () => void;
  /**
   * 실행 하나가 바꾼 것을 되돌린다. 그 뒤에 내가 고친 문서가 있으면 서버가 거절하고(409) false가 온다 —
   * 그때는 알리지 않으니, 부른 쪽이 `api.lastRun`을 다시 받아 그 문서들을 보이고 force로 다시 부른다.
   */
  revertRun: (runId: string, force?: boolean) => Promise<boolean>;
  refreshConversations: () => Promise<void>;
  /** 다른 대화를 연다. 서버에도 알려 둔다 (새로 고쳐도 그 대화가 열린다). */
  selectConversation: (cid: string) => Promise<void>;
  /** 새 대화를 만들어 그리로 간다. 앞의 대화는 목록에 남는다. 보고 있는 대화가 아직 빈 대화면 새로 만들지 않는다. */
  newConversation: () => Promise<void>;
  renameConversation: (cid: string, name: string) => Promise<void>;
  /** 대화를 지운다 (기록과 에이전트의 기억. 문서와 원고는 그대로). 보던 대화를 지웠으면 남은 대화로 간다. */
  deleteConversation: (cid: string) => Promise<void>;
  /** 지금 압축: 대화의 앞부분을 요약으로 바꾼다. 줄였으면 true. */
  compactNow: () => Promise<boolean>;
  /** 대화를 서버에서 다시 받아 짠다. 되돌리기와 `지금 압축`의 표시는 실시간 흐름이 아니라 기록 끝에만 붙는다. */
  reloadConversation: () => Promise<void>;
}

/*
 * 선택 함수가 매번 새 배열을 돌려주면 zustand가 "값이 바뀌었다"고 보고 끝없이 다시 그린다.
 * 빈 목록은 늘 같은 것을 돌려준다.
 */
const NO_TOOLS: ToolDef[] = [];
const NO_ITEMS: Item[] = [];
export const selectTools = (s: State) => s.preset?.tools ?? NO_TOOLS;
/**
 * 보고 있는 대화에서 실행 중인가. `running`은 작업에서 무엇이든 도는 중이라는 뜻이라(한 번에 하나만 돈다),
 * 대화의 기록을 그리거나 그 실행에 말을 거는 곳은 이것을 본다.
 */
export const selectRunningHere = (s: State) => s.running && s.runConversation === s.conversationId;

/** 내보낸 작업(`.aleph`)이나 프리셋(`.alephpreset`) 파일인가. 파일 선택창의 accept에도 쓴다. */
export const ARCHIVE_ACCEPT = ".aleph,.alephpreset";
export const isArchiveFile = (file: File) => /\.(aleph|alephpreset)$/i.test(file.name);
/** 자료로 올릴 수 있는 파일. 파일 선택창의 accept에 쓴다. */
export const UPLOAD_ACCEPT = ".txt,.md,.docx,.hwpx,.pdf,.png,.jpg,.jpeg,.webp,.gif";

const LS = "aleph.ui";
function recall(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function remember(patch: Record<string, unknown>) {
  try {
    localStorage.setItem(LS, JSON.stringify({ ...recall(), ...patch }));
  } catch {
    /* 저장소를 못 쓰는 브라우저 */
  }
}

/*
 * 지금 화면(메인/작업)은 sessionStorage에 적는다. 탭이 살아 있는 동안만 남으므로
 * "앱을 켰다"(값이 없다 → 메인 화면)와 "작업 화면에서 새로 고쳤다"(work → 그 작업)가 갈린다.
 */
const VIEW_KEY = "aleph.view";
function recallView(): View {
  try {
    return sessionStorage.getItem(VIEW_KEY) === "work" ? "work" : "home";
  } catch {
    return "home";
  }
}
function rememberView(view: View) {
  try {
    sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    /* 저장소를 못 쓰는 브라우저 */
  }
}

/** 지운 것의 목록을 서버에서 받는다. 에이전트가 지운 것도 여기 나온다. */
async function fetchDeleted(sessionId: string): Promise<Deleted[]> {
  const items = await api.deleted(sessionId);
  return items.map((d) => {
    const head = d.head.length > 24 ? `${d.head.slice(0, 24)}…` : d.head;
    return {
      path: barePath(d.path),
      // 장면은 경로(원고/s3)가 뜻이 없으니 글의 첫 줄로 부른다.
      label: d.kind === "scene" ? head || "장면" : pathLabel(d.path, null),
      at: d.deleted_at,
    };
  });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | null = null;
let wsTimer: ReturnType<typeof setTimeout> | undefined;
let presetTimer: ReturnType<typeof setTimeout> | undefined;
let presetEdits = 0; // 저장이 돌아왔을 때 그 사이에 더 고쳤는지 본다
let presetDirty = false; // 아직 서버에 보내지 않은 변경이 있다
// 서버에 저장된 프리셋의 모델과 컨텍스트 한도. 이것이 바뀌면 작업 공간의 값(실제로 쓰일 모델, 원그래프의 한도)도 바뀐다
let presetSynced = { model: "", budget: 0 };
let statePending: Promise<unknown> = Promise.resolve();
let dialogBack: DialogState = null; // 설정을 닫으면 돌아갈 창
let seenRun = { id: "", seq: 0 }; // 흐름에서 이미 본 데까지 (실행 하나 안에서)

export const useStore = create<State>((set, get) => {
  const saved = recall();

  /** 잇달아 오는 변경을 모아 작업 공간을 한 번만 다시 읽는다. */
  const refreshSoon = (ms = 200) => {
    if (wsTimer) clearTimeout(wsTimer);
    wsTimer = setTimeout(() => void get().refreshWorkspace(), ms);
  };

  /*
   * 실행의 흐름에 붙는다. 스트림은 작업에 하나이고 이벤트마다 어느 대화의 것인지 적혀 온다.
   * 보고 있는 대화의 것이면 화면의 기록(items)에 붙이고, 어느 대화의 것이든 지금 실행의 기록(live)에는 붙인다.
   * 붙을 때마다 스트림이 그 실행의 이벤트를 처음부터 다시 보내 주므로 live는 비우고 시작한다.
   */
  const attach = (sessionId: string) => {
    unsubscribe?.();
    set({ live: NO_ITEMS });
    unsubscribe = api.subscribe(
      sessionId,
      (e) => {
        if (get().sessionId !== sessionId) return;
        const s = get();
        const cid = e.conversation_id ?? s.runConversation ?? s.conversationId;
        set({
          live: applyEvent(s.live, e),
          ...(cid === s.conversationId ? { items: applyEvent(s.items, e) } : {}),
          ...(cid !== s.runConversation ? { runConversation: cid } : {}),
        });
        // 대화를 오가면 흐름에 다시 붙고, 그때 이미 본 이벤트가 또 온다. 화면의 기록은 다시 짜야 하지만
        // 문서를 다시 읽거나 알리는 일은 한 번이면 된다.
        const seq = e.seq ?? 0;
        if (e.run_id && e.run_id === seenRun.id && seq <= seenRun.seq) return;
        if (e.run_id) seenRun = { id: e.run_id, seq };
        // 첫 요청을 보내면 서버가 그 첫 줄로 대화의 이름을 붙인다. 끝나면 컨텍스트의 크기와 고친 때가 바뀐다.
        if (e.type === "run_started" || e.type === "done") void get().refreshConversations();
        if (e.type === "tool_result") {
          // 원고가 바뀌면 `원고`와 함께 바뀐 장면 경로가 온다. 장면만 다시 읽으면 된다
          // (`원고`만 온 것은 순서만 바뀐 것이라 본문은 그대로다).
          const changed = (e.changed ?? []).filter((p) => barePath(p) !== "원고");
          if (changed.length) get().touch(changed);
          refreshSoon();
        }
        if (e.type === "user_input_resolved" || e.type === "done") refreshSoon();
        // 다른 탭을 보고 있으면 끝났거나 답을 기다린다고 알린다. 진행 중인 실행에 다시 붙으면 스트림이
        // 지난 이벤트부터 다시 보내 주는데, 그렇게 온 옛 질문으로는 알리지 않는다.
        const fresh = !e.timestamp || Date.now() - new Date(e.timestamp).getTime() < 15000;
        if (fresh && e.type === "done") attention("done");
        else if (fresh && e.type === "user_input_required") attention(e.kind === "question" ? "question" : "confirm");
      },
      () => {
        if (get().sessionId !== sessionId) return;
        unsubscribe = null;
        set({ running: false });
        void get().refreshWorkspace();
        void get().refreshSessions();
        void get().refreshConversations();
      },
    );
  };

  /**
   * 대화 하나의 기록을 화면에 올린다. 그 대화에서 실행 중이면 진행 중인 실행의 이벤트는 스트림이
   * 처음부터 다시 보내 주므로 저장된 기록에서는 뺀다. 다른 대화에서 실행 중이면 기록은 그대로 올리고 흐름에만 붙는다.
   */
  const show = (sessionId: string, cid: string, events: RunEvent[], run: RunStatus) => {
    const ran = run.conversation_id ?? (run.run_id ? cid : null);
    const here = run.running && ran === cid;
    set({ items: buildItems(here ? events.filter((e) => e.run_id !== run.run_id) : events), running: run.running, runConversation: ran });
    if (run.running) attach(sessionId);
    else set({ live: NO_ITEMS });
  };

  /** 대화를 열어 그 기록과 컨텍스트의 크기를 읽는다. */
  const openConversation = async (cid: string) => {
    const id = get().sessionId;
    if (!id) return;
    set({ conversationId: cid, items: NO_ITEMS });
    try {
      const [{ events, run }, ws] = await Promise.all([api.events(id, cid), api.workspace(id, cid)]);
      if (get().sessionId !== id || get().conversationId !== cid) return;
      unsubscribe?.();
      unsubscribe = null;
      set({ ws });
      show(id, cid, events, run);
    } catch (e) {
      get().fail(e);
    }
  };

  /** 프리셋을 저장한 뒤에 부른다. 모델이나 컨텍스트 한도가 바뀌었으면 작업 공간을 다시 읽는다. */
  const syncPreset = (stored: Preset) => {
    if (stored.model === presetSynced.model && stored.context_budget === presetSynced.budget) return;
    presetSynced = { model: stored.model, budget: stored.context_budget };
    void get().refreshWorkspace();
  };

  const flushPreset = async () => {
    if (presetTimer) clearTimeout(presetTimer);
    presetTimer = undefined;
    const preset = get().preset;
    // 고친 것이 없으면 보내지 않는다. 보내기·작업 바꾸기 때마다 그냥 저장하면 방금 지운 프리셋이 되살아난다.
    if (!preset || !presetDirty) return;
    presetDirty = false;
    const at = presetEdits;
    try {
      const stored = await api.savePreset(preset);
      // 저장하는 사이에 더 고쳤으면 화면의 값을 그대로 둔다 (곧 다시 저장된다).
      if (at === presetEdits && get().preset?.id === stored.id) set({ preset: stored });
      syncPreset(stored);
      const listed = get().presets.find((p) => p.id === stored.id);
      if (!listed || listed.name !== stored.name) void get().refreshPresets();
    } catch (e) {
      get().fail(e);
    }
  };

  // 지침을 고치고 곧바로 창을 닫거나 새로 고쳐도 남게, 저장을 기다리던 것을 떠나는 길에 보낸다.
  if (typeof window !== "undefined")
    window.addEventListener("pagehide", () => {
      if (presetTimer) void flushPreset();
    });

  const refreshDeleted = async () => {
    const id = get().sessionId;
    if (!id) return;
    try {
      const deleted = await fetchDeleted(id);
      if (get().sessionId === id) set({ deleted });
    } catch {
      /* 목록을 못 받아도 다른 일에는 지장이 없다 */
    }
  };

  const loadPreset = async (id: string) => {
    // 쓰던 프리셋이 지워지고 남은 것이 없는 작업은 프리셋 id가 비어 있다.
    if (!id) {
      presetDirty = false;
      set({ preset: null });
      return;
    }
    try {
      const preset = await api.preset(id);
      presetSynced = { model: preset.model, budget: preset.context_budget };
      presetDirty = false;
      set({ preset });
    } catch (e) {
      get().fail(e);
    }
  };

  return {
    ready: false,
    fatal: null,
    toast: null,
    meta: null,
    providers: [],
    presets: [],
    preset: null,
    view: recallView(),
    sessions: [],
    sessionId: null,
    ws: null,
    rev: {},
    revBy: {},
    conversations: [],
    conversationId: "",
    items: NO_ITEMS,
    running: false,
    runConversation: null,
    live: NO_ITEMS,
    starting: false,
    compacting: false,
    screen: saved.screen === "manuscript" ? "manuscript" : "chat",
    leftTab: saved.leftTab === "materials" ? "materials" : "manuscript",
    rightTab: saved.rightTab === "agent" ? "agent" : saved.rightTab === "chat" && saved.screen === "manuscript" ? "chat" : "work",
    exportChapters: saved.exportChapters !== false,
    leftOpen: saved.leftOpen !== false,
    rightOpen: saved.rightOpen !== false,
    width: { ...WIDTH_DEFAULT, ...(saved.width ?? {}) },
    drawer: null,
    drawerOver: false,
    leftOver: false,
    dialog: null,
    draft: "",
    focusTick: 0,
    modelTick: 0,
    quote: null,
    jump: null,
    locate: null,
    deleted: [],

    init: async () => {
      try {
        const [meta, providers, sessions, presets] = await Promise.all([
          api.meta(),
          api.providers(),
          api.sessions(),
          api.presets(),
        ]);
        // 주소에 `?work=<작업 id>`가 있으면 그 작업을 바로 연다 (시연 서버가 그렇게 연다).
        // 작업 화면에서 새로 고친 것이면 보던 작업을 그대로 연다. 그 작업이 그사이 없어졌으면 메인 화면이다.
        // 앱을 켠 것이면 메인 화면이고, 아무 작업도 읽지 않는다 (실행 중인 작업의 흐름을 붙들 까닭이 없다).
        const asked = new URLSearchParams(window.location.search).get("work");
        // 정적 사이트로 뽑은 시연에는 작업이 하나뿐이다. 그 작업을 연다.
        const wanted = asked ?? (isStatic ? sessions[0]?.id : get().view === "work" ? saved.session : null);
        const resume = sessions.find((s) => s.id === wanted)?.id ?? null;
        // 한 번 열고 나면 주소에서 뗀다. 메인 화면으로 나갔다가 새로 고쳤을 때 다시 그 작업으로 끌려가지 않게.
        if (asked) window.history.replaceState(null, "", window.location.pathname);
        if (!resume) rememberView("home");
        set({ meta, providers, sessions, presets, ready: true, fatal: null, view: resume ? "work" : "home" });
        if (resume) await get().selectSession(resume);
        // 처음 켰는데 쓸 수 있는 제공자가 하나도 없으면 설정(제공자)부터 보여준다.
        if (!isStatic && !providers.some((p) => p.enabled && p.ready)) set({ dialog: { type: "settings" } });
      } catch (e) {
        set({ fatal: e instanceof ApiError ? e.message : String(e) });
      }
    },

    notify: (text, tone = "info") => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: { text, tone } });
      toastTimer = setTimeout(() => set({ toast: null }), tone === "error" ? 7000 : 3000);
    },

    fail: (e) => get().notify(e instanceof Error ? e.message : String(e), "error"),

    refreshProviders: async () => {
      set({ providers: await api.providers() });
      // 제공자를 켜거나 키를 넣으면 프리셋에 적힌 모델을 쓸 수 있게 되기도 한다.
      void get().refreshWorkspace();
    },

    flushPreset: () => flushPreset(),

    attachRun: () => {
      const id = get().sessionId;
      if (!id) return;
      // 화면 밖에서 시작한 실행은 보고 있는 대화에 붙는다 (대화를 안 적어 보내면 서버가 그렇게 한다).
      set({ running: true, runConversation: get().conversationId });
      attach(id);
      void get().refreshSessions();
    },

    refreshPresets: async () => {
      try {
        set({ presets: await api.presets() });
      } catch (e) {
        get().fail(e);
      }
    },

    editPreset: (patch) => {
      const preset = get().preset;
      if (!preset) return;
      presetEdits++;
      presetDirty = true;
      set({ preset: { ...preset, ...patch } });
      if (presetTimer) clearTimeout(presetTimer);
      presetTimer = setTimeout(() => void flushPreset(), 600);
    },

    changeModel: async (patch) => {
      const preset = get().preset;
      if (!preset) return;
      // 화면에는 바로 보인다. 패널이 저장을 기다리는 변경(presetDirty)은 건드리지 않는다:
      // 그 저장은 프리셋을 통째로 보내므로 여기서 바꾼 값도 같이 간다.
      set({ preset: { ...preset, ...patch } });
      try {
        const stored = await api.patchPreset(preset.id, patch);
        const now = get().preset;
        if (now?.id !== stored.id) return;
        syncPreset(stored);
      } catch (e) {
        get().fail(e);
        // 서버가 거절했으면 서버에 있는 값으로 돌아간다. 기다리던 변경은 화면의 것을 지킨다.
        try {
          const stored = await api.preset(preset.id);
          const now = get().preset;
          if (now?.id === stored.id) set({ preset: { ...now, model: stored.model, thinking: stored.thinking } });
        } catch {
          /* 다음에 프리셋을 읽을 때 맞춰진다 */
        }
      }
    },

    saveTool: (original, tool) => {
      const tools = get().preset?.tools ?? [];
      const exists = original !== null && tools.some((t) => t.name === original);
      get().editPreset({ tools: exists ? tools.map((t) => (t.name === original ? tool : t)) : [...tools, tool] });
    },

    removeTool: (name) => get().editPreset({ tools: (get().preset?.tools ?? []).filter((t) => t.name !== name) }),

    renameTool: async (from, to) => {
      // 기다리던 변경을 먼저 보낸다. 이름은 고치는 족족 저장하지 않고 여기서 한 번에 저장한다:
      // 거절될 수 있는 값이라, 화면의 프리셋에 먼저 넣어 두면 그 뒤의 저장이 전부 거절된다.
      await flushPreset();
      const preset = get().preset;
      if (!preset || !preset.tools.some((t) => t.name === from)) return "도구를 찾을 수 없습니다";
      try {
        const stored = await api.savePreset({ ...preset, tools: preset.tools.map((t) => (t.name === from ? { ...t, name: to } : t)) });
        if (get().preset?.id !== stored.id) return null;
        const dialog = get().dialog;
        // 프리셋과 열려 있는 창의 이름을 한 번에 바꾼다 (따로 바꾸면 창이 "도구가 사라졌다"고 보고 닫힌다).
        set({ preset: stored, ...(dialog?.type === "tool" && dialog.name === from ? { dialog: { type: "tool", name: to } } : {}) });
        syncPreset(stored);
        return null;
      } catch (e) {
        // 엔진의 검사 오류는 `tools.3.name: Value error, …`처럼 칸의 자리가 앞에 붙어 온다. 이유만 남긴다.
        return (e instanceof Error ? e.message : String(e)).replace(/^[\w.]+: (Value error, )?/, "");
      }
    },

    choosePreset: async (id) => {
      await flushPreset();
      await get().setSessionState({ preset_id: id });
      await loadPreset(id);
    },

    createPreset: async () => {
      try {
        await flushPreset();
        const made = await api.createPreset();
        await get().refreshPresets();
        await get().choosePreset(made.id);
      } catch (e) {
        get().fail(e);
      }
    },

    duplicatePreset: async (name, id) => {
      const source = id ?? get().preset?.id;
      if (!source) return;
      try {
        await flushPreset();
        const copy = await api.duplicatePreset(source, name);
        await get().refreshPresets();
        // `다른 이름으로 저장`(id 없이 부름)은 새 이름으로 옮겨 간다.
        // 목록의 `복제`는 사본만 만든다. 쓰던 프리셋을 복제했다고 작업이 사본으로 옮겨 가면 뜻밖이다.
        if (!id) await get().choosePreset(copy.id);
        get().notify(id ? `프리셋 '${copy.name}' 복제됨` : `프리셋 '${copy.name}' 저장됨`);
      } catch (e) {
        get().fail(e);
      }
    },

    deletePreset: async (id) => {
      try {
        // 지울 것에 남아 있던 변경은 버린다 (저장하면 지운 뒤에 되살아난다).
        if (id === get().preset?.id) {
          if (presetTimer) clearTimeout(presetTimer);
          presetTimer = undefined;
          presetDirty = false;
        }
        await api.deletePreset(id);
        await get().refreshPresets();
        if (id === get().preset?.id) {
          // 쓰던 프리셋을 지웠으면 남은 것 가운데 첫째로 넘어간다. 남은 것이 없으면 이 작업은 프리셋 없이 남는다.
          if (get().presets[0]) await get().choosePreset(get().presets[0].id);
          else {
            set({ preset: null });
            void get().refreshWorkspace();
          }
        }
        get().notify("프리셋 삭제됨");
      } catch (e) {
        get().fail(e);
      }
    },

    importFile: async (file) => {
      try {
        const got = await api.importFile(file);
        if (got.kind === "preset") {
          await get().refreshPresets();
          get().notify(`프리셋 '${got.preset.name}' 가져옴`);
        } else {
          // 그 작업이 쓰던 프리셋이 같이 들어왔을 수 있다.
          await Promise.all([get().refreshSessions(), get().refreshPresets()]);
          await get().selectSession(got.id);
          get().notify(`작업 '${got.name}' 가져옴`);
        }
        return got;
      } catch (e) {
        // ALEPH에서 내보낸 파일이 아닌 경우 등. 서버가 준 이유를 그대로 보인다.
        get().fail(e);
        return null;
      }
    },

    refreshSessions: async () => {
      try {
        set({ sessions: await api.sessions() });
      } catch {
        /* 목록 갱신 실패는 조용히 넘긴다 */
      }
    },

    goHome: () => {
      rememberView("home");
      set({ view: "home" });
      void get().refreshSessions();
    },

    openWork: async (id) => {
      // 골라져 있어도 읽다가 실패해 비어 있으면 다시 읽는다.
      if (get().sessionId !== id || !get().ws) return get().selectSession(id);
      rememberView("work");
      set({ view: "work" });
    },

    selectSession: async (id) => {
      unsubscribe?.();
      unsubscribe = null;
      await flushPreset();
      remember({ session: id });
      // 작업을 고르는 길(카드, 새 작업, 가져오기)은 전부 그 작업 화면으로 간다.
      const view: View = id ? "work" : "home";
      rememberView(view);
      set({
        view,
        sessionId: id,
        ws: null,
        conversations: [],
        conversationId: "",
        items: NO_ITEMS,
        running: false,
        runConversation: null,
        live: NO_ITEMS,
        drawer: null,
        quote: null,
        draft: "",
        jump: null,
        locate: null,
        rev: {},
        revBy: {},
        deleted: [],
      });
      if (!id) {
        set({ preset: null });
        return;
      }
      try {
        // 대화를 적지 않으면 서버가 마지막으로 보고 있던 대화를 준다. 셋 다 그 대화의 것이다.
        const [{ events, run, conversation_id }, ws, list] = await Promise.all([api.events(id), api.workspace(id), api.conversations(id)]);
        if (get().sessionId !== id) return;
        const cid = conversation_id ?? list.current ?? "main";
        set({ ws, conversations: list.conversations, conversationId: cid });
        void refreshDeleted();
        if (get().preset?.id !== ws.state.preset_id) await loadPreset(ws.state.preset_id);
        if (get().sessionId !== id) return;
        show(id, cid, events, run);
      } catch (e) {
        get().fail(e);
      }
    },

    createSession: async (name, presetId) => {
      try {
        const created = await api.createSession(name, presetId);
        await get().refreshSessions();
        await get().selectSession(created.id);
        return created.id;
      } catch (e) {
        get().fail(e);
        return null;
      }
    },

    renameSession: async (id, name) => {
      try {
        await api.renameSession(id, name);
        await get().refreshSessions();
      } catch (e) {
        get().fail(e);
      }
    },

    deleteSession: async (id) => {
      try {
        await api.deleteSession(id);
        await get().refreshSessions();
        // 열어 둔 작업을 지웠으면 메인 화면으로 간다.
        if (get().sessionId === id) await get().selectSession(null);
      } catch (e) {
        get().fail(e);
      }
    },

    refreshWorkspace: async () => {
      const id = get().sessionId;
      if (!id) return;
      const cid = get().conversationId;
      try {
        // 컨텍스트의 크기는 보고 있는 대화의 것을 받는다.
        const ws = await api.workspace(id, cid || undefined);
        if (get().sessionId !== id || get().conversationId !== cid) return;
        set({ ws });
        void refreshDeleted(); // 에이전트가 지운 것도 메뉴에 뜨게
        if (get().preset?.id !== ws.state.preset_id) await loadPreset(ws.state.preset_id);
        // 열어 둔 문서가 사라졌으면 넓은 패널을 닫는다.
        const drawer = get().drawer;
        if (drawer?.kind === "doc") {
          const p = barePath(drawer.path);
          const alive =
            p === "입력" || p === "출력" || (p.startsWith("원고/") ? findScene(ws, p) !== null : ws.materials.some((m) => barePath(m.path) === p));
          if (!alive) set({ drawer: null });
        }
      } catch {
        /* 다음 갱신 때 다시 시도된다 */
      }
    },

    setSessionState: async (patch) => {
      const id = get().sessionId;
      const ws = get().ws;
      if (!id || !ws) return;
      set({ ws: { ...ws, state: { ...ws.state, ...patch } } });
      const job = statePending
        .catch(() => undefined)
        .then(() => api.saveState(id, patch))
        .then((state) => {
          const now = get().ws;
          if (get().sessionId === id && now) set({ ws: { ...now, state } });
        })
        .catch((e) => {
          get().fail(e);
          void get().refreshWorkspace();
        });
      statePending = job;
      await job;
    },

    act: async (fn) => {
      const id = get().sessionId;
      if (!id) return undefined;
      try {
        const result = await fn(id);
        await get().refreshWorkspace();
        return result;
      } catch (e) {
        get().fail(e);
        return undefined;
      }
    },

    touch: (paths, origin = "") => {
      const rev = { ...get().rev };
      const revBy = { ...get().revBy };
      for (const raw of paths) {
        const p = barePath(raw);
        rev[p] = (rev[p] ?? 0) + 1;
        revBy[p] = origin;
      }
      set({ rev, revBy });
      refreshSoon(origin ? 500 : 200);
    },

    uploadFiles: async (all, folder) => {
      // 내보낸 작업·프리셋 파일은 자료로 올릴 것이 아니라 가져올 것이다. 어디에 놓았든 가져오기로 보낸다.
      const files = all.filter((f) => !isArchiveFile(f));
      for (const f of all) if (isArchiveFile(f)) await get().importFile(f);
      const id = get().sessionId;
      if (!id || files.length === 0) return [];
      const done: UploadResult[] = [];
      const failed: { name: string; error: unknown }[] = [];
      for (const file of files) {
        try {
          done.push(await api.upload(id, file, folder));
        } catch (error) {
          failed.push({ name: file.name, error });
        }
      }
      if (get().sessionId !== id) return done;
      if (done.length) get().touch(done.map((d) => d.path));
      await get().refreshWorkspace();
      if (done.length === 1) get().notify(`${pathLabel(done[0].path, null)} 올림${done[0].note ? ` · ${done[0].note}` : ""}`);
      else if (done.length > 1) {
        // 글을 못 뽑아 파일 그대로 들어간 것(스캔한 PDF 등)이 섞여 있으면 그 수를 같이 알린다.
        const raw = done.filter((d) => d.kind === "file").length;
        get().notify(`${done.length}개 올림${raw ? ` · ${raw}개는 글을 뽑지 못해 파일 그대로` : ""}`);
      }
      // 실패는 서버가 준 이유를 그대로 알린다 (텍스트가 안 뽑히는 PDF 등). 여러 개를 올렸으면 어느 파일인지 앞에 붙인다.
      if (failed.length === 1 && files.length === 1) get().fail(failed[0].error);
      else if (failed.length > 0)
        get().fail(new Error(failed.map((f) => `${f.name}: ${f.error instanceof Error ? f.error.message : String(f.error)}`).join(" / ")));
      return done;
    },

    setScreen: (screen) => {
      // 원고 화면에서는 대화가 오른쪽 패널로 간다. 대화 화면으로 돌아오면 그 탭은 없다.
      const rightTab = screen === "manuscript" ? "chat" : get().rightTab === "chat" ? "work" : get().rightTab;
      remember({ screen, rightTab });
      set({ screen, rightTab, rightOpen: screen === "manuscript" ? true : get().rightOpen });
    },

    setExportChapters: (exportChapters) => {
      remember({ exportChapters });
      set({ exportChapters });
    },

    setLeftTab: (leftTab) => {
      remember({ leftTab, leftOpen: true });
      set({ leftTab, leftOpen: true });
    },

    setRightTab: (rightTab) => {
      remember({ rightTab, rightOpen: true });
      set({ rightTab, rightOpen: true });
    },

    togglePanel: (side) => {
      const key = side === "left" ? "leftOpen" : "rightOpen";
      const next = !get()[key];
      remember({ [key]: next });
      set(side === "left" ? { leftOpen: next } : { rightOpen: next });
    },

    setWidth: (key, px) => {
      const [min, max] = WIDTH_LIMIT[key];
      const width = { ...get().width, [key]: Math.round(Math.min(max, Math.max(min, px))) };
      remember({ width });
      set({ width });
    },

    openDrawer: (drawer) => set({ drawer }),
    closeDrawer: () => set({ drawer: null }),

    openDoc: (path) => {
      const p = barePath(path);
      const ws = get().ws;
      // 문서가 아닌 것(대화의 `원고`, 장, 자료 폴더)은 열 글이 없다. 그것이 있는 왼쪽 탭을 보인다.
      if (p === "원고" || (p.startsWith("원고/") && ws?.manuscript.chapters.some((c) => c.id === p.slice(3)))) return get().setLeftTab("manuscript");
      if (p === "자료" || ws?.materials.some((m) => barePath(m.path).startsWith(`${p}/`))) return get().setLeftTab("materials");
      // 겹쳐 뜬 왼쪽 패널에서 고른 것이면, 고른 문서가 가려지지 않게 패널을 접는다.
      if (get().leftOver && get().leftOpen) get().togglePanel("left");
      if (get().screen === "manuscript" && p.startsWith("원고/") && findScene(ws, p)) return get().jumpToScene(p.slice(3));
      const alive = (w: Workspace) =>
        p === "입력" || p === "출력" || (p.startsWith("원고/") ? findScene(w, p) !== null : w.materials.some((m) => barePath(m.path) === p));
      if (!ws || alive(ws)) return set({ drawer: { kind: "doc", path: p } });
      // 목록에 없다. 방금 생긴 문서일 수도, 지워진 문서일 수도 있어서 다시 읽어 보고 정한다.
      // 지워진 것(대화에 남은 옛 경로)은 버전 기록으로 간다. 거기서 복원할 수 있다.
      const id = get().sessionId;
      void get()
        .refreshWorkspace()
        .then(() => {
          const now = get().ws;
          if (get().sessionId !== id || !now) return;
          set({ drawer: alive(now) ? { kind: "doc", path: p } : { kind: "history", path: p } });
        });
    },

    jumpToScene: (scene) => set({ jump: { scene, tick: (get().jump?.tick ?? 0) + 1 } }),

    openAt: (path, line, start, length) => {
      get().openDoc(path);
      set({ locate: { path: barePath(path), line, start, length, tick: (get().locate?.tick ?? 0) + 1 } });
    },

    openDialog: (dialog) => {
      // 다른 창(도구 창의 모델 칸 등)에서 키를 넣으러 설정으로 간 것이면, 설정을 닫을 때 그 창으로 돌아간다.
      const from = get().dialog;
      dialogBack = dialog?.type === "settings" && dialog.provider && from && from.type !== "settings" ? from : null;
      set({ dialog });
    },
    closeDialog: () => {
      set({ dialog: dialogBack });
      dialogBack = null;
    },

    setDraft: (draft) => set({ draft }),

    focusComposer: () => {
      // 원고 화면에서는 채팅창이 오른쪽 패널의 대화 탭 안에 있다.
      if (get().screen === "manuscript") get().setRightTab("chat");
      set({ focusTick: get().focusTick + 1 });
    },

    insertCommand: (label) => {
      const rest = get().draft.replace(/^\/\S*\s*/, "");
      set({ draft: `/${label} ${rest}` });
      get().focusComposer();
    },

    setQuote: (quote) => {
      set({ quote });
      if (!quote) return;
      // 대화 화면에서 넓은 패널이 채팅창을 덮고 있으면, 인용이 들어간 채팅창이 보이게 패널을 닫는다.
      if (get().drawerOver && get().screen === "chat") set({ drawer: null });
      get().focusComposer();
    },

    send: async () => {
      const { sessionId, conversationId, preset, running, starting, draft, quote } = get();
      // 한 작업에서는 한 번에 하나만 돈다. 다른 대화에서 도는 중에도, 압축하는 중에도 보낼 수 없다.
      if (!sessionId || running || starting || get().compacting) return false;
      const conversation = conversationId || undefined;
      const { tool, rest } = parseCommand(draft, preset?.tools ?? []);
      if (!rest && !tool && !quote) return false;
      // 에이전트에게 보내는 것인데 모델이 없으면 서버가 거절한다. 보내기 전에 모델 고르기를 열어 준다.
      // (프리셋의 모델을 방금 바꿔 서버의 답이 아직 안 왔으면 그대로 보내고 서버가 정하게 둔다.)
      const direct = Boolean(tool && !rest && !quote);
      const state = get().ws?.state;
      if (!direct && preset && state && (!preset.model || (state.model === preset.model && !state.effective_model))) {
        set({ modelTick: get().modelTick + 1 });
        get().notify(preset.model ? "이 모델은 쓸 수 없습니다. 다른 모델을 골라야 합니다" : "모델을 골라야 합니다", "error");
        return false;
      }
      set({ starting: true });
      try {
        await statePending.catch(() => undefined);
        await flushPreset();
        // `/도구`만 보내면 에이전트를 거치지 않고 지금 입력으로 바로 돌린다.
        if (tool && direct) await api.runTool(sessionId, tool.name, conversation ? { conversation } : undefined);
        else await api.startRun(sessionId, { goal: withQuote(quote, rest), tool: tool?.name, conversation });
        // 보내는 사이에 다른 대화로 갔어도 실행은 보낸 대화의 것이다.
        set({ running: true, runConversation: conversationId, ...(get().conversationId === conversationId ? { draft: "", quote: null } : {}) });
        attach(sessionId);
        void get().refreshSessions();
        return true;
      } catch (e) {
        get().fail(e);
        return false;
      } finally {
        set({ starting: false });
      }
    },

    stop: async () => {
      const id = get().sessionId;
      if (!id) return;
      try {
        await api.stopRun(id);
      } catch (e) {
        get().fail(e);
      }
    },

    answer: async (eventId, text) => {
      const id = get().sessionId;
      if (!id) return;
      try {
        await api.respond(id, eventId, text);
      } catch (e) {
        get().fail(e);
      }
    },

    steer: async (text) => {
      const { sessionId, quote } = get();
      const body = text.trim();
      if (!sessionId || !body) return false;
      try {
        await api.steer(sessionId, withQuote(quote, body));
        // 보내는 사이에 더 쓴 글이 있으면 그것은 남긴다.
        if (get().sessionId === sessionId) set({ draft: get().draft.trim() === body ? "" : get().draft, quote: null });
        return true;
      } catch (e) {
        // 보내는 사이에 실행이 끝났다(409). 글은 채팅창에 그대로 있으니 새 요청으로 보낸다.
        // 서버에서는 끝났는데 끝났다는 소식이 화면에 아직 안 왔을 수 있어서, 올 때까지 잠깐 기다린다.
        if (e instanceof ApiError && e.status === 409) {
          for (let i = 0; i < 20 && get().running && get().sessionId === sessionId; i++) await new Promise((r) => setTimeout(r, 100));
          if (get().sessionId !== sessionId) return false;
          if (!get().running) return get().send();
        }
        get().fail(e);
        return false;
      }
    },

    revertRun: async (runId, force = false) => {
      const id = get().sessionId;
      if (!id || get().running) return false;
      try {
        const { reverted, kept } = await api.revertRun(id, runId, force);
        if (get().sessionId !== id) return true;
        // 작업 공간을 먼저 읽는다. 되돌려서 없어진 문서를 띄워 둔 패널이 닫힌 뒤에 편집기들이 다시 읽게 하려는 것이다.
        await Promise.all([get().refreshWorkspace(), get().reloadConversation()]);
        // `원고`만 온 것은 순서만 바뀐 것이라 다시 읽을 본문이 없다 (attach와 같다).
        const changed = reverted.filter((p) => barePath(p) !== "원고");
        if (changed.length) get().touch(changed);
        get().notify(kept.length ? `되돌림 · ${kept.length}개는 그대로 둠` : "되돌림");
        return true;
      } catch (e) {
        // 내가 고친 문서가 있어서 거절된 것(본문에 touched_later)은 부른 쪽이 그 문서들을 보이고 다시 묻는다.
        // 그 밖의 거절(가장 최근의 실행이 아니다, 이미 되돌렸다)은 이유를 알린다.
        const touched = e instanceof ApiError && e.status === 409 && Array.isArray((e.data as { touched_later?: unknown } | null)?.touched_later);
        if (!touched || force) {
          get().fail(e);
          // 다른 데서 이미 되돌렸을 수 있다. 대화를 다시 받아 `되돌림` 표시가 맞게 한다.
          void get().reloadConversation();
        }
        return false;
      }
    },

    compactNow: async () => {
      const id = get().sessionId;
      const cid = get().conversationId;
      if (!id || get().running || get().starting || get().compacting) return false;
      set({ compacting: true });
      try {
        await flushPreset(); // 압축은 프리셋의 보조 모델로 한다
        const done = await api.compact(id, cid || undefined);
        if (get().sessionId !== id || get().conversationId !== cid) return done.compacted;
        if (!done.compacted) {
          get().notify("줄일 대화가 없습니다");
          return false;
        }
        // 기록 끝에 압축 표시가 붙고 원그래프의 토큰 수가 줄어든다.
        await Promise.all([get().reloadConversation(), get().refreshWorkspace(), get().refreshConversations()]);
        return true;
      } catch (e) {
        get().fail(e);
        return false;
      } finally {
        set({ compacting: false });
      }
    },

    reloadConversation: async () => {
      const id = get().sessionId;
      if (!id) return;
      const cid = get().conversationId;
      try {
        const { events, run } = await api.events(id, cid || undefined);
        if (get().sessionId !== id || get().conversationId !== cid) return;
        // 받은 기록으로 처음부터 다시 짜므로, 붙어 있던 스트림이 같은 이벤트를 한 번 더 얹지 않게 끊는다.
        unsubscribe?.();
        unsubscribe = null;
        show(id, cid, events, run);
      } catch (e) {
        get().fail(e);
      }
    },

    refreshConversations: async () => {
      const id = get().sessionId;
      if (!id) return;
      try {
        const list = await api.conversations(id);
        if (get().sessionId === id) set({ conversations: list.conversations });
      } catch {
        /* 목록 갱신 실패는 조용히 넘긴다 */
      }
    },

    selectConversation: async (cid) => {
      if (!get().sessionId || cid === get().conversationId) return;
      // 쓰던 글과 인용은 대화를 따라가지 않는다. 채팅창에 그대로 둔다.
      void get().setSessionState({ conversation: cid });
      await openConversation(cid);
    },

    newConversation: async () => {
      const id = get().sessionId;
      if (!id) return;
      // 아직 한 번도 보내지 않은 대화를 보고 있으면 그것이 새 대화다. 빈 대화를 또 만들지 않는다.
      const current = get().conversations.find((c) => c.id === get().conversationId);
      if (current && !current.name && get().items.length === 0) return get().focusComposer();
      try {
        const made = await api.createConversation(id);
        if (get().sessionId !== id) return;
        set({ conversations: [...get().conversations.filter((c) => c.id !== made.id), made] });
        await openConversation(made.id); // 서버는 만든 대화를 이미 보고 있는 대화로 적어 두었다
        get().focusComposer();
      } catch (e) {
        get().fail(e);
      }
    },

    renameConversation: async (cid, name) => {
      const id = get().sessionId;
      if (!id || !name.trim()) return;
      try {
        const renamed = await api.renameConversation(id, cid, name.trim());
        if (get().sessionId === id) set({ conversations: get().conversations.map((c) => (c.id === cid ? renamed : c)) });
      } catch (e) {
        get().fail(e);
      }
    },

    deleteConversation: async (cid) => {
      const id = get().sessionId;
      if (!id) return;
      try {
        const left = await api.deleteConversation(id, cid);
        if (get().sessionId !== id) return;
        set({ conversations: left.conversations });
        // 보던 대화를 지웠으면 서버가 고른 대화로 간다 (마지막 대화를 지우면 빈 대화 하나가 남는다).
        if (cid === get().conversationId) await openConversation(left.current);
      } catch (e) {
        get().fail(e);
      }
    },
  };
});
