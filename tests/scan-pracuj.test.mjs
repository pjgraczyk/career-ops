// Fixture-based unit tests for the pure logic in scan-pracuj.mjs — argument
// parsing, keyword slugification, URL building and host-pinning, the
// __NEXT_DATA__ payload extraction, offer normalization, challenge detection,
// the search walk (pagination stops, page-cap reporting, deep-page failures),
// and config loading.
//
// What this suite does NOT cover: the lightpanda process layer
// (fetchPracujPage's spawn + report parsing beyond the seam). Exercising
// those against a mocked child process would mostly test the mock; the live
// smoke test covers them instead (see the PR description for the measurement:
// /praca/python and /praca/data-engineer?pn=2, HTTP 200, no challenge,
// 50 grouped offers per page under lightpanda 1.0.5 headless, 2026-11-23).
//
// Fixture values that reach the call are fictional (Acme, ExampleCo); the URL
// shapes are the board's real ones.
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_HOST,
  DEFAULT_MAX_PAGES,
  MAX_PAGES_CAP,
  parseArgs,
  slugifyKeyword,
  assertPracujUrl,
  buildSearchUrl,
  parseNextData,
  extractJobOffersQuery,
  toEpochMs,
  workplaceTypeFor,
  placesFor,
  normalizeOffer,
  parseOffersPage,
  detectChallenge,
  reportReadsAsChallenge,
  isScanFatal,
  PracujChallengeError,
  PracujRenderError,
  scanPracujSearch,
  loadSearches,
  resolveLightpandaBin,
  jitteredDelayMs,
} from '../scan-pracuj.mjs';
import { PORTAL_TOP_LEVEL_KEYS } from '../validate-portals.mjs';
import { describeSpawn } from './helpers/describe-spawn.mjs';

// One groupedOffers row in the exact shape read off the live payload
// (2026-11-23), reduced to the fields the parser reads, with fictional names.
const GROUP = {
  groupId: '802b0000-56be-0050-9e61-08df402a2192',
  jobTitle: 'Senior Backend Developer (m/k)',
  companyName: 'Acme sp. z o.o.',
  companyProfileAbsoluteUri: 'https://pracodawcy.pracuj.pl/company/20247292',
  lastPublicated: '2026-11-23T16:00:00Z',
  initialPublicated: '2026-11-12T23:00:00Z',
  expirationDate: '2026-12-12T22:59:59Z',
  // The payload's jobDescription is a ~200-char teaser ending mid-sentence —
  // why the provider sets no description at all.
  jobDescription: 'Twój zakres obowiązków, Rozwój API i architektury: Projektowanie, rozwój...',
  isSuperOffer: true,
  isRemoteWorkAllowed: false,
  isWholePoland: false,
  offers: [{
    partitionId: 1005217280,
    offerAbsoluteUri: `https://${ALLOWED_HOST}/praca/senior-backend-developer-wroclaw,oferta,1005217280`,
    displayWorkplace: 'Wrocław, Krzyki',
    isWholePoland: false,
  }],
  positionLevels: ['Starszy specjalista / Starsza specjalistka (senior)'],
  typesOfContract: ['Umowa o pracę'],
  workModes: ['Praca hybrydowa'],
};

function nextDataFixture(groupedOffers, extra = {}) {
  return {
    props: {
      pageProps: {
        ...extra,
        dehydratedState: { mutations: [], queries: [{ queryKey: ['other'], state: { data: 1 } }, { queryKey: ['jobOffers'], state: { data: { groupedOffers, offersTotalCount: groupedOffers.length, groupedOffersTotalCount: groupedOffers.length } } }] },
      },
    },
  };
}

const sleepSpy = () => {
  const calls = [];
  const sleepImpl = (ms) => { calls.push(ms); return Promise.resolve(); };
  return { calls, sleepImpl };
};

test('importing the scanner ignores the caller argv', () => {
  const moduleUrl = new URL('../scan-pracuj.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(moduleUrl)})`, '--', '--keyword'],
    { encoding: 'utf8' },
  );
  assert.strictEqual(result.status, 0, describeSpawn(result));
  assert.strictEqual(result.stderr, '');
});

