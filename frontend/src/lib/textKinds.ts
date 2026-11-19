/*
 * 글의 종류를 알아본다: 굵게(`**…**`), 기울임(`*…*`, `_…_`), 큰따옴표 안, 작은따옴표 안,
 * 그리고 제목 줄(`# …`, `## …`, `### …`).
 * 폰트 설정이 종류마다 모양을 달리 그릴 때 쓴다. 글자는 건드리지 않고 "어디부터 어디까지가 무엇인지"만 돌려준다.
 * 원고 편집기(editor/kinds.ts)와 읽는 글(components/KindText.tsx)이 같이 쓴다.
 *
 * 한 줄(문단) 안에서 짝이 맞는 것만 친다. 닫히지 않은 따옴표가 다음 문단까지 물들이지 않는다.
 */

const BOLD = 1;
const ITALIC = 2;
const DQUOTE = 4;
const SQUOTE = 8;
const QUOTE = DQUOTE | SQUOTE;

/** 조각에 붙는 클래스. 겹치면 여럿이 붙는다 (`tk-dq tk-b`). 모양은 lib/appearance.ts가 만드는 CSS에 있다. */
const CLASS: string[] = Array.from({ length: 16 }, (_, bits) =>
  [bits & DQUOTE ? "tk-dq" : "", bits & SQUOTE ? "tk-sq" : "", bits & ITALIC ? "tk-i" : "", bits & BOLD ? "tk-b" : ""].filter(Boolean).join(" "),
);

/** 본문에 글로 적은 제목 줄인가 (`#` 하나에서 셋, 그 뒤에 빈칸과 글). 제목 폰트가 걸리는 자리다. */
export const isHeading = (line: string) => /^#{1,3}[ \t]+\S/.test(line);
/** 제목 줄에 붙는 클래스. */
export const HEADING_CLASS = "tk-h";

export interface Segment {
  from: number;
  to: number;
  cls: string;
}

const NONE: Segment[] = [];
const ANY_MARK = /[*_"'“”‘’]/;
/** 지운 표시 자리에 넣는 글자. 뒤따르는 규칙이 같은 표시를 다시 잡지 않게 한다. */
const USED = "\u0000";

/*
 * 굵게: `**` 사이. 안쪽의 첫 글자와 끝 글자는 빈칸이 아니어야 한다 (`2 ** 3 ** 4` 같은 것을 피한다).
 * 기울임(*): 다른 `*`에 붙어 있지 않은 `*` 사이.
 * 기울임(_): 낱말 가운데의 `_`는 아니다(snake_case_name). 다만 닫는 `_` 뒤에 한글이 바로 붙는 것은 받는다 —
 *            `_정말_로`처럼 조사가 붙는 것이 한국어에서는 보통이다.
 */
const BOLD_RE = /\*\*(?=[^\s*])(?:[^*]|\*(?!\*))+?(?<=[^\s*])\*\*/g;
const STAR_RE = /(?<![*\\])\*(?=[^\s*])[^*]*?(?<=[^\s*])\*(?!\*)/g;
const UNDER_RE = /(?<![\p{L}\p{N}_\\])_(?=[^\s_])[^_]*?(?<=[^\s_])_(?![A-Za-z0-9_])/gu;

function emphasis(text: string, bits: Uint8Array): void {
  let rest = text;
  const take = (re: RegExp, bit: number, mark: number) => {
    rest = rest.replace(re, (found: string, at: number) => {
      for (let i = at; i < at + found.length; i++) bits[i] |= bit;
      return USED.repeat(mark) + found.slice(mark, found.length - mark) + USED.repeat(mark);
    });
  };
  if (text.includes("**")) take(BOLD_RE, BOLD, 2);
  if (text.includes("*")) take(STAR_RE, ITALIC, 1);
  if (text.includes("_")) take(UNDER_RE, ITALIC, 1);
}

/** 영어 낱말을 이루는 글자인가. 이런 글자 사이에 낀 `'`는 따옴표가 아니라 아포스트로피다 (don't, it's). */
const isLatin = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9À-ɏ]/.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

