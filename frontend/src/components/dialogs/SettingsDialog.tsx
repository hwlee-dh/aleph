import { useStore } from "../../store";
import { SettingsBody } from "../SettingsView";
import { Button, Dialog } from "../ui";

/** 설정. 내용은 SettingsBody가 그리고, 고치면 바로 저장된다. provider를 주면 그 제공자를 펼친 채로 연다. */
export function SettingsDialog({ provider }: { provider?: string }) {
  const close = useStore((s) => s.closeDialog);
  return (
    <Dialog
      size="xl"
      title="설정"
      onClose={close}
      footer={
        <Button className="ml-auto" onClick={close}>
          닫기
        </Button>
      }
    >
      <SettingsBody provider={provider} />
    </Dialog>
  );
}
