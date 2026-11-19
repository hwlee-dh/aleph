/*
 * 브라우저 안에서 도는 가짜 API. 엔진이 새 명세(backend/API.md)로 올라오기 전까지 화면을 이것 위에서 만든다.
 * 응답의 모양은 명세와 같고, 실제 모델은 부르지 않는다. 상태는 localStorage(aleph-fake-v1)에 남는다.
 * 콘솔에서 `__alephFakeReset()`을 부르면 처음 상태로 돌아간다.
 */
import { ApiError } from "../errors";
import type { Api, ExportFormat, FlagPatch, NewScene, ProviderBody } from "../api";
import type { FontFile, Imported, Preset, Provider, RunEvent, SessionState, Thinking, ToolDef, UploadResult } from "../types";
import { agentToolLabel, META, MODELS, PROVIDER_KINDS } from "./data";
import { compact, isRunning, reconcile, respond, runTool, startRun, stopAll, stopRun, subscribe } from "./engine";
import { blobKey, blobUrls, db, reset, save, saveNow, session } from "./persist";
import {
  addScene,
  allEvents,
  buildWorkspace,
  builtinPreset,
  clone,
  conversationList,
  conversationOf,
  conversationView,
  createChapter,
  createConversation,
  deleteChapter,
  deleteConversation,
  addFolder,
  deleteDoc,
  deleteScene,
  exportText,
  getPreset,
  historyOf,
  IMAGE_EXT,
  locate,
  MAIN,
  manuscriptChars,
  mergeScenes,
  moveChapter,
  moveDoc,
  moveScene,
  newConversation,
  newSession,
  norm,
  now,
  patchChapter,
  patchScene,
  presetSummaries,
  readDoc,
  record,
  renameConversation,
  resolveRef,
  restore,
  sessionState,
  setFlags,
  splitScene,
  uniquePath,
  writeDoc,
  type FakeSession,
} from "./state";

/**
 * 가짜 호출 하나. 상태를 바꾼 뒤 저장하고, 돌려주는 값은 복사본이다
 * (화면이 받은 값을 고쳐도 안쪽 상태가 따라 바뀌지 않게).
 */
/**
 * 작업의 문서가 마지막으로 바뀐 때. 바뀐 적이 없으면 만든 때다 (API.md 2절의 `updated_at`).
 * 버전 기록은 오래된 것이 잘려 나가므로 문서마다 적힌 때도 같이 본다. 전부 같은 꼴(ISO, UTC)이라 글자로 견줘도 된다.
 */
function lastChanged(s: FakeSession): string {
  const times = [
    s.created_at,
    s.history[s.history.length - 1]?.timestamp,
    s.input.updated_at,
    s.output.updated_at,
    ...Object.values(s.scenes).map((sc) => sc.updated_at),
    ...Object.values(s.materials).map((m) => m.updated_at),
  ];
  return times.reduce<string>((latest, t) => (t && t > latest ? t : latest), s.created_at);
}