test('parseArgs reads CLI flags', () => {
  assert.deepStrictEqual(parseArgs([]), {
    dryRun: false, debug: false, singleKeyword: null, maxPages: null, delayMs: null,
  });
  assert.deepStrictEqual(parseArgs(['--dry-run', '--debug', '--keyword', 'python', '--pages', '2', '--delay-ms', '8000', '--delay-ms=500']), {
    dryRun: true, debug: true, singleKeyword: 'python', maxPages: 2, delayMs: 500,
  });
  // the --flag=value form, which indexOf() cannot see
  assert.strictEqual(parseArgs(['--keyword=devops']).singleKeyword, 'devops');
  assert.strictEqual(parseArgs(['--max-pages', '4']).maxPages, 4);
  // a non-numeric value is left null — validateFlags rejects it at the CLI
  assert.strictEqual(parseArgs(['--pages', 'soon']).maxPages, null);
});

test('slugifyKeyword folds Polish diacritics the way the board\'s own search links do', () => {
  assert.strictEqual(slugifyKeyword('Data Engineer'), 'data-engineer');
  assert.strictEqual(slugifyKeyword('Tester oprogramowania'), 'tester-oprogramowania');
  // "inżynier" — ż folds to z, exactly the fold the board's own slugs apply.
  assert.strictEqual(slugifyKeyword('in\u017cynier'), 'inzynier');
  assert.strictEqual(slugifyKeyword('in\u017cynier oprogramowania'), 'inzynier-oprogramowania');
  assert.strictEqual(slugifyKeyword('  devops  '), 'devops');
  assert.strictEqual(slugifyKeyword('in\u017cynier -- QA!'), 'inzynier-qa');
});

test('assertPracujUrl pins the host and scheme', () => {
  assert.strictEqual(assertPracujUrl(`https://${ALLOWED_HOST}/praca/python`), `https://${ALLOWED_HOST}/praca/python`);
  assert.throws(() => assertPracujUrl(`http://${ALLOWED_HOST}/praca/python`), /must use HTTPS/);
  assert.throws(() => assertPracujUrl('https://evil.example/praca/python'), /untrusted hostname/);
  assert.throws(() => assertPracujUrl(`${ALLOWED_HOST}/praca/python`), /invalid URL/);
  assert.throws(() => assertPracujUrl(null), /invalid URL|pracuj/);
});

test('buildSearchUrl builds page 1 bare and ?pn=N from page 2', () => {
  assert.strictEqual(buildSearchUrl('data engineer', 1), `https://${ALLOWED_HOST}/praca/data-engineer`);
  assert.strictEqual(buildSearchUrl('data engineer', 2), `https://${ALLOWED_HOST}/praca/data-engineer?pn=2`);
  assert.strictEqual(buildSearchUrl('data engineer', 12), `https://${ALLOWED_HOST}/praca/data-engineer?pn=12`);
  assert.throws(() => buildSearchUrl('   ', 1), /empty keyword/);
});

test('parseNextData strips the script wrapper and parses', () => {
  const payload = nextDataFixture([]);
  const wrapped = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  assert.deepStrictEqual(parseNextData(wrapped), payload);
  assert.deepStrictEqual(parseNextData(JSON.stringify(payload)), payload);
  assert.throws(() => parseNextData('<html>no blob</html>'), /not valid JSON/);
  assert.throws(() => parseNextData(''), /not valid JSON/);
});

test('extractJobOffersQuery tells broken from empty', () => {
  // present and empty → the empty-board shape, not an error
  const empty = extractJobOffersQuery(nextDataFixture([]));
  assert.deepStrictEqual(empty.groupedOffers, []);
  assert.strictEqual(empty.offersTotalCount, 0);
  // container missing → descriptive throw naming the keys it got
  assert.throws(() => extractJobOffersQuery({ props: { pageProps: {} } }), /dehydratedState\.queries/);
  assert.throws(() => extractJobOffersQuery({ props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['seoContent'], state: { data: {} } }] } } } }), /no "jobOffers" query.*seoContent/s);
  // groupedOffers absent → throw, not a silent empty board
  assert.throws(() => extractJobOffersQuery({ props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['jobOffers'], state: { data: { offersTotalCount: 5 } } }] } } } }), /groupedOffers/);
});

