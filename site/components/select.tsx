import type { ComponentProps } from 'react';

// A dropdown in the site's dark style: the native select, so the keyboard and screen readers work as usual, with
// its own surface, border, focus ring and chevron instead of the browser's.
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className="relative mt-1 block">
      <select
        {...props}
        className={`w-full cursor-pointer appearance-none rounded-lg border bg-fd-background py-2 pl-3 pr-9 text-fd-foreground transition-colors hover:border-fd-primary/50 focus:border-fd-primary focus:outline-none focus:ring-2 focus:ring-fd-primary/30 [&>option]:bg-fd-popover [&>option]:text-fd-popover-foreground ${className ?? ''}`}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fd-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
