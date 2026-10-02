import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directLink, downloadPdf, fileNameFrom, isPublicAddress, parseLink, safeLookup } from '../src/library/download';

const PDF = Buffer.from('%PDF-1.7\n% a tiny test book\n%%EOF\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-download-'));
let n = 0;
const dest = () => path.join(dir, `${n++}.pdf`);

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/book.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length });
      return res.end(PDF);
    }
    if (url === '/named') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''%E0%A6%AC%E0%A6%87.pdf" });
      return res.end(PDF);
    }
    if (url === '/redirect') {
      res.writeHead(302, { Location: '/book.pdf' });
      return res.end();
    }
    if (url === '/loop') {
      res.writeHead(301, { Location: '/loop' });
      return res.end();
    }
    if (url === '/to-private') {
      res.writeHead(302, { Location: 'http://10.0.0.1/secret.pdf' });
      return res.end();
    }
    if (url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Download</title>');
    }
    if (url === '/text') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end('hello, I am not a PDF at all');
    }
    if (url === '/chunked-big') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); // no Content-Length
      res.write(PDF);
      res.write(Buffer.alloc(4096, 32));
      return res.end();
    }
    if (url === '/hang') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.write(PDF); // …and never ends
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const local = { maxBytes: 1024 * 1024, allowAddresses: ['127.0.0.1'] };

describe('link checks', () => {
  it('only treats public internet addresses as public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1'])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '207.241.224.2', '2606:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('refuses links to this computer or the local network, in any spelling', () => {
    for (const link of ['http://127.0.0.1:4000/projects', 'http://localhost/x.pdf', 'http://api.localhost/x', 'http://printer.local/x', 'http://2130706433/x', 'http://0x7f.1/x', 'http://[::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://169.254.169.254/latest/meta-data'])
      expect(() => parseLink(link), link).toThrow(/local network/);
  });

  it('refuses other schemes, credentials and garbage', () => {
    expect(() => parseLink('file:///etc/passwd')).toThrow(/http/);
    expect(() => parseLink('ftp://example.com/a.pdf')).toThrow(/http/);
    expect(() => parseLink('https://user:pw@example.com/a.pdf')).toThrow(/password/);
    expect(() => parseLink('not a link')).toThrow(/valid link/);
    expect(parseLink('  https://example.com/a.pdf ').toString()).toBe('https://example.com/a.pdf');
  });

  it('resolves host names and rejects ones that point at a private address', async () => {
    const lookup = (host: string, all: boolean) =>
      new Promise<unknown>((resolve, reject) => safeLookup()(host, { all }, (err, address) => (err ? reject(err) : resolve(address))));
    await expect(lookup('localhost', false)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('local network') });
    await expect(lookup('localhost', true)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(() => parseLink('http://127.0.0.1:9/x.pdf', ['127.0.0.1'])).not.toThrow(); // the tests' own server
  });

  it('turns Google Drive and Dropbox share links into download links', () => {
    expect(directLink(new URL('https://drive.google.com/file/d/1AbC-d_9/view?usp=sharing')).toString()).toBe('https://drive.google.com/uc?export=download&id=1AbC-d_9');
    expect(directLink(new URL('https://www.dropbox.com/s/abc/Book.pdf?dl=0')).toString()).toBe('https://www.dropbox.com/s/abc/Book.pdf?dl=1');
    expect(directLink(new URL('https://example.com/a.pdf')).toString()).toBe('https://example.com/a.pdf');
  });

  it('names the file from Content-Disposition, else the link, always as a safe .pdf', () => {
    const u = new URL('https://example.com/books/Pride%20and%20Prejudice.pdf?x=1');
    expect(fileNameFrom(undefined, u)).toBe('Pride and Prejudice.pdf');
    expect(fileNameFrom('attachment; filename="Emma.pdf"', u)).toBe('Emma.pdf');
    expect(fileNameFrom("attachment; filename=x.pdf; filename*=UTF-8''%E0%A6%AC%E0%A6%87.pdf", u)).toBe('বই.pdf');
    expect(fileNameFrom('attachment; filename="../../etc/passwd"', u)).toBe('.. .. etc passwd.pdf');
    expect(fileNameFrom(undefined, new URL('https://example.com/download?id=5'))).toBe('download.pdf');
    expect(fileNameFrom(undefined, new URL('https://example.com/'))).toBe('example.com.pdf');
  });
});

describe('downloadPdf', () => {
  it('downloads a PDF and reports progress', async () => {
    const file = dest();
    const seen: [number, number | undefined][] = [];
    const r = await downloadPdf(new URL(`${base}/book.pdf`), file, { ...local, onProgress: (a, b) => seen.push([a, b]) });
    expect(r).toMatchObject({ fileName: 'book.pdf', size: PDF.length });
    expect(fs.readFileSync(file)).toEqual(PDF);
    expect(seen.at(-1)).toEqual([PDF.length, PDF.length]);
  });

  it('follows redirects and uses the server’s file name', async () => {
    const a = await downloadPdf(new URL(`${base}/redirect`), dest(), local);
    expect(a.url).toBe(`${base}/book.pdf`);
    const b = await downloadPdf(new URL(`${base}/named`), dest(), local);
    expect(b.fileName).toBe('বই.pdf');
  });

  it('checks every redirect target again', async () => {
    const file = dest();
    await expect(downloadPdf(new URL(`${base}/to-private`), file, local)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('10.0.0.1') });
    expect(fs.existsSync(file)).toBe(false);
    await expect(downloadPdf(new URL(`${base}/loop`), dest(), local)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', message: expect.stringContaining('redirects') });
  });

  it('refuses web pages and other files without keeping anything', async () => {
    const file = dest();
    await expect(downloadPdf(new URL(`${base}/page`), file, local)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This link opens a web page, not a PDF file.' });
    await expect(downloadPdf(new URL(`${base}/text`), file, local)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This link does not point to a PDF file.' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('enforces the size limit from the header and while streaming', async () => {
    const file = dest();
    await expect(downloadPdf(new URL(`${base}/book.pdf`), file, { ...local, maxBytes: 10 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(downloadPdf(new URL(`${base}/chunked-big`), file, { ...local, maxBytes: 1000 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('explains a missing file', async () => {
    await expect(downloadPdf(new URL(`${base}/gone.pdf`), dest(), local)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', message: expect.stringContaining('not found') });
  });

  it('stops and cleans up when cancelled or when the server stalls', async () => {
    const file = dest();
    const ctrl = new AbortController();
    const p = downloadPdf(new URL(`${base}/hang`), file, { ...local, signal: ctrl.signal, onProgress: () => ctrl.abort() });
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fs.existsSync(file)).toBe(false);
    await expect(downloadPdf(new URL(`${base}/hang`), file, { ...local, idleTimeoutMs: 300 })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(fs.existsSync(file)).toBe(false);
  });
});
