import { useMemo, useRef, useState, type ReactNode } from "react";
import { usingFakeApi } from "../lib/api";
import { formatChars, formatWhen } from "../lib/labels";
import type { SessionSummary } from "../lib/types";
import { ARCHIVE_ACCEPT, useStore } from "../store";
import { GearIcon, GitHubIcon, MailIcon } from "./icons";
import { Button, IconButton, Popover, Tag } from "./ui";

/*
 * 메인 화면. 앱을 켜면 먼저 보이고, 작업 화면의 로고를 누르면 돌아온다.
 * 위에서 아래로: 로고 → 버전 번호와 날짜 → 작업 카드 → Related Links → 푸터.
 * 가운데에 놓인 단 하나(960px)다. 맨 위 묶음(로고, 버전)과 푸터는 가운데에 맞추고,
 * 구역의 머리와 카드 안의 글은 왼쪽에 맞춘다. 상자는 작업 카드와 링크 박스뿐이다.
 */

/**
 * 바깥 링크의 주소. 비우면 그 박스는 눌러도 아무 데도 가지 않는다.
 * github은 주소 전체(https://…), email은 메일 주소만 적는다. 박스에는 `https://`를 뗀 주소가 보인다.
 */
const LINKS = { github: "https://github.com/hwlee-dh", email: "hwlee0495@uos.ac.kr" };

/**
 * 푸터에 적는 글. 비워 둔 것은 그리지 않는다: name이 비면 소속만 보이고 저작권 표시(ⓒ 해 이름)도 빠진다.
 * 라이선스는 아직 정하지 않아서 적지 않는다.
 */
const AUTHOR = {
  name: "이현우",
  advisor: "유승환",
  affiliation: "서울시립대학교 국어국문학과",
  project: "2026년 1학기 학생미래설계학기 연구인턴십 「생성형 AI를 활용한 문학창작 연구」",
  year: 2026,
};

/** 묶음에 든 폰트의 라이선스 글 (public/licenses). OFL은 폰트와 함께 이 글을 내주라고 한다. */
const FONT_LICENSES = [
  { name: "Noto Sans KR", file: "noto-sans-kr.txt" },
  { name: "Noto Serif KR", file: "noto-serif-kr.txt" },
  { name: "IBM Plex Mono", file: "ibm-plex-mono.txt" },
  { name: "고운바탕", file: "gowun-batang.txt" },
  { name: "Pretendard", file: "pretendard.txt" },
];

/** 마지막으로 고친 때. 엔진이 못 준 작업은 만든 때로 친다. */
const changedAt = (s: SessionSummary) => s.updated_at ?? s.created_at;
const changedTime = (s: SessionSummary) => Date.parse(changedAt(s) ?? "") || 0;

