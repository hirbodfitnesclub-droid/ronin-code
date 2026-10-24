import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Provider, type Starter, type Status } from '../lib/api';
import { makeLangCtx, type Lang } from '../lib/i18n';
import { humanErrorText } from '../lib/errors';

/* Ronin Code — session state: host status, providers, language, session
   cost, and the project/mode actions that mutate them. */

export interface SessionOptions {
  setNotice: (msg: string) => void;
  invalidatePreview: () => void;
  onStartersClose: () => void;
}

export function useSession(opts: SessionOptions) {
  const [status, setStatus] = useState<Status | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sessionCost, setSessionCost] = useState(0);
  const [langOverride, setLangOverride] = useState<Lang | null>(null);

  const lang: Lang = langOverride ?? status?.language ?? 'en';
  const ctx = useMemo(() => makeLangCtx(lang), [lang]);
  const { t, fmtUsd } = ctx;

  /* Delegates to the shared display helper (lib/errors): mapped code →
     localised string, genuine human sentence → as-is, everything else
     (raw codes, browser fetch text, synthetic status strings) → the
     localised fallback. Never returns a raw err.message verbatim. */
  const translateError = useCallback(
    (err: unknown, fallbackKey: Parameters<typeof t>[0] = 'errors.unknown'): string =>
      humanErrorText(err, t, fallbackKey),
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

  const openProject = async () => {
    const path = window.prompt(t('app.openProjectPrompt'), status?.project ?? '');
    if (!path || !path.trim()) return;
    opts.setNotice('');
    try {
      const res = await api.selectProject(path.trim());
      setStatus((prev) => (prev ? { ...prev, project: res.path } : prev));
      opts.invalidatePreview();
      void refreshMeta();
    } catch (err) {
      opts.setNotice(translateError(err, 'app.openProjectFailed'));
    }
  };

  const createStarter = async (starterId?: string) => {
    opts.setNotice('');
    try {
      const res = await api.starterProject(starterId);
      setStatus((prev) => (prev ? { ...prev, project: res.path } : prev));
      opts.invalidatePreview();
      opts.onStartersClose();
      void refreshMeta();
    } catch (err) {
      opts.setNotice(translateError(err, 'app.starterFailed'));
    }
  };

  const loadStarters = async (): Promise<Starter[]> => {
    try {
      return await api.starters();
    } catch {
      return [];
    }
  };

  const toggleAuto = async () => {
    if (!status) return;
    const next = !status.autoMode;
    try {
      if (status.project) {
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
      if (status.project) {
        await api.saveSettings({ projectMode: next ? 'plan' : null });
      } else {
        await api.saveSettings({ planMode: next });
      }
      void refreshMeta();
    } catch {
      /* non-fatal */
    }
  };

  /* Merge a freshly opened/built project path into status. */
  const setProjectPath = (path: string) => {
    setStatus((prev) => (prev ? { ...prev, project: path } : prev));
  };

  return {
    status,
    providers,
    sessionCost,
    setSessionCost,
    lang,
    ctx,
    t,
    fmtUsd,
    translateError,
    setLangOverride,
    refreshMeta,
    setProjectPath,
    openProject,
    createStarter,
    loadStarters,
    toggleAuto,
    togglePlan,
  };
}
