import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import * as m from "motion/react-m";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CloseIcon } from "./icons";

/*
 * 화면 전체가 같이 쓰는 부품. 모양의 규칙:
 *   - 흰 바탕에 시립대 파랑(내가 쥔 것), 에메랄드(에이전트가 한 일), 노랑(인용·주의).
 *   - 상자로 감싸지 않는다. 구역은 가는 줄과 여백으로 나눈다. 테두리 상자는 입력칸, 팝업, 채팅창에만.
 *   - 모서리: 버튼·입력칸 8px(rounded-lg), 팝업 14px(rounded-[14px]), 채팅창 20px, 알약 모양은 rounded-full.
 *   - 설명 문구는 붙이지 않는다. 이름표(label)와 title(마우스를 올리면 뜨는 말)만 쓴다.
 */

type Variant = "primary" | "outline" | "quiet" | "danger";

const VARIANT: Record<Variant, string> = {
  primary: "bg-blue text-white font-bold hover:bg-blue-hover disabled:bg-edge",
  outline: "border border-line bg-bg text-ink hover:border-edge hover:bg-sunken disabled:text-muted disabled:hover:bg-bg",
  quiet: "text-muted hover:bg-sunken hover:text-ink disabled:text-edge disabled:hover:bg-transparent",
  danger: "border border-line bg-bg text-danger hover:border-danger disabled:text-edge",
};

export function Button({
  variant = "outline",
  small = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg whitespace-nowrap ${
        small ? "h-7 px-2.5 text-[13px]" : "h-9 px-4 text-sm"
      } ${VARIANT[variant]} ${className}`}
    />
  );
}

/** 아이콘 하나짜리 버튼. label은 화면 낭독기와 툴팁에 쓰인다. */
export function IconButton({
  label,
  active = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:text-edge ${
        active ? "bg-blue-tint text-blue" : "text-muted hover:bg-sunken hover:text-ink"
      } ${className}`}
    />
  );
}

/** 글자처럼 보이는 버튼 (파란 링크 모양). */
export function TextButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={`link text-[13px] ${className}`} />;
}

type Tone = "blue" | "outline" | "agent" | "warn" | "plain" | "protect";
const TONE: Record<Tone, string> = {
  blue: "bg-blue text-white",
  outline: "border border-blue text-blue !leading-4",
  agent: "bg-agent text-white",
  warn: "bg-warn text-[#1a1a2e]",
  plain: "border border-edge text-muted !leading-4",
  protect: "bg-blue text-white",
};

/** 작은 꼬리표: 수정 방지, 노트, 확인 대기, 쓰는 중 … */
export function Tag({ tone = "plain", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-block shrink-0 rounded px-1.5 text-[11px] leading-[18px] font-bold whitespace-nowrap ${TONE[tone]}`}>
      {children}
    </span>
  );
}

/** 가는 윗줄로 시작하는 구획. */
export function Section({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col gap-3 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-3 border-b border-ink pb-1.5">
        <h2 className="m-0 text-[15px] font-black">{title}</h2>
        {right && <div className="ml-auto flex items-center gap-3">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** 가는 줄로 나뉘는 목록. 자식은 Row. */
export function Rows({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col ${className}`}>{children}</div>;
}
export function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-10 items-center gap-3 border-b border-hair ${className}`}>{children}</div>;
}

/** 이름표가 위에 붙은 입력 한 칸. */
export function Field({ label, right, children, className = "" }: { label: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="flex justify-between gap-3 text-xs text-muted">
        <span>{label}</span>
        {right && <span>{right}</span>}
      </span>
      {children}
    </label>
  );
}

/** 한 줄 입력·고르기. */
export const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-line bg-bg px-2.5 text-sm text-ink focus:border-blue focus:outline-none disabled:bg-sunken disabled:text-muted";
/** 여러 줄 입력. */
export const boxClass = "w-full min-w-0 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink focus:border-blue focus:outline-none";

/** 내용 길이에 맞춰 늘어나는 입력창. */
export function AutoTextarea({
  minRows = 3,
  maxHeight = 480,
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, maxHeight)}px`;
  }, [props.value, maxHeight]);
  return <textarea ref={ref} rows={minRows} {...props} className={`${boxClass} resize-none leading-relaxed ${className}`} />;
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-aleph">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

