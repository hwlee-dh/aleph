import type { ReactNode } from "react";

/* 16px 선 아이콘. 색은 글자색을 따른다. */
function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function Chevron({ up = false, right = false }: { up?: boolean; right?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={right ? "M6 4l4 4-4 4" : up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
    </svg>
  );
}
export const CloseIcon = () => (
  <Svg size={14}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Svg>
);
export const PlusIcon = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const SendIcon = () => (
  <Svg>
    <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
  </Svg>
);
export const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
  </svg>
);
export const LockIcon = ({ open = false }: { open?: boolean }) => (
  <Svg>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d={open ? "M5.5 7V5a2.5 2.5 0 0 1 4.8-1" : "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"} />
  </Svg>
);
/** 노트(에이전트가 항상 읽는 자료) */
export const NoteIcon = () => (
  <Svg>
    <path d="M4.5 2.5h7v11L8 11l-3.5 2.5z" />
  </Svg>
);
export const FolderIcon = () => (
  <Svg>
    <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
  </Svg>
);
export const DocIcon = () => (
  <Svg>
    <path d="M4 2h5.5L12 4.5V14H4z" />
    <path d="M6 7h4M6 9.5h4" />
  </Svg>
);
export const ImageIcon = () => (
  <Svg>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M2.5 11l3-3 2.5 2.5 2-2 3.5 3.5" />
  </Svg>
);
export const GearIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
  </Svg>
);
export const PanelLeftIcon = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6 3v10" />
  </Svg>
);
export const PanelRightIcon = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M10 3v10" />
  </Svg>
);
export const MoreIcon = () => (
  <Svg>
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Svg>
);
export const TrashIcon = () => (
  <Svg>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" />
  </Svg>
);
/** 이름 바꾸기 (연필) */
export const PencilIcon = () => (
  <Svg>
    <path d="M3 13l.6-2.9 7.3-7.3 2.3 2.3-7.3 7.3z" />
    <path d="M9.6 4.1l2.3 2.3" />
  </Svg>
);
export const HistoryIcon = () => (
  <Svg>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 2.5v2.8h2.8" />
    <path d="M8 5v3.2l2 1.3" />
  </Svg>
);
export const ExpandIcon = () => (
  <Svg>
    <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />
  </Svg>
);
export const UploadIcon = () => (
  <Svg>
    <path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v3h11v-3" />
  </Svg>
);
export const ToolIcon = () => (
  <Svg>
    <path d="M9.5 2.5a3 3 0 0 0-2.7 4.2L2.5 11v2.5H5l4.3-4.3A3 3 0 0 0 13.5 6.5L11.5 8.5l-2-2 2-2a3 3 0 0 0-2-.5z" />
  </Svg>
);
export const QuoteIcon = () => (
  <Svg>
    <path d="M3 9.5V7a3 3 0 0 1 3-3M3 9.5h3v3H3zM9 9.5V7a3 3 0 0 1 3-3M9 9.5h3v3H9z" />
  </Svg>
);
export const GripIcon = () => (
  <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" fill="currentColor">
    <circle cx="3" cy="3" r="1.1" />
    <circle cx="7" cy="3" r="1.1" />
    <circle cx="3" cy="7" r="1.1" />
    <circle cx="7" cy="7" r="1.1" />
    <circle cx="3" cy="11" r="1.1" />
    <circle cx="7" cy="11" r="1.1" />
  </svg>
);
export const ArrowDownIcon = () => (
  <Svg size={14}>
    <path d="M8 2.5v11M4 9.5l4 4 4-4" />
  </Svg>
);
export const SearchIcon = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2l3.3 3.3" />
  </Svg>
);
/** 글을 뽑지 못해 파일 그대로 들어온 자료 (PDF 등) */
export const ClipIcon = () => (
  <Svg>
    <path d="M13 7.5l-5 5a3 3 0 0 1-4.2-4.2l5.5-5.5a2 2 0 0 1 2.8 2.8L6.7 11a1 1 0 0 1-1.4-1.4L10 5" />
  </Svg>
);
/** 메인 화면의 바깥 링크: GitHub 표식 (선이 아니라 채운 그림이다) */
export const GitHubIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
export const MailIcon = () => (
  <Svg>
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="M2.5 5l5.5 4 5.5-4" />
  </Svg>
);
/** 새 대화 (말풍선에 더하기) */
export const NewChatIcon = () => (
  <Svg>
    <path d="M2.5 3h11v8H7.5l-3 2.5V11h-2z" />
    <path d="M8 5.2v3.6M6.2 7h3.6" />
  </Svg>
);
