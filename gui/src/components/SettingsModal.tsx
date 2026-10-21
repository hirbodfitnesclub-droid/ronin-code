import { useEffect, useState } from 'react';
import { api, type Provider, type Status } from '../api';

interface Props {
  open: boolean;
  providers: Provider[];
  status: Status | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function SettingsModal({ open, providers, status, onClose, onSaved }: Props) {
  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [modelTouched, setModelTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState('');

  const selected = providers.find((p) => p.id === provider);

  /* Seed the form each time the drawer opens. */
  useEffect(() => {
    if (!open) return;
    const initial =
      providers.find((p) => p.id === status?.provider) ?? providers[0];
    if (initial) {
      setProvider(initial.id);
      setBaseUrl(initial.baseUrl ?? '');
      setModel(
        status?.provider === initial.id && status?.model
          ? status.model
          : initial.defaultModel,
      );
    }
    setApiKey('');
    setModelTouched(false);
    setTestResult(null);
    setSaveError('');
  }, [open, providers, status]);

  if (!open) return null;

  const pickProvider = (id: string) => {
    setProvider(id);
    setTestResult(null);
    const next = providers.find((p) => p.id === id);
    if (next) setBaseUrl(next.baseUrl ?? '');
    if (next && !modelTouched) setModel(next.defaultModel);
    if (next && modelTouched) setModel(next.defaultModel);
    setModelTouched(false);
  };

  const save = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await api.saveSettings({
        provider,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(provider === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
      });
      setApiKey('');
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Persist a freshly-typed key first so the test exercises it.
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
        message: err instanceof Error ? err.message : 'Connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <label className="field">
          <span className="field-label">Provider</span>
          <select value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {providers.length === 0 && <option value="">No providers available</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {provider === 'custom' && (
          <label className="field">
            <span className="field-label">Endpoint URL</span>
            <input
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-endpoint.example/v1"
            />
            <span className="field-hint">Any OpenAI-compatible endpoint — Ronin talks to it directly.</span>
          </label>
        )}

        <label className="field">
          <span className="field-label">API key</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              selected?.hasKey
                ? `${selected.maskedKey || '••••••••'} — leave blank to keep`
                : 'Paste your API key'
            }
          />
          <span className="field-hint">Keys stay on this machine only — never sent anywhere else.</span>
        </label>

        <label className="field">
          <span className="field-label">Model</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setModelTouched(true);
            }}
            placeholder={selected?.defaultModel ?? 'Model id'}
          />
          <span className="field-hint">Prefilled with the provider default — edit for a custom model id.</span>
        </label>

        {testResult && (
          <p className={`test-result ${testResult.ok ? 'test-result--ok' : 'test-result--bad'}`}>
            {testResult.message}
          </p>
        )}
        {saveError && <p className="test-result test-result--bad">{saveError}</p>}

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={test}
            disabled={testing || saving || !provider}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={save}
            disabled={saving || !provider}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
