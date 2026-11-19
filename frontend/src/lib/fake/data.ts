/* 가짜 API가 쓰는 고정 값: 대본에 나오는 글, 기본 제공 프리셋, 설정 화면에 보일 목록. */
import { SUMMARY_TOOL, type Meta, type ModelEntry, type Preset, type Provider, type ProviderKind, type ToolDef } from "../types";

/* ───────── 대본에 쓰는 글 ───────── */

export const BRIEF =
  "제목: 겨울 정류장\n주인공: 서윤\n장소: 종점 정류장\n분량: 장면 하나에 600자 안팎\n\n막차가 끊긴 밤, 주인공이 정류장에서 오지 않는 버스를 기다린다.\n기다리는 동안 십 년 전 같은 자리에서 헤어진 사람을 떠올린다.\n감정을 직접 말하지 않고 사물과 날씨로만 드러낼 것.";

export const CHARACTER =
  "# 서윤\n\n- 서른넷. 시청 민원실에서 일한다.\n- 말수가 적고, 손에 든 것을 자주 고쳐 쥔다.\n- 십 년 전 겨울, 종점 정류장에서 한 사람을 먼저 보냈다. 그 뒤로 이 동네에 오지 않았다.\n- 추위를 잘 타지만 자리를 먼저 뜨는 법이 없다.";

export const PLACE =
  "# 종점 정류장\n\n- 시 외곽, 노선 세 개가 끝나는 곳. 막차는 열한 시 사십 분.\n- 유리벽 세 면과 지붕, 의자 하나. 시간표는 아크릴판 아래에 있다.\n- 길 건너에 철물점과 편의점. 가로등 하나는 오래전부터 깜박인다.\n- 십 년 전과 달라진 것: 노선 하나가 없어졌다. 의자는 그대로다.";

export const PLAN =
  "# 계획\n\n- [x] 1장 막차: 정류장에 앉기까지, 귤\n- [x] 2장 첫차, 장면 1: 눈이 그치고 첫차가 지나간다\n- [ ] 2장 장면 2: 버스가 지나간 뒤. 걷기 시작한다\n- [ ] 마지막 장면은 대사 없이 끝낸다";

export const IMAGE_LINE = "![정류장](자료/삽화/정류장.svg)";

/** 씨앗 원고의 장면들. {N은}·{P} 같은 자리는 주인공 이름과 장소로 채운다. */
export const SEED_SCENES = [
  "막차는 열한 시 사십 분에 끊겼다. {N은} 그걸 알면서도 {P}의 의자에 앉아 있었다. 시간표를 덮은 아크릴판에 성에가 끼어 숫자가 반쯤 지워져 있었다.\n\n가로등 하나가 깜박였다. 불이 들어올 때마다 길 건너 닫힌 철물점 셔터가 보였다가 사라졌다. {N은} 장갑 낀 손으로 무릎 위 종이봉투를 고쳐 쥐었다. 봉투 안에서 귤 두 개가 서로 부딪혔다.\n\n십 년 전에도 이 의자는 차가웠다. 그때는 두 사람이 앉았고, 한 사람이 먼저 일어났다. 버스 문이 닫히는 소리가 지금도 어디선가 나는 것 같았다.\n\n눈이 오기 시작했다. {N은} 일어나지 않았다.",
  "첫차까지는 다섯 시간이 남았다. {N은} 봉투에서 귤 하나를 꺼내 껍질을 벗겼다. 손끝이 얼어서 껍질이 자꾸 끊어졌다.\n\n길 건너 편의점 간판이 꺼졌다. {P} 지붕 위로 눈 쌓이는 소리가 났다. 소리라고 하기에는 너무 작았지만 {N은} 그것을 들었다.\n\n귤은 차가웠고 달지 않았다. 반쪽을 먹고 나머지 반쪽은 옆자리에 올려 두었다. 옆자리에는 아무도 없었다.\n\n멀리서 제설차가 지나갔다. 노란 불빛이 유리벽을 한 번 훑고 갔다.",
  "새벽 네 시에 눈이 그쳤다. {N은} 의자에서 일어나 발자국 하나 없는 길을 내려다보았다.\n\n옆자리의 귤 반쪽은 얼어 있었다. {N은} 그것을 종이봉투에 도로 넣고 봉투 입구를 두 번 접었다.\n\n{P}의 불이 꺼지고, 길 끝에서 첫차의 전조등이 올라왔다. {N은} 손을 들지 않았다. 버스는 속도를 줄였다가 그대로 지나갔다.",
];

