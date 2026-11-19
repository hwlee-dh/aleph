import { Compartment, EditorState, Facet, Prec, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { api } from "../../lib/api";
import { useStore } from "../../store";
import { kindMarks, liveViews } from "./kinds";

/*
 * TextEditor가 쓰는 CodeMirror 확장.
 * 편집기가 한 화면에 수십 개 쌓이므로, 편집기마다 달라지지 않는 것(모양, 키, 꾸밈)은
 * 전부 여기서 한 번만 만들어 같이 쓴다. 모양을 편집기마다 새로 만들면 <style>이 그만큼 늘어난다.
 */

/* ───────── 모양 ───────── */

/** 색은 전부 index.css의 변수를 쓴다. 테두리와 초점 표시는 감싸는 쪽이 정한다. */
const look = EditorView.theme({
  "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    // 높이 제한은 편집기마다 다르다. 감싸는 div가 변수로 넘긴다 (TextEditor 참고).
    maxHeight: "var(--te-max, none)",
  },
  ".cm-content": {
    padding: "0",
    minHeight: "max(100%, var(--te-min, 0px))",
    caretColor: "var(--color-ink)",
    outline: "none",
  },
  ".cm-line": { padding: "0 1px" },
  // 선택 영역은 브라우저 것을 그대로 쓴다(따로 그리면 무겁고 한글 조합과도 부딪힌다). 색만 노랑으로.
  ".cm-content ::selection": { backgroundColor: "var(--color-mark)", color: "var(--color-ink)" },
  ".cm-content::selection": { backgroundColor: "var(--color-mark)", color: "var(--color-ink)" },
  ".cm-placeholder": { color: "var(--color-edge)" },
  ".cm-include": {
    backgroundColor: "var(--color-blue-tint)",
    color: "var(--color-blue)",
    borderRadius: "999px",
    padding: "1px 6px",
    // 줄이 넘어가도 조각마다 알약 모양이 유지되게
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  },
  ".cm-include-open": { cursor: "pointer" },
  // 블록 위젯에는 margin을 쓰면 높이 계산이 어긋난다. 여백은 padding으로.
  ".cm-image": { padding: "6px 0 10px" },
  ".cm-image img": { display: "block", maxWidth: "100%", maxHeight: "420px", borderRadius: "4px" },
  ".cm-image img + img": { marginTop: "8px" },
  // 누르면 그 그림의 표시(`![설명](경로)`)로 커서가 간다.
  ".cm-image-edit img": { cursor: "pointer" },
});

/** 본문 자리인가. 그렇다면 그림 표시(`![설명](경로)`)를 숨기고 그림만 보인다 (아래 "이미지"). */
const hideImageMarks = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/**
 * manuscript는 index.css의 `.manuscript`와 같은 값이다. 폰트·크기·줄 간격은 설정(lib/appearance.ts)이 변수로 바꾼다.
 * side는 오른쪽 패널의 작은 출력 칸이다. 모양은 plain과 같고, 본문 폰트를 골랐을 때만 그것을 따른다.
 * 본문 자리(manuscript, side)에는 글의 종류별 꾸밈(kindMarks)이 같이 들어가고, 그림 표시가 숨는다.
 */
export const variantLook: Record<"manuscript" | "plain" | "side", Extension> = {
  manuscript: [
    EditorView.theme({ "&": { fontFamily: "var(--font-body)", fontSize: "var(--body-size, 16.5px)", lineHeight: "var(--body-leading, 2)" } }),
    kindMarks,
    hideImageMarks.of(true),
  ],
  plain: EditorView.theme({ "&": { fontFamily: "var(--font-sans)", fontSize: "14px", lineHeight: "1.7" } }),
  side: [
    EditorView.theme({ "&": { fontFamily: "var(--font-body-side, var(--font-sans))", fontSize: "14px", lineHeight: "1.7" } }),
    kindMarks,
    hideImageMarks.of(true),
  ],
};