/** 파일 이름에 쓸 수 없는 글자를 바꾼다. */
const fileName = (name: string) => (name || "이름 없음").replace(/[\\/:*?"<>|]/g, "_");

/** 같은 이름이 있으면 꼬리(`(가져옴)` 등)를 붙이고, 그것도 있으면 번호를 붙인다. 프리셋은 꼬리 없이 번호만(" "). */
function freeName(name: string, taken: string[], tail: string): string {
  if (!taken.includes(name)) return name;
  const base = tail.trim() ? `${name}${tail}` : name;
  if (tail.trim() && !taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

function fail501(): never {
  throw new ApiError(501, "가짜 API에는 없는 기능입니다. 시연 서버에 붙여서 봐야 합니다.");
}

async function call<T>(fn: () => T): Promise<T> {
  const value = fn();
  save();
  return clone(value);
}

/* ───────── 제공자 ───────── */

function providerKind(id: string) {
  const kind = PROVIDER_KINDS.find((k) => k.id === id);
  if (!kind) throw new ApiError(400, `모르는 제공자 종류입니다: ${id}`);
  return kind;
}

function findProvider(id: string): Provider {
  const p = db().providers.find((x) => x.id === id);
  if (!p) throw new ApiError(404, `그런 제공자가 없습니다: ${id}`);
  return p;
}

/** 준비 여부 같은 읽기 전용 값을 다시 셈한다. */
function settle(p: Provider): Provider {
  const kind = providerKind(p.kind);
  p.effective_base_url = p.base_url || kind.default_base_url || "";
  p.key_source = p.has_key ? "config" : null;
  p.ready = p.enabled && (p.has_key || !kind.needs_key || kind.key_optional) && (!!p.effective_base_url || !kind.base_url_editable);
  p.tested = kind.tested;
  return p;
}

function saveProvider(id: string, body: ProviderBody): Provider {
  const st = db();
  const kind = providerKind(body.kind);
  const pid = norm(id).replace(/[/:\s]/g, "-");
  if (!pid) throw new ApiError(400, "제공자 이름이 비어 있습니다");
  let p = st.providers.find((x) => x.id === pid);
  if (!p) {
    p = {
      id: pid,
      kind: kind.id,
      label: kind.label,
      base_url: "",
      effective_base_url: "",
      extra: {},
      secrets: {},
      enabled: true,
      has_key: false,
      key_source: null,
      ready: false,
      tested: kind.tested,
    };
    st.providers.push(p);
  }
  p.kind = kind.id;
  if (body.label !== undefined) p.label = body.label.trim() || kind.label;
  if (body.base_url !== undefined) p.base_url = body.base_url.trim();
  if (body.enabled !== undefined) p.enabled = body.enabled;
  // 키는 어디에도 두지 않는다. 넣었다는 사실만 기억한다.
  if (body.api_key) p.has_key = true;
  for (const [name, value] of Object.entries(body.extra ?? {})) {
    const field = kind.extra.find((f) => f.name === name);
    if (field?.secret) {
      if (value) p.secrets[name] = { set: true, summary: "저장됨" };
    } else p.extra[name] = value;
  }
  return settle(p);
}

/* ───────── 프리셋 ───────── */

const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const THINKING: readonly string[] = ["default", "off", "low", "medium", "high"] satisfies Thinking[];
const isThinking = (v: unknown): v is Thinking => typeof v === "string" && THINKING.includes(v);

/** 온도는 0~2로 맞춘다. */
function temperature(v: unknown): number | null {
  const n = numberOrNull(v);
  return n === null ? null : Math.min(2, Math.max(0, n));
}

/** 토큰 한도. 0이나 음수는 정하지 않은 것(null)이다. */
function limit(v: unknown): number | null {
  const n = numberOrNull(v);
  return n !== null && n >= 1 ? Math.floor(n) : null;
}

function cleanTools(raw: unknown): ToolDef[] {
  const taken = new Set<string>();
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => {
      // 이름은 모델이 부르는 함수 이름이라 영문 소문자·숫자·밑줄만 남긴다. 비었거나 겹치면 새로 정한다.
      let name = text(t.name)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "");
      for (let n = 1; !name || taken.has(name); n++) name = `tool_${n}`;
      taken.add(name);
      return {
        name,
        label: text(t.label) || text(t.display_label) || text(t.name) || name,
        description: text(t.description),
        prompt: text(t.prompt) || text(t.instruction) || text(t.template),
        model: text(t.model),
        temperature: temperature(t.temperature),
        thinking: isThinking(t.thinking) ? t.thinking : "",
        max_tokens: limit(t.max_tokens),
        enabled: t.enabled !== false,
      };
    });
}

/** 시작 모드. 비었으면 정하지 않은 것이고, 없는 모드는 엔진처럼 거절한다. */
function startMode(v: unknown): Preset["start_mode"] {
  if (v === undefined || v === null || v === "") return "";
  const mode = META.modes.find((m) => m.id === v)?.id;
  if (!mode) throw new ApiError(400, `모르는 모드입니다: ${String(v)}`);
  return mode;
}

/** 받은 값을 프리셋 모양으로 맞춘다. 빠진 값이 있어도 받는다. */
function cleanPreset(raw: unknown, id: string): Preset {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(422, "프리셋 파일이 아니다");
  const p = raw as Record<string, unknown>;
  const budget = numberOrNull(p.context_budget);
  const starter: Record<string, string> = {};
  if (p.starter && typeof p.starter === "object") for (const [k, v] of Object.entries(p.starter as Record<string, unknown>)) if (typeof v === "string") starter[k] = v;
  return {
    id,
    name: text(p.name).trim() || "이름 없는 프리셋",
    description: text(p.description),
    instruction: text(p.instruction),
    tools: cleanTools(p.tools),
    model: text(p.model),
    temperature: temperature(p.temperature),
    thinking: isThinking(p.thinking) ? p.thinking : "default",
    max_output_tokens: limit(p.max_output_tokens),
    context_budget: budget !== null && budget >= 0 ? Math.floor(budget) : 150000,
    auxiliary_model: text(p.auxiliary_model),
    auxiliary_temperature: temperature(p.auxiliary_temperature),
    auxiliary_thinking: isThinking(p.auxiliary_thinking) ? p.auxiliary_thinking : "default",
    auxiliary_max_output_tokens: limit(p.auxiliary_max_output_tokens),
    auxiliary_max_input_tokens: limit(p.auxiliary_max_input_tokens),
    image_model: text(p.image_model),
    start_mode: startMode(p.start_mode),
    web_search: p.web_search === true,
    web_fetch: p.web_fetch === true,
    starter,
    starter_notes: Array.isArray(p.starter_notes) ? p.starter_notes.filter((x): x is string => typeof x === "string") : [],
    builtin: false,
  };
}

function presetExists(id: string): boolean {
  return !!db().presets[id] || !!builtinPreset(id);
}

function newPresetId(): string {
  const st = db();
  let id = "";
  do id = `preset-${++st.counter}`;
  while (presetExists(id));
  return id;
}

function requirePreset(id: string): Preset {
  if (!presetExists(id)) throw new ApiError(404, `그런 프리셋이 없습니다: ${id}`);
  return getPreset(db(), id);
}

/* ───────── 그 밖의 도우미 ───────── */

function folderPath(folder: string | undefined, fallback: string): string {
  const f = norm(folder ?? "");
  if (!f) return `자료/${fallback}`;
  return f === "자료" || f.startsWith("자료/") ? f : `자료/${f}`;
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    } catch {
      resolve("");
    }
  });
}

