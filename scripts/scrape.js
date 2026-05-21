#!/usr/bin/env node
/**
 * scrape.js  —  Faculty Job Tracker  —  v2
 *
 * Strategy
 * --------
 * For each institute, start at the homepage and crawl up to MAX_HOPS deep,
 * staying strictly within the institute's own domain. At every hop, links are
 * scored by how recruitment-relevant their anchor text and href text look, and
 * only the most promising ones are followed. When a page is fetched it is read
 * in full and run through a multi-step filter:
 *
 *   1. Link scoring  — should we even queue this link?
 *   2. Inclusion gate — does the full page text contain at least one rank term
 *      AND at least one target-department term AND at least one inclusion phrase?
 *   3. Exclusion check — is the page dominated by excluded categories with no
 *      rank signal?
 *   4. Closed signal — does the page say the posting is expired/closed?
 *   5. Sentence verification — read every sentence. Collect only sentences that
 *      contain a rank term. Then check that at least one sentence on the page
 *      also contains a department term. Both must appear on the page, though
 *      not necessarily in the same sentence (per your confirmed preference).
 *   6. Deadline and mode extraction.
 *   7. Confidence scoring.
 *
 * Run:  node scripts/scrape.js
 * Deps: none (pure Node.js built-ins only)
 */

import fs   from "fs";
import path from "path";
import http  from "http";
import https from "https";
import { fileURLToPath } from "url";

// pdf-parse is an optional dependency for reading PDF recruitment notices.
// Install with: npm install pdf-parse
// If not installed, PDF links are skipped gracefully.
let pdfParse = null;
try {
  const mod = await import("pdf-parse/lib/pdf-parse.js");
  pdfParse = mod.default || mod;
} catch {
  // PDF support disabled — pdf-parse not installed
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const SOURCES   = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "sources.json"), "utf8"));
const OUT_PATH       = path.join(ROOT, "data", "jobs.json");
const DISMISSED_PATH = path.join(ROOT, "data", "dismissed.json");

// Load dismissed URLs — permanently hidden from site and skipped by scraper.
// To restore a listing, remove it from data/dismissed.json and re-run.
function loadDismissed() {
  try {
    const raw     = fs.readFileSync(DISMISSED_PATH, "utf8");
    const entries = JSON.parse(raw).dismissed || [];
    const urls    = new Set(entries.map(d => d.url).filter(Boolean));
    const ids     = new Set(entries.map(d => d.id).filter(Boolean));
    return { urls, ids };
  } catch {
    return { urls: new Set(), ids: new Set() };
  }
}
const DISMISSED      = loadDismissed();
const DISMISSED_URLS = DISMISSED.urls;
const DISMISSED_IDS  = DISMISSED.ids;

// ─── Config from sources.json ────────────────────────────────────────────────

const CFG             = SOURCES.crawler;
const MAX_HOPS        = CFG.max_hops;               // 3
const DELAY_MS        = CFG.request_delay_ms;       // 1200
const TIMEOUT_MS      = CFG.timeout_ms;             // 15000
const MAX_BODY_BYTES  = CFG.max_body_bytes;          // 2 MB
const MAX_PAGES       = CFG.max_pages_per_institute; // 40

const REC_PATTERNS  = CFG.recruitment_link_patterns.map(s => s.toLowerCase());
const SKIP_PATTERNS = CFG.skip_link_patterns.map(s => s.toLowerCase());

const RANKS      = SOURCES.target_ranks;                     // lowercase already
const DEPT_MAP   = buildDeptMap(SOURCES.target_departments); // phrase → familyKey
const INCL_KW    = SOURCES.inclusion_keywords.map(s => s.toLowerCase());
const EXCL_KW    = SOURCES.exclusion_keywords.map(s => s.toLowerCase());
const CLOSED_SIG = [
  ...SOURCES.closed_signals.map(s => s.toLowerCase()),
  // Verified on real IIT/NIT pages:
  "(closed)",                                    // IIT Guwahati inline label
  "online application is closed",               // IIT Madras 2025 cycle
  "portal is closed",
  "application is closed",
  "applications are closed",
  "last date has passed",
  "no vacancy",
  "post has been filled",
  "no advertisements found",                    // NIT Rourkela
  "list of selected candidates for faculty",    // process completed
  "applications for special recruitment drive is closed", // IIT Dharwad
  "recruitment process is over",
  "applications are no longer being accepted",
];

