import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../../lib/api";
import { pathLabel } from "../../lib/labels";
import type { SearchHit } from "../../lib/types";
import { useStore } from "../../store";
import { CloseIcon } from "../icons";
import { IconButton, Segmented, Spinner, inputClass } from "../ui";

type Scope = "all" | "manuscript" | "materials";

/*
 * 찾기 칸이 열려 있는지와 찾던 말. 왼쪽 패널을 접었다 펴거나 탭을 오가도 남게 패널 밖에 둔다
 * (겹쳐 뜬 패널은 결과를 누르면 접힌다. 다시 폈을 때 찾던 것이 그대로 있어야 다음 결과로 갈 수 있다).
 * tick은 이미 열려 있을 때 단축키를 또 누르면 입력칸으로 초점을 되돌리는 데 쓴다.
 */
export const useSearch = create<{ open: boolean; query: string; scope: Scope; tick: number }>(() => ({ open: false, query: "", scope: "all", tick: 0 }));
export const openSearch = () => useSearch.setState((s) => ({ open: true, tick: s.tick + 1 }));
export const closeSearch = () => useSearch.setState({ open: false });

// Ctrl+Shift+F. 왼쪽 패널이 접혀 있어도 듣도록 패널 밖(여기)에서 건다.
if (typeof window !== "undefined")
  window.addEventListener("keydown", (e) => {
    // 한글 자판에서는 key가 `ㄹ`로 온다. 자리(code)로 본다.
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== "KeyF") return;
    const s = useStore.getState();
    if (!s.sessionId || s.dialog) return;
    e.preventDefault();
    if (!s.leftOpen) s.togglePanel("left");
    openSearch();
  });

/** 줄에서 찾은 말 앞에 이만큼만 남긴다. 긴 줄에서도 찾은 말이 첫머리에 보이게. */
const LEAD = 14;
/** 찾은 말 뒤로 보일 글자 수. 그 뒤는 두 줄에서 잘린다. */
const TAIL = 120;

/** 찾기: 왼쪽 패널의 탭 아래에 목록 대신 놓인다. 결과를 누르면 그 문서의 그 자리가 열린다. */
export function SearchBox() {
  const sessionId = useStore((s) => s.sessionId);
  const ws = useStore((s) => s.ws);
  const fail = useStore((s) => s.fail);
  const { query, scope, tick } = useSearch();
  const [result, setResult] = useState<{ query: string; hits: SearchHit[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Enter를 누를 때마다 는다. 기다리지 않고 바로 찾는다. */
  const [now, setNow] = useState(0);
  const lastNow = useRef(0);
  const turn = useRef(0); // 늦게 온 응답이 새 결과를 덮지 않게 한다
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [tick]);

  useEffect(() => {
    const q = query.trim();
    const mine = ++turn.current;
    const immediate = now !== lastNow.current;
    lastNow.current = now;
    if (!sessionId || !q) {
      setResult(null);
      setBusy(false);
      return;
    }
    const run = () => {
      setBusy(true);
      api
        .search(sessionId, q, scope)
        .then((r) => mine === turn.current && setResult({ query: q, hits: r.hits, truncated: r.truncated }))
        .catch((e) => {
          if (mine !== turn.current) return;
          setResult(null);
          fail(e);
        })
        .finally(() => mine === turn.current && setBusy(false));
    };
    if (immediate) {
      run();
      return;
    }
    const timer = setTimeout(run, 300);
    return () => clearTimeout(timer);
  }, [sessionId, query, scope, now, fail]);

  // 문서별로 묶는다. 서버가 준 순서(원고는 장면 순)를 그대로 둔다.
  const groups = useMemo(() => {
    const byPath = new Map<string, SearchHit[]>();
    for (const hit of result?.hits ?? []) {
      const group = byPath.get(hit.path);
      if (group) group.push(hit);
      else byPath.set(hit.path, [hit]);
    }
    return [...byPath.values()];
  }, [result]);

  // 위치와 길이는 글자(코드 포인트)로 센다. 엔진이 그렇게 센다.
  const found = result ? Array.from(result.query).length : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 pt-2.5 pr-2 pb-2 pl-3">
        <div className="flex items-center gap-1">
          <input
            ref={input}
            aria-label="찾기"
            placeholder="찾기"
            spellCheck={false}
            value={query}
            onChange={(e) => useSearch.setState({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // 한글 조합을 끝내는 Enter
              if (e.key === "Enter") setNow((n) => n + 1);
              else if (e.key === "Escape") {
                e.stopPropagation();
                closeSearch();
              }
            }}
            className={`${inputClass} !h-8`}
          />
          <IconButton label="닫기" onClick={closeSearch}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className="flex min-h-8 items-center gap-2">
          <Segmented
            label="범위"
            value={scope}
            onChange={(v) => useSearch.setState({ scope: v })}
            options={[
              { value: "all", label: "전체" },
              { value: "manuscript", label: "원고" },
              { value: "materials", label: "자료" },
            ]}
          />
          <span className="flex-1" />
          {busy ? (
            <Spinner className="mr-2" />
          ) : (
            result &&
            result.hits.length > 0 && (
              <span className="mr-1.5 text-xs text-muted tabular-nums">
                {result.hits.length}
                {result.truncated ? "+" : ""}
              </span>
            )
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-hair px-1 pb-3">
        {groups.map((hits, gi) => (
          <section key={hits[0].path} className={`py-1 ${gi > 0 ? "border-t border-hair" : ""}`}>
            <div className="flex h-8 items-center gap-2 px-3">
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{hits[0].title || pathLabel(hits[0].path, ws)}</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{hits.length}</span>
            </div>
            {hits.map((hit) => {
              const chars = Array.from(hit.text);
              const from = hit.start > LEAD + 6 ? hit.start - LEAD : 0;
              const end = hit.start + found;
              return (
                <button
                  key={`${hit.line}:${hit.start}`}
                  type="button"
                  onClick={() => useStore.getState().openAt(hit.path, hit.line, hit.start, result?.query.length ?? 0)}
                  className="flex w-full rounded-md border-0 bg-transparent px-3 py-1 text-left hover:bg-sunken"
                >
                  <span className="line-clamp-2 min-w-0 text-[13px] [overflow-wrap:anywhere]">
                    {from > 0 && <span className="text-muted">…</span>}
                    {chars.slice(from, hit.start).join("")}
                    <mark className="rounded-[2px] bg-mark text-ink">{chars.slice(hit.start, end).join("")}</mark>
                    {chars.slice(end, end + TAIL).join("")}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
        {result && !busy && result.hits.length === 0 && <div className="px-3 py-2 text-[13px] text-muted">결과 없음</div>}
        {result?.truncated && <div className="border-t border-hair px-3 py-2 text-xs text-muted">200곳까지만 보임</div>}
      </div>
    </div>
  );
}
