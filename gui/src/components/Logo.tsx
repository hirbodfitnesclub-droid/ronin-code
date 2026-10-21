export default function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none">
        {/* Open enso ring — a brush circle, unfinished by design */}
        <circle
          cx="16"
          cy="16"
          r="12.5"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="63 16"
          transform="rotate(-38 16 16)"
          opacity="0.92"
        />
        {/* Katana slash through the centre */}
        <path
          d="M9.5 22.5 L22.8 9.2"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path d="M21.2 7.6 L24.4 10.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}
