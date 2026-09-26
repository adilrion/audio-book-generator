import type { Metadata } from 'next';
import { ProjectView } from '@/components/project-view';
import { parseTimeParam } from '@/lib/timeline';

export const metadata: Metadata = { title: 'Project' };

/** /projects/:id?t=1:23 opens the read-along preview at 1 min 23 s. */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <ProjectView id={id} initialTime={parseTimeParam(sp.t)} />;
}
