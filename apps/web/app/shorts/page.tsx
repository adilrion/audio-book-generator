import type { Metadata } from 'next';
import { ShortsList } from '@/components/shorts-list';

export const metadata: Metadata = { title: 'Shorts' };

/** /shorts?batch=<id>,<id>… follows a batch that was just created. */
export default async function ShortsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const batch = typeof sp.batch === 'string' ? sp.batch.split(',').filter((id) => /^[a-z0-9-]{8,64}$/i.test(id)).slice(0, 10) : [];
  return <ShortsList batch={batch} />;
}
