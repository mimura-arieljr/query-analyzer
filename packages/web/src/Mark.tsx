// A magnifier over query lines; the blue block is the cursor.
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path d="M18.5 18.5 25 25" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M8 9.5h8M8 13.5h3" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <rect x="12.75" y="12.1" width="3.5" height="2.8" rx="0.5" fill="var(--hue)" />
    </svg>
  );
}
