import type { Metadata } from 'next';
import { NewShort } from '@/components/new-short';

export const metadata: Metadata = { title: 'New short' };

/** /shorts/new?project=<id> starts from one of the user's books. */
export default async function NewShortPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const project = typeof sp.project === 'string' && /^[a-z0-9-]+$/i.test(sp.project) ? sp.project : undefined;
  return <NewShort projectId={project} />;
}
