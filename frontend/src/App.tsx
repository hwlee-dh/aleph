import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, useIsPresent, usePresenceData, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { api, usingFakeApi } from "./lib/api";
import { formatChars } from "./lib/labels";
import { isArchiveFile, useStore, type RightTab } from "./store";
import { AgentPanel } from "./components/AgentPanel";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { ConversationBar } from "./components/ConversationBar";
import { Dialogs } from "./components/dialogs";
import { DrawerPanel } from "./components/DrawerPanel";
import { Home } from "./components/Home";
import { GearIcon, PanelLeftIcon, PanelRightIcon } from "./components/icons";
import { LeftPanel } from "./components/LeftPanel";
import { ManuscriptView } from "./components/ManuscriptView";
import { Button, Chevron, ConfirmButton, IconButton, MenuItem, Popover, Segmented, Tag, inputClass } from "./components/ui";
import { WorkPanel } from "./components/WorkPanel";

/*
 * 앱을 켜면 메인 화면(components/Home.tsx)이고, 작업을 고르면 아래의 작업 화면이 된다.
 * 작업 화면은 둘뿐이다: 대화 / 원고. 가운데만 바뀐다.
 * 왼쪽은 글(원고 목록과 요약, 자료), 오른쪽은 에이전트 쪽(작업, 에이전트, 원고 화면에서는 대화도).
 * 문서를 크게 볼 때는 가운데와 오른쪽 패널 사이로 넓은 패널이 밀려 나온다.
 * 새 작업, 설정, 도구 편집 같은 것은 전부 팝업이라 닫으면 보던 자리로 돌아온다.
 *
 * 창이 좁을 때: 가운데는 MAIN_MIN 아래로 줄지 않고 가로 스크롤도 만들지 않는다.
 * 옆에 나란히 놓을 자리가 없는 패널은 가운데 위에 겹쳐 뜬다 (오른쪽 → 왼쪽 → 넓은 패널 순으로 자리를 준다).
 * 넓은 패널은 겹칠 때 가운데 칸을 꼭 맞게 덮는다.
 */
const MAIN_MIN = 480;
/** 나란히 놓으려면 있어야 하는 너비. 왼쪽·오른쪽은 줄어들 수 있는 가장 좁은 너비이기도 하다. */
const DOCK_MIN = { left: 200, right: 260, drawer: 400 };
/** 겹쳐 뜬 패널의 자리와 그림자 (왼쪽 패널은 오른쪽으로, 오른쪽 패널은 왼쪽으로 진다). */
const FLOAT = {
  left: "left-0 shadow-[10px_0_28px_rgba(26,26,46,0.14)]",
  right: "right-0 shadow-[-10px_0_28px_rgba(26,26,46,0.14)]",
};
/** 겹쳐 뜬 패널은 그림자가 다 들어갈 때까지 조금 더 밀어 넣는다. */
const FLOAT_SHADOW = 40;

/*
 * 패널을 여닫는 움직임. 튀지 않는 스프링으로 짧게, 닫힐 때는 조금 더 빨리.
 * motion이 움직이는 것은 `--slide`(닫힘 0 ↔ 열림 1) 하나뿐이고, 너비와 자리는 CSS가 그 값에 곱해서 정한다.
 * 그래서 너비를 끌거나 창 크기가 바뀌는 것은 움직임을 거치지 않고 손을 그대로 따라온다.
 * rest…: 스프링의 꼬리를 한 화소쯤 남았을 때 끊는다. 기본값대로면 다 닫힌 것처럼 보인 뒤에도 0.1초쯤 더 DOM에 남는다.
 */