/**
 * 읽기 전용이면 contenteditable을 끈다(커서가 없어지고 조합 입력도 아예 시작되지 않는다).
 * tabindex를 주는 것은 초점을 받을 수 있어야 긁은 글(인용)과 초점 변화를 편집기가 알기 때문이다.
 */
export const readOnlyMode: Record<"on" | "off", Extension> = {
  on: [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: "0" })],
  off: [EditorState.readOnly.of(false), EditorView.editable.of(true)],
};

/** 바깥에서 바뀌는 설정. Compartment는 이름표일 뿐이라 편집기들이 같이 써도 된다. */
export const slots = {
  readOnly: new Compartment(),
  variant: new Compartment(),
  placeholder: new Compartment(),
};

/* ───────── @include:경로 ───────── */

const includeMark = {
  edit: Decoration.mark({ class: "cm-include", attributes: { title: "Ctrl+클릭으로 열기" } }),
  read: Decoration.mark({ class: "cm-include cm-include-open", attributes: { title: "클릭해서 열기" } }),
};

/** replace 위젯이 아니라 mark다. 글자는 그대로 남아 평소처럼 고칠 수 있다. */
const includeMatcher = new MatchDecorator({
  regexp: /@include:\S+/g,
  decoration: (_match, view) => (view.state.readOnly ? includeMark.read : includeMark.edit),
});

const includeMarks = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    constructor(view: EditorView) {
      this.deco = includeMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      // 읽기 전용이 바뀌면 안내 말(title)이 달라지므로 처음부터 다시 만든다.
      this.deco = u.startState.readOnly !== u.state.readOnly ? includeMatcher.createDeco(u.view) : includeMatcher.updateDeco(u, this.deco);
    }
  },
  { decorations: (v) => v.deco },
);

/** pos가 걸친 `@include:경로`의 경로. 없으면 null. */
function includeAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos);
  const re = /@include:(\S+)/g;
  for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return m[1];
  }
  return null;
}

async function openInclude(ref: string) {
  const s = useStore.getState();
  if (!s.sessionId) return;
  try {
    const found = await api.resolve(s.sessionId, ref);
    if (found.kind === "doc" || found.kind === "scene") s.openDoc(found.path);
    else if (found.kind === "folder") s.setLeftTab("materials");
    else if (found.kind === "chapter" || found.kind === "manuscript") s.setLeftTab("manuscript");
    else s.notify(`문서를 찾을 수 없습니다: ${ref}`, "error");
  } catch (e) {
    s.fail(e);
  }
}

/**
 * 편집 중에는 Ctrl(⌘)+클릭, 읽기 전용이면 그냥 클릭으로 연다.
 * mousedown이 아니라 click에서 여는 것은, 알약 위에서 시작한 드래그(글 긁기)를 막지 않기 위해서다.
 */
const includeClick = EditorView.domEventHandlers({
  click(event, view) {
    const readOnly = view.state.readOnly;
    if (event.button !== 0 || (!readOnly && !(event.ctrlKey || event.metaKey))) return false;
    const target = event.target instanceof Element ? event.target.closest(".cm-include") : null;
    if (!target || !view.contentDOM.contains(target)) return false;
    // 읽기 전용에서 글을 긁다가 알약 위에서 손을 뗀 경우는 열지 않는다.
    if (readOnly && !view.state.selection.main.empty) return false;
    const ref = includeAt(view.state, view.posAtDOM(target));
    if (!ref) return false;
    event.preventDefault();
    void openInclude(ref);
    return true;
  },
});

/* ───────── 이미지 ───────── */

