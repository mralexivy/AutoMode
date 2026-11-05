import Link from 'next/link';

export const metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="text-fd-muted-foreground">This page does not exist. Search the docs, or start from the home page.</p>
      <div className="flex gap-3">
        <Link href="/" className="rounded-lg border px-4 py-2">Home</Link>
        <Link href="/docs" className="rounded-lg border px-4 py-2">Docs</Link>
      </div>
    </main>
  );
}
