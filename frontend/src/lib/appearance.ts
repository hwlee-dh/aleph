import { create } from "zustand";
import { api } from "./api";
import type { FontFile } from "./types";
import { useStore } from "../store";

/*
 * 화면 설정: 자리마다의 폰트, 본문의 글자 크기·줄 간격·너비, 글의 종류별 모양.
 * 엔진은 내용을 보지 않고 맡아 두기만 한다 (`GET`·`PUT /appearance`, API.md 9.8). 모양은 여기서 정한다.
 *
 * 적용은 CSS로만 한다. <style id="aleph-appearance"> 하나에 올린 폰트의 @font-face와, 기본값에서 달라진 것만 적는다.
 * 아무것도 고치지 않았으면 이 <style>은 비어 있고, 화면은 index.css에 적힌 그대로다.
 *
 * 이 파일은 main.tsx가 불러오는 순간에 지난번 설정(localStorage에 적어 둔 것)을 먼저 입힌다.
 * 서버의 답을 기다렸다 입히면 첫 화면이 기본 폰트로 그려졌다가 바뀌어 번쩍인다.
 */

/* ───────── 모양 ───────── */

/** 폰트를 따로 정하는 자리. */
export type Slot = "system" | "title" | "body";
/** 따로 꾸미는 글의 종류. */
export type Kind = "normal" | "bold" | "italic" | "dquote" | "squote";

/** 폰트는 이름(font-family)으로 가리킨다. null은 "따로 정하지 않음"이다. 색은 `#rrggbb`. */
export interface KindStyle {
  font: string | null;
  color: string | null;
}

export interface Appearance {
  version: 1;
  /**
   * system: 메뉴·버튼·대화.
   * title: 본문에 글로 적은 제목 줄(`# …`, `## …`, `### …`)과 원고 화면의 장 머리("1장").
   *        null이면 제목 줄은 본문과 똑같이, 장 머리는 시스템 폰트로 보인다.
   * body: 원고와 출력.
   */
  fonts: Record<Slot, string | null>;
  body: {
    size: number; // px
    line_height: number; // 배수
    width: number; // px. 원고 화면의 글 폭 (양옆 여백 포함)
  };
  kinds: {
    normal: KindStyle;
    /** heavy: `**…**`를 두껍게 그린다. */
    bold: KindStyle & { heavy: boolean };
    /** slant: `*…*`를 눕혀 그린다. 한글 폰트는 기울임꼴이 없어 브라우저가 억지로 눕히므로 끌 수 있다. */
    italic: KindStyle & { slant: boolean };
    dquote: KindStyle;
    squote: KindStyle;
  };
}

export const BODY_LIMITS = { size: [10, 40], line_height: [1, 4], width: [360, 2000] } as const;

