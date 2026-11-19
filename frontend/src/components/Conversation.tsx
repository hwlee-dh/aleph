import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { diffBlocks, diffWords } from "../lib/diff";
import { MODE_LABEL, barePath, findScene, formatChars, formatDuration, formatTokens, modelShort, pathLabel, sceneLabel, splitQuote } from "../lib/labels";
import type { Item, LastRun, Proposal, Workspace } from "../lib/types";
import { selectRunningHere, selectTools, useStore } from "../store";
import { Button, Markdown, Popover, Spinner, Tag, TextButton } from "./ui";

type ToolItem = Extract<Item, { kind: "tool" }>;
type AskItem = Extract<Item, { kind: "ask" }>;
/** 그릴 단위. 이어진 도구 호출은 한 묶음이다. */
type Group = Item | { kind: "tools"; key: string; tools: ToolItem[]; reverted?: boolean };

/** 대화. 대화 화면에서는 가운데에, 원고 화면에서는 오른쪽 패널에 놓인다. */
export function Conversation() {
  const items = useStore((s) => s.items);
  const sessionId = useStore((s) => s.sessionId);
  const conversationId = useStore((s) => s.conversationId);
  // 되돌릴 수 있는 것은 작업에서 마지막으로 돈 실행이다. 그것이 이 대화의 실행일 때만 여기에 `되돌리기`를 둔다.
  const lastRunHere = useStore((s) => s.runConversation === null || s.runConversation === s.conversationId);
  const running = useStore((s) => s.running);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // 맨 아래를 보고 있을 때만 새 글을 따라 내려간다
  // 마지막으로 잰 크기. 스크롤 이벤트가 사용자의 스크롤인지, 칸의 크기가 바뀌어 생긴 것인지 가른다.
  const size = useRef({ width: 0, height: 0 });
  const lastUser = useRef("");

  /** 따라 내려가는 중이면 맨 아래에 붙이고, 지금 크기를 적어 둔다. */
  const settle = () => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    size.current = { width: el.clientWidth, height: el.clientHeight };
  };

  useLayoutEffect(() => {
    // 내가 방금 보낸 말은 어디를 보고 있었든 보이게 한다 (그 뒤의 확인 카드가 화면 밖에 남지 않게).
    const mine = [...items].reverse().find((it) => it.kind === "user");
    if (mine && mine.key !== lastUser.current) {
      if (lastUser.current) stick.current = true;
      lastUser.current = mine.key;
    }
    settle();
  }, [items]);
  useEffect(() => {
    stick.current = true;
    lastUser.current = "";
  }, [sessionId, conversationId]);
  // 옆 패널을 여닫아 칸의 폭이 바뀌면 글의 높이도 바뀐다. 맨 아래를 보고 있었으면 그대로 맨 아래에 둔다.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const watch = new ResizeObserver(settle);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  /*
   * 되돌릴 수 있는 것은 가장 최근의 실행 하나뿐이다. 그 완료 줄에만 `되돌리기`를 둔다.
   * 실행 중이거나 이미 되돌렸으면 두지 않는다.
   * 완료 줄 없이 끝난 실행(서버가 꺼짐)이 뒤에 있으면 앞 실행의 완료 줄은 가장 최근의 것이 아니다.
   */
  // 시험 실행은 되돌리기의 대상이 아니다. 시험 실행 뒤에도 그 앞의 진짜 실행을 되돌릴 수 있다.
  const trials = new Set(items.filter((it) => (it.kind === "run" || it.kind === "tool") && it.trial).map((it) => it.run));
  const doneAt = items.findLastIndex((it) => it.kind === "done" && !trials.has(it.run));
  const runAt = items.findLastIndex((it) => it.kind === "run" && !trials.has(it.run));
  const last = doneAt > runAt ? items[doneAt] : null;
  const revertKey = !running && lastRunHere && last?.run && !last.reverted ? last.key : null;

  // 이어진 도구 호출은 한 묶음으로 그린다.
  const groups: Group[] = [];
  for (const it of items) {
    const prev = groups[groups.length - 1];
    if (it.kind === "tool" && prev?.kind === "tools") prev.tools.push(it);
    else if (it.kind === "tool") groups.push({ kind: "tools", key: `g-${it.key}`, tools: [it], reverted: it.reverted });
    else groups.push(it);
  }

  const draw = (g: Group): ReactNode => {
    switch (g.kind) {
      case "run":
        return g.runKind === "tool" ? <div className="ml-auto rounded-full bg-blue-tint px-3 py-1 text-[13px] font-bold text-blue">{g.trial ? "시험 실행" : "직접 실행"}</div> : null;
      case "user":
        return <UserTurn item={g} />;
      case "text":
        return (
          <div className={g.streaming ? "caret" : ""}>
            <Markdown>{g.text}</Markdown>
          </div>
        );
      case "thinking":
        return <Thinking text={g.text} streaming={g.streaming} />;
      case "tools":
        return <ToolGroup tools={g.tools} />;
      case "ask":
        return <Ask item={g} />;
      case "note":
        return (
          <div className={`text-[13px] ${g.tone === "error" ? "text-danger" : "text-muted"}`}>
            {g.tone === "warn" && <Tag tone="warn">주의</Tag>} {g.text}
            {g.detail && (
              <details className="mt-1">
                <summary className="cursor-pointer">요약 보기</summary>
                <div className="mt-1 whitespace-pre-wrap">{g.detail}</div>
              </details>
            )}
          </div>
        );
      case "done":
        return <DoneLine item={g} revertible={g.key === revertKey} />;
      default:
        return null;
    }
  };

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        // 크기가 바뀌면서 브라우저가 스크롤을 옮긴 것은 사용자의 뜻이 아니다.
        if (el.clientWidth !== size.current.width || el.clientHeight !== size.current.height) return settle();
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-5 px-5 pt-6 pb-4">
        {groups.map((g) => {
          const node = draw(g);
          if (node === null) return null;
          // 되돌린 실행은 흐리게 그린다. 완료 줄은 `되돌림` 꼬리표가 읽혀야 하니 그대로 둔다.
          // 감싸는 칸도 세로로 쌓는 flex여야 내 말풍선이 제 폭으로 오른쪽에 붙는다.
          if (g.reverted && g.kind !== "done")
            return (
              <div key={g.key} className="flex flex-col opacity-50">
                {node}
              </div>
            );
          return <Fragment key={g.key}>{node}</Fragment>;
        })}
      </div>
    </div>
  );
}

