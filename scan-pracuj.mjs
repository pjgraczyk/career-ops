#!/usr/bin/env node
// @ts-check
/**
 * scan-pracuj.mjs — Pracuj.pl (www.pracuj.pl, Poland's largest job board)
 * scanner via the lightpanda headless browser.
 *
 * **operator: Grupa Pracuj sp. z o.o.** (declared per Source Indexing Policy
 * rule 4; the www.pracuj.pl host is the operator's own domain).
 *
 * Why this is a standalone browser scanner and not a `providers/*.mjs` module
 * (providers/ADDING_A_PROVIDER.md, "Browser-based scanners"):
 *
 * Measured live on 2026-11-23:
 *   - A plain HTTP GET of a listing page (`/praca/python`, Requested with the
 *     shared BROWSER_LIKE_USER_AGENT) answers `403` with
 *     `cf-mitigated: challenge` — Cloudflare challenges every plain-HTTP
 *     client on www.pracuj.pl, `robots.txt` notwithstanding (it allows the
 *     `/praca/` listing paths and states no Crawl-delay).
 *   - A real browser engine passes without any interactive step:
 *     lightpanda 1.0.5 headless fetched the same pages with HTTP 200 and a
 *     full `script#__NEXT_DATA__` payload. The page is Next.js SSR
 *     (`__N_SSP`), so the whole result list is already in the HTML the
 *     browser renders — no hydration wait is needed.
 *
 * Same architectural pattern as scan-topdev.mjs and scan-dayforce.mjs: drive
 * a real browser, read only what a visitor sees (no login, no cookies of a
 * real person), never solve or relay a challenge. A challenge page throws a
 * named error and the WHOLE scan stops: the same gate stands in front of
 * every remaining search, so continuing would re-request a board that has
 * already told us no.
 *
 * The engine is lightpanda (https://lightpanda.io), invoked as its `fetch`
 * CLI — one process per page, which besides transport gives a natural pause
 * between requests. The binary is resolved from `$PRACUJ_LIGHTPANDA`, then
 * `~/.local/bin/lightpanda`, then `$PATH`.
 *
 * Pacing: this repo's own liveness layer measured pracuj.pl's Cloudflare
 * flagging a session after ~2 rapid hits (check-liveness.mjs,
 * liveness-browser.mjs), so every request is spaced a jittered 6–12 s apart
 * — the same shape as check-liveness's `--throttle` default, applied
 * unconditionally here since every request hits the same host.
 *
 * Reads `pracuj_searches` from portals.yml:
 *   pracuj_searches:
 *     - keyword: "data engineer"   # required — the board's own search slug
 *     # max_pages: 3               # optional — default 3, cap 25
 *
 * The listing page server-renders every result inside its
 * `script#__NEXT_DATA__` blob (`props.pageProps.dehydratedState.queries`,
 * queryKey[0] `jobOffers`): `groupedOffers` rows carry the title, employer,
 * per-place offer URLs, `initialPublicated` / `lastPublicated` /
 * `expirationDate`, contract- and work-mode labels. The payload's
 * `jobDescription` is a truncated teaser (~200 chars), so no `description`
 * is set — a teaser must not feed `content_filter`
 * (providers/ADDING_A_PROVIDER.md §1). Pagination is `?pn=N` (1-based; page 1
 * is the bare search), 50 grouped offers per page; the walk stops on a page
 * that yields no new postings, on a short page, or at the cap — whichever
 * comes first — and the cap is reported as `partial` through the same
 * `incomplete` flag the sibling scanners use.
 *
 * There is no location config in this first cut: the board's keyword search
 * is nationwide, and title/location filtering happens downstream anyway
 * (title_filter, location_filter, data/blacklist.md — all applied by the
 * shared admission gate, same as scan-topdev.mjs).
 *
 * Usage:
 *   node scan-pracuj.mjs
 *   node scan-pracuj.mjs --dry-run
 *   node scan-pracuj.mjs --keyword "python"   # one search, ignore portals.yml
 *   node scan-pracuj.mjs --pages 2 --delay-ms 8000
 *   node scan-pracuj.mjs --help|-h
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { loadYaml } from './lib/yaml-document.mjs';
import {
  appendToPipeline,
  appendToScanHistory,
  appendUnrecordedToScanHistory,
  DATA_ROOT as SCAN_DATA_ROOT,
  PORTALS_PATH,
} from './scan.mjs';
import { createAdmissionGate } from './lib/admission-gate.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { BOT_CHALLENGE_PATTERNS } from './liveness-core.mjs';

// ── Constants ────────────────────────────────────────────────────────

export const ALLOWED_HOST = 'www.pracuj.pl';
const LISTING_BASE_URL = `https://${ALLOWED_HOST}/praca`;

/**
 * Own page ceiling, independent of what the source reports
 * (providers/ADDING_A_PROVIDER.md §2, "Absolute page ceiling"). Kept low:
 * every page costs a browser render against a WAF the repo's liveness layer
 * already documented as flagging a session after ~2 rapid hits.
 */
