import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const CREDS_FILE = path.join(DATA_DIR, "credentials.enc");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");

const ALGORITHM = "aes-256-gcm";
const SECRET = crypto
  .createHash("sha256")
  .update(`sf-dashboard-${process.platform}-${process.env.USERNAME ?? "user"}`)
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

export function saveCredentials(username: string, password: string): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDS_FILE, encrypt(JSON.stringify({ username, password })), "utf8");
}

export function loadCredentials(): { username: string; password: string } | null {
  if (!fs.existsSync(CREDS_FILE)) return null;
  try {
    return JSON.parse(decrypt(fs.readFileSync(CREDS_FILE, "utf8")));
  } catch {
    return null;
  }
}

export function hasCredentials(): boolean {
  return fs.existsSync(CREDS_FILE);
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
  } catch {
    // best-effort — local file is the source of truth within the same session
  }
}

function writeLocal(file: string, content: string): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

// ── Cache ────────────────────────────────────────────────────────────────────

export async function saveCache(data: DashboardCache): Promise<void> {
  const json = JSON.stringify(data);
  writeLocal(CACHE_FILE, json);
  await redisSet("sf:cache", json);
}

export async function loadCache(): Promise<DashboardCache | null> {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch {}
  }
  // Local file missing (e.g. after Render redeploy) — fall back to Redis
  const raw = await redisGet("sf:cache");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as DashboardCache;
    writeLocal(CACHE_FILE, raw); // warm the local file for subsequent reads
    return data;
  } catch {
    return null;
  }
}

// ── Tag storage ──────────────────────────────────────────────────────────────

export type ProductTag = "Sunfish 6" | "Sunfish 7" | "Greatday";
export type TagMap = Record<string, ProductTag>;

const TAGS_FILE = path.join(DATA_DIR, "tags.json");

export async function saveTags(tags: TagMap): Promise<void> {
  const json = JSON.stringify(tags, null, 2);
  writeLocal(TAGS_FILE, json);
  await redisSet("sf:tags", json, 7 * 86400); // 7-day TTL — tags change infrequently
}

export async function loadTags(): Promise<TagMap> {
  if (fs.existsSync(TAGS_FILE)) {
    try { return JSON.parse(fs.readFileSync(TAGS_FILE, "utf8")); } catch {}
  }
  // Fall back to Redis
  const raw = await redisGet("sf:tags");
  if (!raw) return {};
  try {
    const tags = JSON.parse(raw) as TagMap;
    writeLocal(TAGS_FILE, raw);
    return tags;
  } catch {
    return {};
  }
}
