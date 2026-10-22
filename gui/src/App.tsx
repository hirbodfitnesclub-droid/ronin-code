import { useCallback, useMemo, useState } from 'react';
import { type Starter } from './lib/api';
import { LanguageProvider } from './lib/i18n';
import { useSession } from './hooks/useSession';
import { useChat } from './features/chat/useChat';
import ActivityVisual from './components/ActivityVisual';
import ApprovalCard from './components/ApprovalCard';
import ChangesCard from './components/ChangesCard';
import CheckpointsPanel from './components/CheckpointsPanel';
import IdeaPanel from './components/IdeaPanel';
import Logo from './components/Logo';
import Onboarding from './components/Onboarding';
import PlanCard from './components/PlanCard';
import PublishPanel from './components/PublishPanel';
import SettingsModal from './components/SettingsModal';
import RichText from './components/RichText';

/* Ronin Code — app shell (composition root). Session state lives in
   hooks/useSession, the chat state machine in features/chat/useChat;
   this component wires them together and renders the layout. */
export default function App() {
  /* ---------------- shell state ---------------- */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [notice, setNotice] = useState('');
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [starters, setStarters] = useState<Starter[] | null>(null);
  const [startersOpen, setStartersOpen] = useState(false);

  const invalidatePreview = useCallback(() => setPreviewKey((k) => k + 1), []);
  const onStartersClose = useCallback(() => setStartersOpen(false), []);

  /* ---------------- session + chat ---------------- */
  const sessionOpts = useMemo(
    () => ({ setNotice, invalidatePreview, onStartersClose }),
    [invalidatePreview, onStartersClose],
  );
  const session = useSession(sessionOpts);
  const {
    status, providers, sessionCost, lang, t, fmtUsd,
    translateError, refreshMeta, setLangOverride,
    openProject, createStarter, toggleAuto, togglePlan,
  } = session;

  const chatOpts = useMemo(
    () => ({
      t,
      translateError,
      setNotice,
      refreshMeta,
      invalidatePreview,
      onSessionCost: session.setSessionCost,
    }),
    [t, translateError, refreshMeta, invalidatePreview, session.setSessionCost],
  );
  const chat = useChat(chatOpts);
  const {
    items, input, running, activities,
    scrollRef, textareaRef,
    send, undoChanges, decideApproval, approvePlan, rejectPlan,
    onInputKeyDown, onInputChange,
  } = chat;

  /* ---------------- derived ---------------- */
  const mode = status?.mode ?? 'preview';
  const project = status?.project ?? '';
  const projectName = project.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const showOnboarding = Boolean(status) && !status?.onboarded && !onboardingDismissed;
  const isEmpty = items.length === 0 && !running;
  const examples = [t('app.example1'), t('app.example2'), t('app.example3')];

  /* ---------------- cross-feature actions ---------------- */
  const openStarters = async () => {
    setStarters(await session.loadStarters());
    setStartersOpen(true);
  };

  const onIdeaBuilt = (path: string, ideaText: string) => {
    session.setProjectPath(path);
    chat.beginTurnUi(ideaText);
    invalidatePreview();
    void refreshMeta();
  };

  return (
    <LanguageProvider lang={lang}>
      <div className="app">
        {/* ------------------------------ header ------------------------------ */}
        <header className="header">
          <div className="brand">
            <Logo />
            <span className="wordmark">
              Ronin <span className="wordmark-accent">Code</span>
            </span>
            <span className="wordmark-fa" lang="fa" dir="rtl">رونین کد</span>
          </div>

          <div className="header-project">
            {project ? (
              <span className="project-label">
                <span className="project-name">{projectName}</span>
                <span className="project-path" title={project} dir="ltr">{project}</span>
              </span>
            ) : (
              <span className="project-path project-path--empty">{t('app.noProjectYet')}</span>
            )}
            <button type="button" className="btn btn--ghost btn--sm" onClick={openProject}>
              {t('app.openProject')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void openStarters()}>
              {t('app.createStarter')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setIdeaOpen(true)}>
              {t('app.idea')}
            </button>
            {project && (
              <>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCheckpointsOpen(true)}>
                  {t('app.checkpoints')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPublishOpen(true)}>
                  {t('app.publish')}
                </button>
              </>
            )}
          </div>

          <div className="header-right">
            {sessionCost > 0 && (
              <span className="cost-chip" dir="ltr" title={t('cost.session')}>
                {t('cost.session')} <b>{fmtUsd(sessionCost)}</b>
              </span>
            )}
            <button
              type="button"
              className={`toggle-pill ${status?.autoMode ? 'toggle-pill--on' : ''}`}
              onClick={() => void toggleAuto()}
              title={status?.autoMode ? t('app.autoOn') : t('app.autoOff')}
              aria-pressed={Boolean(status?.autoMode)}
            >
              <span className="toggle-dot" />
              {t('app.auto')}
            </button>
            <button
              type="button"
              className={`toggle-pill toggle-pill--plan ${status?.planMode ? 'toggle-pill--on' : ''}`}
              onClick={() => void togglePlan()}
              title={status?.planMode ? t('app.planOn') : t('app.planOff')}
              aria-pressed={Boolean(status?.planMode)}
            >
              <span className="toggle-dot" />
              {t('app.plan')}
            </button>
            <span className={`mode-badge ${mode === 'live' ? 'mode-badge--live' : 'mode-badge--preview'}`}>
              <span className="mode-dot" />
              {mode === 'live' ? t('app.live') : t('app.previewMode')}
            </span>
            {status?.model && <span className="model-label" dir="ltr">{status.model}</span>}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSettingsOpen(true)}>
              {t('app.settings')}
            </button>
          </div>
        </header>

        {notice && (
          <div className="notice" role="alert">
            <span>{notice}</span>
            <button type="button" className="icon-btn" onClick={() => setNotice('')} aria-label={t('app.dismiss')}>
              ×
            </button>
          </div>
        )}

        {/* ------------------------------ main ------------------------------ */}
        <main className={`main ${previewOpen ? '' : 'main--chat-only'}`}>
          <section className="chat-panel">
            <div className="chat-scroll" ref={scrollRef}>
              {isEmpty ? (
                <div className="empty">
                  <div className="empty-orb" aria-hidden="true">
                    <span />
                  </div>
                  <h1>{t('app.whatBuild')}</h1>
                  <p className="empty-sub">{t('app.tagline')}</p>
                  {mode === 'preview' && <p className="preview-note preview-note--hero">{t('app.previewHeroNote')}</p>}
                  <div className="empty-actions">
                    <button type="button" className="btn btn--primary" onClick={() => void openStarters()}>
                      {t('app.createStarter')}
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={openProject}>
                      {t('app.openProject')}
                    </button>
                  </div>
                  <div className="chips">
                    {examples.map((ex) => (
                      <button key={ex} type="button" className="chip" onClick={() => void send(ex)}>
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {items.map((item) => {
                    if (item.kind === 'changes') {
                      return (
                        <ChangesCard
                          key={item.id}
                          files={item.files}
                          mode={mode}
                          undoing={item.undoing}
                          undone={item.undone}
                          costUsd={item.costUsd}
                          costEstimated={item.costEstimated}
                          onUndo={() => void undoChanges(item.id)}
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
                          onDecide={(approved) => void decideApproval(item.approvalId, approved)}
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
                          onApprove={() => void approvePlan(item.planId)}
                          onReject={() => void rejectPlan(item.planId)}
                        />
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
                  {running && (
                    <div className="msg msg--assistant">
                      <ActivityVisual kinds={activities.map((a) => a.kind)} />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="composer">
              <div className="composer-box">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={onInputChange}
                  onKeyDown={onInputKeyDown}
                  placeholder={t('app.composerPlaceholder')}
                  rows={1}
                  aria-label={t('app.composerPlaceholder')}
                />
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => void send()}
                  disabled={running || !input.trim()}
                  aria-label={t('app.send')}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
              <p className="composer-hint">{t('app.composerHint')}</p>
            </div>
          </section>

          {previewOpen ? (
            <section className="preview-panel" aria-label="Live preview">
              <div className="preview-bar">
                <span className="preview-dots" aria-hidden="true"><i /><i /><i /></span>
                <span className="preview-url" dir="ltr">/preview/</span>
                <span className="preview-bar-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPreviewKey((k) => k + 1)}
                    aria-label={t('app.refreshPreview')}
                    title={t('app.refreshPreview')}
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPreviewOpen(false)}
                    aria-label={t('app.collapsePreview')}
                    title={t('app.collapsePreview')}
                  >
                    ›
                  </button>
                </span>
              </div>
              <div className="preview-frame-wrap">
                {project ? (
                  <iframe
                    key={previewKey}
                    className="preview-frame"
                    src={`/preview/?ronin_preview=${previewKey}`}
                    title="Project preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  />
                ) : (
                  <div className="preview-empty">
                    <div className="preview-empty-orb" aria-hidden="true"><span /></div>
                    <Logo />
                    <p className="preview-empty-title">{t('app.previewWillAppear')}</p>
                    <p className="preview-empty-sub">{t('app.previewEmptySub')}</p>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <button
              type="button"
              className="preview-reopen"
              onClick={() => setPreviewOpen(true)}
              aria-label={t('app.showPreview')}
              title={t('app.showPreview')}
            >
              ‹
            </button>
          )}
        </main>

        <SettingsModal
          open={settingsOpen}
          providers={providers}
          status={status}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void refreshMeta()}
        />

        <IdeaPanel
          open={ideaOpen}
          mode={mode}
          onClose={() => setIdeaOpen(false)}
          onBuilt={(path, ideaText) => onIdeaBuilt(path, ideaText)}
        />

        <PublishPanel
          open={publishOpen}
          projectName={projectName}
          onClose={() => setPublishOpen(false)}
        />

        <CheckpointsPanel
          open={checkpointsOpen}
          onClose={() => setCheckpointsOpen(false)}
          onRestored={() => setPreviewKey((k) => k + 1)}
        />

        {startersOpen && (
          <div className="modal-backdrop" onMouseDown={() => setStartersOpen(false)} role="presentation">
            <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label={t('starters.title')} onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>{t('starters.title')}</h2>
                <button type="button" className="icon-btn" onClick={() => setStartersOpen(false)} aria-label={t('settings.close')}>×</button>
              </div>
              <div className="starters-grid">
                {(starters ?? []).map((s) => (
                  <button key={s.id} type="button" className="starter-card" onClick={() => void createStarter(s.id)}>
                    <span className="starter-card-dot" style={{ background: s.accent }} />
                    <span className="starter-card-name">{s.name[lang]}</span>
                    <span className="starter-card-tag">{s.tagline[lang]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {showOnboarding && (
          <Onboarding
            providers={providers}
            status={status}
            onLanguage={setLangOverride}
            onDone={() => {
              setOnboardingDismissed(true);
              void refreshMeta();
            }}
            onCreateStarter={() => void createStarter()}
            onOpenProject={() => void openProject()}
          />
        )}
      </div>
    </LanguageProvider>
  );
}