export const DEFAULT_MAX_PAGES = 3;
export const MAX_PAGES_CAP = 25;

/**
 * Spacing between requests to www.pracuj.pl, in milliseconds. A jittered
 * [base, 2*base) gap is applied around EVERY request (page 1 included) —
 * see the measured-WAF note in the header.
 */
export const INTER_PAGE_DELAY_MS = 6000;

/** Same interstitial markers the sibling scanners treat as "blocked". */
export const CHALLENGE_MARKERS = Object.freeze([
  'just a moment',
  'challenge-platform',
  'challenge-form',
  'cf-challenge',
]);

/** The listing's Next.js data script — the whole payload this scanner reads. */
const NEXT_DATA_SELECTOR = 'script#__NEXT_DATA__';
const JOB_OFFERS_QUERY_KEY = 'jobOffers';

const DATA_ROOT = getCareerOpsRoot();

// ── Args ─────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--dry-run', '--debug', '--keyword', '--pages', '--max-pages', '--delay-ms', '--help', '-h'];
const VALUE_FLAGS = ['--keyword', '--pages', '--max-pages', '--delay-ms'];

const USAGE = `Usage:
  node scan-pracuj.mjs
  node scan-pracuj.mjs --dry-run
  node scan-pracuj.mjs --keyword "python"
  node scan-pracuj.mjs --pages 2 --delay-ms 8000
  node scan-pracuj.mjs --help|-h

Reads pracuj_searches from portals.yml:
  pracuj_searches:
    - keyword: "data engineer"
      max_pages: 3               # optional; default 3, cap 25

Flags:
  --keyword TEXT   scan one keyword, ignoring pracuj_searches
  --pages N        max pages per search (default 3, cap 25; alias --max-pages)
  --delay-ms N     base pause between requests (default 6000; jittered up to 2x)
  --dry-run        print matches, write nothing
  --debug          save extracted page payloads to output/
  --help, -h       show this help and exit`;

/**
 * Parse CLI arguments. Pure and argv-injected so a test can drive it without
 * the module reading `process.argv` at import time.
 *
 * @param {string[]} argv
 * @returns {{dryRun: boolean, debug: boolean, singleKeyword: (string|null), maxPages: (number|null), delayMs: (number|null)}}
 */
