import { useRef, useState } from "react";
import { ARCHIVE_ACCEPT, useStore } from "../../store";
import { Button, Dialog, Field, inputClass } from "../ui";

const FORM = "new-work-form";

/** 새 작업: 이름과 프리셋을 정해 시작한다. 프리셋은 있던 것을 고르거나, 빈 프리셋을 새로 만들어 시작한다. */
export function NewWorkDialog() {
  const presets = useStore((s) => s.presets);
  const currentId = useStore((s) => s.preset?.id);
  const create = useStore((s) => s.createSession);
  const close = useStore((s) => s.closeDialog);
  const [name, setName] = useState("");
  // 지금 쓰던 프리셋을 먼저 골라 둔다. 빈 문자열은 `새 프리셋`이다.
  const [picked, setPicked] = useState(() => presets.find((p) => p.id === currentId)?.id ?? presets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // 고른 것이 사라졌으면 `새 프리셋`으로 본다. 그러면 엔진이 이 작업의 이름으로 빈 프리셋을 만들어 붙인다.
  const presetId = presets.some((p) => p.id === picked) ? picked : "";

  const start = async () => {
    if (busy) return;
    setBusy(true);
    const id = await create(name.trim() || "새 작업", presetId || undefined);
    setBusy(false);
    if (id) close();
  };

  /** 내보낸 파일을 들여온다. 작업(.aleph)이면 그리로 옮겨 가고, 프리셋(.alephpreset)이면 아래 목록에 생긴다. */
  const importFile = async (file: File) => {
    if (busy) return;
    setBusy(true);
    const got = await useStore.getState().importFile(file);
    setBusy(false);
    if (got?.kind === "work") {
      // 기다리는 사이 이 팝업을 닫고 다른 팝업을 열었으면 그것은 닫지 않는다.
      if (useStore.getState().dialog?.type === "new") close();
    } else if (got?.kind === "preset") {
      // 방금 들어온 프리셋으로 바로 시작할 수 있게 골라 둔다.
      setPicked(got.preset.id);
    }
  };

  return (
    <Dialog
      size="sm"
      title="새 작업"
      onClose={close}
      footer={
        <>
          <Button disabled={busy} onClick={() => picker.current?.click()}>
            가져오기
          </Button>
          <input
            ref={picker}
            type="file"
            accept={ARCHIVE_ACCEPT}
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = ""; // 같은 파일을 다시 골라도 change가 오게
              if (picked) void importFile(picked);
            }}
          />
          <Button className="ml-auto" variant="primary" type="submit" form={FORM} disabled={busy}>
            시작
          </Button>
        </>
      }
    >
      <form
        id={FORM}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <Field label="이름">
          <input autoFocus className={inputClass} value={name} placeholder="새 작업" onChange={(e) => setName(e.target.value)} />
        </Field>

        {presets.length > 0 && (
          <div role="radiogroup" aria-label="프리셋" className="flex flex-col">
            <span className="mb-1 text-xs text-muted">프리셋</span>
            <label className={`flex cursor-pointer items-start gap-2.5 border-b border-hair py-2 first-of-type:border-t ${presetId === "" ? "" : "hover:text-blue"}`}>
              <input type="radio" name="preset" className="mt-1 accent-blue" checked={presetId === ""} onChange={() => setPicked("")} />
              <span className={`font-bold ${presetId === "" ? "text-blue" : ""}`}>새 프리셋</span>
            </label>
            {presets.map((p) => (
              <label key={p.id} className={`flex cursor-pointer items-start gap-2.5 border-b border-hair py-2 first-of-type:border-t ${p.id === presetId ? "" : "hover:text-blue"}`}>
                <input type="radio" name="preset" className="mt-1 accent-blue" checked={p.id === presetId} onChange={() => setPicked(p.id)} />
                <span className="flex min-w-0 flex-col">
                  <span className={`truncate font-bold ${p.id === presetId ? "text-blue" : ""}`}>{p.name}</span>
                  {p.description && <span className="text-[13px] text-muted">{p.description}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </form>
    </Dialog>
  );
}
