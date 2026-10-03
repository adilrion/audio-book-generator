import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { ShortBatch } from '@/components/short-batch';

export const metadata: Metadata = { title: 'Batch of shorts' };

/** /shorts/batch?project=<id> starts from one of the user's books. */
export default async function ShortBatchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const project = typeof sp.project === 'string' && /^[a-z0-9-]+$/i.test(sp.project) ? sp.project : undefined;
  return (
    <div className="grid gap-8">
      <PageHeader
        back={{ href: '/shorts', label: 'Shorts' }}
        title="Batch of shorts"
        description="Up to 10 Shorts at once: paste scripts from any AI tool, cut one long script into parts, or let the local AI write a series. One voice and look for all; they render one after another."
      />
      <ShortBatch initialProjectId={project} />
    </div>
  );
}