/** 내 말. 오른쪽에 붙는 둥근 말풍선. */
function UserTurn({ item }: { item: Extract<Item, { kind: "user" }> }) {
  const tools = useStore(selectTools);
  const ws = useStore((s) => s.ws);
  const quoted = splitQuote(item.text);
  const tool = item.tool ? (item.toolLabel ?? tools.find((t) => t.name === item.tool)?.label ?? item.tool) : null;
  const body = quoted ? quoted.message : item.text;
  // 도구 이름은 따로 붙여 보이므로, 글머리에 `/도구`가 남아 있으면 뗀다.
  const text = tool && body.startsWith(`/${tool}`) ? body.slice(tool.length + 1).trimStart() : body;
  const bubble = (place: string) => (
    <div className={`flex flex-col gap-1.5 rounded-[18px] rounded-br-md bg-blue-tint px-4 py-2.5 ${place}`}>
      {quoted && (
        <div className="border-l-[3px] border-mark pl-2.5 text-[13px]">
          <div className="text-xs text-muted">{pathLabel(quoted.path, ws)}</div>
          <div className="line-clamp-4 font-serif whitespace-pre-wrap">{quoted.quote}</div>
        </div>
      )}
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {tool && <span className="mr-1.5 font-bold text-blue">/{tool}</span>}
        <LongText text={text} />
      </div>
    </div>
  );
  if (!item.steer) return bubble("ml-auto max-w-[86%]");
  // 실행을 멈추지 않고 끼워 넣은 말. 새 요청과 헷갈리지 않게 말풍선 위에 적어 둔다.
  return (
    <div className="ml-auto flex max-w-[86%] flex-col items-end gap-1">
      <span className="text-xs text-muted">실행 중에 보냄</span>
      {bubble("max-w-full")}
    </div>
  );
}

/** 긴 글은 접어 둔다. */
function LongText({ text, limit = 600 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= limit || open) return <>{text}</>;
  return (
    <>
      {text.slice(0, limit)}…{" "}
      <TextButton onClick={() => setOpen(true)}>전체 보기</TextButton>
    </>
  );
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details className="text-[13px] text-muted" open={streaming}>
      <summary className="cursor-pointer select-none">{streaming ? "추론 중" : "추론"}</summary>
      <div className={`mt-1 border-l-2 border-hair pl-3 whitespace-pre-wrap ${streaming ? "caret" : ""}`}>{text}</div>
    </details>
  );
}

/** 도구 호출의 대상(경로 등)을 한마디로. */
function targetOf(tool: ToolItem, ws: Workspace | null): string {
  const a = tool.args;
  // 제공자 도구의 대상은 문서가 아니다. 검색어나 주소를 경로처럼 다듬지 않고 그대로 보인다.
  if (tool.native) return ([a.query, a.url].find((v) => typeof v === "string" && v) as string | undefined) ?? "";
  const pick = [a.path, a.source, a.scene, a.query].find((v) => typeof v === "string" && v) as string | undefined;
  const dest = typeof a.destination === "string" ? a.destination : "";
  const from = pick ? (/[/]|^(입력|출력|원고|자료)$/.test(pick) ? pathLabel(pick, ws) : pick) : "";
  return dest ? `${from} → ${pathLabel(dest, ws)}` : from;
}

