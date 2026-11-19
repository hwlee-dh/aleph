"""제작 과정 기록 — 작업에 쌓인 기록을 한 편의 Markdown 문서로 엮는다.

실행 설정(runs.jsonl), 이벤트 흐름(events.jsonl), 도구 내부 호출(tool_calls.jsonl)을
읽어 "어떤 설정과 개입이 이 텍스트를 만들었는가"를 실행 순서대로 재구성한다.
지침과 도구 프롬프트는 자르지 않고 접어서 싣는다 — 재구성 가능성이 이 문서의 목적이다.
"""

from __future__ import annotations

from collections import Counter

from .workspace.store import SessionStore

_MAX_ARGS = 800
_MAX_RESULT = 600
_MAX_TEXT = 2000

_MODE_LABEL = {"manual": "수동", "auto": "자동", "autonomous": "자율", "plan": "계획"}
_STATUS_LABEL = {"completed": "완료", "stopped": "사용자가 중단", "stalled": "같은 호출이 되풀이되어 중단",
                 "interrupted": "서버가 꺼져서 끊김", "error": "오류로 종료"}
_THINKING_LABEL = {"default": "기본", "off": "끔", "low": "낮음", "medium": "보통", "high": "높음"}


def _truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f" … (이하 {len(text) - limit}자 생략)"


def _fmt_ts(iso: str | None) -> str:
    if not iso:
        return "(시각 미상)"
    return str(iso).replace("T", " ")[:16]


def _segments(events: list[dict]) -> list[dict]:
    """이벤트를 실행(run_id) 단위로 묶는다. 순서는 처음 등장한 순서.

    실행에 속하지 않는 이벤트(손으로 돌린 압축, 대화 비우기, 되돌리기)는 실행이 아니다.
    그 자리에 `run_id`가 None인 묶음으로 따로 둔다.
    """
    segments: list[dict] = []
    by_run: dict[str, dict] = {}
    for ev in events:
        rid = ev.get("run_id")
        if not rid:
            if segments and segments[-1]["run_id"] is None:
                segments[-1]["events"].append(ev)
            else:
                segments.append({"run_id": None, "events": [ev]})
            continue
        if rid not in by_run:
            by_run[rid] = {"run_id": rid, "events": []}
            segments.append(by_run[rid])
        by_run[rid]["events"].append(ev)
    return segments


def _prompts_key(m: dict) -> str:
    """지침과 도구 지시문이 앞의 실행과 같은지 견줄 때 쓰는 값."""
    import json

    tools = [t for t in m.get("tools", []) if t.get("enabled", True)]
    return json.dumps(
        [m.get("instruction"), m.get("base_instruction"), m.get("mode_instruction"), tools], ensure_ascii=False, sort_keys=True,
    )


