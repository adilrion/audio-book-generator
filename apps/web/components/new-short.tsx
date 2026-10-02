'use client';

import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { ShortEditor } from '@/components/short-editor';

export function NewShort({ projectId }: { projectId?: string }) {
  const router = useRouter();
  return (
    <div className="grid gap-8">
      <PageHeader
        back={{ href: '/shorts', label: 'Shorts' }}
        title="New short"
        description="A vertical video for YouTube Shorts: your script, a local voice, and captions that light up word by word."
      />
      <ShortEditor initialProjectId={projectId} onSaved={(s) => router.push(`/shorts/${s.id}`)} />
    </div>
  );
}
