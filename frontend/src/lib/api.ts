import { ApiError } from "./errors";
import { fakeApi } from "./fake";
import type {
  Compacted,
  Conversation,
  DeletedItem,
  DocContent,
  FontFile,
  HistoryEntry,
  Imported,
  LastRun,
  SearchHit,
  Usage,
  Meta,
  ModelEntry,
  Preset,
  PresetSummary,
  Provider,
  ResolvedRef,
  RunEvent,
  RunStatus,
  SessionState,
  SessionSummary,
  ToolRun,
  UploadResult,
  Workspace,
} from "./types";

export { ApiError };

export type ExportFormat = "md" | "txt" | "html" | "zip";
export type FlagPatch = { locked?: boolean | null; note?: boolean | null };
export interface ProviderBody {
  kind: string;
  label?: string;
  api_key?: string;
  base_url?: string;
  extra?: Record<string, string>;
  enabled?: boolean;
}
export interface ConversationList {
  conversations: Conversation[];
  current: string;
}
export interface NewScene {
  content?: string;
  from_output?: boolean;
  chapter?: string;
  after?: string | null;
  new_chapter?: boolean;
}

/** 화면이 쓰는 API 전부. 실제 서버(httpApi)와 브라우저 안의 가짜(fakeApi)가 같은 모양이다. */
export interface Api {
  meta(): Promise<Meta>;

  providers(): Promise<Provider[]>;
  saveProvider(id: string, body: ProviderBody): Promise<Provider>;
  clearProviderKey(id: string): Promise<Provider>;
  deleteProvider(id: string): Promise<unknown>;
  models(id: string, refresh?: boolean): Promise<{ models: ModelEntry[]; error: string | null }>;

  /** 사용자가 올린 폰트 파일들. 이름, 굵기 순. */
  fonts(): Promise<FontFile[]>;
  /** 폰트 파일(ttf·otf·woff·woff2)을 올린다. 폰트가 아니면 400(ApiError)이고 이유가 message에 온다. */
  uploadFont(file: File): Promise<FontFile>;
  deleteFont(id: string): Promise<unknown>;
  /** 화면 설정. 엔진은 내용을 보지 않고 맡아 두기만 한다 (모양은 lib/appearance.ts). */
  appearance(): Promise<Record<string, unknown>>;
  saveAppearance(value: Record<string, unknown>): Promise<Record<string, unknown>>;

  presets(): Promise<PresetSummary[]>;
  preset(id: string): Promise<Preset>;
  savePreset(p: Preset): Promise<Preset>;
  /** 준 칸만 고친다. 채팅창에서 모델·추론 수준을 바꿀 때 쓴다 (패널이 자동 저장하는 다른 칸을 덮지 않게). */
  patchPreset(id: string, patch: Partial<Preset>): Promise<Preset>;
  deletePreset(id: string): Promise<{ status: "deleted" | "reverted" }>;
  duplicatePreset(id: string, name?: string): Promise<Preset>;
  /** 내보낸 파일의 내용(JSON으로 읽은 값)을 그대로 준다. */
  /** 프리셋을 `<이름>.alephpreset` 파일로 내려받는다. */
  exportPreset(id: string): Promise<void>;

  sessions(): Promise<SessionSummary[]>;
  createSession(name: string, preset_id?: string): Promise<{ id: string; name: string; created_at: string | null }>;
  renameSession(id: string, name: string): Promise<unknown>;
  deleteSession(id: string): Promise<unknown>;

  state(id: string): Promise<SessionState>;
  saveState(id: string, patch: Partial<SessionState>): Promise<SessionState>;
  /** conversation: 컨텍스트의 크기를 볼 대화 (안 주면 서버가 지금 보고 있다고 아는 대화). */
  workspace(id: string, conversation?: string): Promise<Workspace>;

  /** 이 작업의 대화들(만든 순서)과 지금 보고 있는 대화. */
  conversations(id: string): Promise<ConversationList>;
  /** 새 대화를 만든다. 그것이 보고 있는 대화가 된다. */
  createConversation(id: string, name?: string): Promise<Conversation>;
  renameConversation(id: string, conversation: string, name: string): Promise<Conversation>;
  /** 대화를 지운다 (기록과 에이전트의 기억. 문서는 그대로). 남은 목록이 온다. 그 대화가 실행 중이면 409. */
  deleteConversation(id: string, conversation: string): Promise<ConversationList>;