/** 기본값. 종류별 모양은 전부 "본문과 같음"이고 굵게·기울임도 꾸미지 않는다. */
export const DEFAULTS: Appearance = {
  version: 1,
  fonts: { system: null, title: null, body: null },
  body: { size: 16.5, line_height: 2, width: 720 },
  kinds: {
    normal: { font: null, color: null },
    bold: { font: null, color: null, heavy: false },
    italic: { font: null, color: null, slant: false },
    dquote: { font: null, color: null },
    squote: { font: null, color: null },
  },
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const fontName = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const color = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
const within = (v: unknown, [min, max]: readonly [number, number], fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** 저장돼 있던 것을 읽는다. 빠졌거나 이상한 값은 기본값으로 본다. */
export function readAppearance(raw: unknown): Appearance {
  const r = obj(raw);
  const fonts = obj(r.fonts);
  const body = obj(r.body);
  const kinds = obj(r.kinds);
  const kind = (name: Kind): KindStyle => ({ font: fontName(obj(kinds[name]).font), color: color(obj(kinds[name]).color) });
  return {
    version: 1,
    fonts: { system: fontName(fonts.system), title: fontName(fonts.title), body: fontName(fonts.body) },
    body: {
      size: within(body.size, BODY_LIMITS.size, DEFAULTS.body.size),
      line_height: within(body.line_height, BODY_LIMITS.line_height, DEFAULTS.body.line_height),
      width: within(body.width, BODY_LIMITS.width, DEFAULTS.body.width),
    },
    kinds: {
      normal: kind("normal"),
      bold: { ...kind("bold"), heavy: obj(kinds.bold).heavy === true },
      italic: { ...kind("italic"), slant: obj(kinds.italic).slant === true },
      dquote: kind("dquote"),
      squote: kind("squote"),
    },
  };
}

/**
 * 저장할 모양으로. 받아 온 것(raw) 위에 우리가 아는 키만 덮어쓴다.
 * 모르는 키(다른 판의 화면이 적어 둔 것)는 어느 깊이에 있든 그대로 둔다.
 */
function writeAppearance(raw: Raw, value: Appearance): Raw {
  const kinds = obj(raw.kinds);
  const merged: Raw = { ...kinds };
  for (const name of Object.keys(value.kinds) as Kind[]) merged[name] = { ...obj(kinds[name]), ...value.kinds[name] };
  return {
    ...raw,
    // 더 새 판이 적어 둔 것이면 그 번호를 낮추지 않는다.
    version: typeof raw.version === "number" && raw.version > 1 ? raw.version : 1,
    fonts: { ...obj(raw.fonts), ...value.fonts },
    body: { ...obj(raw.body), ...value.body },
    kinds: merged,
  };
}

/* ───────── 묶음에 든 폰트 ───────── */

interface BuiltinFont {
  family: string;
  label: string;
  /** 처음부터 싣지 않는 폰트는 고른 뒤에 CSS를 불러온다 (첫 화면이 무거워지지 않게). */
  load?: () => Promise<unknown>;
}

/** 만드는 곳은 scripts/fonts.mjs. 거기에 더하면 여기에도 더한다. */
export const BUILTIN: BuiltinFont[] = [
  { family: "Noto Sans KR", label: "Noto Sans KR" },
  { family: "Noto Serif KR", label: "Noto Serif KR" },
  { family: "Gowun Batang", label: "고운바탕", load: () => import("../fonts/gowun-batang.css") },
  { family: "Pretendard", label: "Pretendard", load: () => import("../fonts/pretendard.css") },
];

/** 자리마다의 기본 폰트와 그 뒤에 붙는 대체 폰트. index.css의 @theme와 같아야 한다. */
const SANS = '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';
const SERIF = '"Noto Serif KR", "Nanum Myeongjo", "Batang", "AppleMyungjo", serif';

/** CSS에 적을 폰트 이름. */
export const cssFamily = (family: string) => `"${family.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, " ")}"`;

/* ───────── 적용 ───────── */

const loading = new Set<string>();

/** 그 이름의 폰트가 지금 있는가 (묶음에 들었거나 올려 두었거나). 지운 폰트를 가리키는 설정은 기본 폰트로 보인다. */
function usable(family: string | null, fonts: FontFile[]): family is string {
  if (!family) return false;
  const builtin = BUILTIN.find((b) => b.family === family);
  if (builtin?.load && !loading.has(family)) {
    loading.add(family);
    // 못 불러오면 다음에 다시 해 본다. 그동안은 뒤에 붙은 대체 폰트로 보인다.
    builtin.load().catch(() => loading.delete(family));
  }
  return !!builtin || fonts.some((f) => f.family === family);
}

function fontFaces(fonts: FontFile[]): string[] {
  return fonts.map((f) => {
    const weight = f.weight[0] === f.weight[1] ? String(f.weight[0]) : `${f.weight[0]} ${f.weight[1]}`;
    return `@font-face{font-family:${cssFamily(f.family)};src:url(${JSON.stringify(f.url)}) format("${f.format}");font-weight:${weight};font-style:${f.italic ? "italic" : "normal"};font-display:swap}`;
  });
}

/** 설정을 CSS로 옮긴다. 기본값과 같은 것은 적지 않는다. */
function appearanceCss(value: Appearance, fonts: FontFile[]): string {
  const css = fontFaces(fonts);
  const { system, title, body } = value.fonts;
  const vars: string[] = [];
  if (usable(system, fonts)) vars.push(`--font-sans:${cssFamily(system)}, ${SANS}`);
  const titled = usable(title, fonts);
  if (titled) vars.push(`--font-title:${cssFamily(title)}, var(--font-sans)`);
  if (usable(body, fonts)) {
    vars.push(`--font-body:${cssFamily(body)}, ${SERIF}`);
    // 오른쪽 패널의 작은 출력 칸은 기본이 고딕이다. 본문 폰트를 골랐을 때만 그것을 따른다.
    vars.push("--font-body-side:var(--font-body)");
  }
  if (value.body.size !== DEFAULTS.body.size) vars.push(`--body-size:${value.body.size}px`);
  if (value.body.line_height !== DEFAULTS.body.line_height) vars.push(`--body-leading:${value.body.line_height}`);
  if (value.body.width !== DEFAULTS.body.width) vars.push(`--body-width:${value.body.width}px`);
  if (vars.length) css.push(`:root{${vars.join(";")}}`);

  const rule = (selector: string, style: KindStyle, extra = "") => {
    const lines = [extra];
    if (usable(style.font, fonts)) lines.push(`font-family:${cssFamily(style.font)}, var(--font-body)`);
    if (style.color) lines.push(`color:${style.color}`);
    const text = lines.filter(Boolean).join(";");
    if (text) css.push(`${selector}{${text}}`);
  };
  const k = value.kinds;
  // 편집기의 기본 모양(CodeMirror가 넣는 클래스 하나짜리 규칙)을 이기도록 :root를 붙인다.
  rule(":root .tk-text", k.normal);
  // 제목 줄은 제목 폰트를 골랐을 때만 달라진다 (그 폰트로, 굵게). 고르지 않았으면 본문과 똑같다.
  if (titled) css.push(`.tk-h{font-family:${cssFamily(title)}, var(--font-body);font-weight:700}`);
  // 겹쳤을 때는 뒤에 적힌 것이 이긴다: 따옴표 < 기울임 < 굵게.
  rule(".tk-dq", k.dquote);
  rule(".tk-sq", k.squote);
  rule(".tk-i", k.italic, k.italic.slant ? "font-style:italic" : "");
  rule(".tk-b", k.bold, k.bold.heavy ? "font-weight:700" : "");
  return css.join("\n");
}

/** 굵게·기울임·따옴표·제목 줄 가운데 꾸미는 것이 하나라도 있는가. 없으면 글을 조각내지 않는다. */
function kindsActive(value: Appearance): boolean {
  const { bold, italic, dquote, squote } = value.kinds;
  return !!value.fonts.title || bold.heavy || italic.slant || [bold, italic, dquote, squote].some((s) => !!s.font || !!s.color);
}

function apply(value: Appearance, fonts: FontFile[]): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById("aleph-appearance") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "aleph-appearance";
    document.head.appendChild(style);
  }
  const css = appearanceCss(value, fonts);
  if (style.textContent !== css) style.textContent = css;
}

