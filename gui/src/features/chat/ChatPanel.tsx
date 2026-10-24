import type { Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import type { useChat } from './useChat';
import Timeline from './Timeline';
import EmptyState from './EmptyState';
import Composer from './Composer';

/* Ronin Code — chat panel: scrollable timeline (or empty state), a calm
   subscription banner when a turn is blocked, and the composer. */

interface Props {
  chat: ReturnType<typeof useChat>;
  mode: Mode;
  enabledModels: string[];
  panelUrl: string;
  onOpenStarters: () => void;
  onOpenProject: () => void;
}

export default function ChatPanel({ chat, mode, enabledModels, panelUrl, onOpenStarters, onOpenProject }: Props) {
  const { t } = useLang();
  const isEmpty = chat.items.length === 0 && !chat.running;
  /* Retry is offered only on the newest error and only while idle —
     resending replays the last prompt. */
  const lastItem = chat.items[chat.items.length - 1];
  const retryItemId =
    !chat.running && lastItem?.kind === 'message' && lastItem.role === 'error' ? lastItem.id : null;
  const openPanel = () => {
    if (panelUrl) window.open(panelUrl, '_blank', 'noopener');
  };
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
            turnStartedAt={chat.turnStartedAt}
            activities={chat.activities}
            retryItemId={retryItemId}
            onRetry={chat.retryLast}
            onUndo={chat.undoChanges}
            onDecide={chat.decideApproval}
            onApprovePlan={chat.approvePlan}
            onRejectPlan={chat.rejectPlan}
          />
        )}
      </div>
      {chat.banner && (
        <div className="chat-banner" role="alert">
          <span className="chat-banner-text">
            {chat.banner === 'credit' ? t('picker.insufficientCredit') : t('picker.subscriptionLocked')}
          </span>
          <span className="chat-banner-actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={openPanel}>
              {chat.banner === 'credit' ? t('picker.buyCredit') : t('picker.openPanel')}
            </button>
            <button type="button" className="icon-btn" onClick={chat.dismissBanner} aria-label={t('app.dismiss')}>
              ×
            </button>
          </span>
        </div>
      )}
      <Composer
        input={chat.input}
        running={chat.running}
        textareaRef={chat.textareaRef}
        onChange={chat.onInputChange}
        onKeyDown={chat.onInputKeyDown}
        onSend={() => chat.send()}
        enabledModels={enabledModels}
        modelId={chat.modelId}
        activeModel={chat.activeModel}
        effort={chat.effort}
        effortOptions={chat.effortOptions}
        fast={chat.fast}
        fastAvailable={chat.fastAvailable}
        onSelectModel={chat.selectModel}
        onEffortChange={chat.setEffort}
        onFastChange={chat.setFast}
      />
    </section>
  );
}
