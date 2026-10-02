import { describe, expect, it } from 'vitest';
import { ArchiveClient, archiveDownloadUrl, archiveIdFromUrl, buildQuery, languageCode, pdfFiles, rightsOf, toBook } from '../src/library/archive';

const BASE = 'mediatype:texts AND format:"Text PDF" AND NOT access-restricted-item:true';

describe('archive.org search query', () => {
  it('searches title, author and subject for all words', () => {
    expect(buildQuery({ q: 'pride and prejudice', language: 'any', freeOnly: false })).toBe(
      `(title:(pride AND and AND prejudice) OR creator:(pride AND and AND prejudice) OR subject:(pride AND and AND prejudice)) AND ${BASE}`,
    );
  });

  it('strips query syntax so user text cannot change the query', () => {
    const q = buildQuery({ q: 'a:b OR (c) "d" NOT* e\\f -g', language: 'any', freeOnly: false });
    expect(q.startsWith('(title:(a AND b AND or AND c AND d AND not AND e AND f AND g) OR')).toBe(true);
  });

  it('shows a shelf of classics without words, filtered by language and rights', () => {
    const bn = buildQuery({ q: '  ', language: 'bn', freeOnly: true });
    expect(bn.startsWith('creator:(Tagore OR রবীন্দ্রনাথ OR Bankim')).toBe(true);
    expect(bn).toContain(BASE);
    expect(bn).toContain('language:(ben OR Bengali OR Bangla OR bn)');
    expect(bn).toContain('possible-copyright-status:NOT_IN_COPYRIGHT OR licenseurl');
    expect(buildQuery({ q: '', language: 'any', freeOnly: false })).toBe(`(possible-copyright-status:NOT_IN_COPYRIGHT AND subject:(fiction OR poetry OR novels)) AND ${BASE}`);
  });

  it('keeps Bangla words intact', () => {
    expect(buildQuery({ q: 'রবীন্দ্রনাথ', language: 'any', freeOnly: false })).toContain('title:(রবীন্দ্রনাথ)');
  });
});

describe('archive.org metadata', () => {
  it('reads the rights label', () => {
    expect(rightsOf(undefined, 'NOT_IN_COPYRIGHT')).toEqual({ rights: 'public_domain', license: 'Not in copyright' });
    expect(rightsOf('http://creativecommons.org/publicdomain/mark/1.0/', undefined)).toEqual({ rights: 'public_domain', license: 'Public domain mark' });
    expect(rightsOf('https://creativecommons.org/publicdomain/zero/1.0/', undefined)).toEqual({ rights: 'public_domain', license: 'CC0' });
    expect(rightsOf('https://creativecommons.org/licenses/by-sa/4.0/', undefined)).toEqual({ rights: 'open', license: 'CC BY-SA 4.0' });
    expect(rightsOf('http://creativecommons.org/licenses/by-nc-nd/3.0/', undefined)).toEqual({ rights: 'restricted', license: 'CC BY-NC-ND 3.0' });
    expect(rightsOf(undefined, undefined)).toEqual({ rights: 'unknown' });
  });

  it('maps language codes', () => {
    expect(languageCode('eng')).toBe('en');
    expect(languageCode(['Bengali', 'eng'])).toBe('bn');
    expect(languageCode('hin')).toBe('hin');
    expect(languageCode(undefined)).toBeUndefined();
  });

  it('turns a search document into a book', () => {
    expect(
      toBook({
        identifier: 'gitanjalisongoff00tagouoft',
        title: 'Gitanjali (song offerings)',
        creator: ['Tagore, Rabindranath, 1861-1941', 'Yeats, W. B.'],
        year: '[1913]',
        language: 'eng',
        imagecount: 144,
        downloads: 72872,
        'possible-copyright-status': 'NOT_IN_COPYRIGHT',
      }),
    ).toEqual({
      source: 'archive',
      id: 'gitanjalisongoff00tagouoft',
      title: 'Gitanjali (song offerings)',
      author: 'Tagore, Rabindranath, 1861-1941',
      year: 1913,
      language: 'en',
      pages: 144,
      downloads: 72872,
      coverUrl: 'https://archive.org/services/img/gitanjalisongoff00tagouoft',
      pageUrl: 'https://archive.org/details/gitanjalisongoff00tagouoft',
      rights: 'public_domain',
      license: 'Not in copyright',
    });
    expect(toBook({ identifier: 'x', date: '1847-01-01T00:00:00Z' })?.year).toBe(1847);
    expect(toBook({ identifier: '../etc' })).toBeUndefined();
  });

  it('lists downloadable PDFs, text PDFs first, volumes in natural order', () => {
    const files = pdfFiles([
      { name: 'book_jp2.zip', format: 'Single Page Processed JP2 ZIP', size: '1' },
      { name: 'vol10.pdf', format: 'Text PDF', size: '300' },
      { name: 'scan.pdf', format: 'Image Container PDF', size: '900' },
      { name: 'vol2.pdf', format: 'Text PDF', size: '200' },
      { name: 'secret.pdf', format: 'Text PDF', size: '5', private: 'true' },
    ]);
    expect(files.map((f) => f.name)).toEqual(['vol2.pdf', 'vol10.pdf', 'scan.pdf']);
    expect(files[0]).toEqual({ name: 'vol2.pdf', size: 200, format: 'Text PDF' });
  });

  it('leaves out other copies of the same scan', () => {
    const files = pdfFiles([
      { name: '10652-.pdf', format: 'Image Container PDF', size: '2400' },
      { name: '10652-_text.pdf', format: 'Additional Text PDF', size: '3000' },
      { name: 'pride.pdf', format: 'Text PDF', size: '29' },
      { name: 'pride_bw.pdf', format: 'Grayscale PDF', size: '24' },
      { name: 'other_bw.pdf', format: 'Grayscale PDF', size: '5' },
    ]);
    expect(files.map((f) => f.name)).toEqual(['pride.pdf', '10652-_text.pdf', 'other_bw.pdf']);
  });

  it('builds download links and recognises book pages', () => {
    expect(archiveDownloadUrl('abc', 'dir/My Book.pdf')).toBe('https://archive.org/download/abc/dir/My%20Book.pdf');
    expect(archiveIdFromUrl(new URL('https://archive.org/details/gitanjali00unse/page/n5/mode/2up'))).toBe('gitanjali00unse');
    expect(archiveIdFromUrl(new URL('https://www.archive.org/details/abc'))).toBe('abc');
    expect(archiveIdFromUrl(new URL('https://archive.org/download/abc/abc.pdf'))).toBeUndefined();
    expect(archiveIdFromUrl(new URL('https://example.com/details/abc'))).toBeUndefined();
  });
});

