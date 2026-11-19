import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { baseName, byLabel, formatChars, pathLabel } from "../lib/labels";
import { useDoc } from "../lib/useDoc";
import type { Item } from "../lib/types";
import { selectTools, useStore } from "../store";
import { TextEditor } from "./editor/TextEditor";
import { KindText } from "./KindText";
import { ArrowDownIcon, ExpandIcon, HistoryIcon, NoteIcon } from "./icons";
import { Button, IconButton, Popover, Spinner, inputClass } from "./ui";

/**
 * 작업 패널. 위에서 아래로 입력 → 도구 → 출력이 놓이고, 그 아래에 노트가 있다.
 * 모든 도구는 입력을 읽어 출력에 쓴다는 것이 이 배치 그대로 보인다.
 */
export function WorkPanel() {
  const ws = useStore((s) => s.ws);
  if (!ws) return null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-5">
      <InputBlock />
      <Flow />
      <ToolsBlock />
      <Flow />
      <OutputBlock />
      <NotesBlock />
    </div>
  );
}

function Flow() {
  return (
    <div className="flex justify-center py-1.5 text-edge">
      <ArrowDownIcon />
    </div>
  );
}

function BlockHead({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-1.5 flex min-h-7 items-end gap-2">
      <h3 className="head-bar">{title}</h3>
      {meta && <span className="min-w-0 truncate text-xs leading-[1.45] text-muted">{meta}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

function InputBlock() {
  const input = useStore((s) => s.ws!.input);
  const tools = useStore(selectTools);
  const openDrawer = useStore((s) => s.openDrawer);
  const doc = useDoc("입력");
  return (
    <section>
      <BlockHead title="입력" meta={[formatChars(input.chars), byLabel(input.by, tools)].filter(Boolean).join(" · ")}>
        <IconButton label="이전 입력" onClick={() => openDrawer({ kind: "runs" })}>
          <HistoryIcon />
        </IconButton>
        <IconButton label="크게 보기" onClick={() => openDrawer({ kind: "doc", path: "입력" })}>
          <ExpandIcon />
        </IconButton>
      </BlockHead>
      <div className="rounded-lg border border-line bg-bg px-3 py-2 focus-within:border-blue">
        {doc.text !== null && <TextEditor value={doc.text} loadId={doc.loadId} onChange={doc.edit} onBlur={() => void doc.flush()} path="입력" variant="plain" minHeight={84} maxHeight={240} />}
      </div>
    </section>
  );
}

/** 지금 돌고 있는 사용자 도구. */
function runningTool(items: Item[]) {
  const last = [...items].reverse().find((it) => it.kind === "tool" && it.userTool);
  if (!last || last.kind !== "tool" || last.result !== undefined) return null;
  // 실행 확인을 기다리는 동안에는 아직 돌고 있는 것이 아니다.
  const confirming = items.some((it) => it.kind === "ask" && !it.answered && it.askKind === "tool_confirm" && it.tool === last.tool);
  return confirming ? null : last;
}

function ToolsBlock() {
  const tools = useStore(selectTools);
  const insertCommand = useStore((s) => s.insertCommand);
  const openDialog = useStore((s) => s.openDialog);
  // 입력과 출력은 작업에 하나라서, 어느 대화에서 도는 실행이든 여기에 보인다 (live는 지금 실행의 기록).
  const active = useStore((s) => (s.running ? (runningTool(s.live)?.tool ?? null) : null));
  const enabled = tools.filter((t) => t.enabled && t.prompt.trim());
  return (
    <section>
      <BlockHead title="도구" meta={enabled.length < tools.length ? `${enabled.length} / ${tools.length}` : undefined}>
        <Button small variant="quiet" onClick={() => openDialog({ type: "tool", name: null })}>
          + 도구
        </Button>
      </BlockHead>
      <div className="flex flex-col">
        {enabled.map((t) => (
          <div key={t.name} className={`group flex items-center gap-1 rounded-lg ${active === t.name ? "bg-agent-tint" : "hover:bg-sunken"}`}>
            <button
              type="button"
              title={`채팅창에 /${t.label}`}
              onClick={() => insertCommand(t.label)}
              className="flex min-w-0 flex-1 flex-col border-0 bg-transparent px-2.5 py-1.5 text-left"
            >
              <span className="flex items-center gap-2 font-bold">
                <span className="text-agent">/{t.label}</span>
                {active === t.name && <Spinner />}
              </span>
              {t.description && <span className="truncate text-xs text-muted">{t.description}</span>}
            </button>
            <button
              type="button"
              onClick={() => openDialog({ type: "tool", name: t.name })}
              className="mr-1.5 border-0 bg-transparent px-1.5 py-1 text-xs text-muted opacity-0 group-hover:opacity-100 hover:text-blue focus:opacity-100"
            >
              편집
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function OutputBlock() {
  const output = useStore((s) => s.ws!.output);
  const tools = useStore(selectTools);
  const openDrawer = useStore((s) => s.openDrawer);
  const stream = useStore((s) => (s.running ? (runningTool(s.live)?.stream ?? null) : null));
  const doc = useDoc("출력");
  const toolLabel = tools.find((t) => t.name === output.tool)?.label ?? output.tool;

  // 도구가 끝나면 스트림은 사라지고 출력 문서를 다시 읽는다. 그 사이에 옛 글(대개 빈 칸)이 번쩍이지 않게,
  // 다시 읽은 글이 올 때까지(길어야 0.8초) 마지막 스트림을 그대로 둔다.
  const [held, setHeld] = useState<{ text: string; loadId: number } | null>(null);
  const lastStream = useRef<string | null>(null);
  const streaming = stream !== null;
  if (streaming) lastStream.current = stream;
  const loadId = doc.loadId;
  useLayoutEffect(() => {
    if (streaming || lastStream.current === null) return;
    setHeld({ text: lastStream.current, loadId });
    lastStream.current = null;
    const timer = setTimeout(() => setHeld(null), 800);
    return () => clearTimeout(timer);
    // 스트림이 끝난 순간에만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);
  const shown = stream ?? (held && held.loadId === loadId ? held.text : null);

  // 칸보다 긴 글이 쓰이는 동안에는 쓰이고 있는 끝을 따라 내려간다. 위로 올려 읽고 있으면 그대로 둔다.
  const streamBox = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = streamBox.current;
    if (el && streaming && follow.current) el.scrollTop = el.scrollHeight;
  }, [stream, streaming]);
  useLayoutEffect(() => {
    if (streaming) follow.current = true;
  }, [streaming]);
  return (
    <section>
      <BlockHead title="출력" meta={[formatChars(output.chars), toolLabel].filter(Boolean).join(" · ")}>
        <IconButton label="이전 출력" onClick={() => openDrawer({ kind: "runs" })}>
          <HistoryIcon />
        </IconButton>
        <IconButton label="크게 보기" onClick={() => openDrawer({ kind: "doc", path: "출력" })}>
          <ExpandIcon />
        </IconButton>
      </BlockHead>
      <div className={`rounded-lg border px-3 py-2 ${stream !== null ? "border-agent bg-agent-tint" : "border-line bg-bg focus-within:border-blue"}`}>
        {shown !== null ? (
          // 글자 모양은 아래 편집기(side)와 같게 한다. 끝났을 때 글이 다른 모양으로 바뀌어 보이지 않게.
          <div
            ref={streamBox}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className={`tk-text max-h-60 min-h-[84px] overflow-y-auto font-[family-name:var(--font-body-side,var(--font-sans))] text-sm leading-[1.7] whitespace-pre-wrap [overflow-wrap:anywhere] ${streaming ? "caret" : ""}`}
          >
            <KindText text={shown} />
          </div>
        ) : (
          doc.text !== null && <TextEditor value={doc.text} loadId={doc.loadId} onChange={doc.edit} onBlur={() => void doc.flush()} path="출력" variant="side" minHeight={84} maxHeight={240} />
        )}
      </div>
      {output.chars > 0 && stream === null && <OutputActions />}
    </section>
  );
}

/** 출력을 원고나 자료로 보낸다. 보내면 출력은 비워진다. */
export function OutputActions() {
  const act = useStore((s) => s.act);
  const touch = useStore((s) => s.touch);
  const notify = useStore((s) => s.notify);
  const jumpToScene = useStore((s) => s.jumpToScene);
  const running = useStore((s) => s.running);
  const [dest, setDest] = useState("");

  const toManuscript = async () => {
    const made = await act((id) => api.addScene(id, { from_output: true }));
    if (!made) return;
    touch(["출력", made.path]);
    notify("원고에 넣음");
    jumpToScene(made.id);
  };
  const toMaterial = async (close: () => void) => {
    const name = dest.trim().replace(/^\/+|\/+$/g, "");
    if (!name) return;
    const moved = await act((id) => api.moveDoc(id, "출력", `자료/${name.replace(/^자료\//, "")}`));
    if (!moved) return;
    touch(["출력", moved.path]);
    notify(`${pathLabel(moved.path, null)}에 저장됨`);
    setDest("");
    close();
  };

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button small disabled={running} onClick={() => void toManuscript()}>
        원고에 넣기
      </Button>
      <Popover
        trigger={(open, toggle) => (
          <Button small disabled={running} aria-expanded={open} onClick={toggle}>
            자료로 옮기기
          </Button>
        )}
      >
        {(close) => (
          <form
            className="flex w-72 max-w-full items-end gap-2 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void toMaterial(close);
            }}
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
              폴더/이름
              <input autoFocus value={dest} onChange={(e) => setDest(e.target.value)} className={inputClass} />
            </label>
            <Button small variant="primary" type="submit" disabled={!dest.trim()}>
              옮기기
            </Button>
          </form>
        )}
      </Popover>
    </div>
  );
}

/** 노트 옵션을 켠 자료. 에이전트가 항상 읽는 것들이다. */
function NotesBlock() {
  const notes = useStore((s) => s.ws!.materials).filter((m) => m.note);
  const openDoc = useStore((s) => s.openDoc);
  const setLeftTab = useStore((s) => s.setLeftTab);
  return (
    <section className="mt-7">
      <BlockHead title="노트" meta={notes.length ? String(notes.length) : undefined}>
        <Button small variant="quiet" onClick={() => setLeftTab("materials")}>
          자료에서 고르기
        </Button>
      </BlockHead>
      <div className="flex flex-col">
        {notes.map((m) => (
          <button key={m.path} type="button" onClick={() => openDoc(m.path)} className="flex items-center gap-2 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-left hover:bg-sunken">
            <span className="text-blue">
              <NoteIcon />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {baseName(m.path)}
              <span className="ml-2 text-xs text-muted">{pathLabel(m.path, null).split("/").slice(0, -1).join("/")}</span>
            </span>
            <span className="shrink-0 text-xs text-muted">{formatChars(m.chars)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
