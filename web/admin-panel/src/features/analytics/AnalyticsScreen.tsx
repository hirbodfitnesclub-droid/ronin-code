import { useEffect, useRef, useState } from 'react';
import { api, type AnalyticsOverview } from '../../lib/api';
import { formatDate, formatNumber, formatToman, formatTokens } from '../../lib/format';
import { BarChart, Card, ErrorBox, Spinner, StatCard, errText } from '../../components/ui/primitives';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export default function AnalyticsScreen() {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .analytics(30)
      .then(setData)
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  async function sendChat() {
    const content = draft.trim();
    if (!content || chatBusy) return;
    const next: ChatMsg[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setDraft('');
    setChatBusy(true);
    setChatError('');
    try {
      const r = await api.analystChat(next);
      setMessages([...next, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      setChatError(errText(e));
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div data-testid="screen-analytics">
      <div className="page-head">
        <h1>تحلیل و آمار</h1>
        <span className="dim small">بازه: ۳۰ روز اخیر</span>
      </div>
      <ErrorBox message={error} />
      {!data ? (
        <Spinner />
      ) : (
        <div className="section-gap">
          <div className="stat-grid">
            <StatCard label="کل کاربران" value={formatNumber(data.totals.users)} />
            <StatCard label="درآمد دوره" value={formatToman(data.totals.revenueRials)} />
            <StatCard label="توکن مصرف‌شده" value={formatTokens(data.totals.consumedTokens)} />
            <StatCard label="توکن اعطاشده" value={formatTokens(data.totals.grantedTokens)} />
            <StatCard
              label="نرخ تأیید رسیدها"
              value={data.claims.approvalRate === null ? '—' : `${formatNumber(Math.round(data.claims.approvalRate * 10) / 10)}٪`}
              sub={`تأیید ${formatNumber(data.claims.approved)} · رد ${formatNumber(data.claims.rejected)} · در انتظار ${formatNumber(data.claims.pending)} · بازگشتی ${formatNumber(data.claims.refunded)}`}
            />
          </div>
          <div className="grid-2">
            <Card title="درآمد روزانه">
              <BarChart
                data={data.series.map((s) => ({ label: formatDate(s.date), value: s.revenueRials }))}
                formatValue={(v) => formatToman(v)}
              />
            </Card>
            <Card title="مصرف توکن روزانه">
              <BarChart
                colorClass="bar-cyan"
                data={data.series.map((s) => ({ label: formatDate(s.date), value: s.consumedTokens }))}
                formatValue={(v) => `${formatTokens(v)} توکن`}
              />
            </Card>
          </div>
          <div className="grid-2">
            <Card title="کاربران جدید روزانه">
              <BarChart
                colorClass="bar-green"
                data={data.series.map((s) => ({ label: formatDate(s.date), value: s.newUsers }))}
                formatValue={(v) => `${formatNumber(v)} کاربر`}
              />
            </Card>
            <Card title="مدل‌های پرمصرف">
              {data.topModels.length === 0 ? (
                <p className="dim">داده‌ای ثبت نشده است.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data" style={{ minWidth: 0 }}>
                    <thead>
                      <tr>
                        <th>مدل</th>
                        <th>توکن</th>
                        <th>درخواست</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topModels.map((m) => (
                        <tr key={m.model}>
                          <td className="ltr mono">{m.model}</td>
                          <td>{formatTokens(m.tokens)}</td>
                          <td>{formatNumber(m.requests)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
          <Card title="دستیار تحلیل‌گر هوش مصنوعی">
            <div className="chat-box">
              <div className="chat-log" ref={logRef}>
                {messages.length === 0 ? (
                  <p className="dim small">درباره فروش، مصرف، کاربران یا روندها بپرسید؛ پاسخ بر پایه داده‌های همین پنل است.</p>
                ) : null}
                {messages.map((m, i) => (
                  <div key={i} className={`chat-msg ${m.role === 'user' ? 'user' : ''}`}>
                    {m.content}
                  </div>
                ))}
                {chatBusy ? <div className="chat-msg">در حال تحلیل…</div> : null}
              </div>
              <ErrorBox message={chatError} />
              <form
                className="chat-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendChat();
                }}
              >
                <input className="input" placeholder="سؤال خود را بنویسید…" value={draft} onChange={(e) => setDraft(e.target.value)} />
                <button type="submit" className="btn btn-primary" disabled={chatBusy || !draft.trim()}>
                  ارسال
                </button>
              </form>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