def _render_config(m: dict | None, same_as: int | None = None, conversation: str = "") -> list[str]:
    """실행 하나의 설정. same_as를 주면 지침과 도구 지시문의 전문을 싣지 않고 그 번호의 실행과 같다고만 적는다."""
    if not m:
        return ["> 이 실행의 설정 기록이 없다.", ""]
    tools = [t for t in m.get("tools", []) if t.get("enabled", True)]
    tool_names = ", ".join(
        f"{t.get('label') or t.get('name', '?')}({t.get('model') or '보조 모델'})" for t in tools
    ) or "없음"
    a_temp, x_temp = m.get("agent_temperature"), m.get("auxiliary_temperature")
    if m.get("kind") == "tool":
        tool = next((t for t in tools if t.get("name") == m.get("tool")), {})
        lines = [
            f"- 사용자가 도구를 직접 돌림: {tool.get('label') or m.get('tool') or '미상'}",
            f"- 프리셋: {m.get('preset_name') or m.get('preset_id') or '미상'}",
            f"- 모델: `{tool.get('model') or m.get('auxiliary_model') or m.get('agent_model', '미상')}`",
        ]
    else:
        lines = [
            *([f"- 대화: {conversation}"] if conversation else []),
            f"- 프리셋: {m.get('preset_name') or m.get('preset_id') or '미상'}",
            f"- 모드: {_MODE_LABEL.get(m.get('mode') or '', m.get('mode') or '미상')}"
            + (" (권한 무시 켬)" if m.get("bypass_locks") else ""),
            f"- 에이전트 모델: `{m.get('agent_model', '미상')}` / 보조 모델: `{m.get('auxiliary_model', '미상')}`",
            f"- 온도: 에이전트 {a_temp if a_temp is not None else '기본값'} / 보조 {x_temp if x_temp is not None else '기본값'}",
            f"- 추론 수준: 에이전트 {_THINKING_LABEL.get(m.get('thinking', 'default'), m.get('thinking'))}"
            f" / 보조 {_THINKING_LABEL.get(m.get('auxiliary_thinking', 'default'), m.get('auxiliary_thinking'))}",
            f"- 컨텍스트 한도: {m.get('context_budget', '?')} 토큰"
            + ("" if m.get("auto_compact", True) else " (자동 압축 끔)"),
            f"- 도구: {tool_names}",
        ]
        if m.get("tool"):
            lines.append(f"- 사용자가 지정한 도구: `{m['tool']}`")
    if same_as is not None:
        return lines + ["", f"지침과 도구 지시문은 실행 {same_as}과 같다.", ""]
    lines += ["", "<details>", "<summary>지침과 도구 지시문 (전문)</summary>", "", "**지침**", "", "```text",
              (m.get("instruction") or "(비어 있음)").strip(), "```"]
    fixed = "\n\n".join(s.strip() for s in (m.get("base_instruction"), m.get("mode_instruction")) if s)
    if fixed:
        lines += ["", "**앱이 지침 앞에 붙이는 글** (프리셋과 무관하고 화면에는 보이지 않는다)", "", "```text", fixed, "```"]
    for t in tools:
        lines += [
            "",
            f"**도구 {t.get('label') or t.get('name', '?')}** (`{t.get('name', '?')}`)",
            "",
            f"- 모델: `{t.get('model') or '보조 모델'}`",
            f"- 에이전트에게 보이는 설명: {(t.get('description') or '').strip()}",
            "",
            "```text",
            (t.get("prompt") or "(비어 있음)").strip(),
            "```",
        ]
    lines += ["", "</details>", ""]
    return lines


def _args_str(args) -> str:
    if isinstance(args, dict):
        return "; ".join(f"{k}={v}" for k, v in args.items())
    return str(args)


def _render_trace(events: list[dict], inner: dict[str, list[dict]] | None = None) -> list[str]:
    """이벤트를 차례로 적는다. inner는 도구 호출 id → 그 호출 안에서 일어난 일(도구 실행 기록의 항목들)."""
    lines: list[str] = []
    inner = inner or {}
    for ev in events:
        t = ev.get("type")
        if t == "user_message":
            who = "사용자 응답" if ev.get("in_reply_to") else "사용자"
            lines.append(f"- **{who}**: {_truncate(ev.get('text', ''), _MAX_TEXT)}")
        elif t == "text":
            text = _truncate(ev.get("text", ""), _MAX_TEXT)
            if text:
                lines.append(f"- **에이전트**: {text}")
        elif t == "tool_call":
            idx = ev.get("tool_call_index")
            lines.append(f"- **도구 호출** {f'[{idx}] ' if idx else ''}`{ev.get('tool', '?')}`")
            args = _truncate(_args_str(ev.get("args", {})), _MAX_ARGS)
            if args:
                lines.append(f"  - 인자: {args}")
        elif t == "tool_result":
            result = _truncate(ev.get("result", ""), _MAX_RESULT)
            if result:
                lines.append(f"  - 결과: {result}")
            for e in inner.get(ev.get("tool_call_id") or "", []):
                if e.get("target"):       # 묶음 요약이 장면마다 돌린 것
                    said = _truncate(e.get("output") or "", 400) or f"(실패: {e.get('error') or '빈 결과'})"
                    lines.append(f"  - {e['target']} (`{e.get('model', '?')}`): {said}")
                elif e.get("trail"):      # 읽기 에이전트가 본 것
                    lines.append(f"  - 읽기 에이전트가 본 것 (`{e.get('model', '?')}`): {', '.join(e['trail'])}")
        elif t == "user_input_required":
            label = {"proposal": "문서 변경 확인", "tool_confirm": "도구 실행 확인"}.get(ev.get("kind"), "질문")
            opts = ev.get("options") or []
            opt_str = f" (선택지: {', '.join(map(str, opts))})" if opts else ""
            lines.append(f"- **{label}**: {_truncate(ev.get('question', ''), _MAX_RESULT)}{opt_str}")
        elif t == "compaction":
            by = "사용자가 `지금 압축`을 눌러" if ev.get("manual") else "대화가 컨텍스트 한도를 넘어"
            size = f" ({ev.get('tokens_before', '?')} → {ev.get('tokens_after', '?')} 토큰)"
            if ev.get("kind") == "cleared":
                lines.append(f"- _대화 압축: {by} 오래된 도구 결과 {ev.get('cleared_results', '?')}개를 비웠다{size}_")
            else:
                lines.append(f"- _대화 압축: {by} 앞선 메시지 {ev.get('dropped_messages', '?')}개를 요약으로 바꿨다{size}_")
                if ev.get("summary"):
                    # 이 뒤로 에이전트가 기억하는 앞부분은 이 글이 전부다
                    lines += ["", "  <details>", "  <summary>요약 (이 뒤로 에이전트가 앞부분 대신 들고 있는 글)</summary>", "",
                              "  ```text", *("  " + s for s in _truncate(ev["summary"], 6000).splitlines()), "  ```", "  </details>", ""]
        elif t == "reverted":
            back = ", ".join(ev.get("reverted") or []) or "없음"
            lines.append(f"- _되돌리기: 사용자가 바로 앞의 실행이 바꾼 것을 되돌렸다. 되돌린 문서: {back}_")
        elif t == "notice":
            lines.append(f"- _알림: {_truncate(ev.get('text', ''), _MAX_RESULT)}_")
        elif t == "error":
            lines.append(f"- **오류**: {_truncate(ev.get('error', ''), _MAX_RESULT)}")
        elif t == "done":
            usage = ev.get("usage") or {}
            summary = (
                f"- _실행 종료 ({_STATUS_LABEL.get(ev.get('status'), ev.get('status', '?'))}): "
                f"도구 호출 {ev.get('total_tool_calls', '?')}회, 소요 {ev.get('elapsed_sec', '?')}초"
            )
            if usage.get("prompt_tokens") is not None:
                summary += f", 에이전트 토큰 {usage['prompt_tokens']:,}(입력)+{usage.get('output_tokens', 0):,}(출력)"
            if usage.get("cost_usd") is not None:
                summary += f", 추정 비용 ${usage['cost_usd']:.4f}"
            lines.append(summary + "_")
    return lines or ["- (기록된 진행 이벤트 없음)"]


