import { useEffect, useReducer, useState } from 'react';
import type { ActivityKind, Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import { formatElapsed } from '../../lib/format';
import { looksLikeRawHtml } from '../../lib/turnErrors';
import type { TimelineItem } from './types';
import ActivityVisual from '../../components/ui/ActivityVisual';
import RichText from '../../components/ui/RichText';
import ChangesCard from '../changes/ChangesCard';
import ApprovalCard from '../approvals/ApprovalCard';
import PlanCard from '../plan/PlanCard';

/* Ronin Code — the message timeline (RDX-04). Clear user/agent
   hierarchy; long agent answers collapse behind show more/less; a
   running turn shows ONE activity card — visual motion only, plus
   the real elapsed time; errors are human cards with a retry when
   retrying makes sense. Feature cards render inline in stream order.
   (Documented FSD deviation: the timeline is the host widget that
   composes the leaf cards; cards never import the chat back.) */

const LONG_MESSAGE = 600;

interface Props {
  items: TimelineItem[];
  mode: Mode;
  running: boolean;
  turnStartedAt: number | null;
  activities: Array<{ id: string; kind: ActivityKind }>;
  retryItemId: number | null;
  onRetry: () => void;
  onUndo: (itemId: number) => void;
  onDecide: (approvalId: string, approved: boolean) => void;
  onApprovePlan: (planId: string) => void;
  onRejectPlan: (planId: string) => void;
}

/** Live turn clock — real measured elapsed time, ticking. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="activity-elapsed" dir="ltr">
      {formatElapsed(Date.now() - startedAt)}
    </span>
  );
}

function AssistantText({ text }: { text: string }) {
  const { t } = useLang();
  const [expanded, setExpanded] = useState(false);
  if (text.length <= LONG_MESSAGE) return <RichText text={text} />;
  return (
    <div className={`msg-collapsible ${expanded ? '' : 'msg-collapsible--collapsed'}`}>
      <RichText text={text} />
      <button type="button" className="msg-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? t('chat.showLess') : t('chat.showMore')}
      </button>
    </div>
  );
}

function ErrorCard({ text, canRetry, onRetry }: { text: string; canRetry: boolean; onRetry: () => void }) {
  const { t } = useLang();
  return (
    <div className="msg msg--error">
      <div className="msg-bubble error-card">
        <p>{text}</p>
        {canRetry && (
          <div className="error-card-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
              {t('chat.retry')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Timeline(p: Props) {
  const { t } = useLang();
  return (
    <div className="messages">
      {p.items.map((item) => {
        if (item.kind === 'changes') {
          return (
            <ChangesCard
              key={item.id}
              files={item.files}
              mode={p.mode}
              undoing={item.undoing}
              undone={item.undone}
              costUsd={item.costUsd}
              costEstimated={item.costEstimated}
              durationMs={item.durationMs}
              onUndo={() => void p.onUndo(item.id)}
            />
          );
        }
        if (item.kind === 'approval') {
          return (
            <ApprovalCard
              key={item.id}
              kind={item.approvalKind}
              detail={item.detail}
              resolved={item.resolved}
              onDecide={(approved) => void p.onDecide(item.approvalId, approved)}
            />
          );
        }
        if (item.kind === 'plan') {
          return (
            <PlanCard
              key={item.id}
              task={item.task}
              steps={item.steps}
              status={item.status}
              onApprove={() => void p.onApprovePlan(item.planId)}
              onReject={() => void p.onRejectPlan(item.planId)}
            />
          );
        }
        /* Last line of defence: a raw HTML payload (a fetched or
           provider error page) is never rendered as message content,
           whatever produced the item — it shows as the localised
           generic turn error in the error slot instead. */
        if (item.kind === 'message' && looksLikeRawHtml(item.text)) {
          return (
            <ErrorCard
              key={item.id}
              text={t('app.genericTurnError')}
              canRetry={item.id === p.retryItemId}
              onRetry={p.onRetry}
            />
          );
        }
        if (item.kind === 'message' && item.role === 'error') {
          return (
            <ErrorCard key={item.id} text={item.text} canRetry={item.id === p.retryItemId} onRetry={p.onRetry} />
          );
        }
        return (
          <div key={item.id} className={`msg msg--${item.role}`}>
            <div className="msg-bubble">
              {item.role === 'assistant' ? (
                <AssistantText text={item.text} />
              ) : (
                item.text.split('\n').map((line, i) => <p key={i}>{line || ' '}</p>)
              )}
            </div>
          </div>
        );
      })}
      {p.running && (
        <div className="msg msg--assistant">
          <div className="activity-card">
            <ActivityVisual kinds={p.activities.map((a) => a.kind)} />
            {p.turnStartedAt && <Elapsed startedAt={p.turnStartedAt} />}
          </div>
        </div>
      )}
    </div>
  );
}
