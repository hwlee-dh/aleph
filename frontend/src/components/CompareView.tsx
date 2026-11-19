import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatChars, formatDuration, formatWhen, modelShort } from "../lib/labels";
import type { Item, ToolRun } from "../lib/types";
import { selectTools, useStore } from "../store";
// DrawerPanel도 이 파일을 불러온다(서로 부른다). 둘 다 그릴 때에야 서로를 쓰므로 괜찮다.
import { Frame } from "./DrawerPanel";
import { MoreIcon } from "./icons";
import { KindText } from "./KindText";
import { ModelField, ModelPicker } from "./SettingsView";
import { Button, Chevron, Field, IconButton, MenuItem, Popover, Spinner, Tag, inputClass } from "./ui";

/*
 * 같은 입력으로 돌린 결과들을 나란히 놓고 본다 (API.md 9.5).
 * 지시문이나 모델을 바꾸면 글이 어떻게 달라지는지를 한 화면에서 보이는 자리다.
 * 시험 실행(`이 입력으로 다시 돌리기`)은 출력을 건드리지 않고 도구 실행 기록에만 남는다.
 */

/** 도구 실행 기록(최신이 뒤). 처음 한 번, 그리고 실행이 시작하고 끝날 때마다 다시 받는다. */
export function useToolRuns(): ToolRun[] | null {
  const sessionId = useStore((s) => s.sessionId);
  const running = useStore((s) => s.running);
  const fail = useStore((s) => s.fail);
  const [runs, setRuns] = useState<ToolRun[] | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    api
      .toolRuns(sessionId)
      .then((r) => alive && setRuns(r))
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [sessionId, running, fail]);
  return runs;
}

/**
 * 방금 시작한 시험 실행이 다시 쓰는 입력(그 실행의 번호).
 * 끝날 때까지 비교 화면이 쓰이고 있는 글을 그 묶음의 마지막 단으로 보인다.
 * 시험 실행을 시작하면 넓은 패널이 새로 그려지므로(아래 startTrial) 화면의 상태가 아니라 여기에 둔다.
 */
let trial: { sessionId: string; seq: number } | null = null;
useStore.subscribe((s, prev) => {
  if (prev.running && !s.running) trial = null;
});

/** 지금 쓰이고 있는 사용자 도구의 호출. */
function liveTool(items: Item[]): Extract<Item, { kind: "tool" }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.userTool) return it.result === undefined ? it : null;
  }
  return null;
}

/** 그 실행의 입력으로 도구를 시험 실행하고, 비교 화면을 연다. model이 비면 도구의 모델. */
async function startTrial(run: ToolRun, tool: string, model: string) {
  const s = useStore.getState();
  const id = s.sessionId;
  if (!id || s.running || s.starting || s.compacting) return;
  // 시험 실행을 또 다시 돌려도 "원래 실행"은 처음 그것을 가리키게 한다.
  const seq = run.base_seq ?? run.seq;
  try {
    // 방금 고친 지시문으로 돌도록, 밀려 있는 프리셋 저장을 먼저 끝낸다.
    await s.flushPreset();
    await api.runTool(id, tool, { trial: true, input_seq: seq, ...(model ? { model } : {}), ...(s.conversationId ? { conversation: s.conversationId } : {}) });
  } catch (e) {
    s.fail(e);
    return;
  }
  if (useStore.getState().sessionId !== id) return;
  trial = { sessionId: id, seq };
  // 실행은 대화의 스트림으로 흐른다.
  s.attachRun();
  s.openDrawer({ kind: "compare", seq });
}

/** 시험 실행의 도구와 모델을 고르는 작은 팝업의 속. */
function RerunForm({ run }: { run: ToolRun }) {
  const tools = useStore(selectTools);
  const running = useStore((s) => s.running);
  // 지시문이 빈 도구는 돌릴 수 없다.
  const usable = tools.filter((t) => t.enabled && t.prompt.trim());
  const [tool, setTool] = useState(() => (usable.some((t) => t.name === run.tool) ? run.tool : (usable[0]?.name ?? "")));
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  // 제공자만 고르고 모델을 아직 안 고른 상태(`제공자:`)로는 보내지 않는다.
  const modelReady = model === "" || /^[^:]+:.+/.test(model);

  const start = async () => {
    setBusy(true);
    await startTrial(run, tool, model);
    setBusy(false);
  };

  return (
    <div className="flex w-72 max-w-full flex-col gap-3 p-2">
      <Field label="도구">
        <select className={inputClass} value={tool} onChange={(e) => setTool(e.target.value)}>
          {usable.map((t) => (
            <option key={t.name} value={t.name}>
              {t.label || t.name}
            </option>
          ))}
        </select>
      </Field>
      <ModelField label="모델">
        <ModelPicker label="시험 실행의 모델" value={model} onChange={setModel} emptyLabel="도구의 모델" />
      </ModelField>
      <Button small variant="primary" className="self-start" disabled={!tool || !modelReady || busy || running} title={running ? "실행 중" : undefined} onClick={() => void start()}>
        시험 실행
      </Button>
    </div>
  );
}