function quotes(text: string, bits: Uint8Array): void {
  const found: [number, number, number][] = [];
  let straightDouble = -1; // 열려 있는 `"`의 자리
  let curlyDouble = -1; // “
  let straightSingle = -1; // '
  let curlySingle = -1; // ‘
  // 곧은 큰따옴표는 여는 것과 닫는 것이 같은 글자다. 줄 안의 개수가 짝수면 차례대로 짝짓는다.
  // 홀수면 하나가 남는 것이다 (앞 문단에서 열려 여기서 닫히는 따옴표 등). 그때는 생김새를 본다:
  // 닫는 것은 앞에 글자가 붙어 있고, 여는 것은 뒤에 글자가 붙어 있다.
  const strict = (text.split('"').length - 1) % 2 === 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (straightDouble >= 0 && (!strict || !isSpace(text[i - 1]))) {
        found.push([straightDouble, i + 1, DQUOTE]);
        straightDouble = -1;
      } else if (!strict || !isSpace(text[i + 1])) straightDouble = i;
    } else if (ch === "“") curlyDouble = i;
    else if (ch === "”") {
      if (curlyDouble >= 0) found.push([curlyDouble, i + 1, DQUOTE]);
      curlyDouble = -1;
    } else if (ch === "‘") curlySingle = i;
    else if (ch === "’") {
      // 굽은 것도 아포스트로피로 쓰인다 (don’t).
      if (isLatin(text[i - 1]) && isLatin(text[i + 1])) continue;
      if (curlySingle >= 0) found.push([curlySingle, i + 1, SQUOTE]);
      curlySingle = -1;
    } else if (ch === "'") {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (isLatin(prev) && isLatin(next)) continue; // don't, it's
      if (/^\d\ds(?![A-Za-z0-9])/.test(text.slice(i + 1, i + 5))) continue; // '90s
      // 닫는 것: 앞에 글자가 붙어 있고, 뒤가 영어 낱말로 이어지지 않는다. 한글은 뒤에 붙어도 된다 ('설마'라고).
      // 여는 것: 뒤에 글자가 붙어 있고, 앞이 영어 낱말이 아니다 (dogs' 는 여는 것이 아니다).
      if (straightSingle >= 0 && !isSpace(prev) && !isLatin(next)) {
        found.push([straightSingle, i + 1, SQUOTE]);
        straightSingle = -1;
      } else if (!isSpace(next) && !isLatin(prev)) straightSingle = i; // 닫히지 않은 채 또 열리면 뒤의 것부터 다시 센다
    }
  }
  if (!found.length) return;
  // 바깥 것부터 칠하고 안쪽 것으로 덮는다. 큰따옴표 안의 작은따옴표는 작은따옴표로 보인다.
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  for (const [from, to, bit] of found) for (let i = from; i < to; i++) bits[i] = (bits[i] & ~QUOTE) | bit;
}

/** 한 줄에서 꾸밀 조각들 (보통 글은 빠진다). 표시 글자(`**`, 따옴표)도 조각에 들어간다. */
export function segmentLine(text: string): Segment[] {
  if (!ANY_MARK.test(text)) return NONE;
  const bits = new Uint8Array(text.length);
  emphasis(text, bits);
  quotes(text, bits);
  const out: Segment[] = [];
  let from = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && bits[i] === bits[from]) continue;
    if (bits[from]) out.push({ from, to: i, cls: CLASS[bits[from]] });
    from = i;
  }
  return out;
}

export interface Piece {
  text: string;
  cls: string; // 빈 글이면 보통 글
}

/** 여러 줄의 글을 조각으로 나눈다. 조각을 이어 붙이면 원래 글과 글자 하나까지 같다. */
export function splitKinds(text: string): Piece[] {
  const out: Piece[] = [];
  let plain = "";
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const heading = isHeading(line);
    // 제목 줄은 줄 전체가 조각이다. 그 안의 따옴표 등은 클래스를 겹쳐 붙인다.
    const base = heading ? HEADING_CLASS : "";
    if (heading && plain) {
      out.push({ text: plain, cls: "" });
      plain = "";
    }
    let at = 0;
    for (const s of segmentLine(line)) {
      plain += line.slice(at, s.from);
      if (plain) out.push({ text: plain, cls: base });
      plain = "";
      out.push({ text: line.slice(s.from, s.to), cls: heading ? `${base} ${s.cls}` : s.cls });
      at = s.to;
    }
    plain += line.slice(at);
    if (heading && plain) {
      out.push({ text: plain, cls: base });
      plain = "";
    }
    if (lineEnd < text.length) plain += "\n";
    lineStart = lineEnd + 1;
  }
  if (plain) out.push({ text: plain, cls: "" });
  return out;
}