export function parseArgs(argv = []) {
  const rawPages = flagValue(argv, '--pages') ?? flagValue(argv, '--max-pages');
  const rawDelay = flagValue(argv, '--delay-ms');
  return {
    dryRun: hasFlag(argv, '--dry-run'),
    debug: hasFlag(argv, '--debug'),
    singleKeyword: flagValue(argv, '--keyword') ?? null,
    maxPages: rawPages !== undefined && /^[1-9]\d*$/.test(String(rawPages)) ? Number(rawPages) : null,
    delayMs: rawDelay !== undefined && /^\d+$/.test(String(rawDelay)) ? Number(rawDelay) : null,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────

/**
 * Fold Polish diacritics and slugify a keyword the way the board's own
 * search links do ("Dane inżynier" → "dane-inzynier"). Measured live: a
 * hyphenated multi-word slug (`data-engineer`) reaches the same result set
 * as the spaces form.
 *
 * @param {unknown} keyword
 * @returns {string}
 */
export function slugifyKeyword(keyword) {
  return String(keyword ?? '')
    .trim()
    .toLowerCase()
    .replace(/[ą]/g, 'a')
    .replace(/[ć]/g, 'c')
    .replace(/[ę]/g, 'e')
    .replace(/[ł]/g, 'l')
    .replace(/[ń]/g, 'n')
    .replace(/[ó]/g, 'o')
    .replace(/[ś]/g, 's')
    .replace(/[żź]/g, 'z')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Host-pin a URL to www.pracuj.pl over HTTPS — applied to every request URL
 * and to every resolved posting URL, so an off-host anchor or a poisoned
 * parameter cannot turn this scanner into an SSRF hop.
 *
 * @param {string} url
 * @returns {string} The same URL, validated.
 */
export function assertPracujUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`pracuj: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`pracuj: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== ALLOWED_HOST) {
    throw new Error(`pracuj: untrusted hostname "${parsed.hostname}" — must be ${ALLOWED_HOST}`);
  }
  return parsed.toString();
}

/**
 * Search URL for one page. `?pn=N` from page 2 onward (page 1 is the bare
 * search; the board itself canonicalizes `/praca/{kw}` → `/praca/{kw};kw`).
 *
 * @param {string} keyword
 * @param {number} page - 1-based.
 * @returns {string}
 */
export function buildSearchUrl(keyword, page) {
  const slug = slugifyKeyword(keyword);
  if (!slug) throw new Error(`pracuj: empty keyword: ${JSON.stringify(keyword)}`);
  const url = page > 1 ? `${LISTING_BASE_URL}/${slug}?pn=${Number(page)}` : `${LISTING_BASE_URL}/${slug}`;
  return assertPracujUrl(url);
}

/**
 * Text of the `script#__NEXT_DATA__` blob's JSON document, or an error.
 *
 * lightpanda's --dump-selector returns the element serialized as HTML
 * (`<script ...>...</script>`); the scanner strips the wrapper before
 * JSON.parse. A missing blob is a markup change → the caller throws.
 *
 * @param {string} content
 * @returns {object} The parsed Next.js page props.
 */
export function parseNextData(content) {
  const stripped = String(content ?? '')
    .trim()
    .replace(/^<script[^>]*>/, '')
    .replace(/<\/script>$/, '');
  try {
    return JSON.parse(stripped);
  } catch (cause) {
    throw new Error(`pracuj: __NEXT_DATA__ is not valid JSON: ${cause?.message ?? cause}`);
  }
}

/**
 * The `jobOffers` React-Query result out of the Next.js payload, or a
 * descriptive throw. `groupedOffers` is documented whole-list container, so
 * a payload without it is "broken", not "empty"
 * (providers/ADDING_A_PROVIDER.md §2, the empty-vs-broken split).
 *
 * @param {object} nextData
 * @returns {{groupedOffers: Array<object>, offersTotalCount: (number|undefined)}}
 */
export function extractJobOffersQuery(nextData) {
  const pageProps = nextData?.props?.pageProps;
  const queries = Array.isArray(pageProps?.dehydratedState?.queries)
    ? pageProps.dehydratedState.queries
    : null;
  if (!queries) {
    const keys = nextData && typeof nextData === 'object' ? Object.keys(nextData).join(', ') : typeof nextData;
    throw new Error(`pracuj: unexpected __NEXT_DATA__ shape — expected props.pageProps.dehydratedState.queries, got: [${keys}]`);
  }
  const query = queries.find((q) => Array.isArray(q?.queryKey) && q.queryKey[0] === JOB_OFFERS_QUERY_KEY);
  if (!query) {
    const named = queries.map((q) => (Array.isArray(q?.queryKey) ? String(q.queryKey[0]) : '?')).slice(0, 8).join(' | ');
    throw new Error(`pracuj: no "${JOB_OFFERS_QUERY_KEY}" query in the page payload — got: [${named}]`);
  }
  const data = query?.state?.data;
  const groupedOffers = Array.isArray(data?.groupedOffers) ? data.groupedOffers : null;
  if (!groupedOffers) {
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
    throw new Error(`pracuj: jobOffers payload has no groupedOffers[] — got: [${keys}]`);
  }
  return { groupedOffers, offersTotalCount: data.offersTotalCount };
}

/** NaN-safe epoch-ms from a date string (the toEpochMs pattern; §2). */
export function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * workplaceType for one grouped offer's `workModes` labels, set only when
 * every mapped label agrees. Polish board vocabulary: "Praca zdalna"
 * (remote), "Praca hybrydowa…" (hybrid), "Praca stacjonarna…" (onsite).
 *
 * @param {unknown} workModes
 * @returns {('remote'|'hybrid'|'onsite')|undefined}
 */
export function workplaceTypeFor(workModes) {
  if (!Array.isArray(workModes)) return undefined;
  const mapped = workModes
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => {
      const hay = m.toLowerCase();
      if (hay.includes('zdaln')) return 'remote';
      if (hay.includes('hybrydow')) return 'hybrid';
      if (hay.includes('stacjonarn')) return 'onsite';
      return null;
    })
    .filter(Boolean);
  const distinct = [...new Set(mapped)];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * Places of one grouped offer, as the board displays them (`offers[].displayWorkplace`).
 * A whole-Poland offer with no named place reads "Cała Polska" — the label
 * the board itself uses; nothing is invented for a row that has neither.
 *
 * @param {object} group
 * @returns {string[]}
 */
export function placesFor(group) {
  const places = (Array.isArray(group?.offers) ? group.offers : [])
    .map((o) => (typeof o?.displayWorkplace === 'string' ? o.displayWorkplace.replace(/\s+/g, ' ').trim() : ''))
    .filter(Boolean);
  if (places.length === 0 && group?.isWholePoland === true) return ['Cała Polska'];
  return places;
}

/**
 * One `groupedOffers` row → a scanner offer, or null when the row is
 * malformed (a bad row is dropped, never fatal to the board — §2).
 *
 * @param {object} group
 * @returns {{title: string, url: string, company: string, location: string, postedAt?: number}|null}
 */
export function normalizeOffer(group) {
  if (!group || typeof group !== 'object') return null;
  const title = typeof group.jobTitle === 'string' ? group.jobTitle.trim() : '';
  const row = Array.isArray(group.offers) ? group.offers.find((o) => o && typeof o === 'object') : null;
  let url = typeof row?.offerAbsoluteUri === 'string' ? row.offerAbsoluteUri.trim() : '';
  if (!title || !url) return null;
  try {
    url = assertPracujUrl(url);
  } catch {
    return null; // off-host or non-HTTPS anchor: drop the row
  }
  const places = placesFor(group);
  const postedAt = toEpochMs(group.initialPublicated);
  const workplaceType = workplaceTypeFor(group.workModes);
  return {
    title,
    url,
    company: typeof group.companyName === 'string' ? group.companyName.trim() : '',
    location: places.join(' / '),
    ...(postedAt !== undefined ? { postedAt } : {}),
    ...(workplaceType ? { workplaceType } : {}),
  };
}

/**
 * All offers of one listing page, deduped by URL, in the payload's order.
 *
 * @param {object} nextData - Parsed __NEXT_DATA__.
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number, workplaceType?: string}>}
 */
export function parseOffersPage(nextData) {
  const { groupedOffers } = extractJobOffersQuery(nextData);
  /** @type {Map<string, any>} */
  const byUrl = new Map();
  for (const group of groupedOffers) {
    const offer = normalizeOffer(group);
    if (offer && !byUrl.has(offer.url)) byUrl.set(offer.url, offer);
  }
  return [...byUrl.values()];
}

/**
 * Does this page (or its lightpanda report) show an anti-bot challenge
 * instead of listings? A challenge is a block, not an empty board, and must
 * be reported as such (ADDING_A_PROVIDER.md §2 rule 3: never solve, relay,
 * or retry a challenge).
 *
 * @param {unknown} haystack - Page text, payload, or both concatenated.
 * @returns {boolean}
 */
export function detectChallenge(haystack) {
  if (typeof haystack !== 'string' || !haystack) return false;
  const hay = haystack.toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => hay.includes(marker.toLowerCase()))) return true;
  return BOT_CHALLENGE_PATTERNS.some((re) => re.test(hay));
}

