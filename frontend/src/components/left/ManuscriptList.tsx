import { useMemo, useRef, useState, type DragEvent } from "react";
import { api, download, type ExportFormat } from "../../lib/api";
import { barePath, formatChars } from "../../lib/labels";
import type { Chapter, Scene } from "../../lib/types";
import { useStore } from "../../store";
import { AutoTextarea, Button, Chevron, IconButton, MenuItem, Tag, Toggle } from "../ui";
import { ConfirmItem, DRAG_TYPE, DeletedItems, DropLine, FlagToggle, Grip, MenuLine, ROW_BUTTON, RowMenu, YIELD } from "./parts";

const EXPORTS: { format: ExportFormat; label: string }[] = [
  { format: "md", label: "마크다운" },
  { format: "txt", label: "텍스트" },
  { format: "html", label: "HTML(이미지 포함)" },
  { format: "zip", label: "마크다운 + 이미지 zip" },
];

/** 끌고 있는 것. */
type Drag = { kind: "scene" | "chapter"; id: string };
/** 놓일 자리. 장면은 `chapter` 장의 `after` 장면 뒤(null이면 장의 맨 앞), 장은 `after` 장 뒤(null이면 맨 앞). */
type Drop = { kind: "scene"; chapter: string; after: string | null } | { kind: "chapter"; after: string | null };

const sameDrop = (a: Drop | null, b: Drop | null) =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.after === b.after && (a.kind !== "scene" || b.kind !== "scene" || a.chapter === b.chapter));

