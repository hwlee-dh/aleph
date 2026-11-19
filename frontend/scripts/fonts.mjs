/*
 * 묶음에 넣는 폰트의 CSS와 라이선스 글을 만든다.  `npm run fonts` (빌드할 때도 돈다)
 *
 *   src/fonts/base.css           처음부터 싣는 것 (Noto Sans KR, Noto Serif KR, IBM Plex Mono)
 *   src/fonts/<이름>.css          설정에서 골랐을 때만 불러오는 것 (고운바탕, Pretendard)
 *   public/licenses/<이름>.txt    폰트마다의 저작권 표시와 라이선스 글 (OFL은 폰트를 나눠 줄 때 같이 넣으라고 한다)
 *
 * 왜 패키지의 CSS를 그대로 쓰지 않나: fontsource의 CSS는 woff2와 woff를 같이 가리켜서, 그대로 import하면
 * 쓰이지도 않는 woff까지 묶음에 들어가 크기가 두 배가 된다. 여기서는 woff2만 가리키는 @font-face를 새로 쓴다.
 * 한글 폰트는 굵기 하나가 120여 조각으로 나뉘어 있고 조각마다 unicode-range가 붙어 있다. 그 구조는 그대로 둔다
 * (브라우저가 화면에 나온 글자의 조각만 받는다).
 *
 * 만든 CSS는 저장소에 넣어 둔다. 그래야 `npm run dev`가 이 스크립트 없이도 돈다.
 * 폰트 파일은 node_modules에 있는 것을 Vite가 묶음으로 옮긴다 (CSS의 url이 그 자리를 가리킨다).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "node_modules");
/** 만든 CSS에서 node_modules까지의 길 (src/fonts/ 기준). */
const UP = "../../node_modules";

/** 넣는 폰트. 전부 SIL Open Font License 1.1이고, 패키지에 저작권 표시가 든 라이선스 글이 있다. */
const SHEETS = [
  {
    out: "base",
    fonts: [
      // 시스템: 보통, 굵게(font-bold), 가장 굵게(font-black — 제목과 로고). 가운데 굵기(500)는 화면에서 쓰는 곳이 없어 싣지 않는다.
      { fontsource: "noto-sans-kr", weights: [400, 700, 900] },
      // 본문: 보통과 굵게
      { fontsource: "noto-serif-kr", weights: [400, 700] },
      // 코드
      { fontsource: "ibm-plex-mono", weights: [400] },
    ],
  },
  { out: "gowun-batang", fonts: [{ fontsource: "gowun-batang", weights: [400, 700] }] },
  {
    out: "pretendard",
    fonts: [
      {
        // 조각으로 나뉜 판(dynamic-subset)보다 통짜 파일이 작다.
        family: "Pretendard",
        dir: "pretendard/dist/web/static/woff2",
        faces: [
          [400, "Pretendard-Regular.woff2"],
          [700, "Pretendard-Bold.woff2"],
        ],
        license: "pretendard/dist/LICENSE.txt",
        name: "pretendard",
      },
    ],
  },
];

const face = (family, weight, url, range) =>
  [
    "@font-face {",
    `  font-family: "${family}";`,
    "  font-style: normal;",
    `  font-weight: ${weight};`,
    // 폰트가 오기 전에는 대체 폰트로 먼저 그린다 (구글 폰트를 쓸 때와 같다).
    "  font-display: swap;",
    `  src: url("${url}") format("woff2");`,
    ...(range ? [`  unicode-range: ${range};`] : []),
    "}",
  ].join("\n");

/** fontsource 패키지의 굵기별 CSS에서 조각마다의 woff2 파일과 unicode-range를 읽어 온다. */
function fromFontsource(pkg, weight) {
  const dir = `@fontsource/${pkg}`;
  const css = readFileSync(join(modules, dir, `${weight}.css`), "utf8");
  const faces = [];
  for (const [, body] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const family = /font-family:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const file = /url\(\.\/(files\/[^)]+\.woff2)\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (!family || !file) throw new Error(`${dir}/${weight}.css: 읽을 수 없는 @font-face가 있다`);
    if (!existsSync(join(modules, dir, file))) throw new Error(`${dir}/${file}: 파일이 없다`);
    faces.push(face(family, weight, `${UP}/${dir}/${file}`, range));
  }
  if (!faces.length) throw new Error(`${dir}/${weight}.css: @font-face가 없다`);
  return faces;
}

function fromFiles(font) {
  return font.faces.map(([weight, file]) => {
    if (!existsSync(join(modules, font.dir, file))) throw new Error(`${font.dir}/${file}: 파일이 없다`);
    return face(font.family, weight, `${UP}/${font.dir}/${file}`);
  });
}

/** 내용이 같으면 다시 쓰지 않는다 (개발 서버가 쓸데없이 새로 고치지 않게). */
function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeFileSync(path, content, "utf8");
  return true;
}

let changed = 0;
for (const sheet of SHEETS) {
  const blocks = [];
  for (const font of sheet.fonts) {
    const name = font.fontsource ?? font.name;
    const license = font.fontsource ? `@fontsource/${font.fontsource}/LICENSE` : font.license;
    const text = readFileSync(join(modules, license), "utf8").replace(/\r\n?/g, "\n");
    // 라이선스 글이 OFL이 아니면 넣지 않는다 (패키지가 바뀌었을 때 모르고 지나가지 않게).
    if (!/SIL Open Font License, Version 1\.1/i.test(text)) throw new Error(`${license}: OFL 1.1이 아니다`);
    if (write(join(root, "public", "licenses", `${name}.txt`), text)) changed++;
    blocks.push(...(font.fontsource ? font.weights.flatMap((w) => fromFontsource(font.fontsource, w)) : fromFiles(font)));
  }
  const head = "/* scripts/fonts.mjs가 만든 파일. 손으로 고치지 않는다 (`npm run fonts`). */\n";
  if (write(join(root, "src", "fonts", `${sheet.out}.css`), `${head}${blocks.join("\n")}\n`)) changed++;
  console.log(`${sheet.out}.css: @font-face ${blocks.length}개`);
}
console.log(changed ? `${changed}개 파일을 새로 썼다` : "바뀐 것 없음");
