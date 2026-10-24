import { useState } from 'react';
import { api, type ChangedFile, type DiffFile, type Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import { parseDiffLines } from '../../lib/diff';

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

export default function ChangesCard({ files, mode, onUndo, undoing, undone, costUsd, costEstimated }: Props) {
  const { t, fmtNum, fmtUsd } = useLang();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffFiles, setDiffFiles] = useState<DiffFile[] | null>(null);
  const [checkpointSaved, setCheckpointSaved] = useState(false);
  if (files.length === 0) return null;

  const created = files.filter((f) => f.action === 'created').length;
  const modified = files.length - created;

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
      <div className="changes-visual" aria-hidden="true">
        {files.slice(0, 6).map((f, i) => (
          <span key={`${f.path}-${i}`} className="change-tile">
            <span className={`change-dot ${f.action === 'created' ? 'change-dot--created' : 'change-dot--modified'}`} />
            <span className="change-tile-lines">
              <i style={{ width: `${58 + ((i * 13) % 30)}%` }} />
              <i className="dim" style={{ width: `${34 + ((i * 7) % 22)}%` }} />
            </span>
            <span className="change-tile-name">{basename(f.path)}</span>
          </span>
        ))}
        {files.length > 6 && <span className="change-more">+{files.length - 6}</span>}
      </div>

      <div className="changes-summary">
        <span>
          {t('changes.filesChanged', { count: fmtNum(files.length), plural: files.length === 1 ? '' : 's' })}
          {created > 0 && <> · {t('changes.new', { count: fmtNum(created) })}</>}
          {modified > 0 && <> · {t('changes.edited', { count: fmtNum(modified) })}</>}
        </span>
        {typeof costUsd === 'number' && (
          <span className="changes-cost">
            {t('cost.thisTurn')} {fmtUsd(costUsd)}
            {costEstimated ? ` ${t('cost.est')}` : ''}
          </span>
        )}
      </div>

      {mode === 'preview' && <p className="preview-note">{t('mode.previewBadge')}</p>}

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
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
        >
          {t('changes.details')}
          <span className={`chevron ${detailsOpen ? 'chevron--open' : ''}`}>⌄</span>
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

      {detailsOpen && (
        <ul className="changes-details">
          {files.map((f, i) => (
            <li key={`${f.path}-${i}`}>
              <span
                className={`change-dot ${f.action === 'created' ? 'change-dot--created' : 'change-dot--modified'}`}
              />
              <code dir="ltr">{f.path}</code>
              <span className="changes-details-action">{f.action}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