export function Home() {
  const version = useStore((s) => s.meta?.version);
  const versionDate = useStore((s) => s.meta?.version_date);
  const sessions = useStore((s) => s.sessions);
  const sessionId = useStore((s) => s.sessionId);
  // 목록의 `실행 중`은 목록을 받을 때의 값이다. 골라져 있는 작업은 화면이 직접 알고 있으니 그것도 같이 본다.
  const runningNow = useStore((s) => s.running);
  const openWork = useStore((s) => s.openWork);
  const openDialog = useStore((s) => s.openDialog);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // 엔진은 만든 순서로 준다. 최근에 고친 것이 앞에 오게 다시 줄 세운다 (같으면 받은 순서 그대로).
  const works = useMemo(() => [...sessions].sort((a, b) => changedTime(b) - changedTime(a)), [sessions]);

  /** 내보낸 파일을 들여온다. 작업(.aleph)이면 store가 그 작업 화면으로 옮기고, 프리셋이면 알림만 뜬다. */
  const importFile = async (file: File) => {
    if (busy) return;
    setBusy(true);
    await useStore.getState().importFile(file);
    setBusy(false);
  };

  return (
    // 화면이 길어지면 이 화면만 스크롤된다.
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* min-h-full + flex: 내용이 짧으면 푸터가 화면 아래에 붙는다. */}
      <div className="relative flex min-h-full flex-col">
        {/* 작업 화면 상단바의 설정 버튼과 같은 자리 (위 10px, 오른쪽 12px). */}
        <div className="absolute top-2.5 right-3 flex items-center gap-2">
          {usingFakeApi && <Tag tone="warn">가짜 API</Tag>}
          <IconButton label="설정" onClick={() => openDialog({ type: "settings" })}>
            <GearIcon />
          </IconButton>
        </div>

        <main className="mx-auto flex w-full max-w-[1008px] flex-1 flex-col px-6">
          <header className="flex flex-col items-center pt-16">
            <h1 className="m-0">
              {/* 그림과 글자가 한 장이다. */}
              <img src="/aleph-logo.png" alt="ALEPH" width={3559} height={905} className="block h-auto w-[180px] max-w-full select-none" draggable={false} />
            </h1>
            {/* `v0.4.0 · 2026-11-17`. 날짜를 엔진이 모르면 번호만 보인다. */}
            {version && (
              <div className="mt-2.5 font-mono text-xs text-muted">
                v{version}
                {versionDate && ` · ${versionDate}`}
              </div>
            )}
          </header>

          <section className="mt-12" aria-label="작업">
            <div className="flex items-end gap-2">
              <h2 className="head-bar text-base">작업</h2>
              {works.length > 0 && <span className="text-[13px] leading-[1.7] text-muted">{works.length}</span>}
              <span className="flex-1" />
              <Button disabled={busy} onClick={() => picker.current?.click()}>
                가져오기
              </Button>
              <input
                ref={picker}
                type="file"
                accept={ARCHIVE_ACCEPT}
                hidden
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  e.target.value = ""; // 같은 파일을 다시 골라도 change가 오게
                  if (picked) void importFile(picked);
                }}
              />
              <Button variant="primary" onClick={() => openDialog({ type: "new" })}>
                새 작업
              </Button>
            </div>
            {/* 넓으면 3단, 중간 2단, 좁으면 1단. 카드는 280px 아래로 줄지 않되 창이 그보다 좁으면 창을 따른다. */}
            {works.length > 0 && (
              <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-4">
                {works.map((w) => (
                  <WorkCard key={w.id} work={w} running={w.running || (w.id === sessionId && runningNow)} onOpen={() => void openWork(w.id)} />
                ))}
              </div>
            )}
          </section>

          <nav className="mt-12" aria-labelledby="home-links">
            <h2 id="home-links" className="head-bar text-base">
              Related Links
            </h2>
            {/* 작업 카드와 같은 격자, 같은 꼴의 박스. 이름 밑에 주소를 적는다 (mailto는 메일 프로그램이 없으면 눌러도 아무 일이 없다). */}
            <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-4">
              <LinkCard name="GitHub" href={LINKS.github} address={LINKS.github.replace(/^https?:\/\//i, "").replace(/\/$/, "")} icon={<GitHubIcon />} />
              <LinkCard name="Email" href={LINKS.email && `mailto:${LINKS.email}`} address={LINKS.email} icon={<MailIcon />} />
            </div>
          </nav>

          <footer className="mt-auto pt-14">
            {/* 가운데에 세 줄(소속과 이름, 프로젝트, 저작권 표시), 그 밑에 폰트 라이선스. */}
            <div className="flex flex-col items-center gap-2 border-t border-line py-5 text-center text-xs break-keep text-muted">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span>
                  {[AUTHOR.affiliation, AUTHOR.name].filter(Boolean).join(" ")}
                  {AUTHOR.advisor && ` · 지도교수 ${AUTHOR.advisor}`}
                </span>
                <span>{AUTHOR.project}</span>
                {AUTHOR.name && (
                  <span>
                    ⓒ {AUTHOR.year} {AUTHOR.name}
                  </span>
                )}
              </div>
              <Popover
                side="top"
                trigger={(open, toggle) => (
                  <button
                    type="button"
                    aria-haspopup="true"
                    aria-expanded={open}
                    onClick={toggle}
                    className="border-0 bg-transparent p-0 text-xs text-muted hover:text-ink hover:underline"
                  >
                    폰트 라이선스
                  </button>
                )}
              >
                {(close) => (
                  <div className="flex flex-col">
                    {FONT_LICENSES.map((f) => (
                      <a
                        key={f.file}
                        href={`/licenses/${f.file}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={close}
                        className="rounded-md px-2.5 py-1.5 text-[13px] text-ink no-underline hover:bg-sunken"
                      >
                        {f.name}
                      </a>
                    ))}
                  </div>
                )}
              </Popover>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

/** 작업 하나. 카드 전체가 버튼이고 누르면 그 작업이 열린다. */
function WorkCard({ work, running, onOpen }: { work: SessionSummary; running: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-28 min-w-0 flex-col items-stretch gap-1 rounded-xl border border-line bg-bg p-4 text-left hover:border-blue"
    >
      <span className="flex items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug font-bold [overflow-wrap:anywhere]">{work.name}</span>
        {running && (
          <span className="mt-px flex">
            <Tag tone="agent">실행 중</Tag>
          </span>
        )}
      </span>
      <span className="text-[13px]">
        원고 {formatChars(work.chars)}, 자료 {(work.materials ?? 0).toLocaleString("ko-KR")}개
      </span>
      <span className="mt-auto pt-3 text-xs text-muted">{formatWhen(changedAt(work))}</span>
    </button>
  );
}

/** 바깥 링크 하나. 작업 카드와 같은 꼴이고 박스 전체가 링크다. 주소가 비면 자리만 지킨다 (눌러도 아무 데도 가지 않는다). */
function LinkCard({ name, href, address, icon }: { name: string; href: string; address: string; icon: ReactNode }) {
  const shape = "flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-bg p-4 text-left text-ink no-underline";
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[15px] leading-snug font-bold">
        {icon}
        {name}
      </span>
      {address && <span className="text-[13px] text-muted [overflow-wrap:anywhere]">{address}</span>}
    </>
  );
  if (!href)
    return (
      <a role="link" aria-disabled="true" className={`${shape} cursor-default`}>
        {body}
      </a>
    );
  // 웹 주소는 새 탭으로 연다. mailto는 메일 프로그램이 받으므로 그대로 둔다.
  const web = /^https?:/i.test(href);
  return (
    <a href={href} target={web ? "_blank" : undefined} rel={web ? "noreferrer" : undefined} className={`${shape} hover:border-blue`}>
      {body}
    </a>
  );
}
