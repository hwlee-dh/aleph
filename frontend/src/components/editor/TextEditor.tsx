import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView, placeholder as placeholderText } from "@codemirror/view";
import { barePath, pathLabel } from "../../lib/labels";
import { useStore } from "../../store";
import { QuoteIcon } from "../icons";
import { core, readOnlyMode, slots, variantLook } from "./extensions";
import { showLocate } from "./locate";

export interface TextEditorHandle {
  /** 커서의 글자 위치 (문서 처음부터). 초점이 없어도 마지막 위치. */
  cursor(): number;
  focus(): void;
  getText(): string;
  /** 커서(고른 글)가 화면 가운데쯤 오게 스크롤한다. */
  showSelection(): void;
}

export interface TextEditorProps {
  /** 처음 내용. 타이핑으로는 바뀌지 않는다 */
  value: string;
  /** 이 값이 바뀌면 value로 내용을 통째로 갈아 끼운다 (useDoc의 loadId) */
  loadId: number;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  /** manuscript = 본문 폰트(명조), 큰 글자, 넓은 줄 간격. plain = 고딕 14px. side = plain의 모양인데 본문 자리(작은 출력 칸) */
  variant?: "manuscript" | "plain" | "side";
  /** 이 글의 경로(인용 표시에 쓴다). 예: "원고/s3", "자료/인물/서윤", "입력" */
  path?: string;
  className?: string;
  /** 주면 그 높이 안에서 스크롤, 안 주면 내용만큼 늘어난다 */
  maxHeight?: number;
  minHeight?: number;
  placeholder?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  /** 커서나 글이 바뀔 때마다: 커서 위치와 글 전체 길이 */
  onCursor?: (pos: number, length: number) => void;
  ref?: Ref<TextEditorHandle>;
}

/** 인용 버튼의 자리 (감싸는 div 기준). */
type Spot = { left: number; top: number };

const QUOTE_WIDTH = 68;
const QUOTE_HEIGHT = 28;

/**
 * CodeMirror로 만든 일반 텍스트 편집기. 저장되는 것은 글자 그대로다.
 * `@include:경로`는 알약으로, `![설명](경로)`는 그림으로 보이고(본문 자리에서는 표시를 숨긴다), 글을 긁으면 `인용` 버튼이 뜬다.
 */
