import type { ApprovalDetail } from '../../lib/api';
import { useLang } from '../../lib/i18n';

interface Props {
  kind: 'command' | 'write_outside';
  detail: ApprovalDetail;
  resolved: boolean | null; // null = still waiting
  onDecide: (approved: boolean) => void;
}

/** Minimal visual approval card — the agent is paused until the user decides. */
export default function ApprovalCard({ kind, detail, resolved, onDecide }: Props) {
  const { t } = useLang();
  return (
    <section className="approval-card" aria-label={kind === 'command' ? t('approval.titleCommand') : t('approval.titleWrite')}>
      <div className="approval-title">
        <span className="approval-pulse" aria-hidden="true" />
        {kind === 'command' ? t('approval.titleCommand') : t('approval.titleWrite')}
      </div>
      {kind === 'command' && detail.command && (
        <p className="approval-command" dir="ltr">{detail.command}</p>
      )}
      {kind === 'write_outside' && detail.path && (
        <p className="approval-path" dir="ltr">{detail.path}</p>
      )}
      {resolved === null ? (
        <>
          <div className="approval-actions">
            <button type="button" className="btn btn--primary" onClick={() => onDecide(true)}>
              {t('approval.allow')}
            </button>
            <button type="button" className="btn btn--danger-ghost" onClick={() => onDecide(false)}>
              {t('approval.deny')}
            </button>
          </div>
          <p className="approval-hint">{t('approval.hint')}</p>
        </>
      ) : (
        <p className="approval-hint">{resolved ? '✓' : '✕'}</p>
      )}
    </section>
  );
}
