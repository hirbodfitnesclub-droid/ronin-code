import { useRef, useState } from 'react';
import type { Mode } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import type { useChat } from '../chat/useChat';
import ModelPicker from '../chat/ModelPicker';

/* Ronin Code — Home (RDX-03): the start hub. A hero, one big
   desktop-scale composer that really starts work (the App ensures a
   project exists, then sends the first turn in the workspace), the
   four discoverable start paths, and the current project to continue.
   The host exposes no recent-projects list, so "continue" shows the
   one project the host actually has open — nothing is invented. */

interface Props {
  mode: Mode;
  project: string;
  projectName: string;
  chat: ReturnType<typeof useChat>;
  enabledModels: string[];
  onStartPrompt: (text: string) => void;
  onOpenIdea: () => void;
  onOpenStarters: () => void;
  onOpenProject: () => void;
  onContinue: () => void;
  onOpenSettings: () => void;
}

const pathIconProps = {
  width: 17,
  height: 17,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export default function HomeScreen(p: Props) {
  const { t } = useLang();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chat = p.chat;
  const noModels = p.enabledModels.length === 0;

  const submit = () => {
    const value = text.trim();
    if (!value || chat.running) return;
    setText('');
    p.onStartPrompt(value);
  };

  const paths = [
    {
      key: 'direct',
      title: t('home.pathDirect'),
      sub: t('home.pathDirectSub'),
      icon: (
        <svg {...pathIconProps} aria-hidden="true">
          <path d="M6.8 1.2 2.8 6.9h2.4L4.6 11 9.6 5.1H7.1L6.8 1.2Z" />
        </svg>
      ),
      onClick: () => textareaRef.current?.focus(),
    },
    {
      key: 'idea',
      title: t('home.pathIdea'),
      sub: t('home.pathIdeaSub'),
      icon: (
        <svg {...pathIconProps} aria-hidden="true">
          <path d="M8 1.8a4.4 4.4 0 0 1 2.5 8.03c-.5.3-.8.7-.93 1.17H6.43a3.1 3.1 0 0 0-.93-1.17A4.4 4.4 0 0 1 8 1.8Z" />
          <path d="M6.3 13.4h3.4M7 15h2" />
        </svg>
      ),
      onClick: p.onOpenIdea,
    },
    {
      key: 'starter',
      title: t('home.pathStarter'),
      sub: t('home.pathStarterSub'),
      icon: (
        <svg {...pathIconProps} aria-hidden="true">
          <rect x="2" y="2" width="5" height="5" rx="1.2" />
          <rect x="9" y="2" width="5" height="5" rx="1.2" />
          <rect x="2" y="9" width="5" height="5" rx="1.2" />
          <rect x="9" y="9" width="5" height="5" rx="1.2" />
        </svg>
      ),
      onClick: () => void p.onOpenStarters(),
    },
    {
      key: 'open',
      title: t('home.pathOpen'),
      sub: t('home.pathOpenSub'),
      icon: (
        <svg {...pathIconProps} aria-hidden="true">
          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.8h4.5A1.5 1.5 0 0 1 14 6.3V11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
        </svg>
      ),
      onClick: p.onOpenProject,
    },
  ];

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-orb" aria-hidden="true">
          <span />
        </div>
        <h1 className="home-title">{t('home.title')}</h1>
        <p className="home-sub">{t('home.subtitle')}</p>

        <div className="home-composer">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t('app.composerPlaceholder')}
            aria-label={t('app.composerPlaceholder')}
            rows={3}
          />
          <div className="home-composer-bar">
            <ModelPicker
              enabledModels={p.enabledModels}
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
            <button
              type="button"
              className="home-send"
              onClick={submit}
              disabled={!text.trim() || chat.running}
              aria-label={t('home.start')}
              title={t('home.start')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2.5 8h10M9 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {p.mode === 'preview' && <p className="preview-note preview-note--hero">{t('app.previewHeroNote')}</p>}

        {noModels && (
          <div className="home-models-note" role="note">
            <span>{t('home.noModels')}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={p.onOpenSettings}>
              {t('home.openSettings')}
            </button>
          </div>
        )}

        <div className="home-paths">
          {paths.map((path) => (
            <button key={path.key} type="button" className="home-path" onClick={path.onClick}>
              <span className="home-path-icon">{path.icon}</span>
              <span className="home-path-title">{path.title}</span>
              <span className="home-path-sub">{path.sub}</span>
            </button>
          ))}
        </div>

        <div className="home-section">
          <h2 className="home-section-title">{t('home.continueTitle')}</h2>
          {p.project ? (
            <div className="home-project-card">
              <div className="home-project-info">
                <span className="home-project-name">{p.projectName}</span>
                <span className="home-project-path" title={p.project}>
                  {p.project}
                </span>
              </div>
              <button type="button" className="btn btn--primary btn--sm" onClick={p.onContinue}>
                {t('home.continue')}
              </button>
            </div>
          ) : (
            <p className="home-empty-note">{t('home.noProject')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
