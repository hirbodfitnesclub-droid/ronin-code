import type { ReactNode } from 'react';

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="small faint">{sub}</div> : null}
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-label="در حال بارگذاری" />;
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="alert" role="alert">
      {message}
    </div>
  );
}

export function OkBox({ message }: { message: string }) {
  if (!message) return null;
  return <div className="alert alert-ok">{message}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    pending: 'در انتظار بررسی',
    approved: 'تأییدشده',
    rejected: 'ردشده',
    refunded: 'بازگشت وجه',
    active: 'فعال',
    open: 'باز',
    resolved: 'بسته‌شده',
  };
  return <span className={`badge badge-${status}`}>{labels[status] ?? status}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={wide ? { maxWidth: 900 } : undefined}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            بستن ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Simple CSS bar chart: values normalized to the max. */
export function BarChart({
  data,
  colorClass,
  formatValue,
}: {
  data: { label: string; value: number }[];
  colorClass?: string;
  formatValue?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <Empty text="داده‌ای برای نمایش نیست." />;
  // Thin out axis labels so long series stay readable (~8 labels max).
  const step = Math.max(1, Math.ceil(data.length / 8));
  return (
    <div className="bars" dir="ltr">
      {data.map((d, i) => (
        <div className="bar-col" key={`${d.label}-${i}`} title={`${d.label}: ${formatValue ? formatValue(d.value) : String(d.value)}`}>
          <div className={`bar ${colorClass ?? ''}`} style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }} />
          <div className="bar-label">{i % step === 0 || i === data.length - 1 ? d.label : ''}</div>
        </div>
      ))}
    </div>
  );
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'خطای نامشخص رخ داد.';
}
