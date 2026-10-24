import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { type Starter } from './lib/api';
import { LanguageProvider } from './lib/i18n';
import { useSession } from './hooks/useSession';
import { useChat } from './features/chat/useChat';
import Header, { NavRail } from './features/shell';
import ErrorBoundary from './components/ui/ErrorBoundary';
import ChatPanel from './features/chat/ChatPanel';
import PreviewPanel from './features/preview';
import HomeScreen from './features/home';
import StartersModal from './features/starters';
import SettingsModal from './features/settings';
import IdeaPanel from './features/idea';
import PublishPanel from './features/publish';
import CheckpointsPanel from './features/checkpoints';
import Onboarding from './features/onboarding';
import LoginScreen from './features/auth';

/* Ronin Code — app shell (composition root). Session state lives in
   hooks/useSession, the chat state machine in features/chat/useChat;
   this component wires them together and renders the redesign shell:
   app bar, banners, the active view (Home / Workspace) and the nav
   rail at the inline-end edge. */

type View = 'home' | 'workspace';

function storedNumber(key: string, fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  /* ---------------- shell state ---------------- */
  const [view, setView] = useState<View>('home');
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
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('ronin.rail') === 'collapsed';
    } catch {
      return false;
    }
  });
  const [chatWidth, setChatWidth] = useState<number>(() => storedNumber('ronin.chatWidth', 540));
  const [dividerActive, setDividerActive] = useState(false);

  const invalidatePreview = useCallback(() => setPreviewKey((k) => k + 1), []);
  const onStartersClose = useCallback(() => setStartersOpen(false), []);

  useEffect(() => {
    try {
      window.localStorage.setItem('ronin.rail', railCollapsed ? 'collapsed' : 'open');
    } catch {
      /* private mode — the choice simply does not persist */
    }
  }, [railCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem('ronin.chatWidth', String(chatWidth));
    } catch {
      /* non-fatal */
    }
  }, [chatWidth]);

  /* ---------------- session + chat ---------------- */
  const sessionOpts = useMemo(
    () => ({ setNotice, invalidatePreview, onStartersClose }),
    [invalidatePreview, onStartersClose],
  );
  const session = useSession(sessionOpts);
  const {
    status,
    providers,
    sessionCost,
    lang,
    t,
    translateError,
    refreshMeta,
    setLangOverride,
    openProject,
    createStarter,
    toggleAuto,
    togglePlan,
  } = session;

  const chatOpts = useMemo(
    () => ({
      t,
      translateError,
      setNotice,
      refreshMeta,
      invalidatePreview,
      onSessionCost: session.setSessionCost,
      enabledModels: status?.enabledModels ?? [],
      activeModelId: status?.activeModelId ?? null,
      onLoginRequired: () => {
        void refreshMeta();
      },
    }),
    [t, translateError, refreshMeta, invalidatePreview, session.setSessionCost, status?.enabledModels, status?.activeModelId],
  );
  const chat = useChat(chatOpts);

  /* Apply the account theme (default dark) to the document root. */
  useEffect(() => {
    document.documentElement.dataset.theme = status?.theme ?? 'dark';
  }, [status?.theme]);

  /* ---------------- derived ---------------- */
  const mode = status?.mode ?? 'preview';
  const project = status?.project ?? '';
  const projectName = project.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const needsLogin = Boolean(status?.auth) && !status?.auth?.loggedIn;
  const showOnboarding = Boolean(status) && !needsLogin && !status?.onboarded && !onboardingDismissed;
  const autoMode = Boolean(status?.autoMode);

  /* ---------------- cross-feature actions ---------------- */
  const openStarters = async () => {
    setStarters(await session.loadStarters());
    setStartersOpen(true);
  };

  const onIdeaBuilt = (path: string, ideaText: string) => {
    session.setProjectPath(path);
    chat.beginTurnUi(ideaText);
    invalidatePreview();
    setView('workspace');
    void refreshMeta();
  };

  /* Home composer: make sure a project exists (a fresh starter when
     none is open), then run the first turn in the workspace. */
  const onStartPrompt = async (text: string) => {
    if (!status?.project) {
      await createStarter();
    }
    setView('workspace');
    void chat.send(text);
  };

  /* Drag-resize the chat column (480–640px, PRD §6.1). In RTL the
     chat sits at the inline-start (right) edge, so the drag delta
     flips sign. */
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth;
    const rtl = document.documentElement.dir === 'rtl';
    setDividerActive(true);
    const move = (ev: PointerEvent) => {
      const dx = rtl ? startX - ev.clientX : ev.clientX - startX;
      setChatWidth(Math.min(640, Math.max(480, startW + dx)));
    };
    const up = () => {
      setDividerActive(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (needsLogin) {
    return (
      <ErrorBoundary>
        <LanguageProvider lang={lang}>
          <LoginScreen
            onLoggedIn={() => {
              void refreshMeta();
            }}
          />
        </LanguageProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <LanguageProvider lang={lang}>
        <div className="app">
          <Header
            project={project}
            projectName={projectName}
            sessionCost={sessionCost}
            autoMode={autoMode}
            planMode={Boolean(status?.planMode)}
            mode={mode}
            model={status?.model}
            auth={status?.auth}
            panelUrl={status?.panelUrl}
            onStatusRefresh={() => void refreshMeta()}
            onGoHome={() => setView('home')}
            onOpenProject={() => void openProject()}
            onOpenStarters={openStarters}
            onOpenIdea={() => setIdeaOpen(true)}
            onOpenCheckpoints={() => setCheckpointsOpen(true)}
            onOpenPublish={() => setPublishOpen(true)}
            onToggleAuto={toggleAuto}
            onTogglePlan={togglePlan}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {autoMode && (
            <div className="shell-banner shell-banner--auto" role="status">
              <span className="shell-banner-dot" aria-hidden="true" />
              <span className="shell-banner-text">{t('app.autoBanner')}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void toggleAuto()}>
                {t('app.autoTurnOff')}
              </button>
            </div>
          )}

          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <button type="button" className="icon-btn" onClick={() => setNotice('')} aria-label={t('app.dismiss')}>
                ×
              </button>
            </div>
          )}

          <div className="app-body">
            <div className="app-main">
              {!status ? (
                <div className="app-loading" role="status">
                  <div className="home-orb" aria-hidden="true">
                    <span />
                  </div>
                </div>
              ) : view === 'home' ? (
                <HomeScreen
                  mode={mode}
                  project={project}
                  projectName={projectName}
                  chat={chat}
                  enabledModels={status?.enabledModels ?? []}
                  onStartPrompt={(text) => void onStartPrompt(text)}
                  onOpenIdea={() => setIdeaOpen(true)}
                  onOpenStarters={openStarters}
                  onOpenProject={() => void openProject()}
                  onContinue={() => setView('workspace')}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              ) : (
                <main
                  className={`main ${previewOpen ? '' : 'main--chat-only'}`}
                  style={{ '--chat-w': `${chatWidth}px` } as React.CSSProperties}
                >
                  <ChatPanel
                    chat={chat}
                    mode={mode}
                    enabledModels={status?.enabledModels ?? []}
                    panelUrl={status?.panelUrl ?? ''}
                    onOpenStarters={openStarters}
                    onOpenProject={() => void openProject()}
                  />
                  <div
                    className={`col-divider ${dividerActive ? 'col-divider--active' : ''}`}
                    onPointerDown={onDividerDown}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize chat"
                  />
                  <PreviewPanel
                    open={previewOpen}
                    project={project}
                    previewKey={previewKey}
                    onRefresh={() => setPreviewKey((k) => k + 1)}
                    onSetOpen={setPreviewOpen}
                  />
                </main>
              )}
            </div>

            <NavRail
              view={view}
              collapsed={railCollapsed}
              onToggleCollapsed={() => setRailCollapsed((v) => !v)}
              onNavigate={setView}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenIdea={() => setIdeaOpen(true)}
              onOpenStarters={openStarters}
            />
          </div>

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

          <PublishPanel open={publishOpen} projectName={projectName} onClose={() => setPublishOpen(false)} />

          <CheckpointsPanel
            open={checkpointsOpen}
            onClose={() => setCheckpointsOpen(false)}
            onRestored={() => setPreviewKey((k) => k + 1)}
          />

          <StartersModal
            open={startersOpen}
            starters={starters}
            onClose={() => setStartersOpen(false)}
            onPick={(starterId) => createStarter(starterId)}
          />

          {showOnboarding && (
            <Onboarding
              status={status}
              providers={providers}
              onLanguage={setLangOverride}
              onDone={(openSettings) => {
                setOnboardingDismissed(true);
                if (openSettings) setSettingsOpen(true);
                void refreshMeta();
              }}
            />
          )}
        </div>
      </LanguageProvider>
    </ErrorBoundary>
  );
}
