import { useCallback, useEffect, useRef, useState } from 'react';
import { api, openStream, type ActivityKind, type ChangedFile, type Provider, type Status, type StreamEvent } from './api';
import { LanguageProvider, type Lang } from './i18n';
import ActivityVisual from './components/ActivityVisual';
import ChangesCard from './components/ChangesCard';
import Logo from './components/Logo';
import Onboarding from './components/Onboarding';
import SettingsModal from './components/SettingsModal';
import RichText from './components/RichText';

type TimelineItem =
  | { kind: 'message'; id: number; role: 'user' | 'assistant' | 'error'; text: string }
  | { kind: 'changes'; id: number; files: ChangedFile[]; undoing: boolean; undone: boolean };

const EXAMPLES = [
  'Add a dark hero section with a signup form',
  'Make the layout responsive',
  'Add a small todo app section',
];

let nextId = 1;
const id = () => nextId++;

export default function App() {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [activities, setActivities] = useState<Array<{ id: string; kind: ActivityKind }>>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [notice, setNotice] = useState('');
  const [langOverride, setLangOverride] = useState<Lang | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  const lang: Lang = langOverride ?? status?.language ?? 'en';

  /* Keep <html lang/dir> in sync so RTL mirroring follows the language. */
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  }, [lang]);

  const showOnboarding = Boolean(status) && !status?.onboarded && !onboardingDismissed;

  const runningRef = useRef(false);
  const streamingIdRef = useRef<number | null>(null);
  const pendingChangesRef = useRef<ChangedFile[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mode = status?.mode ?? 'preview';
  const project = status?.project ?? '';
  const projectName = project.split(/[\\/]/).filter(Boolean).pop() ?? '';

  /* ---------------- initial load ---------------- */
  const refreshMeta = useCallback(async () => {
    const [p, s] = await Promise.allSettled([api.providers(), api.status()]);
    if (p.status === 'fulfilled') setProviders(p.value);
    if (s.status === 'fulfilled') setStatus(s.value);
  }, []);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  /* DEV-ONLY visual QA fixtures (stripped from production builds):
     ?devChanges=1 renders a Changes card; ?devActivity=reading,writing
     pins the activity stage on those phases. */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has('devChanges')) {
      setItems([
        { kind: 'message', id: id(), role: 'user', text: 'Add a dark hero section with a signup form' },
        { kind: 'message', id: id(), role: 'assistant', text: 'Done — the hero is live in the preview.' },
        {
          kind: 'changes', id: id(), undoing: false, undone: false,
          files: [
            { path: 'index.html', action: 'modified' },
            { path: 'styles.css', action: 'modified' },
            { path: 'hero.js', action: 'created' },
          ],
        },
      ]);
    }
    const act = params.get('devActivity');
    if (act) {
      const kinds = act.split(',').filter(Boolean) as ActivityKind[];
      setItems([{ kind: 'message', id: id(), role: 'user', text: 'Make it beautiful' }]);
      setActivities(kinds.map((kind, i) => ({ id: `dev-${i}`, kind })));
      runningRef.current = true;
      setRunning(true);
    }
  }, []);

  /* ---------------- streaming ---------------- */
  const finishTurn = useCallback((errorMessage?: string) => {
    runningRef.current = false;
    setRunning(false);
    setActivities([]);
    streamingIdRef.current = null;

    const files = pendingChangesRef.current;
    pendingChangesRef.current = [];

    setItems((prev) => {
      let next = prev;
      if (errorMessage) {
        next = [...next, { kind: 'message', id: id(), role: 'error', text: errorMessage }];
      }
      if (files.length > 0) {
        next = [...next, { kind: 'changes', id: id(), files, undoing: false, undone: false }];
      }
      return next;
    });

    setPreviewKey((k) => k + 1);
    void refreshMeta();
  }, [refreshMeta]);

  useEffect(() => {
    const handle = (ev: StreamEvent) => {
      /* The host broadcasts one shared stream; only the client that
         started the turn consumes it — fresh or second clients must
         not inherit another client's messages/activity. */
      if (!runningRef.current) return;
      switch (ev.type) {
        case 'activity_start':
          setActivities((prev) =>
            prev.some((a) => a.id === ev.activityId)
              ? prev
              : [...prev, { id: ev.activityId, kind: ev.kind }],
          );
          break;
        case 'activity_end':
          setActivities((prev) => prev.filter((a) => a.id !== ev.activityId));
          break;
        case 'assistant_delta': {
          if (streamingIdRef.current === null) streamingIdRef.current = id();
          const sid = streamingIdRef.current;
          setItems((prev) => {
            const idx = prev.findIndex((it) => it.kind === 'message' && it.id === sid);
            if (idx === -1) {
              return [...prev, { kind: 'message', id: sid, role: 'assistant', text: ev.text }];
            }
            const next = [...prev];
            const cur = next[idx];
            if (cur.kind === 'message') {
              next[idx] = { ...cur, text: cur.text + ev.text };
            }
            return next;
          });
          break;
        }
        case 'assistant_message': {
          if (streamingIdRef.current === null) streamingIdRef.current = id();
          const sid = streamingIdRef.current;
          setItems((prev) => {
            const idx = prev.findIndex((it) => it.kind === 'message' && it.id === sid);
            if (idx === -1) {
              return [...prev, { kind: 'message', id: sid, role: 'assistant', text: ev.text }];
            }
            const next = [...prev];
            const cur = next[idx];
            if (cur.kind === 'message') next[idx] = { ...cur, text: ev.text };
            return next;
          });
          break;
        }
        case 'changes':
          pendingChangesRef.current = [...pendingChangesRef.current, ...ev.files];
          break;
        case 'turn_done':
          finishTurn();
          break;
        case 'turn_error':
          finishTurn(ev.message || 'Something went wrong during that turn.');
          break;
      }
    };

    const source = openStream(handle);
    return () => source.close();
  }, [finishTurn]);

  /* ---------------- auto-scroll chat ---------------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, activities, running]);

  /* ---------------- actions ---------------- */
  const send = useCallback(
    async ( raw?: string) => {
      const prompt = (raw ?? input).trim();
      if (!prompt || runningRef.current) return;
      setInput('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      setItems((prev) => [...prev, { kind: 'message', id: id(), role: 'user', text: prompt }]);
      pendingChangesRef.current = [];
      streamingIdRef.current = null;
      runningRef.current = true;
      setRunning(true);
      try {
        await api.startTurn(prompt);
      } catch (err) {
        finishTurn(err instanceof Error ? err.message : 'Could not start that turn.');
      }
    },
    [input, finishTurn],
  );

  const undoChanges = async (itemId: number) => {
    setItems((prev) =>
      prev.map((it) => (it.kind === 'changes' && it.id === itemId ? { ...it, undoing: true } : it)),
    );
    try {
      await api.undo();
      setItems((prev) =>
        prev.map((it) =>
          it.kind === 'changes' && it.id === itemId ? { ...it, undoing: false, undone: true } : it,
        ),
      );
      setPreviewKey((k) => k + 1);
    } catch {
      setItems((prev) =>
        prev.map((it) => (it.kind === 'changes' && it.id === itemId ? { ...it, undoing: false } : it)),
      );
      setNotice('Undo could not be completed.');
    }
  };

  const openProject = async () => {
    const path = window.prompt('Path to your project folder', project || '');
    if (!path || !path.trim()) return;
    setNotice('');
    try {
      const res = await api.selectProject(path.trim());
      setStatus((prev) => (prev ? { ...prev, project: res.path } : prev));
      setPreviewKey((k) => k + 1);
      void refreshMeta();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not open that project.');
    }
  };

  const createStarter = async () => {
    setNotice('');
    try {
      const res = await api.starterProject();
      setStatus((prev) => (prev ? { ...prev, project: res.path } : prev));
      setPreviewKey((k) => k + 1);
      void refreshMeta();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not create a starter project.');
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const isEmpty = items.length === 0 && !running;

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
              <span className="project-path" title={project}>{project}</span>
            </span>
          ) : (
            <span className="project-path project-path--empty">No project yet</span>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={openProject}>
            Open project
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={createStarter}>
            Create starter project
          </button>
        </div>

        <div className="header-right">
          <span className={`mode-badge ${mode === 'live' ? 'mode-badge--live' : 'mode-badge--preview'}`}>
            <span className="mode-dot" />
            {mode === 'live' ? 'Live' : 'Preview mode'}
          </span>
          {status?.model && <span className="model-label">{status.model}</span>}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice" role="alert">
          <span>{notice}</span>
          <button type="button" className="icon-btn" onClick={() => setNotice('')} aria-label="Dismiss">
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
                <h1>What do you want to build?</h1>
                <p className="empty-sub">
                  Describe it in plain words. Ronin Code builds it, and you watch it appear — live, on the right.
                </p>
                {mode === 'preview' && (
                  <p className="preview-note preview-note--hero">
                    Preview mode — add an API key in Settings to go live.
                  </p>
                )}
                <div className="empty-actions">
                  <button type="button" className="btn btn--primary" onClick={createStarter}>
                    Create starter project
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={openProject}>
                    Open a project
                  </button>
                </div>
                <div className="chips">
                  {EXAMPLES.map((ex) => (
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
                        onUndo={() => void undoChanges(item.id)}
                      />
                    );
                  }
                  return (
                    <div key={item.id} className={`msg msg--${item.role}`}>
                      <div className="msg-bubble">
                        {item.role === 'assistant' ? (
                          <RichText text={item.text} />
                        ) : item.text.split('\n').map((line, i) => (
                          <p key={i}>{line || ' '}</p>
                        ))}
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
                placeholder="Describe what to build…"
                rows={1}
                aria-label="Describe what to build"
              />
              <button
                type="button"
                className="send-btn"
                onClick={() => void send()}
                disabled={running || !input.trim()}
                aria-label="Send"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
          </div>
        </section>

        {previewOpen ? (
          <section className="preview-panel" aria-label="Live preview">
            <div className="preview-bar">
              <span className="preview-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="preview-url">/preview/</span>
              <span className="preview-bar-actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPreviewKey((k) => k + 1)}
                  aria-label="Refresh preview"
                  title="Refresh preview"
                >
                  ↻
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPreviewOpen(false)}
                  aria-label="Collapse preview"
                  title="Collapse preview"
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
                  <p className="preview-empty-title">Your creation will appear here</p>
                  <p className="preview-empty-sub">Open a project, or create a starter — it renders live in this space.</p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <button
            type="button"
            className="preview-reopen"
            onClick={() => setPreviewOpen(true)}
            aria-label="Show preview"
            title="Show preview"
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