/** 원고 탭: 장과 장면의 목록. 장면의 머리는 요약이다(제목은 없다). 대화 화면에서도 원고 화면에서도 같은 목록이다. */
export function ManuscriptList() {
  const ws = useStore((s) => s.ws);
  // 지금 실행의 기록. 실행은 보고 있는 대화가 아닌 대화에서 돌 수도 있는데, 원고는 대화들이 같이 쓴다.
  const items = useStore((s) => s.live);
  const openPath = useStore((s) => (s.drawer?.kind === "doc" ? s.drawer.path : null));
  const act = useStore((s) => s.act);
  const exportChapters = useStore((s) => s.exportChapters);

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  /** 요약을 그 자리에서 고치고 있는 장면이나 장의 id. */
  const [editing, setEditing] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  // 끌기 시작할 때 화면을 다시 그리면 브라우저가 끌기를 취소하는 일이 있어, 끄는 것은 상태가 아니라 ref에 둔다.
  const drag = useRef<Drag | null>(null);

  // 에이전트가 고치겠다고 내놓고 아직 답을 못 받은 장면.
  const waiting = useMemo(() => {
    const paths = new Set<string>();
    for (const it of items) {
      if (it.kind !== "ask" || it.answered || it.askKind !== "proposal" || !it.proposal) continue;
      paths.add(barePath(it.proposal.path));
      for (const s of it.proposal.scenes ?? []) paths.add(barePath(s.startsWith("원고/") ? s : `원고/${s}`));
    }
    return paths;
  }, [items]);

  if (!ws) return <div className="flex-1" />;
  const { manuscript, flags } = ws;
  const chapters = manuscript.chapters;

  const setLocked = (path: string, locked: boolean | null) => void act((id) => api.setFlags(id, path, { locked }));

  const toggleFold = (id: string) => {
    const next = new Set(folded);
    if (!next.delete(id)) next.add(id);
    setFolded(next);
  };

  const addScene = async (chapter?: string) => {
    const target = chapter ?? chapters[chapters.length - 1]?.id;
    const made = await act((id) => api.addScene(id, target ? { chapter: target } : { new_chapter: true }));
    if (!made) return;
    if (folded.has(made.chapter)) toggleFold(made.chapter);
    useStore.getState().openDoc(made.path);
  };

  const addChapter = () => void act((id) => api.addChapter(id, {}));

  // 요약은 에이전트가 붙인다 (엔진이 알아서 쓰지 않는다). 메뉴에서는 그 요청을 채팅창에 넣어 주기만 하고, 보내는 것은 사용자가 한다.
  const askSummaries = () => {
    const s = useStore.getState();
    s.setDraft("요약이 없거나 낡은 장면에 요약을 붙여 줘.");
    s.focusComposer();
  };

  /** 지운 장면은 목록에서 사라진다. 버전 기록으로 가는 길은 메뉴의 `삭제한 장면`에 있다 (act가 작업 공간과 함께 그 목록을 다시 받는다). */
  const removeScene = (scene: Scene) => void act((id) => api.deleteScene(id, scene.id));

  const processLog = async () => {
    const log = await act((id) => api.processLog(id));
    if (log) download(`${log.session_name} 제작 기록.md`, log.content);
  };

  /* ── 끌어서 순서 바꾸기 ── */

  const startDrag = (e: DragEvent, d: Drag) => {
    e.stopPropagation();
    drag.current = d;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_TYPE, `원고/${d.id}`); // 무엇이든 실어야 끌기가 시작되는 브라우저가 있다
  };
  const endDrag = () => {
    drag.current = null;
    setDrop(null);
  };
  /** 놓일 자리를 정한다. null이면 여기에는 못 놓는다(제자리이거나 끄는 것이 다른 종류). */
  const aim = (e: DragEvent, next: Drop | null) => {
    if (next) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
    // dragover는 쉬지 않고 온다. 자리가 그대로면 다시 그리지 않는다.
    setDrop((prev) => (sameDrop(prev, next) ? prev : next));
  };
  const upperHalf = (e: DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  };

  /** 끌고 있는 장면을 (chapter, after)에 놓는 것이 제자리가 아니면 그 자리를 돌려준다. */
  const sceneSpot = (chapter: string, after: string | null): Drop | null => {
    const d = drag.current;
    if (d?.kind !== "scene") return null;
    if (after === d.id) return null;
    const home = chapters.find((c) => c.scenes.some((s) => s.id === d.id));
    if (home && home.id === chapter) {
      const i = home.scenes.findIndex((s) => s.id === d.id);
      if ((home.scenes[i - 1]?.id ?? null) === after) return null;
    }
    return { kind: "scene", chapter, after };
  };

  const overScene = (e: DragEvent, chapter: Chapter, index: number) => {
    if (drag.current?.kind !== "scene") return;
    // 줄의 위쪽 반이면 이 장면 앞, 아래쪽 반이면 이 장면 뒤.
    const after = upperHalf(e) ? (chapter.scenes[index - 1]?.id ?? null) : chapter.scenes[index].id;
    aim(e, sceneSpot(chapter.id, after));
  };

  const overHeader = (e: DragEvent, chapter: Chapter) => {
    if (drag.current?.kind !== "scene") return;
    // 펼친 장의 머리 줄은 장의 맨 앞, 접은 장은 안이 안 보이니 맨 끝에 붙인다.
    const after = folded.has(chapter.id) ? (chapter.scenes[chapter.scenes.length - 1]?.id ?? null) : null;
    aim(e, sceneSpot(chapter.id, after));
  };

  const overChapter = (e: DragEvent, index: number) => {
    const d = drag.current;
    if (d?.kind !== "chapter") return;
    const after = upperHalf(e) ? (chapters[index - 1]?.id ?? null) : chapters[index].id;
    const i = chapters.findIndex((c) => c.id === d.id);
    const still = after === d.id || (chapters[i - 1]?.id ?? null) === after;
    aim(e, still ? null : { kind: "chapter", after });
  };

  const onDrop = (e: DragEvent) => {
    const d = drag.current;
    const spot = drop;
    endDrag(); // 다른 장으로 옮긴 줄은 새로 그려져서 dragend가 여기까지 안 올라온다. 여기서도 치운다.
    if (!d || !spot) return;
    e.preventDefault();
    if (d.kind === "scene" && spot.kind === "scene") void act((id) => api.moveScene(id, d.id, { chapter: spot.chapter, after: spot.after }));
    else if (d.kind === "chapter" && spot.kind === "chapter") void act((id) => api.moveChapter(id, d.id, spot.after));
  };

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 pr-2 pl-4">
        <span
          className="text-xs text-muted"
          title={`장 ${chapters.length} · 장면 ${chapters.reduce((n, c) => n + c.scenes.length, 0)} · 원고지 ${Math.ceil(manuscript.chars / 200).toLocaleString("ko-KR")}매`}
        >
          {formatChars(manuscript.chars)}
        </span>
        <span className="flex-1" />
        <FlagToggle always kind="locked" direct={flags["원고"]?.locked} effective={manuscript.locked} onChange={(v) => setLocked("원고", v)} />
        <RowMenu always>
          {(close) => (
            <>
              <MenuItem
                title="채팅창에 요청을 넣습니다"
                onClick={() => {
                  close();
                  askSummaries();
                }}
              >
                요약 요청
              </MenuItem>
              <DeletedItems zone="원고" title="삭제한 장면" close={close} />
              <MenuLine />
              <div className="px-2.5 pt-1 pb-0.5 text-xs text-muted">내보내기</div>
              {EXPORTS.map((x) => (
                <MenuItem
                  key={x.format}
                  onClick={() => {
                    close();
                    void act((id) => api.exportFile(id, x.format, { chapters: exportChapters }));
                  }}
                >
                  {x.label}
                </MenuItem>
              ))}
              {/* 켜고 꺼도 메뉴는 닫지 않는다. 고른 다음 바로 위의 형식을 누른다. */}
              <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
                <span className="flex-1">장 번호 넣기</span>
                <Toggle label="장 번호 넣기" checked={exportChapters} onChange={(v) => useStore.getState().setExportChapters(v)} />
              </div>
              <MenuLine />
              <MenuItem
                onClick={() => {
                  close();
                  void processLog();
                }}
              >
                제작 기록 내려받기
              </MenuItem>
            </>
          )}
        </RowMenu>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-hair px-1 pb-3"
        onDrop={onDrop}
        onDragEnd={endDrag}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
      >
        {chapters.map((chapter, ci) => {
          const isFolded = folded.has(chapter.id);
          const chapterPath = `원고/${chapter.id}`;
          const sceneDrop = drop?.kind === "scene" && drop.chapter === chapter.id ? drop : null;
          return (
            // @container: 패널이 좁으면 장 줄의 분량을 줄여 적는다 (아래).
            <section key={chapter.id} className={`@container relative shrink-0 py-1 ${ci > 0 ? "border-t border-hair" : ""}`} onDragOver={(e) => overChapter(e, ci)}>
              {drop?.kind === "chapter" && drop.after === (chapters[ci - 1]?.id ?? null) && <DropLine at="top" />}
              {drop?.kind === "chapter" && ci === chapters.length - 1 && drop.after === chapter.id && <DropLine at="bottom" />}

              <div
                // 접혀 있거나 비어 있는 장은 줄을 그을 장면이 없으니, 장의 줄을 물들여 놓일 자리를 보인다.
                className={`group/row relative flex h-9 items-center gap-1.5 rounded-md pr-1 pl-3 ${
                  sceneDrop && (isFolded || chapter.scenes.length === 0) ? "bg-blue-tint" : "hover:bg-sunken"
                }`}
                draggable
                onDragStart={(e) => startDrag(e, { kind: "chapter", id: chapter.id })}
                onDragOver={(e) => overHeader(e, chapter)}
              >
                <Grip className="top-2.5" />
                <span className="shrink-0 text-[13px] font-bold">{chapter.number}장</span>
                {/* 장의 이름은 번호뿐이다. 요약이 있으면 그 옆에 흐리게 한 줄 (없어도 남은 칸은 차지한다). */}
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted" title={chapter.summary || undefined}>
                  {chapter.summary}
                </span>
                {/* 장의 분량. 장면 줄의 글자 수처럼, 줄 끝의 조작이 드러나는 동안에는 자리를 내준다. */}
                {/* 좁은 패널에서는 글자 수만 남긴다. 장면 수까지 적으면 장의 요약이 두어 글자밖에 안 보인다. */}
                <span
                  className={`shrink-0 text-xs text-muted tabular-nums ${YIELD}`}
                  title={`장면 ${chapter.scenes.length} · 원고지 ${Math.ceil(chapter.scenes.reduce((n, s) => n + s.chars, 0) / 200).toLocaleString("ko-KR")}매`}
                >
                  <span className="hidden @min-[270px]:inline">장면 {chapter.scenes.length} · </span>
                  {formatChars(chapter.scenes.reduce((n, s) => n + s.chars, 0))}
                </span>
                <FlagToggle kind="locked" direct={flags[chapterPath]?.locked} effective={chapter.locked} onChange={(v) => setLocked(chapterPath, v)} />
                <RowMenu>
                  {(close) => (
                    <>
                      <MenuItem
                        onClick={() => {
                          close();
                          setEditing(chapter.id);
                        }}
                      >
                        요약 고치기
                      </MenuItem>
                      <MenuItem
                        onClick={() => {
                          close();
                          void addScene(chapter.id);
                        }}
                      >
                        장면 추가
                      </MenuItem>
                      <MenuLine />
                      {/* 장면이 남아 있는 장은 서버가 지우지 않는다(409). */}
                      <ConfirmItem
                        disabled={chapter.scenes.length > 0}
                        title={chapter.scenes.length > 0 ? "장면이 있는 장" : undefined}
                        onConfirm={() => {
                          close();
                          void act((id) => api.deleteChapter(id, chapter.id));
                        }}
                      />
                    </>
                  )}
                </RowMenu>
                <IconButton label={isFolded ? "펼치기" : "접기"} aria-expanded={!isFolded} className={ROW_BUTTON} onClick={() => toggleFold(chapter.id)}>
                  <Chevron right={isFolded} />
                </IconButton>
              </div>

              {editing === chapter.id && (
                <SummaryForm
                  value={chapter.summary}
                  onSave={(summary) => void act((id) => api.patchChapter(id, chapter.id, { summary }))}
                  onDone={() => setEditing(null)}
                />
              )}

              {!isFolded &&
                chapter.scenes.map((scene, si) =>
                  editing === scene.id ? (
                    <SummaryForm
                      key={scene.id}
                      value={scene.summary}
                      onSave={(summary) => void act((id) => api.patchScene(id, scene.id, { summary }))}
                      onDone={() => setEditing(null)}
                    />
                  ) : (
                    <SceneRow
                      key={scene.id}
                      scene={scene}
                      direct={flags[`원고/${scene.id}`]?.locked}
                      active={openPath !== null && barePath(openPath) === barePath(scene.path)}
                      waiting={waiting.has(barePath(scene.path))}
                      lineTop={sceneDrop !== null && sceneDrop.after === (chapter.scenes[si - 1]?.id ?? null)}
                      lineBottom={sceneDrop !== null && si === chapter.scenes.length - 1 && sceneDrop.after === scene.id}
                      onDragStart={(e) => startDrag(e, { kind: "scene", id: scene.id })}
                      onDragOver={(e) => overScene(e, chapter, si)}
                      onLock={(v) => setLocked(`원고/${scene.id}`, v)}
                      onEdit={() => setEditing(scene.id)}
                      onDelete={() => removeScene(scene)}
                    />
                  ),
                )}
            </section>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-hair px-2 py-1.5">
        <Button small variant="quiet" onClick={() => void addScene()}>
          + 장면
        </Button>
        <Button small variant="quiet" onClick={addChapter}>
          + 장
        </Button>
      </div>
    </>
  );
}

function SceneRow({
  scene,
  direct,
  active,
  waiting,
  lineTop,
  lineBottom,
  onDragStart,
  onDragOver,
  onLock,
  onEdit,
  onDelete,
}: {
  scene: Scene;
  /** 이 장면에 직접 건 수정 방지. 없으면 장이나 원고 전체의 것을 따른다. */
  direct: boolean | undefined;
  active: boolean;
  waiting: boolean;
  lineTop: boolean;
  lineBottom: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onLock: (value: boolean | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const state = scene.summary_state === "stale" ? "요약 낡음" : scene.summary_state === "manual" ? "직접 씀" : "";
  return (
    <div className="group/row relative flex items-start rounded-md py-1 pr-1 pl-3 hover:bg-sunken" draggable onDragStart={onDragStart} onDragOver={onDragOver}>
      {lineTop && <DropLine at="top" />}
      {lineBottom && <DropLine at="bottom" />}
      <Grip className="top-3" />
      {/* 장면의 머리는 요약이다. 번호·확인 대기·글자 수는 요약의 첫 줄 높이(28px)에 맞춰 둔다. */}
      <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => useStore.getState().openDoc(scene.path)}>
        <span className="w-4 shrink-0 text-xs leading-7 text-muted tabular-nums">{scene.number}</span>
        {/* 요약이 아직 없으면 본문의 첫 줄을 흐리게 대신 보인다. 그것도 없으면(빈 장면) 번호만 남는다. */}
        <span className={`line-clamp-3 min-w-0 flex-1 py-1 text-[13px] leading-5 ${active ? "text-blue" : scene.summary ? "" : "text-muted"}`}>
          {state && (
            <>
              <Tag>{state}</Tag>{" "}
            </>
          )}
          {scene.summary || scene.head}
        </span>
        {waiting && (
          <span className="flex h-7 shrink-0 items-center">
            <Tag tone="outline">확인 대기</Tag>
          </span>
        )}
        <span className={`shrink-0 text-xs leading-7 text-muted ${YIELD}`}>{formatChars(scene.chars)}</span>
      </button>
      <div className="flex h-7 shrink-0 items-center">
        <FlagToggle kind="locked" direct={direct} effective={scene.locked} onChange={onLock} />
        <RowMenu>
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  onEdit();
                }}
              >
                요약 고치기
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  useStore.getState().openDrawer({ kind: "history", path: scene.path });
                }}
              >
                버전 기록
              </MenuItem>
              <MenuLine />
              <ConfirmItem
                onConfirm={() => {
                  close();
                  onDelete();
                }}
              />
            </>
          )}
        </RowMenu>
      </div>
    </div>
  );
}

