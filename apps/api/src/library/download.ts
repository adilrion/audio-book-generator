import dns from 'node:dns';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@app/shared';
import { badRequest } from '../common/errors';

/**
 * Downloads a PDF from a link the user pasted (or the online library) into a local file.
 *
 * The API fetches the link itself, so it must not become a way to reach this Mac's own services
 * or the home network (SSRF): only http(s), only public addresses — checked on the address that
 * is actually connected to, so a DNS answer that changes between check and connect cannot slip
 * through — and every redirect is checked again.
 */

const BLOCKED = new net.BlockList();
for (const [range, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  BLOCKED.addSubnet(range, prefix, 'ipv4');
for (const [range, prefix] of [
  ['::', 127], // unspecified + loopback (IPv4-mapped ::ffff:a.b.c.d is checked against the IPv4 ranges)
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds any IPv4 address)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  BLOCKED.addSubnet(range, prefix, 'ipv6');

/** True for an address on the public internet (not loopback, private, link-local, …). */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (!family) return false;
  return !BLOCKED.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** `allow`: addresses to accept anyway — tests only (a local test server); user input never sets it. */
const allowed = (ip: string, allow: readonly string[]) => allow.includes(ip) || isPublicAddress(ip);

const blockedHost = (host: string) =>
  badRequest(`“${host}” is on this computer or your local network, which links cannot point to.`, 'Use a link to a PDF on a public website.');

/**
 * dns.lookup that refuses non-public answers (a host is rejected if any of its addresses is
 * private). http.get connects to exactly the address this returns.
 */
export const safeLookup =
  (allow: readonly string[] = []): net.LookupFunction =>
  (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, list) => {
      if (err) return callback(err, '');
      if (!list.length || list.some((a) => !allowed(a.address, allow))) return callback(blockedHost(hostname), '');
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };

/** Parse a user-supplied link; only http(s) without credentials, never to a local address. */
export function parseLink(raw: string, allow: readonly string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('That is not a valid link.', 'Paste the full address, starting with https://');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Only http:// and https:// links can be downloaded.');
  if (url.username || url.password) throw badRequest('Links with a user name or password cannot be downloaded.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowed(host, allow)) throw blockedHost(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw blockedHost(host);
  return url;
}

/**
 * Share links that open a preview page → the link that downloads the file itself.
 * Google Drive `/file/d/<id>/view` and Dropbox `?dl=0`.
 */
export function directLink(url: URL): URL {
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'drive.google.com') {
    const id = /\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
    if (id) return new URL(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`);
  }
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    const u = new URL(url);
    u.searchParams.delete('raw');
    u.searchParams.set('dl', '1');
    return u;
  }
  return url;
}

/** A safe local file name: Content-Disposition, else the last path segment, else the host. Always ends in .pdf. */
export function fileNameFrom(disposition: string | undefined, url: URL): string {
  let name: string | undefined;
  const star = /filename\*\s*=\s*(?:utf-8)?''([^;]+)/i.exec(disposition ?? '');
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      name = undefined;
    }
  }
  if (!name) {
    const m = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition ?? '');
    name = (m?.[1] ?? m?.[2])?.trim();
  }
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop();
    try {
      name = last ? decodeURIComponent(last) : undefined;
    } catch {
      name = last;
    }
  }
  name = (name ?? '')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  if (!name || /^\.+$/.test(name)) name = url.hostname;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

export interface DownloadOptions {
  maxBytes: number;
  signal?: AbortSignal;
  /** Called (at most every 200 ms) once the first bytes are confirmed to be a PDF. */
  onProgress?: (received: number, total?: number) => void;
  /** No bytes for this long → give up. */
  idleTimeoutMs?: number;
  maxRedirects?: number;
  /** Tests only: private addresses to accept (a local HTTP server). User input never sets this. */
  allowAddresses?: readonly string[];
}

export interface DownloadResult {
  fileName: string;
  size: number;
  /** The address the file finally came from, after redirects. */
  url: string;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ario-audiobook/0.1';

export const tooLarge = (maxBytes: number) =>
  new AppError('FILE_TOO_LARGE', `This PDF is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`, {
    hint: 'Raise MAX_UPLOAD_MB in .env, or choose a smaller edition.',
    retryable: false,
  });

const notPdf = (isHtml: boolean) =>
  isHtml
    ? badRequest('This link opens a web page, not a PDF file.', 'Open it in your browser, find the PDF download button, right-click it and choose “Copy Link Address”, then paste that link.')
    : badRequest('This link does not point to a PDF file.', 'Use a link that ends in .pdf or downloads a PDF when opened.');

const downloadFailed = (message: string, cause?: unknown) =>
  new AppError('DOWNLOAD_FAILED', message, { hint: 'Check the link and your internet connection, then try again.', retryable: true, cause });

const aborted = () => new AppError('ABORTED', 'The download was cancelled.', { retryable: true });

function get(url: URL, opts: DownloadOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(
      url,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5' },
        lookup: safeLookup(opts.allowAddresses),
        signal: opts.signal,
        timeout: opts.idleTimeoutMs ?? 30_000,
      },
      resolve,
    );
    req.on('timeout', () => req.destroy(downloadFailed('The website stopped responding.')));
    req.on('error', reject);
  });
}

function toDownloadError(e: unknown, signal?: AbortSignal): AppError {
  if (signal?.aborted) return aborted();
  if (e instanceof AppError) return e;
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return downloadFailed('That website could not be found.', e);
  if (code === 'ENOSPC') return new AppError('DISK_FULL', 'Your disk is full.', { hint: 'Free some space, then try again.', cause: e });
  if (typeof code === 'string' && /^(ERR_TLS|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return downloadFailed('The website’s security certificate is not valid.', e);
  return downloadFailed('The download failed.', e);
}

/** Download `link` to `dest` (which must not exist yet). Removes `dest` again on any failure. */
export async function downloadPdf(link: URL, dest: string, opts: DownloadOptions): Promise<DownloadResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = link;
  try {
    for (let hop = 0; ; hop++) {
      const res = await get(url, opts);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= maxRedirects) throw downloadFailed('The link redirects too many times.');
        url = parseLink(new URL(res.headers.location, url).toString(), opts.allowAddresses);
        continue;
      }
      if (status !== 200) {
        res.resume();
        if (status === 404 || status === 410) throw downloadFailed('The file is no longer at that link (not found).');
        if (status === 401 || status === 403) throw downloadFailed('The website does not allow this file to be downloaded without signing in.');
        throw downloadFailed(`The website answered with an error (HTTP ${status}).`);
      }
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      if (/^text\/html|^application\/xhtml/.test(type)) {
        res.resume();
        throw notPdf(true);
      }
      const length = Number(res.headers['content-length']);
      const total = Number.isFinite(length) && length > 0 ? length : undefined;
      if (total && total > opts.maxBytes) {
        res.resume();
        throw tooLarge(opts.maxBytes);
      }

      let received = 0;
      let head = Buffer.alloc(0);
      let reported = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          if (received > opts.maxBytes) return cb(tooLarge(opts.maxBytes));
          if (head.length < 5) {
            head = Buffer.concat([head, chunk]).subarray(0, 5);
            if (head.length < 5) return cb(null, chunk);
            if (head.toString('latin1') !== '%PDF-') return cb(notPdf(type.includes('html')));
          }
          const now = Date.now();
          if (now - reported >= 200) {
            reported = now;
            opts.onProgress?.(received, total);
          }
          cb(null, chunk);
        },
      });
      await pipeline(res, meter, fs.createWriteStream(dest, { flags: 'wx' }), { signal: opts.signal });
      if (head.length < 5) throw notPdf(false);
      opts.onProgress?.(received, total);
      return { fileName: fileNameFrom(res.headers['content-disposition'], url), size: received, url: url.toString() };
    }
  } catch (e) {
    await fsp.rm(dest, { force: true }).catch(() => undefined);
    throw toDownloadError(e, opts.signal);
  }
}