/** `집필` 도구가 돌 때마다 차례로 내는 글. */
export const COMPOSE_POOL = [
  "버스가 지나간 자리에 바퀴 자국 두 줄이 남았다. {N은} 그 줄이 길 끝에서 하나로 모이는 것을 끝까지 보았다.\n\n{P}의 유리벽에 붙은 노선도는 십 년 전 것 그대로였다. 없어진 정거장 이름 위에 누군가 볼펜으로 줄을 그어 놓았다. {N은} 장갑을 벗고 그 줄을 손톱으로 긁어 보았다. 잉크는 지워지지 않았다.\n\n종이봉투는 아까보다 가벼웠다. {N은} 봉투를 의자 위에 내려놓고, 내려놓은 자리를 한 번 돌아본 다음 걷기 시작했다.\n\n눈 위에 발자국이 한 줄 생겼다.",
  "철물점 셔터가 반쯤 올라갔다. 안에서 난로에 불 붙이는 소리가 났다. {N은} 길 건너에서 그 소리를 들으며 신발 끈을 다시 묶었다.\n\n주인은 {N을} 알아보지 못했다. 빗자루로 가게 앞 눈을 쓸다가 {P} 쪽을 한 번 보고, 다시 눈을 쓸었다. 빗자루가 지나간 자리마다 젖은 아스팔트가 드러났다.\n\n{N은} 주머니에서 귤 하나를 꺼냈다. 남은 하나였다. 껍질에 손톱자국만 내고 도로 넣었다.\n\n해가 건물 사이로 올라오고 있었다. 가로등은 아직 꺼지지 않았다.",
  "다음 정거장까지는 걸어서 이십 분이었다. {N은} 그 길을 십 년 전에는 뛰어서 갔다. 버스가 신호에 걸리면 따라잡을 수 있을 것 같았기 때문이다.\n\n지금은 뛰지 않았다. 인도와 차도의 경계가 눈에 덮여 보이지 않았다. {N은} 가로수를 하나씩 세며 걸었다. 열두 번째 나무에서 숫자를 잊어버렸다.\n\n뒤에서 버스 한 대가 다가와 속도를 줄였다. 문이 열렸다. 기사는 아무 말도 하지 않고 기다렸다.\n\n{N은} 계단에 한 발을 올렸다. {P} 쪽은 돌아보지 않았다.",
  "{P}에는 불이 하나만 켜져 있었다. {N은} 그 불 아래 서서 오지 않을 버스의 번호를 올려다보았다. 막차는 이미 지나간 뒤였다.\n\n바람이 시간표 모서리를 들췄다 놓았다. 테이프가 떨어진 자리마다 종이가 누렇게 말려 있었다. {N은} 주머니에서 손을 꺼내 그 모서리를 눌러 주었다. 손을 떼자 종이는 다시 일어섰다.\n\n십 년 전 겨울에도 누군가 여기서 같은 종이를 눌렀다. 그 손은 {N}의 손보다 컸고, 장갑을 끼지 않았다.\n\n첫눈이 가로등 불빛 안으로만 내렸다.",
];

