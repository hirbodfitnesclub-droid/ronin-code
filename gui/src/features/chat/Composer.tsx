import type React from 'react';
import type { CatalogModel } from '../../lib/catalog';
import { useLang } from '../../lib/i18n';
import ModelPicker from './ModelPicker';

/* Ronin Code — the composer (board 08): the auto-growing textarea +
   send on top, the model/effort/Fast toolbar row below, one box.
   There is no attach button (no attachment channel exists) and no
   stop button (the host has no turn-cancel endpoint) — send simply
   stays disabled while a turn runs. */

interface Props {
  input: string;
  running: boolean;
  textareaRef: React.Ref<HTMLTextAreaElement>;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  enabledModels: string[];
  modelId: string | null;
  activeModel: CatalogModel | undefined;
  effort: string | null;
  effortOptions: string[];
  fast: boolean;
  fastAvailable: boolean;
  onSelectModel: (id: string) => void;
  onEffortChange: (effort: string) => void;
  onFastChange: (fast: boolean) => void;
}

export default function Composer(p: Props) {
  const { t } = useLang();
  return (
    <div className="composer">
      <div className="composer-box">
        <div className="composer-main">
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
        <ModelPicker
          enabledModels={p.enabledModels}
          modelId={p.modelId}
          activeModel={p.activeModel}
          effort={p.effort}
          effortOptions={p.effortOptions}
          fast={p.fast}
          fastAvailable={p.fastAvailable}
          onSelectModel={p.onSelectModel}
          onEffortChange={p.onEffortChange}
          onFastChange={p.onFastChange}
        />
      </div>
      <p className="composer-hint">{t('app.composerHint')}</p>
    </div>
  );
}
