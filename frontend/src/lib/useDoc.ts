import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { barePath } from "./labels";
import type { DocContent } from "./types";
import { useStore } from "../store";

export interface DocHandle {
  /** 서버에서 읽어 온 글. 읽는 중이면 null. 타이핑으로는 바뀌지 않고, 밖에서 문서가 바뀌어 다시 읽었을 때만 바뀐다. */
  text: string | null;
  /** text가 새로 들어올 때마다 1씩 는다. 편집기는 이 값이 바뀌면 내용을 통째로 갈아 끼운다. */
  loadId: number;
  meta: Pick<DocContent, "kind" | "locked" | "note"> | null;
  error: string | null;
  /** 아직 저장되지 않은 타이핑이 있다. */
  dirty: boolean;
  /** 고친 글을 넘긴다. 잠깐 뒤에 저장된다. */
  edit: (text: string) => void;
  /** 지금 바로 저장한다. */
  flush: () => Promise<void>;
}

/**
 * 문서 하나(입력, 출력, 자료/…, 원고/s3)를 읽고, 고치면 저장한다.
 * 에이전트나 다른 편집기가 같은 문서를 바꾸면 다시 읽는다.
 */
export function useDoc(path: string | null): DocHandle {
  const origin = useId();
  const sessionId = useStore((s) => s.sessionId);
  const key = path ? barePath(path) : "";
  const rev = useStore((s) => (key ? (s.rev[key] ?? 0) : 0));
  const [loaded, setLoaded] = useState<{ key: string; text: string | null; loadId: number; meta: DocHandle["meta"]; error: string | null }>({
    key: "",
    text: null,
    loadId: 0,
    meta: null,
    error: null,
  });
  const [dirty, setDirty] = useState(false);
  const pending = useRef<{ sessionId: string; key: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loads = useRef(0);

  // 이미 떠난 저장. flush를 기다리는 쪽(나누기, 합치기, 요약)이 그 저장보다 먼저 서버에 닿지 않게 한다.
  const inflight = useRef<Promise<void>>(Promise.resolve());

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    const job = pending.current;
    pending.current = null;
    if (job) {
      inflight.current = inflight.current.then(async () => {
        try {
          await api.saveDoc(job.sessionId, job.key, job.text);
          useStore.getState().touch([job.key], origin);
        } catch (e) {
          useStore.getState().fail(e);
        } finally {
          if (!pending.current) setDirty(false);
        }
      });
    }
    await inflight.current;
  }, [origin]);

  useEffect(() => {
    if (!sessionId || !key) return;
    // 내가 방금 저장해서 생긴 변경이면 다시 읽지 않는다.
    if (loaded.key === key && loaded.text !== null && useStore.getState().revBy[key] === origin) return;
    let alive = true;
    // 밖에서 바뀐 문서가 우선이다. 저장을 기다리던 타이핑은 버린다.
    if (timer.current) clearTimeout(timer.current);
    pending.current = null;
    setDirty(false);
    if (loaded.key !== key) setLoaded({ key, text: null, loadId: loaded.loadId, meta: null, error: null });
    api
      .doc(sessionId, key)
      .then((d) => {
        if (alive) setLoaded({ key, text: d.content, loadId: ++loads.current, meta: { kind: d.kind, locked: d.locked, note: d.note }, error: null });
      })
      .catch((e) => {
        if (alive) setLoaded({ key, text: null, loadId: ++loads.current, meta: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, key, rev]);

  // 다른 문서로 넘어가거나 화면에서 사라질 때 남은 타이핑을 저장한다.
  useEffect(() => () => void flush(), [key, sessionId, flush]);
  // 창을 닫거나 새로 고칠 때도 마찬가지다 (컴포넌트가 치워지지 않고 페이지째 사라진다).
  useEffect(() => {
    const leave = () => void flush();
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [flush]);

  const edit = useCallback(
    (text: string) => {
      if (!sessionId || !key) return;
      pending.current = { sessionId, key, text };
      setDirty(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [sessionId, key, flush],
  );

  const current = loaded.key === key;
  return {
    text: current ? loaded.text : null,
    loadId: current ? loaded.loadId : 0,
    meta: current ? loaded.meta : null,
    error: current ? loaded.error : null,
    dirty,
    edit,
    flush,
  };
}