const DEADLINE_ONLY_CLOSED_SIG = new Set([
  "last date of submission of applications is",
]);

const DEPT_DISPLAY = {
  electrical_engineering:   "Electrical Engineering",
  electronics_communication:"Electronics & Communication Engineering",
  computer_science:         "Computer Science & Engineering",
};

function buildDeptMap(deptObj) {
  const map = {};
  for (const [family, synonyms] of Object.entries(deptObj)) {
    for (const syn of synonyms) map[syn.toLowerCase()] = family;
  }
  return map;
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; FacultyJobTracker/2.0; educational index bot)",
  "Accept":     "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.7",
  "Connection": "keep-alive",
};

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(setCookieHeaders) {
    const values = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const value of values.filter(Boolean)) {
      const [pair] = value.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function fetchPage(url, redirectsLeft = 4, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const headers = {
      ...HEADERS,
      ...(options.headers || {}),
    };
    if (options.cookieJar?.header()) headers.Cookie = options.cookieJar.header();
    const req = proto.request(url, {
      headers,
      timeout: TIMEOUT_MS,
      method: options.method || "GET",
    }, (res) => {
      options.cookieJar?.store(res.headers["set-cookie"]);
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        if (redirectsLeft === 0) { reject(new Error("Too many redirects")); return; }
        const next = new URL(res.headers.location, url).href;
        res.resume();
        resolve(fetchPage(next, redirectsLeft - 1, options));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ct = (res.headers["content-type"] || "").toLowerCase();
      const expected = options.expectedContent || ["html", "text"];
      if (!expected.some(token => ct.includes(token))) {
        res.resume();
        reject(new Error(`Unexpected content-type: ${ct}`));
        return;
      }
      res.setEncoding("utf8");
      let body  = "";
      let bytes = 0;
      res.on("data", chunk => {
        bytes += Buffer.byteLength(chunk, "utf8");
        body  += chunk;
        if (bytes >= MAX_BODY_BYTES) res.destroy();
      });
      res.on("end",   () => resolve(body));
      res.on("close", () => resolve(body));  // destroyed early → still return what we have
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
    req.end();
  });
}

// ─── PDF fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch a PDF URL and extract its text using pdf-parse.
 * Returns plain text string, or null if pdf-parse is not available or fetch fails.
 */
async function fetchPdfText(url, redirectsLeft = 4) {
  if (!pdfParse) return null;
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: { ...HEADERS, Accept: 'application/pdf,*/*' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        if (redirectsLeft === 0) { res.resume(); resolve(null); return; }
        const next = new URL(res.headers.location, url).href;
        res.resume();
        resolve(fetchPdfText(next, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const ct = (res.headers['content-type'] || '').toLowerCase();
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        chunks.push(chunk);
        if (bytes > MAX_BODY_BYTES) res.destroy();
      });
      res.on('end',   () => {
        const buf = Buffer.concat(chunks);
        if (!ct.includes('pdf') && looksLikeHtml(buf)) {
          const embedded = extractEmbeddedPdfUrl(buf.toString('utf8'), url);
          if (embedded && embedded !== url) {
            resolve(fetchPdfText(embedded, redirectsLeft - 1));
            return;
          }
          resolve(null);
          return;
        }
        pdfParse(buf)
          .then(data => resolve(data.text || null))
          .catch(() => resolve(null));
      });
      res.on('close', () => {
        const buf = Buffer.concat(chunks);
        if (!ct.includes('pdf') && looksLikeHtml(buf)) {
          const embedded = extractEmbeddedPdfUrl(buf.toString('utf8'), url);
          if (embedded && embedded !== url) {
            resolve(fetchPdfText(embedded, redirectsLeft - 1));
            return;
          }
          resolve(null);
          return;
        }
        pdfParse(buf)
          .then(data => resolve(data.text || null))
          .catch(() => resolve(null));
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
  });
}

function looksLikeHtml(buf) {
  return buf.slice(0, 512).toString('utf8').toLowerCase().includes('<html');
}

function extractEmbeddedPdfUrl(html, baseUrl) {
  const re = /<(?:embed|iframe)[^>]+src=["']([^"']+pdf[^"']*)["']/i;
  const m = html.match(re);
  if (!m) return null;
  try {
    return new URL(m[1].replace(/&amp;/g, '&'), baseUrl).href;
  } catch {
    return null;
  }
}

// ─── HTML utilities ───────────────────────────────────────────────────────────

/** Decode HTML entities and strip tags, returning readable plain text. */
function toText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi,   " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|section|article|header|footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi,  "&")
    .replace(/&lt;/gi,   "<")
    .replace(/&gt;/gi,   ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]+/g, " ")
    .trim();
}