  doc(id: string, path: string): Promise<DocContent>;
  saveDoc(id: string, path: string, content: string): Promise<{ path: string; created: boolean }>;
  /** 자료에 빈 폴더를 만든다 (`자료/인물/조연`처럼 안쪽 폴더도 된다). 이미 있으면 그대로 둔다. 이렇게 만든 폴더는 비어도 남는다. */
  addFolder(id: string, path: string): Promise<{ path: string }>;
  /** 문서나 폴더를 지운다 (빈 폴더도). */
  deleteDoc(id: string, path: string): Promise<unknown>;
  moveDoc(id: string, source: string, destination: string): Promise<{ path: string }>;
  setFlags(id: string, path: string, flags: FlagPatch): Promise<unknown>;
  history(id: string, path: string): Promise<HistoryEntry[]>;
  version(id: string, hash: string): Promise<string>;
  restore(id: string, path: string, hash: string): Promise<unknown>;
  resolve(id: string, ref: string): Promise<ResolvedRef>;
  /** 이미지 등 파일을 보여줄 주소. */
  fileUrl(id: string, path: string): string;
  upload(id: string, file: File, folder?: string): Promise<UploadResult>;

  addScene(id: string, body: NewScene): Promise<{ id: string; path: string; chapter: string }>;
  patchScene(id: string, scene: string, body: { summary?: string | null }): Promise<unknown>;
  moveScene(id: string, scene: string, to: { chapter: string; after: string | null }): Promise<unknown>;
  splitScene(id: string, scene: string, at: number[]): Promise<{ ids: string[] }>;
  mergeScenes(id: string, scenes: string[]): Promise<{ id: string }>;
  deleteScene(id: string, scene: string): Promise<unknown>;
  addChapter(id: string, body: { after?: string | null }): Promise<{ id: string }>;
  patchChapter(id: string, chapter: string, body: { summary?: string }): Promise<unknown>;
  moveChapter(id: string, chapter: string, after: string | null): Promise<unknown>;
  deleteChapter(id: string, chapter: string): Promise<unknown>;
  /** 원고를 파일로 내려받는다. chapters가 false면 장마다 넣는 번호 머리(`1장`)를 뺀다. */
  exportFile(id: string, format: ExportFormat, options?: { chapters?: boolean }): Promise<void>;

  toolRuns(id: string): Promise<ToolRun[]>;
  /** 지워진 채로 있는 글 문서와 장면 (누가 지웠든). 최근에 지운 것부터. */
  deleted(id: string): Promise<DeletedItem[]>;
  /** conversation: 요청을 보낼 대화. 다른 대화에서 실행 중이면 409 (한 작업에서는 한 번에 하나만 돈다). */
  startRun(id: string, body: { goal: string; tool?: string; conversation?: string }): Promise<{ run_id: string }>;
  /**
   * 에이전트를 거치지 않고 지금 입력으로 도구를 돌린다. conversation은 그 기록이 붙을 대화.
   * trial을 주면 시험 실행이다: 출력을 건드리지 않고 결과는 도구 실행 기록에만 남는다.
   * input_seq는 그 번호의 실행에 들어갔던 입력을 다시 쓴다(안 주면 지금 입력), model은 이번에만 쓸 모델.
   */
  runTool(id: string, name: string, body?: { trial?: true; input_seq?: number; model?: string; conversation?: string }): Promise<{ run_id: string }>;
  /** 가장 최근의 실행과, 되돌리면 무엇이 돌아가는지. */
  lastRun(id: string): Promise<LastRun>;
  /** 실행 하나를 되돌린다. 그 뒤에 사용자가 고친 문서가 있으면 409(ApiError)이고, force로 보내면 그 문서는 그대로 둔다. */
  revertRun(id: string, runId: string, force?: boolean): Promise<{ reverted: string[]; kept: string[] }>;
  /** 대화를 지금 줄인다. 실행 중이면 409, 요약에 실패하면 502(대화는 그대로), 프리셋에 모델이 없으면 400. */
  compact(id: string, conversation?: string): Promise<Compacted>;
  /** 실행 중인 에이전트에게 말을 끼워 넣는다. 실행 중이 아니면 409. */
  steer(id: string, text: string): Promise<unknown>;
  /** 작업을 통째로 zip으로 내려받는다. */
  exportArchive(id: string): Promise<void>;
  /** 내보낸 zip을 새 작업으로 들여온다. */
  /** 내보낸 파일(`.aleph` 작업, `.alephpreset` 프리셋)을 들여온다. 무엇이 들어왔는지는 `kind`로 안다. */
  importFile(file: File): Promise<Imported>;
  search(id: string, query: string, scope?: "all" | "manuscript" | "materials"): Promise<{ hits: SearchHit[]; truncated: boolean }>;
  usage(id: string): Promise<Usage>;
  /** 대화 하나의 기록. conversation을 안 주면 지금 보고 있는 대화이고, 어느 대화인지는 conversation_id로 온다. run은 작업의 실행이다. */
  events(id: string, conversation?: string): Promise<{ events: RunEvent[]; run: RunStatus; conversation_id?: string }>;
  /** 진행 중인 실행의 이벤트를 받는다 (작업에 하나. 이벤트마다 conversation_id가 붙는다). 끝나면 onEnd. 돌려주는 함수로 끊는다. */
  subscribe(id: string, onEvent: (e: RunEvent) => void, onEnd: () => void): () => void;
  respond(id: string, event_id: string, response: string): Promise<unknown>;
  stopRun(id: string): Promise<{ stopped: boolean }>;
  processLog(id: string): Promise<{ content: string; session_name: string }>;
}

