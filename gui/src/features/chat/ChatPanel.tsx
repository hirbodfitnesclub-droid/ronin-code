import type { Mode } from '../../lib/api';
import type { useChat } from './useChat';
import Timeline from './Timeline';
import EmptyState from './EmptyState';
import Composer from './Composer';

/* Ronin Code — chat panel: scrollable timeline (or empty state) + composer. */

interface Props {
  chat: ReturnType<typeof useChat>;
  mode: Mode;
  onOpenStarters: () => void;
  onOpenProject: () => void;
}

export default function ChatPanel({ chat, mode, onOpenStarters, onOpenProject }: Props) {
  const isEmpty = chat.items.length === 0 && !chat.running;
  return (
    <section className="chat-panel">
      <div className="chat-scroll" ref={chat.scrollRef}>
        {isEmpty ? (
          <EmptyState
            mode={mode}
            onOpenStarters={onOpenStarters}
            onOpenProject={onOpenProject}
            onSendExample={(text) => chat.send(text)}
          />
        ) : (
          <Timeline
            items={chat.items}
            mode={mode}
            running={chat.running}
            activities={chat.activities}
            onUndo={chat.undoChanges}
            onDecide={chat.decideApproval}
            onApprovePlan={chat.approvePlan}
            onRejectPlan={chat.rejectPlan}
          />
        )}
      </div>
      <Composer
        input={chat.input}
        running={chat.running}
        textareaRef={chat.textareaRef}
        onChange={chat.onInputChange}
        onKeyDown={chat.onInputKeyDown}
        onSend={() => chat.send()}
      />
    </section>
  );
}
