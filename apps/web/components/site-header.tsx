import Link from 'next/link';
import { BookAudio, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="group flex min-w-0 items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid size-8 place-items-center rounded-lg bg-brand text-brand-foreground shadow-xs">
            <BookAudio className="size-[18px]" aria-hidden />
          </span>
          <span className="truncate">Read-Along Studio</span>
          <span className="hidden rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase sm:inline">Local</span>
        </Link>
        <nav className="ml-auto flex items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/">Projects</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/new">
              <Plus aria-hidden />
              <span>New Audiobook</span>
            </Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
