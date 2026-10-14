import './router-brand.css';

export function RouterMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`mr-mark ${className}`}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M20 4 36 20 20 36 4 20 20 4Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="m20 12 8 8-8 8-8-8 8-8Z" fill="currentColor" />
      <path
        d="M20 4v8m16 8h-8m-8 16v-8M4 20h8"
        stroke="currentColor"
        strokeWidth="2.4"
      />
    </svg>
  );
}

export function RouterBrand({ light = false }: { light?: boolean }) {
  return (
    <a
      className={`mr-brand${light ? ' mr-brand-light' : ''}`}
      href="/admin/"
      aria-label="ModelRouter 首页"
    >
      <span className="mr-brand-symbol">
        <RouterMark />
      </span>
      <span>ModelRouter</span>
    </a>
  );
}