/** `이어 쓰기` 도구가 차례로 내는 글. */
export const CONTINUE_POOL = [
  "현관 앞에 서서야 열쇠를 바꿨다던 말이 생각났다. 초인종을 누르자 안에서 슬리퍼 끄는 소리가 났다. 소리는 문 앞까지 왔다가 한참 멈춰 있었다.\n\n문이 열렸을 때 어머니는 나를 보지 않고 내 가방을 먼저 보았다. 가방이 작다는 것을, 그러니까 오래 있지 않을 것이라는 것을 확인하는 눈이었다.\n\n\"밥은.\" 어머니가 말했다. 묻는 말이 아니었다.",
  "식탁에는 수저가 두 벌 놓여 있었다. 한 벌은 내가 쓰던 것이었고 손잡이의 칠이 벗겨진 자리까지 그대로였다.\n\n어머니는 국을 뜨면서 역에서 집까지 무엇을 타고 왔느냐고 물었다. 걸어왔다고 하자 국자가 냄비 가장자리에 한 번 부딪혔다.\n\n창밖으로 내가 걸어온 길이 보였다. 가로등은 아직 켜지지 않았다.",
  "설거지는 내가 하겠다고 했다. 어머니는 대답 대신 고무장갑을 싱크대 위에 올려놓았다. 장갑은 내 손에 조금 작았다.\n\n수도꼭지에서는 더운물이 한참 뒤에야 나왔다. 보일러 소리가 벽을 타고 올라갔다. 그 소리를 듣고 있으니 이 집의 겨울이 어땠는지가 손끝부터 돌아왔다.\n\n마지막 그릇을 엎어 놓았을 때 방 불이 꺼지는 소리가 났다. 어머니는 내 방 불만 켜 두었다.",
];

/** `비평` 도구가 차례로 내는 글. {doc}은 살펴본 대상이다. */
export const CRITIQUE_POOL = [
  "대상: {doc}\n\n1. 감정을 사물로만 드러내라는 조건은 지켜졌다. 종이봉투와 귤이 그 일을 한다.\n2. 셋째 문단의 회상이 설명에 가깝다. \"한 사람이 먼저 일어났다\"까지만 두고 뒤 문장은 빼도 된다.\n3. 마지막 문장은 좋다. 다만 바로 앞 문장과 길이가 같아서 끝맺는 힘이 약하다.\n\n고칠 순서: 2 → 3",
  "대상: {doc}\n\n1. 첫 문단이 시간과 장소를 한꺼번에 알려 준다. 둘 중 하나는 둘째 문단으로 미뤄도 된다.\n2. 날씨 묘사가 문단마다 한 번씩 나온다. 한 곳은 덜어내는 편이 낫다.\n3. 인물이 하는 행동이 \"보았다\"에 몰려 있다. 손이 하는 일을 하나 더 넣을 것.\n\n고칠 순서: 3 → 1",
];

/** 에이전트가 장면의 한 문단을 고칠 때 끝 문장 자리에 넣는 글. */
export const REWRITES = [
  "말하려던 것은 입김이 되어 흩어졌다. 남은 것은 손에 쥔 봉투의 무게뿐이었다.",
  "그 자리는 여전히 차가웠고, 차갑다는 사실만이 십 년을 건너 그대로였다.",
  "불빛이 한 번 꺼졌다 켜지는 사이에, 길 건너의 셔터는 조금 더 낡아 있었다.",
];

