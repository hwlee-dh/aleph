import { josa } from "./josa";
import type { Chapter, Mode, Provider, Scene, Thinking, ToolDef, Workspace } from "./types";

export const MODE_LABEL: Record<Mode, string> = { manual: "수동", auto: "자동", autonomous: "자율", plan: "계획" };
export const MODES: Mode[] = ["manual", "auto", "autonomous", "plan"];
/** 서버(meta.modes)가 설명을 주지 못했을 때 쓰는 말. */
export const MODE_HINT: Record<Mode, string> = {
  manual: "문서를 바꾸거나 도구를 돌리기 전에 항상 확인합니다.",
  auto: "에이전트가 판단해서 확인을 청합니다. 원고 변경은 항상 확인합니다.",
  autonomous: "확인하지 않고 끝까지 진행합니다.",
  plan: "실행하지 않고 계획만 세웁니다. 자료에만 씁니다.",
};

export const THINKING_LABEL: Record<Thinking, string> = { default: "기본", off: "끔", low: "낮음", medium: "보통", high: "높음" };
export const THINKINGS: Thinking[] = ["default", "off", "low", "medium", "high"];

/** 경로 끝의 `.md`와 앞뒤 `/`를 뗀다. 같은 문서인지 견줄 때 쓴다. */
export function barePath(path: string): string {
  return String(path ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
}
export const samePath = (a: string, b: string) => barePath(a) === barePath(b);

export function findScene(ws: Workspace | null, idOrPath: string): { scene: Scene; chapter: Chapter } | null {
  const id = barePath(idOrPath).replace(/^원고\//, "");
  for (const chapter of ws?.manuscript.chapters ?? []) {
    const scene = chapter.scenes.find((s) => s.id === id);
    if (scene) return { scene, chapter };
  }
  return null;
}

/**
 * 장면의 이름: `1장 2번째 장면`. 장면에는 제목이 없고 이름은 자리뿐이다.
 * 엔진이 주는 이름(확인 카드의 설명, 찾기·되돌리기의 결과, 에이전트의 말)과 같은 꼴이라야 한 화면에 두 꼴이 섞이지 않는다.
 */
export function sceneLabel(scene: Scene, chapter: Chapter): string {
  return `${chapter.number}장 ${scene.number}번째 장면`;
}

/** 장면의 자리 표시: `1장 2`. 이름이 아니라 번호가 놓이는 자리(원고 화면의 경계)에 쓴다. */
export function sceneMark(scene: Scene, chapter: Chapter): string {
  return `${chapter.number}장 ${scene.number}`;
}

/** 경로를 화면에 보일 이름으로. 입력·출력은 그대로, 자료는 `자료/`를 뗀 이름, 장면은 `1장 2번째 장면`, 장은 `1장`. */
export function pathLabel(path: string, ws: Workspace | null): string {
  const p = barePath(path);
  if (p === "입력" || p === "출력" || p === "원고" || p === "자료") return p;
  if (p.startsWith("원고/")) {
    const found = findScene(ws, p);
    if (found) return sceneLabel(found.scene, found.chapter);
    const chapter = ws?.manuscript.chapters.find((c) => c.id === p.slice(3));
    return chapter ? `${chapter.number}장` : p;
  }
  return p.replace(/^자료\//, "");
}

/** 경로의 마지막 이름. */
export function baseName(path: string): string {
  return barePath(path).split("/").pop() ?? "";
}
export function parentPath(path: string): string {
  const parts = barePath(path).split("/");
  parts.pop();
  return parts.join("/");
}

/** 문서를 마지막으로 쓴 주체를 사람 말로. */
export function byLabel(by: string, tools: ToolDef[] = []): string {
  if (by === "user") return "내가 씀";
  if (by === "agent") return "에이전트가 씀";
  if (by === "preset") return "시작 자료";
  if (by.startsWith("tool:")) {
    const name = by.slice(5);
    return `${tools.find((t) => t.name === name)?.label ?? name} 출력`;
  }
  return "";
}

/** 모델 참조('제공자:모델')에서 모델 이름만. */
export function modelShort(ref: string | undefined | null): string {
  if (!ref) return "";
  const i = ref.indexOf(":");
  return i === -1 ? ref : ref.slice(i + 1);
}

/** 모델 참조를 제공자 이름과 함께. */
export function modelLabel(ref: string, providers: Provider[]): string {
  if (!ref) return "모델 미지정";
  const i = ref.indexOf(":");
  if (i === -1) return ref;
  const provider = providers.find((p) => p.id === ref.slice(0, i));
  return `${provider?.label ?? ref.slice(0, i)} · ${ref.slice(i + 1)}`;
}

export const formatChars = (n: number) => `${n.toLocaleString("ko-KR")}자`;
/** 파일의 크기. 목록과 넓은 패널이 같은 말로 적는다. */
export const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);

export function formatTokens(n: number | undefined): string {
  if (!n) return "0";
  return n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString("ko-KR");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

/** 시각을 짧게: 오늘이면 `14:02`, 아니면 `11.15 14:02`. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? hm : `${d.getMonth() + 1}.${d.getDate()} ${hm}`;
}

/** 채팅창의 `/도구이름 나머지`를 가른다. 맞는 도구가 없으면 tool은 null. */
export function parseCommand(text: string, tools: ToolDef[]): { tool: ToolDef | null; rest: string } {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return { tool: null, rest: text.trim() };
  const tool = tools.find((t) => t.enabled && (t.label === m[1] || t.name === m[1])) ?? null;
  return tool ? { tool, rest: m[2].trim() } : { tool: null, rest: text.trim() };
}

/** 인용한 대목을 요청 글 앞에 붙인다. 엔진에는 그냥 글로 간다 (형식은 API.md의 "문서에서 인용해 요청하기"). */
export function withQuote(quote: { path: string; text: string } | null, message: string): string {
  if (!quote) return message;
  const quoted = quote.text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `[인용: ${barePath(quote.path)}]\n${quoted}\n\n${message}`.trim();
}

/** withQuote로 만든 글을 다시 가른다. path는 인용한 문서의 경로. */
export function splitQuote(text: string): { path: string; quote: string; message: string } | null {
  const m = /^\[인용: ([^\]]+)\]\n((?:>.*(?:\n|$))+)\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  return {
    path: m[1],
    quote: m[2]
      .split("\n")
      .filter((l) => l.startsWith(">"))
      .map((l) => l.replace(/^> ?/, ""))
      .join("\n"),
    message: m[3].trim(),
  };
}

export { josa };
