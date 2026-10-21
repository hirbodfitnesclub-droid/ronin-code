import type { PlanStep } from '../api';
import { useLang } from '../i18n';

interface Props {
  task: string;
  steps: PlanStep[];
  status: 'pending' | 'building' | 'done' | 'rejected';
  onApprove: () => void;
  onReject: () => void;
}

/** The plan as a visual step checklist — steps tick off live while building. */
export default function PlanCard({ task, steps, status, onApprove, onReject }: Props) {
  const { t } = useLang();
  return (
    <section className="plan-card" aria-label={t('plan.title')}>
      <div className="plan-title">
        <span className="plan-spark" aria-hidden="true" />
        {t('plan.title')}
      </div>
      <p className="plan-task">{task}</p>
      <ol className="plan-steps">
        {steps.map((s, i) => (
          <li key={i} className={`plan-step-item plan-step-item--${s.state ?? (status === 'done' ? 'done' : 'pending')}`}>
            <span className="plan-step-node">
              <span className="plan-step-num">{i + 1}</span>
            </span>
            <span className="plan-step-text">
              <span className="plan-step-name">{s.title}</span>
              {s.detail && <span className="plan-step-detail">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {status === 'pending' && (
        <>
          <div className="plan-actions">
            <button type="button" className="btn btn--primary" onClick={onApprove}>
              {t('plan.approve')}
            </button>
            <button type="button" className="btn btn--danger-ghost" onClick={onReject}>
              {t('plan.reject')}
            </button>
          </div>
          <p className="approval-hint">{t('plan.editHint')}</p>
        </>
      )}
      {status === 'building' && <p className="approval-hint">{t('plan.building')}</p>}
    </section>
  );
}