/** Thrown when pracuj.pl puts a challenge in front of its public listings. */
export class PracujChallengeError extends Error {
  constructor(url) {
    super(`pracuj: challenge page served at ${url} — not solved, not retried (see ADDING_A_PROVIDER.md §2 rule 3)`);
    this.name = 'PracujChallengeError';
  }
}

/** Thrown when the page answered but its listing payload is not there. */
export class PracujRenderError extends Error {
  constructor(url, detail) {
    super(`pracuj: ${url} did not deliver its listing payload: ${detail}. This is a markup change or a block — rerun with --debug and inspect the dump.`);
    this.name = 'PracujRenderError';
  }
}

/**
 * Does this error end the whole scan, or just its keyword? A challenge is
 * board-wide: the same gate stands in front of every remaining search.
 * (See scan-topdev.mjs for the same reasoning.)
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isScanFatal(err) {
  return err instanceof PracujChallengeError;
}

// ── lightpanda layer ─────────────────────────────────────────────────

/**
 * Resolve the lightpanda binary: `$PRACUJ_LIGHTPANDA`, then `$PATH`, then
 * `~/.local/bin/lightpanda` (its usual single-user install location).
 *
 * @returns {string}
 */
export function resolveLightpandaBin() {
  const env = typeof process !== 'undefined' ? process.env : {};
  // An explicit $PRACUJ_LIGHTPANDA wins verbatim — the user pinned the
  // binary; if it is wrong, the spawn fails with a named ENOENT error.
  const override = typeof env.PRACUJ_LIGHTPANDA === 'string' ? env.PRACUJ_LIGHTPANDA.trim() : '';
  if (override) return override;
  if (existsSync(join(homedir(), '.local', 'bin', 'lightpanda'))) {
    return join(homedir(), '.local', 'bin', 'lightpanda');
  }
  return 'lightpanda'; // bare name — spawn resolves it from $PATH
}