/** `이 입력으로 다시 돌리기` 버튼과 그 팝업. */
export function RerunButton({ run }: { run: ToolRun }) {
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <Button small aria-expanded={open} onClick={toggle}>
          이 입력으로 다시 돌리기
        </Button>
      )}
    >
      {() => <RerunForm run={run} />}
    </Popover>
  );
}

/** 입력이 같은 실행끼리 묶는다. 묶음 안은 돌린 순서, 묶음은 최근에 돌린 것이 앞. */
function groupByInput(runs: ToolRun[]): ToolRun[][] {
  const byInput = new Map<string, ToolRun[]>();
  for (const run of runs) {
    const group = byInput.get(run.input);
    if (group) group.push(run);
    else byInput.set(run.input, [run]);
  }
  return [...byInput.values()].sort((a, b) => b[b.length - 1].seq - a[a.length - 1].seq);
}

/** 묶음을 부르는 말: 입력에 적혀 있던 첫 줄. */
function headLine(run: ToolRun): string {
  const line = (run.input_raw || run.input).split("\n").find((l) => l.trim()) ?? "";
  const text = line.trim();
  return text.length > 44 ? `${text.slice(0, 44)}…` : text || "입력";
}

export function CompareView({ seq }: { seq?: number }) {
  const sessionId = useStore((s) => s.sessionId);
  const openDrawer = useStore((s) => s.openDrawer);
  const runs = useToolRuns();
  // 내가 방금 시작한 시험 실행이 쓰고 있는 글.
  const live = useStore((s) => (s.running && trial?.sessionId === s.sessionId ? liveTool(s.live) : null));
  /** 보고 있는 묶음에 든 실행 하나의 번호. */
  const [picked, setPicked] = useState<number | null>(seq ?? null);
  const [inputOpen, setInputOpen] = useState(false);

  // 나란히 놓으려면 넓어야 한다. 좁게 쓰고 있었으면 열 때 한 번 넓힌다.
  useEffect(() => {
    const s = useStore.getState();
    if (s.width.drawer < 720) s.setWidth("drawer", 900);
  }, []);

  const groups = useMemo(() => groupByInput(runs ?? []), [runs]);
  // 고른 것이 없으면 가장 최근에 둘 이상 모인 묶음, 그것도 없으면 가장 최근의 실행.
  const group = groups.find((g) => g.some((r) => r.seq === picked)) ?? groups.find((g) => g.length > 1) ?? groups[0] ?? null;
  const writingNow = live && group && trial && sessionId === trial.sessionId && group.some((r) => r.seq === trial?.seq) ? live : null;
  /*
   * 실행이 끝난 순간부터 실행 기록을 다시 받을 때까지, 쓰이던 단을 그대로 둔다.
   * 그 사이에 단이 하나 빠졌다 다시 생기면 옆으로 넘겨 둔 스크롤이 풀려, 방금 나온 결과가 화면 밖(오른쪽)에 놓인다.
   */
  const [held, setHeld] = useState<{ item: Extract<Item, { kind: "tool" }>; group: number } | null>(null);
  useEffect(() => {
    if (writingNow && group) setHeld({ item: writingNow, group: group[0].seq });
  }, [writingNow, group]);
  useEffect(() => {
    setHeld(null);
  }, [runs]);
  const writing = writingNow ?? (held && group && held.group === group[0].seq ? held.item : null);
  const count = (group?.length ?? 0) + (writing ? 1 : 0);

  return (
    <Frame
      title="비교"
      tags={group ? <span className="text-xs text-muted tabular-nums">{count}</span> : null}
      actions={
        <Button small variant="quiet" onClick={() => openDrawer({ kind: "runs", seq: group ? group[group.length - 1].seq : undefined })}>
          이전 입력·출력
        </Button>
      }
    >
      {group && (
        <>
          <div className="flex shrink-0 items-center gap-2 px-6 pt-3 pb-2">
            {groups.length > 1 ? (
              <select
                aria-label="입력"
                className={`${inputClass} !h-8 !w-auto max-w-[min(100%,28rem)]`}
                value={group[0].seq}
                onChange={(e) => setPicked(Number(e.target.value))}
              >
                {groups.map((g) => (
                  <option key={g[0].seq} value={g[0].seq}>
                    {headLine(g[0])} · {g.length}
                  </option>
                ))}
              </select>
            ) : (
              <span className="min-w-0 truncate text-[13px]">{headLine(group[0])}</span>
            )}
            <Button small variant="quiet" aria-expanded={inputOpen} onClick={() => setInputOpen(!inputOpen)}>
              입력 보기
              <Chevron right={!inputOpen} />
            </Button>
          </div>
          {inputOpen && (
            <div className="max-h-[38vh] shrink-0 overflow-y-auto px-6 pb-3 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{group[0].input}</div>
          )}
          {/* 단은 가는 세로줄로만 나눈다. 둘이면 반반, 셋부터는 좁아지지 않고 옆으로 넘긴다. */}
          <div className="flex min-h-0 flex-1 overflow-x-auto border-t border-hair">
            {group.map((run, i) => (
              <Column key={run.seq} run={run} narrow={count > 2} menuLeft={i === 0 && count > 1} />
            ))}
            {writing && <LiveColumn item={writing} narrow={count > 2} />}
          </div>
        </>
      )}
    </Frame>
  );
}

