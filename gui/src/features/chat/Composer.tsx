import type React from 'react';
import { useLang } from '../../lib/i18n';

/* Ronin Code — the composer: auto-growing textarea + send button. */

interface Props {
  input: string;
  running: boolean;
  textareaRef: React.Ref<HTMLTextAreaElement>;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
}

export default function Composer(p: Props) {
  const { t } = useLang();
  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={p.textareaRef}
          value={p.input}
          onChange={p.onChange}
          onKeyDown={p.onKeyDown}
          placeholder={t('app.composerPlaceholder')}
          rows={1}
          aria-label={t('app.composerPlaceholder')}
        />
        <button
          type="button"
          className="send-btn"
          onClick={() => void p.onSend()}
          disabled={p.running || !p.input.trim()}
          aria-label={t('app.send')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 13V3M8 3L4 7M8 3l4 4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <p className="composer-hint">{t('app.composerHint')}</p>
    </div>
  );
}
