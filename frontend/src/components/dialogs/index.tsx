import { useStore } from "../../store";
import { NewWorkDialog } from "./NewWorkDialog";
import { PresetDialog } from "./PresetDialog";
import { SettingsDialog } from "./SettingsDialog";
import { TextDialog } from "./TextDialog";
import { ToolDialog } from "./ToolDialog";

/** 지금 떠 있어야 할 팝업 하나. 여는 쪽은 store의 openDialog만 부르면 된다. */
export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case "new":
      return <NewWorkDialog />;
    case "settings":
      return <SettingsDialog provider={dialog.provider} />;
    case "tool":
      // 도구가 바뀌면(새 도구를 만든 뒤 그 도구로 다시 열릴 때도) 처음부터 다시 그린다.
      return <ToolDialog key={dialog.name ?? ""} name={dialog.name} />;
    case "presets":
      return <PresetDialog />;
    case "text":
      return <TextDialog key={dialog.field} field={dialog.field} />;
  }
}