const columnClass = (narrow: boolean) => `flex min-h-0 flex-1 flex-col border-l border-hair first:border-l-0 ${narrow ? "min-w-[320px]" : "min-w-0"}`;

function Column({ run, narrow, menuLeft }: { run: ToolRun; narrow: boolean; menuLeft: boolean }) {
  const meta = [modelShort(run.model), formatDuration(run.duration_ms), formatChars(run.output.length), formatWhen(run.timestamp)].filter(Boolean).join(" · ");
  return (
    <section className={columnClass(narrow)}>
      <div className="shrink-0 pt-3 pr-3 pb-2 pl-5">
        <div className="flex min-h-7 items-center gap-1.5">
          <span className={`min-w-0 truncate font-bold ${run.error ? "text-danger" : ""}`}>{run.label || run.tool}</span>
          {run.trial ? <Tag>시험</Tag> : !run.error && <Tag tone="outline">출력에 씀</Tag>}
          <span className="flex-1" />
          <ColumnMenu run={run} left={menuLeft} />
        </div>
        <div className="truncate text-xs text-muted" title={meta}>
          {meta}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-12">
        {run.error && <div className="mb-2 text-[13px] text-danger">{run.error}</div>}
        <div className="manuscript small tk-text mx-auto max-w-[var(--body-width,720px)]">
          <KindText text={run.output} />
        </div>
      </div>
    </section>
  );
}

/** 단 머리의 메뉴. `이 입력으로 다시 돌리기`를 고르면 같은 팝업이 도구·모델 고르기로 바뀐다. */
function ColumnMenu({ run, left }: { run: ToolRun; left: boolean }) {
  const running = useStore((s) => s.running);
  const [form, setForm] = useState(false);

  const toOutput = async () => {
    const s = useStore.getState();
    if (!s.sessionId) return;
    try {
      await api.saveDoc(s.sessionId, "출력", run.output);
      s.touch(["출력"]);
      s.notify("출력에 넣음");
    } catch (e) {
      s.fail(e);
    }
  };

  return (
    // 첫 단은 왼쪽에 자리가 없다. 팝업을 오른쪽(다음 단 위)으로 펼친다.
    <Popover
      align={left ? "left" : "right"}
      className={form ? "" : "!min-w-44"}
      trigger={(open, toggle) => (
        <IconButton
          label="더 보기"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setForm(false);
            toggle();
          }}
        >
          <MoreIcon />
        </IconButton>
      )}
    >
      {(close) =>
        form ? (
          <RerunForm run={run} />
        ) : (
          <>
            <MenuItem
              disabled={!run.output || running}
              onClick={() => {
                close();
                void toOutput();
              }}
            >
              출력에 넣기
            </MenuItem>
            <MenuItem onClick={() => setForm(true)}>이 입력으로 다시 돌리기</MenuItem>
          </>
        )
      }
    </Popover>
  );
}

/** 지금 쓰이고 있는 시험 실행. 끝나면 실행 기록을 다시 받아 보통의 단이 된다. */
function LiveColumn({ item, narrow }: { item: Extract<Item, { kind: "tool" }>; narrow: boolean }) {
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  // 단이 여럿이면 새 단은 화면 밖 오른쪽에 생긴다. 보이게 옆으로 넘긴다.
  // 요즘 브라우저의 scrollIntoView는 Promise를 돌려준다. 그것을 effect가 그대로 돌려주면 React가 정리 함수로 알고 부르다 화면이 죽는다.
  useEffect(() => {
    void root.current?.scrollIntoView({ block: "nearest", inline: "end" });
  }, []);
  // 쓰이고 있는 끝을 따라 내려간다. 위로 올려 읽고 있으면 그대로 둔다.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [item.stream]);
  return (
    <section ref={root} className={columnClass(narrow)}>
      <div className="shrink-0 pt-3 pr-3 pb-2 pl-5">
        <div className="flex min-h-7 items-center gap-1.5">
          <span className="min-w-0 truncate font-bold text-agent">{item.label || item.tool}</span>
          <Tag>시험</Tag>
          <Spinner />
        </div>
        <div className="text-xs text-muted">{formatChars((item.stream ?? "").length)}</div>
      </div>
      <div
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-12"
      >
        <div className="manuscript small caret tk-text mx-auto max-w-[var(--body-width,720px)]">
          <KindText text={item.stream ?? ""} />
        </div>
      </div>
    </section>
  );
}