/*
 * 창을 닫거나 새로 고치는 순간에 떠나는 저장(방금 친 지침, 문서)은 페이지가 사라져도 끝까지 가야 한다.
 * 그때만 keepalive를 건다. keepalive는 본문이 64KB를 넘으면 거절되므로 짧은 글에만 쓴다 (긴 글은 평소처럼 보낸다).
 */
let leaving = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => (leaving = true));
  window.addEventListener("pageshow", () => (leaving = false));
}
const KEEPALIVE_CHARS = 20000; // 한글은 글자당 3바이트

async function request<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  let res: Response;
  try {
    const json = raw === undefined && body !== undefined ? JSON.stringify(body) : undefined;
    res = await fetch(`/api${path}`, {
      method,
      headers: json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: raw ?? json,
      keepalive: leaving && json !== undefined && json.length < KEEPALIVE_CHARS,
    });
  } catch {
    throw new ApiError(0, "서버에 연결하지 못했습니다. ALEPH가 실행 중인지 확인해야 합니다.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* JSON이 아닌 응답 */
  }
  if (!res.ok) {
    let message = `요청이 실패했습니다 (HTTP ${res.status}).`;
    if (data?.error) message = String(data.error);
    else if (Array.isArray(data?.detail))
      message = data.detail.map((d: any) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`).join(" / ");
    else if (typeof data?.detail === "string") message = data.detail;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);
const q = encodeURIComponent;
/** 대화를 가리키는 꼬리. 안 주면 서버가 지금 보고 있다고 아는 대화로 간다. */
const at = (conversation?: string) => (conversation ? `?conversation=${q(conversation)}` : "");

/**
 * 서버가 주는 파일을 받아서 내려 준다. 주소로 바로 가면 서버가 거절했을 때(실행 중 409 등) 이유를 알 수 없다.
 * 파일 이름은 서버가 `Content-Disposition`의 `filename*`에 준 것을 쓴다.
 */
async function fetchDownload(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`);
  } catch {
    throw new ApiError(0, "서버에 연결하지 못했습니다. ALEPH가 실행 중인지 확인해야 합니다.");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ? String(data.error) : `내보내지 못했습니다 (HTTP ${res.status}).`, data);
  }
  const header = res.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(header)?.[1];
  download(encoded ? decodeURIComponent(encoded) : (plain ?? fallbackName), await res.blob(), "application/octet-stream");
}

/** 내보내기 주소. 장 번호를 넣을지는 늘 적어 보낸다 (안 적으면 서버는 넣는다). */
export function exportUrl(id: string, format: ExportFormat, options?: { chapters?: boolean }): string {
  return `/api/sessions/${id}/export?format=${format}&chapters=${options?.chapters === false ? "false" : "true"}`;
}

