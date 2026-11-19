import { EditorView } from "@codemirror/view";
import { barePath } from "../../lib/labels";
import { useStore, type Locate } from "../../store";

/*
 * 찾기 결과를 눌렀을 때 그 자리를 보이는 일 (store의 `locate`).
 * 편집기는 문서를 열 때마다 새로 생기므로, "이 자리는 이미 보였다"는 것을 편집기 밖에 적어 둔다.
 * 안 그러면 한참 뒤에 그 문서를 다시 열었을 때 옛 자리로 튄다.
 */

/** 이미 보인 자리. store는 누를 때마다 새 것을 만들어 넣으므로, 같은 것인지만 보면 된다. */
let shown: Locate | null = null;
/*
 * 같은 문서가 두 군데(원고 화면의 장면과, 넓은 패널에 띄워 둔 그 장면)에 열려 있으면 편집기도 둘이다.
 * 먼저 본 쪽이 자리를 가져가 버리면 다른 쪽은 장면의 머리에 남는다. 누른 직후 잠깐은 다른 편집기도 그 자리를 보인다.
 */
let shownAt = 0;
let shownIn = new WeakSet<EditorView>();
const SHARE_MS = 3000;

/** 이 문서에 아직 보이지 않은 자리가 걸려 있으면 그것을, 없으면 null. */
export function pendingLocate(path: string | undefined): Locate | null {
  const locate = useStore.getState().locate;
  return locate && path && locate.path === barePath(path) && locate !== shown ? locate : null;
}

/** 엔진은 글자(코드 포인트)로 세고 편집기는 UTF-16으로 센다. 그 줄에서의 위치를 편집기의 것으로 바꾼다. */
function unitOffset(text: string, chars: number): number {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen++ >= chars) break;
    units += ch.length;
  }
  return units;
}

/** 그 줄·위치로 스크롤하고 그 글귀를 고른다. 줄이 문서 밖이면 아무것도 하지 않는다 (그사이 글이 바뀐 것이다). */
export function showLocate(view: EditorView, locate: Locate) {
  if (locate === shown && (shownIn.has(view) || performance.now() - shownAt > SHARE_MS)) return;
  if (locate !== shown) {
    shown = locate;
    shownAt = performance.now();
    shownIn = new WeakSet();
  }
  shownIn.add(view);
  const doc = view.state.doc;
  if (locate.line < 1 || locate.line > doc.lines) return;
  const line = doc.line(locate.line);
  const from = Math.min(line.from + unitOffset(line.text, locate.start), line.to);
  const to = Math.min(from + locate.length, line.to);
  // 고른 글은 편집기에 초점이 있어야 칠해져 보인다 (선택 영역은 브라우저 것을 그대로 쓴다).
  view.focus();
  view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
}