def _tool_stats(store: SessionStore, session_id: str) -> tuple[list[str], float, bool]:
    entries = store.read_tool_call_log(session_id)
    if not entries:
        return [], 0.0, True
    counts: Counter = Counter()
    tokens: Counter = Counter()
    duration: Counter = Counter()
    cost: dict[str, float] = {}
    complete = True
    for e in entries:
        tool = e.get("tool", "?")
        usage = e.get("usage") or {}
        counts[tool] += 1
        tokens[tool] += int(usage.get("total_tokens") or 0)
        duration[tool] += int(e.get("duration_ms") or 0)
        if usage.get("cost_usd") is not None:
            cost[tool] = cost.get(tool, 0.0) + float(usage["cost_usd"])
        elif usage:
            complete = False
    lines = ["## 부록 A. 도구 내부 호출 통계", "",
             "대괄호로 묶인 항목은 엔진이 보조 모델로 한 호출(대화 압축, 읽기 에이전트)이다.", "",
             "| 도구 | 호출 수 | 총 토큰 | 총 소요(초) | 추정 비용(USD) |", "| --- | ---: | ---: | ---: | ---: |"]
    for tool in sorted(counts, key=lambda t: -counts[t]):
        c = cost.get(tool)
        lines.append(
            f"| `{tool}` | {counts[tool]} | {tokens[tool]:,} | {duration[tool] / 1000:.1f} | "
            f"{f'${c:.4f}' if c is not None else '—'} |"
        )
    lines.append("")
    return lines, sum(cost.values()), complete


