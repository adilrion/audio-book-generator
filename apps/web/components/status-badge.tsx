import type { JobStatus } from '@app/types';
import { Ban, CircleCheck, CircleX, Clock, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { isActive, STATUS_LABELS } from '@/lib/stages';

export function StatusBadge({ status, queued, className }: { status: JobStatus; queued?: boolean; className?: string }) {
  if (status === 'COMPLETED')
    return (
      <Badge variant="success" className={className}>
        <CircleCheck aria-hidden /> Completed
      </Badge>
    );
  if (status === 'FAILED')
    return (
      <Badge variant="destructive" className={className}>
        <CircleX aria-hidden /> Failed
      </Badge>
    );
  if (status === 'CANCELLED')
    return (
      <Badge variant="muted" className={className}>
        <Ban aria-hidden /> Cancelled
      </Badge>
    );
  if (isActive(status))
    return (
      <Badge variant="info" className={className}>
        <LoaderCircle className="animate-spin" aria-hidden /> {STATUS_LABELS[status]}
      </Badge>
    );
  return (
    <Badge variant="secondary" className={className}>
      <Clock aria-hidden /> {queued ? 'Queued' : 'Not started'}
    </Badge>
  );
}
