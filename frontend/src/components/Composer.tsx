import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { askNotifyPermission } from "../lib/attention";
import { MODES, MODE_HINT, MODE_LABEL, THINKING_LABEL, THINKINGS, formatTokens, modelShort } from "../lib/labels";
import type { ToolDef, Usage } from "../lib/types";
import { selectRunningHere, selectTools, useStore } from "../store";
import { runSummary } from "./Conversation";
import { CloseIcon, NewChatIcon, PlusIcon, SendIcon, StopIcon, ToolIcon, UploadIcon } from "./icons";
import { ModelPicker } from "./SettingsView";
import { Button, MenuItem, Popover, Segmented, Spinner, Tag, TextButton, Toggle } from "./ui";

const UPLOAD_ACCEPT = ".txt,.md,.docx,.hwpx,.pdf,.png,.jpg,.jpeg,.webp,.gif";

/** 채팅창. 쓰는 양에 따라 늘어나는 둥근 상자, 아래 줄에 모델·모드·컨텍스트. */
export function Composer() {
  const sessionId = useStore((s) => s.sessionId);
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);
  const focusTick = useStore((s) => s.focusTick);
  const quote = useStore((s) => s.quote);
  const setQuote = useStore((s) => s.setQuote);
  // 여기서 running은 보고 있는 대화에서 도는 중이라는 뜻이다. 다른 대화에서 도는 중이면(elsewhere) 보낼 수 없다:
  // 한 작업에서는 한 번에 하나만 돈다.
  const running = useStore(selectRunningHere);
  const elsewhere = useStore((s) => s.running && s.runConversation !== s.conversationId);
  const starting = useStore((s) => s.starting);
  // `지금 압축`이 도는 동안에는 엔진이 실행을 받지 않는다. 보내기를 꺼 둔다 (`/도구` 직접 실행도 보내기로 간다).
  const compacting = useStore((s) => s.compacting);
  const items = useStore((s) => s.items);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const answer = useStore((s) => s.answer);
  const steer = useStore((s) => s.steer);
  const tools = useStore(selectTools);
  const bypass = useStore((s) => s.ws?.state.bypass_locks ?? false);
  const setSessionState = useStore((s) => s.setSessionState);

  const box = useRef<HTMLTextAreaElement>(null);
  const [pick, setPick] = useState(0); // `/` 목록에서 고른 줄
  const steering = useRef(false); // 끼워 넣는 말을 보내는 중

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft]);
  useEffect(() => {
    if (focusTick === 0) return;
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusTick]);

  const enabled = tools.filter((t) => t.enabled && t.prompt.trim());
  // `/`로 시작하고 아직 띄어 쓰지 않았으면 도구 목록을 띄운다.
  const slash = /^\/(\S*)$/.exec(draft);
  const matches = slash ? enabled.filter((t) => t.label.includes(slash[1]) || t.name.includes(slash[1])) : [];
  const choose = (t: ToolDef) => {
    setDraft(`/${t.label} `);
    setPick(0);
    box.current?.focus();
  };

  const status = running ? runSummary(items) : null;
  const question = status?.waiting?.askKind === "question" ? status.waiting : null;
  const written = Boolean(draft.trim());
  // 실행 중에도 글이 있으면 보낸다. 질문을 받고 있으면 그 답이고, 그 밖에는(승인·반려를 기다리는 중에도) 끼워 넣는 말이다.
  const canSend = !starting && !elsewhere && !compacting && (running ? written : written || Boolean(quote));

  const submit = () => {
    if (!canSend) return;
    // 알림 권한은 사용자 동작 안에서만 물을 수 있다. 요청을 처음 보내는 이때 한 번 묻는다.
    askNotifyPermission();
    if (question) {
      void answer(question.eventId, draft.trim());
      setDraft("");
    } else if (running) {
      // 채팅창은 받아들여진 뒤에 store가 비운다. 그 사이에 Enter를 한 번 더 눌러도 같은 말이 두 번 가지 않게 한다.
      if (steering.current) return;
      steering.current = true;
      void steer(draft).finally(() => (steering.current = false));
    } else void send();
  };

  return (
    <div className="mx-auto w-full max-w-[780px] shrink-0 px-5 pb-4">
      {bypass && (
        // 좁은 칸에서는 뒤의 말이 잘리고, 이름과 `끄기`는 꺾이지 않는다.
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-[#fbeceb] px-3 py-1.5 text-[13px] text-danger">
          <span className="shrink-0 font-bold whitespace-nowrap">권한 무시 켜짐</span>
          <span className="min-w-0 truncate" title="수정 방지된 문서도 에이전트가 고칩니다">
            수정 방지된 문서도 에이전트가 고칩니다
          </span>
          <button type="button" className="ml-auto shrink-0 border-0 bg-transparent p-0 font-bold whitespace-nowrap text-danger underline" onClick={() => void setSessionState({ bypass_locks: false })}>
            끄기
          </button>
        </div>
      )}
      {status && (
        <div className={`mb-1.5 flex items-center gap-2 px-1 text-[13px] ${status.waiting ? "text-blue" : "text-agent"}`}>
          {status.waiting ? <span className="h-2 w-2 rounded-full bg-blue" /> : <Spinner />}
          <span className="font-bold">{status.label}</span>
          {status.calls && <span className="text-muted">{status.calls}</span>}
        </div>
      )}
      {elsewhere && <RunningElsewhere />}
      {compacting && (
        <div className="mb-1.5 flex items-center gap-2 px-1 text-[13px] text-agent">
          <Spinner />
          <span className="font-bold">압축 중</span>
        </div>
      )}

      {/* 평소에는 차분하게 두고, 글을 쓰는 동안(글 칸에 초점이 있을 때)에만 파란 테두리와 옅은 파란 띠가 뜬다. */}
      <div className="relative rounded-[20px] border border-line bg-bg shadow-[0_2px_10px_rgba(26,26,46,0.06)] transition-[border-color,box-shadow] duration-150 has-[textarea:focus]:border-blue has-[textarea:focus]:shadow-[0_0_0_4px_var(--color-blue-tint)]">
        {matches.length > 0 && (
          <div className="pop absolute right-0 bottom-full left-0 z-30 mb-2 max-h-72 overflow-y-auto" role="listbox" aria-label="도구">
            {matches.map((t, i) => (
              <MenuItem key={t.name} active={i === pick % matches.length} hint={t.description} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(t)}>
                /{t.label}
              </MenuItem>
            ))}
          </div>
        )}

        {quote && (
          <div className="mx-3 mt-3 flex items-start gap-2 rounded-lg bg-mark-tint px-3 py-2 text-[13px]">
            <div className="min-w-0 flex-1 border-l-[3px] border-mark pl-2.5">
              <div className="text-xs text-muted">
                {quote.label} · {quote.text.length.toLocaleString("ko-KR")}자
              </div>
              <div className="line-clamp-2 font-serif whitespace-pre-wrap">{quote.text}</div>
            </div>
            <button type="button" aria-label="인용 빼기" title="인용 빼기" className="border-0 bg-transparent p-0.5 text-muted hover:text-ink" onClick={() => setQuote(null)}>
              <CloseIcon />
            </button>
          </div>
        )}

        <textarea
          ref={box}
          rows={1}
          aria-label="요청"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setPick(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (matches.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPick((pick + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                choose(matches[pick % matches.length]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft("");
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="block w-full resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 leading-relaxed outline-none"
        />

        <div className="flex items-center gap-1 px-2 pt-1 pb-2">
          <PlusMenu sessionId={sessionId} tools={enabled} />
          <ModelButton />
          <ModeButton />
          <span className="flex-1" />
          <ContextRing />
          {/* 실행 중에는 쓰기 전까지 중단이다. 쓰기 시작하면 보내기로 바뀐다 (질문에는 답, 그 밖에는 끼워 넣는 말). */}
          {running && !written ? (
            <button type="button" aria-label="중단" title="중단" onClick={() => void stop()} className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-full bg-ink text-bg hover:opacity-85">
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              aria-label={question ? "답 보내기" : "보내기"}
              title={question ? "답 보내기" : "보내기"}
              disabled={!canSend}
              onClick={submit}
              className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-full bg-blue text-white hover:bg-blue-hover disabled:bg-line"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 다른 대화에서 실행 중일 때 채팅창 위에 뜨는 줄. 그 대화로 가는 길을 준다. */
function RunningElsewhere() {
  const there = useStore((s) => s.conversations.find((c) => c.id === s.runConversation));
  const cid = useStore((s) => s.runConversation);
  const selectConversation = useStore((s) => s.selectConversation);
  return (
    <div className="mb-1.5 flex items-center gap-2 px-1 text-[13px] text-muted">
      <span className="pulse h-2 w-2 shrink-0 rounded-full bg-agent" />
      <span className="shrink-0">다른 대화에서 실행 중</span>
      {cid && (
        <TextButton className="min-w-0 truncate" onClick={() => void selectConversation(cid)}>
          {there?.name || "새 대화"}
        </TextButton>
      )}
    </div>
  );
}

const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-[13px] text-muted hover:bg-sunken hover:text-ink";

/** `+`: 파일 올리기, 새 대화, 도구 고르기. */
function PlusMenu({ sessionId, tools }: { sessionId: string | null; tools: ToolDef[] }) {
  const insertCommand = useStore((s) => s.insertCommand);
  const uploadFiles = useStore((s) => s.uploadFiles);
  const openDoc = useStore((s) => s.openDoc);
  const newConversation = useStore((s) => s.newConversation);
  const file = useRef<HTMLInputElement>(null);

  const upload = async (files: File[]) => {
    if (!sessionId) return;
    // 결과와 실패 이유(텍스트가 안 뽑히는 파일 등)는 올리는 쪽이 한 번에 알린다.
    const done = await uploadFiles(files);
    // 올린 것을 바로 보이게 한다: 하나면 그 문서를, 여럿이면 자료 탭을 연다.
    if (done.length === 1) openDoc(done[0].path);
    else if (done.length > 1) useStore.getState().setLeftTab("materials");
  };

  return (
    <>
      <input
        ref={file}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void upload(files);
        }}
      />
      <Popover
        side="top"
        trigger={(open, toggle) => (
          <button type="button" aria-label="더하기" title="파일 올리기, 새 대화, 도구 고르기" aria-expanded={open} onClick={toggle} className={`${chip} !w-7 justify-center !px-0`}>
            <PlusIcon />
          </button>
        )}
      >
        {(close) => (
          <div className="w-64 max-w-full">
            <MenuItem
              onClick={() => {
                close();
                file.current?.click();
              }}
            >
              <UploadIcon /> 파일 올리기
            </MenuItem>
            {/* 앞의 대화는 목록에 남는다. 새 대화의 에이전트는 다른 대화에서 한 말을 모르고 문서만 같이 쓴다. */}
            <MenuItem
              onClick={() => {
                close();
                void newConversation();
              }}
            >
              <NewChatIcon /> 새 대화
            </MenuItem>
            {tools.length > 0 && <div className="mx-2.5 my-1 border-t border-hair" />}
            {tools.map((t) => (
              <MenuItem
                key={t.name}
                hint={t.description}
                onClick={() => {
                  close();
                  insertCommand(t.label);
                }}
              >
                <ToolIcon /> {t.label}
              </MenuItem>
            ))}
          </div>
        )}
      </Popover>
    </>
  );
}

/**
 * 모델·추론 수준. 프리셋의 값을 그대로 보이고, 바꾸면 프리셋이 바뀐다 (에이전트 패널의 모델 칸과 같은 값이다).
 * 같은 프리셋을 쓰는 다른 작업도 같이 바뀐다.
 */
function ModelButton() {
  const state = useStore((s) => s.ws?.state);
  const preset = useStore((s) => s.preset);
  const changeModel = useStore((s) => s.changeModel);
  // 모델이 없어서 보내지 못했으면 store가 이 값을 올린다. 그때 고르기를 열어 준다.
  const modelTick = useStore((s) => s.modelTick);
  const button = useRef<HTMLButtonElement>(null);
  const seen = useRef(modelTick);
  useEffect(() => {
    if (modelTick === seen.current) return;
    seen.current = modelTick;
    const el = button.current;
    if (el && el.getAttribute("aria-expanded") !== "true") el.click();
  }, [modelTick]);
  if (!state || !preset) return null;

  const name = modelShort(preset.model);
  // 서버가 이 모델을 보고도 실제로 쓸 모델을 비워 줬으면 쓸 수 없는 것이다 (그 제공자가 없거나 꺼져 있다).
  // 방금 바꿔서 서버의 답이 아직 안 온 동안에는(state.model이 옛 값) 아무 말도 하지 않는다.
  const unusable = name !== "" && state.model === preset.model && !state.effective_model;
  const thinking = preset.thinking;
  return (
    <Popover
      side="top"
      trigger={(open, toggle) => (
        <button ref={button} type="button" aria-expanded={open} title="모델과 추론 수준" onClick={toggle} className={`${chip} ${name && !unusable ? "" : "font-bold !text-danger"}`}>
          <span className="max-w-44 truncate">{name || "모델 고르기"}</span>
          {unusable && <span className="text-xs whitespace-nowrap">쓸 수 없음</span>}
          {!unusable && name && thinking !== "default" && thinking !== "off" && <span className="text-xs whitespace-nowrap">추론 {THINKING_LABEL[thinking]}</span>}
        </button>
      )}
    >
      {() => (
        <div className="flex w-[340px] max-w-full flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">모델</span>
            <ModelPicker value={preset.model} onChange={(model) => void changeModel({ model })} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">추론</span>
            <Segmented label="추론" value={thinking} onChange={(v) => void changeModel({ thinking: v })} options={THINKINGS.map((t) => ({ value: t, label: THINKING_LABEL[t] }))} />
          </div>
        </div>
      )}
    </Popover>
  );
}

/** 모드(수동/자동/자율/계획)와 권한 무시. */
function ModeButton() {
  const state = useStore((s) => s.ws?.state);
  const modes = useStore((s) => s.meta?.modes) ?? [];
  const running = useStore((s) => s.running);
  const setSessionState = useStore((s) => s.setSessionState);
  if (!state) return null;
  return (
    <Popover
      side="top"
      trigger={(open, toggle) => (
        <button type="button" aria-expanded={open} title="모드" onClick={toggle} className={`${chip} ${state.mode === "autonomous" ? "!text-agent" : ""}`}>
          {MODE_LABEL[state.mode]}
        </button>
      )}
    >
      {(close) => (
        <div className="w-80 max-w-full">
          {MODES.map((m) => (
            <MenuItem
              key={m}
              active={state.mode === m}
              hint={modes.find((x) => x.id === m)?.description ?? MODE_HINT[m]}
              disabled={running}
              onClick={() => {
                close();
                void setSessionState({ mode: m });
              }}
            >
              {MODE_LABEL[m]}
            </MenuItem>
          ))}
          <div className="mx-2.5 my-1 border-t border-hair" />
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
            <span className="flex-1">
              권한 무시
              <span className="block text-xs text-muted">수정 방지된 문서도 고칩니다</span>
            </span>
            <Toggle label="권한 무시" checked={state.bypass_locks} disabled={running} onChange={(v) => void setSessionState({ bypass_locks: v })} />
          </div>
        </div>
      )}
    </Popover>
  );
}

/**
 * 컨텍스트가 얼마나 찼는지. 누르면 나오는 창에서 자동 압축을 켜고 끄고, 지금 압축할 수 있다.
 * 한도는 프리셋의 컨텍스트 한도다. 자동 압축을 꺼 두면 100%를 넘을 수 있다 (원은 다 찬 채로 있다).
 */
function ContextRing() {
  const context = useStore((s) => s.ws?.context);
  const autoCompact = useStore((s) => s.ws?.state.auto_compact ?? true);
  const idle = useStore((s) => !s.running && !s.starting);
  const setSessionState = useStore((s) => s.setSessionState);
  const compactNow = useStore((s) => s.compactNow);
  const busy = useStore((s) => s.compacting);
  if (!context) return null;
  const percent = context.budget ? Math.round((context.tokens / context.budget) * 100) : 0;
  const ratio = Math.min(1, percent / 100);
  const r = 7;
  const len = 2 * Math.PI * r;
  return (
    <Popover
      side="top"
      align="right"
      trigger={(open, toggle) => (
        <button type="button" aria-label="컨텍스트" title="컨텍스트" aria-expanded={open} onClick={toggle} className={`${chip} !px-1.5`}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2.5" />
            <circle
              cx="10"
              cy="10"
              r={r}
              fill="none"
              stroke={ratio > 0.85 ? "var(--color-danger)" : "var(--color-blue)"}
              strokeWidth="2.5"
              strokeDasharray={`${len * ratio} ${len}`}
              strokeLinecap="round"
              transform="rotate(-90 10 10)"
            />
          </svg>
        </button>
      )}
    >
      {() => (
        <div className="w-72 max-w-full p-3 text-[13px]">
          <div className="flex items-baseline gap-2">
            <span className="font-bold">
              {context.tokens.toLocaleString("ko-KR")}
              {context.budget > 0 && ` / ${context.budget.toLocaleString("ko-KR")}`} 토큰
            </span>
            {context.budget > 0 && <span className="text-xs text-muted">{percent}%</span>}
          </div>
          <div className="mt-2.5 flex items-center gap-2 border-t border-hair pt-2.5">
            <span className="flex-1">자동 압축</span>
            <Toggle label="자동 압축" checked={autoCompact} onChange={(v) => void setSessionState({ auto_compact: v })} />
          </div>
          <Button
            small
            className="mt-2 w-full"
            disabled={!idle || busy}
            onClick={() => void compactNow()}
          >
            {busy ? "압축 중" : "지금 압축"}
          </Button>
          <UsageTable />
        </div>
      )}
    </Popover>
  );
}

const money = (usd: number) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;

/** 이 작업에서 지금까지 쓴 토큰과 비용. 팝업이 열릴 때마다 새로 받는다. */
function UsageTable() {
  const sessionId = useStore((s) => s.sessionId);
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    // 못 받으면 위의 컨텍스트 줄만 남는다. 곁들이는 숫자라 오류로 알리지 않는다.
    api.usage(sessionId).then(
      (u) => alive && setUsage(u),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);
  if (!usage || usage.runs === 0) return null;

  const rows: { name: string; tokens: string; cost: number | null }[] = [
    { name: "에이전트", tokens: `입력 ${formatTokens(usage.agent.prompt_tokens)} · 출력 ${formatTokens(usage.agent.output_tokens)}`, cost: usage.agent.cost_usd },
    ...usage.tools.filter((t) => t.calls > 0).map((t) => ({ name: `${t.label || t.tool} ${t.calls}회`, tokens: formatTokens(t.total_tokens), cost: t.cost_usd })),
  ];
  if (usage.auxiliary.calls > 0) rows.push({ name: `보조 모델 ${usage.auxiliary.calls}회`, tokens: formatTokens(usage.auxiliary.total_tokens), cost: usage.auxiliary.cost_usd });

  return (
    <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1 border-t border-hair pt-2.5 text-xs">
      <div className="col-span-3 text-muted">실행 {usage.runs.toLocaleString("ko-KR")}회</div>
      {rows.map((r) => (
        <div key={r.name} className="contents">
          <span className="truncate">{r.name}</span>
          <span className="text-right text-muted tabular-nums">{r.tokens}</span>
          <span className="text-right tabular-nums">{r.cost === null ? "" : money(r.cost)}</span>
        </div>
      ))}
      {usage.total_cost_usd !== null && (
        <div className="contents font-bold">
          <span>합계</span>
          <span className="text-right">{!usage.cost_complete && <Tag title="단가를 모르는 모델의 호출이 빠져 있습니다">일부만</Tag>}</span>
          <span className="text-right tabular-nums">{money(usage.total_cost_usd)}</span>
        </div>
      )}
    </div>
  );
}
