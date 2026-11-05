import Link from 'next/link';

// The install call to action at the end of a guide.
export function InstallCard() {
  return (
    <div className="not-prose my-8 rounded-xl border bg-fd-card p-5">
      <p className="font-semibold">Install AutoMode</p>
      <p className="mt-1 text-sm text-fd-muted-foreground">
        Paste these into Claude Code, one at a time, then run <code>/reload-plugins</code>. It is free, needs no key and no server, and starts on its own.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg border bg-fd-background p-3 text-sm">
        <code>{'/plugin marketplace add mralexivy/AutoMode\n/plugin install automode@automode'}</code>
      </pre>
      <Link href="/docs/getting-started/install" className="mt-3 inline-block text-sm font-medium text-fd-primary underline">
        Read the install guide
      </Link>
    </div>
  );
}
