/*
 * 다른 탭을 보고 있는 사이에 실행이 끝났거나 내 답을 기다리게 됐을 때 알린다.
 * 긴 실행을 걸어 두고 다른 일을 하다가 돌아오는 것이 보통이라, 끝난 줄 모르고 기다리지 않게 하려는 것이다.
 *   - 탭 제목 앞에 표시를 붙인다 (`● ALEPH`, 기다리는 중이면 `? ALEPH`). 탭으로 돌아오면 되돌린다.
 *   - 브라우저 알림 권한이 있으면 알림도 띄운다.
 * 이 탭을 보고 있을 때는 아무것도 하지 않는다.
 */

export type Attention = "done" | "confirm" | "question";

const BODY: Record<Attention, string> = { done: "실행이 끝났습니다", confirm: "확인을 기다립니다", question: "질문이 있습니다" };
const ASKED = "aleph.notify.asked";

let title: string | null = null; // 표시를 붙이기 전의 제목. null이면 붙인 것이 없다
let shown: Notification | null = null;
let watching = false;
let asked = false;

function clear() {
  if (title !== null) {
    document.title = title;
    title = null;
  }
  shown?.close();
  shown = null;
}

export function attention(kind: Attention): void {
  if (typeof document === "undefined" || !document.hidden) return;
  if (!watching) {
    watching = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) clear();
    });
  }
  // 표시가 이미 붙어 있으면(질문 뒤에 끝남 등) 원래 제목은 그대로 두고 표시만 바꾼다.
  if (title === null) title = document.title;
  document.title = `${kind === "done" ? "●" : "?"} ${title}`;

  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    shown?.close();
    // 같은 tag면 앞의 알림을 갈아 끼운다. 알림이 쌓이지 않는다.
    const note = new Notification("ALEPH", { body: BODY[kind], tag: "aleph" });
    note.onclick = () => {
      window.focus();
      note.close();
    };
    shown = note;
  } catch {
    /* 생성자로는 알림을 못 띄우는 브라우저(안드로이드 크롬 등). 제목 표시만 남는다 */
  }
}

/**
 * 알림 권한을 묻는다. 브라우저는 사용자 동작(클릭, Enter) 안에서 부른 것만 받아 주므로 요청을 보내는 자리에서 부른다.
 * 한 번만 묻는다: 이미 정해졌으면(허용·차단) 안 묻고, 묻는 창을 그냥 닫았어도 보낼 때마다 다시 띄우지 않는다.
 */
export function askNotifyPermission(): void {
  if (asked || typeof Notification === "undefined" || Notification.permission !== "default") return;
  asked = true;
  try {
    if (localStorage.getItem(ASKED)) return;
    localStorage.setItem(ASKED, "1");
  } catch {
    /* 저장소를 못 쓰는 브라우저. 이번에 켠 동안에만 한 번 묻는다 */
  }
  try {
    // 옛 사파리는 약속 대신 콜백을 받고 아무것도 돌려주지 않는다.
    void Promise.resolve(Notification.requestPermission()).catch(() => undefined);
  } catch {
    /* 권한을 물을 수 없는 환경 */
  }
}
