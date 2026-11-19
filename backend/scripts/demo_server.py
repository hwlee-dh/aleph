"""키 없이 화면을 돌려 보기 위한 시연 서버.

실제 모델 대신 대본대로 움직이는 가짜 모델을 등록한다. 화면 흐름(스트리밍, 도구 실행,
질문, 문서 변경 확인, 도구 실행 확인, 중단)을 과금 없이 확인하는 용도다. 진짜 작업 데이터와
섞이지 않도록 `data-demo/` 폴더를 쓴다.

    uv run python scripts/demo_server.py [포트] [--open]

모델을 고를 필요 없이 `demo:agent`가 미리 들어가 있다. 가짜 에이전트는 상황을 보고 대본을 고른다.

- 계획 모드: 자료에 계획을 적고 노트로 지정한다.
- 원고가 비어 있을 때 요청하면: 시점을 묻고(자율이면 묻지 않는다), 인물 자료와 입력을 쓰고,
  집필 도구를 돌려 원고에 넣는다. 자율 모드에서는 두 장면을 쓰고 둘째 장면은 비평을 거친다.
- 원고가 있을 때 요청하면: 다음 장면을 쓴다.
- 올린 글(자료/올린 글)이 있고 요청에 "나눠"가 있으면: 그 글을 읽고 장면으로 나눈다.
  (`scripts/시연용 글/등대지기의 딸.txt`를 올려 보면 된다.)
- 문서에서 인용해 요청하면: 그 대목의 마지막 문장을 덜어내는 수정을 한다.
- `/도구 요청`처럼 도구를 지정하면: 요청을 입력에 덧붙이고 그 도구를 돌린다.
- 원고가 비어 있을 때의 첫 단계에는 에이전트의 생각이 먼저 보인다.
- 요청에 "찾아봐"나 "검색"이 있고 프리셋에서 웹 검색을 켜 두었으면: 검색하는 시늉을 하고 자료에 조사 메모를 남긴다.
- "'서윤'을 '서연'으로 바꿔 줘"처럼 따옴표로 두 글귀를 주면: 찾아 바꾸기를 한다.
- 요청에 "그림"이나 "삽화", "스캔"이 있고 자료에 이미지나 PDF가 있으면: 그 파일을 본다.
- 실행 중에 말을 걸면 받았다고만 답한다 (대본은 그 말대로 움직이지 못한다).
- 장면에 "요약 실패"라고 적혀 있으면 그 장면의 요약이 일부러 실패한다 (요약 도구가 실패했을 때의 표시를 보려고).

글을 "읽고 판단"하는 것처럼 보여도 전부 정해진 규칙이다. 지침이나 도구의 품질은
이것으로 확인할 수 없다.
"""

from __future__ import annotations

import asyncio
import json
import re
import struct
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import uvicorn
from pydantic_ai.messages import BinaryImage, FilePart
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    NativeToolCallPart,
    NativeToolReturnPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, DeltaThinkingPart, DeltaToolCall, FunctionModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aleph.app import create_app  # noqa: E402
from aleph.providers.factory import register_test_model  # noqa: E402
from aleph.providers.store import ProviderConfig  # noqa: E402
from aleph.settings import REPO_DIR, AppPaths  # noqa: E402

SCENE = """바람이 계단을 타고 올라왔다. 서윤은 난간을 붙잡고 한 칸씩 발을 옮겼다. 아버지가 삼십 년 동안 오르내린 계단이었다.

등탑 꼭대기의 불은 꺼져 있었다. 유리창 너머로 방파제를 넘는 파도가 하얗게 부서졌다. 무전기에서는 잡음만 흘렀다.

"아버지."

대답 대신 아래층에서 문이 닫히는 소리가 났다. 서윤은 성냥갑을 꺼냈다. 손이 떨려서 세 번째에야 불이 붙었다."""

SCENE2 = """아침에는 바람이 죽어 있었다. 서윤은 등탑 유리를 닦았다. 소금기가 말라붙은 자리는 손톱으로 긁어야 떨어졌다.

아버지는 부엌에서 미역국을 끓이고 있었다. 식탁에는 숟가락이 두 벌 놓여 있었다. 사흘 만이었다.

서윤은 걸레를 헹궈 난간에 널고 내려갔다. 아버지는 돌아보지 않았다. 국을 뜨는 손이 한 번 멈췄다가 다시 움직였다.

"불은 네가 켰더라."

서윤은 숟가락을 들었다."""

