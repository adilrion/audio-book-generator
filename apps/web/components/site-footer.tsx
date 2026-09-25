import { Scale } from 'lucide-react';

/** Spec §28: remind users to only process books they have the right to use. */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="flex items-start gap-2">
          <Scale className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Only process and distribute books you have the legal right to use. This tool does not remove DRM or copy protection.
          </span>
        </p>
        <p className="shrink-0">Runs entirely on this Mac — no cloud AI.</p>
      </div>
    </footer>
  );
}
