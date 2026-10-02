'use client';

import { Link2, TriangleAlert } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { linkProblem } from '@/lib/library';

/** Paste a link to a PDF found anywhere on the internet; the API downloads it. */
export function LinkImport({ onLink, disabled }: { onLink: (url: string) => void; disabled?: boolean }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = linkProblem(value);
    setProblem(p);
    if (!p) onLink(value.trim());
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-3 rounded-2xl border-2 border-dashed border-foreground/15 bg-muted/30 px-5 py-8 sm:px-8">
      <Label htmlFor={id} className="text-[15px] font-medium">
        Link to a PDF book
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id={id}
            type="url"
            inputMode="url"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setProblem(undefined);
            }}
            placeholder="https://example.org/books/my-book.pdf"
            className="h-10 bg-card pl-9"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!problem}
            aria-describedby={`${id}-help`}
            disabled={disabled}
          />
        </div>
        <Button type="submit" variant="brand" className="h-10" disabled={disabled}>
          Download PDF
        </Button>
      </div>
      {problem && (
        <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <TriangleAlert className="size-4 shrink-0" aria-hidden /> {problem}
        </p>
      )}
      <p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">
        Use the link of the PDF itself (right-click the download button → Copy Link Address). Google Drive and Dropbox share links and archive.org book pages work
        too. Only use books you have the right to turn into an audiobook.
      </p>
    </form>
  );
}
