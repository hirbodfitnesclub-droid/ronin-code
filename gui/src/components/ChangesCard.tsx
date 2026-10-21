import { useState } from 'react';
import type { ChangedFile, Mode } from '../api';

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
}

export default function ChangesCard({ files, mode, onUndo, undoing, undone }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (files.length === 0) return null;

  const created = files.filter((f) => f.action === 'created').length;
  const modified = files.length - created;

  return (
    <section className="changes-card" aria-label="Changes from this turn">
      <div className="changes-visual" aria-hidden="true">
        {files.slice(0, 6).map((f, i) => (
          <span key={`${f.path}-${i}`} className="change-tile">
            <span
              className={`change-dot ${f.action === 'created' ? 'change-dot--created' : 'change-dot--modified'}`}
            />
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
          {files.length} file{files.length === 1 ? '' : 's'} changed
          {created > 0 && <> · {created} new</>}
          {modified > 0 && <> · {modified} edited</>}
        </span>
      </div>

      {mode === 'preview' && (
        <p className="preview-note">
          Preview mode — add an API key in Settings to go live.
        </p>
      )}

      <div className="changes-actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onUndo}
          disabled={undoing || undone}
        >
          {undone ? 'Undone' : undoing ? 'Undoing…' : 'Undo'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
        >
          Details
          <span className={`chevron ${detailsOpen ? 'chevron--open' : ''}`}>⌄</span>
        </button>
      </div>

      {detailsOpen && (
        <ul className="changes-details">
          {files.map((f, i) => (
            <li key={`${f.path}-${i}`}>
              <span
                className={`change-dot ${f.action === 'created' ? 'change-dot--created' : 'change-dot--modified'}`}
              />
              <code>{f.path}</code>
              <span className="changes-details-action">{f.action}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