/**
 * The challenge verdict for one lightpanda report: lightpanda's own
 * `bot_challenge` field, a wall-shaped HTTP status (403 / 429 / 503), or
 * challenge markers in the dumped payload. Never the JSON report line
 * itself: it echoes response headers (`cf-ray`), which
 * BOT_CHALLENGE_PATTERNS' /\bcf-ray\b/ would read as a wall.
 *
 * @param {{http_status?: number, bot_challenge?: unknown}} report
 * @param {string} dumped - The dumped `__NEXT_DATA__` payload (may be empty).
 * @returns {boolean}
 */
export function reportReadsAsChallenge(report, dumped) {
  return Boolean(report?.bot_challenge)
    || report?.http_status === 403
    || report?.http_status === 429
    || report?.http_status === 503
    || detectChallenge(dumped);
}

/**
 * Read one URL through lightpanda's `fetch` CLI: the JSON report line, the
 * dumped `script#__NEXT_DATA__` content, or a named failure.
 *
 * One process per page — the spawn itself is the natural pause between
 * requests, and nothing about the page is read outside what a visitor's
 * browser renders (no login, no cookies, no challenge ever solved).
 *
 * @param {string} url
 * @param {{execFile?: Function, debug?: boolean}} [options]
 * @returns {Promise<{nextData: object, dumped: string}>} parsed payload + raw dump (for --debug)
 */
