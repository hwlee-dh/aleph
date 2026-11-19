import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api } from "../lib/api";
import { formatChars, sceneLabel, sceneMark } from "../lib/labels";
import { useAppearance } from "../lib/appearance";
import { useDoc, type DocHandle } from "../lib/useDoc";
import { useStore } from "../store";
import { pendingLocate } from "./editor/locate";
import { TextEditor, type TextEditorHandle } from "./editor/TextEditor";
import { HistoryIcon, PlusIcon } from "./icons";
import { Button, Tag } from "./ui";

/*
 * 원고 화면의 가운데. 장면을 순서대로 이어 붙인 편집 화면이다.
 * 장면마다 편집기가 하나씩 있다(저장은 장면 단위). 장면 사이에는 평소에 아무것도 보이지 않는다:
 * 내보낸 글에서도 장면 사이는 빈 줄 하나뿐이라, 글이 그냥 이어져 보이는 쪽이 실제 글의 모습과 맞다.
 * 경계(가는 줄, 번호, `앞 장면과 합치기`)는 마우스를 올린 장면과 초점이 든 장면에서만 흐리게 뜬다 (index.css의 `.scene-edge`).
 * 장의 머리(`2장`)는 항상 보인다. 요약은 여기 보이지 않는다(왼쪽 목록에만).
 */

/** 부모가 장면 하나를 다룰 때 쓰는 손잡이. */
interface SceneHandle {
  editor: () => TextEditorHandle | null;
  el: () => HTMLElement | null;
  /** 아직 저장되지 않은 글을 저장한다. */
  save: () => Promise<void>;
  /** 화면 밖이라 아직 읽지 않았으면 지금 읽는다. */
  load: () => void;
}

/** 장면들이 부모에게 알리는 통로. 한 번 만들어 그대로 쓰므로 장면이 다시 그려지지 않는다. */
interface Hub {
  handles: Map<string, SceneHandle>;
  scroller: RefObject<HTMLDivElement | null>;
  /**
   * 그 장면으로 스크롤하고 초점을 준다. 아직 화면에 없으면 생겼을 때 한다.
   * start는 장면의 처음을 화면 위에 맞추고(목록에서 골랐을 때), nearest는 안 보일 때만 움직인다(쓰던 자리 근처에 새 장면이 생겼을 때).
   * located면 그 장면 안의 한 자리(찾기 결과)를 편집기가 곧 고른다. 자리를 다시 맞출 때 머리가 아니라 그 글귀를 따라간다.
   */
  go: (id: string, align?: ScrollLogicalPosition, located?: boolean) => void;
  mounted: (id: string) => void;
  ready: (id: string) => void;
  focused: (id: string) => void;
  cursor: (id: string, splittable: boolean) => void;
  merge: (prevId: string, id: string) => void;
  /** 글의 높이가 바뀌었다. 방금 찾아간 장면이 있으면 그 자리를 다시 맞춘다. */
  resettle: () => void;
  /** 사용자가 스크롤이나 타이핑을 시작했다. 더는 자리를 다시 맞추지 않는다. */
  release: () => void;
}

/**
 * 아직 읽지 않은 장면이 차지할 높이를 글자 수로 어림한다. 읽어 오면서 스크롤 막대가 덜 튄다.
 * 본문의 글자 크기·줄 간격·너비(설정)에 맞춘다. 기본값에서는 한 줄 36자, 줄 높이 33px이다.
 */
function estimate(chars: number): number {
  const { size, line_height, width } = useAppearance.getState().value.body;
  const perLine = Math.max(8, Math.floor(((width - 48) / size) * 0.885));
  return Math.max(1, Math.ceil(chars / perLine)) * size * line_height;
}

interface SceneProps {
  id: string;
  path: string;
  /** 경계에 뜨는 이름 (`1장 3`). */
  label: string;
  chars: number;
  /** 바로 앞 장면(장을 넘어서도). 원고의 첫 장면이면 null. */
  prevId: string | null;
  hub: Hub;
}