function toAnalysisText(html) {
  return toText(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, " "));
}

/**
 * Extract all href links from raw HTML. Returns array of { href, anchorText }.
 * Only keeps absolute or root-relative links; resolves relative ones against base.
 */
function extractLinks(html, baseUrl) {
  const links = [];
  const re    = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw    = m[1].trim();
    const anchor = toText(m[2]).trim().toLowerCase();
    try {
      const abs = new URL(raw, baseUrl).href;
      // Strip fragment
      const clean = abs.split("#")[0];
      links.push({ href: clean, anchorText: anchor });
    } catch { /* malformed URL — skip */ }
  }
  return links;
}

function extractDynamicDataUrls(html, baseUrl) {
  const urls = new Set();
  const re = /data-url=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      urls.add(new URL(m[1].trim(), baseUrl).href);
    } catch { /* malformed data-url skipped */ }
  }
  return [...urls];
}

async function fetchDynamicTableText(html, baseUrl, allDomains, cookieJar) {
  const rows = [];
  const parts = [];
  for (const endpoint of extractDynamicDataUrls(html, baseUrl)) {
    if (!isAllowedDomain(endpoint, allDomains)) continue;
    try {
      const body = await fetchPage(endpoint, 4, {
        cookieJar,
        method: "POST",
        expectedContent: ["json", "text"],
        headers: {
          "Accept": "application/json, text/javascript, */*;q=0.8",
          "Referer": baseUrl,
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      const json = JSON.parse(body);
      const jsonRows = Array.isArray(json) ? json : (Array.isArray(json.rows) ? json.rows : []);
      for (const row of jsonRows) {
        if (!row || typeof row !== "object") continue;
        rows.push(row);
        parts.push(Object.values(row).filter(v => v != null).join(" "));
      }
    } catch (err) {
      console.log(`    [dynamic-err] ${endpoint.replace(baseUrl, "")} — ${err.message}`);
    }
  }
  return { text: parts.join("\n"), rows };
}

// ─── Link scoring ─────────────────────────────────────────────────────────────

/**
 * Returns a priority score for a link based on how recruitment-relevant it looks.
 * Higher is better. Returns -1 to suppress the link entirely.
 */
function scoreLinkRelevance(href, anchorText, allDomains, institute = {}) {
  const hLow = href.toLowerCase();
  const aLow = anchorText.toLowerCase();

  // Must stay on an allowed domain for this institute
  if (!isAllowedDomain(href, allDomains)) return -1;

  // Hard skip patterns — if any match, drop immediately
  // Exception: .pdf is in the skip list to avoid random PDFs, but we allow
  // PDFs that look recruitment-relevant (anchor or href contains a recruitment word)
  const isPdf = hLow.endsWith('.pdf');
  const skipPatterns = [...SKIP_PATTERNS, ...(institute.link_skip_patterns || [])];
  for (const pat of skipPatterns) {
    if (pat === '.pdf') continue;  // handled separately below
    if (pat === 'displaypage.aspx' && hasStrongRecruitmentAnchor(aLow, hLow)) continue;
    if (pat === 'rti') {
      if (isRtiUrl(href)) return -1;
      continue;
    }
    if (matchesSkipPattern(href, pat) || aLow.includes(pat)) return -1;
  }
  if (isPdf) {
    const hasRecruitSignal = hasStrongRecruitmentAnchor(aLow, hLow);
    return hasRecruitSignal ? 8 : -1;
  }

  let score = 0;

  // Bonus for recruitment patterns in href or anchor text
  for (const pat of REC_PATTERNS) {
    if (hLow.includes(pat)) score += 3;
    if (aLow.includes(pat)) score += 2;
  }

  // Strong bonus for explicit rank terms in anchor text
  for (const rank of RANKS) {
    if (aLow.includes(rank)) score += 5;
  }

  // Mild penalty for very long query strings (dynamic pages less likely to be useful)
  if ((href.match(/[&?]/g) || []).length > 4) score -= 2;

  return score;
}

function isRtiUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\/|[-_])rti($|\/|[-_])/.test(u.pathname.toLowerCase());
  } catch {
    return false;
  }
}