/*
 * `![설명](경로)`는 그림으로 보인다. 저장되는 글은 글자 그대로다.
 *
 * 본문 자리(원고, 출력)에서는 그 표시를 숨기고 그림만 보인다. 긴 설명과 경로가 소설 본문에 끼어 보이지 않게 하려는 것이다.
 *   - 그 줄에 그림 표시만 있으면 그림이 그 줄을 대신한다 (빈 줄이 남지 않는다).
 *   - 글 사이에 끼어 있으면 표시만 숨기고 그림은 그 줄 아래에 놓인다.
 *   - 커서가 그 줄에 오면(그림을 눌러도 그리로 간다) 글이 다시 보여서 설명과 경로를 고치거나 지울 수 있다.
 *     다른 줄로 가면 다시 숨는다. 읽기 전용에서는 늘 숨긴다.
 *   - 그림을 못 불러왔으면 숨기지 않는다. 아무것도 안 보이면 고칠 수도 없다.
 * 입력과 자료 문서(plain)에서는 숨기지 않고 지금처럼 글 아래에 그림을 놓는다. 거기는 적힌 글자 그대로가 중요한 자리다
 * (입력은 그대로 도구에 들어가고, 자료는 표시를 직접 다루는 작업용 문서다).
 */

/** 편집기에 초점이 있는가. 초점이 없는 편집기의 커서(대개 글머리)가 그 줄의 표시를 드러내지 않게 한다. */
const setFocused = StateEffect.define<boolean>();
/** 그림 하나를 못 불러왔다. 꾸밈을 다시 짜서 그 표시를 글로 보이게 한다. */
const imageFailed = StateEffect.define<null>();

/** 못 불러온 그림의 주소. 자료가 바뀌면(그림이 새로 생겼을 수 있다) 비우고 다음에 다시 불러 본다. */
const broken = new Set<string>();
useStore.subscribe((s, prev) => {
  if (s.ws?.materials !== prev.ws?.materials || s.sessionId !== prev.sessionId) broken.clear();
});

interface Picture {
  src: string;
  alt: string;
  /** 그 줄의 처음부터 표시의 끝까지 (그림을 누르면 커서가 놓일 자리). */
  end: number;
}