export function fetchPracujPage(url, options = {}) {
  assertPracujUrl(url);
  const execFileImpl = options.execFile ?? execFile;
  const bin = resolveLightpandaBin();
  return new Promise((resolve, reject) => {
    execFileImpl(
      bin,
      ['fetch', url, '--json', '--dump', 'html', '--dump-selector', NEXT_DATA_SELECTOR],
      { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new PracujRenderError(url, `lightpanda failed: ${err.message.split('\n')[0]}${stderr ? ` — ${stderr.split('\n')[0]}` : ''}`));
          return;
        }
        // lightpanda interleaves $time=… log lines with the one JSON report
        // object; take the last line that looks like the report.
        const lines = String(stdout).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{"url"'));
        const reportLine = lines[lines.length - 1];
        if (!reportLine) {
          reject(new PracujRenderError(url, `lightpanda produced no JSON report (stderr: ${String(stderr).split('\n')[0]})`));
          return;
        }
        let report;
        try {
          report = JSON.parse(reportLine);
        } catch (cause) {
          reject(new PracujRenderError(url, `lightpanda's report is not valid JSON: ${cause?.message ?? cause}`));
          return;
        }
        const dumped = typeof report.content === 'string' ? report.content : '';
        if (report.error || dumped === '' || reportReadsAsChallenge(report, dumped)) {
          // A challenge (the verdict above) is the one case that names itself;
          // an error or an empty dump has no listing payload to walk.
          reject(new PracujChallengeError(url));
          return;
        }
        let nextData;
        try {
          nextData = parseNextData(dumped);
        } catch (cause) {
          reject(cause instanceof PracujRenderError ? cause : new PracujRenderError(url, cause?.message ?? String(cause)));
          return;
        }
        resolve({ nextData, dumped });
      },
    );
  });
}

// ── Search walk ──────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Jittered delay, the liveness-browser pattern: a value in [baseMs, 2*baseMs)
 * — a fixed cadence is a fingerprint, and pracuj.pl's WAF is rate-based.
 *
 * @param {number} baseMs
 * @returns {number}
 */
export function jitteredDelayMs(baseMs) {
  if (!baseMs || baseMs <= 0) return 0;
  return baseMs + Math.floor(Math.random() * baseMs);
}

/**
 * Page through one search, stopping when a page yields no new postings, when
 * a page returns fewer rows than a full page (the board's own walk end), at
 * `maxPages`, or on a named error. Page-1 failures stop the search (and a
 * challenge stops the whole scan); deeper-page failures keep the pages
 * already read and mark the result incomplete.
 *
 * @param {{keyword: string, maxPages: number}} search
 * @param {{fetchPage: (url: string) => Promise<{nextData: object, dumped: string}>, delayMs?: number, sleepImpl?: (ms: number) => Promise<void>, jitterImpl?: (ms: number) => number, debug?: boolean}} options
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number, workplaceType?: string}>>}
 *   The jobs, with `.incomplete` and `.error` set when a deeper page failed.
 */
