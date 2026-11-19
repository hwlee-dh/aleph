import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useAppearance } from "../../lib/appearance";
import { HEADING_CLASS, isHeading, segmentLine } from "../../lib/textKinds";

/*
 * 폰트 설정: 굵게·기울임·따옴표 안의 글을 종류마다 다른 모양으로 그리고, 제목 줄(`# …`)에 제목 폰트를 건다.
 * `@include` 표시와 같은 방식(mark)이라 글자는 그대로 남는다. 저장되는 글에도, 내보낸 파일에도 들어가지 않는다.
 * 모양(폰트, 색)은 여기 없다. 클래스(`tk-dq` 등)만 붙이고, 그 클래스의 CSS는 lib/appearance.ts가 설정에 맞춰 만든다.
 */

/** 살아 있는 편집기 전부. 화면 설정이 바뀌면 줄 높이를 다시 재게 한다. */
const live = new Set<EditorView>();
/** 설정이 바뀌었으니 꾸밈을 다시 만들라는 신호. */
const restyle = StateEffect.define<null>();

/** 모든 편집기가 쓴다 (extensions.ts의 core). */
export const liveViews: Extension = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      live.add(view);
    }
    destroy() {
      live.delete(this.view);
    }
  },
);

// 같은 클래스의 꾸밈은 하나만 만들어 같이 쓴다.
const marks = new Map<string, Decoration>();
function markFor(cls: string): Decoration {
  let mark = marks.get(cls);
  if (!mark) marks.set(cls, (mark = Decoration.mark({ class: cls })));
  return mark;
}

/** 제목 줄은 줄 전체에 건다 (`#`도 그대로 보인다). */
const headingLine = Decoration.line({ class: HEADING_CLASS });

function build(view: EditorView): DecorationSet {
  // 꾸미는 종류가 하나도 없으면(기본값) 아무것도 붙이지 않는다.
  if (!useAppearance.getState().kindsActive) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  // 화면에 보이는 줄만 본다. 긴 원고에서도 타이핑이 느려지지 않는다.
  let done = -1; // 여기까지는 이미 봤다 (범위가 줄 가운데에서 시작해도 같은 줄을 두 번 넣지 않게)
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.from <= done) continue;
      done = line.to;
      if (isHeading(line.text)) builder.add(line.from, line.from, headingLine);
      for (const s of segmentLine(line.text)) builder.add(line.from + s.from, line.from + s.to, markFor(s.cls));
    }
  }
  return builder.finish();
}

const kindMarksPlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    constructor(view: EditorView) {
      this.deco = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(restyle)))) this.deco = build(u.view);
    }
  },
  { decorations: (v) => v.deco },
);

/**
 * 본문 자리의 편집기(원고, 출력)에만 넣는다. 자료와 입력에는 넣지 않는다.
 * `tk-text`는 '보통' 글의 폰트와 색이 걸리는 자리다.
 */
export const kindMarks: Extension = [kindMarksPlugin, EditorView.editorAttributes.of({ class: "tk-text" })];

function refresh() {
  for (const view of live) {
    view.dispatch({ effects: restyle.of(null) });
    // 폰트나 글자 크기가 바뀌면 줄 높이가 달라진다.
    view.requestMeasure();
  }
}

useAppearance.subscribe((now, before) => {
  if (now.value !== before.value || now.fonts !== before.fonts) refresh();
});

// 폰트 파일이 뒤늦게 도착해 글자 폭이 바뀌었을 때도 다시 잰다 (커서 자리와 인용 버튼의 자리가 어긋나지 않게).
if (typeof document !== "undefined" && document.fonts) document.fonts.addEventListener("loadingdone", () => live.forEach((v) => v.requestMeasure()));