class ImageWidget extends WidgetType {
  constructor(
    readonly pictures: Picture[],
    /** 그림을 눌러 그 표시를 고치러 갈 수 있는가 (읽기 전용이 아니다). */
    readonly editable: boolean,
  ) {
    super();
  }
  // 같은 그림이면 DOM을 다시 만들지 않는다(타이핑할 때마다 그림이 깜빡이지 않게).
  eq(other: ImageWidget) {
    return (
      other.editable === this.editable &&
      other.pictures.length === this.pictures.length &&
      other.pictures.every((p, i) => p.src === this.pictures[i].src && p.alt === this.pictures[i].alt && p.end === this.pictures[i].end)
    );
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = this.editable ? "cm-image cm-image-edit" : "cm-image";
    for (const picture of this.pictures) {
      const img = document.createElement("img");
      img.alt = picture.alt;
      img.title = picture.alt;
      img.draggable = false;
      // 그림이 뜨면 줄 높이가 달라진다. 편집기가 다시 재게 한다.
      img.onload = () => view.requestMeasure();
      img.onerror = () => {
        broken.add(picture.src);
        // 편집기가 이미 치워졌으면(문서를 닫음) 할 일이 없다.
        if (view.dom.isConnected) view.dispatch({ effects: imageFailed.of(null) });
      };
      if (this.editable)
        img.onmousedown = (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          // 이 그림의 표시가 있는 줄. 그 표시의 끝에 커서를 놓으면 줄의 글이 다시 보인다.
          const line = view.state.doc.lineAt(view.posAtDOM(box));
          view.dispatch({ selection: { anchor: Math.min(line.from + picture.end, line.to) } });
          view.focus();
        };
      img.src = picture.src;
      box.appendChild(img);
    }
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** `![설명](경로)`의 경로를 그림 주소로. 작업 밖의 주소(http…)는 그대로, 나머지는 작업의 파일이다. */
function imageSrc(raw: string): string | null {
  let target = raw.trim().replace(/\s+"[^"]*"$/, ""); // `경로 "제목"` 꼴이면 제목을 뗀다
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (!target) return null;
  if (/^http/i.test(target)) return target;
  const sessionId = useStore.getState().sessionId;
  return sessionId ? api.fileUrl(sessionId, target) : null;
}

/**
 * 커서가 있어서 그림 표시를 글로 드러낼 줄들 (줄 번호를 이어 붙인 것. 견주기 쉽게 글로 둔다).
 * 커서 하나, 또는 한 줄 안에서 고른 글일 때만 그 줄을 드러낸다. 여러 줄을 긁는 동안에는 드러내지 않는다
 * (긁는 도중에 줄이 생겼다 사라지면 글이 밀린다).
 */
function revealedLines(state: EditorState, focused: boolean): string {
  if (!focused || state.readOnly) return "";
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    if (range.empty || state.doc.lineAt(range.to).number === first) lines.add(first);
  }
  return [...lines].join(",");
}

interface Images {
  deco: DecorationSet;
  focused: boolean;
  /** 지금 드러낸 줄들 (revealedLines). */
  revealed: string;
  /** 이 글에 그림 표시가 하나라도 있는가. 없으면 커서가 움직여도 다시 짤 것이 없다. */
  any: boolean;
}

function buildImages(state: EditorState, focused: boolean): Images {
  const revealed = revealedLines(state, focused);
  const text = state.doc.toString();
  if (!text.includes("![")) return { deco: Decoration.none, focused, revealed, any: false };
  const hide = state.facet(hideImageMarks);
  const editable = !state.readOnly;
  const shown = new Set(revealed ? revealed.split(",").map(Number) : []);

  // 줄마다 그 줄의 그림 표시를 모은다.
  const byLine = new Map<number, { from: number; to: number; pictures: Picture[] }[]>();
  const re = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const src = imageSrc(m[2]);
    // 못 불러온 그림은 꾸미지 않는다. 표시가 글 그대로 보인다.
    if (!src || broken.has(src)) continue;
    const line = state.doc.lineAt(m.index);
    const marks = byLine.get(line.number) ?? [];
    marks.push({ from: m.index, to: m.index + m[0].length, pictures: [{ src, alt: m[1], end: m.index + m[0].length - line.from }] });
    byLine.set(line.number, marks);
  }

  const found: Range<Decoration>[] = [];
  for (const [number, marks] of byLine) {
    const line = state.doc.line(number);
    const pictures = marks.flatMap((mark) => mark.pictures);
    const widget = new ImageWidget(pictures, editable);
    if (!hide || shown.has(number)) {
      // 글은 그대로 두고, 그 줄 바로 아래에 그림을 놓는다.
      found.push(Decoration.widget({ widget, block: true, side: 1 }).range(line.to));
      continue;
    }
    // 표시를 뺀 나머지가 비었으면 그 줄에는 그림 표시뿐이다. 그림이 그 줄을 대신한다.
    let rest = line.text;
    for (const mark of [...marks].reverse()) rest = rest.slice(0, mark.from - line.from) + rest.slice(mark.to - line.from);
    if (!rest.trim() && line.from < line.to) {
      found.push(Decoration.replace({ widget, block: true }).range(line.from, line.to));
      continue;
    }
    for (const mark of marks) found.push(Decoration.replace({}).range(mark.from, mark.to));
    found.push(Decoration.widget({ widget, block: true, side: 1 }).range(line.to));
  }
  return { deco: Decoration.set(found, true), focused, revealed, any: true };
}

