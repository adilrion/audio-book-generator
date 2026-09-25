'use client';

import { FileUp } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export function isPdfFile(f: File) {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

/** Drag & drop (or click / keyboard to browse) for a single PDF. */
export function UploadDropzone({ onFile, maxMb, disabled, className }: { onFile: (f: File) => void; maxMb?: number; disabled?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const pick = (files: FileList | null | undefined) => {
    const f = files?.[0];
    if (f) onFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (!disabled) pick(e.dataTransfer.files);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.current?.click();
    }
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label="Upload a PDF: drag and drop a file here, or press Enter to browse"
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={onKey}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        if (!disabled) setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
      className={cn(
        'group flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
        dragging ? 'border-brand bg-brand/10' : 'border-input hover:border-foreground/30 hover:bg-muted/40',
        disabled && 'pointer-events-none opacity-60',
        className,
      )}
    >
      <span className={cn('grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground transition-colors', dragging && 'bg-brand text-brand-foreground')}>
        <FileUp className="size-6" aria-hidden />
      </span>
      <div className="grid gap-1">
        <p className="font-medium">{dragging ? 'Drop the PDF to upload' : 'Drag & drop a PDF book here'}</p>
        <p className="text-sm text-muted-foreground">
          or <span className="font-medium text-foreground underline underline-offset-4">click to browse</span>
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {maxMb ? `Up to ${maxMb >= 1024 ? `${(maxMb / 1024).toFixed(1)} GB` : `${maxMb} MB`}` : 'PDF only'} · text-based PDFs work best; scanned pages use OCR
      </p>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        // input.click() bubbles to the wrapper's onClick — don't re-open the picker.
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
