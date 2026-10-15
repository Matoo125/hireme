// Server-side page fetching for the archive fallback (CLI and web UI saves,
// where there's no extension to hand us the live DOM).
//
// This takes a URL supplied by an authenticated user and makes the server
// request it, so it is an SSRF sink: without the address checks below, a
// bookmark of http://169.254.169.254/ would have the API read cloud metadata
// on the user's behalf. Every redirect hop is re-checked for the same reason.
import { promises as dns } from 'node:dns';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

// A real browser UA: plenty of sites serve a stub or a block page to anything
// that looks automated, which would archive as an empty article.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class FetchError extends Error {
  readonly status: number | undefined;

  constructor(message: string, { status }: { status?: number } = {}) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchedPage {
  html: string;
  /** The final URL after redirects; the base for resolving relative links. */
  url: string;
}

export interface FetchedResource {
  buffer: Buffer;
  contentType: string;
  /** The final URL after redirects; the base for resolving relative links. */
  url: string;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc: number, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, including cloud metadata at .169.254
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved
];

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  // String#split always yields at least one element.
  const addr = ip.toLowerCase().split('%')[0]!; // drop any zone index
  if (addr === '::1' || addr === '::') return true;

  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms reach v4 space.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);

  const head = parseInt(addr.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedV4(ip);
  if (version === 6) return isBlockedV6(ip);
  return true; // not an IP we can reason about
}

/** Reject a hostname that resolves to any address we won't talk to. */
async function assertPublicHost(hostname: string): Promise<void> {
  // A literal IP in the URL never reaches DNS, so check it directly.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new FetchError(`Refusing to fetch a private address (${hostname})`);
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new FetchError(`Could not resolve ${hostname}`);
  }
  if (!addresses.length) throw new FetchError(`Could not resolve ${hostname}`);

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new FetchError(`Refusing to fetch a private address (${hostname} → ${address})`);
    }
  }
  // Residual risk: the name is resolved again by fetch(), so a DNS rebind
  // between these two lookups could still land on a private address. Closing
  // that properly means dialing the checked IP with a Host header; not worth
  // the machinery here, but worth knowing about.
}

function decodeBody(buffer: Buffer, contentType: string | null): string {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const charset = match ? match[1] : 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/** Read a response body, aborting if it grows past `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const chunks = [];
  let total = 0;
  if (!response.body) throw new FetchError('The page returned an empty response');
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new FetchError('Page is too large to archive');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a URL's bytes, following redirects by hand so each hop is re-checked
 * against the SSRF guard, with no opinion on what content-type is acceptable
 * — callers decide that themselves from the returned `contentType`. Resolves
 * to `{ buffer, contentType, url }`, where `url` is the final URL after
 * redirects — the caller uses it as the base for resolving relative links.
 */
async function fetchResource(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchedResource> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = options;

  let current: string = rawUrl;
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new FetchError(`Not a valid URL: ${current}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new FetchError(`Only http and https can be archived, got ${url.protocol}`);
    }

    await assertPublicHost(url.hostname);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError('Timed out fetching the page');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const failure = err as Error;
      if (failure.name === 'AbortError') throw new FetchError('Timed out fetching the page');
      throw new FetchError(`Could not reach the page: ${failure.message}`);
    }

    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new FetchError(`Redirect with no Location (HTTP ${response.status})`);
        current = new URL(location, url).toString();
        continue;
      }

      if (!response.ok) {
        throw new FetchError(`The page returned HTTP ${response.status}`, { status: response.status });
      }

      const contentType = response.headers.get('content-type') || '';
      const buffer = await readCapped(response, maxBytes);
      return { buffer, contentType, url: url.toString() };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new FetchError(`Too many redirects (more than ${maxRedirects})`);
}

const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml|text\/plain/i;

/** Whether a Content-Type header looks like something extractArticle can parse. */
function isHtmlContentType(contentType: string): boolean {
  return !contentType || HTML_CONTENT_TYPE.test(contentType);
}

/**
 * Fetch a page's HTML specifically — a thin wrapper over `fetchResource` that
 * rejects anything that isn't HTML-ish and decodes the body as text. This is
 * the original, unchanged behavior; `fetchResource` exists so callers that
 * need to branch on content-type (a PDF, say) aren't forced through this
 * HTML-only gate first.
 */
async function fetchPage(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const resource = await fetchResource(rawUrl, options);
  if (!isHtmlContentType(resource.contentType)) {
    throw new FetchError(`Not an HTML page (${resource.contentType.split(';')[0]!.trim()})`);
  }
  return { html: decodeBody(resource.buffer, resource.contentType), url: resource.url };
}

export { fetchPage, fetchResource, isHtmlContentType, decodeBody, FetchError, assertPublicHost, isBlockedAddress };
