import { ApiError } from "./errors";

/*
 * 정적 사이트로 뽑은 시연 (`vite build --mode static`, scripts/make_static_demo.py).
 * 서버가 없다. 작업 하나의 응답을 미리 받아 둔 파일(`snapshot/`)만 읽는다. 읽기 전용이다.
 */

export const isStatic = import.meta.env.VITE_STATIC === "1";

interface Index {
  /** 요청의 열쇠(requestKey) → 그 응답이 든 파일 */
  entries: Record<string, string>;
  /** 자료의 파일 경로(`자료/삽화/등대.png`) → 그 파일 */
  files: Record<string, string>;
}

const base = `${import.meta.env.BASE_URL}snapshot/`;
let index: Index | null = null;
let loading: Promise<Index> | null = null;
const load = () => (loading ??= fetch(`${base}index.json`).then((r) => r.json() as Promise<Index>).then((i) => (index = i)));

/** 화면에서 바꾼 작업의 상태(보고 있는 대화, 모드). 저장되지 않고 이 탭에서만 유지된다. */
const states = new Map<string, Record<string, unknown>>();

/** 요청을 가리키는 열쇠: 경로와, 이름순으로 줄 세운 질의. 뽑는 쪽과 같은 규칙이다. */
function requestKey(path: string): string {
  const url = new URL(path, "http://snapshot");
  const query = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return decodeURIComponent(url.pathname) + (query ? `?${query}` : "");
}

async function read<T>(path: string): Promise<T> {
  const file = (await load()).entries[requestKey(path)];
  if (!file) throw new ApiError(404, "시연 사이트에 들어 있지 않은 내용입니다.");
  const res = await fetch(base + file);
  if (!res.ok) throw new ApiError(res.status, "시연 사이트의 파일을 읽지 못했습니다.");
  return (await res.json()) as T;
}

export async function snapshotRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (method === "GET") return read<T>(path);
  // 대화를 고르거나 모드를 바꾸면 화면이 작업의 상태를 저장한다. 그것은 받아 주고 이 탭에서만 기억한다.
  const state = /^(\/sessions\/[^/]+)\/state$/.exec(path);
  if (method === "PUT" && state) {
    const next = { ...(states.get(path) ?? (await read<Record<string, unknown>>(path))), ...(body as Record<string, unknown>) };
    states.set(path, next);
    return next as T;
  }
  throw new ApiError(405, "읽기 전용 시연입니다. 여기서 바꾼 것은 저장되지 않습니다.");
}

/** 자료의 파일(이미지 등)의 주소. 들어 있지 않으면 빈 문자열. */
export function snapshotFile(path: string): string {
  const file = index?.files[path];
  return file ? base + file : "";
}