function dropBlob(sessionId: string, path: string): void {
  const key = blobKey(sessionId, path);
  const url = blobUrls.get(key);
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* 무시 */
  }
  blobUrls.delete(key);
}

function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ensureNotRunning(s: FakeSession, what: string): void {
  if (isRunning(s.id)) throw new ApiError(409, `실행 중에는 ${what} 수 없습니다`);
}

/** 제작 기록: 모든 대화의 이벤트를 시간 순서로, 읽기 좋은 마크다운으로. */
function processLog(s: FakeSession): string {
  const lines: string[] = [`# 제작 기록: ${s.name}`, ""];
  const time = (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    const two = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${two(d.getHours())}:${two(d.getMinutes())}`;
  };
  const modeName = (id?: string) => META.modes.find((m) => m.id === id)?.label ?? id ?? "";
  const asked = new Map<string, RunEvent>();
  let n = 0;
  for (const e of allEvents(s)) {
    switch (e.type) {
      case "run_started":
        lines.push(`## ${++n}. ${time(e.timestamp)} · ${e.kind === "tool" ? "도구를 직접 실행" : `에이전트 (${modeName(e.mode)}, ${e.agent_model ?? ""})`}`, "");
        break;
      case "user_message":
        if (e.in_reply_to) {
          const q = asked.get(e.in_reply_to);
          lines.push(`- 내 답${q?.kind === "question" ? "" : ` (${q?.kind === "tool_confirm" ? "도구 실행 확인" : "문서 변경 확인"})`}: ${e.text ?? ""}`);
        } else lines.push(`**나**: ${e.tool ? `/${e.tool} ` : ""}${e.text ?? ""}`, "");
        break;
      case "text":
        if (lines[lines.length - 1] !== "") lines.push("");
        lines.push(`**에이전트**: ${e.text ?? ""}`, "");
        break;
      case "tool_call":
        lines.push(`- 도구 \`${e.tool}\` (${e.label ?? agentToolLabel(e.tool ?? "")})${e.user_tool ? " — 입력을 읽고 출력에 씁니다" : ""}`);
        break;
      case "tool_result":
        lines.push(`  - ${e.ok === false ? "실패" : "결과"}: ${e.result ?? ""}${e.changed?.length ? ` [바뀐 문서: ${e.changed.join(", ")}]` : ""}`);
        break;
      case "user_input_required":
        if (e.event_id) asked.set(e.event_id, e);
        lines.push(`- ${e.kind === "question" ? `질문: ${e.question ?? ""}` : e.kind === "tool_confirm" ? `확인 요청 (도구 실행): ${e.label ?? e.tool ?? ""}` : `확인 요청 (문서 변경): ${e.description ?? ""}`}`);
        break;
      case "compaction":
        lines.push(`- 대화 앞부분 ${e.dropped_messages ?? "?"}개를 요약으로 바꿨습니다.`);
        break;
      case "error":
        lines.push(`- 오류: ${e.error ?? ""}`);
        break;
      case "done":
        if (lines[lines.length - 1] !== "") lines.push("");
        lines.push(`끝: ${e.status ?? ""} · 도구 ${e.total_tool_calls ?? 0}번 · ${e.elapsed_sec ?? 0}초 · 컨텍스트 ${(e.usage?.context_tokens ?? 0).toLocaleString()} 토큰`, "");
        break;
      default:
        break;
    }
  }
  if (!n) lines.push("아직 실행한 것이 없습니다.");
  return lines.join("\n");
}

