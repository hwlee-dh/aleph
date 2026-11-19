import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { barePath, byLabel, findScene, formatChars, formatDuration, formatSize, formatWhen, modelShort, pathLabel } from "../lib/labels";
import type { HistoryEntry, ToolDef, ToolRun } from "../lib/types";
import { useDoc } from "../lib/useDoc";
import { selectTools, useStore, type Drawer } from "../store";
import { CompareView, RerunButton, useToolRuns } from "./CompareView";
import { TextEditor, type TextEditorHandle } from "./editor/TextEditor";
import { Chevron, CloseIcon, HistoryIcon } from "./icons";
import { KindText } from "./KindText";
import { Button, IconButton, Segmented, Tag } from "./ui";
import { OutputActions } from "./WorkPanel";

/** 오른쪽에서 밀려 나오는 넓은 패널. 문서를 크게 보거나, 이전 입력·출력, 같은 입력의 결과 비교, 버전 기록을 본다. */
export function DrawerPanel({ drawer }: { drawer: Drawer }) {
  if (drawer.kind === "runs") return <RunsView seq={drawer.seq} />;
  if (drawer.kind === "compare") return <CompareView key={drawer.seq ?? "latest"} seq={drawer.seq} />;
  if (drawer.kind === "history") return <HistoryView key={drawer.path} path={drawer.path} />;
  return <DocView key={barePath(drawer.path)} path={barePath(drawer.path)} />;
}

export function Frame({ title, tags, actions, children }: { title: ReactNode; tags?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const close = useStore((s) => s.closeDrawer);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-hair pr-3 pl-6">
        <div className="min-w-0 truncate text-[15px] font-black">{title}</div>
        {tags}
        <span className="flex-1" />
        {actions}
        <IconButton label="닫기" onClick={close}>
          <CloseIcon />
        </IconButton>
      </div>
      {children}
    </div>
  );
}

