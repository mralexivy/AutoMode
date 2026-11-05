import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { absolute, basePath, moved } from '@/lib/shared';

// A static redirect for each address of the old site. GitHub Pages cannot send a 301, so the page refreshes at once
// and names the new page as canonical. Google treats an instant refresh like a permanent redirect.
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(moved).map((old) => ({ old }));
}

export async function generateMetadata(props: PageProps<'/[old]'>): Promise<Metadata> {
  const { old } = await props.params;
  const to = moved[old];
  if (!to) notFound();
  return { title: 'Moved', alternates: { canonical: absolute(to) } };
}

export default async function Moved(props: PageProps<'/[old]'>) {
  const { old } = await props.params;
  const to = moved[old];
  if (!to) notFound();
  return (
    <main className="mx-auto max-w-xl p-10 text-center">
      {/* React hoists this into the head of the static file. */}
      <meta httpEquiv="refresh" content={`0; url=${basePath}${to}/`} />
      <p>
        This page moved to <Link href={to} className="text-fd-primary underline">{absolute(to)}</Link>.
      </p>
    </main>
  );
}
