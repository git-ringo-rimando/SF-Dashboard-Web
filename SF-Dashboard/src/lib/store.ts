import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

const ALGORITHM = "aes-256-gcm";
const SECRET = crypto
  .createHash("sha256")
  .update(process.env.CREDS_SECRET ?? "sf-dashboard-app-secret")
  .digest();

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

function decrypt(encoded: string): string {
  const [ivHex, tagHex, encHex] = encoded.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, SECRET, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// Sanitize username for use as a directory name / Redis key segment
function sanitize(username: string): string {
  return username.replace(/[^a-zA-Z0-9@._-]/g, "_").slice(0, 100);
}

// ── Per-user file paths ───────────────────────────────────────────────────────

function userDir(username: string)      { return path.join(DATA_DIR, sanitize(username)); }
function credsFile(username: string)    { return path.join(userDir(username), "credentials.enc"); }
function cacheFile(username: string)    { return path.join(userDir(username), "cache.json"); }
function tagsFile(username: string)     { return path.join(userDir(username), "tags.json"); }
function progressFile(username: string) { return path.join(userDir(username), "progress.json"); }

function writeLocal(file: string, content: string): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

// ── Credentials ───────────────────────────────────────────────────────────────

export interface Credentials {
  username: string;
  password: string;
  memberId?: string;
  cookie?: string;
  token?: string;
}

export async function saveCredentials(username: string, password: string, memberId?: string, cookie?: string, token?: string): Promise<void> {
  const encrypted = encrypt(JSON.stringify({ username, password, memberId, cookie, token }));
  writeLocal(credsFile(username), encrypted);
  await redisSet(`sf:creds:${sanitize(username)}`, encrypted, 90 * 86400);
}

export async function loadCredentials(username: string): Promise<Credentials | null> {
  const file = credsFile(username);
  if (fs.existsSync(file)) {
    try { return JSON.parse(decrypt(fs.readFileSync(file, "utf8"))); } catch {}
  }
  const raw = await redisGet(`sf:creds:${sanitize(username)}`);
  if (!raw) return null;
  try {
    const creds = JSON.parse(decrypt(raw)) as Credentials;
    writeLocal(file, raw);
    return creds;
  } catch {
    return null;
  }
}

export async function hasCredentials(username: string): Promise<boolean> {
  if (fs.existsSync(credsFile(username))) return true;
  return !!(await redisGet(`sf:creds:${sanitize(username)}`));
}

// ── Data shapes ──────────────────────────────────────────────────────────────

export interface TicketRow {
  documentNo: string;
  project: string;
  type: string;
  status: string;
  reportedDate: string;
}

export interface ModuleRow {
  module: string;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  open: number;
  responded: number;
  reopen: number;
  fixed: number;
  closed: number;
  cancelled: number;
}

export interface SeverityRow {
  severity: string;
  open: number;
  responded: number;
  reopen: number;
  fixed: number;
  closed: number;
  cancelled: number;
}

export interface RecentTicket {
  task: string;
  ticketNo: string;
  createdDate: string;
  reportedDate: string;
  fixedDate: string;
  project: string;
  module: string;
  subject: string;
  severity: string;
  completion: string;
  status: string;
}

export interface DashboardCache {
  scrapedAt: string;
  error: string | null;
  totals: {
    all: number;
    open: number;
    responded: number;
    reopen: number;
    fixed: number;
    closed: number;
    cancelled: number;
    unresolved: number;
    unresponded: number;
  };
  statisticPeriod: string;
  partnerPeriod: string;
  unresolvedTickets: TicketRow[];
  unrespondedTickets: TicketRow[];
  moduleBreakdown: ModuleRow[];
  severityBreakdown: SeverityRow[];
  recentTickets: RecentTicket[];
}

// ── Upstash Redis (optional — only active when env vars are set) ──────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key: string): Promise<string | null> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      cache: "no-store",
    });
    const data = await res.json() as { result: string | null };
    return data.result ?? null;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: string, ttlSeconds = 86400): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(REDIS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, value, "EX", ttlSeconds]),
    });
  } catch {}
}

async function redisDel(...keys: string[]): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN || !keys.length) return;
  try {
    await fetch(REDIS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["DEL", ...keys]),
    });
  } catch {}
}

// ── Cache ────────────────────────────────────────────────────────────────────

// In-process cache keyed by username — skips disk on repeated /api/data polls.
const _cacheMemory = new Map<string, DashboardCache | null | undefined>();

export async function saveCache(data: DashboardCache, username: string): Promise<void> {
  _cacheMemory.set(username, data);
  const json = JSON.stringify(data);
  writeLocal(cacheFile(username), json);
  await redisSet(`sf:cache:${sanitize(username)}`, json);
}

export async function loadCache(username: string): Promise<DashboardCache | null> {
  const mem = _cacheMemory.get(username);
  if (mem !== undefined) return mem;

  const file = cacheFile(username);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as DashboardCache;
      _cacheMemory.set(username, data);
      return data;
    } catch {}
  }
  const raw = await redisGet(`sf:cache:${sanitize(username)}`);
  if (!raw) { _cacheMemory.set(username, null); return null; }
  try {
    const data = JSON.parse(raw) as DashboardCache;
    writeLocal(file, raw);
    _cacheMemory.set(username, data);
    return data;
  } catch {
    return null;
  }
}

// ── Tag storage ──────────────────────────────────────────────────────────────

export type ProductTag = "Sunfish 6" | "Sunfish 7" | "Greatday";
export type TagMap = Record<string, ProductTag>;

export async function saveTags(tags: TagMap, username: string): Promise<void> {
  const json = JSON.stringify(tags, null, 2);
  writeLocal(tagsFile(username), json);
  await redisSet(`sf:tags:${sanitize(username)}`, json, 90 * 86400);
}

export async function loadTags(username: string): Promise<TagMap> {
  const file = tagsFile(username);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  }
  const raw = await redisGet(`sf:tags:${sanitize(username)}`);
  if (!raw) return {};
  try {
    const tags = JSON.parse(raw) as TagMap;
    writeLocal(file, raw);
    return tags;
  } catch {
    return {};
  }
}

// ── Scrape progress ───────────────────────────────────────────────────────────

export interface ScrapeProgress {
  phase: string;
  current: number;
  total: number;
  startedAt: string;
}

export function saveProgress(p: ScrapeProgress, username: string): void {
  writeLocal(progressFile(username), JSON.stringify(p));
  redisSet(`sf:progress:${sanitize(username)}`, JSON.stringify(p), 3600).catch(() => {});
}

export function clearProgress(username: string): void {
  const file = progressFile(username);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  redisDel(`sf:progress:${sanitize(username)}`).catch(() => {});
}

export async function loadProgress(username: string): Promise<ScrapeProgress | null> {
  const file = progressFile(username);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  }
  const raw = await redisGet(`sf:progress:${sanitize(username)}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as ScrapeProgress; } catch { return null; }
}

// ── Sign-out ──────────────────────────────────────────────────────────────────

export async function clearAllData(username: string): Promise<void> {
  _cacheMemory.delete(username);
  const s = sanitize(username);
  // Tags are persistent user preferences — kept across sign-out/sign-in cycles
  for (const file of [credsFile(username), cacheFile(username), progressFile(username)]) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
  await redisDel(`sf:creds:${s}`, `sf:cache:${s}`, `sf:progress:${s}`);
}