function DocView({ path }: { path: string }) {
  const ws = useStore((s) => s.ws);
  const sessionId = useStore((s) => s.sessionId);
  const tools = useStore(selectTools);
  const openDrawer = useStore((s) => s.openDrawer);
  const material = ws?.materials.find((m) => barePath(m.path) === path);
  // 그림과 파일(글을 못 뽑은 PDF 등)은 읽을 글이 없다. 읽으려 들면 서버가 오류를 준다.
  const doc = useDoc(material && material.kind !== "text" ? null : path);
  // PDF는 브라우저가 그대로 보여 준다. 그 밖의 파일은 크기만 보인다.
  const pdf = material?.kind === "file" && /\.pdf$/i.test(material.path) && sessionId ? api.fileUrl(sessionId, material.path) : "";
  const scene = path.startsWith("원고/") ? findScene(ws, path) : null;
  const isIo = path === "입력" || path === "출력";
  const info = scene ? scene.scene : material ? material : path === "입력" ? ws?.input : path === "출력" ? ws?.output : null;
  const locked = scene?.scene.locked ?? material?.locked ?? false;
  // 그림과 파일은 글자 수가 없다. 크기를 보인다.
  const amount = material && material.kind !== "text" ? formatSize(material.size) : info ? formatChars(info.chars) : "";
  const meta = [amount, info ? byLabel(info.by, tools) : "", info ? formatWhen(info.updated_at) : ""].filter(Boolean).join(" · ");

  // 빈 문서(방금 만든 문서)를 열면 바로 쓸 수 있게 편집기에 초점을 준다.
  const editor = useRef<TextEditorHandle>(null);
  const empty = doc.text === "";
  const loadId = doc.loadId;
  useEffect(() => {
    if (loadId === 1 && empty) editor.current?.focus();
    // 처음 읽어 왔을 때 한 번만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadId]);

  return (
    <Frame
      title={
        scene || isIo ? (
          pathLabel(path, ws)
        ) : (
          <>
            <span className="font-normal text-muted">{path.replace(/^자료\//, "").split("/").slice(0, -1).join(" / ")}</span>
            {path.split("/").length > 2 && <span className="font-normal text-muted"> / </span>}
            {path.split("/").pop()}
          </>
        )
      }
      tags={
        <>
          {locked && <Tag tone="outline">수정 방지</Tag>}
          {material?.note && <Tag tone="plain">노트</Tag>}
          <span className="ml-1 hidden truncate text-xs text-muted sm:inline">{meta}</span>
        </>
      }
      actions={
        isIo ? (
          <IconButton label={path === "입력" ? "이전 입력" : "이전 출력"} onClick={() => openDrawer({ kind: "runs" })}>
            <HistoryIcon />
          </IconButton>
        ) : (
          <IconButton label="버전 기록" onClick={() => openDrawer({ kind: "history", path })}>
            <HistoryIcon />
          </IconButton>
        )
      }
    >
      {pdf ? (
        <iframe src={pdf} title={path.split("/").pop() ?? ""} className="min-h-0 w-full flex-1 border-0" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-16">
          {doc.error && <div className="text-[13px] text-danger">{doc.error}</div>}
          {material?.kind === "image" && sessionId ? (
            <img src={api.fileUrl(sessionId, material.path)} alt={path.split("/").pop() ?? ""} className="mx-auto max-h-[80vh] max-w-full" />
          ) : material?.kind === "file" ? (
            <div className="text-[13px] text-muted">{formatSize(material.size)}</div>
          ) : (
            doc.text !== null && (
              <div className={`mx-auto ${scene || path === "출력" ? "max-w-[var(--body-width,720px)]" : "max-w-[720px]"}`}>
                {path === "출력" && doc.text.trim() && (
                  <div className="mb-4">
                    <OutputActions />
                  </div>
                )}
                <TextEditor
                  ref={editor}
                  value={doc.text}
                  loadId={doc.loadId}
                  onChange={doc.edit}
                  onBlur={() => void doc.flush()}
                  path={path}
                  variant={scene || path === "출력" ? "manuscript" : "plain"}
                  minHeight={320}
                />
              </div>
            )
          )}
        </div>
      )}
    </Frame>
  );
}


/** 도구 실행 기록. 이전 입력과 출력을 다시 본다. */
function RunsView({ seq }: { seq?: number }) {
  const sessionId = useStore((s) => s.sessionId);
  const fail = useStore((s) => s.fail);
  const touch = useStore((s) => s.touch);
  const notify = useStore((s) => s.notify);
  const openDrawer = useStore((s) => s.openDrawer);
  const runs = useToolRuns();
  const [picked, setPicked] = useState<number | null>(seq ?? null);
  const [show, setShow] = useState<"input" | "raw" | "output">("output");

  const ws = useStore((s) => s.ws);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set()); // 펼쳐 둔 묶음 (tool_call_id)

  const list = [...(runs ?? [])].reverse();
  const run = list.find((r) => r.seq === picked) ?? list[0];
  // 묶음 요약은 장면마다 한 줄씩 남긴다 (target이 있고 tool_call_id가 같다). 그것들은 한 줄로 접어 둔다.
  const rows: ({ batch: null; run: ToolRun } | { batch: string; runs: ToolRun[] })[] = [];
  const batches = new Map<string, ToolRun[]>();
  for (const r of list) {
    const id = r.target && r.tool_call_id ? r.tool_call_id : "";
    if (!id) {
      rows.push({ batch: null, run: r });
      continue;
    }
    let batch = batches.get(id);
    if (!batch) {
      batch = [];
      batches.set(id, batch);
      rows.push({ batch: id, runs: batch });
    }
    batch.unshift(r); // 목록은 최신이 위지만 묶음 안은 돌린 순서(원고의 순서)대로 보인다
  }
  const toggle = (id: string, first: ToolRun) => {
    const next = new Set(open);
    if (next.delete(id)) return setOpen(next);
    setOpen(next.add(id));
    setPicked(first.seq);
  };
  const runRow = (r: ToolRun, inBatch: boolean) => (
    <button
      key={r.seq}
      type="button"
      onClick={() => setPicked(r.seq)}
      className={`flex w-full flex-col border-0 py-1.5 pr-4 text-left ${inBatch ? "pl-7" : "pl-4"} ${run?.seq === r.seq ? "bg-blue-tint" : "bg-transparent hover:bg-sunken"}`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`min-w-0 truncate ${inBatch ? "text-[13px]" : "font-bold"} ${r.error ? "text-danger" : run?.seq === r.seq ? "text-blue" : ""}`}>
          {inBatch && r.target ? pathLabel(r.target, ws) : r.label || r.tool}
        </span>
        {r.trial && <Tag>시험</Tag>}
      </span>
      {!inBatch && (
        <span className="text-xs text-muted">
          {formatWhen(r.timestamp)} · {r.by === "user" ? "직접 실행" : "에이전트"}
        </span>
      )}
    </button>
  );
  // 같은 입력(풀린 전문이 같은 것)으로 돌린 실행의 수. 둘 이상이면 나란히 놓고 볼 것이 있다.
  const same = run ? list.filter((r) => r.input === run.input).length : 0;
  const reuse = async (text: string, where: "입력" | "출력") => {
    if (!sessionId) return;
    try {
      await api.saveDoc(sessionId, where, text);
      touch([where]);
      notify(`${where}에 다시 넣음`);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Frame title="이전 입력·출력" tags={runs ? <span className="text-xs text-muted">{runs.length}</span> : null}>
      <div className="flex min-h-0 flex-1">
        <div className="w-36 shrink-0 overflow-y-auto border-r border-hair py-2 lg:w-52">
          {rows.map((row) => {
            if (row.batch === null) return runRow(row.run, false);
            const first = row.runs[0];
            const expanded = open.has(row.batch);
            // 접혀 있는데 그 안의 것을 보고 있으면 묶음 줄에 표시한다.
            const holds = !expanded && row.runs.some((r) => r.seq === run?.seq);
            return (
              <div key={row.batch}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(row.batch, first)}
                  className={`flex w-full flex-col border-0 px-4 py-1.5 text-left ${holds ? "bg-blue-tint" : "bg-transparent hover:bg-sunken"}`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={`min-w-0 truncate font-bold ${row.runs.some((r) => r.error) ? "text-danger" : holds ? "text-blue" : ""}`}>{first.label || first.tool}</span>
                    <span className="shrink-0 text-xs text-muted">{row.runs.length}</span>
                    <span className="ml-auto shrink-0 text-muted">
                      <Chevron up={expanded} />
                    </span>
                  </span>
                  <span className="text-xs text-muted">{formatWhen(first.timestamp)} · 묶음</span>
                </button>
                {expanded && row.runs.map((r) => runRow(r, true))}
              </div>
            );
          })}
        </div>
        {run && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pt-3 pb-2">
              <Segmented
                label="볼 것"
                value={show}
                onChange={setShow}
                options={[
                  { value: "raw", label: "입력", title: "입력에 적혀 있던 그대로" },
                  { value: "input", label: "입력 전문", title: "@include가 풀린 뒤, 도구에 실제로 들어간 글" },
                  { value: "output", label: "출력" },
                ]}
              />
              <span className="text-xs text-muted">{[modelShort(run.model), formatDuration(run.duration_ms)].filter(Boolean).join(" · ")}</span>
              <span className="flex-1" />
              {show === "raw" && (
                <Button small onClick={() => void reuse(run.input_raw, "입력")}>
                  입력에 다시 넣기
                </Button>
              )}
              {show === "output" && run.output && (
                <Button small onClick={() => void reuse(run.output, "출력")}>
                  출력에 다시 넣기
                </Button>
              )}
              <Button small variant="quiet" onClick={() => openDrawer({ kind: "compare", seq: run.seq })}>
                {same > 1 ? `비교 ${same}` : "비교"}
              </Button>
              <RerunButton run={run} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12">
              {run.error && <div className="mb-2 text-[13px] text-danger">{run.error}</div>}
              <div
                className={`mx-auto whitespace-pre-wrap [overflow-wrap:anywhere] ${
                  show === "output" ? "manuscript tk-text max-w-[var(--body-width,720px)]" : "max-w-[720px] text-sm leading-relaxed"
                }`}
              >
                {show === "output" ? <KindText text={run.output} /> : show === "raw" ? run.input_raw : run.input}
              </div>
            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}

const ACTION: Record<HistoryEntry["action"], string> = { write: "수정", delete: "삭제", move: "이동" };

/** 그 변경이 어디서 비롯했는지 (엔진이 origin에 적어 준다). */
function originLabel(e: HistoryEntry): string {
  const o = e.origin ?? {};
  if (o.restored_from) return "복원";
  if (o.split_from) return "나누기";
  if (o.merged) return "합치기";
  if (o.uploaded) return "올린 파일";
  if (o.from_output) return "출력에서";
  return "";
}

/** 목록의 둘째 줄: 누가·무엇을·몇 자. */
function entryLine(e: HistoryEntry, tools: ToolDef[]): string {
  if (e.action !== "write") return [ACTION[e.action], e.by === "agent" ? "에이전트" : "", e.action === "move" ? formatChars(e.chars) : ""].filter(Boolean).join(" · ");
  return [e.tool_run?.label ?? (byLabel(e.by, tools) || ACTION.write), originLabel(e), formatChars(e.chars)].filter(Boolean).join(" · ");
}

/** 문서 하나의 버전 기록. 예전 버전을 보고, 그 버전으로 복원한다. */
function HistoryView({ path }: { path: string }) {
  const ws = useStore((s) => s.ws);
  const sessionId = useStore((s) => s.sessionId);
  const tools = useStore(selectTools);
  const rev = useStore((s) => s.rev[barePath(path)] ?? 0);
  const fail = useStore((s) => s.fail);
  const touch = useStore((s) => s.touch);
  const notify = useStore((s) => s.notify);
  const openDrawer = useStore((s) => s.openDrawer);
  const remembered = useStore((s) => s.deleted.find((d) => d.path === barePath(path))?.label);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [picked, setPicked] = useState<HistoryEntry | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    api
      .history(sessionId, path)
      .then((e) => {
        if (!alive) return;
        const sorted = [...e].sort((a, b) => b.seq - a.seq);
        setEntries(sorted);
        // 지워진 문서는 맨 위가 `삭제` 줄이라 볼 글이 없다. 지워지기 직전의 글을 먼저 보인다.
        const lastText = sorted[0]?.action === "delete" ? sorted.find((x) => x.action !== "delete") : undefined;
        setPicked((cur) => sorted.find((x) => x.seq === cur?.seq) ?? lastText ?? sorted[0] ?? null);
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [sessionId, path, rev, fail]);

  useEffect(() => {
    setContent(null);
    if (!sessionId || !picked?.hash || picked.action === "delete") return;
    let alive = true;
    api
      .version(sessionId, picked.hash)
      .then((c) => alive && setContent(c))
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [sessionId, picked, fail]);

  const latest = entries?.[0];
  const body = path.startsWith("원고/") || barePath(path) === "출력";
  // 지워진 문서나 장면인가. 목록에 없으니 `문서로`는 갈 곳이 없다.
  const gone = ws !== null && (path.startsWith("원고/") ? !findScene(ws, path) : !ws.materials.some((m) => barePath(m.path) === barePath(path)));
  // 지금 글과 같은 버전은 복원할 것이 없다. `이동` 줄도 그때의 글을 갖고 있어 복원할 수 있다.
  const restorable = !!picked && picked.action !== "delete" && !!picked.hash && content !== null && (gone || picked.hash !== latest?.hash);
  const restore = async () => {
    if (!sessionId || !picked) return;
    try {
      const restored = (await api.restore(sessionId, path, picked.hash)) as { path?: string } | null;
      const to = restored?.path ?? path;
      const s = useStore.getState();
      touch([to]);
      await s.refreshWorkspace();
      if (barePath(to) !== barePath(path)) {
        // 지운 장면은 원고 끝에 새 장면으로 돌아온다. 그 장면의 기록으로 옮겨 가고, 원고 화면이면 그 자리로 간다.
        openDrawer({ kind: "history", path: barePath(to) });
        if (s.screen === "manuscript" && to.startsWith("원고/")) s.jumpToScene(barePath(to).slice(3));
        notify("원고 끝에 복원함");
      } else notify(gone ? "복원함" : "이 버전으로 복원함");
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Frame
      title={
        <>
          <span className="font-normal text-muted">버전 기록 · </span>
          {gone ? (remembered ?? pathLabel(path, ws)) : pathLabel(path, ws)}
        </>
      }
      tags={gone && entries !== null ? <Tag tone="plain">삭제됨</Tag> : null}
      actions={
        gone ? null : (
          <Button small variant="quiet" onClick={() => openDrawer({ kind: "doc", path })}>
            문서로
          </Button>
        )
      }
    >
      <div className="flex min-h-0 flex-1">
        <div className="w-40 shrink-0 overflow-y-auto border-r border-hair py-2 lg:w-56">
          {(entries ?? []).map((e) => (
            <button
              key={e.seq}
              type="button"
              onClick={() => setPicked(e)}
              className={`flex w-full flex-col border-0 px-4 py-1.5 text-left ${picked?.seq === e.seq ? "bg-blue-tint" : "bg-transparent hover:bg-sunken"}`}
            >
              <span className="flex items-center gap-1.5">
                <span className={picked?.seq === e.seq ? "font-bold text-blue" : "font-bold"}>{formatWhen(e.timestamp)}</span>
                {e === latest && !gone && <Tag tone="plain">현재</Tag>}
                {e.proposal?.status === "rejected" && <Tag tone="plain">반려</Tag>}
              </span>
              <span className="text-xs text-muted">{entryLine(e, tools)}</span>
            </button>
          ))}
        </div>
        {picked && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pt-3 pb-2 text-xs text-muted">
              {picked.tool_run && (
                <Button small variant="quiet" onClick={() => openDrawer({ kind: "runs", seq: picked.tool_run!.run_seq })}>
                  이때의 입력
                </Button>
              )}
              {picked.proposal?.note && <span>반려 사유: {picked.proposal.note}</span>}
              {picked.action === "move" && picked.to && <span>→ {pathLabel(picked.to, ws)}</span>}
              <span className="flex-1" />
              {restorable && (
                <Button small variant="primary" onClick={() => void restore()}>
                  {gone ? "복원" : "이 버전으로 복원"}
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12">
              {/* 글의 종류별 꾸밈은 본문(장면, 출력)의 기록에만 건다. 자료의 기록은 글만 보인다. */}
              {body ? (
                <div className="manuscript tk-text mx-auto max-w-[var(--body-width,720px)]">{content !== null && <KindText text={content} />}</div>
              ) : (
                <div className="manuscript mx-auto max-w-[720px]">{content}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}
