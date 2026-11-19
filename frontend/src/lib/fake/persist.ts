/* 가짜 API의 상태를 메모리에 들고, localStorage에 저장한다. */
import { ApiError } from "../errors";
import { seedState } from "./seed";
import { closeLostRun, type FakeSession, type FakeState } from "./state";

const KEY = "aleph-fake-v1";

let state: FakeState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 저장하기에는 큰 이미지의 주소(object URL). `작업 id\n경로` → 주소. 새로고침하면 사라진다. */
export const blobUrls = new Map<string, string>();
export const blobKey = (sessionId: string, path: string) => `${sessionId}\n${path}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 새로고침으로 끊긴 것들을 정리한다. */
function tidy(st: FakeState): FakeState {
  for (const s of st.sessions) {
    if (s.run.running) closeLostRun(s);
    // 주소가 메모리에만 있던 큰 이미지는 더 보여줄 수 없다.
    for (const [path, m] of Object.entries(s.materials)) if (m.kind !== "text" && !m.data) delete s.materials[path];
  }
  return st;
}

function load(): FakeState {
  try {
    const raw = storage()?.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as FakeState;
      // 상태의 모양이 바뀌면 `v`를 올린다. 번호가 다른 저장본은 읽지 않고 처음 상태로 덮는다.
      if (parsed && parsed.v === 3 && Array.isArray(parsed.sessions)) return tidy(parsed);
    }
  } catch {
    /* 깨진 저장본은 버리고 처음 상태로 */
  }
  return seedState();
}

export function db(): FakeState {
  if (!state) {
    state = load();
    saveNow();
  }
  return state;
}

export function saveNow(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!state) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(state));
  } catch {
    // 저장 공간이 모자라다. 올린 이미지와 글이 흐르던 조각(끝난 글은 따로 남아 있다)을 빼고 다시 넣어 본다.
    try {
      const slim = JSON.stringify(state, (key, value) => {
        if (key === "data" && typeof value === "string" && value.length > 20_000) return "";
        if (key === "events" && Array.isArray(value)) return value.filter((e) => !["tool_stream", "text_delta", "thinking_delta"].includes(e?.type));
        return value;
      });
      store.setItem(KEY, slim);
    } catch {
      /* 그래도 안 되면 메모리에만 둔다 */
    }
  }
}

/** 조금 모았다가 저장한다. 도구가 글을 흘리는 동안 이벤트마다 쓰지 않게. */
export function save(): void {
  if (timer) return;
  timer = setTimeout(saveNow, 150);
}

export function reset(): void {
  for (const url of blobUrls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* 무시 */
    }
  }
  blobUrls.clear();
  state = seedState();
  saveNow();
}

export function session(id: string): FakeSession {
  const s = db().sessions.find((x) => x.id === id);
  if (!s) throw new ApiError(404, "그런 작업이 없습니다");
  return s;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // 떠나기 직전에 모아 둔 것을 마저 저장한다.
  window.addEventListener("pagehide", saveNow);
}
