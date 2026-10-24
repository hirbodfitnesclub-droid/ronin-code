import type { ActivityKind, Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import { looksLikeRawHtml } from '../../lib/turnErrors';
import type { TimelineItem } from './types';
import ActivityVisual from '../../components/ui/ActivityVisual';
import RichText from '../../components/ui/RichText';
import ChangesCard from '../changes/ChangesCard';
import ApprovalCard from '../approvals/ApprovalCard';
import PlanCard from '../plan/PlanCard';

/* Ronin Code — the message timeline. Renders message bubbles plus the
   feature cards (changes / approval / plan) inline in stream order.
   (Documented FSD deviation: the timeline is the host widget that
   composes the leaf cards; cards never import the chat back.) */

interface Props {
  items: TimelineItem[];
  mode: Mode;
  running: boolean;
  activities: Array<{ id: string; kind: ActivityKind }>;
  onUndo: (itemId: number) => void;
  onDecide: (approvalId: string, approved: boolean) => void;
  onApprovePlan: (planId: string) => void;
  onRejectPlan: (planId: string) => void;
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
            <div key={item.id} className="msg msg--error">
              <div className="msg-bubble">
                <p>{t('app.genericTurnError')}</p>
              </div>
            </div>
          );
        }
        return (
          <div key={item.id} className={`msg msg--${item.role}`}>
            <div className="msg-bubble">
              {item.role === 'assistant' ? (
                <RichText text={item.text} />
              ) : (
                item.text.split('\n').map((line, i) => <p key={i}>{line || ' '}</p>)
              )}
            </div>
          </div>
        );
      })}
      {p.running && (
        <div className="msg msg--assistant">
          <ActivityVisual kinds={p.activities.map((a) => a.kind)} />
        </div>
      )}
    </div>
  );
}
