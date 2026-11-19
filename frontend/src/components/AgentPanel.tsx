import { useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { MODES, MODE_LABEL, THINKING_LABEL, THINKINGS, modelShort } from "../lib/labels";
import { SUMMARY_TOOL, type Mode, type Thinking, type ToolDef } from "../lib/types";
import { ARCHIVE_ACCEPT, useStore } from "../store";
import { Chevron } from "./icons";
import { ModelPicker, NumberBox } from "./SettingsView";
import { AutoTextarea, Button, Field, MenuItem, Popover, Toggle, inputClass } from "./ui";

/**
 * 에이전트 패널 = 지금 프리셋의 내용. 맨 위에 프리셋의 이름이 있고 그 아래에 지침, 모델 설정 두 묶음(에이전트, 보조),
 * 도구 한 벌이 올라와 있다. 고치면 곧 저장된다 (저장 버튼이 없는 대신 이름 옆에 `자동 저장`이 적혀 있다).
 * 모델 설정은 여기에만 있다. 채팅창 하단의 모델·추론 수준은 이 패널의 에이전트 묶음과 같은 값이다.
 */
export function AgentPanel() {
  const preset = useStore((s) => s.preset);
  const edit = useStore((s) => s.editPreset);
  const openDialog = useStore((s) => s.openDialog);
  const modes = useStore((s) => s.meta?.modes);
  // 엔진이 알려 주지 않으면(값이 없으면) 되는지 안 되는지 말하지 않는다.
  const available = useStore((s) => s.ws?.state.available);
  // 쓰던 프리셋을 지워서 남은 것이 없는 작업. 프리셋 창에서 새로 만들거나 가져온다.
  if (!preset)
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted">
        <span className="flex-1">프리셋 없음</span>
        <Button small onClick={() => openDialog({ type: "presets" })}>
          프리셋
        </Button>
      </div>
    );

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <PresetBar name={preset.name} id={preset.id} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-5">
        <section>
          <Head title="지침">
            <Button small variant="quiet" onClick={() => openDialog({ type: "text", field: "instruction" })}>
              크게
            </Button>
          </Head>
          <AutoTextarea aria-label="지침" minRows={6} maxHeight={260} value={preset.instruction} onChange={(e) => edit({ instruction: e.target.value })} />
          {/* 이 프리셋으로 새 작업을 만들 때의 모드. 일하는 방식이라 지침 곁에 둔다. 이미 있는 작업의 모드는 바뀌지 않는다. */}
          <Field className="mt-3 max-w-44" label="시작 모드">
            <select
              className={inputClass}
              title="이 프리셋으로 새 작업을 만들 때의 모드"
              value={preset.start_mode}
              onChange={(e) => edit({ start_mode: e.target.value as Mode | "" })}
            >
              <option value="">정하지 않음</option>
              {(modes ?? MODES.map((id) => ({ id, label: MODE_LABEL[id] }))).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </section>

        <section className="mt-7">
          <Head title="에이전트 모델" />
          <div className="flex flex-col gap-3">
            <ModelPicker label="에이전트 모델" value={preset.model} onChange={(model) => edit({ model })} />
            <div className={grid}>
              <ThinkingField value={preset.thinking} onChange={(thinking) => edit({ thinking })} />
              <Field label="온도">
                <NumberBox decimal max={2} placeholder="기본" value={preset.temperature} onChange={(temperature) => edit({ temperature })} />
              </Field>
              <Field label="최대 출력">
                <NumberBox min={1} placeholder="기본" value={preset.max_output_tokens} onChange={(max_output_tokens) => edit({ max_output_tokens })} />
              </Field>
              {/* 컨텍스트 한도만 숫자가 꼭 있다. 0이면 대화를 줄이지 않는다. */}
              <Field label="컨텍스트 한도">
                <NumberBox required value={preset.context_budget} onChange={(v) => v !== null && edit({ context_budget: v })} />
              </Field>
            </div>
          </div>
        </section>

        {/* 도구가 따로 정하지 않았을 때 쓰는 값. 대화 압축도 이 모델로 한다. */}
        <section className="mt-7">
          <Head title="보조 모델" />
          <div className="flex flex-col gap-3">
            <ModelPicker label="보조 모델" value={preset.auxiliary_model} onChange={(auxiliary_model) => edit({ auxiliary_model })} emptyLabel="에이전트 모델과 같게" />
            <div className={grid}>
              <ThinkingField value={preset.auxiliary_thinking} onChange={(auxiliary_thinking) => edit({ auxiliary_thinking })} />
              <Field label="온도">
                <NumberBox decimal max={2} placeholder="기본" value={preset.auxiliary_temperature} onChange={(auxiliary_temperature) => edit({ auxiliary_temperature })} />
              </Field>
              <Field label="최대 출력">
                <NumberBox
                  min={1}
                  placeholder="기본"
                  value={preset.auxiliary_max_output_tokens}
                  onChange={(auxiliary_max_output_tokens) => edit({ auxiliary_max_output_tokens })}
                />
              </Field>
              <Field label="최대 입력">
                <NumberBox
                  min={1}
                  placeholder="없음"
                  value={preset.auxiliary_max_input_tokens}
                  onChange={(auxiliary_max_input_tokens) => edit({ auxiliary_max_input_tokens })}
                />
              </Field>
            </div>
          </div>
        </section>

        {/* 그림을 만드는 모델. 에이전트 모델과 따로 둔다 (그림을 만드는 모델은 보통 도구를 쓰지 못한다). 정해 두면 에이전트가 `이미지 만들기`를 쓴다. */}
        <section className="mt-7">
          <Head title="이미지 모델" />
          <ModelPicker label="이미지 모델" value={preset.image_model} onChange={(image_model) => edit({ image_model })} emptyLabel="없음" />
        </section>

        <section className="mt-7">
          <Head title="도구">
            <AddTool tools={preset.tools} />
          </Head>
          <div className="-mx-2.5 flex flex-col">
            {preset.tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} />
            ))}
          </div>
        </section>

        {/* 제공자가 실행하는 도구. 지금 모델에서 안 되는 것도 켜 둘 수 있다 (모델을 바꾸면 쓰인다). */}
        <section className="mt-7">
          <Head title="제공자 도구" />
          <div className="flex flex-col">
            <NativeRow label="웹 검색" checked={preset.web_search} unavailable={available?.web_search === false} onChange={(web_search) => edit({ web_search })} />
            <NativeRow label="웹 페이지 읽기" checked={preset.web_fetch} unavailable={available?.web_fetch === false} onChange={(web_fetch) => edit({ web_fetch })} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** 칸 넷이 놓이는 격자. 패널이 넓으면 네 칸이 한 줄, 좁으면 둘씩 두 줄. */
