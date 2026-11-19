import { useEffect, useRef, useState } from "react";
import { THINKING_LABEL, THINKINGS } from "../../lib/labels";
import type { ToolDef } from "../../lib/types";
import { useStore } from "../../store";
import { ModelField, ModelPicker, NumberBox } from "../SettingsView";
import { AutoTextarea, Button, ConfirmButton, Dialog, Field, Toggle, boxClass, inputClass } from "../ui";

/** 새 도구. 영문 이름은 차례로 붙인다 (`tool_1`, `tool_2` …). 사용자가 도구 창에서 뜻이 있는 이름으로 고칠 수 있다. */
function freshTool(tools: ToolDef[]): ToolDef {
  const names = new Set(tools.map((t) => t.name));
  let name = "tool_1";
  for (let n = 2; names.has(name); n++) name = `tool_${n}`;
  const labels = new Set(tools.map((t) => t.label));
  let label = "새도구";
  for (let n = 2; labels.has(label); n++) label = `새도구${n}`;
  return { name, label, description: "", prompt: "", model: "", temperature: null, thinking: "", max_tokens: null, enabled: true };
}

/** 방금 영문 이름을 바꿔서 생긴 이름. 그 이름으로 창이 다시 그려질 때를 알아본다. */
let justRenamed = "";

/**
 * 영문 이름: 모델이 부르는 함수 이름이다. 뜻이 있는 이름이 모델이 도구를 고르는 데도 낫다.
 * 다른 칸처럼 치는 족족 저장하지 않는다. 쓰는 도중의 값(한 글자 등)은 엔진이 거절하므로 칸을 떠날 때 저장하고,
 * 안 되면 원래 이름으로 돌아가면서 이유를 보인다. 규칙은 엔진이 본다 (여기서는 뻔한 것만 미리 거른다).
 */
function IdField({ tool }: { tool: ToolDef }) {
  const renameTool = useStore((s) => s.renameTool);
  const tools = useStore((s) => s.preset?.tools);
  const agentTools = useStore((s) => s.meta?.agent_tools);
  const [text, setText] = useState(tool.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    const next = text.trim();
    if (busy || next === tool.name) return;
    const refuse = (reason: string) => {
      setError(reason);
      setText(tool.name);
    };
    if (!/^[a-z][a-z0-9_]{1,48}$/.test(next)) return refuse("소문자로 시작, 소문자·숫자·_ 2~49자");
    if (tools?.some((t) => t.name === next)) return refuse("같은 이름이 있습니다");
    if (agentTools?.some((t) => t.name === next)) return refuse("기본 도구의 이름입니다");
    setBusy(true);
    justRenamed = next;
    const reason = await renameTool(tool.name, next);
    // 됐으면 창이 새 이름으로 다시 그려져서 이 칸은 사라진다.
    if (reason === null) return;
    justRenamed = "";
    setBusy(false);
    refuse(reason);
  };

  return (
    <Field className="max-w-xs flex-[1_1_180px]" label="영문 이름" right={error ? <span className="text-danger">{error}</span> : undefined}>
      <input
        className={`${inputClass} font-mono !text-[13px] ${error ? "!border-danger" : ""}`}
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        disabled={busy}
        onChange={(e) => {
          setError("");
          setText(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape" && text !== tool.name) {
            // 고치던 것만 되돌린다. 창은 닫지 않는다.
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setText(tool.name);
            setError("");
          }
        }}
      />
    </Field>
  );
}

/** 도구 하나를 고친다. name이 null이면 도구를 하나 만들어 넣고 그 도구로 다시 연다. */
export function ToolDialog({ name }: { name: string | null }) {
  const tool = useStore((s) => (name === null ? undefined : s.preset?.tools.find((t) => t.name === name)));
  const saveTool = useStore((s) => s.saveTool);
  const openDialog = useStore((s) => s.openDialog);
  const closeDialog = useStore((s) => s.closeDialog);

  // StrictMode는 effect를 두 번 돌린다. 도구가 둘 생기지 않게 한 번만 만든다.
  const made = useRef(false);
  useEffect(() => {
    if (name !== null || made.current) return;
    made.current = true;
    const preset = useStore.getState().preset;
    if (!preset) {
      closeDialog();
      return;
    }
    const created = freshTool(preset.tools);
    saveTool(null, created);
    openDialog({ type: "tool", name: created.name });
  }, [name, saveTool, openDialog, closeDialog]);

  // 열려 있는 동안 도구가 사라지면(삭제, 프리셋 바꿈) 닫는다.
  const gone = name !== null && !tool;
  useEffect(() => {
    if (gone) closeDialog();
  }, [gone, closeDialog]);

  // 복제하면 열린 채로 사본으로 옮겨 간다. 이름 칸이 앞 도구의 것을 쥐고 있지 않게 도구마다 새로 그린다.
  return tool ? <ToolForm key={tool.name} tool={tool} /> : null;
}

