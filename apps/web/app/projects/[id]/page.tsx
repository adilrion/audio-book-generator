import type { Metadata } from 'next';
import { ProjectView } from '@/components/project-view';

export const metadata: Metadata = { title: 'Project' };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectView id={id} />;
}
