import { useEffect, useRef, useState } from 'react';
import { Card } from '../../components/ui';
import { api, ApiError, type Pack } from '../../lib/api';
import { ERROR_CODE_KEYS, useLang, type StringKey } from '../../lib/i18n';

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

/* Receipt claim for the selected pack — upload ONE receipt photo, no form fields. */
export function ClaimCard({ pack, onGoPurchases }: { pack: Pack | null; onGoPurchases: () => void }) {
  const { t, fmtToman } = useLang();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<StringKey | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  // A different pack means a fresh claim form.
  useEffect(() => {
    setSubmitted(false);
    setError(null);
  }, [pack?.id]);

  const pickFile = (candidate: File | null | undefined) => {
    if (!candidate) return;
    if (!candidate.type.startsWith('image/')) {
      setError('errors.invalid_receipt_type');
      return;
    }
    if (candidate.size > MAX_RECEIPT_BYTES) {
      setError('errors.receipt_too_large');
      return;
    }
    setError(null);
    setFile(candidate);
    setPreview(URL.createObjectURL(candidate));
  };

  const removeFile = () => {
    setFile(null);
    setPreview(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const submit = async () => {
    if (!pack || submitting) return;
    if (!file) {
      setError('errors.receipt_required');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.createClaim(pack.id, file);
      setSubmitted(true);
      removeFile();
    } catch (e) {
      if (e instanceof ApiError) setError(ERROR_CODE_KEYS[e.code] ?? 'errors.unknown');
      else setError('errors.unknown');
    } finally {
      setSubmitting(false);
    }
  };

  if (!pack) {
    return (
      <Card>
        <h2 className="buy-card-title">{t('buy.uploadReceipt')}</h2>
        <p className="buy-muted">{t('buy.step1')}</p>
      </Card>
    );
  }

  if (submitted) {
    return (
      <Card className="buy-success">
        <div className="buy-success-icon" aria-hidden="true">
          ✓
        </div>
        <p className="buy-success-text">{t('buy.claimSubmitted')}</p>
        <p className="buy-muted">{t('purchases.pendingNote')}</p>
        <button type="button" className="btn btn-primary" onClick={onGoPurchases}>
          {t('nav.purchases')}
        </button>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="buy-card-title">{t('buy.uploadReceipt')}</h2>
      <div className="buy-amount-row">
        <span>{t('buy.amountToPay')}</span>
        <strong>
          {pack.priceRials > 0 ? (
            <>
              <span className="ltr-island">{fmtToman(pack.priceRials)}</span> {t('common.toman')}
            </>
          ) : (
            <span className="ltr-island">${pack.usd}</span>
          )}
        </strong>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="buy-file-input"
        aria-label={t('buy.receiptChoose')}
        onChange={(e) => pickFile(e.target.files?.[0])}
      />

      {preview && file ? (
        <div className="buy-preview">
          <img src={preview} alt={t('buy.receiptSelected', { name: file.name })} className="buy-preview-img" />
          <div className="buy-preview-meta">
            <span className="buy-preview-name ltr-island">{file.name}</span>
            <div className="buy-preview-actions">
              <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
                {t('buy.receiptReplace')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={removeFile}>
                {t('buy.receiptRemove')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={dragging ? 'buy-dropzone is-dragging' : 'buy-dropzone'}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pickFile(e.dataTransfer.files?.[0]);
          }}
        >
          <span className="buy-dropzone-icon" aria-hidden="true">
            ⬆
          </span>
          <span className="buy-dropzone-title">{t('buy.receiptChoose')}</span>
          <span className="buy-dropzone-hint">{t('buy.receiptHint')}</span>
        </button>
      )}

      {error ? (
        <div className="buy-error" role="alert">
          {t(error)}
        </div>
      ) : null}

      <button
        type="button"
        className="btn btn-primary btn-block buy-submit"
        disabled={submitting}
        onClick={() => void submit()}
      >
        {submitting ? t('buy.submitting') : t('buy.submitClaim')}
      </button>

      <ul className="buy-notes">
        <li>{t('buy.step2')}</li>
        <li>{t('buy.step3')}</li>
        <li>{t('buy.maxPendingNote')}</li>
      </ul>
    </Card>
  );
}
