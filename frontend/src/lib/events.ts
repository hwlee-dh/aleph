import { formatTokens } from "./labels";
import type { Item, RunEvent } from "./types";

let counter = 0;
const nextKey = (prefix: string) => `${prefix}-${++counter}`;

/** 이벤트 하나를 대화 항목 목록에 반영한다. 원본 배열은 건드리지 않는다. */
export function applyEvent(items: Item[], e: RunEvent): Item[] {
  // 항목마다 그것을 만든 실행을 적어 둔다. 실행을 되돌렸을 때 그 실행의 항목만 골라 흐리게 하려는 것이다.
  const run = e.run_id;

  switch (e.type) {
    case "run_started":
      return [
        ...items,
        {
          kind: "run",
          key: nextKey("run"),
          run,
          runKind: e.kind === "tool" ? "tool" : "agent",
          trial: e.trial === true,
          mode: e.mode,
          model: e.agent_model,
          preset: e.preset_name,
          bypass: e.bypass_locks,
          at: e.timestamp,
        },
      ];

    case "user_message": {
      if (!e.in_reply_to)
        return [
          ...items,
          { kind: "user", key: nextKey("user"), run, text: e.text ?? "", tool: e.tool, toolLabel: e.tool_label, reply: false, steer: e.steer === true },
        ];
      // 질문·확인에 대한 내 답. 답은 그 요청 자리에 붙여 두고, 질문에 대한 답만 대화 줄로도 남긴다.
      const asked = items.find((it) => it.kind === "ask" && it.eventId === e.in_reply_to);
      const next = items.map((it) => (it.kind === "ask" && it.eventId === e.in_reply_to ? { ...it, answered: true, reply: e.text ?? "" } : it));
      if (asked && asked.kind === "ask" && asked.askKind !== "question") return next;
      return [...next, { kind: "user", key: nextKey("user"), run, text: e.text ?? "", reply: true }];
    }

    case "text_delta":
    case "thinking_delta": {
      const kind = e.type === "text_delta" ? "text" : "thinking";
      const key = `${kind}-${e.run_id ?? ""}-${e.id}`;
      const i = items.findIndex((it) => it.key === key);
      if (i === -1) return [...items, { kind, key, run, text: e.delta ?? "", streaming: true }];
      const cur = items[i] as Extract<Item, { kind: "text" | "thinking" }>;
      const copy = items.slice();
      copy[i] = { ...cur, text: cur.text + (e.delta ?? "") };
      return copy;
    }

    case "text":
    case "thinking": {
      const kind = e.type;
      const key = `${kind}-${e.run_id ?? ""}-${e.id ?? nextKey("p")}`;
      const done = { kind, key, run, text: e.text ?? "", streaming: false } as Item;
      const i = items.findIndex((it) => it.key === key);
      if (i === -1) return [...items, done];
      const copy = items.slice();
      copy[i] = done;
      return copy;
    }

    case "tool_call":
      return [
        ...items,
        {
          kind: "tool",
          key: `tool-${e.tool_call_id ?? nextKey("t")}`,
          run,
          tool: e.tool ?? "?",
          label: e.label ?? "",
          userTool: e.user_tool === true,
          args: e.args ?? {},
          index: e.tool_call_index,
          native: e.native === true,
          trial: e.trial === true,
          startedAt: e.timestamp,
        },
      ];

    case "tool_stream": {
      const key = `tool-${e.tool_call_id}`;
      const i = items.findIndex((it) => it.key === key);
      if (i === -1) return items;
      const cur = items[i] as Extract<Item, { kind: "tool" }>;
      const copy = items.slice();
      copy[i] = { ...cur, stream: (cur.stream ?? "") + (e.delta ?? "") };
      return copy;
    }

    case "tool_result": {
      const key = `tool-${e.tool_call_id}`;
      const i = e.tool_call_id ? items.findIndex((it) => it.key === key) : -1;
      if (i === -1) {
        // 호출 없이 결과만 오는 것이 있다 (모델이 만든 이미지: tool_call_id가 비어 있고 changed에 저장된 경로가 온다).
        // 그것도 한 줄로 남긴다. 그 밖의 짝 없는 결과는 버린다.
        if (e.tool_call_id || !e.tool) return items;
        return [
          ...items,
          {
            kind: "tool",
            key: nextKey("tool-lone"),
            run,
            tool: e.tool,
            label: e.label ?? "",
            userTool: false,
            args: {},
            native: e.native === true,
            result: e.result ?? "",
            ok: e.ok !== false,
            changed: e.changed ?? [],
            startedAt: e.timestamp,
            endedAt: e.timestamp,
          },
        ];
      }
      const cur = items[i] as Extract<Item, { kind: "tool" }>;
      const copy = items.slice();
      copy[i] = {
        ...cur,
        result: e.result ?? "",
        ok: e.ok !== false,
        changed: e.changed ?? [],
        trail: e.trail,
        rejected: e.rejected === true,
        // 표시는 호출과 결과 양쪽에 온다. 어느 한쪽에만 붙어 와도 놓치지 않는다.
        native: cur.native || e.native === true,
        trial: cur.trial || e.trial === true,
        endedAt: e.timestamp,
      };
      return copy;
    }

    case "user_input_required": {
      const askKind = e.kind === "proposal" || e.kind === "tool_confirm" ? e.kind : "question";
      return [
        ...items,
        {
          kind: "ask",
          key: `ask-${e.event_id}`,
          run,
          eventId: e.event_id ?? "",
          askKind,
          question: e.question ?? "",
          options: e.options ?? [],
          answered: false,
          tool: e.tool,
          label: e.label,
          input: e.input,
          proposal:
            askKind === "proposal"
              ? {
                  action: e.action ?? "write",
                  path: e.path ?? "",
                  dest: e.dest ?? null,
                  old: e.old ?? null,
                  next: e.new ?? null,
                  description: e.description ?? "",
                  by: e.by ?? "agent",
                  position: e.position,
                  pieces: e.pieces,
                  scenes: e.scenes,
                  query: e.query,
                  replacement: e.replacement,
                  items: e.items,
                }
              : undefined,
        },
      ];
    }

    case "user_input_resolved": {
      const asked = items.find((it) => it.kind === "ask" && it.eventId === e.event_id);
      const confirmed = asked?.kind === "ask" && asked.askKind === "tool_confirm" ? asked.tool : undefined;
      return items.map((it) => {
        if (it.kind === "ask" && it.eventId === e.event_id) return { ...it, answered: true, reply: it.reply ?? e.response };
        // 실행 확인을 기다린 시간은 도구가 돈 시간이 아니다. 걸린 시간은 확인이 풀린 때부터 잰다.
        if (confirmed && it.kind === "tool" && it.tool === confirmed && it.result === undefined && e.timestamp) return { ...it, startedAt: e.timestamp };
        return it;
      });
    }

    case "compaction": {
      const shrunk = e.tokens_before && e.tokens_after !== undefined ? ` (${formatTokens(e.tokens_before)} → ${formatTokens(e.tokens_after)} 토큰)` : "";
      // cleared: 오래된 도구 결과만 비웠다 (모델을 부르지 않았다). 작게 한 줄로 남긴다.
      if (e.kind === "cleared")
        return [...items, { kind: "note", key: nextKey("note"), run, tone: "info", text: `오래된 도구 결과 ${e.cleared_results ?? "?"}개를 비웠습니다${shrunk}` }];
      // summary: 앞부분을 요약으로 바꿨다. 요약은 펼쳐 볼 수 있다.
      // manual은 사용자가 `지금 압축`으로 돌린 것이다.
      const head = e.manual ? "대화를 압축했습니다" : "대화가 길어져 압축했습니다";
      return [
        ...items,
        {
          kind: "note",
          key: nextKey("note"),
          run,
          tone: "info",
          text: `${head}. 앞부분 ${e.dropped_messages ?? "?"}개 메시지를 요약으로 바꿨습니다${shrunk}`,
          detail: e.summary || undefined,
        },
      ];
    }

    case "notice":
      return [...items, { kind: "note", key: nextKey("note"), run, tone: e.level === "warning" ? "warn" : "info", text: e.text ?? "" }];

    case "error":
      return [...items, { kind: "note", key: nextKey("note"), run, tone: "error", text: e.error ?? "알 수 없는 오류" }];

    case "done": {
      // 끝났는데 아직 '쓰는 중'으로 남은 조각과 답 못 받은 질문을 정리한다.
      const settled = items.map((it) => {
        if ((it.kind === "text" || it.kind === "thinking") && it.streaming) return { ...it, streaming: false };
        if (it.kind === "ask" && !it.answered) return { ...it, answered: true };
        // 결과를 받지 못한 도구 호출(중단·오류)이 '진행 중'으로 남지 않게 한다.
        if (it.kind === "tool" && it.result === undefined) return { ...it, result: "실행이 끝나기 전에 멈췄습니다", ok: false };
        return it;
      });
      return [...settled, { kind: "done", key: nextKey("done"), run, event: e }];
    }

    case "reverted":
      // 기록은 지워지지 않고 이 이벤트만 끝에 붙는다. 그 실행의 항목들에 표시해 두면 화면이 흐리게 그린다.
      if (!e.target_run_id) return items;
      return items.map((it) => (it.run === e.target_run_id ? { ...it, reverted: true } : it));

    case "conversation_reset":
      return [...items, { kind: "reset", key: nextKey("reset") }];

    default:
      return items;
  }
}

export function buildItems(events: RunEvent[]): Item[] {
  return events.reduce(applyEvent, [] as Item[]);
}
