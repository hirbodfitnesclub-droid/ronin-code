/* Ronin Code — per-family monogram marks for model families.
   Tasteful geometric inline SVGs, one distinct colour per family.
   No external images, no emoji. Shapes are original abstractions
   (hexagon, starburst, sparkle, wave…) — not vendor logos. */

import type { ReactNode } from 'react';

interface MarkDef {
  color: string;
  body: ReactNode;
}

const S = {
  fill: 'currentColor',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fillNone: 'none',
};

const MARKS: Record<string, MarkDef> = {
  OpenAI: {
    color: '#10a37f',
    body: (
      <path
        d="M12 3.2 19.2 7.4v9.2L12 20.8 4.8 16.6V7.4L12 3.2Z"
        fill={S.fillNone}
        stroke={S.stroke}
        strokeWidth={S.strokeWidth}
        strokeLinejoin={S.strokeLinejoin}
      />
    ),
  },
  Claude: {
    color: '#d97757',
    body: (
      <g stroke={S.stroke} strokeWidth={2} strokeLinecap={S.strokeLinecap}>
        <path d="M12 4v16M5.1 8l13.8 8M18.9 8L5.1 16" />
      </g>
    ),
  },
  Gemini: {
    color: '#4796e3',
    body: <path d="M12 3c.9 5.8 2.4 7.6 9 9-6.6 1.4-8.1 3.2-9 9-.9-5.8-2.4-7.6-9-9 6.6-1.4 8.1-3.2 9-9Z" fill={S.fill} />,
  },
  Grok: {
    color: '#8a93a1',
    body: (
      <g stroke={S.stroke} strokeWidth={2.6} strokeLinecap={S.strokeLinecap}>
        <path d="M5 5l14 14M19 5L5 19" />
      </g>
    ),
  },
  DeepSeek: {
    color: '#4d6bfe',
    body: (
      <>
        <path
          d="M3 15c2.8 0 2.8-4.5 5.6-4.5S11.4 15 14.2 15 17 10.5 19.8 10.5"
          fill={S.fillNone}
          stroke={S.stroke}
          strokeWidth={2}
          strokeLinecap={S.strokeLinecap}
        />
        <circle cx="18.6" cy="16.8" r="1.5" fill={S.fill} />
      </>
    ),
  },
  Xiaomi: {
    color: '#ff6900',
    body: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="4.5" fill={S.fillNone} stroke={S.stroke} strokeWidth={1.9} />
        <path d="M8.5 16V8.5L12 12l3.5-3.5V16" fill={S.fillNone} stroke={S.stroke} strokeWidth={1.7} strokeLinecap={S.strokeLinecap} strokeLinejoin={S.strokeLinejoin} />
      </>
    ),
  },
  GLM: {
    color: '#7c6cf0',
    body: (
      <path
        d="M12 3.5 20 12l-8 8.5L4 12l8-8.5Z M4 12h16"
        fill={S.fillNone}
        stroke={S.stroke}
        strokeWidth={1.7}
        strokeLinejoin={S.strokeLinejoin}
      />
    ),
  },
  Qwen: {
    color: '#a259e6',
    body: (
      <>
        <circle cx="12" cy="12" r="7.5" fill={S.fillNone} stroke={S.stroke} strokeWidth={1.8} strokeDasharray="34 14" strokeLinecap={S.strokeLinecap} transform="rotate(40 12 12)" />
        <circle cx="12" cy="12" r="2" fill={S.fill} />
      </>
    ),
  },
  Kimi: {
    color: '#d9a441',
    body: <path d="M19.5 15.5A8.5 8.5 0 1 1 8.5 4.5a7 7 0 1 0 11 11Z" fill={S.fill} />,
  },
  MiniMax: {
    color: '#ec4899',
    body: (
      <g stroke={S.stroke} strokeWidth={2.2} strokeLinecap={S.strokeLinecap}>
        <path d="M6 17V9M12 17V5M18 17v-6" />
      </g>
    ),
  },
  Tencent: {
    color: '#00a4ff',
    body: (
      <path
        d="M7 18h10.2a3.6 3.6 0 0 0 .7-7.1A5.6 5.6 0 0 0 6.9 9.6 4.3 4.3 0 0 0 7 18Z"
        fill={S.fillNone}
        stroke={S.stroke}
        strokeWidth={1.8}
        strokeLinejoin={S.strokeLinejoin}
      />
    ),
  },
};

const FALLBACK: MarkDef = {
  color: '#8a93a1',
  body: (
    <>
      <circle cx="12" cy="12" r="7.5" fill="none" stroke={S.stroke} strokeWidth={1.8} />
      <circle cx="12" cy="12" r="2" fill={S.fill} />
    </>
  ),
};

export function familyMark(family: string): MarkDef {
  return MARKS[family] ?? FALLBACK;
}

export default function FamilyMark({ family, size = 16 }: { family: string; size?: number }) {
  const mark = familyMark(family);
  return (
    <span className="family-mark" style={{ color: mark.color }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {mark.body}
      </svg>
    </span>
  );
}