const SceneBlock = memo(function SceneBlock({ id, path, label, chars, prevId, hub }: SceneProps) {
  const root = useRef<HTMLElement>(null);
  const editor = useRef<TextEditorHandle>(null);
  const docRef = useRef<DocHandle | null>(null);
  // 긴 원고를 한꺼번에 읽지 않는다. 화면 가까이 온 장면만 읽고 편집기를 만든다 (한번 만들면 그대로 둔다).
  const [near, setNear] = useState(false);

  const doc = useDoc(near ? path : null);
  docRef.current = doc;
  const loaded = doc.text !== null;

  useEffect(() => {
    const el = root.current;
    if (near || !el) return;
    const MARGIN = 1200;
    let told = false;
    const seen = new IntersectionObserver(
      (entries) => {
        told = true;
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: hub.scroller.current, rootMargin: `${MARGIN}px 0px` },
    );
    seen.observe(el);
    // 관찰자는 화면이 그려질 때에만 알려 준다. 창이 가려져 그리기가 멈춘 채 열리면 영영 소식이 없어 원고가 빈 채로 남는다.
    // 잠깐 기다려도 첫 소식이 없으면 자리를 직접 재어 본다.
    const fallback = setTimeout(() => {
      const box = hub.scroller.current?.getBoundingClientRect();
      if (told || !box) return;
      const r = el.getBoundingClientRect();
      if (r.bottom > box.top - MARGIN && r.top < box.bottom + MARGIN) setNear(true);
    }, 400);
    return () => {
      seen.disconnect();
      clearTimeout(fallback);
    };
  }, [near, hub]);

  useEffect(() => {
    const handle: SceneHandle = {
      editor: () => editor.current,
      el: () => root.current,
      load: () => setNear(true),
      save: async () => {
        const d = docRef.current;
        if (!d) return;
        // 올린 글에는 \r\n이 남아 있을 수 있는데 편집기는 줄 바꿈을 \n 하나로 센다.
        // 글자 위치로 자르기 전에 편집기의 글로 맞춰 둔다.
        const text = editor.current?.getText();
        if (text !== undefined && d.text?.includes("\r")) d.edit(text);
        await d.flush();
      },
    };
    hub.handles.set(id, handle);
    hub.mounted(id);
    return () => {
      if (hub.handles.get(id) === handle) hub.handles.delete(id);
    };
  }, [hub, id]);

  // 편집기가 생겼다(자식의 effect가 먼저 돌므로 이때는 초점을 줄 수 있다).
  useEffect(() => {
    if (loaded) hub.ready(id);
  }, [loaded, hub, id]);

  // 장면을 떠나면 바로 저장한다. 요약은 다시 쓰지 않는다: 고친 장면의 요약은 낡은 것(stale)으로 남고,
  // 에이전트가 다시 붙이거나 사용자가 직접 쓴다.
  const leave = () => void docRef.current?.flush();

  return (
    <section ref={root} className="scene scroll-mt-3">
      {/*
        이 장면의 위쪽 경계. 자리는 늘 차지하고(본문의 빈 줄 하나 높이) 보이기만 바뀐다. 그래서 떴다 사라져도 글이 밀리지 않는다.
        버튼은 안 보일 때도 Tab으로 닿는다. 닿으면 초점이 이 장면 안에 든 것이라 경계가 뜬다.
      */}
      <div className="scene-edge flex items-center gap-2 text-xs text-muted select-none">
        <span className="shrink-0 tabular-nums">{label}</span>
        <span className="h-px min-w-6 flex-1 bg-line" />
        {prevId && (
          <Button small variant="quiet" onClick={() => hub.merge(prevId, id)}>
            앞 장면과 합치기
          </Button>
        )}
      </div>
      {doc.error ? (
        <p className="m-0 py-2 text-[13px] text-danger">{doc.error}</p>
      ) : doc.text === null ? (
        <div style={{ minHeight: estimate(chars) }} />
      ) : (
        <TextEditor
          ref={editor}
          value={doc.text}
          loadId={doc.loadId}
          variant="manuscript"
          path={path}
          onChange={(text) => doc.edit(text)}
          onFocus={() => {
            hub.focused(id);
            // 커서가 전에 있던 자리 그대로면 편집기가 따로 알려 주지 않는다. 돌아온 장면의 자리를 다시 알린다.
            const ed = editor.current;
            if (ed) {
              const pos = ed.cursor();
              hub.cursor(id, pos > 0 && pos < ed.getText().length);
            }
          }}
          onBlur={leave}
          onCursor={(pos, length) => hub.cursor(id, pos > 0 && pos < length)}
        />
      )}
    </section>
  );
});