/** 둘째 작업에 올려 둔 통짜 글. 아직 장면으로 나누지 않았다. */
export const UPLOADED_TEXT =
  "기차는 예정보다 이십 분 늦게 도착했다. 역 앞 광장은 내가 떠나던 날보다 좁아 보였다. 분수는 물이 빠져 있었고 바닥에 동전 대신 낙엽이 깔려 있었다.\n\n택시 승강장에는 차가 한 대도 없었다. 나는 가방을 왼손으로 옮겨 들고 걷기로 했다. 집까지는 사십 분이 걸린다. 열일곱 살 때는 삼십 분이면 갔다.\n\n시장 골목을 지날 때 생선 가게 아주머니가 나를 한참 쳐다보았다. 알아본 것인지 낯선 사람이라 본 것인지는 알 수 없었다. 나는 인사를 하지 않았다.\n\n다리를 건너자 우리 집 지붕이 보였다. 기와는 파란색에서 회색이 되어 있었다.\n\n다리 난간의 페인트는 손이 닿는 높이만 벗겨져 있었다. 나는 그 자리에 손을 얹지 않고 건넜다. 물은 내가 기억하는 것보다 얕았고, 바닥의 돌이 하나하나 보였다.\n\n골목 입구의 구멍가게는 미용실이 되어 있었다. 유리문에 붙은 가격표는 햇빛에 바래 숫자만 남았다. 안에서 드라이어 소리가 났다가 그쳤다.\n\n세 번째 전봇대를 지나면 우리 집 담이 시작된다. 담 위로 감나무 가지가 넘어와 있었다. 감은 다 떨어지고 꼭지만 몇 개 붙어 있었다.\n\n대문은 잠겨 있지 않았다. 손잡이를 잡았을 때 쇠가 생각보다 따뜻했다. 누군가 조금 전에 잡았던 것처럼.\n\n마당에는 빨래가 널려 있었다. 수건 두 장과 양말 한 켤레. 나는 그것이 한 사람 몫이라는 것을 세어 보고서야 알았다.\n\n가방을 내려놓지 않은 채로 한참 서 있었다. 집 안에서는 라디오 소리가 났다. 내가 떠나던 날 아침에도 같은 주파수였다.";

/** 삽화 예시. 작은 SVG를 직접 그려 data URL로 둔다. */
export const BUS_STOP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270" width="480" height="270">' +
  '<rect width="480" height="270" fill="#1b2433"/>' +
  '<rect y="212" width="480" height="58" fill="#e6ebf1"/>' +
  '<circle cx="372" cy="58" r="40" fill="#ffd97a" opacity="0.14"/>' +
  '<rect x="370" y="62" width="4" height="150" fill="#5b6b82"/>' +
  '<circle cx="372" cy="58" r="9" fill="#ffd97a"/>' +
  '<rect x="140" y="98" width="196" height="8" rx="2" fill="#6b7c94"/>' +
  '<rect x="150" y="106" width="6" height="106" fill="#6b7c94"/>' +
  '<rect x="320" y="106" width="6" height="106" fill="#6b7c94"/>' +
  '<rect x="156" y="112" width="164" height="78" fill="#33435c" opacity="0.75"/>' +
  '<rect x="170" y="122" width="38" height="50" fill="#dfe6ee" opacity="0.85"/>' +
  '<rect x="200" y="182" width="96" height="7" rx="2" fill="#9aa7b9"/>' +
  '<rect x="208" y="189" width="5" height="23" fill="#9aa7b9"/>' +
  '<rect x="283" y="189" width="5" height="23" fill="#9aa7b9"/>' +
  '<g fill="#ffffff" opacity="0.85">' +
  '<circle cx="60" cy="40" r="2"/><circle cx="118" cy="86" r="1.6"/><circle cx="96" cy="150" r="2"/>' +
  '<circle cx="232" cy="52" r="1.8"/><circle cx="290" cy="30" r="2"/><circle cx="352" cy="128" r="1.6"/>' +
  '<circle cx="420" cy="92" r="2"/><circle cx="440" cy="170" r="1.8"/><circle cx="34" cy="188" r="1.6"/>' +
  '<circle cx="396" cy="186" r="2"/><circle cx="180" cy="70" r="1.5"/>' +
  "</g></svg>";

export const BUS_STOP_URL = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(BUS_STOP_SVG);

/* ───────── 작은 도우미 ───────── */

