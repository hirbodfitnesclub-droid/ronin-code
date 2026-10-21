import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  openStream,
  ApiError,
  type ActivityKind,
  type ApprovalDetail,
  type ChangedFile,
  type PlanStep,
  type Provider,
  type Starter,
  type Status,
  type StreamEvent,
} from './api';
import { ERROR_CODE_KEYS, LanguageProvider, makeLangCtx, type Lang } from './i18n';
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

type TimelineItem =
  | { kind: 'message'; id: number; role: 'user' | 'assistant' | 'error'; text: string }
  | { kind: 'changes'; id: number; files: ChangedFile[]; undoing: boolean; undone: boolean; costUsd?: number; costEstimated?: boolean }
  | { kind: 'approval'; id: number; approvalId: string; approvalKind: 'command' | 'write_outside'; detail: ApprovalDetail; resolved: boolean | null }
  | { kind: 'plan'; id: number; planId: string; task: string; steps: PlanStep[]; status: 'pending' | 'building' | 'done' | 'rejected' };

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
  const [sessionCost, setSessionCost] = useState(0);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [starters, setStarters] = useState<Starter[] | null>(null);
  const [startersOpen, setStartersOpen] = useState(false);

  const runningRef = useRef(false);
  const streamingIdRef = useRef<number | null>(null);
  const pendingChangesRef = useRef<ChangedFile[]>([]);
  const pendingUsageRef = useRef<{ costUsd: number; estimated: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lang: Lang = langOverride ?? status?.language ?? 'en';
  const ctx = useMemo(() => makeLangCtx(lang), [lang]);
  const { t, fmtUsd } = ctx;

  const mode = status?.mode ?? 'preview';
  const project = status?.project ?? '';
  const projectName = project.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const showOnboarding = Boolean(status) && !status?.onboarded && !onboardingDismissed;

  const translateError = useCallback(
    (err: unknown, fallbackKey: Parameters<typeof t>[0] = 'errors.unknown'): string => {
      if (err instanceof ApiError && err.code && ERROR_CODE_KEYS[err.code]) {
        return t(ERROR_CODE_KEYS[err.code]);
      }
      if (err instanceof Error && err.message) return err.message;
      return t(fallbackKey);
    },
    [t],
  );

  /* Keep <html lang/dir> in sync so RTL mirroring follows the language. */
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  }, [lang]);

  /* ---------------- initial load ---------------- */
  const refreshMeta = useCallback(async () => {
    const [p, s] = await Promise.allSettled([api.providers(), api.status()]);
    if (p.status === 'fulfilled') setProviders(p.value);
    if (s.status === 'fulfilled') setStatus(s.value);
  }, []);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  /* DEV-ONLY visual QA fixtures (stripped from production builds). */
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
  const finishTurn = useCallback(
    (errorMessage?: string) => {
      runningRef.current = false;
      setRunning(false);
      setActivities([]);
      streamingIdRef.current = null;

      const files = pendingChangesRef.current;
      pendingChangesRef.current = [];
      const usage = pendingUsageRef.current;
      pendingUsageRef.current = null;

      setItems((prev) => {
        let next = prev;
        if (errorMessage) {
          next = [...next, { kind: 'message', id: id(), role: 'error' as const, text: errorMessage }];
        }
        // A building plan completes with the turn.
        next = next.map((it) =>
          it.kind === 'plan' && it.status === 'building'
            ? { ...it, status: 'done' as const, steps: it.steps.map((s) => ({ ...s, state: 'done' as const })) }
            : it,
        );
        if (files.length > 0) {
          next = [
            ...next,
            {
              kind: 'changes', id: id(), files, undoing: false, undone: false,
              ...(usage ? { costUsd: usage.costUsd, costEstimated: usage.estimated } : {}),
            },
          ];
        }
        return next;
      });

      setPreviewKey((k) => k + 1);
      void refreshMeta();
    },
    [refreshMeta],
  );

  useEffect(() => {
    const handle = (ev: StreamEvent) => {
      /* The host broadcasts one shared stream; only the client that
         started the turn consumes it. */
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
        case 'approval_request':
          setItems((prev) => [
            ...prev,
            {
              kind: 'approval', id: id(), approvalId: ev.approvalId,
              approvalKind: ev.kind, detail: ev.detail, resolved: null,
            },
          ]);
          break;
        case 'approval_resolved':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'approval' && it.approvalId === ev.approvalId
                ? { ...it, resolved: ev.approved }
                : it,
            ),
          );
          break;
        case 'plan_proposed':
          setItems((prev) => [
            ...prev.map((it) =>
              it.kind === 'plan' && it.status === 'pending' ? { ...it, status: 'rejected' as const } : it,
            ),
            { kind: 'plan', id: id(), planId: ev.planId, task: ev.task, steps: ev.steps, status: 'pending' },
          ]);
          break;
        case 'plan_progress':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'plan' && it.planId === ev.planId ? { ...it, steps: ev.steps } : it,
            ),
          );
          break;
        case 'plan_cleared':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'plan' && it.planId === ev.planId ? { ...it, status: 'rejected' as const } : it,
            ),
          );
          break;
        case 'turn_usage':
          pendingUsageRef.current = { costUsd: ev.costUsd, estimated: ev.estimated };
          setSessionCost(ev.sessionTotalUsd);
          break;
        case 'provider_switched':
          void refreshMeta();
          break;
        case 'budget_warning':
          setNotice(t('cost.budgetWarn'));
          break;
        case 'budget_exceeded':
          setNotice(t('cost.budgetHit'));
          break;
        case 'turn_done':
          finishTurn();
          break;
        case 'turn_error':
          finishTurn(ev.message || t('app.genericTurnError'));
          break;
      }
    };

    const source = openStream(handle);
    return () => source.close();
  }, [finishTurn, refreshMeta, t]);

  /* ---------------- auto-scroll chat ---------------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, activities, running]);

  /* ---------------- actions ---------------- */
  const send = useCallback(
    async (raw?: string) => {
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
        finishTurn(translateError(err, 'app.turnStartFailed'));
      }
    },
    [input, finishTurn, translateError],
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
    } catch (err) {
      setItems((prev) =>
        prev.map((it) => (it.kind === 'changes' && it.id === itemId ? { ...it, undoing: false } : it)),
      );
      setNotice(translateError(err, 'app.undoFailed'));
    }
  };

  const decideApproval = async (approvalId: string, approved: boolean) => {
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'approval' && it.approvalId === approvalId ? { ...it, resolved: approved } : it,
      ),
    );
    try {
      await api.approval(approvalId, approved);
    } catch {
      /* host also resolves via its own timeout safety valve */
    }
  };

  const approvePlan = async (planId: string) => {
    try {
      await api.planApprove(planId);
      setItems((prev) =>
        prev.map((it) => (it.kind === 'plan' && it.planId === planId ? { ...it, status: 'building' as const } : it)),
      );
      // The execution runs host-side; consume its stream like a normal turn.
      runningRef.current = true;
      setRunning(true);
      streamingIdRef.current = null;
      pendingChangesRef.current = [];
    } catch (err) {
      setNotice(translateError(err));
    }
  };

  const rejectPlan = async (planId: string) => {
    setItems((prev) =>
      prev.map((it) => (it.kind === 'plan' && it.planId === planId ? { ...it, status: 'rejected' as const } : it)),
    );
    try {
      await api.planReject(planId);
    } catch {
      /* non-fatal */
    }
  };

  const openProject = async () => {
    const path = window.prompt(t('app.openProjectPrompt'), project || '');
    if (!path || !path.trim()) return;
    setNotice('');
    try {
      const res = await api.selectProject(path.trim());
      setStatus((prev) => (prev ? { ...prev, project: res.path } : prev));
      setPreviewKey((k) => k + 1);
      void refreshMeta();
    } catch (err) {
      setNotice(translateError(err, 'app.openProjectFailed'));
    }
  };

  const createStarter = async (starterId?: string) => {
    setNotice('');
    try {
      const res = await api.starterProject(starterId);
      setStatus((prev) => (prev ? { ...prev, project: res.path } : prev));
      setPreviewKey((k) => k + 1);
      setStartersOpen(false);
      void refreshMeta();
    } catch (err) {
      setNotice(translateError(err, 'app.starterFailed'));
    }
  };

  const openStarters = async () => {
    try {
      setStarters(await api.starters());
    } catch {
      setStarters([]);
    }
    setStartersOpen(true);
  };

  const toggleAuto = async () => {
    if (!status) return;
    const next = !status.autoMode;
    try {
      if (project) {
        await api.saveSettings({ projectMode: next ? 'auto' : null });
      } else {
        await api.saveSettings({ autoMode: next });
      }
      void refreshMeta();
    } catch {
      /* non-fatal */
    }
  };

  const togglePlan = async () => {
    if (!status) return;
    const next = !status.planMode;
    try {
      if (project) {
        await api.saveSettings({ projectMode: next ? 'plan' : null });
      } else {
        await api.saveSettings({ planMode: next });
      }
      void refreshMeta();
    } catch {
      /* non-fatal */
    }
  };

  const onIdeaBuilt = (path: string, ideaText: string) => {
    setStatus((prev) => (prev ? { ...prev, project: path } : prev));
    setItems((prev) => [...prev, { kind: 'message', id: id(), role: 'user', text: ideaText }]);
    pendingChangesRef.current = [];
    streamingIdRef.current = null;
    runningRef.current = true;
    setRunning(true);
    setPreviewKey((k) => k + 1);
    void refreshMeta();
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
  const examples = [t('app.example1'), t('app.example2'), t('app.example3')];

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
