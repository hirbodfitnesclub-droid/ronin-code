import { useLang } from '../../lib/i18n';
import type { DayUsage } from '../../lib/api';

/* 7-day usage bars as inline SVG. The last day in the series is today. */
export function WeekChart({ days }: { days: DayUsage[] }) {
  const { lang, fmtNum } = useLang();
  const locale = lang === 'fa' ? 'fa-IR' : 'en-US';
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const width = 336;
  const height = 132;
  const baseline = 104;
  const slot = width / Math.max(1, days.length);
  const barW = Math.min(30, slot * 0.52);

  const weekday = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d);
  };

  return (
    <div dir="ltr" className="week-chart-wrap">
      <svg
        className="week-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={days.map((d) => `${d.date}: ${fmtNum(d.tokens)}`).join(', ')}
      >
        <line x1="0" y1={baseline} x2={width} y2={baseline} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
        {days.map((d, i) => {
          const h = Math.max(d.tokens > 0 ? 4 : 1.5, (d.tokens / max) * 88);
          const x = i * slot + (slot - barW) / 2;
          const isToday = i === days.length - 1;
          return (
            <g key={d.date}>
              <title>{`${d.date} — ${fmtNum(d.tokens)}`}</title>
              <rect
                x={x}
                y={baseline - h}
                width={barW}
                height={h}
                rx="5"
                fill={isToday ? 'var(--accent-bright)' : 'var(--accent)'}
                opacity={isToday ? 1 : 0.55}
              />
              <text x={i * slot + slot / 2} y={height - 8} textAnchor="middle" className="week-chart-label">
                {weekday(d.date)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
