'use client';

import type { LibraryBookDetail, LibraryFile } from '@app/types';
import { Link2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { BookLibrary, type LibrarySearchState } from '@/components/book-library';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { libraryNewUrl, librarySearchQuery, parseLibrarySearch } from '@/lib/library';

/**
 * /discover — the online library on its own page. The search lives in the address bar, so Back
 * from the New audiobook page returns to the same results. Picking a book opens New audiobook with
 * the book already downloading.
 */
export function OnlineLibrary({ initial }: { initial: Partial<LibrarySearchState> }) {
  const router = useRouter();
  // Back from New audiobook restores this page from Next's router cache, rendered with the address
  // of the first visit; the search kept in the address bar since then is in window.location.
  const [start] = useState(() => (typeof window === 'undefined' ? initial : parseLibrarySearch(Object.fromEntries(new URLSearchParams(window.location.search)))));

  const onSearchChange = useCallback((s: LibrarySearchState) => {
    const url = new URL(window.location.href);
    url.search = librarySearchQuery(s);
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const onPick = (book: LibraryBookDetail, file: LibraryFile) => router.push(libraryNewUrl(book.id, file.name));

  return (
    <div className="grid gap-8">
      <PageHeader
        title="Online library"
        description="Find a free book on the Internet Archive and make it an audiobook. English classics, Tagore, Bankim, Sarat Chandra and millions more — downloaded straight to this Mac."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/new?source=link">
                <Link2 aria-hidden /> Paste a link
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/new">
                <Upload aria-hidden /> Upload a PDF
              </Link>
            </Button>
          </>
        }
      />
      <BookLibrary onPick={onPick} initial={start} onSearchChange={onSearchChange} wide />
    </div>
  );
}