/** 읽기 에이전트가 본 것 한 줄(`읽기: 원고/s3`). 경로는 사람이 알아볼 이름으로 바꾼다 (`읽기: 1장 2번째 장면`). */
function trailLine(line: string, ws: Workspace | null): string {
  const cut = line.indexOf(": ");
  if (cut === -1) return line;
  const what = line.slice(cut + 2).trim();
  return /^(원고|자료)\//.test(what) ? `${line.slice(0, cut)}: ${pathLabel(what, ws)}` : line;
}

function ToolGroup({ tools }: { tools: ToolItem[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {tools.map((t) => (t.userTool ? <UserToolRow key={t.key} tool={t} /> : <AgentToolRow key={t.key} tool={t} />))}
    </div>
  );
}

/** 이름이 따로 오지 않았을 때의 제공자 도구 이름. */
const NATIVE_LABEL: Record<string, string> = { web_search: "웹 검색", web_fetch: "웹 페이지 읽기", image_generation: "이미지 생성" };

/** 에이전트의 기본 도구(읽기, 쓰기, 옮기기 …)와 제공자 도구(웹 검색, 웹 페이지 읽기). 한 줄로만 남긴다. */
function AgentToolRow({ tool }: { tool: ToolItem }) {
  const ws = useStore((s) => s.ws);
  const agentTools = useStore((s) => s.meta?.agent_tools) ?? [];
  const openDoc = useStore((s) => s.openDoc);
  const [open, setOpen] = useState(false);
  const running = useStore(selectRunningHere);
  const label = tool.label || agentTools.find((t) => t.name === tool.tool)?.label || (tool.native ? NATIVE_LABEL[tool.tool] : "") || tool.tool;
  // 서버가 꺼지는 바람에 결과 없이 끝난 호출은 '진행 중'으로 보이지 않게 한다.
  const pending = tool.result === undefined && running;
  const failed = tool.ok === false;
  // 읽기 에이전트는 맡긴 일(task), 이미지 만들기는 이미지 모델에 넘긴 글(prompt)이 인자다.
  // 길 수 있어서 줄에는 앞머리만 보이고 펼치면 다 보인다.
  const long = tool.tool === "explore" ? tool.args.task : tool.tool === "generate_image" ? tool.args.prompt : "";
  const task = typeof long === "string" ? long.trim() : "";
  const brief = task.length > 70 ? `${task.slice(0, 70)}…` : task;
  // 만든 그림은 줄 밑에 작게 보인다 (이미지 만들기, 그리고 에이전트 모델이 스스로 만든 그림). 지워진 그림은 보이지 않는다.
  const sessionId = useStore((s) => s.sessionId);
  const pictures =
    sessionId && (tool.tool === "generate_image" || tool.native)
      ? (tool.changed ?? []).filter((p) => ws?.materials.some((m) => m.kind === "image" && barePath(m.path) === barePath(p)))
      : [];
  // 도는 동안 도구가 흘려보내는 글(읽기 에이전트가 무엇을 보는지, 그 뒤에 쓰는 답)의 끝 몇 줄.
  const tail = pending ? (tool.stream ?? "").split("\n").filter(Boolean).slice(-4).join("\n") : "";
  // 장면이 바뀌면 `원고`도 같이 온다. 장면 이름이 있으면 `원고`는 군말이라 뺀다.
  const changed = (tool.changed ?? []).filter((p, _, all) => barePath(p) !== "원고" || !all.some((q) => barePath(q).startsWith("원고/")));
  const url = tool.native && typeof tool.args.url === "string" ? tool.args.url : "";
  return (
    <div className="text-[13px]">
      {/* 점은 첫 줄에 붙어 있고, 긴 글(맡긴 일)은 그 옆에서 줄을 바꾼다. */}
      <div className="flex items-start gap-x-2">
        <span className="flex h-[1.55em] shrink-0 items-center">
          {pending ? <Spinner /> : <span className={`h-1.5 w-1.5 rounded-full ${failed ? "bg-danger" : "bg-agent"}`} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
          <button type="button" className="border-0 bg-transparent p-0 text-left text-muted [overflow-wrap:anywhere] hover:text-ink" onClick={() => setOpen(!open)}>
            <span className={failed ? "text-danger" : "text-ink"}>{label}</span> {task ? brief : changed.length === 0 && targetOf(tool, ws)}
          </button>
          {tool.rejected && <Tag tone="plain">반려</Tag>}
          {changed.map((p) => (
            <TextButton key={p} onClick={() => openDoc(p)}>
              {pathLabel(p, ws)}
            </TextButton>
          ))}
        </div>
      </div>
      {/* 막힌 이유(수정 방지 등)는 펼치지 않아도 보이게 한다. */}
      {failed && tool.result && !open && <div className="mt-0.5 ml-3.5 line-clamp-3 text-danger">{tool.result}</div>}
      {tail && !open && <div className="caret mt-1 ml-3.5 border-l-2 border-hair pl-3 text-xs whitespace-pre-wrap text-muted">{tail}</div>}
      {pictures.length > 0 && sessionId && (
        <div className="mt-1.5 ml-3.5 flex flex-wrap gap-2">
          {pictures.map((p) => (
            <button key={p} type="button" title={pathLabel(p, ws)} onClick={() => openDoc(p)} className="border-0 bg-transparent p-0">
              <img src={api.fileUrl(sessionId, p)} alt={pathLabel(p, ws)} className="block max-h-44 max-w-full rounded-lg border border-line" />
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="mt-1 ml-3.5 flex flex-col gap-1 border-l-2 border-hair pl-3 text-xs text-muted">
          {task && <div className="whitespace-pre-wrap text-ink">{task}</div>}
          {/* 읽기 에이전트가 본 것. 도는 동안 흘러간 줄은 기록에 남지 않아서, 끝난 뒤에는 이것으로 보인다. */}
          {tool.trail && tool.trail.length > 0 && (
            <div className="flex flex-col">
              {tool.trail.map((line, i) => (
                <span key={i}>{trailLine(line, ws)}</span>
              ))}
            </div>
          )}
          {/* 제공자 도구는 인자가 검색어·주소뿐이라 줄에 이미 보인다. 펼치면 요약만 보인다. */}
          {/* 제공자가 인자를 다른 모양으로 주어 줄에 보인 것이 없으면, 받은 그대로 보인다. */}
          {!task && (!tool.native || !targetOf(tool, ws)) && Object.keys(tool.args).length > 0 && (
            <pre className="m-0 font-mono whitespace-pre-wrap">{JSON.stringify(tool.args, null, 2)}</pre>
          )}
          {/^https?:\/\//i.test(url) && (
            <a className="link [overflow-wrap:anywhere]" href={url} target="_blank" rel="noreferrer">
              {url}
            </a>
          )}
          {/* 아직 도는 중이면 흘러나오는 글을 통째로 보인다. */}
          {tool.result === undefined && tool.stream && <div className={`max-h-48 overflow-y-auto whitespace-pre-wrap ${pending ? "caret" : ""}`}>{tool.stream}</div>}
          {tool.result && <div className="max-h-48 overflow-y-auto whitespace-pre-wrap">{tool.result}</div>}
        </div>
      )}
    </div>
  );
}

/** 사용자가 만든 도구. 언제나 입력을 읽고 출력에 쓴다. */
function UserToolRow({ tool }: { tool: ToolItem }) {
  const openDrawer = useStore((s) => s.openDrawer);
  const userTools = useStore(selectTools);
  const def = userTools.find((t) => t.name === tool.tool);
  const running = useStore(selectRunningHere);
  // 실행 확인을 기다리는 동안에는 아직 돌고 있는 것이 아니다 (tool_call이 확인 요청보다 먼저 온다).
  const confirming = useStore((s) => s.items.some((it) => it.kind === "ask" && !it.answered && it.askKind === "tool_confirm" && it.tool === tool.tool));
  const label = tool.label || def?.label || tool.tool;
  const waiting = tool.result === undefined && running && confirming;
  const pending = tool.result === undefined && running && !confirming;
  const rejected = tool.rejected === true;
  const failed = tool.ok === false;
  const tail = (tool.stream ?? "").split("\n").filter(Boolean).slice(-4).join("\n");
  const duration = tool.startedAt && tool.endedAt ? formatDuration(new Date(tool.endedAt).getTime() - new Date(tool.startedAt).getTime()) : "";
  return (
    <div className={`rounded-xl px-3.5 py-2.5 ${pending ? "bg-agent-tint" : "bg-sunken"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <TextButton onClick={() => openDrawer({ kind: "runs" })}>입력</TextButton>
        <span className="text-muted">→</span>
        <span className={`font-bold ${failed ? "text-danger" : "text-agent"}`}>{label}</span>
        {pending && <Spinner />}
        <span className="text-muted">→</span>
        {/* 시험 실행은 출력을 건드리지 않는다. 결과는 비교 화면에서 본다. */}
        {tool.trial ? (
          <TextButton onClick={() => openDrawer({ kind: "compare" })}>결과</TextButton>
        ) : (
          <TextButton onClick={() => openDrawer({ kind: "doc", path: "출력" })}>출력</TextButton>
        )}
        {tool.trial && <Tag tone="plain">시험 실행</Tag>}
        {waiting && <Tag tone="outline">확인 대기</Tag>}
        {rejected && <Tag tone="plain">반려</Tag>}
        <span className="ml-auto text-xs text-muted">
          {[modelShort(def?.model), duration].filter(Boolean).join(" · ")}
        </span>
      </div>
      {pending && tail && <div className="caret mt-2 font-body text-[14.5px] leading-[1.85] whitespace-pre-wrap">{tail}</div>}
      {failed && tool.result && <div className="mt-1.5 text-[13px] text-danger">{tool.result}</div>}
    </div>
  );
}

function Ask({ item: asked }: { item: AskItem }) {
  // 답은 도는 실행에만 보낼 수 있다. 실행이 끊겼는데(서버가 꺼짐) 기록에 답 못 받은 확인이 남아 있으면,
  // 답할 수 없는 것으로 보인다 (버튼을 두면 눌렀을 때 서버가 거절한다).
  const live = useStore(selectRunningHere);
  const item = asked.answered || live ? asked : { ...asked, answered: true };
  if (item.askKind === "proposal" && item.proposal) return <ProposalAsk item={item} proposal={item.proposal} />;
  if (item.askKind === "tool_confirm") return <ToolConfirm item={item} />;
  return <Question item={item} />;
}

/** 확인 요청의 겉모양. 답하기 전에는 파란 윗줄이 선다. */
function AskFrame({ tag, title, answered, reply, children }: { tag: string; title: ReactNode; answered: boolean; reply?: string; children?: ReactNode }) {
  if (answered) {
    const ok = reply === "승인";
    return (
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <Tag tone={ok ? "outline" : "plain"}>{reply === undefined ? tag : ok ? "승인" : reply === "반려" ? "반려" : tag === "질문" ? "답함" : "반려"}</Tag>
        <span className="text-ink">{title}</span>
        {/* 질문에 한 답은 바로 아래에 내 말로 남는다. 여기에는 반려 사유만 적는다. */}
        {reply && !ok && reply !== "반려" && tag !== "질문" && <span>{reply}</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-blue bg-bg px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="blue">{tag}</Tag>
        <span className="font-bold">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** 승인 / 반려(사유). */
function Verdict({ eventId }: { eventId: string }) {
  const answer = useStore((s) => s.answer);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const reply = (text: string) => {
    setBusy(true);
    void answer(eventId, text).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" disabled={busy} onClick={() => reply("승인")}>
        승인
      </Button>
      <input
        aria-label="반려 사유"
        placeholder="반려 사유"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && reason.trim() && reply(reason.trim())}
        className="h-9 min-w-36 flex-1 rounded-lg border border-line bg-bg px-2.5 text-sm focus:border-blue focus:outline-none"
      />
      <Button disabled={busy} onClick={() => reply(reason.trim() || "반려")}>
        반려
      </Button>
    </div>
  );
}

function Question({ item }: { item: AskItem }) {
  const answer = useStore((s) => s.answer);
  const focusComposer = useStore((s) => s.focusComposer);
  return (
    <AskFrame tag="질문" title={<span className="font-normal whitespace-pre-wrap">{item.question}</span>} answered={item.answered} reply={item.reply}>
      <div className="flex flex-wrap gap-2">
        {item.options.map((o) => (
          <Button key={o} small onClick={() => void answer(item.eventId, o)}>
            {o}
          </Button>
        ))}
        <Button small variant="quiet" onClick={focusComposer}>
          직접 답하기
        </Button>
      </div>
    </AskFrame>
  );
}

function ToolConfirm({ item }: { item: AskItem }) {
  const tools = useStore(selectTools);
  const mine = tools.find((t) => t.name === item.tool);
  const label = item.label || mine?.label || item.tool || "도구";
  // 프리셋의 도구는 입력을 읽어 출력에 쓴다. 에이전트의 기본 도구(이미지 만들기, 묶음 요약)는 그 자리를 거치지 않는다:
  // 이름만 보이고, 같이 온 글은 이미지 모델에 넘길 글이거나 요약을 붙일 곳들이다.
  const imagePrompt = item.tool === "generate_image";
  return (
    <AskFrame tag="도구 실행" title={mine ? `입력 → ${label} → 출력` : label} answered={item.answered} reply={item.reply}>
      {item.input !== undefined && (
        <div>
          {(mine || imagePrompt) && (
            <div className="mb-1 text-xs text-muted">
              {imagePrompt ? "넘길 글" : "입력"} {formatChars(item.input.length)}
            </div>
          )}
          <Clamp>
            <div className="text-[13.5px] whitespace-pre-wrap">{item.input}</div>
          </Clamp>
        </div>
      )}
      <Verdict eventId={item.eventId} />
    </AskFrame>
  );
}

const ACTION_TITLE: Record<Proposal["action"], string> = {
  write: "수정",
  delete: "삭제",
  move: "이동",
  insert: "원고에 장면 넣기",
  split: "장면 나누기",
  merge: "장면 합치기",
  reorder: "순서 바꾸기",
  replace: "찾아 바꾸기",
};

function ProposalAsk({ item, proposal }: { item: AskItem; proposal: Proposal }) {
  const ws = useStore((s) => s.ws);
  const openDoc = useStore((s) => s.openDoc);
  const target = proposal.path ? pathLabel(proposal.path, ws) : "";
  const title = proposal.description || [target, ACTION_TITLE[proposal.action]].filter(Boolean).join(" ");
  // 수정 방지된 문서를 고치겠다는 확인이면(권한 무시) 그 사실을 보인다.
  const at = barePath(proposal.path ?? "");
  const locked = !item.answered && (at.startsWith("원고/") ? (findScene(ws, at)?.scene.locked ?? false) : (ws?.materials.find((m) => barePath(m.path) === at)?.locked ?? false));
  return (
    <AskFrame tag="문서 변경" title={title} answered={item.answered} reply={item.reply}>
      {/* 찾아 바꾸기는 여러 문서에 걸친다. 무엇을 무엇으로 바꾸는지는 제목에, 어느 문서인지는 아래 줄들에 있다. */}
      {proposal.action !== "replace" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
          <span>{ACTION_TITLE[proposal.action]}</span>
          {proposal.path && proposal.action !== "insert" && <TextButton onClick={() => openDoc(proposal.path)}>{target}</TextButton>}
          {locked && <Tag tone="outline">수정 방지</Tag>}
          {proposal.dest && <span>→ {pathLabel(proposal.dest, ws)}</span>}
          {(proposal.action === "insert" || proposal.action === "reorder") && proposal.position && (
            <span>
              {proposal.action === "reorder" ? "→ " : ""}
              {positionLabel(proposal, ws)}
            </span>
          )}
        </div>
      )}
      {/* 찾아 바꾸기의 범위. 에이전트가 범위를 주지 않았으면(빈 경로) 원고와 자료 전체다. */}
      {proposal.action === "replace" && (
        <div className="text-[13px] text-muted">범위 {proposal.path ? target : "원고와 자료 전체"}</div>
      )}
      {proposal.action === "replace" ? <ReplaceBody proposal={proposal} /> : <ProposalBody proposal={proposal} ws={ws} />}
      <Verdict eventId={item.eventId} />
    </AskFrame>
  );
}

function positionLabel(p: Proposal, ws: Workspace | null): string {
  const chapters = ws?.manuscript.chapters ?? [];
  const after = p.position?.after ? findScene(ws, p.position.after) : null;
  if (after) return `${sceneLabel(after.scene, after.chapter)} 뒤`;
  const chapter = chapters.find((c) => c.id === p.position?.chapter) ?? chapters[chapters.length - 1];
  if (!chapter || p.position?.new_chapter) return "새 장";
  return p.position?.after === null && !p.position.end ? `${chapter.number}장 맨 앞` : `${chapter.number}장 끝`;
}

/** 찾아 바꾸기: 문서마다 몇 곳인지와, 바뀌는 예 몇 줄. */
function ReplaceBody({ proposal }: { proposal: Proposal }) {
  const ws = useStore((s) => s.ws);
  const openDoc = useStore((s) => s.openDoc);
  const docs = proposal.items ?? [];
  if (docs.length === 0) return null;
  return (
    <Clamp>
      <div className="flex flex-col gap-2.5">
        {docs.map((doc) => (
          <div key={doc.path}>
            <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
              <TextButton onClick={() => openDoc(doc.path)}>{doc.title || pathLabel(doc.path, ws)}</TextButton>
              <span className="text-xs text-muted">{doc.count.toLocaleString("ko-KR")}곳</span>
            </div>
            <div className="mt-0.5 flex flex-col font-serif text-[14.5px] leading-[1.85] whitespace-pre-wrap">
              {doc.samples.map((s, i) => (
                <p key={i} className="m-0">
                  <Words before={s.before} after={s.after} />
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Clamp>
  );
}

/** 바뀌는 부분을 보여준다. */
function ProposalBody({ proposal, ws }: { proposal: Proposal; ws: Workspace | null }) {
  const { action, old, next } = proposal;
  if (action === "split")
    return (
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[13.5px]">
        {(proposal.pieces ?? []).map((piece, i) => (
          <li key={i}>
            {piece.new_chapter && <Tag tone="plain">새 장</Tag>}{" "}
            <span className="font-serif">{piece.head}</span> <span className="text-xs text-muted">{formatChars(piece.chars)}</span>
          </li>
        ))}
      </ol>
    );
  // 합친 글이 비어 있으면(빈 장면끼리) 보일 글이 없다. 어느 장면들인지만 적는다.
  if (action === "merge" && !next)
    return (
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-[13.5px]">
        {(proposal.scenes ?? []).map((id, i) => {
          const found = findScene(ws, id);
          return (
            <span key={id}>
              {i > 0 && <span className="mr-2 text-muted">+</span>}
              {found ? sceneLabel(found.scene, found.chapter) : id}
            </span>
          );
        })}
      </div>
    );
  // 옮기기는 글이 그대로다. 어디서 어디로 가는지는 윗줄에 있다.
  if (action === "move" || action === "reorder") return null;
  if (action === "delete")
    return old ? (
      <Clamp>
        <div className="font-serif text-[14.5px] leading-[1.85] whitespace-pre-wrap text-danger line-through">{old}</div>
      </Clamp>
    ) : null;
  if (next === null) return null;
  if (!old)
    return (
      <Clamp>
        <div className="font-serif text-[14.5px] leading-[1.85] whitespace-pre-wrap">{next}</div>
      </Clamp>
    );
  return (
    <Clamp>
      <Diff before={old} after={next} />
    </Clamp>
  );
}

/** 한 줄 안에서 바뀐 낱말만 짚는다: 지운 것은 줄을 긋고, 새로 든 것은 에메랄드. */
function Words({ before, after }: { before: string; after: string }) {
  return (
    <>
      {diffWords(before, after).map((part, j) =>
        part.kind === "same" ? (
          <span key={j}>{part.text}</span>
        ) : part.kind === "del" ? (
          <del key={j} className="bg-[#fbeceb] text-danger">
            {part.text}
          </del>
        ) : (
          <ins key={j} className="bg-agent-tint text-agent no-underline">
            {part.text}
          </ins>
        ),
      )}
    </>
  );
}

/** 지운 글과 새 글. 바뀐 문단만 보이고, 그대로인 문단은 앞뒤 한 문단씩만 남긴다. */
function Diff({ before, after }: { before: string; after: string }) {
  const blocks = diffBlocks(before, after);
  const out: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (b.kind === "same") {
      const nearChange = blocks[i - 1]?.kind === "change" || blocks[i + 1]?.kind === "change";
      if (!b.text.trim()) return;
      if (nearChange) out.push(<p key={i} className="m-0 text-muted">{b.text}</p>);
      else if (out[out.length - 1] !== "gap") out.push("gap");
      return;
    }
    // 문단 하나를 문단 하나로 고친 경우에는 바뀐 낱말만 짚는다.
    if (b.before.length === 1 && b.after.length === 1) {
      out.push(
        <p key={i} className="m-0">
          <Words before={b.before[0]} after={b.after[0]} />
        </p>,
      );
      return;
    }
    b.before.filter((t) => t.trim()).forEach((t, j) => out.push(<p key={`${i}d${j}`} className="m-0 bg-[#fbeceb] text-danger line-through">{t}</p>));
    b.after.filter((t) => t.trim()).forEach((t, j) => out.push(<p key={`${i}a${j}`} className="m-0 bg-agent-tint text-agent">{t}</p>));
  });
  return (
    <div className="flex flex-col gap-2 font-serif text-[14.5px] leading-[1.85] whitespace-pre-wrap">
      {out.map((node, i) => (node === "gap" ? <div key={`gap${i}`} className="text-center text-xs text-edge">⋯</div> : node))}
    </div>
  );
}

/** 길면 접어 두고 펼쳐 본다. */
function Clamp({ children, height = 260 }: { children: ReactNode; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    if (ref.current) setLong(ref.current.scrollHeight > height + 24);
  }, [children, height]);
  return (
    <div>
      <div ref={ref} className="overflow-hidden" style={{ maxHeight: open || !long ? undefined : height }}>
        {children}
      </div>
      {long && (
        <TextButton className="mt-1" onClick={() => setOpen(!open)}>
          {open ? "접기" : "전체 보기"}
        </TextButton>
      )}
    </div>
  );
}

function DoneLine({ item, revertible }: { item: Extract<Item, { kind: "done" }>; revertible: boolean }) {
  const e = item.event;
  // stalled: 같은 도구를 같은 인자로 되풀이 불러서 엔진이 멈췄다 (까닭은 바로 앞의 오류 줄에 있다).
  // interrupted: 실행 도중에 서버가 꺼졌다. 그 실행이 문서에 남긴 변경은 그대로 있다.
  const status = {
    completed: "완료",
    stopped: "중단",
    stalled: "반복 호출로 중단",
    interrupted: "서버가 꺼져서 끊김",
    error: "오류",
  }[e.status ?? "completed"];
  const bad = e.status === "error" || e.status === "stalled" || e.status === "interrupted";
  const parts = [
    status,
    e.total_tool_calls ? `도구 ${e.total_tool_calls}회` : "",
    e.elapsed_sec ? formatDuration(e.elapsed_sec * 1000) : "",
    e.usage?.prompt_tokens ? `${formatTokens((e.usage.prompt_tokens ?? 0) + (e.usage.output_tokens ?? 0))} 토큰` : "",
    e.usage?.cost_usd ? `$${e.usage.cost_usd.toFixed(3)}` : "",
  ].filter(Boolean);
  return (
    <div className={`flex items-center gap-3 text-xs ${bad ? "text-danger" : "text-muted"}`}>
      <span className="h-px flex-1 bg-hair" />
      {parts.join(" · ")}
      {item.reverted && <Tag tone="plain">되돌림</Tag>}
      {revertible && (
        <Popover
          trigger={(open, toggle) => (
            <TextButton className="!text-xs" aria-expanded={open} onClick={toggle}>
              되돌리기
            </TextButton>
          )}
        >
          {(close) => <RevertPlan close={close} />}
        </Popover>
      )}
      <span className="h-px flex-1 bg-hair" />
    </div>
  );
}

// structure는 글은 그대로고 원고의 순서만 바뀐 것이다 (경로는 `원고`).
const CHANGE_LABEL: Record<LastRun["changes"][number]["action"], string> = { write: "수정", delete: "삭제", move: "이동", structure: "순서" };

/** 되돌리기 전에 무엇이 돌아가는지 보인다. 팝업이 열릴 때 서버에 묻는다. */
function RevertPlan({ close }: { close: () => void }) {
  const sessionId = useStore((s) => s.sessionId);
  const conversationId = useStore((s) => s.conversationId);
  const ws = useStore((s) => s.ws);
  const revertRun = useStore((s) => s.revertRun);
  const [plan, setPlan] = useState<LastRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = (id: string) => api.lastRun(id).then(setPlan, (e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    if (sessionId) void load(sessionId);
  }, [sessionId]);
  // 완료 줄은 대화의 맨 아래에 있어서 팝업이 스크롤 밖으로 열린다. 내용이 정해질 때마다 보이는 데까지 내린다.
  useLayoutEffect(() => {
    root.current?.scrollIntoView({ block: "nearest" });
  }, [plan, error]);

  const confirm = async () => {
    if (!sessionId || !plan?.run_id) return;
    setBusy(true);
    // 그 뒤에 내가 고친 문서는 고친 대로 두고(force) 나머지만 되돌린다.
    const ok = await revertRun(plan.run_id, plan.touched_later.length > 0);
    if (ok) return close();
    // 팝업을 연 뒤에 문서를 고쳤으면 서버가 거절한다. 목록을 다시 받아 그 문서들을 따로 보이고, 다시 누르면 그것들은 두고 되돌린다.
    await load(sessionId);
    setBusy(false);
  };

  let body: ReactNode;
  if (error) body = <span className="text-danger">{error}</span>;
  else if (!plan) body = <Spinner />;
  else if (!plan.revertible || !plan.run_id) body = <span className="text-muted">{plan.reason || "되돌릴 수 없습니다"}</span>;
  // 팝업을 여는 사이에 다른 대화에서 실행이 돌았으면, 마지막 실행은 이 줄의 실행이 아니다.
  else if (plan.conversation_id && plan.conversation_id !== conversationId) body = <span className="text-muted">마지막 실행은 다른 대화의 것입니다</span>;
  else {
    const kept = new Set(plan.touched_later.map(barePath));
    const changes = plan.changes.filter((c) => !kept.has(barePath(c.path)));
    body = (
      <>
        {changes.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {changes.map((c) => (
              <div key={c.path} className="flex items-baseline gap-3">
                {/* 이름은 엔진이 지어 준다 (그 실행이 지워서 목록에 없는 장면은 "지운 장면"으로 온다). */}
                <span className="min-w-0 flex-1 truncate" title={c.title || undefined}>
                  {c.title || pathLabel(c.path, ws)}
                </span>
                <span className="shrink-0 text-xs text-muted">{CHANGE_LABEL[c.action]}</span>
              </div>
            ))}
          </div>
        )}
        {plan.touched_later.length > 0 && (
          <div className={`flex flex-col gap-0.5 ${changes.length > 0 ? "border-t border-hair pt-2" : ""}`}>
            <span className="text-xs text-muted">내가 고친 문서는 그대로 둠</span>
            {plan.touched_later.map((p) => (
              <span key={p} className="truncate text-muted">
                {pathLabel(p, ws)}
              </span>
            ))}
          </div>
        )}
        <Button small variant="primary" className="self-end" disabled={busy} onClick={() => void confirm()}>
          되돌리기
        </Button>
      </>
    );
  }
  return (
    // 팝업의 테두리까지 보이게 아래로 조금 더 내린다 (scroll-mb).
    <div ref={root} className="flex w-72 max-w-full scroll-mb-3 flex-col gap-2.5 p-3 text-[13px]">
      {body}
    </div>
  );
}

/** 실행이 어떤 조건으로 시작됐는지 (채팅창 위 상태 줄에서 쓴다). */
export function runSummary(all: Item[]): { label: string; calls: string; waiting: AskItem | null } {
  // 지금 실행의 것만 본다. 앞 실행의 도구 횟수가 새 실행의 첫머리에 남지 않게. (도구 호출에는 한도가 없다. 몇 번째인지만 보인다)
  const items = all.slice(all.findLastIndex((it) => it.kind === "run") + 1);
  const waiting = [...items].reverse().find((it): it is AskItem => it.kind === "ask" && !it.answered) ?? null;
  const tool = [...items].reverse().find((it): it is ToolItem => it.kind === "tool");
  const run = all.findLast((it) => it.kind === "run");
  const calls = tool?.index ? `도구 ${tool.index}회` : "";
  if (waiting) return { label: waiting.askKind === "question" ? "답 대기" : "확인 대기", calls, waiting };
  if (tool && tool.result === undefined && tool.userTool) return { label: `${tool.label || tool.tool} 실행 중`, calls, waiting };
  const mode = run?.kind === "run" && run.mode ? MODE_LABEL[run.mode] : "";
  return { label: mode ? `에이전트 응답 중 · ${mode}` : "에이전트 응답 중", calls, waiting };
}