/** 나란히 붙은 고르기 버튼 (알약 모양 홈 안에서 고른 것만 떠오른다). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="inline-flex rounded-lg bg-sunken p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.label}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-md px-3 text-[13px] whitespace-nowrap ${
            value === o.value ? "bg-bg font-bold text-blue shadow-[0_1px_2px_rgba(0,0,0,0.14)]" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 켜고 끄는 스위치. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-blue" : "bg-edge"}`}
    >
      <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-[left] ${checked ? "left-4" : "left-0.5"}`} />
    </button>
  );
}

/** 버튼을 누르면 옆에 펼쳐지는 작은 팝업. 바깥을 누르거나 Esc를 누르면 닫힌다. */
export function Popover({
  trigger,
  children,
  align = "left",
  side = "bottom",
  className = "",
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  side?: "bottom" | "top";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // 좁은 패널에서는 팝업이 패널 밖으로 삐져나가 패널에 가로 스크롤을 만든다.
  // 열릴 때 재서, 넘치는 것을 자르는 조상(없으면 창) 안으로 당기고 그보다 넓어지지 않게 한다.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    el.style.translate = "";
    el.style.maxWidth = "";
    let left = 8;
    let right = window.innerWidth - 8;
    // 팝업 안의 입력칸이 초점을 받으면서 브라우저가 패널을 이미 옆으로 밀어 놓았을 수 있다.
    // 밀린 만큼을 더해 밀리기 전의 자리로 따진다 (팝업을 당기고 나면 넘치는 것이 없어 스크롤은 저절로 돌아온다).
    const clips: HTMLElement[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowX === "visible") continue;
      const r = p.getBoundingClientRect();
      left = Math.max(left, r.left + 8);
      right = Math.min(right, r.left + p.clientWidth - 8);
      clips.push(p);
    }
    el.style.maxWidth = `${Math.max(right - left, 0)}px`;
    // 밀린 만큼은 폭을 줄인 뒤에 읽는다. 폭이 줄면 넘치는 것도 줄어 스크롤이 조금 돌아오는데,
    // 그 전의 값을 더하면 그만큼 더 당겨져 팝업이 패널 왼쪽 밖으로 나간다.
    const scrolled = clips.reduce((n, p) => n + p.scrollLeft, 0);
    const rect = el.getBoundingClientRect();
    const at = { left: rect.left + scrolled, right: rect.right + scrolled };
    const dx = at.right > right ? right - at.right : at.left < left ? left - at.left : 0;
    if (dx) el.style.translate = `${Math.round(dx)}px 0`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // 이 팝업에서 창(Dialog)을 띄운 경우: 창이 위에 떠 있는 동안에는 창 안을 눌러도, Esc를 눌러도 팝업을 닫지 않는다.
    // 창을 닫으면 팝업으로 돌아온다 (모델 고르기에서 키를 넣으러 설정에 다녀올 때).
    const under = (target?: EventTarget | null) => {
      if (ref.current?.closest("[data-overlay]")) return false; // 창 안에 있는 팝업은 여느 때처럼 닫힌다
      return target ? target instanceof Element && target.closest("[data-overlay]") !== null : document.querySelector("[data-overlay]") !== null;
    };
    const onDown = (e: MouseEvent) => {
      if (under(e.target)) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (under()) return;
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen(!open))}
      {open && (
        // 버튼 쪽에서 살짝 떠오른다. 닫힐 때는 바로 사라진다 (메뉴는 고르자마자 없어지는 편이 낫다).
        // 위의 자리 맞춤은 translate를 쓰고 이 움직임은 transform(y)을 써서 서로 건드리지 않는다.
        <m.div
          ref={pop}
          className={`pop absolute z-40 max-h-[70vh] min-w-56 overflow-y-auto ${side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"} ${
            align === "right" ? "right-0" : "left-0"
          } ${className}`}
          initial={{ opacity: 0, y: side === "top" ? 4 : -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
        >
          {children(() => setOpen(false))}
        </m.div>
      )}
    </div>
  );
}

/** 팝업 안의 한 줄. */
export function MenuItem({
  children,
  hint,
  active = false,
  danger = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { hint?: ReactNode; active?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-sunken disabled:text-edge disabled:hover:bg-transparent ${
        active ? "font-bold text-blue" : danger ? "text-danger" : "text-ink"
      } ${className}`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">{children}</span>
        {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
      </span>
    </button>
  );
}

/** 화면 위에 뜨는 창. 닫으면 보던 자리로 돌아온다. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const width = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-6xl" }[size];
  return (
    // 바탕이 흐려지며 창이 살짝 떠오른다. 닫힐 때는 바로 사라진다.
    <m.div
      data-overlay=""
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(26,26,46,0.4)] px-4 pt-[7vh] pb-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      <m.div
        role="dialog"
        aria-modal="true"
        className={`flex w-full ${width} flex-col rounded-[14px] bg-bg shadow-[0_18px_50px_rgba(0,0,0,0.3)]`}
        initial={{ y: 8 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
      >
        <div className="flex items-center gap-3 px-6 pt-5 pb-2">
          <h2 className="m-0 min-w-0 flex-1 text-lg font-black">{title}</h2>
          <IconButton label="닫기" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className="flex min-w-0 flex-col gap-4 px-6 pt-2 pb-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-hair px-6 py-3.5">{footer}</div>}
      </m.div>
    </m.div>
  );
}

/** 두 번 눌러야 실행되는 삭제 버튼 (confirm 창을 띄우지 않는다). */
export function ConfirmButton({
  label,
  confirm,
  onConfirm,
  small = true,
  disabled,
  title,
}: {
  label: string;
  confirm?: string;
  onConfirm: () => void;
  small?: boolean;
  disabled?: boolean;
  title?: string; // 꺼져 있는 까닭 등, 마우스를 올리면 뜨는 말
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <Button
      small={small}
      variant="danger"
      className="!border-danger"
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
    >
      {confirm ?? `${label} 확인`}
    </Button>
  ) : (
    <Button small={small} variant="quiet" disabled={disabled} title={title} onClick={() => setArmed(true)}>
      {label}
    </Button>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`spin inline-block h-3 w-3 shrink-0 rounded-full border-2 border-agent border-r-transparent ${className}`} aria-label="진행 중" />;
}

export { Chevron, CloseIcon } from "./icons";
