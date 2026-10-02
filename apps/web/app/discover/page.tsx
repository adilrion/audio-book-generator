import type { Metadata } from 'next';
import { OnlineLibrary } from '@/components/online-library';
import { parseLibrarySearch } from '@/lib/library';

export const metadata: Metadata = { title: 'Online library' };

/** /discover?q=tagore&lang=bn&free=0 opens that search. */
export default async function DiscoverPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <OnlineLibrary initial={parseLibrarySearch(await searchParams)} />;
}
