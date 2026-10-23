import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, openStream, type ActivityKind, type ChangedFile, type StreamEvent } from '../../lib/api';
import { bannerForTurnError } from '../../lib/turnErrors';
import { defaultEffort, hasFast, modelById, pickerEfforts } from '../../lib/models';
import type { StringKey } from '../../lib/i18n';
import type { TimelineItem } from './types';

/* Ronin Code — chat state machine: the timeline, the live activity
   stream, approvals and plans. Consumes the host's SSE stream; only the
   client that started a turn consumes its events (host broadcasts). */

let nextId = 1;
const id = () => nextId++;

export interface ChatOptions {
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  translateError: (err: unknown, fallbackKey?: StringKey) => string;
  setNotice: (msg: string) => void;
  refreshMeta: () => Promise<void>;
  invalidatePreview: () => void;
  onSessionCost: (sessionTotalUsd: number) => void;
  enabledModels: string[];
  activeModelId: string | null;
  onLoginRequired: () => void;
}

export type ChatBanner = 'credit' | 'locked' | null;

export function useChat(opts: ChatOptions) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [activities, setActivities] = useState<Array<{ id: string; kind: ActivityKind }>>([]);

  /* ---------------- model picker state ---------------- */
  const [pickedModelId, setPickedModelId] = useState<string | null>(null);
  const [effortPick, setEffortPick] = useState<string | null>(null);
  const [fast, setFast] = useState(false);
  const [banner, setBanner] = useState<ChatBanner>(null);

  const modelId = pickedModelId ?? opts.activeModelId ?? opts.enabledModels[0] ?? null;
  const activeModel = modelById(modelId);
  const effortOptions = pickerEfforts(activeModel);
  const effort =
    effortPick && effortOptions.includes(effortPick) ? effortPick : defaultEffort(activeModel);
  const fastAvailable = hasFast(activeModel);

  /* A new model resets effort/fast to sensible defaults. */
  const lastModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastModelRef.current !== modelId) {
      lastModelRef.current = modelId;
      setEffortPick(null);
      setFast(false);
    }
  }, [modelId]);

  const selectModel = useCallback((id_: string) => {
    setPickedModelId(id_);
    void api.saveSettings({ activeModelId: id_ }).catch(() => {
      /* non-fatal — the pick still applies to this session */
    });
  }, []);

  const runningRef = useRef(false);
  const streamingIdRef = useRef<number | null>(null);
  const pendingChangesRef = useRef<ChangedFile[]>([]);
  const pendingUsageRef = useRef<{ costUsd: number; estimated: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* DEV-ONLY visual QA fixtures (stripped from production builds). */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has('devChanges')) {
      setItems([
        { kind: 'message', id: id(), role: 'user', text: 'Add a dark hero section with a signup form' },
        { kind: 'message', id: id(), role: 'assistant', text: 'Done — the hero is live in the preview.' },
        {
          kind: 'changes',
          id: id(),
          undoing: false,
          undone: false,
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
              kind: 'changes',
              id: id(),
              files,
              undoing: false,
              undone: false,
              ...(usage ? { costUsd: usage.costUsd, costEstimated: usage.estimated } : {}),
            },
          ];
        }
        return next;
      });

      opts.invalidatePreview();
      void opts.refreshMeta();
    },
    [opts],
  );

  useEffect(() => {
    const handle = (ev: StreamEvent) => {
      /* The host broadcasts one shared stream; only the client that
         started the turn consumes it. */
      if (!runningRef.current) return;
      switch (ev.type) {
        case 'activity_start':
          setActivities((prev) =>
            prev.some((a) => a.id === ev.activityId) ? prev : [...prev, { id: ev.activityId, kind: ev.kind }],
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
              kind: 'approval',
              id: id(),
              approvalId: ev.approvalId,
              approvalKind: ev.kind,
              detail: ev.detail,
              resolved: null,
            },
          ]);
          break;
        case 'approval_resolved':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'approval' && it.approvalId === ev.approvalId ? { ...it, resolved: ev.approved } : it,
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
            prev.map((it) => (it.kind === 'plan' && it.planId === ev.planId ? { ...it, steps: ev.steps } : it)),
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
          opts.onSessionCost(ev.sessionTotalUsd);
          break;
        case 'provider_switched':
          void opts.refreshMeta();
          break;
        case 'budget_warning':
          opts.setNotice(opts.t('cost.budgetWarn'));
          break;
        case 'budget_exceeded':
          opts.setNotice(opts.t('cost.budgetHit'));
          break;
        case 'turn_done':
          finishTurn();
          break;
        case 'turn_error': {
          if (ev.code === 'login_required') {
            finishTurn();
            opts.onLoginRequired();
            break;
          }
          /* Existing banners only: 402 -> credit, locked/suspended ->
             locked (lib/turnErrors). No visual redesign. */
          const banner = bannerForTurnError(ev.code);
          if (banner) {
            setBanner(banner);
            finishTurn();
          } else {
            finishTurn(ev.message || opts.t('app.genericTurnError'));
          }
          break;
        }
      }
    };

    const source = openStream(handle);
    return () => source.close();
  }, [finishTurn, opts]);

  /* ---------------- auto-scroll chat ---------------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, activities, running]);

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
      setBanner(null);
      try {
        await api.startTurn(prompt, {
          ...(modelId ? { modelId } : {}),
          ...(effort ? { effort } : {}),
          ...(fastAvailable ? { fast } : {}),
        });
      } catch (err) {
        finishTurn(opts.translateError(err, 'app.turnStartFailed'));
      }
    },
    [input, finishTurn, opts, modelId, effort, fast, fastAvailable],
  );

  const undoChanges = async (itemId: number) => {
    setItems((prev) => prev.map((it) => (it.kind === 'changes' && it.id === itemId ? { ...it, undoing: true } : it)));
    try {
      await api.undo();
      setItems((prev) =>
        prev.map((it) => (it.kind === 'changes' && it.id === itemId ? { ...it, undoing: false, undone: true } : it)),
      );
      opts.invalidatePreview();
    } catch (err) {
      setItems((prev) =>
        prev.map((it) => (it.kind === 'changes' && it.id === itemId ? { ...it, undoing: false } : it)),
      );
      opts.setNotice(opts.translateError(err, 'app.undoFailed'));
    }
  };

  const decideApproval = async (approvalId: string, approved: boolean) => {
    setItems((prev) =>
      prev.map((it) => (it.kind === 'approval' && it.approvalId === approvalId ? { ...it, resolved: approved } : it)),
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
      opts.setNotice(opts.translateError(err));
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

  /* Start consuming a turn that was launched elsewhere (Idea build):
     appends the user's message and flips the chat into running state. */
  const beginTurnUi = (promptText: string) => {
    setItems((prev) => [...prev, { kind: 'message', id: id(), role: 'user', text: promptText }]);
    pendingChangesRef.current = [];
    streamingIdRef.current = null;
    runningRef.current = true;
    setRunning(true);
  };

  return {
    items,
    input,
    running,
    activities,
    scrollRef,
    textareaRef,
    modelId,
    activeModel,
    effort,
    effortOptions,
    fast,
    fastAvailable,
    banner,
    dismissBanner: () => setBanner(null),
    selectModel,
    setEffort: setEffortPick,
    setFast,
    send,
    undoChanges,
    decideApproval,
    approvePlan,
    rejectPlan,
    beginTurnUi,
    onInputKeyDown,
    onInputChange,
  };
}