CONTINUATION = """서윤은 가방을 내려놓지 않은 채 한참 서 있었다. 발전기 소리가 벽을 타고 올라왔다. 어릴 때는 그 소리를 들으며 잠들었다.

아버지는 등을 보인 채 무전기 다이얼을 돌렸다. 주파수가 맞을 때마다 짧은 잡음이 났다.

"방은 그대로다."

그게 전부였다. 서윤은 계단을 올랐다. 세 번째 칸이 여전히 삐걱거렸다."""

CRITIQUE = """반드시 고칠 것: 없음

살아 있는 곳: 감정을 말하지 않고 손이 하는 일로만 보여주는 대목. 읽는 사람이 떨림을 스스로 알아챈다.
개선 여지: 둘째 문단의 소리 묘사는 한 번 더 돌아오면 좋다. 지금은 한 번 나오고 사라진다.
취향: 마지막 문장을 한 박자 더 짧게 끊을 수 있다."""

BRIEF = """# 첫 장면

- 사건: 폭풍이 치는 밤, 서윤이 꺼진 등대의 불을 다시 켜러 등탑에 오른다.
- 인물 상태: 아버지와 말을 섞지 않은 지 사흘째. 불안하지만 드러내지 않는다.
- 시점: {pov}, 3인칭 제한.
- 문체: 짧은 문장. 감정은 행동으로만.

인물:
@include:자료/인물/서윤
"""

BRIEF2 = """# 둘째 장면

- 사건: 폭풍이 지나간 아침. 서윤이 등탑 유리를 닦고 내려와 아버지와 사흘 만에 한 식탁에 앉는다.
- 인물 상태: 밤새 불을 지켰다. 아버지가 그것을 아는지 모르는지 알 수 없다.
- 문체: 짧은 문장. 화해를 말로 하지 않는다.

앞 장면:
@include:{previous}
"""

BRIEF_NEXT = """# 이어 쓰기

- 할 일: 아래 장면의 바로 뒤를 이어 쓴다. 같은 목소리, 같은 문장 길이.
- 새 사건을 크게 벌이지 않는다. 방금 일어난 일의 여운 안에서 한 걸음만 나아간다.

앞 장면:
@include:{previous}
"""

CRITIQUE_BRIEF = """이 장면이 하려는 일: 폭풍 뒤의 아침, 두 사람이 화해를 말로 하지 않고 한 식탁에 앉는다.
초점 인물: 서윤.
봐 주었으면 하는 점: 감정을 설명하지 않고 있는가.

비평할 글:
@include:{draft}
"""

CHARACTER = "스물여섯. 등대지기의 딸. 도시에서 돌아온 지 한 달. 말수가 적고 손이 먼저 움직인다."
FATHER = "예순하나. 삼십 년째 등대를 지킨다. 미안하다는 말을 할 줄 몰라서 밥을 차린다."
PLAN = """# 계획

1. 인물 정하기: 서윤(딸), 아버지(등대지기). `자료/인물`에 한 사람씩 적는다.
2. 첫 장면: 폭풍이 치는 밤, 서윤이 꺼진 등대의 불을 켜러 오른다.
3. 둘째 장면: 폭풍이 지나간 아침, 두 사람이 한 식탁에 앉는다.
4. 두 장면을 이어 읽고 겹치는 대목을 덜어낸다.

장면마다: 입력에 지시서 쓰기 → 집필 → 읽어 보고 필요하면 비평 → 원고에 넣기.
"""

PACE = 1.0  # 가짜 모델이 뜸 들이는 정도. 테스트는 0으로 둔다.

AGENT_TOOLS = {
    "list", "read", "search", "explore", "generate_image", "write", "edit", "delete", "move", "set_note",
    "insert_scene", "move_scene", "split", "merge_scenes", "ask_user", "set_summary", "summarize_scenes",
}


def _nap(seconds: float):
    return asyncio.sleep(seconds * PACE)


# ---------------------------------------------------------------- 상황 읽기

