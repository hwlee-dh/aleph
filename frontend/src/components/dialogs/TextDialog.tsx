import { useStore } from "../../store";
import { Button, Dialog, boxClass } from "../ui";

const TITLE = { instruction: "에이전트 지침" } as const;

/** 지침을 넓게 고친다. 패널의 칸과 같은 값을 고치므로 저장 버튼이 없다. */
export function TextDialog({ field }: { field: "instruction" }) {
  const value = useStore((s) => s.preset?.[field]);
  const edit = useStore((s) => s.editPreset);
  const close = useStore((s) => s.closeDialog);
  if (value === undefined) return null;

  return (
    <Dialog
      size="lg"
      title={TITLE[field]}
      onClose={close}
      footer={
        <Button className="ml-auto" onClick={close}>
          닫기
        </Button>
      }
    >
      <textarea
        autoFocus
        aria-label={TITLE[field]}
        rows={20}
        className={`${boxClass} resize-y leading-relaxed`}
        value={value}
        onChange={(e) => edit({ [field]: e.target.value })}
      />
    </Dialog>
  );
}
