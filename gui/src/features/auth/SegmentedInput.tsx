import React, { useRef } from 'react';

/* Ronin Code — segmented one-time-code input (auth): one box per
   character, grouped with a gap, fully paste-friendly (a paste
   anywhere fills the boxes from the normalised text), arrow/backspace
   navigation included. The value is the plain body string; the caller
   owns normalisation via `accept`. */

interface Props {
  value: string;
  length: number;
  groupAfter?: number; // visual gap after this many boxes (4 for RNC codes)
  prefix?: string; // static chip before the boxes (e.g. "RNC")
  accept: (raw: string) => string;
  onChange: (next: string) => void;
  ariaLabel: string;
  autoFocus?: boolean;
}

export default function SegmentedInput(p: Props) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const focusBox = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(p.length - 1, i))];
    el?.focus();
    el?.select();
  };

  const setChar = (index: number, rawChar: string) => {
    const clean = p.accept(rawChar);
    const chars = p.value.split('');
    while (chars.length < p.length) chars.push('');
    if (clean) {
      chars[index] = clean.slice(-1);
      p.onChange(chars.join(''));
      if (index < p.length - 1) focusBox(index + 1);
    } else if (rawChar === '') {
      chars[index] = '';
      p.onChange(chars.join(''));
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = p.accept(e.clipboardData.getData('text'));
    if (!text) return;
    p.onChange(text);
    focusBox(Math.min(text.length, p.length - 1));
  };

  const onKeyDown = (index: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !p.value[index] && index > 0) {
      e.preventDefault();
      const chars = p.value.split('');
      chars[index - 1] = '';
      p.onChange(chars.join(''));
      focusBox(index - 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusBox(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusBox(index + 1);
    }
  };

  return (
    <div className="seg-input" dir="ltr" onPaste={onPaste}>
      {p.prefix && <span className="seg-prefix">{p.prefix}</span>}
      {Array.from({ length: p.length }, (_, i) => (
        <React.Fragment key={i}>
          {p.groupAfter && i === p.groupAfter && <span className="seg-gap" aria-hidden="true" />}
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="seg-box"
            type="text"
            inputMode={p.prefix ? 'text' : 'numeric'}
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            autoFocus={p.autoFocus && i === 0}
            spellCheck={false}
            maxLength={1}
            value={p.value[i] ?? ''}
            onChange={(e) => setChar(i, e.target.value)}
            onKeyDown={onKeyDown(i)}
            onFocus={(e) => e.target.select()}
            aria-label={`${p.ariaLabel} ${i + 1}`}
          />
        </React.Fragment>
      ))}
    </div>
  );
}