/** 낱말 끝소리에 맞는 조사를 붙인다. */
export function josa(word: string, withFinal: string, without: string): string {
  const last = word.trim().replace(/[\s'"’”`)\]〉]+$/, "").slice(-1);
  const code = last.charCodeAt(0);
  const hangul = code >= 0xac00 && code <= 0xd7a3;
  const final = hangul ? (code - 0xac00) % 28 !== 0 : /[013678lmnr]/i.test(last);
  return word + (final ? withFinal : without);
}

/** 대본 글의 {N은}·{N이}·{N을}·{N}·{P} 자리를 채운다. */
export function fill(text: string, name: string, place: string): string {
  return text
    .replace(/\{N은\}/g, josa(name, "은", "는"))
    .replace(/\{N이\}/g, josa(name, "이", "가"))
    .replace(/\{N을\}/g, josa(name, "을", "를"))
    .replace(/\{N\}/g, name)
    .replace(/\{P\}/g, place);
}

/* ───────── 기본 제공 프리셋 ───────── */

function tool(name: string, label: string, description: string, prompt: string, extra: Partial<ToolDef> = {}): ToolDef {
  return { name, label, description, prompt, model: "", temperature: null, thinking: "", max_tokens: null, enabled: true, ...extra };
}

/** 요약 도구의 기본 꼴. 기본 프리셋에 들어 있고, 지운 사람이 다시 넣을 때도 이것이 쓰인다 (`meta.summary_tool`). */
const SUMMARY_TOOL_DEF = tool(
  SUMMARY_TOOL,
  "요약",
  "입력에 든 글을 두세 문장으로 요약한다. 장면의 본문을 넣으면 그 장면의 요약이 나온다.",
  "입력에 든 장면을 두세 문장으로 요약한다. 누가 무엇을 하고 무엇이 달라지는지만 적는다. 요약만 출력한다.",
);

/** 프리셋의 모델 자리. 가짜는 화면을 바로 볼 수 있게 처음 상태의 제공자에 있는 모델을 적어 둔다 (엔진의 기본 프리셋은 비운 채 나간다). */
const MODEL_FIELDS = {
  model: "google:gemini-2.5-pro",
  temperature: null,
  thinking: "default",
  max_output_tokens: null,
  context_budget: 150000,
  auxiliary_model: "",
  auxiliary_temperature: null,
  auxiliary_thinking: "default",
  auxiliary_max_output_tokens: null,
  auxiliary_max_input_tokens: null,
  image_model: "",
  start_mode: "",
} satisfies Partial<Preset>;

const CRITIQUE_TOOL = tool(
  "critique",
  "비평",
  "글 하나를 읽고 고칠 곳을 짚는다. 입력에 살펴볼 글을 불러 두고 부른다.",
  "너는 문예지 편집자다. 입력의 글을 읽고 고칠 곳을 번호를 붙여 짚는다.\n\n- 칭찬은 한 줄로 줄이고, 고칠 곳은 어느 문단인지 밝힌다.\n- 고쳐 쓴 문장을 대신 써 주지 않는다.\n- 끝에 고칠 순서를 한 줄로 적는다.",
  { temperature: 0.3 },
);

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "basic",
    name: "기본",
    description: "브리프와 자료를 바탕으로 장면을 쓰고, 살펴보고, 원고에 넣는다.",
    instruction:
      "너는 소설가와 함께 일하는 집필 에이전트다.\n\n- 브리프를 먼저 읽고, 브리프에 없는 설정은 지어내기 전에 묻는다.\n- 글은 도구로 쓴다. 입력에 필요한 자료를 불러 두고 도구를 돌린 뒤, 무엇을 썼는지 한 줄로만 알린다.\n- 출력을 원고에 넣는 일은 반드시 확인을 받는다.\n- 작가가 짚은 대목은 그 대목만 고친다.",
    tools: [
      tool(
        "compose",
        "집필",
        "장면 하나를 쓴다. 입력에 브리프, 인물, 앞 장면, 이번에 쓸 내용을 준비해 두고 부른다.",
        "너는 소설가다. 입력에 있는 브리프와 자료를 따라 장면 하나를 쓴다.\n\n- 분량은 브리프에 적힌 대로.\n- 감정을 직접 말하지 않는다. 사물과 날씨, 손이 하는 일로 드러낸다.\n- 앞 장면이 있으면 그 문체와 시점을 그대로 잇는다.\n- 글만 쓴다. 설명이나 머리말을 붙이지 않는다.",
        { temperature: 0.9 },
      ),
      CRITIQUE_TOOL,
      SUMMARY_TOOL_DEF,
    ],
    ...MODEL_FIELDS,
    starter: {
      "자료/브리프.md": "제목: \n주인공: \n장소: \n분량: 장면 하나에 600자 안팎\n\n(무슨 이야기인지 서너 줄로 적는다.)",
      "자료/계획.md": "# 계획\n\n- [ ] ",
    },
    starter_notes: ["자료/브리프.md", "자료/계획.md"],
    builtin: true,
  },
  {
    id: "continue",
    name: "이어 쓰기",
    description: "쓰던 글을 올려 장면으로 나누고, 같은 문체로 이어 쓴다.",
    instruction:
      "너는 작가가 쓰던 글을 이어 쓰고 고쳐 쓰는 일을 돕는다.\n\n- 올린 글의 문체와 시점을 그대로 따른다.\n- 원고는 자르고 옮기기만 한다. 고쳐 쓰라는 말이 있을 때만 고치고, 반드시 확인을 받는다.\n- 메모에 적힌 고칠 곳을 먼저 확인한다.",
    tools: [
      tool(
        "continue",
        "이어 쓰기",
        "앞 글의 문체를 따라 다음 대목을 쓴다. 입력에 앞 글과 이어질 방향을 준비해 두고 부른다.",
        "입력에 있는 글의 바로 다음 대목을 쓴다.\n\n- 시점, 시제, 문장 길이를 앞 글과 맞춘다.\n- 새 인물이나 설정을 지어내지 않는다.\n- 글만 쓴다.",
        { temperature: 0.8 },
      ),
      CRITIQUE_TOOL,
    ],
    ...MODEL_FIELDS,
    starter: { "자료/메모.md": "# 메모\n\n- 고칠 곳과 이어 쓸 방향을 여기에 적는다." },
    starter_notes: ["자료/메모.md"],
    builtin: true,
  },
];

