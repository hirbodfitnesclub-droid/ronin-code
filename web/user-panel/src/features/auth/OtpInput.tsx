import { useRef } from 'react';
import { normalizeDigits } from './helpers';

/* Six digit boxes (LTR island): auto-advance, backspace-to-previous, paste fills all. */
export function OtpInput({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const focusBox = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(5, i))];
    el?.focus();
    el?.select();
  };

  const setDigit = (i: number, digit: string) => {
    const next = value.split('');
    while (next.length < 6) next.push('');
    next[i] = digit;
    onChange(next.join('').slice(0, 6));
  };

  return (
    <div className="otp-boxes ltr-island" role="group" aria-label={label}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="otp-box"
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`${label} ${i + 1}`}
          disabled={disabled}
          value={value[i] ?? ''}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const digits = normalizeDigits(e.target.value);
            if (!digits) {
              setDigit(i, '');
              return;
            }
            if (digits.length > 1) {
              // Typed/pasted several digits into one box — spread them forward.
              const merged = (value.slice(0, i) + digits).slice(0, 6);
              onChange(merged);
              focusBox(Math.min(5, i + digits.length));
              return;
            }
            setDigit(i, digits);
            if (i < 5) focusBox(i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              if (value[i]) setDigit(i, '');
              else if (i > 0) {
                setDigit(i - 1, '');
                focusBox(i - 1);
              }
            } else if (e.key === 'ArrowLeft' && i > 0) {
              e.preventDefault();
              focusBox(i - 1);
            } else if (e.key === 'ArrowRight' && i < 5) {
              e.preventDefault();
              focusBox(i + 1);
            }
          }}
          onPaste={(e) => {
            const digits = normalizeDigits(e.clipboardData.getData('text'));
            if (digits.length < 2) return;
            e.preventDefault();
            const merged = (value.slice(0, i) + digits).slice(0, 6);
            onChange(merged);
            focusBox(Math.min(5, merged.length));
          }}
        />
      ))}
    </div>
  );
}