export function ManuscriptView() {
  const sessionId = useStore((s) => s.sessionId);
  const manuscript = useStore((s) => s.ws?.manuscript);
  const jump = useStore((s) => s.jump);
  const scroller = useRef<HTMLDivElement>(null);
  /** 마지막으로 초점이 간 장면. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 커서가 장면의 처음도 끝도 아닌가 (나눌 수 있는가). */
  const [cursor, setCursor] = useState<{ id: string; splittable: boolean } | null>(null);
  const [working, setWorking] = useState(false);

  const hub = useMemo<Hub>(() => {
    const handles = new Map<string, SceneHandle>();
    let want: { id: string; align: ScrollLogicalPosition; located: boolean } | null = null; // 편집기가 생기면 초점을 줄 장면
    let merging = false;
    // 목록에서 골라 찾아간 장면. 위쪽 장면의 글과 그림이 뒤늦게 읽히면 자리가 밀리므로, 잠깐 동안은 다시 맞춘다.
    // located면 장면의 머리가 아니라 편집기가 고른 글귀(찾기 결과)에 맞춘다.
    let held: { id: string; until: number; located: boolean } | null = null;

    const reveal = (id: string, align: ScrollLogicalPosition, located: boolean) => {
      const h = handles.get(id);
      if (!h) return false;
      h.load();
      h.el()?.scrollIntoView({ block: align });
      held = align === "start" ? { id, until: performance.now() + 2500, located } : null;
      const ed = h.editor();
      if (!ed) return false;
      ed.focus();
      return true;
    };
    const retry = (id: string) => {
      if (want?.id === id && reveal(id, want.align, want.located)) want = null;
    };

    return {
      handles,
      scroller,
      go: (id, align = "start", located = false) => {
        setActiveId(id);
        want = reveal(id, align, located) ? null : { id, align, located };
      },
      mounted: retry,
      ready: retry,
      focused: (id) => setActiveId(id),
      cursor: (id, splittable) => setCursor((now) => (now && now.id === id && now.splittable === splittable ? now : { id, splittable })),
      merge: async (prevId, id) => {
        if (merging) return;
        merging = true;
        try {
          await Promise.all([handles.get(prevId)?.save(), handles.get(id)?.save()]);
          const s = useStore.getState();
          const merged = await s.act((sid) => api.mergeScenes(sid, [prevId, id]));
          if (!merged) return;
          // 합쳐진 쪽 편집기가 늘어난 글을 다시 읽게 한다. 사라진 장면의 편집기는 목록에서 빠지며 없어진다.
          s.touch([`원고/${merged.id}`]);
          setActiveId((now) => (now === id ? merged.id : now));
        } finally {
          merging = false;
        }
      },
      resettle: () => {
        if (!held) return;
        if (performance.now() > held.until) {
          held = null;
          return;
        }
        const h = handles.get(held.id);
        const ed = held.located ? h?.editor() : null;
        if (ed) ed.showSelection();
        else h?.el()?.scrollIntoView({ block: "start" });
      },
      release: () => {
        held = null;
      },
    };
  }, []);

  // 장면이 읽히거나 그림이 떠서 글의 높이가 바뀔 때마다 알린다.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!content.current) return;
    const watch = new ResizeObserver(hub.resettle);
    watch.observe(content.current);
    return () => watch.disconnect();
  }, [hub]);

  const flat = useMemo(() => (manuscript?.chapters ?? []).flatMap((chapter) => chapter.scenes.map((scene) => ({ scene, chapter }))), [manuscript]);
  const prevOf = useMemo(() => new Map(flat.map((x, i) => [x.scene.id, i > 0 ? flat[i - 1].scene.id : null] as const)), [flat]);
  // 아직 어디에도 초점이 간 적 없으면 첫 장면을 가리킨다.
  const active = flat.find((x) => x.scene.id === activeId) ?? flat[0] ?? null;

  useEffect(() => {
    // 찾기 결과에서 왔으면(openAt) 그 장면 안의 자리가 같이 정해져 있다. 그 자리는 장면의 편집기가 고른다.
    if (jump) hub.go(jump.scene, "start", pendingLocate(`원고/${jump.scene}`) !== null);
  }, [jump, hub]);

  const act = useStore.getState().act;

  const split = async () => {
    if (!active || working) return;
    const { scene } = active;
    const handle = hub.handles.get(scene.id);
    const ed = handle?.editor();
    if (!handle || !ed) return;
    const text = ed.getText();
    const pos = ed.cursor();
    if (pos <= 0 || pos >= text.length) return;
    setWorking(true);
    try {
      await handle.save();
      // 엔진은 글자(코드 포인트)로 세고 편집기는 UTF-16으로 센다. 앞에 이모지 같은 글자가 있으면 어긋나므로 맞춘다.
      const at = Array.from(text.slice(0, pos)).length;
      const made = await act((id) => api.splitScene(id, scene.id, [at]));
      if (!made) return;
      // 앞 조각이 원래 id를 갖는다. 그 편집기가 줄어든 글을 다시 읽게 하고, 뒤 조각으로 넘어간다.
      useStore.getState().touch([scene.path]);
      if (made.ids[1]) hub.go(made.ids[1], "nearest");
    } finally {
      setWorking(false);
    }
  };

  const addScene = async (body: { chapter: string } | { new_chapter: true }) => {
    const made = await act((id) => api.addScene(id, { ...body, content: "" }));
    if (made) hub.go(made.id, "nearest");
  };

  const splittable = !!active && !working && cursor?.id === active.scene.id && cursor.splittable;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      {active && (
        // 막대의 버튼을 눌러도 장면의 초점과 커서가 그대로 있어야 한다 (나눌 자리가 커서다).
        <div className="shrink-0 border-b border-hair" onMouseDown={(e) => e.preventDefault()}>
          <div className="mx-auto flex h-10 w-full max-w-[var(--body-width,720px)] items-center gap-3 px-6">
            <span className="min-w-0 truncate text-[13px] font-bold">{sceneLabel(active.scene, active.chapter)}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{formatChars(active.scene.chars)}</span>
            {active.scene.locked && <Tag tone="protect">수정 방지</Tag>}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Button small variant="quiet" disabled={!splittable} onClick={() => void split()}>
                여기서 장면 나누기
              </Button>
              <Button small variant="quiet" onClick={() => useStore.getState().openDrawer({ kind: "history", path: active.scene.path })}>
                <HistoryIcon />
                버전 기록
              </Button>
            </span>
          </div>
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" onWheel={hub.release} onPointerDown={hub.release} onKeyDown={hub.release}>
        <div ref={content} className="mx-auto w-full max-w-[var(--body-width,720px)] px-6 pt-6 pb-[40vh]">
          {sessionId && manuscript && manuscript.chapters.length === 0 && (
            <Button small variant="quiet" className="-ml-2.5" onClick={() => void addScene({ new_chapter: true })}>
              <PlusIcon />
              장면
            </Button>
          )}

          {sessionId &&
            manuscript?.chapters.map((chapter) => (
              <section key={chapter.id} className="pb-12">
                {/* 장의 경계는 항상 보인다. 장에도 제목은 없고 번호뿐이다. */}
                <header className="font-title text-xl leading-tight font-black">{chapter.number}장</header>
                {chapter.scenes.map((scene) => (
                  <SceneBlock
                    // 작업이 달라도 장면 id는 같을 수 있다(s1, s2 …).
                    key={`${sessionId}:${scene.id}`}
                    id={scene.id}
                    path={scene.path}
                    label={sceneMark(scene, chapter)}
                    chars={scene.chars}
                    prevId={prevOf.get(scene.id) ?? null}
                    hub={hub}
                  />
                ))}
                <div className="pt-3">
                  <Button small variant="quiet" className="-ml-2.5" onClick={() => void addScene({ chapter: chapter.id })}>
                    <PlusIcon />
                    장면
                  </Button>
                </div>
              </section>
            ))}

          {sessionId && manuscript && manuscript.chapters.length > 0 && (
            <div className="border-t border-hair pt-3">
              <Button small variant="quiet" className="-ml-2.5" onClick={() => void act((id) => api.addChapter(id, {}))}>
                <PlusIcon />
                장
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
