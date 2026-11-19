import { useRef, useState, type ReactNode } from "react";
import { formatWhen } from "../../lib/labels";
import { useStore } from "../../store";
import { GripIcon, LockIcon, MoreIcon, NoteIcon } from "../icons";
import { IconButton, MenuItem, Popover, inputClass } from "../ui";

/*
 * 왼쪽 패널의 두 목록(원고, 자료)이 같이 쓰는 부품.
 * 줄(row)에는 `group/row`를 붙이고, 줄 끝의 조작은 아래 REVEAL로 감싸 마우스를 올렸을 때만 드러낸다.
 */

/**
 * 줄에 마우스를 올렸을 때만 드러난다. 가려져 있는 동안은 자리도 차지하지 않는다 (좁은 패널에서 이름과 요약이 덜 잘리게).
 * 메뉴가 열려 있는 동안(data-open)과 키보드로 줄 안에 들어왔을 때(focus-visible)는 마우스가 떠나도 남는다.
 * aria-expanded를 보지 않는 까닭: 폴더·장을 접고 펼치는 버튼도 그 값을 쓴다.
 */
export const REVEAL = "hidden group-hover/row:flex group-has-[:focus-visible]/row:flex group-has-[[data-open=true]]/row:flex";
/** 위와 반대: 조작이 드러나는 동안 자리를 내주는 것 (글자 수). */
export const YIELD = "group-hover/row:hidden group-has-[:focus-visible]/row:hidden group-has-[[data-open=true]]/row:hidden";
/** 줄 바탕이 이미 bg-sunken이라, 줄 안의 아이콘 버튼은 한 단계 더 짙은 바탕으로 눌리는 자리를 보인다. */
export const ROW_BUTTON = "hover:!bg-hair";

/** 끌고 있는 것의 경로를 싣는 자리. text/plain을 쓰지 않는 까닭: 편집기에 떨어뜨렸을 때 글자가 끼어들지 않게. */
export const DRAG_TYPE = "application/x-aleph-path";

/** 토글을 눌렀을 때 보낼 값. 직접 건 값이 있으면 상속으로 되돌리고(null), 없으면 지금 실제 값의 반대로 건다. */
export const nextFlag = (direct: boolean | undefined, effective: boolean): boolean | null => (direct !== undefined ? null : !effective);

/**
 * 수정 방지·노트 토글.
 *   직접 건 것(켬이든 끔이든)  진한 파랑, 항상 보인다
 *   상속으로 켜진 것           옅은 파랑, 항상 보인다
 *   꺼진 것                    줄에 마우스를 올릴 때만 (always면 항상)
 * 직접 "끔"으로 건 것도 항상 보이게 한 까닭: 원고 전체를 잠그고 한 장면만 푼 경우, 풀린 그 장면이 눈에 띄어야 한다.
 */
export function FlagToggle({
  kind,
  direct,
  effective,
  onChange,
  always = false,
}: {
  kind: "locked" | "note";
  direct: boolean | undefined;
  effective: boolean;
  onChange: (value: boolean | null) => void;
  always?: boolean;
}) {
  const own = direct !== undefined;
  const tone = own ? "!text-blue" : effective ? "!text-blue opacity-45" : "";
  const button = (
    <IconButton
      label={kind === "locked" ? "수정 방지" : "노트"}
      aria-pressed={effective}
      onClick={() => onChange(nextFlag(direct, effective))}
      // 노트 아이콘은 켜고 끈 모양이 같아서, 켜진 것은 속을 채워 가른다.
      className={`${ROW_BUTTON} ${tone} ${kind === "note" && effective ? "[&>svg]:fill-current" : ""}`}
    >
      {kind === "locked" ? <LockIcon open={!effective} /> : <NoteIcon />}
    </IconButton>
  );
  return own || effective || always ? button : <span className={REVEAL}>{button}</span>;
}