function hasStrongRecruitmentAnchor(anchorText, hrefText) {
  const combined = `${anchorText} ${hrefText}`.toLowerCase();
  const hasFaculty = combined.includes("faculty");
  const hasProfessor = /\b(professor|prof|associate|assistant)\b|\bap[-_ ]?\d/.test(combined);
  const hasRecruit = /\b(recruitment|recruit|rolling|advertisement|advt|position|vacancy|application)\b/.test(combined);
  const hasRank = RANKS.some(rank => combined.includes(rank));
  return (hasFaculty && hasRecruit) || (hasProfessor && hasRecruit) || hasRank;
}

function isAllowedDomain(url, allDomains) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return allDomains.some(domain => {
      const clean = domain.toLowerCase().replace(/^www\./, "");
      return host === clean || host.endsWith(`.${clean}`);
    });
  } catch {
    return false;
  }
}

function matchesSkipPattern(url, pattern) {
  const lowPattern = pattern.toLowerCase();
  const lowUrl = url.toLowerCase();

  if (lowPattern.endsWith("$")) {
    try {
      const pathOnly = new URL(lowUrl).pathname.replace(/\/$/, "");
      const suffix = lowPattern.slice(0, -1).replace(/\/$/, "");
      return pathOnly.endsWith(suffix);
    } catch {
      return lowUrl.endsWith(lowPattern.slice(0, -1));
    }
  }

  return lowUrl.includes(lowPattern);
}

// ─── Text analysis ────────────────────────────────────────────────────────────

/** Split text into sentences on common terminal punctuation or newlines. */
function toSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|[\n\r]+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

function textContains(text, phrase) {
  return text.toLowerCase().includes(phrase);
}

function anyContains(text, phrases) {
  const low = text.toLowerCase();
  return phrases.some(p => low.includes(p));
}

/** Returns true if rank terms appear on the page but only alongside excluded
 *  categories, with no genuine faculty opening signal. */
function isExclusionDominated(text) {
  const low = text.toLowerCase();
  const hasRank = RANKS.some(r => low.includes(r));
  if (!hasRank) return true;  // no rank term at all → suppress

  const exclCount = EXCL_KW.filter(k => low.includes(k)).length;
  const inclCount = INCL_KW.filter(k => low.includes(k)).length;
  // If exclusion terms are heavy and inclusion terms are absent, suppress
  if (exclCount >= 3 && inclCount === 0) return true;
  return false;
}

function isClosedPage(text) {
  const low = text.toLowerCase();
  return CLOSED_SIG.some(sig => {
    if (DEADLINE_ONLY_CLOSED_SIG.has(sig)) return false;
    return low.includes(sig);
  });
}

// ─── Department detection ─────────────────────────────────────────────────────

function detectDepartments(text, options = {}) {
  const low   = text.toLowerCase();
  const found = new Set();
  for (const [phrase, family] of Object.entries(DEPT_MAP)) {
    if (low.includes(phrase)) found.add(family);
  }
  if (found.size === 0 && Array.isArray(options.assumeDepartmentFamilies) && /\b(various|all)\s+(academic\s+units|departments|faculty\s+positions?)\b/.test(low)) {
    for (const family of options.assumeDepartmentFamilies) found.add(family);
  }
  if (found.size === 0 && options.assumeAllTargetDepartments && /\b(various|all)\s+faculty\s+positions?\b/.test(low)) {
    for (const family of new Set(Object.values(DEPT_MAP))) found.add(family);
  }
  return [...found];
}

// ─── Rank detection ───────────────────────────────────────────────────────────

function detectRanks(text) {
  const low   = text.toLowerCase();
  const found = [];
  const lead = low.slice(0, 2500);
  if (/for\s+the\s+post\s+of\s+associate\s+professor\s+and\s+professor/.test(lead)) {
    return ["Associate Professor"];
  }
  if (/for\s+the\s+post\s+of\s+assistant\s+professor/.test(lead)) {
    return ["Assistant Professor"];
  }
  if (low.includes("assistant professor")) found.push("Assistant Professor");
  if (low.includes("associate professor")) found.push("Associate Professor");
  return found;
}

// ─── Deadline parsing ─────────────────────────────────────────────────────────