@dataclass
class Turn:
    user: str = ""
    done: int = 0                                  # 이번 요청에서 이미 한 도구 호출 수
    returns: list[str] = field(default_factory=list)   # 그 결과들 (순서대로)
    instructions: str = ""
    tools: set[str] = field(default_factory=set)
    natives: set[str] = field(default_factory=set)       # 이번 요청에 붙은, 제공자가 실행하는 도구
    steered: list[str] = field(default_factory=list)     # 실행 중에 사용자가 보낸 말

    @property
    def mode(self) -> str:
        for key, name in (("계획 모드", "plan"), ("자율 모드", "autonomous"), ("수동 모드", "manual")):
            if f"지금은 {key}입니다" in self.instructions:
                return name
        return "auto"

    def block(self, tag: str) -> list[str]:
        m = re.search(rf"<{tag}>\n(.*?)\n</{tag}>", self.instructions, re.S)
        return m.group(1).splitlines() if m else []

    @property
    def materials(self) -> list[str]:
        return [re.sub(r" \([^)]*\)( \[[^\]]*\])?$", "", line) for line in self.block("materials") if line.startswith("자료/")]

    @property
    def scenes(self) -> list[tuple[str, str]]:
        """(경로, 그 줄 전체) 들."""
        out = []
        for line in self.block("manuscript"):
            m = re.match(r"\s+\d+\.\d+ (원고/s\d+)", line)
            if m:
                out.append((m.group(1), line))
        return out

    def tool(self, name: str) -> str | None:
        """사용자 도구 가운데 그 이름의 것. 없으면 첫 번째 사용자 도구(집필 자리)나 None."""
        if name in self.tools:
            return name
        return None

    @property
    def user_tools(self) -> list[str]:
        return sorted(self.tools - AGENT_TOOLS)


def _user_text(m) -> str | None:
    if isinstance(m, ModelRequest):
        for p in m.parts:
            if isinstance(p, UserPromptPart) and isinstance(p.content, str):
                return p.content
    return None


_INTERJECTION = ("[사용자가 실행 중에 보낸 말입니다.", "[앱의 알림]")


def read_turn(messages, info: AgentInfo) -> Turn:
    idx, text = 0, ""
    steered: list[str] = []
    for i, m in enumerate(messages):
        t = _user_text(m)
        if t is None:
            continue
        if t.startswith(_INTERJECTION):
            # 실행 중에 끼어든 말은 새 요청이 아니다. 하던 대본을 이어 가되, 받았다는 것은 기억한다.
            if "[사용자가 실행 중에 보낸 말입니다." in t:
                said = t.split("[사용자가 실행 중에 보낸 말입니다. 지금 하던 일에 반영하십시오.]\n", 1)[-1]
                steered += [part.strip() for part in said.split("\n\n") if part.strip()]
            continue
        idx, text, steered = i, t, []
    steps = messages[idx + 1:]
    returns: list[str] = []
    for m in steps:
        if isinstance(m, ModelRequest):
            returns += [str(p.content) for p in m.parts if isinstance(p, ToolReturnPart)]
    return Turn(
        user=text,
        done=sum(1 for m in steps if isinstance(m, ModelResponse)),
        returns=returns,
        instructions=info.instructions or "",
        tools={t.name for t in info.function_tools},
        natives={getattr(t, "kind", "") for t in info.model_request_parameters.native_tools},
        steered=steered,
    )


def call(tool: str, say: str = "", think: str = "", **args) -> dict:
    """대본의 한 단계. say는 도구를 부르기 전에 하는 말, think는 그 전에 보이는 생각."""
    return {"tool": tool, "args": args, **({"say": say} if say else {}), **({"think": think} if think else {})}


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?…”\"])\s+", text.strip()) if s]


def run_script(turn: Turn, script: list, closing) -> dict | str:
    """대본의 다음 단계. 앞 단계가 반려되거나 막혔으면 거기서 멈추고 그 사실을 말한다."""
    last = turn.returns[-1] if turn.returns else ""
    if "반려했습니다" in last:
        return "알겠다. 여기서 멈춘다. 어떻게 바꾸면 좋을지 말해 주면 그대로 다시 하겠다."
    if last.startswith("오류"):
        return f"막혔다. {last[4:].strip()}"
    if "요약을 붙이지 않았습니다" in last:
        return "알겠다. 요약은 붙이지 않았다. 나머지는 끝났다."
    if turn.done < len(script):
        step = script[turn.done]
        return step(turn) if callable(step) else step
    text = closing(turn) if callable(closing) else closing
    if turn.steered:
        said = ", ".join(f"'{t[:40]}'" for t in turn.steered)
        text += f" 실행 중에 보낸 말({said})은 받았다. 이 시연용 대본은 그 말대로 움직이지는 못한다."
    return text


# ---------------------------------------------------------------- 대본들

def _compose(turn: Turn, **args) -> dict:
    name = turn.tool("compose") or (turn.user_tools[0] if turn.user_tools else "compose")
    return call(name, **args)


