"""에이전트의 대화 기억(모델 메시지 이력)을 세션 폴더에 저장하고 불러온다.

화면에 보이는 대화 기록(events.jsonl)과는 별개다. 이쪽은 모델에게 다시
넘겨줄 원본 메시지이고, 서버를 껐다 켜도 이어서 일할 수 있게 한다.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from pydantic_ai.messages import (
    FilePart,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)


def load_history(path: Path) -> list[ModelMessage]:
    if not path.exists():
        return []
    try:
        return list(ModelMessagesTypeAdapter.validate_json(path.read_bytes()))
    except Exception:
        # 형식이 깨졌거나 라이브러리 버전이 바뀌어 못 읽는 경우 — 원본은 옆에 남겨 두고 새로 시작한다.
        try:
            path.replace(path.with_suffix(".broken.json"))
        except OSError:
            pass
        return []


def strip_files(messages: list[ModelMessage]) -> list[ModelMessage]:
    """사용자 쪽 메시지에 실려 있던 파일(이미지, PDF)을 자리 표시로 바꾼다.

    에이전트가 view_file로 본 파일은 그 요청 안에서만 쓸모가 있다. 대화 기억에 남기면 다음 요청마다
    그 파일을 통째로 다시 보내게 된다.
    """
    out: list[ModelMessage] = []
    for message in messages:
        if isinstance(message, ModelRequest) and any(
            isinstance(p, UserPromptPart) and not isinstance(p.content, str) for p in message.parts
        ):
            parts = []
            for p in message.parts:
                if isinstance(p, UserPromptPart) and not isinstance(p.content, str):
                    kept = [c if isinstance(c, str) else "(파일의 내용은 대화 기억에서 뺐다. 다시 보려면 view_file을 쓴다.)" for c in p.content]
                    p = replace(p, content="\n".join(kept))
                parts.append(p)
            message = replace(message, parts=parts)
        elif isinstance(message, ModelResponse) and any(isinstance(p, FilePart) for p in message.parts):
            # 모델이 만든 이미지는 이미 자료에 저장돼 있다. 기억에는 그 사실만 남긴다.
            parts = [TextPart(content="(이미지를 만들어 자료에 저장했다.)") if isinstance(p, FilePart) else p for p in message.parts]
            message = replace(message, parts=parts)
        out.append(message)
    return out


def save_history(path: Path, messages: list[ModelMessage]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(ModelMessagesTypeAdapter.dump_json(strip_files(messages)))
    tmp.replace(path)


def _call_ids(message: ModelMessage) -> set[str]:
    if not isinstance(message, ModelResponse):
        return set()
    return {p.tool_call_id for p in message.parts if isinstance(p, ToolCallPart)}


def _return_ids(message: ModelMessage) -> set[str]:
    if not isinstance(message, ModelRequest):
        return set()
    return {
        p.tool_call_id
        for p in message.parts
        if isinstance(p, (ToolReturnPart, RetryPromptPart)) and getattr(p, "tool_call_id", None)
    }


def sanitize_history(messages: list[ModelMessage]) -> list[ModelMessage]:
    """다음 실행에 넘겨도 안전한 지점까지만 남긴다.

    실행이 중간에 끊기면(중단 버튼, 오류, 사용자 확인 대기 중 취소) 이력 끝에
    짝이 맞지 않는 조각이 남는다. 제공자들은 '도구 호출에는 반드시 결과가
    따라와야 한다'는 규칙을 어기면 요청 자체를 거절하므로 여기서 잘라 낸다.
      - 결과가 없는(또는 일부만 있는) 도구 호출 응답 이후는 버린다.
      - 끝에 남은 빈 응답, 답을 받지 못한 사용자 요청은 버린다.
    """
    kept: list[ModelMessage] = []
    i = 0
    n = len(messages)
    while i < n:
        msg = messages[i]
        calls = _call_ids(msg)
        if calls:
            nxt = messages[i + 1] if i + 1 < n else None
            if nxt is None or not calls.issubset(_return_ids(nxt)):
                break
            kept.extend([msg, nxt])
            i += 2
            continue
        kept.append(msg)
        i += 1

    while kept:
        last = kept[-1]
        if isinstance(last, ModelResponse) and not last.parts:
            kept.pop()
            continue
        if isinstance(last, ModelRequest) and not _return_ids(last):
            # 모델이 답하지 못한 사용자 요청 — 남겨 두면 재시도할 때마다 같은 요청이 쌓인다.
            kept.pop()
            continue
        break
    return kept