export async function scanPracujSearch(search, options) {
  const { fetchPage, delayMs = INTER_PAGE_DELAY_MS, sleepImpl = sleep, jitterImpl = jitteredDelayMs, debug = false } = options;
  const pageLimit = Math.min(Math.max(1, search.maxPages), MAX_PAGES_CAP);
  const seen = new Set();
  const collected = [];

  for (let page = 1; page <= pageLimit; page++) {
    if (page > 1) await sleepImpl(jitterImpl(delayMs));
    const url = buildSearchUrl(search.keyword, page);
    let nextData;
    try {
      ({ nextData } = await fetchPage(url));
    } catch (err) {
      if (page === 1) throw err;
      collected.incomplete = true;
      collected.error = err;
      break;
    }
    if (debug) {
      const debugDir = join(DATA_ROOT, 'output');
      mkdirSync(debugDir, { recursive: true });
      const dump = join(debugDir, `debug-pracuj-${slugifyKeyword(search.keyword)}-p${page}.json`);
      writeFileSync(dump, JSON.stringify(nextData, null, 2));
      console.log(`  [debug] payload → ${dump}`);
    }
    const { groupedOffers } = extractJobOffersQuery(nextData);
    const sourceRowCount = groupedOffers.length;
    const offers = parseOffersPage(nextData);
    const fresh = offers.filter((o) => !seen.has(o.url));
    for (const o of fresh) {
      seen.add(o.url);
      collected.push(o);
    }
    // A page that is short (of the rows the SOURCE returned) or adds nothing
    // new ends the walk; a full page at the cap is reported partial.
    if (sourceRowCount < 50 || fresh.length === 0) break;
    if (page === pageLimit) collected.incomplete = true;
  }
  return collected;
}

// ── Config & main ────────────────────────────────────────────────────

/**
 * @param {object} portals
 * @returns {Array<{keyword: string, maxPages: number}>}
 */
export function loadSearches(portals) {
  const list = Array.isArray(portals?.pracuj_searches) ? portals.pracuj_searches : [];
  return list
    .map((s, index) => {
      const where = `pracuj_searches[${index}]`;
      const raw = typeof s === 'string' ? { keyword: s } : s;
      if (!raw || typeof raw !== 'object' || typeof raw.keyword !== 'string' || !raw.keyword.trim()) {
        throw new Error(`${where}: \`keyword\` is required and must be a non-empty string`);
      }
      const entry = { keyword: raw.keyword.trim() };
      const rawMax = Number.isInteger(/** @type {any} */ (raw).max_pages) ? /** @type {any} */ (raw).max_pages : DEFAULT_MAX_PAGES;
      entry.maxPages = Math.min(Math.max(1, rawMax), MAX_PAGES_CAP);
      return entry;
    });
}

/**
 * @param {{argv?: string[], fetchPage?: (url: string) => Promise<{nextData: object, dumped: string}>, sleepImpl?: (ms: number) => Promise<void>, jitterImpl?: (ms: number) => number}} [options]
 * @returns {Promise<number>} process exit code
 */
