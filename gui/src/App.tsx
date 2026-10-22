import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Starter } from './lib/api';
import { LanguageProvider } from './lib/i18n';
import { useSession } from './hooks/useSession';
import { useChat } from './features/chat/useChat';
import Header from './features/shell';
import ErrorBoundary from './components/ui/ErrorBoundary';
import ChatPanel from './features/chat/ChatPanel';
import PreviewPanel from './features/preview';
import StartersModal from './features/starters';
import SettingsModal from './features/settings';
import IdeaPanel from './features/idea';
import PublishPanel from './features/publish';
import CheckpointsPanel from './features/checkpoints';
import Onboarding from './features/onboarding';
import LoginScreen from './features/auth';

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
            autoMode={Boolean(status?.autoMode)}
            planMode={Boolean(status?.planMode)}
            mode={mode}
            model={status?.model}
            auth={status?.auth}
            panelUrl={status?.panelUrl}
            onStatusRefresh={() => void refreshMeta()}
            onOpenProject={() => void openProject()}
            onOpenStarters={openStarters}
            onOpenIdea={() => setIdeaOpen(true)}
            onOpenCheckpoints={() => setCheckpointsOpen(true)}
            onOpenPublish={() => setPublishOpen(true)}
            onToggleAuto={toggleAuto}
            onTogglePlan={togglePlan}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <button type="button" className="icon-btn" onClick={() => setNotice('')} aria-label={t('app.dismiss')}>
                ×
              </button>
            </div>
          )}

          <main className={`main ${previewOpen ? '' : 'main--chat-only'}`}>
            <ChatPanel
              chat={chat}
              mode={mode}
              enabledModels={status?.enabledModels ?? []}
              panelUrl={status?.panelUrl ?? ''}
              onOpenStarters={openStarters}
              onOpenProject={() => void openProject()}
            />
            <PreviewPanel
              open={previewOpen}
              project={project}
              previewKey={previewKey}
              onRefresh={() => setPreviewKey((k) => k + 1)}
              onSetOpen={setPreviewOpen}
            />
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
              onLanguage={setLangOverride}
              onDone={() => {
                setOnboardingDismissed(true);
                void refreshMeta();
              }}
            />
          )}
        </div>
      </LanguageProvider>
    </ErrorBoundary>
  );
}