function subscribeHttp(sessionId: string, onEvent: (e: RunEvent) => void, onEnd: () => void): () => void {
  let lastSeq = 0;
  let closed = false;
  let source: EventSource | null = null;

  const close = () => {
    closed = true;
    source?.close();
  };
  const open = () => {
    if (closed) return;
    source = new EventSource(`/api/sessions/${sessionId}/stream?after=${lastSeq}`);
    source.onmessage = (msg) => {
      if (msg.data === "[DONE]") {
        close();
        onEnd();
        return;
      }
      try {
        const event = JSON.parse(msg.data) as RunEvent;
        if (event.seq !== undefined) {
          if (event.seq <= lastSeq) return;
          lastSeq = event.seq;
        }
        onEvent(event);
      } catch {
        /* 깨진 줄은 무시 */
      }
    };
    source.onerror = () => {
      // 기본 재접속은 처음 주소(after=옛 값)로 붙으므로, 직접 닫고 최신 위치에서 다시 연다.
      source?.close();
      if (!closed) setTimeout(open, 1500);
    };
  };
  open();
  return close;
}

export const httpApi: Api = {
  meta: () => get("/meta"),

  providers: () => get<{ providers: Provider[] }>("/providers").then((r) => r.providers),
  saveProvider: (id, body) => put(`/providers/${q(id)}`, body),
  clearProviderKey: (id) => del(`/providers/${q(id)}/key`),
  deleteProvider: (id) => del(`/providers/${q(id)}`),
  models: (id, refresh = false) => get(`/providers/${q(id)}/models${refresh ? "?refresh=true" : ""}`),

  fonts: () => get<{ fonts: FontFile[] }>("/fonts").then((r) => r.fonts),
  uploadFont: (file) => request("POST", `/fonts/upload?name=${q(file.name)}`, undefined, file),
  deleteFont: (id) => del(`/fonts/${q(id)}`),
  appearance: () => get<Record<string, unknown> | null>("/appearance").then((r) => r ?? {}),
  saveAppearance: (value) => put("/appearance", value),

  presets: () => get<{ presets: PresetSummary[] }>("/presets").then((r) => r.presets),
  preset: (id) => get(`/presets/${q(id)}`),
  savePreset: (p) => put(`/presets/${q(p.id)}`, p),
  patchPreset: (id, body) => patch(`/presets/${q(id)}`, body),
  deletePreset: (id) => del(`/presets/${q(id)}`),
  duplicatePreset: (id, name) => post(`/presets/${q(id)}/duplicate`, name ? { name } : {}),
  exportPreset: (id) => fetchDownload(`/presets/${q(id)}/archive`, "프리셋.alephpreset"),

  sessions: () => get<{ sessions: SessionSummary[] }>("/sessions").then((r) => r.sessions),
  createSession: (name, preset_id) => post("/sessions", { name, preset_id }),
  renameSession: (id, name) => patch(`/sessions/${id}`, { name }),
  deleteSession: (id) => del(`/sessions/${id}`),

  state: (id) => get(`/sessions/${id}/state`),
  saveState: (id, body) => put(`/sessions/${id}/state`, body),
  workspace: (id, conversation) => get(`/sessions/${id}/workspace${at(conversation)}`),

  conversations: (id) => get(`/sessions/${id}/conversations`),
  createConversation: (id, name) => post(`/sessions/${id}/conversations`, name ? { name } : {}),
  renameConversation: (id, conversation, name) => patch(`/sessions/${id}/conversations/${q(conversation)}`, { name }),
  deleteConversation: (id, conversation) => del(`/sessions/${id}/conversations/${q(conversation)}`),

  doc: (id, path) => get(`/sessions/${id}/docs/content?path=${q(path)}`),
  saveDoc: (id, path, content) => put(`/sessions/${id}/docs/content`, { path, content }),
  addFolder: (id, path) => post(`/sessions/${id}/docs/folders`, { path }),
  deleteDoc: (id, path) => del(`/sessions/${id}/docs/content?path=${q(path)}`),
  moveDoc: (id, source, destination) => post(`/sessions/${id}/docs/move`, { source, destination }),
  setFlags: (id, path, flags) => put(`/sessions/${id}/flags`, { path, ...flags }),
  history: (id, path) => get<{ entries: HistoryEntry[] }>(`/sessions/${id}/docs/history?path=${q(path)}`).then((r) => r.entries),
  version: (id, hash) => get<{ content: string }>(`/sessions/${id}/docs/version?hash=${q(hash)}`).then((r) => r.content),
  restore: (id, path, hash) => post(`/sessions/${id}/docs/restore`, { path, hash }),
  resolve: (id, ref) => get(`/sessions/${id}/docs/resolve?ref=${q(ref)}`),
  fileUrl: (id, path) => `/api/sessions/${id}/files?path=${q(path)}`,
  upload: (id, file, folder) =>
    request("POST", `/sessions/${id}/upload?name=${q(file.name)}${folder ? `&folder=${q(folder)}` : ""}`, undefined, file),

  addScene: (id, body) => post(`/sessions/${id}/manuscript/scenes`, body),
  patchScene: (id, scene, body) => patch(`/sessions/${id}/manuscript/scenes/${q(scene)}`, body),
  moveScene: (id, scene, to) => post(`/sessions/${id}/manuscript/scenes/${q(scene)}/move`, to),
  splitScene: (id, scene, at) => post(`/sessions/${id}/manuscript/scenes/${q(scene)}/split`, { at }),
  mergeScenes: (id, scenes) => post(`/sessions/${id}/manuscript/merge`, { scenes }),
  deleteScene: (id, scene) => del(`/sessions/${id}/manuscript/scenes/${q(scene)}`),
  addChapter: (id, body) => post(`/sessions/${id}/manuscript/chapters`, body),
  patchChapter: (id, chapter, body) => patch(`/sessions/${id}/manuscript/chapters/${q(chapter)}`, body),
  moveChapter: (id, chapter, after) => post(`/sessions/${id}/manuscript/chapters/${q(chapter)}/move`, { after }),
  deleteChapter: (id, chapter) => del(`/sessions/${id}/manuscript/chapters/${q(chapter)}`),
  exportFile: async (id, format, options) => {
    // 서버가 Content-Disposition을 붙여 주므로 주소로 가기만 하면 내려받아진다.
    const a = document.createElement("a");
    a.href = exportUrl(id, format, options);
    a.download = "";
    a.click();
  },

  toolRuns: (id) => get<{ runs: ToolRun[] }>(`/sessions/${id}/tool-runs`).then((r) => r.runs),
  deleted: (id) => get<{ items: DeletedItem[] }>(`/sessions/${id}/deleted`).then((r) => r.items),
  startRun: (id, body) => post(`/sessions/${id}/runs`, body),
  runTool: (id, name, body) => post(`/sessions/${id}/tools/${q(name)}/run`, body),
  lastRun: (id) => get(`/sessions/${id}/runs/last`),
  revertRun: (id, runId, force) => post(`/sessions/${id}/runs/${q(runId)}/revert`, force ? { force: true } : {}),
  compact: (id, conversation) => post(`/sessions/${id}/conversation/compact${at(conversation)}`),
  steer: (id, text) => post(`/sessions/${id}/steer`, { text }),
  exportArchive: (id) => fetchDownload(`/sessions/${id}/archive`, "작업.aleph"),
  importFile: (file) => request("POST", "/import", undefined, file),
  search: (id, query, scope = "all") => get(`/sessions/${id}/search?q=${q(query)}&scope=${scope}`),
  usage: (id) => get(`/sessions/${id}/usage`),
  events: (id, conversation) => get(`/sessions/${id}/events${at(conversation)}`),
  subscribe: subscribeHttp,
  respond: (id, event_id, response) => post(`/sessions/${id}/respond`, { event_id, response }),
  stopRun: (id) => post(`/sessions/${id}/stop`),
  processLog: (id) => get(`/sessions/${id}/process-log`),
};

/**
 * 엔진이 새 명세로 올라오기 전까지는 브라우저 안의 가짜를 쓴다.
 * `npm run dev:fake`(VITE_FAKE_API=1)로 띄우면 가짜, 그 밖에는 실제 서버다. 바꿀 곳은 이 한 줄이다.
 */
export const usingFakeApi = import.meta.env.VITE_FAKE_API === "1";
export const api: Api = usingFakeApi ? fakeApi : httpApi;

export function download(filename: string, content: string | Blob, type = "text/markdown") {
  const blob = typeof content === "string" ? new Blob([content], { type: `${type};charset=utf-8` }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