const MONTH_IDX = {
  january:0, february:1, march:2, april:3, may:4, june:5,
  july:6, august:7, september:8, october:9, november:10, december:11,
  jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7,
  sep:8, oct:9, nov:10, dec:11,
};

// Words that, when found near a date, indicate that date is a genuine deadline.
// A date appearing without any of these nearby is likely a "last updated",
// a footer copyright year, or an unrelated event date — not a closing deadline.
const DEADLINE_CONTEXT_WORDS = [
  "last date",
  "closing date",
  "close date",
  "apply by",
  "apply on or before",
  "apply before",
  "deadline",
  "on or before",
  "last day",
  "due date",
  "submission date",
  "application deadline",
  "applications must be received",
  "applications should reach",
  "last date for",
  "applications close",
  "closing on",
  "closes on",
  "open till",
  "open until",
  "valid till",
  "valid until",
  "upto",
  "up to",
];

// How many characters around a date we look for context words.
// 200 chars covers roughly 2-3 sentences before/after the date.
const CONTEXT_WINDOW = 200;

function parseDeadline(text) {
  const candidates = findDeadlineDates(text)
    .filter(dt => !isPastDate(dt));

  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);
  return candidates[0].toISOString().split("T")[0];
}

function hasExpiredDeadline(text) {
  const candidates = findDeadlineDates(text);
  return candidates.length > 0 && candidates.every(isPastDate);
}

function isPastDate(dt) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dt.getTime() < today.getTime();
}

function findDeadlineDates(text) {
  const candidates = [];

  // Validate a date. Past dates are retained so expired pages can be rejected.
  const makeDate = (y, m, d) => {
    const yi = +y, mi = +m, di = +d;
    if (mi < 0 || mi > 11) return null;
    if (di < 1 || di > 31) return null;
    if (yi < 2020 || yi > 2035) return null;
    const dt = new Date(Date.UTC(yi, mi, di, 12, 0, 0));
    if (dt.getUTCMonth() !== mi) return null;  // month overflow check
    return dt;
  };

  // Check whether a date at position `index` in the text has deadline context
  // within CONTEXT_WINDOW characters before or after it.
  const hasDeadlineContext = (index, matchLength) => {
    const start  = Math.max(0, index - CONTEXT_WINDOW);
    const end    = Math.min(text.length, index + matchLength + CONTEXT_WINDOW);
    const window = text.slice(start, end).toLowerCase();
    return DEADLINE_CONTEXT_WORDS.some(word => window.includes(word));
  };

  // ── Pattern 1: DD/MM/YYYY, DD-MM-YYYY, or DD.MM.YYYY ──
  for (const m of text.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})\b/g)) {
    if (!hasDeadlineContext(m.index, m[0].length)) continue;
    const dt = makeDate(m[3], +m[2] - 1, +m[1]);  // DD/MM/YYYY
    if (dt) candidates.push(dt);
  }

  // ── Pattern 2: YYYY-MM-DD ──
  for (const m of text.matchAll(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g)) {
    if (!hasDeadlineContext(m.index, m[0].length)) continue;
    const dt = makeDate(m[1], +m[2] - 1, +m[3]);
    if (dt) candidates.push(dt);
  }

  // ── Pattern 3: DD Month YYYY  (e.g. "30 April 2025", "30 Apr 2025") ──
  const re3 = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(20\d{2})\b/gi;
  for (const m of text.matchAll(re3)) {
    if (!hasDeadlineContext(m.index, m[0].length)) continue;
    const mi = MONTH_IDX[m[2].toLowerCase()];
    if (mi === undefined) continue;
    const dt = makeDate(m[3], mi, +m[1]);
    if (dt) candidates.push(dt);
  }

  // ── Pattern 4: Month DD, YYYY  (e.g. "April 30, 2025") ──
  const re4 = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?[,\s]+(20\d{2})\b/gi;
  for (const m of text.matchAll(re4)) {
    if (!hasDeadlineContext(m.index, m[0].length)) continue;
    const mi = MONTH_IDX[m[1].toLowerCase()];
    if (mi === undefined) continue;
    const dt = makeDate(m[3], mi, +m[2]);
    if (dt) candidates.push(dt);
  }

  return candidates;
}