/* ───────── 지난번 설정 (번쩍임 막기) ───────── */

const LS = "aleph.appearance";

function recall(): { raw: Raw; fonts: FontFile[] } {
  try {
    const saved = obj(JSON.parse(localStorage.getItem(LS) ?? "{}"));
    return { raw: obj(saved.raw), fonts: Array.isArray(saved.fonts) ? (saved.fonts as FontFile[]) : [] };
  } catch {
    return { raw: {}, fonts: [] };
  }
}

function remember(raw: Raw, fonts: FontFile[]): void {
  try {
    localStorage.setItem(LS, JSON.stringify({ raw, fonts }));
  } catch {
    /* 저장소를 못 쓰는 브라우저 */
  }
}

/* ───────── 상태 ───────── */

export interface UploadFailure {
  name: string;
  error: string;
}

interface AppearanceState {
  /** 서버에 있는 그대로. 모르는 키를 지키려고 들고 있다. */
  raw: Raw;
  value: Appearance;
  /** 사용자가 올린 폰트 파일들. */
  fonts: FontFile[];
  kindsActive: boolean;

  /** 서버에서 설정과 폰트 목록을 읽어 입힌다. 앱을 켤 때 한 번. */
  load: () => Promise<void>;
  /** 고친다. 바로 보이고, 잠깐 뒤에 저장된다. */
  edit: (change: (value: Appearance) => Appearance) => void;
  setFont: (slot: Slot, family: string | null) => void;
  setBody: (patch: Partial<Appearance["body"]>) => void;
  setKind: <K extends Kind>(kind: K, patch: Partial<Appearance["kinds"][K]>) => void;
  /** 전부 기본값으로. 올린 폰트는 그대로 둔다. */
  reset: () => void;
  /** 폰트 파일들을 올린다. 거절된 것은 서버가 준 이유와 함께 돌려준다. */
  upload: (files: File[]) => Promise<UploadFailure[]>;
  /** 그 이름의 폰트(파일 전부)를 지운다. 그 폰트를 쓰던 설정은 그대로 두고, 화면은 기본 폰트로 보인다. */
  removeFamily: (family: string) => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false; // 아직 서버에 보내지 않은 변경이 있다
let edits = 0;

export const useAppearance = create<AppearanceState>((set, get) => {
  const saved = recall();
  const first = readAppearance(saved.raw);
  apply(first, saved.fonts);

  const show = (value: Appearance, fonts: FontFile[], raw = get().raw) => {
    apply(value, fonts);
    set({ value, fonts, raw, kindsActive: kindsActive(value) });
  };

  const flush = async () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!dirty) return;
    dirty = false;
    const at = edits;
    const { raw, value, fonts } = get();
    const next = writeAppearance(raw, value);
    remember(next, fonts);
    try {
      const stored = await api.saveAppearance(next);
      // 저장하는 사이에 더 고쳤으면 화면의 값을 그대로 둔다 (곧 다시 저장된다).
      if (at === edits) set({ raw: obj(stored) });
    } catch (e) {
      dirty = true;
      notifyFailure(e);
    }
  };