const SLIDE_REST = { restDelta: 0.004, restSpeed: 0.5 } as const;
const SLIDE_OPEN = { type: "spring", visualDuration: 0.22, bounce: 0, ...SLIDE_REST } as const;
const SLIDE_CLOSE = { type: "spring", visualDuration: 0.18, bounce: 0, ...SLIDE_REST } as const;
const INSTANT = { duration: 0 } as const;

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return width;
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const fatal = useStore((s) => s.fatal);
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const sessionId = useStore((s) => s.sessionId);
  const screen = useStore((s) => s.screen);
  const rightTab = useStore((s) => s.rightTab);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const width = useStore((s) => s.width);
  const setWidth = useStore((s) => s.setWidth);
  const drawer = useStore((s) => s.drawer);
  const toast = useStore((s) => s.toast);
  const windowWidth = useWindowWidth();

  useEffect(() => {
    void init();
  }, [init]);

  // 창 어디에든 내보낸 파일(.aleph, .alephpreset)을 끌어다 놓으면 가져온다.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault(); // 이래야 drop이 온다
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      const taken = e.defaultPrevented; // 자료 탭처럼 파일을 받는 자리가 이미 처리했다
      e.preventDefault(); // 브라우저가 그 파일을 열어 화면을 떠나지 않게
      if (taken) return;
      const files = Array.from(e.dataTransfer?.files ?? []).filter(isArchiveFile);
      void (async () => {
        for (const f of files) await useStore.getState().importFile(f);
      })();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // 가운데 몫을 먼저 떼고, 남는 자리에 들어가는 패널만 나란히 놓는다.
  let room = windowWidth - MAIN_MIN;
  const rightDocked = rightOpen && room >= DOCK_MIN.right;
  if (rightDocked) room -= DOCK_MIN.right;
  const leftDocked = leftOpen && room >= DOCK_MIN.left;
  if (leftDocked) room -= DOCK_MIN.left;
  const drawerDocked = !!drawer && room >= DOCK_MIN.drawer;
  const drawerOver = !!drawer && !drawerDocked;
  const leftOver = leftOpen && !leftDocked;
  const rightOver = rightOpen && !rightDocked;
  // 무엇이 가운데를 덮고 있는지 다른 곳에서 알아야 한다 (인용하면 넓은 패널을, 문서를 고르면 겹쳐 뜬 왼쪽 패널을 닫는다).
  useEffect(() => {
    useStore.setState({ drawerOver, leftOver });
  }, [drawerOver, leftOver]);
  /** 겹쳐 뜬 옆 패널은 가운데를 누르면 닫힌다. */
  const dismissFloating = () => {
    const s = useStore.getState();
    if (leftOver) s.togglePanel("left");
    if (rightOver) s.togglePanel("right");
  };
  const floatWidth = (px: number) => Math.min(px, Math.max(windowWidth - 48, 0));

  // 방금 열어서 나타나는 패널만 밀려 나온다. 넓은 패널은 창 크기에 따라 나란히 놓인 것과 가운데를 덮는 것이
  // 서로 갈아 끼워지는데, 그때는 같은 패널이 자리만 옮기는 것이라 움직임 없이 바로 바뀌어야 한다.
  // 그래서 바로 앞 화면에서 이미 열려 있었는지를 기억해 둔다.
  const was = useRef({ left: leftOpen, right: rightOpen, drawer: !!drawer });
  useEffect(() => {
    was.current = { left: leftOpen, right: rightOpen, drawer: !!drawer };
  });

  if (fatal)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-lg font-black">ALEPH에 연결하지 못했습니다</div>
        <div className="max-w-md text-muted">{fatal}</div>
        <Button variant="primary" onClick={() => void init()}>
          다시 시도
        </Button>
      </div>
    );
  if (!ready) return null;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 메인 화면에는 상단바도 세 칸도 없다. 팝업과 알림은 두 화면이 같이 쓴다. */}
      {view === "home" ? <Home /> : <TopBar />}
      {view === "work" && sessionId && (
        // 나란히 놓인 패널은 정한 너비를 갖되, 창이 좁으면 조금씩 줄어든다.
        // overflow-clip: 밀려 나오는 패널이 잠깐 줄 밖에 걸쳐 있어도 이 줄이 옆으로 스크롤되는 일이 없다.
        <div className="relative flex min-h-0 flex-1 overflow-clip">
          {/* 옆 패널은 열려 있는 동안 한 개가 그대로 있고, 나란히 놓였는지 겹쳐 떴는지만 바뀐다. */}
          <AnimatePresence initial={false}>
            {leftOpen && (
              <Slide
                key="left"
                as="aside"
                label="글"
                edge="left"
                place={leftDocked ? "dock" : "float"}
                want={leftDocked ? width.left : floatWidth(width.left)}
                min={DOCK_MIN.left}
                appear={!was.current.left}
                grip={<Resizer value={width.left} onChange={(px) => setWidth("left", px)} />}
                side
              >
                <LeftPanel />
              </Slide>
            )}
          </AnimatePresence>

          <div
            className="relative flex min-h-0 flex-[1_0_0]"
            style={{ minWidth: Math.min(MAIN_MIN, windowWidth) }}
            onPointerDownCapture={leftOver || rightOver ? dismissFloating : undefined}
          >
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">{screen === "chat" ? <ChatColumn /> : <ManuscriptView />}</main>
            {/* key: 작업을 바꾸면 닫히는 움직임 없이 바로 치운다 (닫히는 동안 앞 작업의 문서를 새 작업에서 읽으려 들지 않게).
                custom: 문서를 닫아서 사라지는 것인지(움직인다), 자리를 옮기느라 사라지는 것인지(바로 치운다). */}
            <AnimatePresence key={sessionId} initial={false} custom={!drawer}>
              {drawer && drawerOver && (
                <Slide key="drawer" as="section" label="문서" edge="right" place="cover" appear={!was.current.drawer}>
                  <DrawerPanel drawer={drawer} />
                </Slide>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence key={sessionId} initial={false} custom={!drawer}>
            {drawer && drawerDocked && (
              <Slide
                key="drawer"
                as="section"
                label="문서"
                edge="right"
                place="dock"
                want={width.drawer}
                min={360}
                appear={!was.current.drawer}
                grip={<Resizer value={width.drawer} onChange={(px) => setWidth("drawer", px)} reverse />}
              >
                <DrawerPanel drawer={drawer} />
              </Slide>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {rightOpen && (
              <Slide
                key="right"
                as="aside"
                label="에이전트"
                edge="right"
                place={rightDocked ? "dock" : "float"}
                want={rightDocked ? width.right : floatWidth(width.right)}
                min={DOCK_MIN.right}
                appear={!was.current.right}
                grip={<Resizer value={width.right} onChange={(px) => setWidth("right", px)} reverse />}
                // 원고 화면에서 이 패널에 대화가 들어와 있으면 흰색이다 (대화는 읽고 쓰는 칸이다).
                side={!(screen === "manuscript" && rightTab === "chat")}
              >
                <RightPanel />
              </Slide>
            )}
          </AnimatePresence>
        </div>
      )}
      <Dialogs />
      <AnimatePresence>
        {toast && (
          <m.div
            key="toast"
            role="status"
            // 긴 이유(올리기 실패 등)는 여러 줄이 된다. 폭은 글 길이만큼, 창을 넘지 않게.
            className={`fixed bottom-6 left-1/2 z-[60] w-max max-w-[min(92vw,44rem)] -translate-x-1/2 rounded-[18px] px-4 py-2 text-[13px] text-white shadow-[0_6px_20px_rgba(0,0,0,0.25)] ${
              toast.tone === "error" ? "bg-danger" : "bg-ink"
            }`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {toast.text}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 여닫히는 패널 한 칸.
 *   dock  — 가운데 옆에 나란히. 너비가 0에서 제 너비로 자라며 가운데를 민다.
 *   float — 가운데 위에 겹쳐. 가장자리에서 미끄러져 들어온다.
 *   cover — 가운데 칸을 꼭 맞게 덮어. 오른쪽에서 미끄러져 들어온다.
 * 닫히면 DOM에서 사라진다 (AnimatePresence가 닫히는 움직임이 끝날 때까지만 붙들어 둔다).
 */
function Slide({
  as: Tag,
  label,
  edge,
  place,
  want = 0,
  min = 0,
  appear,
  grip,
  side = false,
  children,
}: {
  /** 양옆 패널의 면(옅은 회청색)으로 그린다. 아니면 흰색이다. */
  side?: boolean;
  as: "aside" | "section";
  label: string;
  /** 어느 쪽에서 나오는가. */
  edge: "left" | "right";
  place: "dock" | "float" | "cover";
  /** dock: 정한 너비 (자리가 모자라면 줄어든다). float: 뜬 너비. */
  want?: number;
  /** dock일 때 줄어들 수 있는 가장 좁은 너비. */
  min?: number;
  /** 방금 열어서 나타나는가. 아니면 처음부터 열린 채로 놓인다. */
  appear: boolean;
  /** 너비를 끄는 손잡이. dock일 때만 가운데 쪽에 붙는다. */
  grip?: ReactNode;
  children: ReactNode;
}) {
  const present = useIsPresent();
  // AnimatePresence의 custom. false면 닫혀서가 아니라 자리를 옮기느라 사라지는 것이다.
  const closed = usePresenceData() !== false;
  // 운영체제의 `동작 줄이기`. MotionConfig는 transform만 꺼 주므로 너비가 자라는 것은 여기서 끈다.
  const still = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [slideIn] = useState(appear && !still);
  /** `--slide`가 1에 닿기 전이다 (열리는 중이거나 닫히는 중). */
  const [mid, setMid] = useState(slideIn);
  const moving = mid || !present;
  const docked = place === "dock";

  // 움직이는 동안 패널 속은 다 열렸을 때의 너비로 묶어 두고 바깥 칸으로 가린다. 안 그러면 좁아진 칸에 맞춰
  // 글이 줄을 바꿔 가며 찌그러진다. 그 너비는 옆 패널들과 자리를 나눈 결과라 CSS만 안다. 그래서 잠깐 다 연 것으로 놓고 잰다.
  const [full, setFull] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !moving || !docked) return;
    const now = el.style.getPropertyValue("--slide");
    el.style.setProperty("--slide", "1");
    setFull(el.getBoundingClientRect().width);
    el.style.setProperty("--slide", now);
  }, [moving, docked]);
  const pinned = moving && docked && full !== null;

  const out = edge === "left" ? "var(--slide) - 1" : "1 - var(--slide)";
  // 양옆 패널은 옅은 회청색 면(.side)으로 내려앉고, 글을 읽고 쓰는 칸(가운데, 넓은 패널, 패널에 든 대화)은 흰색이다.
  const surface = side ? "side" : "bg-bg";
  return (
    <m.div
      ref={box}
      // 닫히는 동안에는 이미 닫힌 것으로 친다: 누르거나 탭 키로 들어갈 수 없다.
      inert={!present}
      className={
        docked
          ? // 가운데 쪽 가장자리에 붙여 둔다. 그래야 가운데와 한 장처럼 같이 밀린다.
            `flex min-h-0 ${edge === "left" ? "justify-end" : ""} ${moving ? "overflow-clip" : ""}`
          : place === "float"
            ? `absolute inset-y-0 z-30 flex ${FLOAT[edge]}`
            : `absolute inset-0 z-20 flex ${moving ? "overflow-clip" : ""}`
      }
      style={
        !present && !closed
          ? // 자리를 옮기느라 치워지는 쪽은 그 자리에서 바로 안 보이게 한다. motion이 치우는 것은 다음 화면이라,
            // 그대로 두면 새 자리에 놓인 것과 한 화면 동안 같이 보인다.
            { display: "none" }
          : docked
          ? { flex: `0 1 calc(var(--slide) * ${want + 1}px)`, minWidth: `calc(var(--slide) * ${min + 1}px)` }
          : place === "float"
            ? // translate는 움직일 때만 건다. 0이어도 걸려 있으면 안쪽의 겹침 순서와 fixed의 기준이 달라진다.
              { width: want, translate: moving ? `calc((${out}) * ${want + FLOAT_SHADOW}px) 0` : undefined }
            : undefined
      }
      initial={slideIn ? { "--slide": 0 } : false}
      animate={{ "--slide": 1 }}
      exit={{ "--slide": 0, transition: still || !closed ? INSTANT : SLIDE_CLOSE }}
      transition={still ? INSTANT : SLIDE_OPEN}
      onUpdate={(latest) => setMid(Number(latest["--slide"]) < 1)}
    >
      {docked && edge === "right" && grip}
      <Tag
        aria-label={label}
        className={
          docked
            ? `flex min-h-0 flex-col ${surface}`
            : `flex min-h-0 min-w-0 flex-[1_0_0] flex-col ${surface} ${place === "cover" ? "" : edge === "left" ? "border-r border-line" : "border-l border-line"}`
        }
        style={
          docked
            ? pinned
              ? { flex: "none", width: full - (grip ? 1 : 0) }
              : { flex: "1 0 0", minWidth: 0 }
            : place === "cover" && moving
              ? { translate: "calc((1 - var(--slide)) * 100%) 0" }
              : undefined
        }
      >
        {children}
      </Tag>
      {docked && edge === "left" && grip}
    </m.div>
  );
}

function ChatColumn() {
  return (
    <>
      <ConversationBar />
      <Conversation />
      <Composer />
    </>
  );
}

/** 맨 위 줄: 작업 고르기, 화면 고르기, 패널 접기, 설정. */
function TopBar() {
  const screen = useStore((s) => s.screen);
  const setScreen = useStore((s) => s.setScreen);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const openDialog = useStore((s) => s.openDialog);
  const goHome = useStore((s) => s.goHome);
  const sessionId = useStore((s) => s.sessionId);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <IconButton label="왼쪽 패널" active={leftOpen} onClick={() => togglePanel("left")}>
        <PanelLeftIcon />
      </IconButton>
      {/* 로고: 그림과 글자가 한 장이다 (글자를 폰트로 따로 그리지 않는다). 누르면 메인 화면으로 돌아간다. */}
      <button
        type="button"
        aria-label="메인 화면"
        title="메인 화면"
        onClick={goHome}
        className="ml-1 flex h-8 shrink-0 items-center rounded-lg border-0 bg-transparent px-1 select-none hover:bg-sunken"
      >
        <img src="/aleph-logo.png" alt="ALEPH" width={3559} height={905} className="h-[23px] w-auto" draggable={false} />
      </button>
      <WorkSwitcher />
      {usingFakeApi && <Tag tone="warn">가짜 API</Tag>}
      <span className="flex-1" />
      {sessionId && (
        <Segmented
          label="화면"
          value={screen}
          onChange={setScreen}
          options={[
            { value: "chat", label: "대화" },
            { value: "manuscript", label: "원고" },
          ]}
        />
      )}
      <span className="flex-1" />
      <IconButton label="설정" onClick={() => openDialog({ type: "settings" })}>
        <GearIcon />
      </IconButton>
      <IconButton label="오른쪽 패널" active={rightOpen} onClick={() => togglePanel("right")}>
        <PanelRightIcon />
      </IconButton>
    </header>
  );
}

function WorkSwitcher() {
  const sessions = useStore((s) => s.sessions);
  const sessionId = useStore((s) => s.sessionId);
  const presets = useStore((s) => s.presets);
  const select = useStore((s) => s.selectSession);
  const rename = useStore((s) => s.renameSession);
  const remove = useStore((s) => s.deleteSession);
  const refreshSessions = useStore((s) => s.refreshSessions);
  const openDialog = useStore((s) => s.openDialog);
  const fail = useStore((s) => s.fail);
  // 목록의 `실행 중`은 메뉴를 열 때 받은 값이다. 지금 작업은 화면이 직접 알고 있으니 그것도 같이 본다.
  const runningNow = useStore((s) => s.running);
  const current = sessions.find((s) => s.id === sessionId);
  const [name, setName] = useState<string | null>(null);
  return (
    <Popover
      trigger={(open, toggle) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setName(null);
            // 다른 작업의 실행이 그사이 끝났을 수 있다. 열 때 `실행 중` 표시를 다시 받는다.
            if (!open) void refreshSessions();
            toggle();
          }}
          className="ml-2 inline-flex h-8 max-w-72 items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 font-bold hover:bg-sunken"
        >
          <span className="truncate">{current?.name ?? "작업"}</span>
          <Chevron />
        </button>
      )}
    >
      {(close) => (
        <div className="w-80 max-w-full">
          {sessions.map((s) => (
            <MenuItem
              key={s.id}
              active={s.id === sessionId}
              hint={[presets.find((p) => p.id === s.preset_id)?.name, formatChars(s.chars), s.running ? "실행 중" : ""].filter(Boolean).join(" · ")}
              onClick={() => {
                close();
                if (s.id !== sessionId) void select(s.id);
              }}
            >
              {s.name}
            </MenuItem>
          ))}
          <div className="mx-2.5 my-1 border-t border-hair" />
          <MenuItem
            onClick={() => {
              close();
              openDialog({ type: "new" });
            }}
          >
            + 새 작업
          </MenuItem>
          {current &&
            (name === null ? (
              // 이름이 길면 `'이름' 삭제`가 메뉴 너비를 넘는다. 그때만 다음 줄로 넘긴다.
              <div className="flex flex-wrap items-center gap-1 px-1 py-1">
                <Button small variant="quiet" onClick={() => setName(current.name)}>
                  이름 변경
                </Button>
                <Button
                  small
                  variant="quiet"
                  disabled={current.running || runningNow}
                  title={current.running || runningNow ? "실행 중에는 내보낼 수 없습니다" : undefined}
                  onClick={() => {
                    close();
                    // 방금 고친 지침·도구가 zip에 들어가도록, 프리셋 저장이 끝난 뒤에 받는다.
                    void useStore
                      .getState()
                      .flushPreset()
                      .then(() => api.exportArchive(current.id))
                      .catch(fail);
                  }}
                >
                  내보내기
                </Button>
                <ConfirmButton
                  label="삭제"
                  confirm={`'${current.name}' 삭제`}
                  disabled={current.running}
                  title={current.running ? "실행 중에는 삭제할 수 없습니다" : undefined}
                  onConfirm={() => {
                    close();
                    void remove(current.id);
                  }}
                />
              </div>
            ) : (
              <form
                className="flex items-center gap-2 p-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) void rename(current.id, name.trim());
                  setName(null);
                }}
              >
                <input autoFocus aria-label="작업 이름" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
                <Button small variant="primary" type="submit">
                  저장
                </Button>
              </form>
            ))}
        </div>
      )}
    </Popover>
  );
}