function isRolling(text) {
  const low = text.toLowerCase();
  return (
    // Exact phrases verified on real IIT/NIT pages:
    low.includes("rolling basis") ||
    low.includes("rolling advertisement") ||
    low.includes("rolling advt") ||
    low.includes("rolling recruitment") ||
    low.includes("this is a rolling") ||                          // IIT Bombay, MNNIT
    low.includes("applications will be processed periodically") || // IIT Bombay
    low.includes("applications are accepted throughout the year") || // IIT Gandhinagar
    low.includes("throughout the year") ||
    low.includes("there is no last date") ||                      // IIT Bombay Physics
    low.includes("no last date for applications") ||              // IIT Bombay
    low.includes("no specific last date") ||                      // NIT Warangal
    low.includes("regular drive is opened") ||                    // IIT Dharwad
    low.includes("regular drive (rolling") ||                     // IIT Dharwad
    low.includes("when a sizable number of applications") ||      // NIT Warangal
    low.includes("cutoff date will be announced") ||              // NIT Warangal
    low.includes("standing advertisement") ||                     // IIT Patna
    low.includes("open on rolling") ||
    low.includes("open until filled") ||
    low.includes("until the position is filled") ||
    low.includes("applications are reviewed on a rolling") ||
    low.includes("applications will be reviewed") ||
    low.includes("invites applications on a rolling") ||
    low.includes("positions are open on") ||
    low.includes("faculty positions are open") ||
    low.includes("processed periodically") ||
    low.includes("processed in batches") ||
    low.includes("applications will be accepted online throughout")
  );
}