export async function main({ argv = [], fetchPage, sleepImpl = sleep, jitterImpl = jitteredDelayMs } = {}) {
  const { dryRun, debug, singleKeyword, maxPages: cliMaxPages, delayMs: cliDelayMs } = parseArgs(argv);

  mkdirSync(join(DATA_ROOT, 'data'), { recursive: true });

  let config = {};
  if (existsSync(PORTALS_PATH)) {
    config = loadYaml(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  }

  let searches;
  if (singleKeyword && singleKeyword.trim()) {
    searches = [{ keyword: singleKeyword.trim(), maxPages: cliMaxPages ?? DEFAULT_MAX_PAGES }];
  } else {
    try {
      searches = loadSearches(config);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
    if (searches.length === 0) {
      console.error(
        'No `pracuj_searches` configured in portals.yml.\n' +
        'Add at least one entry, for example:\n\n' +
        'pracuj_searches:\n' +
        '  - keyword: "data engineer"\n',
      );
      return 1;
    }
  }
  if (cliMaxPages) for (const s of searches) s.maxPages = Math.min(s.maxPages, cliMaxPages);

  const gate = createAdmissionGate({ config });
  const date = localToday();
  const delayMs = cliDelayMs ?? INTER_PAGE_DELAY_MS;

  const newOffers = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const dupeSkipped = [];
  const errors = [];
  const handledThisRun = new Set();
  let totalFound = 0;
  let challengeStopped = false;

  // Searches overlap, so one posting comes back under several keywords. Its
  // first sighting already got a verdict and a scan-history row; a repeat
  // must not pin the URL with a skipped_dup row on top of a skip meant to be
  // revisited.
  searches: for (const search of searches) {
    const seenUrls = new Set();

    process.stdout.write(`  "${search.keyword}" ... `);
    let offers;
    try {
      offers = await scanPracujSearch(
        { keyword: search.keyword, maxPages: search.maxPages },
        {
          fetchPage: fetchPage ?? ((url) => fetchPracujPage(url, { debug })),
          delayMs,
          sleepImpl,
          jitterImpl,
          debug,
        },
      );
    } catch (err) {
      process.stdout.write(`ERROR\n`);
      errors.push({ keyword: search.keyword, page: 1, error: /** @type {Error} */ (err).message });
      if (isScanFatal(err)) {
        console.log('  challenge encountered — stopping the scan; the board is not retried');
        challengeStopped = true;
        break;
      }
      continue;
    }
    if (offers.error) {
      // A deeper page failed transiently: the pages already read stand.
      errors.push({ keyword: search.keyword, page: 2, error: /** @type {Error} */ (offers.error).message });
    }

    process.stdout.write(`${offers.length} found\n`);
    totalFound += offers.length;
    if (offers.incomplete && !offers.error) {
      console.warn(`  ⚠️  "${search.keyword}" hit the max_pages cap (${search.maxPages}) — raise it on this entry to read deeper`);
    }

    for (const offer of offers) {
      if (seenUrls.has(offer.url)) continue;
      seenUrls.add(offer.url);

      const canonical = {
        url: offer.url,
        company: offer.company || 'Pracuj.pl',
        title: offer.title,
        location: offer.location,
        source: 'pracuj',
        ...(offer.postedAt !== undefined ? { postedAt: offer.postedAt } : {}),
        ...(offer.workplaceType ? { workArrangement: offer.workplaceType === 'remote' ? 'Remote' : offer.workplaceType === 'hybrid' ? 'Hybrid' : 'On-site' } : {}),
      };

      if (handledThisRun.has(canonical.url)) continue;
      handledThisRun.add(canonical.url);

      const reason = gate.check(canonical);
      if (reason === 'seen') { dupeSkipped.push(canonical); continue; }
      if (reason === 'blacklisted') continue;
      if (reason === 'title') { titleSkipped.push(canonical); continue; }
      if (reason === 'location') { locationSkipped.push(canonical); continue; }
      newOffers.push(canonical);
    }
  }

  if (!dryRun) {
    if (newOffers.length > 0) await appendToPipeline(newOffers);
    if (newOffers.length > 0) await appendToScanHistory(newOffers, date, 'added');
    await appendUnrecordedToScanHistory(titleSkipped, date, 'skipped_title');
    await appendUnrecordedToScanHistory(locationSkipped, date, 'skipped_location');
    await appendUnrecordedToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  printScanSummaryHeader('Pracuj.pl Scan', date);
  console.log(`Searches:           ${searches.length}`);
  console.log(`Total found:        ${totalFound}`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Blacklisted:        ${gate.counts.blacklisted}`);
  console.log(`Duplicates:         ${dupeSkipped.length}`);
  console.log(`New offers:         ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ "${e.keyword}" page ${e.page}: ${e.error}`);
  }

  if (challengeStopped) {
    console.log('\npracuj.pl served a challenge page: the scan stopped rather than retry it.');
    console.log('If this persists, the board may require an interactive check — see docs/SUPPORTED_JOB_BOARDS.md.');
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    console.log(dryRun ? '\n(dry run — not saved)' : '\nSaved to data/pipeline.md');
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
  // Errors are reported in the summary above, not through the exit code —
  // same convention as scan-interamt.mjs and scan-dayforce.mjs, so a
  // scheduled caller does not treat one challenged keyword as a crashed scan.
  return 0;
}

// Guarded so importing this module (a test, or anything else) never drives a
// live scan and appends to the user's pipeline — the rule every sibling
// scanner follows (scan-topdev.mjs, scan-interamt.mjs, scan-dayforce.mjs).
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  main({ argv })
    .then((code) => { if (code) process.exit(code); })
    .catch((err) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