def _last_scene(turn: Turn) -> str:
    """이번 요청에서 방금 원고에 넣은 장면의 경로."""
    found = [m.group(0) for r in turn.returns for m in [re.search(r"원고/s[0-9]+", r)] if m and "원고에 장면을 넣었습니다" in r]
    return found[-1] if found else "원고"


def flow_plan(turn: Turn) -> dict | str:
    script = [
        call("list", say="지금 있는 것부터 보겠다."),
        call("write", path="자료/계획", content=PLAN),
        call("set_note", path="자료/계획"),
    ]
    if "ask_user" in turn.tools:
        script.append(call("ask_user", question="두 장면으로 끝낼까요, 더 이어 갈까요?", options=["두 장면으로 끝", "더 이어 간다"]))
    return run_script(turn, script, "계획을 `자료/계획`에 적었다. 노트로 지정해 두어서 다음부터는 늘 보고 시작한다. 모드를 바꾸고 시작하라고 하면 1번부터 하겠다.")


def flow_first(turn: Turn) -> dict | str:
    """원고가 비어 있을 때: 묻고, 자료와 입력을 쓰고, 집필해서 원고에 넣는다."""
    can_ask = "ask_user" in turn.tools
    answer = turn.returns[1] if can_ask and len(turn.returns) > 1 else ""
    pov = answer if answer in ("서윤", "아버지") else "서윤"
    script: list = [call(
        "list", say="지금 있는 것부터 보겠다.",
        think="원고가 비어 있다. 무엇이 정해져 있는지 자료부터 확인하고, 시점처럼 내가 정하면 안 되는 것은 물어야 한다.",
    )]
    if can_ask:
        script.append(call("ask_user", question="첫 장면을 누구의 시점으로 쓸까요?", options=["서윤", "아버지"]))
    script += [
        call("write", path="자료/인물/서윤", content=CHARACTER),
        call("write", path="입력", content=BRIEF.format(pov=pov)),
        # 자동 모드에서는 첫 실행 전에 입력을 보여 주고 확인을 받는다
        _compose(turn, **({"confirm": True} if turn.mode == "auto" else {})),
        call("insert_scene", say="읽어 보니 고칠 곳이 없다. 원고에 넣겠다.", from_output=True),
        call("summarize_scenes", say="장면에 요약을 붙여 둔다."),
        call("write", path="자료/계획", content="# 계획\n\n- [x] 첫 장면: 등탑\n- [ ] 다음 장면: 폭풍이 지나간 아침\n"),
    ]
    return run_script(turn, script, "첫 장면을 원고에 넣었다. 다음은 폭풍이 지나간 아침이다. 고칠 곳이 있으면 그 대목을 인용해서 말해 달라.")


def flow_handoff(turn: Turn) -> dict | str:
    """자율 모드, 원고가 비어 있을 때: 묻지 않고 두 장면을 쓴다. 둘째 장면은 비평을 거친다."""
    critique = turn.tool("critique")
    script: list = [
        call(
            "list", say="묻지 않고 끝까지 하겠다.",
            think="물어볼 사람이 없다. 시점과 장면 수는 내가 정하고, 정한 것은 자료에 적어 둔다.",
        ),
        call("write", path="자료/인물/서윤", content=CHARACTER),
        call("write", path="자료/인물/아버지", content=FATHER),
        call("write", path="입력", content=BRIEF.format(pov="서윤")),
        _compose(turn),
        call("insert_scene", from_output=True),
        lambda t: call("write", path="입력", content=BRIEF2.format(previous=_last_scene(t))),
        _compose(turn),
    ]
    if critique:
        script += [
            call("move", say="다른 눈으로 한 번 보겠다.", source="출력", destination="자료/초고/아침"),
            call("write", path="입력", content=CRITIQUE_BRIEF.format(draft="자료/초고/아침")),
            call(critique),
            call("insert_scene", say="반드시 고칠 것은 없다고 한다. 원고에 넣겠다.", from_doc="자료/초고/아침"),
        ]
    else:
        script.append(call("insert_scene", from_output=True))
    script.append(call("summarize_scenes", say="두 장면에 요약을 붙여 둔다."))
    script.append(call(
        "write", path="자료/계획",
        content="# 계획\n\n- [x] 첫 장면: 등탑\n- [x] 둘째 장면: 아침\n\n스스로 정한 것: 시점은 서윤, 3인칭 제한. 두 장면 사이의 밤은 건너뛰었다.\n",
    ))
    return run_script(turn, script, "두 장면을 썼다. 원고에 1장 1, 2번째 장면으로 들어가 있다. 스스로 정한 것은 `자료/계획`에 적어 두었다.")


