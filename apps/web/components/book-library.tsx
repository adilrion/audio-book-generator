'use client';

import type { LibraryBook, LibraryBookDetail, LibraryFile, LibraryLanguage, LibrarySearchResult } from '@app/types';
import { ArrowUpRight, Download, FileText, LoaderCircle, Search, TriangleAlert } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiErrorAlert } from '@/components/api-error-alert';
import { BookCover } from '@/components/book-cover';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { type ApiError, api, toApiError } from '@/lib/api';
import { bookMeta, fileMeta, rightsBadge } from '@/lib/library';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

type Results = { key: string; total: number; books: LibraryBook[]; page: number; pageSize: number };

/** Starting points, all out of copyright. */
const SUGGESTIONS: Record<LibraryLanguage, string[]> = {
  any: ['Jane Austen', 'Sherlock Holmes', 'Charles Dickens', 'Tagore', 'Fairy tales', 'রবীন্দ্রনাথ'],
  en: ['Jane Austen', 'Sherlock Holmes', 'Charles Dickens', 'Mark Twain', 'Jules Verne', 'Fairy tales'],
  bn: ['রবীন্দ্রনাথ', 'শরৎচন্দ্র', 'বঙ্কিমচন্দ্র', 'সুকুমার রায়', 'বিভূতিভূষণ', 'উপেন্দ্রকিশোর'],
};