def compile_process_log(store: SessionStore, session_id: str) -> str:
    meta = store.meta(session_id)
    name = meta.get("name") or session_id[:8]
    runs = store.read_runs(session_id)
    events = store.read_events(session_id)
    manifests = {m.get("run_id"): m for m in runs if m.get("run_id")}
    segments = _segments(events)
    run_count = sum(1 for s in segments if s["run_id"])
    conversations = {c["id"]: c for c in store.conversations(session_id)}
    # 도구 호출 안에서 일어난 일: 묶음 요약이 장면마다 돌린 것, 읽기 에이전트가 본 것
    inner: dict[str, list[dict]] = {}
    for e in store.read_tool_call_log(session_id):
        if e.get("tool_call_id") and (e.get("target") or e.get("trail")):
            inner.setdefault(e["tool_call_id"], []).append(e)

    stamps = [ev.get("timestamp") for ev in events if ev.get("timestamp")]
    total_calls = sum(1 for ev in events if ev.get("type") == "tool_call")
    modes: Counter = Counter(m.get("mode") for m in runs)
    models = sorted({m.get("agent_model") for m in runs if m.get("agent_model")})

    p_total = o_total = 0
    agent_cost = 0.0
    cost_known = True
    for ev in events:
        if ev.get("type") != "done":
            continue
        usage = ev.get("usage") or {}
        p_total += usage.get("prompt_tokens") or 0
        o_total += usage.get("output_tokens") or 0
        if usage.get("cost_usd") is not None:
            agent_cost += float(usage["cost_usd"])
        elif usage.get("prompt_tokens"):
            cost_known = False

    appendix, tool_cost, tool_cost_known = _tool_stats(store, session_id)

    out = [
        f"# 제작 과정 기록 — {name}", "",
        f"- 작업 ID: `{session_id}`",
    ]
    if meta.get("created_at"):
        out.append(f"- 작업 생성: {_fmt_ts(meta['created_at'])}")
    out += [
        f"- 기록 구간: {_fmt_ts(stamps[0]) if stamps else '(기록 없음)'} ~ {_fmt_ts(stamps[-1]) if stamps else '(기록 없음)'}",
        f"- 총 실행: {run_count}회 / 총 도구 호출: {total_calls}회",
        *([f"- 대화: {len(conversations)}개 (대화마다 에이전트의 기억이 따로다. 한 대화의 에이전트는 다른 대화에서 오간 말을 모르고, 작업 공간에 적힌 것만 본다)"]
          if len(conversations) > 1 else []),
        "",
        "이 문서는 ALEPH로 텍스트를 제작한 과정을 자동으로 정리한 기록이다. 각 실행에 적용된 설정"
        "(지침·모드·모델·도구)과 에이전트-사용자 상호작용을 실행 순서대로 담아, 결과 텍스트가 어떤 절차와 "
        "개입을 거쳐 산출되었는지를 재구성한다.", "",
        "## 제작 환경 개요", "",
    ]
    if models:
        out.append("- 사용 에이전트 모델: " + ", ".join(f"`{m}`" for m in models))
    if modes:
        out.append("- 모드 분포: " + " / ".join(f"{_MODE_LABEL.get(k, k)} {v}회" for k, v in modes.most_common()))
    out.append(f"- 총 토큰: 에이전트 {p_total + o_total:,} (입력 {p_total:,} / 출력 {o_total:,})")
    cost_line = f"- 추정 비용: ${agent_cost + tool_cost:.4f} USD (에이전트 ${agent_cost:.4f} + 도구 ${tool_cost:.4f})"
    if not (cost_known and tool_cost_known):
        cost_line += " — 단가를 알 수 없는 모델의 호출은 빠져 있어 실제보다 적다"
    out += [cost_line, "  - 공개 단가 기준의 추정치이며 실제 청구액과 다를 수 있다.", "", "## 실행 기록", ""]

    def conversation_of(seg: dict, m: dict | None) -> str:
        """대화가 여럿일 때만, 이 묶음이 어느 대화의 것인지."""
        if len(conversations) < 2:
            return ""
        cid = (m or {}).get("conversation") or next((e.get("conversation_id") for e in seg["events"] if e.get("conversation_id")), "main")
        name = (conversations.get(cid) or {}).get("name") or ("(지운 대화)" if cid not in conversations else "(이름 없음)")
        return f"{_truncate(name, 60)} (`{cid}`)"

    number = 0
    seen_prompts: dict[str, int] = {}
    for seg in segments:
        if seg["run_id"] is None:   # 실행 밖에서 일어난 일
            where = conversation_of(seg, None)
            out += [f"### 실행 사이 — {_fmt_ts(seg['events'][0].get('timestamp'))}" + (f" · 대화: {where}" if where else ""), ""]
            out += _render_trace(seg["events"], inner)
            out.append("")
            continue
        number += 1
        m = manifests.get(seg["run_id"])
        goal = (m or {}).get("goal") or next(
            (e.get("text") for e in seg["events"] if e.get("type") == "user_message"), "(목표 미상)"
        )
        out += [f"### 실행 {number} — {_truncate(goal, 120)}", ""]
        key = _prompts_key(m) if m else ""
        out += _render_config(m, same_as=seen_prompts.get(key) if key else None, conversation=conversation_of(seg, m))
        if key:
            seen_prompts.setdefault(key, number)
        out += ["**진행**", ""]
        out += _render_trace(seg["events"], inner)
        out.append("")

    out += appendix
    return "\n".join(out).rstrip() + "\n"