const grid = "grid grid-cols-2 gap-3 @[520px]:grid-cols-4";

/**
 * 패널의 맨 윗줄: 프리셋의 이름(누르면 프리셋을 바꾸는 창)과 내보내기, 가져오기.
 * 아래의 것이 전부 이 프리셋의 내용이라는 것을 이 줄이 알린다.
 */
function PresetBar({ name, id }: { name: string; id: string }) {
  const openDialog = useStore((s) => s.openDialog);
  const fail = useStore((s) => s.fail);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const run = async (job: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await job();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const exportFile = () =>
    run(async () => {
      // 방금 고친 것까지 들어가도록, 밀려 있는 저장을 먼저 끝낸다.
      await useStore.getState().flushPreset();
      await api.exportPreset(id); // <이름>.alephpreset
    });

  const importFile = (picked: File) =>
    run(async () => {
      const got = await useStore.getState().importFile(picked);
      // 들어온 프리셋은 목록에 더해질 뿐 이 작업의 프리셋이 바뀌지는 않는다. 목록을 띄워 고를 수 있게 한다.
      if (got?.kind === "preset") openDialog({ type: "presets" });
    });

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2.5 pl-1.5">
      <button
        type="button"
        title="프리셋"
        aria-label={`프리셋 ${name}`}
        onClick={() => openDialog({ type: "presets" })}
        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 text-left hover:bg-sunken"
      >
        <span className="min-w-0 truncate text-[15px] font-black">{name}</span>
        <span className="shrink-0 text-muted">
          <Chevron />
        </span>
        <span className="hidden shrink-0 pl-1 text-xs text-edge @[340px]:inline">자동 저장</span>
      </button>
      <Button small variant="quiet" disabled={busy} onClick={() => void exportFile()}>
        내보내기
      </Button>
      <Button small variant="quiet" disabled={busy} onClick={() => file.current?.click()}>
        가져오기
      </Button>
      <input
        ref={file}
        type="file"
        accept={ARCHIVE_ACCEPT}
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (picked) void importFile(picked);
        }}
      />
    </div>
  );
}

