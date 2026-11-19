import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { PresetSummary } from "../../lib/types";
import { ARCHIVE_ACCEPT, useStore } from "../../store";
import { Button, ConfirmButton, Dialog, Field, Tag, inputClass } from "../ui";

/**
 * 프리셋 = 지금 에이전트 패널에 올라와 있는 지침·모델·도구 한 벌에 붙인 이름.
 * 여기서 다른 것을 불러오고, 다른 이름으로 저장하고, 복제하고, 파일로 주고받는다.
 */
export function PresetDialog() {
  const presets = useStore((s) => s.presets);
  const preset = useStore((s) => s.preset);
  const edit = useStore((s) => s.editPreset);
  const choose = useStore((s) => s.choosePreset);
  const duplicate = useStore((s) => s.duplicatePreset);
  const remove = useStore((s) => s.deletePreset);
  const importArchive = useStore((s) => s.importFile);
  const fail = useStore((s) => s.fail);
  const close = useStore((s) => s.closeDialog);

  const [busy, setBusy] = useState(false);
  const [saveAs, setSaveAs] = useState<string | null>(null); // null이면 입력칸을 닫아 둔다
  const file = useRef<HTMLInputElement>(null);

  /** 한 번에 하나씩만 한다 (복제를 연달아 눌러 사본이 여럿 생기지 않게). */
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

  const load = (id: string) =>
    run(async () => {
      if (id !== preset?.id) await choose(id);
      close();
    });

  const exportFile = (p: PresetSummary) =>
    run(async () => {
      // 지금 쓰는 것은 방금 고친 것까지 들어가도록, 밀려 있는 저장을 먼저 끝낸다.
      if (preset?.id === p.id) await useStore.getState().flushPreset();
      await api.exportPreset(p.id); // <이름>.alephpreset
    });

  const importFile = (picked: File) =>
    run(async () => {
      const got = await importArchive(picked);
      // 프리셋 자리에 작업 파일을 넣었으면 그 작업으로 옮겨 갔다. 이 창은 닫는다.
      if (got?.kind === "work") close();
    });

  const saveCopy = () => {
    const name = (saveAs ?? "").trim();
    if (!name) return;
    void run(async () => {
      await duplicate(name);
      setSaveAs(null);
    });
  };

  return (
    <Dialog
      title="프리셋"
      onClose={close}
      footer={
        <>
          {saveAs === null ? (
            <>
              <Button disabled={!preset || busy} onClick={() => setSaveAs("")}>
                다른 이름으로 저장
              </Button>
              <Button disabled={busy} onClick={() => file.current?.click()}>
                가져오기
              </Button>
            </>
          ) : (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveCopy();
              }}
            >
              <input
                autoFocus
                aria-label="새 프리셋 이름"
                placeholder="이름"
                className={`${inputClass} max-w-64`}
                value={saveAs}
                onChange={(e) => setSaveAs(e.target.value)}
                onKeyDown={(e) => {
                  // Esc는 팝업이 아니라 이 입력칸만 닫는다.
                  if (e.key !== "Escape") return;
                  e.stopPropagation();
                  setSaveAs(null);
                }}
              />
              <Button variant="primary" type="submit" disabled={!saveAs.trim() || busy}>
                저장
              </Button>
              <Button variant="quiet" onClick={() => setSaveAs(null)}>
                취소
              </Button>
            </form>
          )}
          <span className="flex-1" />
          <Button onClick={close}>닫기</Button>
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
        </>
      }
    >
      {preset && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
          <Field label="이름">
            <NameInput key={preset.id} value={preset.name} onCommit={(name) => edit({ name })} />
          </Field>
          <Field label="설명">
            <input className={inputClass} value={preset.description} onChange={(e) => edit({ description: e.target.value })} />
          </Field>
        </div>
      )}

      <div className="flex flex-col border-t border-ink">
        {presets.map((p) => {
          // 지금 쓰는 것은 위에서 고치는 대로 줄에도 바로 보인다.
          const current = preset && preset.id === p.id ? preset : null;
          const name = current ? current.name : p.name;
          const description = current ? current.description : p.description;
          return (
            <div key={p.id} className="flex items-center gap-1 border-b border-hair py-1.5">
              <button type="button" title="불러오기" disabled={busy} onClick={() => void load(p.id)} className="group flex min-w-0 flex-1 flex-col bg-transparent py-0.5 text-left">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-bold group-hover:text-blue">{name}</span>
                  {current && <Tag tone="outline">사용 중</Tag>}
                  {(p.builtin || p.has_builtin) && <Tag>기본 제공</Tag>}
                </span>
                {description && <span className="truncate text-[13px] text-muted">{description}</span>}
              </button>
              <Button small variant="quiet" disabled={busy} onClick={() => void run(() => duplicate(undefined, p.id))}>
                복제
              </Button>
              <Button small variant="quiet" disabled={busy} onClick={() => void exportFile(p)}>
                내보내기
              </Button>
              {/* 손대지 않은 기본 제공본은 지울 것이 없다. 고친 기본 제공본은 지우면 기본값으로 돌아간다. */}
              {!p.builtin && <ConfirmButton label={p.has_builtin ? "기본값으로" : "삭제"} confirm={p.has_builtin ? "되돌리기 확인" : undefined} disabled={busy} onConfirm={() => void run(() => remove(p.id))} />}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

/** 이름은 비워 둔 채로 저장하지 않는다. 비어 있는 동안에는 화면에만 두고, 칸을 떠나면 저장된 이름으로 돌아온다. */
function NameInput({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const [text, setText] = useState(value);
  // 저장된 이름이 밖에서 바뀌면 따라간다. 비워 놓고 새로 치는 중이면 건드리지 않는다.
  useEffect(() => {
    setText((cur) => (cur.trim() === "" ? cur : value));
  }, [value]);
  return (
    <input
      className={`${inputClass} font-bold`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim()) onCommit(e.target.value);
      }}
      onBlur={() => text.trim() === "" && setText(value)}
    />
  );
}
