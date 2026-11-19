import { useMemo } from "react";
import { useAppearance } from "../lib/appearance";
import { splitKinds } from "../lib/textKinds";

/**
 * 읽기만 하는 본문(출력, 버전 기록, 비교 결과, 쓰이는 중인 글)을 글의 종류별로 꾸며 그린다.
 * 편집기(editor/kinds.ts)와 같은 규칙으로 글을 조각내 <span>으로 감싼다. 글자는 그대로다.
 * 감싸는 쪽은 줄 바꿈을 살리는 모양(`whitespace-pre-wrap`)이어야 하고, '보통' 글의 모양을 받으려면 `tk-text`를 붙인다.
 */
export function KindText({ text }: { text: string }) {
  // 꾸미는 종류가 없으면(기본값) 조각내지 않는다.
  const active = useAppearance((s) => s.kindsActive);
  const pieces = useMemo(() => (active ? splitKinds(text) : null), [active, text]);
  if (!pieces) return <>{text}</>;
  return (
    <>
      {pieces.map((p, i) =>
        p.cls ? (
          <span key={i} className={p.cls}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}