test('toEpochMs is NaN-safe and honours epoch 0', () => {
  assert.strictEqual(toEpochMs('2026-11-12T23:00:00Z'), Date.parse('2026-11-12T23:00:00Z'));
  assert.strictEqual(toEpochMs('1970-01-01T00:00:00Z'), 0);
  assert.strictEqual(toEpochMs('not a date'), undefined);
  assert.strictEqual(toEpochMs(''), undefined);
  assert.strictEqual(toEpochMs(null), undefined);
});

test('workplaceTypeFor maps the board\'s own vocabulary, only when unambiguous', () => {
  assert.strictEqual(workplaceTypeFor(['Praca zdalna']), 'remote');
  assert.strictEqual(workplaceTypeFor(['Praca hybrydowa']), 'hybrid');
  // measured live wording ("to be agreed") — still hybrid
  assert.strictEqual(workplaceTypeFor(['Praca hybrydowa (do uzgodnienia)']), 'hybrid');
  assert.strictEqual(workplaceTypeFor(['Praca stacjonarna']), 'onsite');
  // a posting open both ways does not resolve to one value → omit
  assert.strictEqual(workplaceTypeFor(['Praca hybrydowa', 'Praca zdalna']), undefined);
  assert.strictEqual(workplaceTypeFor([]), undefined);
  assert.strictEqual(workplaceTypeFor(null), undefined);
});

test('placesFor reads displayWorkplace and uses the board\'s whole-Poland label', () => {
  assert.deepStrictEqual(placesFor(GROUP), ['Wrocław, Krzyki']);
  assert.deepStrictEqual(placesFor({ offers: [{ displayWorkplace: 'Warszawa' }, { displayWorkplace: '  Wrocław  ' }] }), ['Warszawa', 'Wrocław']);
  assert.deepStrictEqual(placesFor({ offers: [{ displayWorkplace: 'Warszawa' }, { displayWorkplace: 'Warszawa' }] }), ['Warszawa', 'Warszawa']);
  assert.deepStrictEqual(placesFor({ offers: [], isWholePoland: true }), ['Cała Polska']);
  assert.deepStrictEqual(placesFor({ offers: [] }), []);
  // a named place wins over the whole-Poland flag (no label is invented on top of it)
  assert.deepStrictEqual(placesFor({ offers: [{ displayWorkplace: 'Krk' }], isWholePoland: true }), ['Krk']);
});

