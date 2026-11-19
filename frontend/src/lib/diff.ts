/** 두 글을 견준다. 제안을 '지운 글 / 새 글'로 보여줄 때 쓴다. */
export type DiffPart = { kind: "same" | "del" | "add"; text: string };

/** 조각의 나열 둘을 견준다 (가장 긴 공통 부분열). */
function diffSeq(a: string[], b: string[]): DiffPart[] {
  // 글이 아주 길면 표가 너무 커지므로 앞뒤 같은 부분을 먼저 걷어낸다.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffPart[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) {
    // 견주기엔 너무 크다. 통째로 바뀐 것으로 보여준다.
    midA.forEach((text) => out.push({ kind: "del", text }));
    midB.forEach((text) => out.push({ kind: "add", text }));
  } else {
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: midA[i++] });
      else out.push({ kind: "add", text: midB[j++] });
    }
    while (i < n) out.push({ kind: "del", text: midA[i++] });
    while (j < m) out.push({ kind: "add", text: midB[j++] });
  }
  a.slice(a.length - tail).forEach((text) => out.push({ kind: "same", text }));
  return out;
}

/** 문단(줄) 단위로. */
export function diffLines(before: string, after: string): DiffPart[] {
  return diffSeq(before.split("\n"), after.split("\n"));
}

/** 낱말 단위로. 고친 문단 안에서 정확히 어디가 바뀌었는지 보여줄 때 쓴다. 이어진 같은 종류는 하나로 합친다. */
export function diffWords(before: string, after: string): DiffPart[] {
  const words = (text: string) => text.split(/(\s+)/).filter(Boolean);
  const out: DiffPart[] = [];
  for (const part of diffSeq(words(before), words(after))) {
    const last = out[out.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/** 그대로인 문단 하나, 또는 바뀐 대목(지운 문단들과 새 문단들) 하나. */
export type DiffBlock = { kind: "same"; text: string } | { kind: "change"; before: string[]; after: string[] };

/** 문단 단위로 견준 뒤, 붙어 있는 지움과 더함을 '바뀐 대목' 하나로 묶는다. */
export function diffBlocks(before: string, after: string): DiffBlock[] {
  const out: DiffBlock[] = [];
  for (const part of diffLines(before, after)) {
    if (part.kind === "same") {
      out.push({ kind: "same", text: part.text });
      continue;
    }
    let last = out[out.length - 1];
    if (!last || last.kind !== "change") {
      last = { kind: "change", before: [], after: [] };
      out.push(last);
    }
    (part.kind === "del" ? last.before : last.after).push(part.text);
  }
  return out;
}