  // 고치고 곧바로 창을 닫아도 남게, 저장을 기다리던 것을 떠나는 길에 보낸다.
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flush());

  const refreshFonts = async () => {
    const fonts = await api.fonts();
    show(get().value, fonts);
    remember(writeAppearance(get().raw, get().value), fonts);
  };

  return {
    raw: saved.raw,
    value: first,
    fonts: saved.fonts,
    kindsActive: kindsActive(first),

    load: async () => {
      try {
        const at = edits;
        const [raw, fonts] = await Promise.all([api.appearance(), api.fonts()]);
        // 읽는 사이에 고쳤으면 고친 값을 둔다 (모르는 키만 받아 온다).
        const value = at === edits ? readAppearance(raw) : get().value;
        show(value, fonts, obj(raw));
        remember(writeAppearance(obj(raw), value), fonts);
      } catch {
        /* 서버가 없으면 지난번 설정 그대로 둔다. 연결 오류는 앱이 따로 알린다. */
      }
    },

    edit: (change) => {
      edits++;
      dirty = true;
      show(change(get().value), get().fonts);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void flush(), 500);
    },

    setFont: (slot, family) => get().edit((v) => ({ ...v, fonts: { ...v.fonts, [slot]: family } })),
    setBody: (patch) => get().edit((v) => ({ ...v, body: { ...v.body, ...patch } })),
    setKind: (kind, patch) => get().edit((v) => ({ ...v, kinds: { ...v.kinds, [kind]: { ...v.kinds[kind], ...patch } } })),
    reset: () => get().edit(() => DEFAULTS),

    upload: async (files) => {
      const failed: UploadFailure[] = [];
      for (const file of files) {
        try {
          await api.uploadFont(file);
        } catch (e) {
          failed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
      await refreshFonts().catch(notifyFailure);
      return failed;
    },

    removeFamily: async (family) => {
      try {
        for (const f of get().fonts.filter((x) => x.family === family)) await api.deleteFont(f.id);
      } catch (e) {
        notifyFailure(e);
      }
      await refreshFonts().catch(notifyFailure);
    },
  };
});

/** 실패를 화면 아래의 알림으로 보인다. */
function notifyFailure(e: unknown): void {
  useStore.getState().fail(e);
}

// 앱이 뜨는 길에 서버의 설정을 읽는다 (지난번 설정은 위에서 이미 입혔다).
if (typeof window !== "undefined") void useAppearance.getState().load();
