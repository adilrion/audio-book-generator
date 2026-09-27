'use client';

import type { ProjectSummary } from '@app/types';
import { Activity, BookAudio, LibraryBig, type LucideIcon, Menu, Plus, Scale } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { healthTone, useAppState } from '@/components/app-state';
import { BookCover } from '@/components/book-cover';
import { PowerMini } from '@/components/power-control';
import { StatusDot, statusLabel } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { isActive } from '@/lib/stages';
import { cn } from '@/lib/utils';

/** Typing targets where single-key shortcuts must not fire. */
export function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('[role="dialog"],[role="menu"],[role="listbox"]'));
}

function Logo() {
  return (
    <Link href="/" className="group flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="Read-Along Studio — library">
      <span className="grid size-8 place-items-center rounded-[10px] bg-brand text-brand-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.45),0_1px_2px_rgb(110_70_0/0.3)] transition-transform group-hover:-rotate-3">
        <BookAudio className="size-[18px]" aria-hidden />
      </span>
      <span className="grid leading-none">
        <span className="font-serif text-[17px] font-semibold tracking-tight">Read-Along</span>
        <span className="mt-0.5 text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">Studio · Local</span>
      </span>
    </Link>
  );
}

function NavItem({ href, icon: Icon, active, children, trailing }: { href: string; icon: LucideIcon; active: boolean; children: ReactNode; trailing?: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.07]',
      )}
    >
      <Icon className={cn('size-4', active && 'text-foreground')} aria-hidden />
      <span className="flex-1">{children}</span>
      {trailing}
    </Link>
  );
}

function RecentItem({ p, active }: { p: ProjectSummary; active: boolean }) {
  const working = isActive(p.status);
  return (
    <li>
      <Link
        href={`/projects/${p.id}`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group flex items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors hover:bg-foreground/[0.05] focus-visible:ring-[3px] focus-visible:ring-ring/50',
          active && 'bg-foreground/[0.07] hover:bg-foreground/[0.07]',
        )}
      >
        <BookCover projectId={p.id} title={p.name} size="xs" className="w-6 shadow-none" />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className={cn('truncate text-[13px]', active ? 'font-medium text-foreground' : 'text-foreground/85')}>{p.name}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <StatusDot status={p.status} className="size-1.5 [&>span]:size-1.5" />
            <span className="truncate tabular">{working ? `${statusLabel(p.status)} · ${Math.round(p.progress)}%` : statusLabel(p.status)}</span>
          </span>
        </span>
      </Link>
    </li>
  );
}

function SidebarContent() {
  const pathname = usePathname();
  const { projects, health } = useAppState();
  const recent = useMemo(() => [...(projects.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 7), [projects.data]);
  const tone = healthTone(health.data);
  const failing = health.data?.checks.filter((c) => !c.ok).length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Logo />
      </div>
      <div className="px-3">
        <Button asChild variant="brand" className="w-full justify-start">
          <Link href="/new">
            <Plus aria-hidden /> New audiobook
            <Kbd className="ml-auto border-brand-foreground/20 opacity-60">N</Kbd>
          </Link>
        </Button>
      </div>

      <nav className="mt-5 grid gap-0.5 px-3" aria-label="Main">
        <NavItem
          href="/"
          icon={LibraryBig}
          active={pathname === '/'}
          trailing={projects.data?.length ? <span className="text-xs font-normal text-muted-foreground tabular">{projects.data.length}</span> : undefined}
        >
          Library
        </NavItem>
        <NavItem
          href="/system"
          icon={Activity}
          active={pathname.startsWith('/system')}
          trailing={
            tone === 'unknown' ? undefined : (
              <span
                className={cn('size-2 rounded-full', tone === 'ok' && 'bg-success', tone === 'warning' && 'bg-warning', tone === 'error' && 'bg-destructive')}
                role="img"
                aria-label={tone === 'ok' ? 'All services ready' : `${failing} service${failing === 1 ? '' : 's'} need attention`}
                title={tone === 'ok' ? 'All services ready' : `${failing} service${failing === 1 ? '' : 's'} need attention`}
              />
            )
          }
        >
          System
        </NavItem>
      </nav>

      {recent.length > 0 && (
        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          <p className="px-5 pb-1.5 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">Recent</p>
          <ul className="grid min-h-0 content-start gap-0.5 overflow-y-auto px-3 pb-2 scrollbar-thin">
            {recent.map((p) => (
              <RecentItem key={p.id} p={p} active={pathname === `/projects/${p.id}`} />
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto grid gap-3 p-3">
        <PowerMini />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [pathname]);

  // "N" anywhere (outside text fields) starts a new audiobook.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return;
      if (pathname === '/new') return;
      e.preventDefault();
      router.push('/new');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pathname, router]);

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-[60] rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r bg-sidebar lg:block">
        <SidebarContent />
      </aside>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="bg-sidebar">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Library, system status and recent audiobooks</SheetDescription>
          <SidebarContent />
        </SheetContent>
      </Sheet>

      <div className="flex min-h-dvh flex-col lg:pl-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:px-4 lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMenuOpen(true)} aria-label="Open navigation">
            <Menu aria-hidden />
          </Button>
          <Logo />
          {pathname !== '/new' && (
            <Button asChild size="sm" variant="brand" className="ml-auto">
              <Link href="/new">
                <Plus aria-hidden /> New
              </Link>
            </Button>
          )}
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8 lg:px-10 lg:py-10">
          {children}
        </main>

        {/* Spec §28: remind users to only process books they have the right to use. */}
        <footer className="mx-auto w-full max-w-[1200px] px-4 pb-6 sm:px-6 lg:px-10">
          <div className="flex flex-col gap-2 border-t pt-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2">
              <Scale className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>Only process and distribute books you have the legal right to use. This tool does not remove DRM or copy protection.</span>
            </p>
            <p className="shrink-0">Runs entirely on this Mac — no cloud AI.</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
