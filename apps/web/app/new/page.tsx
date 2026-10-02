import type { Metadata } from 'next';
import { NewProject } from '@/components/new-project';
import { parseNewParams } from '@/lib/library';

export const metadata: Metadata = { title: 'New audiobook' };

/** /new?archive=<id>&file=<pdf> starts with a book from the online library; ?source=library|link opens that tab. */
export default async function NewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { book, tab } = parseNewParams(await searchParams);
  return <NewProject initialBook={book} initialTab={tab} />;
}
