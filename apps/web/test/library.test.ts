import type { LibraryBook } from '@app/types';
import { describe, expect, it } from 'vitest';
import { bookMeta, displayAuthor, fileMeta, libraryNewUrl, librarySearchQuery, linkLabel, linkProblem, parseLibrarySearch, parseNewParams, rightsBadge } from '@/lib/library';

const book = (extra: Partial<LibraryBook> = {}): LibraryBook => ({
  source: 'archive',
  id: 'x',
  title: 'Pride and prejudice',
  coverUrl: '',
  pageUrl: '',
  rights: 'unknown',
  ...extra,
});

describe('library display', () => {
  it('writes catalogue author names the way readers do', () => {
    expect(displayAuthor('Austen, Jane, 1775-1817')).toBe('Jane Austen');
    expect(displayAuthor('Tagore, Rabindranath, 1861-1941')).toBe('Rabindranath Tagore');
    expect(displayAuthor('Yeats, W. B. (William Butler), 1865-1939')).toBe('W. B. Yeats');
    expect(displayAuthor('Dickens, Charles, 1812-')).toBe('Charles Dickens');
    expect(displayAuthor('রবীন্দ্রনাথ ঠাকুর')).toBe('রবীন্দ্রনাথ ঠাকুর');
    expect(displayAuthor('Rabindranath Tagore, রবীন্দ্রনাথ ঠাকুর')).toBe('Rabindranath Tagore, রবীন্দ্রনাথ ঠাকুর');
    expect(displayAuthor('Marcus Aurelius, Emperor of Rome, 121-180')).toBe('Marcus Aurelius, Emperor of Rome');
    expect(displayAuthor('Crane, Thomas, b. 1843?')).toBe('Thomas Crane');
    expect(displayAuthor('Baum, L. Frank (Lyman Frank), 1856-1919')).toBe('L. Frank Baum');
    expect(displayAuthor('De Quincey, Thomas, 1785-1859')).toBe('Thomas De Quincey');
    expect(displayAuthor('Standard Ebooks, Jane Austen, Something')).toBe('Standard Ebooks, Jane Austen, Something');
    expect(displayAuthor(undefined)).toBeUndefined();
  });

  it('shows the licence name for licensed books and one label for public domain', () => {
    expect(rightsBadge(book({ rights: 'public_domain', license: 'CC0' }))).toMatchObject({ label: 'Public domain', variant: 'success', help: expect.stringContaining('CC0') });
    expect(rightsBadge(book({ rights: 'open', license: 'CC BY-SA 4.0' }))).toMatchObject({ label: 'CC BY-SA 4.0', variant: 'info' });
    expect(rightsBadge(book({ rights: 'restricted', license: 'CC BY-NC-ND 3.0' }))).toMatchObject({ label: 'CC BY-NC-ND 3.0', variant: 'warning', help: expect.stringContaining('NoDerivatives') });
    expect(rightsBadge(book())).toMatchObject({ label: 'Rights unknown', variant: 'muted' });
  });

  it('summarises a book and a file', () => {
    expect(bookMeta(book({ author: 'Austen, Jane, 1775-1817', year: 1894, pages: 518, language: 'en' }))).toBe('Jane Austen · 1894 · 518 pages · English');
    expect(bookMeta(book({ language: 'bn' }))).toBe('Bangla');
    expect(fileMeta({ name: 'a.pdf', size: 29_610_052, format: 'Text PDF' })).toBe('28 MB · with text');
    expect(fileMeta({ name: 'a.pdf', size: 0, format: 'Image Container PDF' })).toBe('Image Container PDF');
  });

  it('checks pasted links before sending them', () => {
    expect(linkProblem('  ')).toMatch(/Paste/);
    expect(linkProblem('example.com/book.pdf')).toMatch(/https:\/\//);
    expect(linkProblem('file:///Users/me/book.pdf')).toMatch(/http/);
    expect(linkProblem('https://example.com/book.pdf')).toBeUndefined();
  });

  it('names a downloading link after its PDF, else its website', () => {
    expect(linkLabel('https://example.com/books/Pride%20and%20Prejudice.pdf?x=1')).toBe('Pride and Prejudice.pdf');
    expect(linkLabel('https://www.dropbox.com/s/abc/view?dl=0')).toBe('dropbox.com');
    expect(linkLabel('https://drive.google.com/file/d/1AbC/view')).toBe('drive.google.com');
  });

  it('keeps the library search in the address bar', () => {
    expect(librarySearchQuery({ q: '', language: 'any', free: true })).toBe('');
    expect(librarySearchQuery({ q: 'রবীন্দ্রনাথ', language: 'bn', free: false })).toBe('?q=%E0%A6%B0%E0%A6%AC%E0%A7%80%E0%A6%A8%E0%A7%8D%E0%A6%A6%E0%A7%8D%E0%A6%B0%E0%A6%A8%E0%A6%BE%E0%A6%A5&lang=bn&free=0');
    expect(parseLibrarySearch({ q: 'tagore', lang: 'bn', free: '0' })).toEqual({ q: 'tagore', language: 'bn', free: false });
    expect(parseLibrarySearch({ lang: 'fr', q: ['a', 'b'] })).toEqual({ q: 'a', language: undefined, free: undefined });
  });

  it('opens New audiobook with a library book or a tab', () => {
    const url = libraryNewUrl('RABINDRARACHANABALI', 'RABINDRA RACHANABALI - 1ST VOL_text.pdf');
    expect(url).toBe('/new?archive=RABINDRARACHANABALI&file=RABINDRA+RACHANABALI+-+1ST+VOL_text.pdf');
    const sp = Object.fromEntries(new URLSearchParams(url.split('?')[1]));
    expect(parseNewParams(sp)).toEqual({ book: { id: 'RABINDRARACHANABALI', file: 'RABINDRA RACHANABALI - 1ST VOL_text.pdf' }, tab: 'library' });
    expect(parseNewParams({ archive: '../x' })).toEqual({ book: undefined, tab: undefined });
    expect(parseNewParams({ source: 'link' })).toEqual({ book: undefined, tab: 'link' });
    expect(parseNewParams({ source: 'nope' })).toEqual({ book: undefined, tab: undefined });
  });
});