test('normalizeOffer maps the live row shape and drops unusable rows', () => {
  const offer = normalizeOffer(GROUP);
  assert.strictEqual(offer.title, 'Senior Backend Developer (m/k)');
  assert.strictEqual(offer.company, 'Acme sp. z o.o.');
  assert.strictEqual(offer.url, `${ALLOWED_HOST ? `https://${ALLOWED_HOST}` : ''}/praca/senior-backend-developer-wroclaw,oferta,1005217280`);
  assert.strictEqual(offer.location, 'Wrocław, Krzyki');
  assert.strictEqual(offer.postedAt, Date.parse('2026-11-12T23:00:00Z'));
  assert.strictEqual(offer.workplaceType, 'hybrid');
  // no description: the payload's jobDescription is a truncated teaser
  assert.strictEqual('description' in offer, false);

  assert.strictEqual(normalizeOffer({ ...GROUP, jobTitle: '' }), null);
  assert.strictEqual(normalizeOffer({ ...GROUP, offers: [] }), null);
  assert.strictEqual(normalizeOffer({ ...GROUP, offers: [{ offerAbsoluteUri: 'https://evil.example/praca' }] }), null);
  assert.strictEqual(normalizeOffer(null), null);
});

test('parseOffersPage dedups by URL in payload order', () => {
  const dup = { ...GROUP, offers: [{ ...GROUP.offers[0] }] };
  const jobs = parseOffersPage(nextDataFixture([GROUP, dup]));
  assert.strictEqual(jobs.length, 1);
});

test('detectChallenge and isScanFatal', () => {
  assert.strictEqual(detectChallenge('Just a moment...'), true);
  assert.strictEqual(detectChallenge('oferty pracy'), false);
  assert.strictEqual(detectChallenge('Attention Required! | Cloudflare'), true);
  assert.strictEqual(detectChallenge(''), false);
  assert.strictEqual(detectChallenge(null), false);

  assert.strictEqual(isScanFatal(new PracujChallengeError('https://www.pracuj.pl/praca')), true);
  assert.strictEqual(isScanFatal(new PracujRenderError('https://www.pracuj.pl/praca', 'x')), false);
  assert.strictEqual(isScanFatal(new Error('x')), false);
});

test('reportReadsAsChallenge reads the verdict fields, never the report line (which echoes cf-ray)', () => {
  // A successful report line always contains the cf-ray header — an earlier
  // cut ran detectChallenge over it and read every 200 as a wall.
  const reportLine = '{"url":"https://www.pracuj.pl/praca/python;kw","http_status":200,"headers":[{"name":"cf-ray","value":"abc-WAW"}],"bot_challenge":null,"content":"{}"}';
  const report = JSON.parse(reportLine);
  assert.strictEqual(reportReadsAsChallenge(report, report.content), false);
  assert.strictEqual(detectChallenge(reportLine), true, 'the report line itself IS covered by the patterns — which is why it is never scanned');
  // the real verdict fields
  assert.strictEqual(reportReadsAsChallenge({ http_status: 403 }, ''), true);
  assert.strictEqual(reportReadsAsChallenge({ http_status: 429 }, ''), true);
  assert.strictEqual(reportReadsAsChallenge({ http_status: 503 }, ''), true);
  assert.strictEqual(reportReadsAsChallenge({ http_status: 200, bot_challenge: 'cloudflare' }, ''), true);
  assert.strictEqual(reportReadsAsChallenge({ http_status: 200, bot_challenge: null }, ''), false);
  assert.strictEqual(reportReadsAsChallenge({ http_status: 200 }, ''), false);
});

/**
 * One full listing page (50 rows) whose URLs differ by `prefix`, so distinct
 * page fixtures paginate past the dedup instead of reading as "nothing new".
 */
function fullPageFixture(prefix) {
  return nextDataFixture(Array.from({ length: 50 }, (_, i) => ({
    ...GROUP,
    jobTitle: `Role ${prefix}-${i}`,
    offers: [{ offerAbsoluteUri: `https://${ALLOWED_HOST}/praca/role-${prefix}-${i},oferta,${i}` }],
  })));
}

test('scanPracujSearch stops on a short page and reports the cap as incomplete', async () => {
  const pageA = fullPageFixture('a');
  const pageB = fullPageFixture('b');
  const shortPage = nextDataFixture([GROUP]);
  const { calls, sleepImpl } = sleepSpy();
  const pick = (url) => (url.includes('pn=3') ? shortPage : url.includes('pn=2') ? pageB : pageA);
  const jobs = await scanPracujSearch(
    { keyword: 'python', maxPages: 5 },
    { fetchPage: async (url) => ({ nextData: pick(url), dumped: '' }), sleepImpl, jitterImpl: (ms) => ms },
  );
  assert.strictEqual(jobs.length, 50 + 50 + 1);
  assert.strictEqual(jobs.incomplete, undefined, 'a short final page is a natural end, not a cap');
  assert.strictEqual(calls.length, 2, 'paced between pages, not before page 1');
});

test('scanPracujSearch stops at maxPages and marks the read partial', async () => {
  const pageA = fullPageFixture('a');
  const pageB = fullPageFixture('b');
  const jobs = await scanPracujSearch(
    { keyword: 'python', maxPages: 2 },
    {
      fetchPage: async (url) => ({ nextData: url.includes('pn=2') ? pageB : pageA, dumped: '' }),
      sleepImpl: sleepSpy().sleepImpl,
      jitterImpl: (ms) => ms,
    },
  );
  assert.strictEqual(jobs.length, 100);
  assert.strictEqual(jobs.incomplete, true, 'a full page at the cap means the board could have more');
});

test('scanPracujSearch keeps pages already read when a deeper page fails', async () => {
  const pageA = fullPageFixture('a');
  let page = 0;
  const jobs = await scanPracujSearch(
    { keyword: 'python', maxPages: 5 },
    {
      fetchPage: async () => {
        page++;
        if (page >= 2) throw new PracujRenderError('https://www.pracuj.pl/praca/python', 'payload missing');
        return { nextData: pageA, dumped: '' };
      },
      sleepImpl: sleepSpy().sleepImpl,
      jitterImpl: (ms) => ms,
    },
  );
  assert.strictEqual(jobs.length, 50, 'page 1 stands');
  assert.strictEqual(jobs.incomplete, true);
  assert.ok(jobs.error instanceof PracujRenderError);
});

test('scanPracujSearch propagates a page-1 failure to the caller', async () => {
  await assert.rejects(
    scanPracujSearch(
      { keyword: 'python', maxPages: 5 },
      { fetchPage: async () => { throw new PracujChallengeError('https://www.pracuj.pl/praca/python'); } },
    ),
    PracujChallengeError,
  );
});

test('scanPracujSearch ends the walk when a page yields nothing new', async () => {
  const pageA = fullPageFixture('a');
  let fetches = 0;
  const jobs = await scanPracujSearch(
    { keyword: 'python', maxPages: 5 },
    {
      // The board re-serves the same 50 rows (its own "repeated page" stop shape).
      fetchPage: async () => { fetches++; return { nextData: pageA, dumped: '' }; },
      sleepImpl: sleepSpy().sleepImpl,
      jitterImpl: (ms) => ms,
    },
  );
  assert.strictEqual(jobs.length, 50);
  assert.strictEqual(fetches, 2, 'page 1 + one repeat, then the walk ends');
  assert.notStrictEqual(jobs.incomplete, true);
});

test('loadSearches validates and clamps', () => {
  assert.deepStrictEqual(loadSearches({ pracuj_searches: ['python', { keyword: ' data engineer ', max_pages: 99 }] }), [
    { keyword: 'python', maxPages: DEFAULT_MAX_PAGES },
    { keyword: 'data engineer', maxPages: MAX_PAGES_CAP },
  ]);
  assert.throws(() => loadSearches({ pracuj_searches: [{ max_pages: 2 }] }), /keyword.*required/);
  assert.throws(() => loadSearches({ pracuj_searches: [null] }), /keyword.*required/);
  assert.deepStrictEqual(loadSearches({}), []);
});

test('the scanner is registered as a portals.yml top-level config key', () => {
  // Mirrors scan-topdev.test.mjs: a scan section a verify-portals run must know.
  assert.ok(PORTAL_TOP_LEVEL_KEYS.includes('pracuj_searches'), 'pracuj_searches must be in validate-portals PORTAL_TOP_LEVEL_KEYS');
});

test('the CLI rejects unknown flags before it can scan', () => {
  // validateFlags runs before main(), so this needs no network and touches no browser.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scan-pracuj.mjs', import.meta.url)), '--headless'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.strictEqual(result.status, 1, describeSpawn(result));
});

test('resolveLightpandaBin honours the PRACUJ_LIGHTPANDA override', () => {
  const prev = process.env.PRACUJ_LIGHTPANDA;
  try {
    process.env.PRACUJ_LIGHTPANDA = '/usr/local/bin/lightpanda-test';
    assert.strictEqual(resolveLightpandaBin(), '/usr/local/bin/lightpanda-test');
  } finally {
    if (prev === undefined) delete process.env.PRACUJ_LIGHTPANDA;
    else process.env.PRACUJ_LIGHTPANDA = prev;
  }
});

test('jitteredDelayMs is within [base, 2*base) and 0 when disabled', () => {
  for (let i = 0; i < 50; i++) {
    const d = jitteredDelayMs(6000);
    assert.ok(d >= 6000 && d < 12_000, `expected [6000, 12000), got ${d}`);
  }
  assert.strictEqual(jitteredDelayMs(0), 0);
  assert.strictEqual(jitteredDelayMs(-5), 0);
});
