import { useEffect, useState } from 'react';
import { api, type Provider, type Status } from '../../lib/api';
import RouterSection from './RouterSection';
import { useLang, type Lang } from '../../lib/i18n';

interface Props {
  open: boolean;
  providers: Provider[];
  status: Status | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function SettingsModal({ open, providers, status, onClose, onSaved }: Props) {
  const { t } = useLang();
  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState('');

  // v1 sections
  const [language, setLanguage] = useState<Lang>('en');
  const [extraKeys, setExtraKeys] = useState<string[]>(['']);
  const [failoverOn, setFailoverOn] = useState(true);
  const [failoverOrder, setFailoverOrder] = useState<string[]>([]);
  const [envAccess, setEnvAccess] = useState(false);
  const [projectMode, setProjectMode] = useState<'auto' | 'plan' | ''>('');
  const [budget, setBudget] = useState('');
  const [rtkSaved, setRtkSaved] = useState(0);

  const selected = providers.find((p) => p.id === provider);
  const others = providers.filter((p) => p.id !== provider);

  /* Seed the form each time the drawer opens. */
  useEffect(() => {
    if (!open) return;
    const initial = providers.find((p) => p.id === status?.provider) ?? providers[0];
    if (initial) {
      setProvider(initial.id);
      setBaseUrl(initial.baseUrl ?? '');
      setModel(status?.provider === initial.id && status?.model ? status.model : initial.defaultModel);
      setExtraKeys(['']);
    }
    setApiKey('');
    setTestResult(null);
    setSaveError('');
    setLanguage(status?.language ?? 'en');
    setFailoverOn(status?.failover ?? true);
    setEnvAccess(status?.envAccess ?? false);
    setProjectMode(status?.projectMode ?? '');
    setBudget(status?.budgetCapUsd ? String(status.budgetCapUsd) : '');
    void api
      .usage()
      .then((u) => setRtkSaved(u.rtk.savedChars))
      .catch(() => setRtkSaved(0));
  }, [open, providers, status]);

  if (!open) return null;

  const pickProvider = (id_: string) => {
    setProvider(id_);
    setTestResult(null);
    const next = providers.find((p) => p.id === id_);
    if (next) {
      setBaseUrl(next.baseUrl ?? '');
      setModel(next.defaultModel);
      setExtraKeys(['']);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await api.saveSettings({
        provider,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(provider === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
        language,
        failover: failoverOn,
        failoverOrder,
        envAccess,
        projectMode: projectMode === '' ? null : projectMode,
        budgetCapUsd: budget.trim() ? Number(budget) || null : null,
      });
      // Main key field: typing replaces the provider's first key slot.
      if (apiKey.trim()) {
        await api.saveSettings({ provider, apiKey: apiKey.trim() });
      }
      // Extra rows: typed keys are appended to the provider's list.
      const newExtras = extraKeys.map((v) => v.trim()).filter(Boolean);
      if (newExtras.length) {
        await api.saveSettings({ addKeys: newExtras, keysProvider: provider });
      }
      setApiKey('');
      setExtraKeys(['']);
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async (index: number) => {
    try {
      await api.saveSettings({ removeKeyIndex: index, keysProvider: provider });
      onSaved();
    } catch {
      /* non-fatal */
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (apiKey.trim() || provider === 'custom') {
        await api.saveSettings({
          provider,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(provider === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
        });
        setApiKey('');
        onSaved();
      }
      setTestResult(await api.testSettings(provider, provider === 'custom' ? baseUrl.trim() : undefined));
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : t('settings.testFailed'),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal modal--settings"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{t('settings.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>
            ×
          </button>
        </div>

        <label className="field">
          <span className="field-label">{t('settings.language')}</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
            <option value="en">English</option>
            <option value="fa">فارسی</option>
          </select>
          <span className="field-hint">{t('settings.languageHint')}</span>
        </label>

        <label className="field">
          <span className="field-label">{t('settings.provider')}</span>
          <select value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {providers.length === 0 && <option value="">{t('settings.noProviders')}</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {provider === 'custom' && (
          <label className="field">
            <span className="field-label">{t('settings.endpointUrl')}</span>
            <input
              type="url"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-endpoint.example/v1"
            />
            <span className="field-hint">{t('settings.endpointHint')}</span>
          </label>
        )}

        <label className="field">
          <span className="field-label">{t('settings.apiKey')}</span>
          <input
            type="password"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              selected?.hasKey
                ? t('settings.keepKey', { masked: selected.maskedKey || '••••••••' })
                : t('settings.apiKeyPlaceholder')
            }
          />
          <span className="field-hint">{t('settings.keysHint')}</span>
        </label>

        <label className="field">
          <span className="field-label">{t('settings.model')}</span>
          <input
            type="text"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={selected?.defaultModel ?? t('settings.modelPlaceholder')}
          />
          <span className="field-hint">{t('settings.modelHint')}</span>
        </label>

        <RouterSection
          keys={selected?.keys ?? []}
          extraKeys={extraKeys}
          onExtraKeysChange={setExtraKeys}
          failoverOn={failoverOn}
          onFailoverToggle={() => setFailoverOn((v) => !v)}
          others={others}
          failoverOrder={failoverOrder}
          onFailoverOrderChange={setFailoverOrder}
          rtkSaved={rtkSaved}
          onRemoveKey={(index) => removeKey(index)}
        />

        {/* ---------------- safety ---------------- */}
        <div className="settings-section">
          <h3>{t('settings.safety')}</h3>
          <div className="switch-row">
            <span className="switch-label">{t('settings.envAccess')}</span>
            <button
              type="button"
              className={`switch ${envAccess ? 'switch--on' : ''}`}
              onClick={() => setEnvAccess((v) => !v)}
              aria-pressed={envAccess}
              aria-label={t('settings.envAccess')}
            />
          </div>
          <span className="field-hint">{t('settings.envHint')}</span>

          <label className="field">
            <span className="field-label">{t('settings.projectMode')}</span>
            <select value={projectMode} onChange={(e) => setProjectMode(e.target.value as 'auto' | 'plan' | '')}>
              <option value="">{t('settings.modeDefault')}</option>
              <option value="auto">{t('settings.modeAuto')}</option>
              <option value="plan">{t('settings.modePlan')}</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">{t('settings.budget')}</span>
            <input
              type="number"
              dir="ltr"
              min="0"
              step="0.5"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder={t('settings.budgetPlaceholder')}
            />
            <span className="field-hint">{t('settings.budgetHint')}</span>
          </label>
        </div>

        {testResult && (
          <p className={`test-result ${testResult.ok ? 'test-result--ok' : 'test-result--bad'}`}>
            {testResult.message}
          </p>
        )}
        {saveError && <p className="test-result test-result--bad">{saveError}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn--ghost" onClick={test} disabled={testing || saving || !provider}>
            {testing ? t('settings.testing') : t('settings.test')}
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={saving || !provider}>
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
