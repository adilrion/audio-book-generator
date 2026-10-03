'use client';

import { Layers } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { ShortEditor } from '@/components/short-editor';
import { Button } from '@/components/ui/button';

export function NewShort({ projectId }: { projectId?: string }) {
  const router = useRouter();
  return (
    <div className="grid gap-8">
      <PageHeader
        back={{ href: '/shorts', label: 'Shorts' }}
        title="New short"
        description="A vertical video for YouTube Shorts: your script, a local voice, and captions that light up word by word."
        actions={
          <Button asChild variant="outline">
            <Link href={projectId ? `/shorts/batch?project=${projectId}` : '/shorts/batch'}>
              <Layers aria-hidden /> Make several at once
            </Link>
          </Button>
        }
      />
      <ShortEditor initialProjectId={projectId} onSaved={(s) => router.push(`/shorts/${s.id}`)} />
    </div>
  );
}