function isOpenEndedRolling(text) {
  const low = text.toLowerCase();
  return (
    low.includes("throughout the year") ||
    low.includes("there is no last date") ||
    low.includes("no last date for applications") ||
    low.includes("no specific last date") ||
    low.includes("applications will be processed periodically") ||
    low.includes("applications are accepted throughout the year") ||
    low.includes("applications will be accepted online throughout") ||
    low.includes("open until filled") ||
    low.includes("until the position is filled")
  );
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

function scoreConfidence({ hasRank, deptCount, hasDeadline, rolling, inclCount }) {
  let s = 0;
  if (hasRank)      s += 3;
  if (deptCount > 0) s += 2;
  if (hasDeadline || rolling) s += 2;
  if (inclCount >= 2) s += 1;
  if (s >= 7) return "high";
  if (s >= 4) return "medium";
  return "low";
}

// ─── Per-institute crawler ────────────────────────────────────────────────────

/**
 * BFS crawl from homepage up to MAX_HOPS.
 *
 * Queue entries: { url, depth }
 * On each page:
 *   - Extract all links, score them, add promising ones to the queue
 *   - Run analysis on the page itself
 *
 * Returns the best matching page (highest score) or null.
 */
async function crawlInstitute(institute) {
  // extra_domains lets specific institutes crawl related subdomains
  // e.g. IIT Madras: facapp.iitm.ac.in for the application portal
  const allDomains = [institute.domain, ...(institute.extra_domains || [])];
  const { id, name, homepage, domain } = institute;
  const checkedAt = new Date().toISOString();

  const visited = new Set();
  // { url, depth, score } — scored during link extraction so BFS is priority-aware
  const seedUrls = [homepage, ...(institute.seed_urls || [])];
  const queue    = seedUrls.map(u => ({ url: u, depth: 0, linkScore: 100 }));
  const cookieJar = new CookieJar();
  let   pagesVisited = 0;

  // Accumulate all confirmed findings across pages
  const confirmedJobs = new Map();
  let   bestUrl   = null;
  let   bestDeadline = null;
  let   rolling   = false;
  let   advertDate = null;   // published date of the advertisement e.g. "Dated 27.02.2026"
  let   inclCount = 0;
  let   anyConfirmed = false;

  while (queue.length > 0 && pagesVisited < MAX_PAGES) {
    // Sort queue by score descending so best candidates are visited first
    queue.sort((a, b) => b.linkScore - a.linkScore);
    const { url, depth } = queue.shift();

    if (visited.has(url)) continue;
    visited.add(url);
    pagesVisited++;

    // Polite delay
    await sleep(DELAY_MS);

    // ── Determine if this is a PDF or HTML page ──
    const isPdfUrl = url.toLowerCase().endsWith('.pdf');
    let html = null;
    let text = '';

    if (isPdfUrl) {
      if (!pdfParse) {
        console.log(`    [skip-pdf] ${url} — pdf-parse not installed`);
        continue;
      }
      const pdfText = await fetchPdfText(url);
      if (!pdfText) {
        console.log(`    [fetch-err] ${url} — PDF extraction failed`);
        continue;
      }
      text = pdfText;
      console.log(`    [pdf] ${url.replace(homepage,'')} — extracted ${text.length} chars`);
    } else {
      try {
        html = await fetchPage(url, 4, { cookieJar });
      } catch (err) {
        console.log(`    [fetch-err] ${url} — ${err.message}`);
        continue;
      }
      text = toAnalysisText(html);
      const dynamic = await fetchDynamicTableText(html, url, allDomains, cookieJar);
      if (dynamic.text) {
        text += `\n${dynamic.text}`;
        console.log(`    [dynamic] ${url.replace(homepage, "")||"/"} — ${dynamic.rows.length} row(s)`);
      }
    }

    // ── Gate 1: page must have rank + active-intake phrase + department ──
    // Requiring all three prevents false positives from general faculty pages
    // or archived notices that mention ranks but have no live opening language.
    const skipAnalysis = (institute.analysis_skip_patterns || [])
      .some(pattern => url.toLowerCase().includes(pattern.toLowerCase()));
    const pageHasRank = !skipAnalysis && RANKS.some(r => textContains(text, r));
    const pageHasIncl = anyContains(text, INCL_KW);
    const deptOptions = {
      assumeAllTargetDepartments: !!institute.assume_all_target_departments,
      assumeDepartmentFamilies: institute.assume_department_families || [],
    };
    const pageHasDept = detectDepartments(text, deptOptions).length > 0;
    const worthAnalysing = pageHasRank && pageHasIncl && pageHasDept;

    if (worthAnalysing) {
      // ── Gate 2: exclusion dominance ──
      if (!isExclusionDominated(text)) {
        const ranksFound = detectRanks(text);
        const deptsFound = detectDepartments(text, deptOptions);
        const ic = INCL_KW.filter(k => textContains(text, k)).length;

        const isHomepage = url.replace(/\/$/, "") === homepage.replace(/\/$/, "");
        if (ranksFound.length > 0 && deptsFound.length > 0 && !isHomepage) {
          // Rolling detection runs first. If the page says rolling basis,
          // a nearby date is often context and not a closing deadline.
          const pr = isRolling(text);
          const pd = parseDeadline(text);
          const onlyExpiredDeadline = !pd && hasExpiredDeadline(text);
          const closed =
            (!pd && isClosedPage(text)) ||
            (!pr && onlyExpiredDeadline) ||
            (pr && onlyExpiredDeadline && !isOpenEndedRolling(text) && !institute.force_rolling);

          if (!closed && (pr || pd)) {
            anyConfirmed = true;
            for (const rank of ranksFound) {
              for (const deptFamily of deptsFound) {
                confirmedJobs.set(`${rank}|${deptFamily}`, { rank, deptFamily });
              }
            }

            if (!bestUrl || ic > inclCount) {
              bestUrl   = url;
              inclCount = ic;
            }
            if (pd) {
              if (!bestDeadline || pd < bestDeadline) bestDeadline = pd;
            }
            if (pr) rolling = true;
            // Capture "Dated DD.MM.YYYY" or "Dated DD/MM/YYYY" as advertisement date
            if (!advertDate) {
              const adm = text.match(/dated\s+(\d{1,2})[.\/](\d{1,2})[.\/](20\d{2})/i);
              if (adm) {
                const [,d,m,y] = adm;
                advertDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
              }
            }

            console.log(`    [match] ${url.replace(homepage, "")||"/"} — ranks: ${ranksFound.join(",")} depts: ${deptsFound.join(",")} rolling: ${pr} deadline: ${pd||"none"}`);
          } else {
            console.log(`    [closed] ${url.replace(homepage, "")||"/"}`);
          }
        }
      }
    }

    // ── Extract and enqueue child links (HTML only, not PDFs) ──
    if (depth < MAX_HOPS && html && !isPdfUrl) {
      const links = extractLinks(html, url);
      for (const { href, anchorText } of links) {
        if (visited.has(href)) continue;
        const s = scoreLinkRelevance(href, anchorText, allDomains, institute);
        if (s <= 0) continue;
        queue.push({ url: href, depth: depth + 1, linkScore: s });
      }
    }
  }

  if (!anyConfirmed) return null;

  const confirmedJobList = [...confirmedJobs.values()];
  const ranksArr = [...new Set(confirmedJobList.map(j => j.rank))];
  const deptsArr = [...new Set(confirmedJobList.map(j => j.deptFamily))];
  // Honour per-institute force_rolling override from sources.json
  if (institute.force_rolling) rolling = true;

  if (!rolling && !bestDeadline) {
    console.log(`  [gate4] ${name} — no rolling signal and no future deadline — suppressed`);
    return null;
  }

  const confidence = scoreConfidence({
    hasRank:     ranksArr.length > 0,
    deptCount:   deptsArr.length,
    hasDeadline: !!bestDeadline,
    rolling,
    inclCount,
  });

  // ── Gate 4: weak signal filter ───────────────────────────────────────────
  // Suppress if medium confidence with no deadline, no rolling, AND low inclusion count.
  // A page with 3+ strong inclusion keywords passes even without a deadline —
  // it is clearly a recruitment page (e.g. IIT Madras /careers/prospective-faculty).
  if (confidence === "medium" && !rolling && !bestDeadline && inclCount < 3) {
    console.log(`  [gate4] ${name} — medium conf, no deadline, no rolling, only ${inclCount} inclusion kw — suppressed`);
    return null;
  }
  if (confidence === "low") {
    console.log(`  [gate4] ${name} — low confidence — suppressed`);
    return null;
  }

  // Build flat job entries: one per rank × department
  const jobs = [];
  for (const { rank, deptFamily } of confirmedJobList) {
    jobs.push({
      rank,
      department:       DEPT_DISPLAY[deptFamily] || deptFamily,
      departmentFamily: deptFamily,
      deadline:         bestDeadline || null,
      rolling,
      applicationMode:  rolling    ? "Rolling basis"
                        : bestDeadline ? "Fixed deadline"
                        : "See official page",
      confidence,
      deadlineType: rolling && bestDeadline ? "rolling_cutoff" : (bestDeadline ? "application_deadline" : null),
      notes: confidence === "low" ? "Low confidence — verify manually on official page" : null,
    });
  }

  return {
    id,
    name,
    type: institute.instType,
    url:  institute.canonical_url || bestUrl || homepage,
    advertDate,
    status:    "active",
    checkedAt,
    pagesScanned: pagesVisited,
    jobs,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log(" Faculty Job Tracker — Scraper v2");
  console.log(` Started: ${new Date().toISOString()}`);
  console.log(`═══════════════════════════════════════════════\n`);

  const allInstitutes = [
    ...SOURCES.iits.map(i => ({ ...i, instType: "IIT" })),
    ...SOURCES.nits.map(i => ({ ...i, instType: "NIT" })),
  ];

  // Deduplicate by id (safety net)
  const seen    = new Set();
  const unique  = allInstitutes.filter(i => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
  const onlyIds = (process.env.SCRAPE_ONLY || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const crawlTargets = onlyIds.length
    ? unique.filter(i => onlyIds.includes(i.id))
    : unique;

  console.log(`Institutes to crawl: ${crawlTargets.length}\n`);

  const results = [];

  for (const institute of crawlTargets) {
    console.log(`\n→ ${institute.name}  (${institute.homepage})`);
    let result;
    try {
      result = await crawlInstitute(institute);
    } catch (err) {
      console.warn(`  [FATAL] ${institute.name}: ${err.message}`);
      result = null;
    }

    if (result && result.jobs.length > 0) {
      // Filter out dismissed entries by URL or institute id
      const isDismissed = DISMISSED_URLS.has(result.url) || DISMISSED_IDS.has(result.id);
      if (isDismissed) {
        console.log(`  [dismissed] ${result.url} — skipped (in dismissed.json)`);
      } else {
        console.log(`  ✓ ${result.jobs.length} job(s) confirmed | confidence: ${result.jobs[0]?.confidence} | pages scanned: ${result.pagesScanned}`);
        results.push(result);
      }
    } else {
      console.log(`  — No confirmed openings found`);
    }
  }

  const output = {
    generatedAt:  new Date().toISOString(),
    totalActive:  results.length,
    scraper:      "v2 — homepage crawl, 3-hop depth",
    results,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n${"═".repeat(47)}`);
  console.log(` Done. ${results.length} institute(s) with confirmed openings.`);
  console.log(` Output → ${OUT_PATH}`);
  console.log(`${"═".repeat(47)}\n`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