/* ───────── 폰트와 화면 설정 ───────── */

/*
 * 올린 폰트는 이 창이 열려 있는 동안만 남는다 (파일을 메모리의 주소로만 들고 있다).
 * 화면 설정은 localStorage에 따로 둔다. 가짜의 다른 상태와 섞지 않아서 `__alephFakeReset`에도 남는다.
 */
const fakeFonts: FontFile[] = [];
const APPEARANCE_KEY = "aleph-fake-appearance";
const FONT_FORMAT: Record<string, FontFile["format"]> = { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" };
const WEIGHT_NAMES: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/bold/i, 700],
  [/black|heavy/i, 900],
];

/** 가짜는 파일을 열어 보지 않는다. 이름(`MaruBuri-Bold.woff2`)에서 폰트 이름과 굵기를 어림한다. */
function fakeFont(file: File): FontFile {
  const name = norm(file.name).split("/").pop() || "";
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (ext === "ttc") throw new ApiError(400, "여러 폰트를 묶은 파일(ttc)은 받지 않습니다");
  const format = FONT_FORMAT[ext];
  if (!format) throw new ApiError(400, "폰트 파일이 아니다 (ttf, otf, woff, woff2)");
  const stem = name.replace(/\.[^.]+$/, "");
  const cut = stem.search(/[-_ ](thin|hairline|extra|ultra|light|regular|medium|semi|demi|bold|black|heavy|italic|variable|vf)/i);
  const family = (cut > 0 ? stem.slice(0, cut) : stem).trim() || stem;
  const style = cut > 0 ? stem.slice(cut + 1) : "Regular";
  const variable = /variable|vf|\[wght\]/i.test(stem);
  const weight = WEIGHT_NAMES.find(([re]) => re.test(style))?.[1] ?? 400;
  return {
    id: `font-${Date.now().toString(36)}-${fakeFonts.length}`,
    family,
    style,
    weight: variable ? [100, 900] : [weight, weight],
    italic: /italic|oblique/i.test(style),
    format,
    size: file.size,
    file: name,
    url: URL.createObjectURL(file),
  };
}

function readAppearance(): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/* ───────── API ───────── */