function ToolForm({ tool }: { tool: ToolDef }) {
  // 선택 함수가 매번 새 배열을 돌려주면 다시 그리기가 끝나지 않으므로, 걸러 내는 일은 밖에서 한다.
  const tools = useStore((s) => s.preset?.tools);
  const others = (tools ?? []).filter((t) => t.name !== tool.name).map((t) => t.label);
  const saveTool = useStore((s) => s.saveTool);
  const removeTool = useStore((s) => s.removeTool);
  const close = useStore((s) => s.closeDialog);
  const openDialog = useStore((s) => s.openDialog);
  const notify = useStore((s) => s.notify);
  const change = (patch: Partial<ToolDef>) => saveTool(tool.name, { ...tool, ...patch });

  /** 같은 내용의 도구를 하나 더 만들어 그것을 연다. 지시문만 바꿔 같은 입력으로 비교할 때 쓴다. */
  const duplicate = () => {
    const all = tools ?? [];
    const labels = new Set(all.map((t) => t.label));
    let copyLabel = `${tool.label}2`;
    for (let n = 3; labels.has(copyLabel); n++) copyLabel = `${tool.label}${n}`;
    const copy: ToolDef = { ...tool, name: freshTool(all).name, label: copyLabel };
    saveTool(null, copy);
    openDialog({ type: "tool", name: copy.name });
    notify(`'${copyLabel}' 복제됨`);
  };

  // 이름은 비거나 다른 도구와 겹치면 저장하지 않는다 (서버가 프리셋 전체를 거절한다).
  // 그런 동안에는 화면에만 두고, 칸을 떠나면 저장된 이름으로 돌아온다.
  const [label, setLabel] = useState(tool.label);
  const taken = others.includes(label);

  // 갓 만든 도구는 이름부터 고치게 한다.
  const labelRef = useRef<HTMLInputElement>(null);
  const isNew = useRef(tool.prompt === "" && tool.description === "");
  useEffect(() => {
    // 영문 이름을 바꾸면 이 창이 새 이름으로 다시 그려진다. 그때는 초점을 이름 칸으로 끌어오지 않는다.
    if (!isNew.current || tool.name === justRenamed) return;
    labelRef.current?.focus();
    labelRef.current?.select();
  }, []);

  return (
    <Dialog
      size="lg"
      title="도구"
      onClose={close}
      footer={
        <>
          <ConfirmButton
            small={false}
            label="삭제"
            onConfirm={() => {
              removeTool(tool.name);
              close();
            }}
          />
          <Button variant="quiet" onClick={duplicate}>
            복제
          </Button>
          <span className="flex-1" />
          <Button onClick={close}>닫기</Button>
        </>
      }
    >
      {/* 도구는 언제나 입력을 읽고 출력에 쓴다 */}
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <span>입력</span>
        <span aria-hidden="true">→</span>
        <span className="font-bold text-agent">{label || tool.label}</span>
        <span aria-hidden="true">→</span>
        <span>출력</span>
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-4">
        <Field className="max-w-sm flex-[1_1_220px]" label="이름" right={taken ? <span className="text-danger">같은 이름이 있습니다</span> : undefined}>
          {/* 채팅창에서 `/이름`으로 부른다는 것을 앞의 빗금으로 보인다 */}
          <span className="relative block">
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">/</span>
            <input
              ref={labelRef}
              className={`${inputClass} !pl-5 font-bold ${taken ? "!border-danger" : ""}`}
              value={label}
              spellCheck={false}
              onChange={(e) => {
                const next = e.target.value.replace(/\s+/g, ""); // 공백 없이
                setLabel(next);
                if (next && !others.includes(next)) change({ label: next });
              }}
              onBlur={() => (label === "" || taken) && setLabel(tool.label)}
            />
          </span>
        </Field>
        <IdField tool={tool} />
      </div>

      <Field label="설명">
        <AutoTextarea minRows={2} maxHeight={160} value={tool.description} onChange={(e) => change({ description: e.target.value })} />
      </Field>

      <Field label="지시문">
        <textarea className={`${boxClass} resize-y leading-relaxed`} rows={14} value={tool.prompt} onChange={(e) => change({ prompt: e.target.value })} />
      </Field>

      {/* 아래 넷은 비우면 프리셋의 보조 값을 따른다 (에이전트 패널의 `보조 모델` 묶음). */}
      <ModelField label="모델">
        <ModelPicker value={tool.model} onChange={(model) => change({ model })} emptyLabel="보조 모델" />
      </ModelField>

      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-28" label="추론">
          <select className={inputClass} value={tool.thinking ?? ""} onChange={(e) => change({ thinking: e.target.value as ToolDef["thinking"] })}>
            <option value="">보조</option>
            {THINKINGS.map((t) => (
              <option key={t} value={t}>
                {THINKING_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field className="w-28" label="온도">
          <NumberBox decimal max={2} placeholder="보조" value={tool.temperature} onChange={(temperature) => change({ temperature })} />
        </Field>
        <Field className="w-32" label="최대 출력">
          <NumberBox min={1} placeholder="보조" value={tool.max_tokens} onChange={(max_tokens) => change({ max_tokens })} />
        </Field>
        <span className="flex-1" />
        <label className="flex h-9 items-center gap-2 text-[13px]">
          <span>사용</span>
          <Toggle checked={tool.enabled} label="사용" onChange={(enabled) => change({ enabled })} />
        </label>
      </div>
    </Dialog>
  );
}