/** 블록 위젯은 ViewPlugin으로 줄 수 없어서(높이에 영향을 준다) StateField로 둔다. */
const images = StateField.define<Images>({
  create: (state) => buildImages(state, false),
  update(value, tr) {
    let focused = value.focused;
    let rebuild = false;
    for (const effect of tr.effects) {
      if (effect.is(setFocused)) focused = effect.value;
      else if (effect.is(imageFailed)) rebuild = true;
    }
    // 읽기 전용이나 본문 자리 여부가 바뀌면 숨길지 말지가 달라진다.
    if (tr.startState.readOnly !== tr.state.readOnly || tr.startState.facet(hideImageMarks) !== tr.state.facet(hideImageMarks)) rebuild = true;
    if (tr.docChanged && !rebuild) {
      // 그림 문법이 있는 줄을 건드렸을 때만 다시 찾는다. 그 밖의 타이핑에서는 자리만 옮긴다.
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        if (rebuild) return;
        const before = tr.startState.doc;
        const after = tr.state.doc;
        rebuild =
          before.sliceString(before.lineAt(fromA).from, before.lineAt(toA).to).includes("![") ||
          after.sliceString(after.lineAt(fromB).from, after.lineAt(toB).to).includes("![");
      });
    }
    // 커서가 그림 표시가 있는 줄에 들어오거나 나가면 그 줄의 글을 드러내거나 숨긴다.
    // 같은 줄 안에서 움직이는 동안(한글을 조합하는 동안도 그렇다)에는 꾸밈이 바뀌지 않는다.
    if (!rebuild && value.any && revealedLines(tr.state, focused) !== value.revealed) rebuild = true;
    if (rebuild) return buildImages(tr.state, focused);
    if (!tr.docChanged && focused === value.focused) return value;
    return { ...value, deco: value.deco.map(tr.changes), focused };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

/**
 * 초점이 들어오면 바로, 나가면 조금 뒤에 알린다. 나갈 때 바로 숨기면 드러나 있던 글만큼 아래가 밀려 올라와서,
 * 방금 누른 것(다른 장면의 글, 버튼)이 손가락 밑에서 달아난다. 누르기가 끝난 뒤에 숨긴다.
 */
const imageFocus: Extension = [
  EditorView.focusChangeEffect.of((_state, focusing) => (focusing ? setFocused.of(true) : null)),
  EditorView.domEventObservers({
    blur(_event, view) {
      setTimeout(() => {
        if (view.dom.isConnected && !view.hasFocus) view.dispatch({ effects: setFocused.of(false) });
      }, 180);
    },
  }),
];

const IMAGE_MARK = /!\[[^\]\n]*\]\([^)\n]+\)/;

/**
 * 위아래 방향키. 그림이 줄을 대신하고 있으면 편집기가 그 줄을 한 덩어리로 보고 건너뛴다.
 * 건너뛰려는 바로 옆줄이 그림 표시가 있는 줄이면 그 줄로 들어간다. 들어가면 글이 드러나서 고칠 수 있다.
 */
function stepIntoImage(view: EditorView, forward: boolean): boolean {
  const state = view.state;
  const sel = state.selection.main;
  if (state.readOnly || !state.facet(hideImageMarks) || !sel.empty) return false;
  const from = state.doc.lineAt(sel.head).number;
  const next = from + (forward ? 1 : -1);
  if (next < 1 || next > state.doc.lines) return false;
  const target = view.moveVertically(sel, forward).head;
  const to = state.doc.lineAt(target).number;
  // 옆줄로 가거나, 줄이 넘어간 긴 문단 안에서 한 줄 움직이는 것은 평소대로다.
  if (to === next || (to === from && target !== sel.head)) return false;
  const line = state.doc.line(next);
  if (!IMAGE_MARK.test(line.text)) return false;
  view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true, userEvent: "select" });
  return true;
}

const imageKeys = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: (view) => stepIntoImage(view, true) },
    { key: "ArrowUp", run: (view) => stepIntoImage(view, false) },
  ]),
);

/* ───────── 묶음 ───────── */

/** 모든 편집기가 똑같이 쓰는 것. 줄 번호·거터·활성 줄 표시 같은 것은 넣지 않는다. */
export const core: Extension = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.lineWrapping,
  look,
  includeMarks,
  includeClick,
  images,
  imageFocus,
  imageKeys,
  liveViews,
];