/** 장면이나 장의 요약을 그 자리에서 고친다. onSave에 null이 가면 요약을 지우는 것이다. */
function SummaryForm({ value, onSave, onDone }: { value: string; onSave: (summary: string | null) => void; onDone: () => void }) {
  const [summary, setSummary] = useState(value);

  const save = (clear: boolean) => {
    // 요약은 손댔을 때만 보낸다. 보내면 직접 쓴 요약이 되어 에이전트와 도구가 덮지 않는다.
    // 지우면(null) 요약이 없는 상태로 돌아가서 에이전트가 다시 붙일 수 있다. 글을 다 지우고 저장한 것도 지운 것으로 본다.
    const text = summary.trim();
    const changed = text !== value.trim();
    onDone();
    if (!clear && !changed) return;
    onSave(clear || !text ? null : text);
  };

  return (
    <form
      className="flex flex-col gap-1.5 py-2 pr-2 pl-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          // 요약 칸은 여러 줄이라 Enter는 줄을 바꾼다. Ctrl+Enter로 저장한다.
          e.preventDefault();
          save(false);
        }
      }}
    >
      <AutoTextarea autoFocus aria-label="요약" placeholder="요약" minRows={3} maxHeight={220} value={summary} onChange={(e) => setSummary(e.target.value)} className="!text-[13px]" />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button small variant="primary" type="submit">
          저장
        </Button>
        <Button small variant="quiet" disabled={!value} onClick={() => save(true)}>
          요약 삭제
        </Button>
        <Button small variant="quiet" className="ml-auto" onClick={onDone}>
          취소
        </Button>
      </div>
    </form>
  );
}