describe('ArchiveClient', () => {
  const fake = (body: unknown, ok = true) => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return { ok, status: ok ? 200 : 503, json: async () => body };
    };
    return { urls, client: new ArchiveClient(fetchImpl) };
  };

  it('searches and caches the answer', async () => {
    const { urls, client } = fake({ response: { numFound: 158, docs: [{ identifier: 'prideprejudice00aust', title: 'Pride and prejudice', language: 'eng' }, { title: 'no id' }] } });
    const r = await client.search({ q: 'pride', language: 'en', freeOnly: true, page: 2 });
    expect(r).toMatchObject({ total: 158, page: 2, pageSize: 24, books: [{ id: 'prideprejudice00aust', language: 'en' }] });
    expect(r.books).toHaveLength(1);
    const url = new URL(urls[0]);
    expect(url.pathname).toBe('/advancedsearch.php');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.getAll('sort[]')).toEqual(['downloads desc']);
    await client.search({ q: 'pride', language: 'en', freeOnly: true, page: 2 });
    expect(urls).toHaveLength(1);
  });

  it('reports archive.org trouble as LIBRARY_UNAVAILABLE', async () => {
    await expect(fake({}, false).client.search({ q: 'x', language: 'any', freeOnly: false, page: 1 })).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE', retryable: true });
    const failing = new ArchiveClient(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(failing.item('abc')).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
  });

  it('reports a request the browser cancelled as ABORTED, not as an archive.org problem', async () => {
    const ctrl = new AbortController();
    const client = new ArchiveClient(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          ctrl.abort();
        }),
    );
    await expect(client.search({ q: 'x', language: 'any', freeOnly: false, page: 1 }, ctrl.signal)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('loads an item with its PDFs; unknown, dark and borrow-only items have none', async () => {
    const item = await fake({ metadata: { title: 'Emma', creator: 'Austen' }, files: [{ name: 'emma.pdf', format: 'Text PDF', size: '1000' }] }).client.item('emma00aust');
    expect(item).toMatchObject({ id: 'emma00aust', title: 'Emma', files: [{ name: 'emma.pdf', size: 1000 }] });
    await expect(fake({}).client.item('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fake({ metadata: { title: 'x' }, is_dark: true }).client.item('dark')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fake({}).client.item('../../x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const lending = await fake({ metadata: { title: 'x', 'access-restricted-item': 'true' }, files: [{ name: 'x.pdf', format: 'Text PDF', size: '1' }] }).client.item('lent');
    expect(lending.files).toEqual([]);
  });
});
