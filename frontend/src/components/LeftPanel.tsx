import { useStore, type LeftTab } from "../store";
import { SearchIcon } from "./icons";
import { ManuscriptList } from "./left/ManuscriptList";
import { MaterialTree } from "./left/MaterialTree";
import { SearchBox, closeSearch, openSearch, useSearch } from "./left/SearchBox";
import { IconButton } from "./ui";

/** 왼쪽 패널: 원고 목록(장면과 요약)과 자료 트리. 너비와 접기는 바깥(App)이 맡고, 여기는 주어진 칸을 채운다. */
export function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  const setTab = useStore((s) => s.setLeftTab);
  const scenes = useStore((s) => s.ws?.manuscript.chapters.reduce((n, c) => n + c.scenes.length, 0) ?? 0);
  const materials = useStore((s) => s.ws?.materials.length ?? 0);
  // 찾는 동안에는 탭 아래가 찾기 칸이 된다. 탭을 누르면 그 목록으로 돌아간다.
  const searching = useSearch((s) => s.open);

  const tabButton = (id: LeftTab, label: string, count: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={!searching && tab === id}
      onClick={() => {
        closeSearch();
        setTab(id);
      }}
      // -mb-px: 고른 탭의 파란 밑줄이 탭 줄의 회색 선 위에 겹치게.
      className={`-mb-px flex h-10 items-center gap-1.5 border-b-2 text-sm ${
        !searching && tab === id ? "border-blue font-bold text-blue" : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {label}
      <span className="text-xs font-normal text-muted tabular-nums">{count}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="tablist" className="flex shrink-0 gap-5 border-b border-line pr-2 pl-4">
        {tabButton("manuscript", "원고", scenes)}
        {tabButton("materials", "자료", materials)}
        <span className="flex-1" />
        <IconButton label="찾기" title="찾기 (Ctrl+Shift+F)" active={searching} className="self-center" onClick={searching ? closeSearch : openSearch}>
          <SearchIcon />
        </IconButton>
      </div>
      {searching && <SearchBox />}
      {/* 찾는 동안에도 목록은 치우지 않고 가려만 둔다. 접어 둔 장·폴더와 고치던 것이 그대로 남는다. */}
      <div className={searching ? "hidden" : "contents"}>{tab === "manuscript" ? <ManuscriptList /> : <MaterialTree />}</div>
    </div>
  );
}
