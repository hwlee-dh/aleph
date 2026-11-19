import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { api } from "../../lib/api";
import { barePath, formatChars, formatSize } from "../../lib/labels";
import type { Material } from "../../lib/types";
import { UPLOAD_ACCEPT, useStore } from "../../store";
import { ClipIcon, DocIcon, FolderIcon, ImageIcon, PlusIcon } from "../icons";
import { Chevron, IconButton, MenuItem, Popover, Spinner } from "../ui";
import { ConfirmItem, DRAG_TYPE, DeletedItems, FlagToggle, InlineInput, MenuLine, REVEAL, ROW_BUTTON, RowMenu, YIELD } from "./parts";

/** 보이지 않는 뿌리. 자료의 경로는 전부 이 아래다. */
const ROOT = "자료";
/** 한 단계 들여쓰는 너비(px). */
const INDENT = 14;

interface Folder {
  path: string; // `자료/인물`
  name: string;
  folders: Folder[];
  docs: Material[];
}
/** 위에서 내려온 설정까지 따진 폴더의 실제 값. */
interface Inherited {
  locked: boolean;
  note: boolean;
}

const fileName = (path: string) => path.split("/").pop() ?? "";
const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");
const trimSlashes = (text: string) => text.trim().replace(/^\/+|\/+$/g, "");
const byName = (a: string, b: string) => a.localeCompare(b, "ko", { numeric: true });

/** 이름과 확장자를 가른다. 글 문서는 `.md`만 확장자로 본다 (`2.5장` 같은 이름의 점을 확장자로 착각하지 않게). */
function splitName(m: Material): [string, string] {
  const name = fileName(m.path);
  const ext = (m.kind === "text" ? /\.md$/i : /\.[^.]+$/).exec(name)?.[0] ?? "";
  return [name.slice(0, name.length - ext.length), ext];
}

/**
 * 평평한 목록(`자료/인물/서윤.md` …)에서 폴더 트리를 만든다. 폴더는 문서의 경로에서 나오고,
 * 안이 빈 폴더(사용자가 만들어 둔 것)는 엔진이 따로 주는 폴더 목록에만 있어서 그것도 같이 넣는다.
 */
function buildTree(materials: Material[], folders: string[]): Folder {
  const root: Folder = { path: ROOT, name: ROOT, folders: [], docs: [] };
  const known = new Map<string, Folder>([[ROOT, root]]);
  const folderAt = (path: string): Folder => {
    const found = known.get(path);
    if (found) return found;
    const made: Folder = { path, name: fileName(path), folders: [], docs: [] };
    known.set(path, made);
    folderAt(folderOf(path)).folders.push(made);
    return made;
  };
  for (const m of materials) {
    if (!m.path.startsWith(`${ROOT}/`)) continue;
    folderAt(folderOf(m.path)).docs.push(m);
  }
  for (const path of folders) if (path.startsWith(`${ROOT}/`)) folderAt(path);
  for (const f of known.values()) {
    f.folders.sort((a, b) => byName(a.name, b.name));
    f.docs.sort((a, b) => byName(fileName(a.path), fileName(b.path)));
  }
  return root;
}