def flow_next(turn: Turn) -> dict | str:
    """원고가 있을 때: 마지막 장면에 이어 다음 장면을 쓴다."""
    last_path, _ = turn.scenes[-1]
    second = len(turn.scenes) == 1   # 첫 장면(등탑)만 있으면 다음은 준비해 둔 둘째 장면(아침)이다
    brief = BRIEF2.format(previous=last_path) if second else BRIEF_NEXT.format(previous=last_path)
    script = [
        call("write", say="앞 장면에 이어 쓰겠다.", path="입력", content=brief),
        _compose(turn),
        call("insert_scene", from_output=True),
        call("summarize_scenes", say="장면에 요약을 붙여 둔다."),
    ]
    return run_script(turn, script, "다음 장면을 원고 끝에 넣었다.")


def flow_split(turn: Turn, path: str) -> dict | str:
    """올린 글을 읽고 문단 둘마다 잘라 장면으로 나눈다."""

    def cuts(t: Turn) -> dict:
        text = re.sub(r"\n\n\(전체 [^)]*\)$", "", t.returns[0])
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        picked = []
        for p in paragraphs[2::2]:
            anchor = p[:24]
            if text.count(anchor) == 1:
                picked.append({"before": anchor})
        if not picked and len(paragraphs) > 1:
            picked = [{"before": paragraphs[len(paragraphs) // 2][:24]}]
        return call("split", say="장면이 바뀌는 자리를 찾았다. 글은 그대로 두고 자르기만 한다.", path=path, cuts=picked)

    script = [
        call("read", say="올린 글부터 읽겠다.", path=path), cuts,
        call("summarize_scenes", say="나눈 장면마다 요약을 붙인다. 요약 도구를 한꺼번에 돌린다."),
    ]
    return run_script(turn, script, "올린 글을 장면으로 나눠 원고에 넣었다. 자료의 원문은 그대로 있다. 장면마다 요약이 붙었으니 목록에서 확인해 달라.")


def flow_summarize(turn: Turn) -> dict | str:
    """요약을 붙여 달라는 요청: 요약이 없거나 낡은 장면에 요약 도구를 한꺼번에 돌린다."""
    script = [call("summarize_scenes", say="요약이 없거나 낡은 장면을 찾아 한꺼번에 붙이겠다.")]

    def closing(t: Turn) -> str:
        last = t.returns[-1] if t.returns else ""
        if "실패한 곳" in last:
            return "요약을 붙이다가 실패한 장면이 있다. 그 장면은 요약이 낡은 채로 남아 있다. 다시 시키거나 직접 적어 주면 된다."
        if "요약할 장면이 없습니다" in last:
            return "요약은 전부 최신이다. 붙일 곳이 없다."
        return "요약을 붙였다. 원고 목록에서 확인해 달라."

    return run_script(turn, script, closing)


def flow_quote(turn: Turn, path: str, quoted: str) -> dict | str:
    """인용한 대목의 마지막 문장을 덜어낸다."""
    sentences = _sentences(quoted)
    shorter = " ".join(sentences[:-1]) if len(sentences) > 1 else quoted
    script = [
        call("read", say="그 대목을 다시 읽겠다.", path=path),
        call("edit", path=path, old_text=quoted, new_text=shorter),
    ]
    return run_script(turn, script, "그 대목의 마지막 문장을 덜어냈다. 마음에 안 들면 버전 기록에서 되돌릴 수 있다.")


def flow_search(turn: Turn) -> dict | str:
    """웹 검색: 검색하는 시늉을 하고(제공자가 실행하는 도구), 찾은 것을 자료에 남긴다."""
    script = [
        {
            **call(
                "write", say="찾아봤다. 남겨 둘 것을 자료에 적는다.", path="자료/조사/등대",
                content="# 등대 조사 메모\n\n- 1930년대 유인 등대는 등탑, 숙소, 발전기실로 이루어진다.\n- 불은 석유등에서 전등으로 바뀌던 때다.\n\n출처: https://example.org/lighthouse-history\n",
            ),
            "search": "1930년대 등대 구조",
        },
    ]
    return run_script(turn, script, "찾은 것을 `자료/조사/등대`에 출처와 함께 적어 두었다. (시연용이라 실제로 검색하지는 않았다.)")


def flow_replace(turn: Turn, query: str, replacement: str) -> dict | str:
    script = [
        call("search", say="어디에 나오는지부터 보겠다.", query=query),
        call("replace_all", query=query, replacement=replacement),
    ]
    return run_script(turn, script, f"'{query}'를 '{replacement}'로 바꿨다. 마음에 안 들면 이 요청을 통째로 되돌릴 수 있다.")


def flow_explore(turn: Turn) -> dict | str:
    """원고를 훑어 달라는 요청: 직접 다 읽지 않고 읽기 에이전트에게 맡긴다."""
    task = "원고 전체에서 서윤이 어떻게 그려지는지 장면별로 정리해 줘. 근거가 된 장면의 경로를 같이 적어 줘."
    script = [call("explore", say="직접 다 읽지 않고 읽기 에이전트에게 맡기겠다.", task=task)]
    return run_script(turn, script, lambda t: "읽기 에이전트가 알아본 것이다.\n\n" + (t.returns[-1] if t.returns else ""))


def flow_image(turn: Turn) -> dict | str:
    """그림을 만들어 달라는 요청: 이미지 모델에 넘길 글을 쓰고 그림을 만든다."""
    prompt = (
        "폭풍이 치는 밤의 등대. 등탑 꼭대기의 유리창 안에 작은 불빛 하나가 막 켜졌다. "
        "아래에서 올려다본 구도, 방파제를 넘는 흰 파도, 짙은 남색 하늘. 인물은 보이지 않는다. 수채화."
    )
    script = [call("generate_image", say="이미지 모델에 넘길 글을 쓰고 그림을 만들겠다.", prompt=prompt, name="등탑의 밤")]
    return run_script(turn, script, "그림을 만들어 `자료/삽화`에 넣었다. (시연용 가짜 모델이라 단색 그림이다. 실제 이미지 모델은 글대로 그린다.)")


def flow_view(turn: Turn, path: str) -> dict | str:
    script = [call("view_file", say="그 파일을 보겠다.", path=path)]
    return run_script(turn, script, f"`{path}`를 봤다. (시연용 가짜 모델이라 실제로 내용을 알아보지는 못한다.)")


def flow_directive(turn: Turn, name: str, label: str, goal: str) -> dict | str:
    """사용자가 도구를 지정했다: 요청을 입력에 덧붙이고 그 도구를 돌린다."""

    def write_input(t: Turn) -> dict:
        current = t.returns[0]
        base = "" if current.startswith("(비어 있음)") else current.rstrip() + "\n\n"
        return call("write", path="입력", content=f"{base}- 이번에 특히: {goal}\n")

    script = [call("read", path="입력"), write_input, call(name)]
    return run_script(turn, script, f"요청을 입력에 덧붙이고 '{label}' 도구를 돌렸다. 결과는 출력에 있다.")


def agent_script(messages, info: AgentInfo) -> dict | str:
    turn = read_turn(messages, info)
    user = turn.user

    if turn.mode == "plan":
        return flow_plan(turn)

    directive = re.match(r"\[사용자가 '(.+?)' 도구\((\w+)\)를 쓰라고 지정했습니다\..*?\]\n\n(.*)", user, re.S)
    if directive and directive.group(2) in turn.tools:
        return flow_directive(turn, directive.group(2), directive.group(1), directive.group(3).strip())

    quote = re.search(r"\[(?:인용|긁은 곳): ([^\]\n]+)\]\n((?:>.*\n?)+)", user)
    if quote:
        quoted = "\n".join(line[1:].lstrip() for line in quote.group(2).strip().splitlines())
        return flow_quote(turn, quote.group(1).strip(), quoted)

    if turn.scenes and "summarize_scenes" in turn.tools and re.search("요약", user):
        return flow_summarize(turn)

    swap = re.search(r"['\"‘“]([^'\"’”]+)['\"’”][을를]?\s*['\"‘“]([^'\"’”]+)['\"’”](?:으로|로)\s*바꿔", user)
    if swap and "replace_all" in turn.tools:
        return flow_replace(turn, swap.group(1), swap.group(2))

    if "web_search" in turn.natives and re.search("찾아봐|찾아 봐|검색|조사", user):
        return flow_search(turn)

    if turn.scenes and "explore" in turn.tools and re.search("훑어|어긋나|일관|어떻게 그려|어디에 나오", user):
        return flow_explore(turn)

    if "generate_image" in turn.tools and re.search("(그림|삽화|이미지).*(그려|만들)", user):
        return flow_image(turn)

    asset = next((p for p in turn.materials if p.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"))), None)
    if asset and "view_file" in turn.tools and re.search("그림|삽화|이미지|스캔|파일을 봐", user):
        return flow_view(turn, asset)

    uploaded = next((p for p in turn.materials if p.startswith("자료/올린 글/") and not p.lower().endswith(".pdf")), None)
    if uploaded and re.search("나눠|나누|장면으로", user):
        return flow_split(turn, uploaded)

    if not turn.user_tools:
        return "(시연용 가짜 모델) 이 프리셋에는 도구가 없다. 에이전트 패널에서 도구를 만들면 그것을 돌려 본다."
    if turn.scenes:   # 요청을 시작할 때 원고에 장면이 있었다
        return flow_next(turn)
    if turn.mode == "autonomous":
        return flow_handoff(turn)
    return flow_first(turn)


# ---------------------------------------------------------------- 도구와 보조 모델

def _input_text(messages) -> str:
    return next((t for t in (_user_text(m) for m in reversed(messages)) if t), "")


def sub_call(messages, info: AgentInfo) -> dict | str:
    """도구(집필, 비평, 요약, 사용자가 만든 것)의 대답."""
    system = info.instructions or ""
    text = _input_text(messages)
    if "읽기 에이전트입니다" in system:   # 본 에이전트가 내보낸 읽기 에이전트. 목록을 보고, 찾고, 답한다
        done = sum(1 for m in messages if isinstance(m, ModelResponse))
        if done == 0:
            return call("list", path="원고")
        if done == 1:
            return call("search", query="서윤", path="원고")
        return (
            "서윤은 말보다 손과 발로 그려진다. 등탑을 오르는 장면에서는 난간을 붙잡고 한 칸씩 올라가고, "
            "아버지와 마주 앉는 장면에서는 묻지 않고 기다린다.\n\n"
            "근거: 원고의 장면들에서 '서윤'이 나오는 곳을 찾아 확인했다 (원고/s1부터). "
            "(시연용 가짜 모델의 답이다. 실제 모델은 장면을 읽고 답한다.)"
        )
    if "인수인계용으로 요약" in system:   # 대화 압축
        return "사용자가 등대지기 딸의 이야기를 쓰자고 했고, 지금까지 쓴 것은 원고와 자료에 있다. 이어서 다음 장면을 쓰면 된다."
    if "입력에 든 글을 요약한다" in system:
        if text.startswith("[") and "장면 요약들]" in text[:40]:
            return "서윤이 섬의 등대로 돌아와 아버지와 말 없이 다시 한 지붕 아래에 놓인다."
        if "요약 실패" in text:   # 알림 표시를 보려고 일부러 실패시키는 길: 장면에 '요약 실패'라고 적으면 된다
            raise RuntimeError("시연용: 이 장면의 요약을 일부러 실패시켰다")
        if "성냥갑" in text:
            return "폭풍이 치는 밤, 서윤이 꺼진 등대의 불을 켜러 등탑에 오른다."
        if "미역국" in text:
            return "폭풍이 지나간 아침, 서윤과 아버지가 사흘 만에 한 식탁에 앉는다."
        if "발전기" in text:
            return "서윤이 가방을 든 채 서 있다가 아버지의 한마디를 듣고 옛 방으로 올라간다."
        first = _sentences(text)[0] if text.strip() else ""
        return f"'{first[:30]}'로 시작하는 대목이다." if first else "빈 장면이다."
    if "exacting reader" in system or "비평" in system[:200]:
        return CRITIQUE
    if "novelist" in system or "소설가" in system[:200]:
        if "폭풍이 치는 밤" in text:
            return SCENE
        if "폭풍이 지나간 아침" in text:
            return SCENE2
        return CONTINUATION
    head = text.strip().splitlines()[0][:60] if text.strip() else ""
    return f"(시연용 가짜 모델의 대답) 지시문과 입력을 받았다. 실제 모델이라면 여기에 결과가 나온다.\n\n받은 입력의 첫 줄: {head}"


def pick(messages, info: AgentInfo) -> dict | str:
    if not ({"read", "write"} <= {t.name for t in info.function_tools}):
        return sub_call(messages, info)
    return agent_script(messages, info)


async def model_stream(messages, info: AgentInfo):
    step = pick(messages, info)
    agent = bool(info.function_tools)
    await _nap(0.5)
    think = "" if isinstance(step, str) else step.get("think", "")
    for i in range(0, len(think), 6):
        await _nap(0.02)
        yield {0: DeltaThinkingPart(content=think[i:i + 6])}
    query = "" if isinstance(step, str) else step.get("search", "")
    if query:   # 제공자가 실행하는 웹 검색을 흉내 낸다 (호출과 결과가 모델의 응답 안에 같이 온다)
        yield {2: NativeToolCallPart(tool_name="web_search", args={"query": query}, tool_call_id="demo-search")}
        await _nap(0.6)
        yield {3: NativeToolReturnPart(tool_name="web_search", tool_call_id="demo-search", content=[
            {"title": "등대의 역사와 구조", "url": "https://example.org/lighthouse-history"},
            {"title": "유인 등대의 하루", "url": "https://example.org/keepers-day"},
        ])}
    say = step if isinstance(step, str) else step.get("say", "")
    width = 4 if agent else 3
    for i in range(0, len(say), width):
        await _nap(0.02)
        yield say[i:i + width]
    if not isinstance(step, str):
        yield {1: DeltaToolCall(name=step["tool"], json_args=json.dumps(step["args"], ensure_ascii=False))}


async def model_plain(messages, info: AgentInfo) -> ModelResponse:
    step = pick(messages, info)
    await _nap(0.3)
    if isinstance(step, str):
        return ModelResponse(parts=[TextPart(content=step)])
    parts: list = [TextPart(content=step["say"])] if step.get("say") else []
    parts.append(ToolCallPart(tool_name=step["tool"], args=step["args"]))
    return ModelResponse(parts=parts)


def use_demo_models(ctx) -> None:
    """모델이 비어 있는 프리셋을 가짜 모델로 읽히게 한다. 시연 중에 새로 만든 프리셋도 고를 것 없이 바로 돈다.

    이미지 모델은 채우지 않는다. 비워 두는 것(`없음`)이 뜻이 있는 선택이라서, 그림을 만들어 보려면
    에이전트 패널의 `이미지 모델`에서 `시연용 가짜 모델`의 `image`를 고른다.
    """
    original = ctx.presets.get

    def get(preset_id: str):
        preset = original(preset_id)
        if preset is not None and not preset.model:
            preset.model = "demo:agent"
            preset.auxiliary_model = preset.auxiliary_model or "demo:aux"
        return preset

    ctx.presets.get = get


def _png(width: int, height: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> bytes:
    """위아래 두 색으로 나뉜 PNG 한 장. 가짜 이미지 모델이 내는 그림이다."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + bytes(top if y < height * 2 // 3 else bottom) * width for y in range(height))
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    )


async def image_plain(messages, info: AgentInfo) -> ModelResponse:
    """가짜 이미지 모델. 무엇을 시키든 남색 하늘과 파란 바다 한 장을 낸다."""
    await _nap(1.2)
    return ModelResponse(parts=[FilePart(content=BinaryImage(data=_png(480, 300, (0, 40, 94), (0, 94, 184)), media_type="image/png"))])


def register_models() -> None:
    model = FunctionModel(model_plain, stream_function=model_stream)
    for ref in ("demo:agent", "demo:aux"):
        register_test_model(ref, model)
    register_test_model("demo:image", FunctionModel(image_plain, profile={"supports_image_output": True}))


def main() -> None:
    args = sys.argv[1:]
    port = next((int(a) for a in args if a.isdigit()), 8765)
    register_models()
    paths = AppPaths(data=REPO_DIR / "data-demo")
    app = create_app(paths)
    ctx = app.state.ctx
    use_demo_models(ctx)
    # 설정 화면에서 가짜 모델이 "등록되지 않은 제공자"로 보이지 않게 자리만 만들어 둔다. 실제로 연결되지는 않는다.
    ctx.providers.upsert(ProviderConfig(id="demo", kind="openai_compatible", label="시연용 가짜 모델", base_url="http://127.0.0.1:9/v1"))
    url = f"http://127.0.0.1:{port}"
    print(f"시연 서버: {url}  (데이터: {paths.data})")
    print("실제 모델은 부르지 않는다. 끝내려면 이 창에서 Ctrl+C를 누르거나 창을 닫는다.")
    if "--open" in args:
        import threading
        import webbrowser

        threading.Timer(1.5, webbrowser.open, args=[url]).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