function RightPanel() {
  const screen = useStore((s) => s.screen);
  const rightTab = useStore((s) => s.rightTab);
  const setRightTab = useStore((s) => s.setRightTab);
  // 실행은 어느 대화의 것이든 이 탭 안에 있다. 지금 실행의 기록(live)으로 답을 기다리는지 본다.
  const waiting = useStore((s) => s.running && s.live.some((it) => it.kind === "ask" && !it.answered));
  const running = useStore((s) => s.running);
  const tabs: { id: RightTab; label: string; mark?: ReactNode }[] = [
    // 원고 화면에서는 가운데가 원고라서 대화가 이쪽으로 온다.
    ...(screen === "manuscript"
      ? [{ id: "chat" as const, label: "대화", mark: waiting ? <span className="h-1.5 w-1.5 rounded-full bg-blue" /> : running ? <span className="pulse h-1.5 w-1.5 rounded-full bg-agent" /> : null }]
      : []),
    { id: "work", label: "작업" },
    { id: "agent", label: "에이전트" },
  ];
  const tab = tabs.some((t) => t.id === rightTab) ? rightTab : "work";
  return (
    <>
      <div className="flex h-11 shrink-0 items-end gap-5 border-b border-hair px-4" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setRightTab(t.id)}
            className={`-mb-px flex items-center gap-1.5 border-0 border-b-2 bg-transparent px-0 pb-2 text-[15px] ${
              tab === t.id ? "border-blue font-black text-ink" : "border-transparent font-bold text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {t.mark}
          </button>
        ))}
      </div>
      {tab === "chat" ? <ChatColumn /> : tab === "work" ? <WorkPanel /> : <AgentPanel />}
    </>
  );
}

/** 패널 사이의 세로줄. 끌어서 너비를 바꾼다. reverse면 왼쪽으로 끌수록 넓어진다. */
function Resizer({ value, onChange, reverse = false }: { value: number; onChange: (px: number) => void; reverse?: boolean }) {
  const start = useRef<{ x: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={`resizer ${dragging ? "dragging" : ""}`}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, value };
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = e.clientX - start.current.x;
        onChange(start.current.value + (reverse ? -delta : delta));
      }}
      onPointerUp={(e) => {
        start.current = null;
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    />
  );
}