/** 자료 탭: 폴더 트리. 문서와 폴더마다 수정 방지와 노트를 켜고 끈다. */
export function MaterialTree() {
  const ws = useStore((s) => s.ws);
  const openPath = useStore((s) => (s.drawer?.kind === "doc" ? s.drawer.path : null));
  const act = useStore((s) => s.act);

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  /** 이름을 바꾸고 있는 문서나 폴더의 경로. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 새 문서나 새 폴더의 이름을 받고 있는 자리 (그것이 들어갈 폴더와 무엇을 만드는지). */
  const [creating, setCreating] = useState<{ folder: string; kind: "doc" | "folder" } | null>(null);
  /** 끌어 온 것이 놓일 폴더. */
  const [dropTo, setDropTo] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // 끌고 있는 문서나 폴더의 경로. 바깥(탐색기)에서 끌어 온 파일이면 비어 있다.
  const drag = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const materials = ws?.materials;
  const folders = ws?.folders;
  const tree = useMemo(() => buildTree(materials ?? [], folders ?? []), [materials, folders]);

  if (!ws) return <div className="flex-1" />;
  const flags = ws.flags;
  const openDoc = (path: string) => useStore.getState().openDoc(path);

  const setFlag = (path: string, patch: { locked?: boolean | null; note?: boolean | null }) => void act((id) => api.setFlags(id, path, patch));

  const setFold = (path: string, fold: boolean) => {
    const next = new Set(folded);
    if (fold) next.add(path);
    else next.delete(path);
    setFolded(next);
  };

  const startCreate = (folder: string, kind: "doc" | "folder" = "doc") => {
    setFold(folder, false); // 접힌 폴더면 입력칸이 보이게 펼친다
    setCreating({ folder, kind });
  };

  const create = async (folder: string, typed: string, kind: "doc" | "folder") => {
    setCreating(null);
    let name = trimSlashes(typed);
    if (folder === ROOT) name = name.replace(/^자료\//, "");
    if (!name) return;
    const path = `${folder}/${name}`;
    if (kind === "folder") {
      // 새 폴더는 접어 둔 적이 없으니 펼쳐진 채로 보인다. 같은 이름의 폴더가 이미 있으면 엔진이 그대로 둔다.
      await act((id) => api.addFolder(id, path));
      return;
    }
    // 같은 이름이 이미 있으면 빈 글로 덮지 않고 그 문서를 연다.
    const existing = ws.materials.find((m) => barePath(m.path) === barePath(path));
    if (existing) return openDoc(existing.path);
    const saved = await act((id) => api.saveDoc(id, path, ""));
    if (saved) openDoc(saved.path);
  };

  /** 옮기기와 이름 바꾸기. 폴더도 된다. */
  const move = async (source: string, destination: string) => {
    if (barePath(source) === barePath(destination)) return;
    const before = useStore.getState().drawer;
    const moved = await act((id) => api.moveDoc(id, source, destination));
    if (!moved) return;
    // 보고 있던 문서를 옮겼으면 넓은 패널이 새 자리를 따라가게 한다 (작업 공간을 다시 읽으면서 옛 경로는 닫힌다).
    if (before?.kind === "doc" || before?.kind === "history") {
      const from = barePath(source);
      const to = barePath(moved.path);
      const at = barePath(before.path);
      const next = at === from ? to : at.startsWith(`${from}/`) ? to + at.slice(from.length) : null;
      if (next) useStore.getState().openDrawer({ ...before, path: next });
    }
  };

  const upload = async (files: File[], folder: string) => {
    if (files.length === 0) return;
    // 뿌리에 놓으면 폴더를 주지 않는다. 서버가 글은 `올린 글`, 이미지는 `삽화`에 넣는다.
    const into = folder === ROOT ? undefined : folder.slice(ROOT.length + 1);
    setUploading(true);
    await useStore.getState().uploadFiles(files, into);
    setUploading(false);
  };

  /**
   * 이름 바꾸기에 적은 글을 새 경로로. 이름만 적으면 그 자리에서 이름을 바꾸고,
   * `폴더/이름`처럼 `/`를 넣으면 자료 맨 위에서부터의 경로로 보고 옮긴다 (새 문서의 `폴더/이름`과 같은 규칙).
   */
  const renamed = (current: string, typed: string, ext = ""): string | null => {
    const name = trimSlashes(typed);
    if (!name) return null;
    if (!name.includes("/")) return `${folderOf(current)}/${name}${ext}`;
    return `${ROOT}/${name.replace(/^자료\//, "")}${ext}`;
  };

  /** 문서나 폴더를 지운다. 버전 기록으로 가는 길은 메뉴의 `삭제한 문서`에 있다 (act가 작업 공간과 함께 그 목록을 다시 받는다). */
  const remove = (path: string) => void act((id) => api.deleteDoc(id, path));

  /* ── 끌어다 놓기: 문서와 폴더를 폴더로, 바깥의 파일을 폴더나 패널로 ── */

  const startDrag = (e: DragEvent, path: string) => {
    drag.current = path;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_TYPE, path);
  };
  const endDrag = () => {
    drag.current = null;
    setDropTo(null);
  };
  /**
   * 끌고 있는 것을 이 폴더에 놓을 수 있는가. 이미 그 폴더에 있으면 옮길 것이 없고,
   * 폴더는 자기 자신이나 자기 안쪽 폴더로 들어갈 수 없다.
   */
  const fits = (source: string, folder: string) => folderOf(source) !== folder && folder !== source && !folder.startsWith(`${source}/`);
  // 폴더 칸은 겹쳐 있다(폴더 안의 폴더). 가장 안쪽이 받고 바깥으로는 올리지 않는다.
  const over = (folder: string) => (e: DragEvent) => {
    e.stopPropagation();
    const mode = drag.current ? (fits(drag.current, folder) ? "move" : null) : e.dataTransfer.types.includes("Files") ? "copy" : null;
    if (mode) {
      e.preventDefault();
      e.dataTransfer.dropEffect = mode;
    }
    setDropTo(mode ? folder : null);
  };
  const dropOn = (folder: string) => (e: DragEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const source = drag.current;
    endDrag();
    if (source) {
      if (fits(source, folder)) void move(source, `${folder}/${fileName(source)}`);
    } else void upload([...e.dataTransfer.files], folder);
  };

  const pad = (depth: number) => ({ paddingLeft: 12 + depth * INDENT });

  const renderDoc = (m: Material, depth: number) => {
    const [stem, ext] = splitName(m);
    const icon = <span className="shrink-0 text-muted">{m.kind === "image" ? <ImageIcon /> : m.kind === "file" ? <ClipIcon /> : <DocIcon />}</span>;
    // 폴더 줄의 접기 화살표만큼 비워서 아이콘이 한 줄로 서게 한다.
    const gap = <span className="w-3 shrink-0" />;

    if (renaming === m.path)
      return (
        <div key={m.path} className="flex h-8 items-center gap-1.5 pr-2" style={pad(depth)}>
          {gap}
          {icon}
          <InlineInput
            initial={stem}
            label="이름"
            title="이름, 또는 폴더/이름"
            className="flex-1"
            onCancel={() => setRenaming(null)}
            onCommit={(typed) => {
              setRenaming(null);
              // 확장자는 그대로 둔다. 이미지의 확장자를 지우면 서버가 무슨 파일인지 모르게 된다.
              const to = renamed(m.path, typed, ext);
              if (to) void move(m.path, to);
            }}
          />
        </div>
      );

    const direct = flags[m.path] ?? flags[barePath(m.path)];
    const active = openPath !== null && barePath(openPath) === barePath(m.path);
    return (
      <div key={m.path} className="group/row flex h-8 items-center rounded-md pr-1 hover:bg-sunken" style={pad(depth)} draggable onDragStart={(e) => startDrag(e, m.path)}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left" onClick={() => openDoc(m.path)}>
          {gap}
          {icon}
          <span className={`min-w-0 flex-1 truncate ${active ? "font-bold text-blue" : ""}`}>{m.kind === "text" ? stem : stem + ext}</span>
          {m.kind === "text" && <span className={`shrink-0 pr-1 text-xs text-muted ${YIELD}`}>{formatChars(m.chars)}</span>}
          {m.kind === "file" && m.size > 0 && <span className={`shrink-0 pr-1 text-xs text-muted ${YIELD}`}>{formatSize(m.size)}</span>}
        </button>
        <FlagToggle kind="note" direct={direct?.note} effective={m.note} onChange={(note) => setFlag(m.path, { note })} />
        <FlagToggle kind="locked" direct={direct?.locked} effective={m.locked} onChange={(locked) => setFlag(m.path, { locked })} />
        <RowMenu>
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  setRenaming(m.path);
                }}
              >
                이름 바꾸기
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  useStore.getState().openDrawer({ kind: "history", path: m.path });
                }}
              >
                버전 기록
              </MenuItem>
              <MenuLine />
              <ConfirmItem
                onConfirm={() => {
                  close();
                  remove(m.path);
                }}
              />
            </>
          )}
        </RowMenu>
      </div>
    );
  };

  const renderFolder = (folder: Folder, depth: number, above: Inherited): ReactNode => {
    const direct = flags[folder.path];
    // 더 안쪽에 건 설정이 우선한다. 직접 건 것이 없으면 위에서 내려온 값이다.
    const own: Inherited = { locked: direct?.locked ?? above.locked, note: direct?.note ?? above.note };
    const isFolded = folded.has(folder.path);
    return (
      <div key={folder.path} onDragOver={over(folder.path)} onDrop={dropOn(folder.path)}>
        {renaming === folder.path ? (
          <div className="flex h-8 items-center gap-1.5 pr-2" style={pad(depth)}>
            <span className="w-3 shrink-0" />
            <span className="shrink-0 text-muted">
              <FolderIcon />
            </span>
            <InlineInput
              initial={folder.name}
              label="이름"
              title="이름, 또는 폴더/이름"
              className="flex-1"
              onCancel={() => setRenaming(null)}
              onCommit={(typed) => {
                setRenaming(null);
                const to = renamed(folder.path, typed);
                if (to) void move(folder.path, to);
              }}
            />
          </div>
        ) : (
          // 폴더 줄도 끌 수 있다. 다른 폴더나 맨 위(자료)에 놓으면 안에 든 것째로 그 안으로 간다.
          <div
            className={`group/row flex h-8 items-center rounded-md pr-1 ${dropTo === folder.path ? "bg-blue-tint" : "hover:bg-sunken"}`}
            style={pad(depth)}
            draggable
            onDragStart={(e) => startDrag(e, folder.path)}
          >
            <button
              type="button"
              aria-expanded={!isFolded}
              className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left"
              onClick={() => setFold(folder.path, !isFolded)}
            >
              <span className="flex w-3 shrink-0 justify-center text-muted">
                <Chevron right={isFolded} />
              </span>
              <span className="shrink-0 text-muted">
                <FolderIcon />
              </span>
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            </button>
            <span className={REVEAL}>
              <IconButton label="새 문서" className={ROW_BUTTON} onClick={() => startCreate(folder.path)}>
                <PlusIcon />
              </IconButton>
            </span>
            <FlagToggle kind="note" direct={direct?.note} effective={own.note} onChange={(note) => setFlag(folder.path, { note })} />
            <FlagToggle kind="locked" direct={direct?.locked} effective={own.locked} onChange={(locked) => setFlag(folder.path, { locked })} />
            <RowMenu>
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      startCreate(folder.path, "doc");
                    }}
                  >
                    새 문서
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      startCreate(folder.path, "folder");
                    }}
                  >
                    새 폴더
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      close();
                      setRenaming(folder.path);
                    }}
                  >
                    이름 바꾸기
                  </MenuItem>
                  <MenuLine />
                  <ConfirmItem
                    onConfirm={() => {
                      close();
                      remove(folder.path);
                    }}
                  />
                </>
              )}
            </RowMenu>
          </div>
        )}
        {!isFolded && renderInside(folder, depth + 1, own)}
      </div>
    );
  };

  const renderInside = (folder: Folder, depth: number, above: Inherited): ReactNode => (
    <>
      {creating?.folder === folder.path && (
        <div className="flex h-8 items-center gap-1.5 pr-2" style={pad(depth)}>
          <span className="w-3 shrink-0" />
          <span className="shrink-0 text-muted">{creating.kind === "folder" ? <FolderIcon /> : <DocIcon />}</span>
          <InlineInput
            // 문서를 만들다 폴더로 바꿔도 칸이 새로 그려지게 한다.
            key={creating.kind}
            initial=""
            label={creating.kind === "folder" ? "새 폴더" : "새 문서"}
            placeholder={creating.kind === "folder" ? "폴더 이름" : folder.path === ROOT ? "폴더/이름" : "이름"}
            className="flex-1"
            onCancel={() => setCreating(null)}
            onCommit={(typed) => void create(folder.path, typed, creating.kind)}
          />
        </div>
      )}
      {folder.folders.map((f) => renderFolder(f, depth, above))}
      {folder.docs.map((m) => renderDoc(m, depth))}
    </>
  );

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 pr-2 pl-4">
        {uploading && <Spinner />}
        <span className="flex-1" />
        <Popover
          align="right"
          className="!min-w-40"
          trigger={(open, toggle) => (
            <IconButton label="추가" aria-haspopup="menu" aria-expanded={open} active={open} onClick={toggle}>
              <PlusIcon />
            </IconButton>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  close();
                  startCreate(ROOT, "doc");
                }}
              >
                새 문서
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  startCreate(ROOT, "folder");
                }}
              >
                새 폴더
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  picker.current?.click();
                }}
              >
                파일 올리기
              </MenuItem>
              <DeletedItems zone="자료" title="삭제한 문서" close={close} />
            </>
          )}
        </Popover>
        <input
          ref={picker}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = ""; // 같은 파일을 다시 골라도 change가 오게
            void upload(files, ROOT);
          }}
        />
      </div>

      <div
        className={`min-h-0 flex-1 overflow-y-auto border-t border-hair px-1 pt-1 pb-3 ${dropTo === ROOT ? "bg-blue-tint" : ""}`}
        onDragOver={over(ROOT)}
        onDrop={dropOn(ROOT)}
        onDragEnd={endDrag}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTo(null);
        }}
      >
        {renderInside(tree, 0, { locked: flags[ROOT]?.locked ?? false, note: flags[ROOT]?.note ?? false })}
      </div>
    </>
  );
}