/** 줄 끝의 `⋯` 메뉴. 화면 아래쪽 줄에서는 위로 펼친다 (목록이 스크롤 칸이라 아래로 펼치면 잘린다). */
export function RowMenu({ children, always = false }: { children: (close: () => void) => ReactNode; always?: boolean }) {
  const [up, setUp] = useState(false);
  return (
    <div className={always ? "flex" : REVEAL}>
      <Popover
        align="right"
        side={up ? "top" : "bottom"}
        className="!min-w-44"
        trigger={(open, toggle) => (
          <IconButton
            label="더 보기"
            aria-haspopup="menu"
            aria-expanded={open}
            data-open={open}
            className={ROW_BUTTON}
            onClick={(e) => {
              if (!open) setUp(e.currentTarget.getBoundingClientRect().bottom > window.innerHeight - 240);
              toggle();
            }}
          >
            <MoreIcon />
          </IconButton>
        )}
      >
        {children}
      </Popover>
    </div>
  );
}

/** 메뉴 안의 삭제. 한 번 누르면 `삭제 확인`으로 바뀌고, 한 번 더 눌러야 지운다. 메뉴가 닫히면 처음으로 돌아간다. */
export function ConfirmItem({ label = "삭제", onConfirm, disabled, title }: { label?: string; onConfirm: () => void; disabled?: boolean; title?: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <MenuItem danger disabled={disabled} title={title} onClick={() => (armed ? onConfirm() : setArmed(true))}>
      {armed ? `${label} 확인` : label}
    </MenuItem>
  );
}

/** 메뉴 안의 가는 구분선. */
export const MenuLine = () => <div className="my-1 border-t border-hair" />;

/**
 * 메뉴 안의 "삭제한 장면"·"삭제한 문서". 고르면 그 버전 기록이 열리고 거기서 복원한다.
 * 지운 것이 없으면 아무것도 그리지 않는다.
 */
export function DeletedItems({ zone, title, close }: { zone: "원고" | "자료"; title: string; close: () => void }) {
  const deleted = useStore((s) => s.deleted);
  const mine = deleted.filter((d) => d.path.startsWith(`${zone}/`)).slice(0, 8);
  if (mine.length === 0) return null;
  return (
    <>
      <MenuLine />
      <div className="px-2.5 pt-1 pb-0.5 text-xs text-muted">{title}</div>
      {mine.map((d) => (
        <MenuItem
          key={d.path}
          onClick={() => {
            close();
            useStore.getState().openDrawer({ kind: "history", path: d.path });
          }}
        >
          <span className="min-w-0 flex-1 truncate">{d.label}</span>
          <span className="shrink-0 text-xs text-muted">{formatWhen(d.at)}</span>
        </MenuItem>
      ))}
    </>
  );
}

/**
 * 그 자리에서 고치는 한 줄 입력칸. Enter로 확정, Esc로 취소.
 * 한글을 조합하는 중의 Enter는 글자를 확정하는 키라서 넘긴다 (안 그러면 마지막 글자가 빠진 채 저장된다).
 */
export function InlineInput({
  initial,
  label,
  placeholder,
  onCommit,
  onCancel,
  commitOnBlur = true,
  className = "",
  title,
}: {
  initial: string;
  label: string;
  placeholder?: string;
  title?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  commitOnBlur?: boolean;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  // Enter로 확정하면 입력칸이 사라지면서 blur가 따라올 수 있다. 두 번 확정하지 않게 막는다.
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };
  return (
    <input
      autoFocus
      aria-label={label}
      title={title}
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(commitOnBlur)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          // 넓은 패널이나 팝업이 같은 Esc로 닫히지 않게 여기서 멈춘다.
          e.stopPropagation();
          finish(false);
        }
      }}
      className={`${inputClass} !h-7 !px-2 ${className}`}
    />
  );
}

/** 끌어서 옮기는 손잡이. 줄의 왼쪽 여백(12px) 안에 놓인다. 줄 전체가 draggable이고 이것은 표시다. */
export function Grip({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`absolute left-0.5 cursor-grab text-edge opacity-0 group-hover/row:opacity-100 ${className}`}>
      <GripIcon />
    </span>
  );
}

/** 끌어 온 것이 놓일 자리를 보이는 파란 가는 줄. 부모는 relative여야 한다. */
export function DropLine({ at }: { at: "top" | "bottom" }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-blue ${at === "top" ? "-top-px" : "-bottom-px"}`} />;
}
