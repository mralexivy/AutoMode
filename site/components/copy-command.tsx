'use client';
import { useState } from 'react';

// One install command with a copy button.
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-fd-card px-4 py-3 font-mono text-sm">
      <code className="flex-1 overflow-x-auto whitespace-nowrap">{command}</code>
      <button
        type="button"
        className="rounded-md bg-fd-secondary px-3 py-1.5 font-sans text-xs font-semibold"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {}
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