/* ───────── 앱 정보 ───────── */

/** 에이전트의 기본 도구. 이름은 지금 엔진의 것을 따랐고, `write_input`만 가짜가 따로 두었다. */
export const AGENT_TOOLS: { name: string; label: string }[] = [
  { name: "list", label: "문서 목록" },
  { name: "read", label: "문서 읽기" },
  { name: "search", label: "찾기" },
  { name: "explore", label: "읽기 에이전트" },
  { name: "write", label: "문서 쓰기" },
  { name: "write_input", label: "입력 쓰기" },
  { name: "edit", label: "부분 수정" },
  { name: "delete", label: "문서 지우기" },
  { name: "move", label: "문서 옮기기" },
  { name: "insert_scene", label: "장면 넣기" },
  { name: "split", label: "장면 나누기" },
  { name: "merge_scenes", label: "장면 합치기" },
  { name: "move_scene", label: "순서 바꾸기" },
  { name: "ask_user", label: "질문하기" },
  { name: "set_summary", label: "요약 붙이기" },
  { name: "summarize_scenes", label: "묶음 요약" },
  { name: "generate_image", label: "이미지 만들기" },
];

export function agentToolLabel(name: string): string {
  return AGENT_TOOLS.find((t) => t.name === name)?.label ?? name;
}

function kind(id: string, label: string, group: ProviderKind["group"], extra: Partial<ProviderKind> = {}): ProviderKind {
  return {
    id,
    label,
    group,
    needs_key: true,
    key_optional: false,
    env_key: null,
    default_base_url: null,
    base_url_editable: false,
    tested: true,
    note: "",
    key_url: "",
    extra: [],
    ...extra,
  };
}