function BookCard({ book, busy, disabled, problem, onPick }: { book: LibraryBook; busy: boolean; disabled: boolean; problem?: string; onPick: () => void }) {
  const rights = rightsBadge(book);
  return (
    <li className="flex gap-3 rounded-xl border bg-card p-3 shadow-xs">
      <BookCover src={book.coverUrl} title={book.title} className="w-14 self-start" />
      <div className="grid min-w-0 flex-1 content-start gap-1">
        <p className="line-clamp-2 font-serif text-[15px] leading-snug font-medium" title={book.title} lang={book.language === 'bn' ? 'bn' : undefined}>
          {book.title}
        </p>
        <p className="line-clamp-1 text-xs text-muted-foreground tabular">{bookMeta(book) || '—'}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <Badge variant={rights.variant} title={rights.help} className="px-1.5 py-0 text-[11px]">
            {rights.label}
          </Badge>
        </div>
        {problem && (
          <p className="flex items-center gap-1 text-xs text-destructive" role="alert">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden /> {problem}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="xs" variant="secondary" onClick={onPick} disabled={disabled || busy} aria-label={`Make an audiobook from “${book.title}”`}>
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            Use this book
          </Button>
          <a
            href={book.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 rounded text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            archive.org <ArrowUpRight className="size-3" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      </div>
    </li>
  );
}

function CardSkeleton() {
  return (
    <li className="flex gap-3 rounded-xl border bg-card p-3" aria-hidden>
      <Skeleton className="aspect-[5/7] w-14 rounded-[3px]" />
      <div className="grid flex-1 content-start gap-2 pt-0.5">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-1 h-7 w-28" />
      </div>
    </li>
  );
}

/**
 * Search the Internet Archive for a book and pick one of its PDFs. Free-to-use books (as their
 * pages label them) are shown by default; the empty search lists the most downloaded ones.
 */
export interface LibrarySearchState {
  q: string;
  language: LibraryLanguage;
  free: boolean;
}

export function BookLibrary({
  onPick,
  disabled,
  initial,
  onSearchChange,
  wide = false,
}: {
  onPick: (book: LibraryBookDetail, file: LibraryFile) => void;
  disabled?: boolean;
  initial?: Partial<LibrarySearchState>;
  /** Called when the search changes (e.g. to keep it in the address bar). */
  onSearchChange?: (s: LibrarySearchState) => void;
  /** More columns, for the full-page library. */
  wide?: boolean;
}) {
  const ids = { q: useId(), free: useId() };
  const [text, setText] = useState(initial?.q ?? '');
  const [query, setQuery] = useState((initial?.q ?? '').trim());
  const [language, setLanguage] = useState<LibraryLanguage>(initial?.language ?? 'any');
  const [free, setFree] = useState(initial?.free ?? true);
  const [results, setResults] = useState<Results>();
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [picking, setPicking] = useState<string>();
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<LibraryBookDetail>();
  const [attempt, setAttempt] = useState(0);
  const ctrl = useRef<AbortController | null>(null);
  const key = JSON.stringify([query, language, free]);

  // Typing searches after a short pause; Enter searches at once.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), 500);
    return () => window.clearTimeout(t);
  }, [text]);

  const changed = useRef(onSearchChange);
  changed.current = onSearchChange;
  useEffect(() => changed.current?.({ q: query, language, free }), [query, language, free]);

  useEffect(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError(undefined);
    api
      .librarySearch({ q: query, language, free, page: 1 }, c.signal)
      .then((r: LibrarySearchResult) => !c.signal.aborted && setResults({ key, ...r }))
      .catch((e) => !c.signal.aborted && setError(toApiError(e)))
      .finally(() => !c.signal.aborted && setLoading(false));
    return () => c.abort();
  }, [key, query, language, free, attempt]);

  const showMore = async () => {
    if (!results) return;
    setMore(true);
    try {
      const r = await api.librarySearch({ q: query, language, free, page: results.page + 1 });
      setResults((cur) => (cur && cur.key === key ? { ...cur, page: r.page, books: [...cur.books, ...r.books.filter((b) => !cur.books.some((c) => c.id === b.id))] } : cur));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setMore(false);
    }
  };

  const pick = async (book: LibraryBook) => {
    setPicking(book.id);
    setProblems(({ [book.id]: _, ...rest }) => rest);
    try {
      const detail = await api.libraryBook(book.id);
      if (detail.files.length === 0) setProblems((p) => ({ ...p, [book.id]: 'No downloadable PDF — it may be a borrow-only book.' }));
      else if (detail.files.length === 1) onPick(detail, detail.files[0]);
      else setChoice(detail);
    } catch (e) {
      setProblems((p) => ({ ...p, [book.id]: toApiError(e).message }));
    } finally {
      setPicking(undefined);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQuery(text.trim());
  };

  const grid = cn('grid gap-2.5 sm:grid-cols-2', wide && 'lg:grid-cols-3 2xl:grid-cols-4');
  const books = results?.key === key ? results.books : [];
  const total = results?.key === key ? results.total : 0;
  const canShowMore = !loading && results?.key === key && books.length < total && books.length < 100 * results.pageSize;

  return (
    <div className="grid gap-4">
      <form onSubmit={submit} role="search" className="grid gap-3">
        <Label htmlFor={ids.q} className="sr-only">
          Search books
        </Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id={ids.q}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Title or author — e.g. Pride and Prejudice, Tagore, রবীন্দ্রনাথ"
            className="h-10 pl-9"
            maxLength={200}
            autoComplete="off"
            disabled={disabled}
          />
        </div>
        {!text && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Suggestions">
            <span className="mr-0.5 text-xs text-muted-foreground">Try</span>
            {SUGGESTIONS[language].map((s) => (
              <button
                key={s}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setText(s);
                  setQuery(s);
                }}
                className="rounded-full border bg-card px-2.5 py-0.5 text-xs text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
          <Segmented value={language} onValueChange={(v) => setLanguage(v as LibraryLanguage)} aria-label="Book language" disabled={disabled} className="sm:w-auto">
            <SegmentedItem value="any">Any language</SegmentedItem>
            <SegmentedItem value="en">English</SegmentedItem>
            <SegmentedItem value="bn">
              <span lang="bn">বাংলা</span>
            </SegmentedItem>
          </Segmented>
          <div className="flex items-center gap-2">
            <Switch id={ids.free} checked={free} onCheckedChange={setFree} disabled={disabled} />
            <Label htmlFor={ids.free} className="text-sm font-normal" title="Public domain, CC0 or CC BY / BY-SA, as labelled on the book’s page">
              Free to use only
            </Label>
          </div>
        </div>
      </form>

      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground" aria-live="polite">
        <span>
          {loading
            ? 'Searching the Internet Archive…'
            : error && !books.length
              ? ''
              : query
                ? `${formatNumber(total)} book${total === 1 ? '' : 's'} for “${query}”`
                : `Popular${free ? ' free' : ''} classics${language === 'bn' ? ' in Bangla' : language === 'en' ? ' in English' : ''}`}
        </span>
      </div>

      {error && <ApiErrorAlert error={error} title="The online library is not available" onRetry={() => setAttempt((a) => a + 1)} />}

      {loading ? (
        <ul className={grid}>
          {Array.from({ length: wide ? 8 : 4 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </ul>
      ) : books.length > 0 ? (
        <ul className={grid}>
          {books.map((b) => (
            <BookCard key={b.id} book={b} busy={picking === b.id} disabled={!!disabled || (!!picking && picking !== b.id)} problem={problems[b.id]} onPick={() => void pick(b)} />
          ))}
        </ul>
      ) : (
        !error && (
          <p className="rounded-xl bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">
            No books found. Try fewer words or the author’s name{free ? ', or switch off “Free to use only”' : ''}.
          </p>
        )
      )}

      {canShowMore && (
        <Button variant="outline" size="sm" onClick={() => void showMore()} disabled={more} className="justify-self-center">
          {more && <LoaderCircle className="animate-spin" aria-hidden />}
          Show more books
        </Button>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Books come from the{' '}
        <a href="https://archive.org" target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
          Internet Archive
        </a>{' '}
        and are downloaded to this Mac. Rights labels are set by each book’s uploader — make sure you may turn a book into an audiobook before you publish it.
      </p>

      <Dialog open={!!choice} onOpenChange={(open) => !open && setChoice(undefined)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a PDF</DialogTitle>
            <DialogDescription>
              “{choice?.title}” has {choice?.files.length} PDFs — usually volumes or different scans. PDFs “with text” are faster to read.
            </DialogDescription>
          </DialogHeader>
          <ul className="-mx-1 grid max-h-[55vh] gap-1 overflow-y-auto px-1 py-0.5">
            {choice?.files.map((f) => (
              <li key={f.name}>
                <button
                  type="button"
                  onClick={() => {
                    if (!choice) return;
                    setChoice(undefined);
                    onPick(choice, f);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm font-medium">{f.name}</span>
                    <span className="text-xs text-muted-foreground tabular">{fileMeta(f)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
