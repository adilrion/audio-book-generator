import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="-ml-1 flex w-fit items-center gap-0.5 rounded-md px-1 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ChevronLeft className="size-4" aria-hidden /> {children}
    </Link>
  );
}

/** Page title block: optional back link, serif title, one-line description and actions on the right. */
export function PageHeader({
  back,
  title,
  description,
  actions,
  className,
}: {
  back?: { href: string; label: string };
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('grid gap-3', className)}>
      {back && <BackLink href={back.href}>{back.label}</BackLink>}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="grid min-w-0 gap-1.5">
          <h1 className="font-serif text-[2rem] leading-[1.1] font-medium tracking-tight text-balance sm:text-[2.5rem]">{title}</h1>
          {description && <p className="max-w-2xl text-[15px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