export function TextEditor({
  value,
  loadId,
  onChange,
  readOnly = false,
  variant = "plain",
  path,
  className = "",
  maxHeight,
  minHeight,
  placeholder,
  onFocus,
  onBlur,
  onCursor,
  ref,
}: TextEditorProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);

  // 편집기는 한 번만 만든다. 그 안의 콜백이 늘 최신 props를 보도록 여기 담아 둔다.
  const live = useRef({ value, onChange, onFocus, onBlur, onCursor, path, readOnly, variant, placeholder });
  useLayoutEffect(() => {
    live.current = { value, onChange, onFocus, onBlur, onCursor, path, readOnly, variant, placeholder };
  });

  const loaded = useRef(loadId); // 편집기에 들어 있는 내용의 loadId
  const applied = useRef({ readOnly, variant, placeholder }); // 편집기에 반영된 설정
  const makeState = useRef<(text: string) => EditorState>(null);

  useEffect(() => {
    if (!host.current) return;
    let pressing = false; // 마우스로 긁는 중에는 버튼을 띄우지 않는다
    const measureKey = {};

    /** 긁은 글의 끝(마우스를 뗀 쪽) 가까이에 인용 버튼을 놓는다. */
    const place = () => {
      const view = viewRef.current;
      const box = wrap.current;
      if (!view || !box) return;
      if (!live.current.path || pressing || !view.hasFocus || view.state.selection.main.empty) {
        setSpot(null);
        return;
      }
      // 화면 좌표는 편집기가 DOM을 다 고친 뒤에 읽는다.
      view.requestMeasure<Spot | null>({
        key: measureKey,
        read: () => {
          const sel = view.state.selection.main;
          if (sel.empty) return null;
          const forward = sel.head >= sel.anchor;
          const at = view.coordsAtPos(sel.head, forward ? -1 : 1);
          if (!at) return null;
          // 안에서 스크롤해 끝이 가려졌으면 숨긴다.
          const seen = view.scrollDOM.getBoundingClientRect();
          if (at.bottom < seen.top || at.top > seen.bottom) return null;
          const base = box.getBoundingClientRect();
          const left = Math.max(0, Math.min(at.left - base.left, base.width - QUOTE_WIDTH));
          // 아래로 긁었으면 끝줄 아래에, 위로 긁었으면 첫 줄 위에 둔다. 긁은 글을 가리지 않게.
          return { left, top: forward ? at.bottom - base.top + 6 : at.top - base.top - QUOTE_HEIGHT - 6 };
        },
        write: (next) => setSpot((prev) => (prev && next && prev.left === next.left && prev.top === next.top ? prev : next)),
      });
    };

    const mine: Extension = [
      EditorView.updateListener.of((u) => {
        if (u.docChanged) live.current.onChange?.(u.state.doc.toString());
        if (u.docChanged || u.selectionSet) live.current.onCursor?.(u.state.selection.main.head, u.state.doc.length);
        if (u.docChanged || u.selectionSet || u.focusChanged || u.geometryChanged) place();
      }),
      EditorView.domEventObservers({
        focus: () => live.current.onFocus?.(),
        blur: () => live.current.onBlur?.(),
        mousedown: () => {
          pressing = true;
          setSpot(null);
          document.addEventListener(
            "mouseup",
            () => {
              pressing = false;
              // 선택이 자리 잡은 뒤에 본다.
              setTimeout(place, 0);
            },
            { once: true },
          );
        },
      }),
    ];

    makeState.current = (text) => {
      const now = live.current;
      return EditorState.create({
        doc: text,
        extensions: [
          core,
          slots.readOnly.of(now.readOnly ? readOnlyMode.on : readOnlyMode.off),
          slots.variant.of(variantLook[now.variant]),
          slots.placeholder.of(now.placeholder ? placeholderText(now.placeholder) : []),
          mine,
        ],
      });
    };

    const now = live.current;
    const view = new EditorView({ parent: host.current, state: makeState.current(now.value) });
    viewRef.current = view;
    applied.current = { readOnly: now.readOnly, variant: now.variant, placeholder: now.placeholder };
    view.scrollDOM.addEventListener("scroll", place, { passive: true });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 밖에서 문서가 바뀌었다(다시 읽음, 복원, 에이전트가 고침). 내용을 통째로 갈아 끼운다.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !makeState.current || loaded.current === loadId) return;
    loaded.current = loadId;
    if (view.state.doc.toString() === value) return;
    // 변경으로 넣지 않고 상태를 새로 만든다. onChange가 불리지 않고, 실행 취소가 앞 문서의 조각을 되살리지도 않는다.
    const head = view.state.selection.main.head;
    view.setState(makeState.current(value));
    const length = view.state.doc.length;
    // 커서는 있던 자리에 둔다 (장면을 나눈 직후처럼 초점이 그대로일 때 맨 앞으로 튀지 않게).
    if (head > 0) view.dispatch({ selection: { anchor: Math.min(head, length) } });
    else live.current.onCursor?.(0, length);
    setSpot(null);
  }, [loadId, value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const was = applied.current;
    const effects: StateEffect<unknown>[] = [];
    if (was.readOnly !== readOnly) effects.push(slots.readOnly.reconfigure(readOnly ? readOnlyMode.on : readOnlyMode.off));
    if (was.variant !== variant) effects.push(slots.variant.reconfigure(variantLook[variant]));
    if (was.placeholder !== placeholder) effects.push(slots.placeholder.reconfigure(placeholder ? placeholderText(placeholder) : []));
    applied.current = { readOnly, variant, placeholder };
    if (effects.length) view.dispatch({ effects });
  }, [readOnly, variant, placeholder]);

  // 찾기 결과를 눌렀다: 이 문서의 그 줄로 가서 그 글귀를 고른다.
  // 편집기가 막 생겼을 때도 본다 (문서를 새로 열었거나, 원고 화면에서 장면이 화면 가까이 와서 이제 만들어진 경우).
  const bare = path ? barePath(path) : "";
  const locate = useStore((s) => (bare && s.locate?.path === bare ? s.locate : null));
  useEffect(() => {
    if (!locate) return;
    // 원고 화면은 같은 순간에 이 장면의 머리로 스크롤하고 초점을 준다 (부모의 effect라 이것보다 늦게 돈다).
    // 그 뒤에 자리를 잡아야 하므로 한 박자 미룬다.
    const timer = setTimeout(() => viewRef.current && showLocate(viewRef.current, locate), 0);
    return () => clearTimeout(timer);
  }, [locate]);

  useImperativeHandle(
    ref,
    () => ({
      cursor: () => viewRef.current?.state.selection.main.head ?? 0,
      focus: () => viewRef.current?.focus(),
      getText: () => viewRef.current?.state.doc.toString() ?? live.current.value,
      showSelection: () => {
        const view = viewRef.current;
        if (view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main, { y: "center" }) });
      },
    }),
    [],
  );

  const quote = () => {
    const view = viewRef.current;
    if (!view || !path) return;
    const sel = view.state.selection.main;
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (!text.trim()) return;
    const s = useStore.getState();
    s.setQuote({ path, label: pathLabel(path, s.ws), text });
    setSpot(null);
  };

  // 높이 제한은 CSS 변수로 넘긴다. 편집기마다 스타일을 새로 만들지 않아도 된다 (extensions.ts의 look).
  const limits = {
    "--te-max": maxHeight ? `${maxHeight}px` : undefined,
    "--te-min": minHeight ? `${minHeight}px` : undefined,
  } as CSSProperties;

  return (
    <div ref={wrap} className={`relative min-w-0 ${className}`}>
      <div ref={host} style={limits} />
      {spot && path && (
        <button
          type="button"
          style={{ left: spot.left, top: spot.top, height: QUOTE_HEIGHT }}
          // 누르는 순간 초점이 옮겨 가면 긁어 둔 선택이 풀린다.
          onMouseDown={(e) => e.preventDefault()}
          onClick={quote}
          className="absolute z-20 inline-flex items-center gap-1 rounded-full border border-line bg-bg pr-3 pl-2 font-sans text-[13px] leading-none whitespace-nowrap text-ink shadow-[0_6px_18px_rgba(0,0,0,0.16)] hover:border-blue hover:text-blue"
        >
          <QuoteIcon />
          인용
        </button>
      )}
    </div>
  );
}
