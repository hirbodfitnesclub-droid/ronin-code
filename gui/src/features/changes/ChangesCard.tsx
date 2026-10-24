import { useState } from 'react';
import { api, type ChangedFile, type DiffFile, type Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import { formatElapsed } from '../../lib/format';
import { parseDiffLines } from '../../lib/diff';

/* Ronin Code — turn summary card (RDX-06): what the turn changed,
   grouped by what really happened (new / edited — the host snapshot
   diff produces exactly these two actions; deletions are not
   detected, so no group is invented for them). Every number on the
   card is real: file counts, the measured turn duration, the metered
   cost. Actions: Undo, the real diff, save a checkpoint. No per-file
   approve/reject and no +/− line stats exist in the host API, so
   neither is shown. */

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

interface Props {
  files: ChangedFile[];
  mode: Mode;
  onUndo: () => void;
  undoing: boolean;
  undone: boolean;
  costUsd?: number;
  costEstimated?: boolean;
  durationMs?: number;
}

function DiffBlock({ file }: { file: DiffFile }) {
  const { t } = useLang();
  if (file.diff === null) {
    return (
      <div className="diff-file">
        <div className="diff-file-head">{file.path}</div>
        <p className="diff-note">{t('changes.largeFile')}</p>
      </div>
    );
  }
  if (!file.diff) return null;
  const lines = parseDiffLines(file.diff);
  return (
    <div className="diff-file">
      <div className="diff-file-head">{file.path}</div>
      <pre className="diff-body">
        {lines.map((line, i) => {
          const cls =
            line.kind === 'add'
              ? 'diff-line--add'
              : line.kind === 'del'
                ? 'diff-line--del'
                : line.kind === 'hunk'
                  ? 'diff-line--hunk'
                  : '';
          return (
            <div key={i} className={`diff-line ${cls}`}>
              {line.text || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export default function ChangesCard({ files, mode, onUndo, undoing, undone, costUsd, costEstimated, durationMs }: Props) {
  const { t, fmtNum, fmtUsd } = useLang();
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffFiles, setDiffFiles] = useState<DiffFile[] | null>(null);
  const [checkpointSaved, setCheckpointSaved] = useState(false);
  if (files.length === 0) return null;

  const created = files.filter((f) => f.action === 'created');
  const modified = files.filter((f) => f.action !== 'created');
  const groups = [
    { key: 'created', title: t('changes.groupCreated'), list: created },
    { key: 'modified', title: t('changes.groupModified'), list: modified },
  ].filter((g) => g.list.length > 0);

  const toggleDiff = async () => {
    if (!diffOpen && diffFiles === null) {
      try {
        const res = await api.diff();
        setDiffFiles(res.files);
      } catch {
        setDiffFiles([]);
      }
    }
    setDiffOpen((v) => !v);
  };

  const saveCheckpoint = async () => {
    try {
      await api.createCheckpoint(new Date().toLocaleString());
      setCheckpointSaved(true);
    } catch {
      /* non-fatal */
    }
  };

  return (
    <section className="changes-card" aria-label={t('changes.title')}>
      <div className="changes-summary">
        <span>
          {t('changes.filesChanged', { count: fmtNum(files.length), plural: files.length === 1 ? '' : 's' })}
          {created.length > 0 && <> · {t('changes.new', { count: fmtNum(created.length) })}</>}
          {modified.length > 0 && <> · {t('changes.edited', { count: fmtNum(modified.length) })}</>}
        </span>
        <span className="changes-meta">
          {typeof durationMs === 'number' && durationMs > 0 && (
            <span className="changes-duration">{t('changes.took', { time: formatElapsed(durationMs) })}</span>
          )}
          {typeof costUsd === 'number' && (
            <span className="changes-cost">
              {t('cost.thisTurn')} {fmtUsd(costUsd)}
              {costEstimated ? ` ${t('cost.est')}` : ''}
            </span>
          )}
        </span>
      </div>

      {mode === 'preview' && <p className="preview-note">{t('mode.previewBadge')}</p>}

      <div className="changes-groups">
        {groups.map((g) => (
          <div key={g.key} className="changes-group">
            <h4 className="changes-group-title">
              {g.title} · {fmtNum(g.list.length)}
            </h4>
            <ul className="changes-rows">
              {g.list.map((f, i) => (
                <li key={`${f.path}-${i}`} className="changes-row">
                  <span
                    className={`change-dot ${f.action === 'created' ? 'change-dot--created' : 'change-dot--modified'}`}
                  />
                  <span className="changes-row-name">{basename(f.path)}</span>
                  <span className="changes-row-path" dir="ltr" title={f.path}>
                    {f.path}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="changes-actions">
        <button type="button" className="btn btn--ghost" onClick={onUndo} disabled={undoing || undone}>
          {undone ? t('changes.undone') : undoing ? t('changes.undoing') : t('changes.undo')}
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => void toggleDiff()} aria-expanded={diffOpen}>
          {t('changes.diff')}
          <span className={`chevron ${diffOpen ? 'chevron--open' : ''}`}>⌄</span>
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void saveCheckpoint()}
          disabled={checkpointSaved}
        >
          {checkpointSaved ? '✓' : t('changes.checkpoint')}
        </button>
      </div>

      {diffOpen && diffFiles && (
        <div className="diff-view">
          {diffFiles.map((f) => (
            <DiffBlock key={f.path} file={f} />
          ))}
        </div>
      )}
    </section>
  );
}
