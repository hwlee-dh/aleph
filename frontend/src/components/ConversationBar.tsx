import { useEffect, useState } from "react";
import { formatWhen } from "../lib/labels";
import type { Conversation } from "../lib/types";
import { useStore } from "../store";
import { Chevron, NewChatIcon, PencilIcon, TrashIcon } from "./icons";
import { InlineInput } from "./left/parts";
import { Button, IconButton, Popover, Tag } from "./ui";

/** 이름이 빈 대화는 아직 한 번도 보내지 않은 대화다. */
const nameOf = (c: Conversation | undefined) => c?.name || "새 대화";

/**
 * 대화 위의 가는 줄: 보고 있는 대화의 이름(누르면 이 작업의 대화 목록)과 `새 대화`.
 * 작업이 주인공이고 대화는 그 안의 것이라, 글자 한 줄로만 두고 눈에 띄지 않게 한다.
 * 문서와 원고, 프리셋은 작업의 것이라 대화를 바꿔도 그대로다. 바뀌는 것은 기록과 에이전트의 기억이다.
 */
export function ConversationBar() {
  const conversations = useStore((s) => s.conversations);
  const conversationId = useStore((s) => s.conversationId);
  // 다른 대화에서 도는 중이면 이름 옆에 점을 찍는다 (이 대화에서 도는 것은 채팅창 위의 상태 줄이 알린다).
  const elsewhere = useStore((s) => s.running && s.runConversation !== s.conversationId);
  const newConversation = useStore((s) => s.newConversation);
  if (!conversationId) return null;
  const current = conversations.find((c) => c.id === conversationId);

  return (
    <div className="mx-auto flex h-9 w-full max-w-[780px] shrink-0 items-center gap-1 px-3">
      <div className="min-w-0">
        <Popover
          className="w-80 max-w-[calc(100vw-32px)]"
          trigger={(open, toggle) => (
            <button
              type="button"
              title="대화"
              aria-haspopup="true"
              aria-expanded={open}
              onClick={toggle}
              className="flex h-7 max-w-full items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-[13px] text-muted hover:bg-sunken hover:text-ink"
            >
              <span className="min-w-0 truncate">{nameOf(current)}</span>
              {conversations.length > 1 && <span className="shrink-0 text-xs text-edge">{conversations.length}</span>}
              {elsewhere && <span className="pulse h-1.5 w-1.5 shrink-0 rounded-full bg-agent" />}
              <span className="shrink-0">
                <Chevron up={open} />
              </span>
            </button>
          )}
        >
          {(close) => <ConversationList close={close} />}
        </Popover>
      </div>
      <span className="flex-1" />
      <IconButton label="새 대화" onClick={() => void newConversation()}>
        <NewChatIcon />
      </IconButton>
    </div>
  );
}

/** 이 작업의 대화들. 고르기, 이름 바꾸기, 지우기. 최근에 기록이 붙은 것이 위다. */
function ConversationList({ close }: { close: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const conversationId = useStore((s) => s.conversationId);
  const runAt = useStore((s) => (s.running ? s.runConversation : null));
  const select = useStore((s) => s.selectConversation);
  const rename = useStore((s) => s.renameConversation);
  const remove = useStore((s) => s.deleteConversation);
  const refresh = useStore((s) => s.refreshConversations);
  const [editing, setEditing] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null); // 지우기를 한 번 누른 대화

  // 목록은 열 때마다 새로 받는다 (다른 대화의 고친 때와 실행 표시가 바뀌었을 수 있다).
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3500);
    return () => clearTimeout(t);
  }, [armed]);

  const sorted = [...conversations].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));

  return (
    <div className="flex flex-col">
      {sorted.map((c) => {
        const current = c.id === conversationId;
        const running = c.running || c.id === runAt;
        if (editing === c.id)
          return (
            <div key={c.id} className="px-1 py-0.5">
              <InlineInput
                initial={c.name}
                label="대화 이름"
                placeholder="이름"
                onCancel={() => setEditing(null)}
                onCommit={(name) => {
                  setEditing(null);
                  if (name && name !== c.name) void rename(c.id, name);
                }}
              />
            </div>
          );
        return (
          <div key={c.id} className="group/row flex items-center rounded-md pr-1 hover:bg-sunken">
            <button
              type="button"
              aria-current={current ? "true" : undefined}
              onClick={() => {
                close();
                void select(c.id);
              }}
              className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent py-1.5 pr-1 pl-2.5 text-left text-[13px]"
            >
              <span className={`min-w-0 flex-1 truncate ${current ? "font-bold text-blue" : c.name ? "text-ink" : "text-muted"}`}>{nameOf(c)}</span>
              {running && <Tag tone="agent">실행 중</Tag>}
              <span className="shrink-0 text-xs text-muted group-hover/row:hidden group-has-[:focus-visible]/row:hidden">{formatWhen(c.updated_at)}</span>
            </button>
            {armed === c.id ? (
              <Button
                small
                variant="danger"
                className="!border-danger"
                onClick={() => {
                  setArmed(null);
                  void remove(c.id);
                }}
              >
                삭제 확인
              </Button>
            ) : (
              <span className="hidden items-center group-hover/row:flex group-has-[:focus-visible]/row:flex">
                <IconButton label="이름 바꾸기" className="hover:!bg-hair" onClick={() => setEditing(c.id)}>
                  <PencilIcon />
                </IconButton>
                {/* 실행 중인 대화는 지울 수 없다. 지우면 그 기록과 에이전트의 기억이 없어진다 (문서와 원고는 그대로). */}
                <IconButton label="삭제" title={running ? "실행 중에는 삭제할 수 없습니다" : "삭제"} className="hover:!bg-hair" disabled={running} onClick={() => setArmed(c.id)}>
                  <TrashIcon />
                </IconButton>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
