import type { JobStatus } from '@app/types';
import { Badge } from '@/components/ui/badge';
import { isActive, STATUS_LABELS } from '@/lib/stages';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'destructive' | 'warning' | 'muted' | 'info' | 'secondary';

export function statusTone(status: JobStatus): Tone {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED') return 'destructive';
  if (status === 'AWAITING_REVIEW') return 'warning';
  if (status === 'CANCELLED') return 'muted';
  if (isActive(status)) return 'info';
  return 'secondary';
}

export function statusLabel(status: JobStatus, queued?: boolean): string {
  if (status === 'AWAITING_REVIEW') return 'Review chapters';
  if (status === 'PENDING') return queued ? 'Queued' : 'Not started';
  return STATUS_LABELS[status];
}

const DOT: Record<Tone, string> = {
  success: 'bg-success',
  destructive: 'bg-destructive',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground/60',
  info: 'bg-info',
  secondary: 'bg-muted-foreground/50',
};

/** Coloured status dot; pulses while the project is processing. */
export function StatusDot({ status, className }: { status: JobStatus; className?: string }) {
  const tone = statusTone(status);
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {tone === 'info' && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none', DOT[tone])} />}
      <span className={cn('relative size-2 rounded-full', DOT[tone])} />
    </span>
  );
}

export function StatusBadge({ status, queued, className }: { status: JobStatus; queued?: boolean; className?: string }) {
  return (
    <Badge variant={statusTone(status)} className={className}>
      <StatusDot status={status} className="size-1.5 [&>span]:size-1.5" />
      {statusLabel(status, queued)}
    </Badge>
  );
}