/** 구획의 머리줄. 작업 패널과 같은 모양이다 (굵은 글자 위에 짧은 파란 줄. 구획 사이에는 따로 줄을 긋지 않는다). */
function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-1.5 flex min-h-7 items-end gap-2">
      <h3 className="head-bar">{title}</h3>
      <span className="flex-1" />
      {children}
    </div>
  );
}

function ThinkingField({ value, onChange }: { value: Thinking; onChange: (v: Thinking) => void }) {
  return (
    <Field label="추론">
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value as Thinking)}>
        {THINKINGS.map((t) => (
          <option key={t} value={t}>
            {THINKING_LABEL[t]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * `+ 도구`. 요약 도구는 다른 도구처럼 지울 수 있으므로, 프리셋에 없으면 여기서 다시 넣을 수 있게 고르기를 띄운다.
 * 채울 값은 엔진이 준 기본 꼴(`meta.summary_tool`)이다.
 */
function AddTool({ tools }: { tools: ToolDef[] }) {
  const summaryTool = useStore((s) => s.meta?.summary_tool);
  const openDialog = useStore((s) => s.openDialog);
  const saveTool = useStore((s) => s.saveTool);
  const fresh = () => openDialog({ type: "tool", name: null });

  if (!summaryTool || tools.some((t) => t.name === SUMMARY_TOOL))
    return (
      <Button small variant="quiet" onClick={fresh}>
        + 도구
      </Button>
    );
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <Button small variant="quiet" aria-haspopup="true" aria-expanded={open} onClick={toggle}>
          + 도구
        </Button>
      )}
    >
      {(close) => (
        <div className="w-40 max-w-full">
          <MenuItem
            onClick={() => {
              close();
              fresh();
            }}
          >
            새 도구
          </MenuItem>
          <MenuItem
            onClick={() => {
              close();
              saveTool(null, { ...summaryTool, name: SUMMARY_TOOL });
            }}
          >
            {summaryTool.label || "요약"} 도구
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

function ToolRow({ tool }: { tool: ToolDef }) {
  const saveTool = useStore((s) => s.saveTool);
  const openDialog = useStore((s) => s.openDialog);
  const model = modelShort(tool.model);
  return (
    // 스위치와 줄 전체 누르기가 겹치지 않게, 버튼 둘을 나란히 둔다 (버튼 안에 버튼을 넣을 수 없다).
    <div className="flex items-center rounded-lg pl-2.5 hover:bg-sunken">
      <Toggle checked={tool.enabled} label={`${tool.label} 사용`} onChange={(enabled) => saveTool(tool.name, { ...tool, enabled })} />
      <button
        type="button"
        onClick={() => openDialog({ type: "tool", name: tool.name })}
        className="flex min-w-0 flex-1 flex-col border-0 bg-transparent py-1.5 pr-2.5 pl-2.5 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 truncate font-bold ${tool.enabled ? "" : "text-muted"}`}>{tool.label}</span>
          {/* 지시문이 빈 도구는 저장은 되지만 에이전트에게 주어지지 않고 돌릴 수도 없다 */}
          {!tool.prompt.trim() && <span className="shrink-0 text-xs text-danger">지시문 없음</span>}
          {model && <span className="ml-auto max-w-[50%] shrink-0 truncate text-xs text-muted">{model}</span>}
        </span>
        {tool.description && <span className="truncate text-[13px] text-muted">{tool.description}</span>}
      </button>
    </div>
  );
}

/** 제공자 도구 한 줄. 도구 줄과 스위치 자리를 맞춘다. 눌러서 열 것이 없으니 줄 바탕은 바뀌지 않는다. */
function NativeRow({ label, checked, unavailable, onChange }: { label: string; checked: boolean; unavailable: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <Toggle checked={checked} label={`${label} 사용`} onChange={onChange} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`min-w-0 truncate font-bold ${checked ? "" : "text-muted"}`}>{label}</span>
        {unavailable && <span className="shrink-0 text-xs text-muted">지금 모델에서는 안 됨</span>}
      </span>
    </div>
  );
}