export const PROVIDER_KINDS: ProviderKind[] = [
  kind("google", "Google Gemini", "direct", {
    env_key: "GEMINI_API_KEY",
    default_base_url: "https://generativelanguage.googleapis.com",
    key_url: "https://aistudio.google.com/apikey",
  }),
  kind("anthropic", "Anthropic", "direct", {
    env_key: "ANTHROPIC_API_KEY",
    default_base_url: "https://api.anthropic.com",
    key_url: "https://console.anthropic.com/settings/keys",
  }),
  kind("openrouter", "OpenRouter", "aggregator", {
    env_key: "OPENROUTER_API_KEY",
    default_base_url: "https://openrouter.ai/api/v1",
    tested: false,
    note: "실제 호출로 확인하지 않은 제공자입니다.",
    key_url: "https://openrouter.ai/keys",
  }),
  kind("ollama", "Ollama (내 컴퓨터)", "local", {
    needs_key: false,
    key_optional: true,
    default_base_url: "http://127.0.0.1:11434",
    base_url_editable: true,
    tested: false,
    note: "Ollama가 켜져 있어야 합니다.",
  }),
  kind("custom", "OpenAI 호환 서버", "custom", {
    key_optional: true,
    base_url_editable: true,
    tested: false,
    note: "주소를 직접 적습니다.",
    extra: [
      {
        name: "organization",
        label: "조직 ID",
        placeholder: "비워 둬도 됩니다",
        env: null,
        help: "서버가 요구할 때만 적습니다.",
        secret: false,
        multiline: false,
      },
    ],
  }),
];

export const META: Meta = {
  version: "0.4.0",
  version_date: "2026-11-17",
  provider_kinds: PROVIDER_KINDS,
  modes: [
    { id: "manual", label: "수동", description: "문서를 바꾸거나 도구를 돌리기 전에 항상 확인합니다." },
    { id: "auto", label: "자동", description: "에이전트가 판단해서 확인을 청합니다. 원고 변경은 항상 확인합니다." },
    { id: "autonomous", label: "자율", description: "확인하지 않고 끝까지 진행합니다." },
    { id: "plan", label: "계획", description: "실행하지 않고 계획만 세웁니다. 자료에만 씁니다." },
  ],
  agent_tools: AGENT_TOOLS,
  summary_tool: SUMMARY_TOOL_DEF,
};

/** 제공자 종류마다 보여줄 모델 목록. */
export const MODELS: Record<string, ModelEntry[]> = {
  google: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", context: 1048576, price_in: 1.25, price_out: 10 },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", context: 1048576, price_in: 0.3, price_out: 2.5 },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", context: 1048576, price_in: 0.1, price_out: 0.4 },
  ],
  anthropic: [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", context: 200000, price_in: 3, price_out: 15 },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", context: 200000, price_in: 1, price_out: 5 },
  ],
  openrouter: [
    { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro", context: 1048576, price_in: 1.25, price_out: 10 },
    { id: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", context: 200000, price_in: 3, price_out: 15 },
    { id: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat", context: 64000, price_in: 0.27, price_out: 1.1 },
  ],
  ollama: [
    { id: "gemma3:12b", label: "gemma3:12b", context: 131072 },
    { id: "exaone3.5:7.8b", label: "exaone3.5:7.8b", context: 32768 },
  ],
  custom: [{ id: "local-model", label: "local-model" }],
};

/** 처음 상태의 제공자: 준비된 것 둘(하나는 확인 안 된 종류), 키가 없는 것 하나. */
export function seedProviders(): Provider[] {
  const make = (id: string, has_key: boolean): Provider => {
    const k = PROVIDER_KINDS.find((x) => x.id === id)!;
    return {
      id,
      kind: id,
      label: k.label,
      base_url: "",
      effective_base_url: k.default_base_url ?? "",
      extra: {},
      secrets: {},
      enabled: true,
      has_key,
      key_source: has_key ? "config" : null,
      ready: has_key || !k.needs_key,
      tested: k.tested,
    };
  };
  return [make("google", true), make("openrouter", true), make("anthropic", false)];
}