export const fakeApi: Api = {
  meta: () => call(() => META),

  providers: () => call(() => db().providers.map(settle)),
  saveProvider: (id, body) => call(() => saveProvider(id, body)),
  clearProviderKey: (id) =>
    call(() => {
      const p = findProvider(id);
      p.has_key = false;
      p.secrets = {};
      return settle(p);
    }),
  deleteProvider: (id) =>
    call(() => {
      findProvider(id);
      const st = db();
      st.providers = st.providers.filter((p) => p.id !== id);
      return { status: "deleted" };
    }),
  models: (id) =>
    call(() => {
      const p = settle(findProvider(id));
      if (!p.ready) return { models: [], error: "제공자가 준비되지 않았습니다. 키를 넣고 켜야 모델 목록을 받을 수 있습니다." };
      return { models: MODELS[p.kind] ?? [], error: null };
    }),

  fonts: async () =>
    clone([...fakeFonts].sort((a, b) => a.family.localeCompare(b.family) || a.weight[0] - b.weight[0] || Number(a.italic) - Number(b.italic))),
  uploadFont: async (file) => {
    // 같은 파일을 다시 올리면 있던 것이 온다.
    const again = fakeFonts.find((f) => f.file === file.name && f.size === file.size);
    if (again) return clone(again);
    const font = fakeFont(file);
    fakeFonts.push(font);
    return clone(font);
  },
  deleteFont: async (id) => {
    const at = fakeFonts.findIndex((f) => f.id === id);
    if (at === -1) throw new ApiError(404, "그런 폰트가 없습니다");
    URL.revokeObjectURL(fakeFonts[at].url);
    fakeFonts.splice(at, 1);
    return { status: "ok" };
  },
  appearance: async () => readAppearance(),
  saveAppearance: async (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "객체가 아니다");
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(value));
    } catch {
      /* 저장소를 못 쓰는 브라우저 */
    }
    return clone(value);
  },

  presets: () => call(() => presetSummaries(db())),
  preset: (id) => call(() => requirePreset(id)),
  savePreset: (p) =>
    call(() => {
      const id = text(p?.id).trim();
      if (!id) throw new ApiError(400, "프리셋 id가 비어 있습니다");
      // 도구의 영문 이름은 엔진처럼 거절한다 (가져온 파일은 아래 cleanTools가 말없이 다듬는다).
      const seen = new Set<string>();
      for (const t of Array.isArray(p?.tools) ? p.tools : []) {
        const name = text(t?.name);
        if (!/^[a-z][a-z0-9_]{1,48}$/.test(name)) throw new ApiError(422, `도구 이름 '${name}'은 쓸 수 없습니다. 소문자로 시작하고 소문자·숫자·_만, 2~49자여야 합니다`);
        if (META.agent_tools.some((a) => a.name === name)) throw new ApiError(400, `'${name}'은 기본 도구의 이름입니다`);
        if (seen.has(name)) throw new ApiError(400, `도구 이름이 겹칩니다: ${name}`);
        seen.add(name);
      }
      // 기본 제공본을 고치면 같은 id의 사용자본이 생긴다.
      const saved = cleanPreset(p, id);
      db().presets[id] = saved;
      return saved;
    }),
  patchPreset: (id, patch) =>
    call(() => {
      const merged = cleanPreset({ ...requirePreset(id), ...patch }, id);
      const refused = Object.keys(patch ?? {}).filter((k) => k === "id" || k === "builtin" || !(k in merged));
      if (refused.length) throw new ApiError(400, `고칠 수 없는 칸입니다: ${refused.join(", ")}`);
      db().presets[id] = merged;
      return merged;
    }),
  deletePreset: (id) =>
    call((): { status: "deleted" | "reverted" } => {
      const st = db();
      if (!presetExists(id)) throw new ApiError(404, `그런 프리셋이 없습니다: ${id}`);
      delete st.presets[id];
      if (builtinPreset(id)) return { status: "reverted" };
      // 지워진 프리셋을 쓰던 작업은 기본 프리셋으로 돌린다.
      for (const s of st.sessions) if (s.state.preset_id === id) s.state.preset_id = "basic";
      return { status: "deleted" };
    }),
  duplicatePreset: (id, name) =>
    call(() => {
      const source = requirePreset(id);
      const copy: Preset = { ...source, id: newPresetId(), name: name?.trim() || `${source.name} 사본`, builtin: false };
      db().presets[copy.id] = copy;
      return copy;
    }),
  // 실제 파일은 zip이지만 가짜는 같은 확장자의 JSON 한 덩어리로 주고받는다 (가짜끼리만 통한다).
  exportPreset: async (id) => {
    const preset = requirePreset(id);
    const body = { app: "ALEPH", kind: "preset", format: 1, name: preset.name, preset };
    downloadBlob(`${fileName(preset.name)}.alephpreset`, new Blob([JSON.stringify(body)], { type: "application/octet-stream" }));
  },

  sessions: () =>
    call(() =>
      db().sessions.map((s) => ({
        id: s.id,
        name: s.name,
        created_at: s.created_at,
        updated_at: lastChanged(s),
        running: isRunning(s.id),
        preset_id: s.state.preset_id,
        chars: manuscriptChars(s),
        materials: Object.keys(s.materials).length,
      })),
    ),
  createSession: (name, preset_id) =>
    call(() => {
      const st = db();
      const title = String(name ?? "").trim();
      if (!title) throw new ApiError(400, "작업 이름이 비어 있습니다");
      if (preset_id && !presetExists(preset_id)) throw new ApiError(404, `그런 프리셋이 없습니다: ${preset_id}`);
      const s = newSession(st, `fake-${++st.counter}`, title, preset_id || "basic");
      st.sessions.unshift(s);
      return { id: s.id, name: s.name, created_at: s.created_at };
    }),
  renameSession: (id, name) =>
    call(() => {
      const title = String(name ?? "").trim();
      if (!title) throw new ApiError(400, "작업 이름이 비어 있습니다");
      session(id).name = title;
      return { id, name: title };
    }),
  deleteSession: (id) =>
    call(() => {
      const s = session(id);
      ensureNotRunning(s, "작업을 지울");
      for (const path of Object.keys(s.materials)) dropBlob(id, path);
      const st = db();
      st.sessions = st.sessions.filter((x) => x.id !== id);
      return { status: "deleted" };
    }),

  state: (id) => call(() => sessionState(db(), session(id))),
  saveState: (id, patch: Partial<SessionState>) =>
    call(() => {
      const s = session(id);
      if (patch.preset_id !== undefined) {
        if (!presetExists(patch.preset_id)) throw new ApiError(404, `그런 프리셋이 없습니다: ${patch.preset_id}`);
        s.state.preset_id = patch.preset_id;
      }
      if (patch.mode !== undefined) {
        if (!META.modes.some((m) => m.id === patch.mode)) throw new ApiError(400, `모르는 진행 방식입니다: ${patch.mode}`);
        s.state.mode = patch.mode;
      }
      if (patch.bypass_locks !== undefined) s.state.bypass_locks = !!patch.bypass_locks;
      if (patch.auto_compact !== undefined) s.state.auto_compact = !!patch.auto_compact;
      // 없는 대화를 가리키면 보던 대화를 그대로 본다.
      const viewed = patch.conversation;
      if (viewed !== undefined && s.conversations.some((c) => c.id === viewed)) s.state.conversation = viewed;
      return sessionState(db(), s);
    }),
  workspace: (id, conversation) =>
    call(() => {
      const s = session(id);
      return buildWorkspace(db(), s, conversationOf(s, conversation));
    }),

  conversations: (id) =>
    call(() => {
      const s = session(id);
      reconcile(s);
      return conversationList(s);
    }),
  createConversation: (id, name) =>
    call(() => {
      const s = session(id);
      return conversationView(s, createConversation(s, name));
    }),
  renameConversation: (id, conversation, name) =>
    call(() => {
      const s = session(id);
      reconcile(s);
      return conversationView(s, renameConversation(s, conversation, String(name ?? "")));
    }),
  deleteConversation: (id, conversation) =>
    call(() => {
      const s = session(id);
      const conv = conversationOf(s, conversation);
      // 다른 대화에서 도는 중이면 지울 수 있다.
      if (isRunning(id) && s.run.conversation_id === conv.id) throw new ApiError(409, "실행 중인 대화는 지울 수 없습니다. 먼저 중단해야 합니다");
      deleteConversation(s, conv.id);
      return conversationList(s);
    }),

  doc: (id, path) => call(() => readDoc(session(id), path)),
  saveDoc: (id, path, content) => call(() => writeDoc(session(id), path, String(content ?? ""), "user")),
  addFolder: (id, path) => call(() => ({ path: addFolder(session(id), path) })),
  deleteDoc: (id, path) =>
    call(() => {
      const removed = deleteDoc(session(id), path, "user");
      for (const p of removed) dropBlob(id, p);
      return { deleted: removed };
    }),
  moveDoc: (id, source, destination) =>
    call(() => {
      const { path, moved } = moveDoc(session(id), source, destination, "user");
      for (const [from, to] of moved) {
        const url = blobUrls.get(blobKey(id, from));
        if (url) {
          blobUrls.delete(blobKey(id, from));
          blobUrls.set(blobKey(id, to), url);
        }
      }
      return { path };
    }),
  setFlags: (id, path, flags: FlagPatch) =>
    call(() => {
      setFlags(session(id), path, flags);
      return { path };
    }),
  history: (id, path) => call(() => historyOf(session(id), path)),
  version: (id, hash) =>
    call(() => {
      const content = session(id).versions[hash];
      if (content === undefined) throw new ApiError(404, "그 버전을 찾지 못했습니다");
      return content;
    }),
  restore: (id, path, hash) => call(() => restore(session(id), path, hash, "user")),
  resolve: (id, ref) => call(() => resolveRef(session(id), ref)),

  fileUrl: (id, path) => {
    const s = db().sessions.find((x) => x.id === id);
    const t = s ? locate(s, path) : null;
    if (!s || !t || t.type !== "material") return "";
    const m = s.materials[t.path];
    if (m.data) return m.data;
    const blob = blobUrls.get(blobKey(id, t.path));
    if (blob) return blob;
    return m.kind === "text" ? `data:text/plain;charset=utf-8,${encodeURIComponent(m.content)}` : "";
  },

  upload: async (id, file, folder): Promise<UploadResult> => {
    const s = session(id);
    const name = norm(file.name).split("/").pop() || "이름 없음";
    const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

    if (ext === "txt" || ext === "md") {
      const content = (await file.text()).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
      if (!content.trim()) throw new ApiError(422, "글이 들어 있지 않은 파일입니다");
      const path = uniquePath(s, `${folderPath(folder, "올린 글")}/${name.replace(/\.[^.]+$/, "")}.md`);
      writeDoc(s, path, content, "user");
      save();
      return { path, kind: "text", chars: content.length, note: "" };
    }

    if (IMAGE_EXT.test(name)) {
      const path = uniquePath(s, `${folderPath(folder, "삽화")}/${name}`);
      // 작은 이미지는 새로고침해도 남게 글자로 바꿔 두고, 큰 것은 이 창이 열려 있는 동안만 쓸 주소로 둔다.
      const data = file.size <= 200_000 ? await toDataUrl(file) : "";
      if (!data) blobUrls.set(blobKey(id, path), URL.createObjectURL(file));
      s.materials[path] = { kind: "image", content: "", data, size: file.size, updated_at: now(), by: "user" };
      record(s, "write", path, "", "user");
      save();
      return { path, kind: "image", chars: 0, note: "" };
    }

    throw new ApiError(422, "가짜에서는 txt·md·이미지만 올릴 수 있습니다");
  },

  addScene: (id, body: NewScene) => call(() => addScene(session(id), body ?? {}, "user")),
  patchScene: (id, scene, body) =>
    call(() => {
      patchScene(session(id), scene, body ?? {});
      return { id: scene };
    }),
  moveScene: (id, scene, to) =>
    call(() => {
      moveScene(session(id), scene, to);
      return { id: scene };
    }),
  splitScene: (id, scene, at) => call(() => splitScene(session(id), scene, Array.isArray(at) ? at : [], "user")),
  mergeScenes: (id, scenes) => call(() => mergeScenes(session(id), Array.isArray(scenes) ? scenes : [], "user")),
  deleteScene: (id, scene) =>
    call(() => {
      deleteScene(session(id), scene, "user");
      return { id: scene };
    }),
  addChapter: (id, body) => call(() => ({ id: createChapter(session(id), body ?? {}).id })),
  patchChapter: (id, chapter, body) =>
    call(() => {
      patchChapter(session(id), chapter, body ?? {});
      return { id: chapter };
    }),
  moveChapter: (id, chapter, after) =>
    call(() => {
      moveChapter(session(id), chapter, after ?? null);
      return { id: chapter };
    }),
  deleteChapter: (id, chapter) =>
    call(() => {
      deleteChapter(session(id), chapter);
      return { id: chapter };
    }),
  exportFile: async (id, format: ExportFormat, options) => {
    const s = session(id);
    // html과 zip은 가짜에서 만들지 않는다. 마크다운으로 대신하고 그 사실을 파일 이름에 적는다.
    const real = format === "txt" ? "txt" : "md";
    const filename = format === real ? `${s.name}.${real}` : `${s.name} (가짜라서 ${format} 대신 md).md`;
    downloadBlob(filename, new Blob([exportText(s, real, options?.chapters !== false)], { type: `${real === "txt" ? "text/plain" : "text/markdown"};charset=utf-8` }));
  },

  toolRuns: (id) => call(() => session(id).toolRuns),
  // 가짜는 지운 것의 목록을 두지 않는다.
  deleted: () => call(() => []),
  startRun: (id, body) => call(() => startRun(id, body ?? { goal: "" })),
  // 가짜는 시험 실행과 입력 다시 쓰기, 모델 바꿔 돌리기를 흉내 내지 않는다. 대화만 본다.
  runTool: (id, name, body) => call(() => runTool(id, name, body?.conversation)),
  compact: (id, conversation) => call(() => compact(id, conversation)),
  // v0.2 뒤에 더해진 것은 가짜에 없다. 시연 서버에 붙여서 본다.
  lastRun: () => call(() => ({ run_id: null, revertible: false, reason: "가짜 API에는 없습니다", changes: [], touched_later: [] })),
  revertRun: () => call(() => fail501()),
  steer: () => call(() => fail501()),
  exportArchive: async (id) => {
    const s = session(id);
    ensureNotRunning(s, "내보낼");
    const body = { app: "ALEPH", kind: "work", format: 1, name: s.name, session: s, preset: db().presets[s.state.preset_id] ?? null };
    downloadBlob(`${fileName(s.name)}.aleph`, new Blob([JSON.stringify(body)], { type: "application/octet-stream" }));
  },
  importFile: async (file) => {
    let raw: any;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new ApiError(400, "ALEPH에서 내보낸 파일이 아니다.");
    }
    if (raw?.app !== "ALEPH" || (raw.kind !== "work" && raw.kind !== "preset")) throw new ApiError(400, "ALEPH에서 내보낸 파일이 아니다.");
    return call<Imported>(() => {
      const st = db();
      const presetNames = () => Object.values(st.presets).map((p) => p.name);
      if (raw.kind === "preset") {
        // 프리셋은 언제나 새 id로 들어온다. 같은 이름이 있으면 번호를 붙인다.
        const preset = cleanPreset({ ...raw.preset, name: freeName(text(raw.preset?.name).trim() || "가져온 프리셋", presetNames(), " ") }, newPresetId());
        st.presets[preset.id] = preset;
        return { kind: "preset", preset };
      }
      // 그 작업이 쓰던 프리셋이 여기 없으면 같이 들인다. 같은 id가 있으면 있는 것을 쓴다.
      const presetId = text(raw.session?.state?.preset_id) || "basic";
      if (raw.preset && !presetExists(presetId)) st.presets[presetId] = cleanPreset(raw.preset, presetId);
      const name = freeName(text(raw.name).trim() || "가져온 작업", st.sessions.map((s) => s.name), " (가져옴)");
      const kept = presetExists(presetId) ? presetId : "basic";
      const rest = clone(raw.session);
      const conversations: FakeSession["conversations"] =
        Array.isArray(rest.conversations) && rest.conversations.length ? rest.conversations : [newConversation(MAIN)];
      const viewed = text(rest.state?.conversation);
      // 작업의 상태는 아는 칸만 남긴다.
      const state: FakeSession["state"] = {
        preset_id: kept,
        mode: META.modes.find((m) => m.id === rest.state?.mode)?.id ?? "auto",
        bypass_locks: rest.state?.bypass_locks === true,
        auto_compact: rest.state?.auto_compact !== false,
        conversation: conversations.some((c) => c.id === viewed) ? viewed : conversations[conversations.length - 1].id,
      };
      // 들여온 작업에서 도는 실행은 없다.
      const run: FakeSession["run"] = { run_id: null, conversation_id: null, running: false, status: "", waiting: false };
      const copy: FakeSession = { ...rest, id: `fake-${++st.counter}`, name, state, conversations, run };
      st.sessions.unshift(copy);
      return { kind: "work", id: copy.id, name, preset_id: kept };
    });
  },
  search: () => call(() => ({ hits: [], truncated: false })),
  usage: () =>
    call(() => ({
      runs: 0,
      agent: { prompt_tokens: 0, output_tokens: 0, cost_usd: null },
      tools: [],
      auxiliary: { calls: 0, total_tokens: 0, cost_usd: null },
      total_cost_usd: null,
      cost_complete: true,
    })),
  events: (id, conversation) =>
    call(() => {
      const s = session(id);
      const conv = conversationOf(s, conversation);
      reconcile(s);
      const running = isRunning(id);
      return {
        conversation_id: conv.id,
        events: conv.events,
        // 실행은 작업의 것이라, 지금 받는 대화가 아닌 다른 대화의 것일 수 있다.
        run: {
          running,
          run_id: s.run.run_id,
          conversation_id: s.run.conversation_id ?? undefined,
          status: s.run.status || undefined,
          waiting_for_user: running && s.run.waiting,
        },
      };
    }),
  subscribe: (id, onEvent, onEnd) => subscribe(id, onEvent, onEnd),
  respond: (id, event_id, response) =>
    call(() => {
      respond(id, event_id, String(response ?? ""));
      return { ok: true };
    }),
  stopRun: (id) => call(() => ({ stopped: stopRun(id) })),
  processLog: (id) =>
    call(() => {
      const s = session(id);
      return { content: processLog(s), session_name: s.name };
    }),
};

declare global {
  interface Window {
    /** 가짜 API를 처음 상태로 돌리고 화면을 새로 읽는다. */
    __alephFakeReset?: () => void;
  }
}

if (typeof window !== "undefined") {
  window.__alephFakeReset = () => {
    stopAll();
    reset();
    saveNow();
    try {
      window.location.reload();
    } catch {
      /* 창이 아닌 곳에서는 상태만 되돌린다 */
    }
  };
}
