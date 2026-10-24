import { useEffect, useState } from 'react';
import { api, type Provider, type Status, type Theme } from '../../lib/api';
import RouterSection from './RouterSection';
import ModelMultiSelect from './ModelMultiSelect';
import ThemeSegmented from '../../components/ui/ThemeSegmented';
import { humanErrorText } from '../../lib/errors';
import { formatTokens } from '../../lib/format';
import { useLang, type Lang } from '../../lib/i18n';

/* Ronin Code — Settings as a full SCREEN (RDX-08), converted from
   the old modal: a compact section nav on the side, one section at
   a time, and the same single save/test semantics as before (one
   Save persists every section). Sections: Connection & keys (BYOK),
   Models, Router, Subscription (server balance/usage figures +
   panel links — no prices, no checkout in-app), Account, Appearance,
   Language, Safety. */

interface Props {
  providers: Provider[];
  status: Status | null;
  onSaved: () => void;
  onBack: () => void;
}

type SectionId = 'connection' | 'models' | 'router' | 'subscription' | 'account' | 'appearance' | 'language' | 'safety';

export default function SettingsScreen({ providers, status, onSaved, onBack }: Props) {
  const { t } = useLang();
  const [section, setSection] = useState<SectionId>('connection');

  /* Form state — seeded once from the status at mount (the screen
     only mounts when opened, like the modal did). */
  const initial = providers.find((p) => p.id === status?.provider) ?? providers[0];
  const [provider, setProvider] = useState(initial?.id ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(
    status?.provider === initial?.id && status?.model ? status.model : (initial?.defaultModel ?? ''),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState('');
  const [savedNote, setSavedNote] = useState(false);

  const [language, setLanguage] = useState<Lang>(status?.language ?? 'en');
  const [theme, setTheme] = useState<Theme>(status?.theme ?? 'dark');
  const [enabledModels, setEnabledModels] = useState<string[]>(status?.enabledModels ?? []);
  const [extraKeys, setExtraKeys] = useState<string[]>(['']);
  const [failoverOn, setFailoverOn] = useState(status?.failover ?? true);
  const [failoverOrder, setFailoverOrder] = useState<string[]>([]);
  const [envAccess, setEnvAccess] = useState(status?.envAccess ?? false);
  const [projectMode, setProjectMode] = useState<'auto' | 'plan' | ''>(status?.projectMode ?? '');
  const [budget, setBudget] = useState(status?.budgetCapUsd ? String(status.budgetCapUsd) : '');
  const [rtkSaved, setRtkSaved] = useState(0);

  const selected = providers.find((p) => p.id === provider);
  const others = providers.filter((p) => p.id !== provider);
  const sub = status?.auth?.subscription ?? null;
  const panelUrl = status?.panelUrl;

  useEffect(() => {
    void api
      .usage()
      .then((u) => setRtkSaved(u.rtk.savedChars))
      .catch(() => setRtkSaved(0));
  }, []);

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
    setSavedNote(false);
    try {
      await api.saveSettings({
        provider,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(provider === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
        language,
        theme,
        enabledModels,
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
      setSavedNote(true);
      onSaved();
    } catch (err) {
      setSaveError(humanErrorText(err, t, 'settings.saveFailed'));
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
        message: humanErrorText(err, t, 'settings.testFailed'),
      });
    } finally {
      setTesting(false);
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* the app re-checks auth on refresh either way */
    }
    onSaved();
  };

  const nav: Array<{ id: SectionId; label: string }> = [
    { id: 'connection', label: t('settings.sectionConnection') },
    { id: 'models', label: t('settings.models.title') },
    { id: 'router', label: t('settings.router') },
    { id: 'subscription', label: t('settings.sectionSubscription') },
    { id: 'account', label: t('settings.sectionAccount') },
    { id: 'appearance', label: t('settings.sectionAppearance') },
    { id: 'language', label: t('settings.language') },
    { id: 'safety', label: t('settings.safety') },
  ];

  return (
    <div className="settings-screen">
      <aside className="settings-nav">
        <button type="button" className="settings-back" onClick={onBack}>
          <span className="settings-back-arrow" aria-hidden="true">
            ←
          </span>
          {t('auth.back')}
        </button>
        <h2 className="settings-nav-title">{t('settings.title')}</h2>
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`settings-nav-item ${section === item.id ? 'settings-nav-item--active' : ''}`}
            onClick={() => setSection(item.id)}
            aria-current={section === item.id ? 'page' : undefined}
          >
            {item.label}
          </button>
        ))}
      </aside>

      <div className="settings-content">
        <div className="settings-scroll">
          {section === 'connection' && (
            <section className="settings-pane">
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
            </section>
          )}

          {section === 'models' && (
            <section className="settings-pane">
              <h3>{t('settings.models.title')}</h3>
              <span className="field-hint">{t('settings.models.hint')}</span>
              <ModelMultiSelect value={enabledModels} onChange={setEnabledModels} />
            </section>
          )}

          {section === 'router' && (
            <section className="settings-pane">
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
                onRemoveKey={(index) => void removeKey(index)}
              />
            </section>
          )}

          {section === 'subscription' && (
            <section className="settings-pane">
              <h3>{t('settings.sectionSubscription')}</h3>
              {sub ? (
                <>
                  <dl className="settings-kv">
                    <div>
                      <dt>{t('account.balance')}</dt>
                      <dd dir="ltr">{formatTokens(sub.balanceTokens)}</dd>
                    </div>
                    <div>
                      <dt>{t('settings.subSpendable')}</dt>
                      <dd dir="ltr">{formatTokens(sub.spendableTokens)}</dd>
                    </div>
                    <div>
                      <dt>{t('settings.subStatus')}</dt>
                      <dd>{sub.status === 'active' ? t('settings.subStatusActive') : t('settings.subStatusInactive')}</dd>
                    </div>
                    <div>
                      <dt>{t('settings.subDevice')}</dt>
                      <dd>{sub.deviceAuthorized ? t('settings.subDeviceOk') : t('settings.subDeviceNo')}</dd>
                    </div>
                  </dl>
                  {sub.subscriptionKeyMasked && (
                    <div className="settings-section">
                      <h3>{t('settings.subscriptionKey')}</h3>
                      <span className="field-hint">
                        <span dir="ltr">{sub.subscriptionKeyMasked}</span>
                        {sub.subscriptionKeyStatus ? ` · ${sub.subscriptionKeyStatus}` : ''}
                      </span>
                      <span className="field-hint">{t('settings.subscriptionKeyHint')}</span>
                    </div>
                  )}
                  {panelUrl && (
                    <div className="settings-inline-actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => window.open(panelUrl, '_blank', 'noopener')}
                      >
                        {t('picker.buyCredit')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => window.open(panelUrl, '_blank', 'noopener')}
                      >
                        {t('account.openPanel')}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p className="field-hint">{t('picker.subscriptionLocked')}</p>
              )}
            </section>
          )}

          {section === 'account' && (
            <section className="settings-pane">
              <h3>{t('settings.sectionAccount')}</h3>
              <dl className="settings-kv">
                <div>
                  <dt>{t('settings.accountName')}</dt>
                  <dd>{status?.auth?.user?.name || '—'}</dd>
                </div>
                <div>
                  <dt>{t('settings.accountPhone')}</dt>
                  <dd dir="ltr">{status?.auth?.user?.phone || '—'}</dd>
                </div>
                <div>
                  <dt>{t('settings.subDevice')}</dt>
                  <dd>{sub?.deviceAuthorized ? t('settings.subDeviceOk') : t('settings.subDeviceNo')}</dd>
                </div>
              </dl>
              <div className="settings-inline-actions">
                <button type="button" className="btn btn--ghost btn--sm" onClick={onSaved}>
                  {t('account.refreshBalance')}
                </button>
                <button type="button" className="btn btn--danger-ghost btn--sm" onClick={() => void logout()}>
                  {t('account.logout')}
                </button>
              </div>
            </section>
          )}

          {section === 'appearance' && (
            <section className="settings-pane">
              <div className="field">
                <span className="field-label">{t('settings.theme')}</span>
                <ThemeSegmented
                  value={theme}
                  onChange={(next) => {
                    setTheme(next);
                    document.documentElement.dataset.theme = next;
                  }}
                />
              </div>
            </section>
          )}

          {section === 'language' && (
            <section className="settings-pane">
              <label className="field">
                <span className="field-label">{t('settings.language')}</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
                  <option value="en">English</option>
                  <option value="fa">فارسی</option>
                </select>
                <span className="field-hint">{t('settings.languageHint')}</span>
              </label>
            </section>
          )}

          {section === 'safety' && (
            <section className="settings-pane">
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
            </section>
          )}
        </div>

        <div className="settings-footer">
          <span className="settings-footer-status">
            {testResult && (
              <span className={`test-result ${testResult.ok ? 'test-result--ok' : 'test-result--bad'}`}>
                {testResult.message}
              </span>
            )}
            {saveError && <span className="test-result test-result--bad">{saveError}</span>}
            {savedNote && !saveError && <span className="test-result test-result--ok">{t('settings.savedNote')}</span>}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => void test()} disabled={testing || saving || !provider}>
            {testing ? t('settings.testing') : t('settings.test')}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving || !provider}>
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
