"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { DashboardCache, TicketRow, ModuleRow, SeverityRow, RecentTicket, ProductTag, TagMap } from "@/lib/store";

const REFRESH_MS = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Filters {
  dateFrom: string;   // "YYYY-MM-DD" or ""
  dateTo: string;
  datePreset: string;
  fixDateFrom: string;
  fixDateTo: string;
  fixDatePreset: string;
  projects: string[];
  types: string[];
  statuses: string[];
  tags: string[];
  includedInternalProjects: string[]; // labels from INTERNAL_PROJECTS to un-exclude
  customExcludedProjects: string[];   // user-added exclusion patterns
}

const EMPTY_FILTERS: Filters = { dateFrom: "", dateTo: "", datePreset: "", fixDateFrom: "", fixDateTo: "", fixDatePreset: "", projects: [], types: [], statuses: [], tags: [], includedInternalProjects: [], customExcludedProjects: [] };

// Internal/product projects excluded by default — each entry is independently togglable
const INTERNAL_PROJECTS: { label: string; patterns: string[] }[] = [
  { label: "SunFish 7 HCM",      patterns: ["sunfish 7 hcm", "sunfish hcm"] },
  { label: "SunFish 7 HR",       patterns: ["sunfish 7 hr"] },
  { label: "SunFish HR Product 6", patterns: ["sunfish hr product"] },
  { label: "SunFish 7 Tech",     patterns: ["sunfish 7 tech"] },
  { label: "SunFish 6 Tech",     patterns: ["sunfish 6 tech"] },
  { label: "SunFish DataOn PH",  patterns: ["sunfish dataon"] },
  { label: "SDP PH IT / SDPPHIT", patterns: ["sdp ph it", "sdpphit"] },
  { label: "PMN",                 patterns: ["pmn"] },
  { label: "Greatday Pro",       patterns: ["greatday pro"] },
  { label: "Greatday",           patterns: ["greatday"] },
];

function isProjectExcluded(project: string, includedInternalProjects: string[], customExcludedProjects: string[] = []): boolean {
  const p = project.toLowerCase().trim();
  for (const ip of INTERNAL_PROJECTS) {
    if (ip.patterns.some((pat) => p.includes(pat))) {
      return !includedInternalProjects.includes(ip.label);
    }
  }
  if (customExcludedProjects.length) {
    return customExcludedProjects.some((pat) => p.includes(pat.toLowerCase().trim()));
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
  Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12",
};

/** Return "YYYY-MM-DD" from any date string — avoids all timezone issues. */
function toDateOnly(s: string): string | null {
  if (!s) return null;
  // "YYYY-MM-DD..." — ISO or input value
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // "05-May-2026" or "05-May-2026 10:30:00"
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})/i);
  if (m) {
    const mon = MONTH_MAP[m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function toInputDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DATE_PRESETS = [
  { value: "today",           label: "Today" },
  { value: "yesterday-today", label: "Yesterday – Today" },
  { value: "yesterday",       label: "Yesterday" },
  { value: "this-week",       label: "This Week" },
  { value: "this-month",      label: "This Month" },
  { value: "custom",          label: "Custom" },
] as const;

function getPresetDates(preset: string): { from: string; to: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = toInputDate(today);
  const offset = (n: number) => { const d = new Date(today); d.setDate(today.getDate() + n); return toInputDate(d); };

  // Work day = 5:30 PM (D-1) → 5:29 PM (D).
  // Before 5:30PM: current work day spans [yesterday, today].
  // At/after 5:30PM: new work day just started, spans [today, today].
  const h = now.getHours(), m = now.getMinutes();
  const pastCutoff = h > 17 || (h === 17 && m >= 30);

  switch (preset) {
    case "today":
      return pastCutoff ? { from: todayStr, to: todayStr } : { from: offset(-1), to: todayStr };
    case "yesterday-today":
      return { from: offset(-1), to: todayStr };
    case "yesterday":
      return pastCutoff ? { from: offset(-1), to: todayStr } : { from: offset(-2), to: offset(-1) };
    case "this-week": {
      const day = today.getDay();
      return { from: offset(-(day === 0 ? 6 : day - 1)), to: todayStr };
    }
    case "this-month":
      return { from: toInputDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: todayStr };
    default:
      return { from: "", to: "" };
  }
}

function activeFilterCount(f: Filters) {
  return (f.dateFrom ? 1 : 0) + (f.fixDateFrom ? 1 : 0) + f.projects.length + f.types.length + f.statuses.length + f.tags.length + f.includedInternalProjects.length + f.customExcludedProjects.length;
}

function filterTicketRows(rows: TicketRow[], f: Filters, tagMap: TagMap = {}): TicketRow[] {
  return rows.filter((r) => {
    if (isProjectExcluded(r.project, f.includedInternalProjects, f.customExcludedProjects)) return false;
    const d = toDateOnly(r.reportedDate);
    if (d && f.dateFrom && d < f.dateFrom) return false;
    if (d && f.dateTo   && d > f.dateTo)   return false;
    if (f.projects.length && !f.projects.includes(r.project)) return false;
    if (f.types.length    && !f.types.includes(r.type)) return false;
    if (f.statuses.length && !f.statuses.includes(r.status)) return false;
    if (f.tags.length) {
      const tag = getProjectTag(r.project, tagMap);
      if (!tag || !f.tags.includes(tag)) return false;
    }
    return true;
  });
}

function filterRecent(rows: RecentTicket[], f: Filters, tagMap: TagMap = {}): RecentTicket[] {
  return rows.filter((r) => {
    if (isProjectExcluded(r.project, f.includedInternalProjects, f.customExcludedProjects)) return false;
    const d = toDateOnly(r.createdDate);
    if (d && f.dateFrom && d < f.dateFrom) return false;
    if (d && f.dateTo   && d > f.dateTo)   return false;
    if (f.fixDateFrom || f.fixDateTo) {
      const fd = toDateOnly(r.fixedDate);
      if (!fd) return false; // no fix date — exclude when fix date filter is active
      if (f.fixDateFrom && fd < f.fixDateFrom) return false;
      if (f.fixDateTo   && fd > f.fixDateTo)   return false;
    }
    if (f.projects.length && !f.projects.includes(r.project)) return false;
    if (f.types.length    && !f.types.includes(r.task)) return false;
    if (f.statuses.length && !f.statuses.includes(r.status)) return false;
    if (f.tags.length) {
      const tag = getProjectTag(r.project, tagMap);
      if (!tag || !f.tags.includes(tag)) return false;
    }
    return true;
  });
}

// ── Status & severity colours ─────────────────────────────────────────────────

const STATUS_CLS: Record<string, string> = {
  Open:      "bg-red-500/20 text-red-300 border border-red-700",
  Responded: "bg-yellow-500/20 text-yellow-300 border border-yellow-700",
  Fixed:     "bg-green-500/20 text-green-300 border border-green-700",
  Closed:    "bg-gray-500/20 text-gray-300 border border-gray-600",
  Reopen:    "bg-orange-500/20 text-orange-300 border border-orange-700",
  Cancelled: "bg-purple-500/20 text-purple-300 border border-purple-700",
};

const PRODUCT_TAGS: ProductTag[] = ["Sunfish 6", "Sunfish 7", "Greatday"];

const TAG_CLS: Record<ProductTag, string> = {
  "Sunfish 6": "bg-red-500/20 text-red-300 border border-red-700",
  "Sunfish 7": "bg-blue-500/20 text-blue-300 border border-blue-700",
  "Greatday":  "bg-orange-500/20 text-orange-300 border border-orange-700",
};

const TAG_CARD_CLS: Record<ProductTag, string> = {
  "Sunfish 6": "border-red-900/60 bg-red-950/20",
  "Sunfish 7": "border-blue-900/60 bg-blue-950/20",
  "Greatday":  "border-orange-900/60 bg-orange-950/20",
};

const TAG_BANNER_CLS: Record<string, string> = {
  "Sunfish 6": "bg-red-500/30 text-red-300 border border-red-600",
  "Sunfish 7": "bg-blue-500/30 text-blue-300 border border-blue-600",
  "Greatday":  "bg-orange-500/30 text-orange-300 border border-orange-600",
};

function autoDetectTag(project: string): ProductTag | null {
  const p = project.toLowerCase();
  if (p.includes("sunfish 7") || p.includes("sunfish7") || p.includes("sunfish hcm")) return "Sunfish 7";
  if (p.includes("sunfish 6") || p.includes("sunfish6") || p.includes("sunfish hr product")) return "Sunfish 6";
  return null;
}

function getProjectTag(project: string, tagMap: TagMap): ProductTag | null {
  return tagMap[project] ?? autoDetectTag(project) ?? null;
}

// Ticket list uses extended labels — normalise to canonical four
function normalizeSeverity(s: string): string {
  const l = s.toLowerCase();
  if (l.includes("critical"))                       return "Critical";
  if (l.includes("major") || l.includes("high"))    return "High";
  if (l.includes("minor") || l.includes("medium"))  return "Medium";
  if (l.includes("low") || l.includes("no impact")) return "Low";
  return s; // keep as-is if unrecognised
}

const SEV_CLS: Record<string, string> = {
  Critical: "text-red-400",
  High:     "text-orange-400",
  Medium:   "text-yellow-400",
  Low:      "text-blue-400",
};

function StatusBadge({ s }: { s: string }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${STATUS_CLS[s] ?? "bg-gray-700 text-gray-300"}`}>
      {s || "—"}
    </span>
  );
}

function TagBadge({ tag }: { tag: ProductTag }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${TAG_CLS[tag]}`}>
      {tag}
    </span>
  );
}

// ── Filter panel ──────────────────────────────────────────────────────────────

interface Option { value: string; count: number }

function MultiCheck({
  label, options, selected, onChange,
}: {
  label: string; options: Option[]; selected: string[]; onChange: (v: string[]) => void;
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active  = selected.includes(o.value);
          const isEmpty = o.count === 0;
          return (
            <button
              key={o.value}
              onClick={() => !isEmpty && toggle(o.value)}
              disabled={isEmpty}
              title={isEmpty ? "No tickets with this status" : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                isEmpty
                  ? "border-gray-800 bg-gray-900 text-gray-600 cursor-not-allowed opacity-50"
                  : active
                    ? "bg-teal-600 border-teal-500 text-white"
                    : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500"
              }`}
            >
              {o.value}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
                isEmpty ? "bg-gray-800 text-gray-600"
                : active ? "bg-teal-500/60 text-white"
                : "bg-gray-700 text-gray-400"
              }`}>
                {o.count}
              </span>
            </button>
          );
        })}
        {options.length === 0 && <span className="text-xs text-gray-600">No data yet</span>}
      </div>
    </div>
  );
}

const selectCls = "bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 cursor-pointer";
const inputCls  = "bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500";

// ── Custom exclusion manager ───────────────────────────────────────────────────

function CustomExclusionManager({
  excluded, onChange,
}: {
  excluded: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");

  function add() {
    const val = input.trim();
    if (!val || excluded.some((e) => e.toLowerCase() === val.toLowerCase())) return;
    onChange([...excluded, val]);
    setInput("");
  }

  return (
    <div className="pt-2 border-t border-gray-800">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
        Custom Exclusions
        <span className="ml-2 normal-case font-normal text-gray-600">(add project name or pattern to exclude)</span>
      </p>

      {/* Input row */}
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Type project name or pattern…"
          className={`${inputCls} w-64 placeholder-gray-600`}
        />
        <button
          onClick={add}
          disabled={!input.trim()}
          className="px-3 py-1.5 text-xs rounded-lg bg-teal-600/20 border border-teal-700 text-teal-300
                     hover:bg-teal-600/40 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          Add
        </button>
      </div>

      {/* Excluded list */}
      {excluded.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {excluded.map((pat) => (
            <span
              key={pat}
              className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 rounded-full text-xs font-medium
                         bg-red-900/30 border border-red-800 text-red-300"
            >
              {pat}
              <button
                onClick={() => onChange(excluded.filter((e) => e !== pat))}
                className="hover:text-white transition leading-none"
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPanel({
  filters, onChange, options,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  options: { projects: Option[]; types: Option[]; statuses: Option[]; tags: Option[] };
}) {
  function setField<K extends keyof Filters>(k: K, v: Filters[K]) {
    onChange({ ...filters, [k]: v });
  }

  function applyDatePreset(preset: string) {
    const { from, to } = getPresetDates(preset);
    onChange({ ...filters, datePreset: preset, dateFrom: from, dateTo: to });
  }

  function applyFixDatePreset(preset: string) {
    const { from, to } = getPresetDates(preset);
    onChange({ ...filters, fixDatePreset: preset, fixDateFrom: from, fixDateTo: to });
  }

  const showCustomDate    = filters.datePreset === "custom" || (!filters.datePreset && (filters.dateFrom || filters.dateTo));
  const showCustomFixDate = filters.fixDatePreset === "custom" || (!filters.fixDatePreset && (filters.fixDateFrom || filters.fixDateTo));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      {/* Date range */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Date Range</p>
        <div className="flex flex-wrap items-center gap-2">
          {DATE_PRESETS.filter((p) => p.value !== "custom").map((p) => {
            const active = filters.datePreset === p.value;
            return (
              <button
                key={p.value}
                onClick={() => active
                  ? onChange({ ...filters, datePreset: "", dateFrom: "", dateTo: "" })
                  : applyDatePreset(p.value)
                }
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? "bg-teal-600 border-teal-500 text-white"
                    : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500"
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <button
            onClick={() => onChange({ ...filters, datePreset: "custom", dateFrom: filters.dateFrom, dateTo: filters.dateTo })}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              filters.datePreset === "custom"
                ? "bg-teal-600 border-teal-500 text-white"
                : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500"
            }`}
          >
            Custom
          </button>

          {showCustomDate && (
            <>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">From</label>
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => onChange({ ...filters, dateFrom: e.target.value, datePreset: "custom" })}
                  className={inputCls}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">To</label>
                <input
                  type="date"
                  value={filters.dateTo}
                  min={filters.dateFrom}
                  onChange={(e) => onChange({ ...filters, dateTo: e.target.value, datePreset: "custom" })}
                  className={inputCls}
                />
              </div>
            </>
          )}

          {(filters.dateFrom || filters.dateTo || filters.datePreset) && (
            <button
              onClick={() => onChange({ ...filters, dateFrom: "", dateTo: "", datePreset: "" })}
              className="text-xs text-gray-500 hover:text-gray-300 transition"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-5">
        <MultiCheck label="Product Tag" options={options.tags} selected={filters.tags}
          onChange={(v) => setField("tags", v)} />
        <MultiCheck label="Project" options={options.projects} selected={filters.projects}
          onChange={(v) => setField("projects", v)} />
        <MultiCheck label="Type" options={options.types} selected={filters.types}
          onChange={(v) => setField("types", v)} />
        <MultiCheck label="Status" options={options.statuses} selected={filters.statuses}
          onChange={(v) => setField("statuses", v)} />
      </div>

      {/* Fix Date range */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Fix Date Range</p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={filters.fixDatePreset}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") {
                onChange({ ...filters, fixDatePreset: "custom" });
              } else if (v === "") {
                onChange({ ...filters, fixDatePreset: "", fixDateFrom: "", fixDateTo: "" });
              } else {
                applyFixDatePreset(v);
              }
            }}
            className={selectCls}
          >
            <option value="">Select range…</option>
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>

          {showCustomFixDate && (
            <>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">From</label>
                <input
                  type="date"
                  value={filters.fixDateFrom}
                  onChange={(e) => {
                    const v = e.target.value;
                    const newTo = filters.fixDateTo && filters.fixDateTo < v ? v : filters.fixDateTo;
                    onChange({ ...filters, fixDateFrom: v, fixDateTo: newTo, fixDatePreset: "custom" });
                  }}
                  className={inputCls}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">To</label>
                <input
                  type="date"
                  value={filters.fixDateTo}
                  min={filters.fixDateFrom}
                  onChange={(e) => onChange({ ...filters, fixDateTo: e.target.value, fixDatePreset: "custom" })}
                  className={inputCls}
                />
              </div>
            </>
          )}

          {!showCustomFixDate && filters.fixDateFrom && (
            <span className="text-xs text-gray-400">
              {filters.fixDateFrom === filters.fixDateTo
                ? filters.fixDateFrom
                : `${filters.fixDateFrom} → ${filters.fixDateTo}`}
            </span>
          )}

          {(filters.fixDateFrom || filters.fixDateTo || filters.fixDatePreset) && (
            <button
              onClick={() => onChange({ ...filters, fixDateFrom: "", fixDateTo: "", fixDatePreset: "" })}
              className="text-xs text-gray-500 hover:text-gray-300 transition"
            >
              Clear
            </button>
          )}
          <span className="text-xs text-gray-600">Only shows tickets with a fix date</span>
        </div>
      </div>

      {/* Internal projects — per-project checkboxes */}
      <div className="pt-2 border-t border-gray-800">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Internal Projects
          <span className="ml-2 normal-case font-normal text-gray-600">(excluded by default — check to include)</span>
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1.5">
          {INTERNAL_PROJECTS.map((ip) => {
            const checked = filters.includedInternalProjects.includes(ip.label);
            return (
              <label key={ip.label} className="flex items-center gap-2 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? filters.includedInternalProjects.filter((l) => l !== ip.label)
                      : [...filters.includedInternalProjects, ip.label];
                    setField("includedInternalProjects", next);
                  }}
                  className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-teal-500
                             focus:ring-teal-500 focus:ring-1 cursor-pointer"
                />
                <span className={`text-xs transition-colors ${checked ? "text-teal-300" : "text-gray-400 group-hover:text-gray-200"}`}>
                  {ip.label}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <CustomExclusionManager
        excluded={filters.customExcludedProjects}
        onChange={(next) => setField("customExcludedProjects", next)}
      />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <div className={`bg-gray-900 border rounded-xl p-5 flex flex-col items-center justify-center text-center ${accent ?? "border-gray-800"}`}>
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-[80px] font-bold text-white leading-none">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

const BREAKDOWN_GROUPS: { status: string; cls: string; headerCls: string }[] = [
  { status: "Open",      cls: "text-red-400",    headerCls: "bg-red-950/40 border-red-900/50 text-red-400" },
  { status: "Responded", cls: "text-yellow-300",  headerCls: "bg-yellow-950/40 border-yellow-900/50 text-yellow-400" },
  { status: "Reopen",    cls: "text-orange-400",  headerCls: "bg-orange-950/40 border-orange-900/50 text-orange-400" },
];

function TicketMiniTable({ rows, title, tagMap = {}, breakdown = false }: { rows: TicketRow[]; title: string; tagMap?: TagMap; breakdown?: boolean }) {
  const COLS = 6;

  const bodyRows = breakdown ? (
    BREAKDOWN_GROUPS.flatMap(({ status, headerCls }) => {
      const group = rows.filter((r) => r.status === status);
      if (group.length === 0) return [];
      return [
        <tr key={`hdr-${status}`} className={`border-b border-t ${headerCls}`}>
          <td colSpan={COLS} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider">
            {status} <span className="ml-1 opacity-60">({group.length})</span>
          </td>
        </tr>,
        ...group.map((r, i) => (
          <tr key={`${status}-${i}`} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
            <td className="px-4 py-2.5 text-blue-400 font-mono text-xs whitespace-nowrap">{r.documentNo}</td>
            <td className="px-4 py-2.5 text-gray-300 break-words min-w-[120px]">{r.project}</td>
            <td className="px-4 py-2.5 whitespace-nowrap">
              {(() => { const t = getProjectTag(r.project, tagMap); return t ? <TagBadge tag={t} /> : <span className="text-gray-700">—</span>; })()}
            </td>
            <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{r.type}</td>
            <td className="px-4 py-2.5"><StatusBadge s={r.status} /></td>
            <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{r.reportedDate}</td>
          </tr>
        )),
      ];
    })
  ) : (
    rows.map((r, i) => (
      <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
        <td className="px-4 py-2.5 text-blue-400 font-mono text-xs whitespace-nowrap">{r.documentNo}</td>
        <td className="px-4 py-2.5 text-gray-300 break-words min-w-[120px]">{r.project}</td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          {(() => { const t = getProjectTag(r.project, tagMap); return t ? <TagBadge tag={t} /> : <span className="text-gray-700">—</span>; })()}
        </td>
        <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{r.type}</td>
        <td className="px-4 py-2.5"><StatusBadge s={r.status} /></td>
        <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{r.reportedDate}</td>
      </tr>
    ))
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="font-semibold text-white text-sm">{title}</h3>
        <span className="text-xs text-gray-400">{rows.length} tickets</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {["Document No", "Project", "Tag", "Type", "Status", "Reported Date"].map((h) => (
                <th key={h} className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? <tr><td colSpan={COLS} className="px-4 py-6 text-center text-gray-600 text-sm">No tickets match filters</td></tr>
              : bodyRows}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModuleTable({ rows }: { rows: ModuleRow[] }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800">
        <h3 className="font-semibold text-white text-sm">Module Breakdown</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {[
                ["Module", "text-gray-400"], ["Total", "text-gray-400"], ["Critical", "text-red-400"],
                ["High", "text-orange-400"], ["Medium", "text-yellow-400"], ["Low", "text-blue-400"],
                ["Open", "text-red-300"], ["Responded", "text-yellow-300"], ["Fixed", "text-green-300"], ["Closed", "text-gray-300"],
              ].map(([h, c]) => (
                <th key={h} className={`px-4 py-2 text-left text-xs uppercase tracking-wide font-medium ${c}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-2.5 text-gray-200 font-medium whitespace-nowrap">{r.module}</td>
                <td className="px-4 py-2.5 text-center text-white font-semibold">{r.total}</td>
                <td className="px-4 py-2.5 text-center text-red-400">{r.critical || "—"}</td>
                <td className="px-4 py-2.5 text-center text-orange-400">{r.high || "—"}</td>
                <td className="px-4 py-2.5 text-center text-yellow-400">{r.medium || "—"}</td>
                <td className="px-4 py-2.5 text-center text-blue-400">{r.low || "—"}</td>
                <td className="px-4 py-2.5 text-center">{r.open ? <span className="text-red-400 font-medium">{r.open}</span> : <span className="text-gray-600">—</span>}</td>
                <td className="px-4 py-2.5 text-center text-yellow-300">{r.responded || "—"}</td>
                <td className="px-4 py-2.5 text-center text-green-400">{r.fixed || "—"}</td>
                <td className="px-4 py-2.5 text-center text-gray-400">{r.closed || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SeverityTable({ rows }: { rows: SeverityRow[] }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 bg-blue-900">
        <h3 className="font-bold text-white text-[18px] uppercase tracking-wide text-center">By Severity</h3>
      </div>
      <div>
        <table className="w-full text-[20px] table-fixed">
          <thead>
            <tr className="border-b border-gray-800">
              {["Severity", "Open", "Responded", "Reopen", "Fixed", "Closed", "Cancelled"].map((h) => (
                <th key={h} className="px-2 py-2 text-center text-[16px] font-bold text-gray-400 uppercase tracking-wide first:text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                <td className={`px-2 py-2.5 font-semibold ${SEV_CLS[r.severity] ?? "text-gray-300"}`}>{r.severity}</td>
                <td className="px-2 py-2.5 text-center">{r.open ? <span className="text-red-400 font-medium">{r.open}</span> : <span className="text-gray-600">—</span>}</td>
                <td className="px-2 py-2.5 text-center text-yellow-300">{r.responded || "—"}</td>
                <td className="px-2 py-2.5 text-center text-orange-400">{r.reopen || "—"}</td>
                <td className="px-2 py-2.5 text-center text-green-400">{r.fixed || "—"}</td>
                <td className="px-2 py-2.5 text-center text-gray-400">{r.closed || "—"}</td>
                <td className="px-2 py-2.5 text-center text-purple-400">{r.cancelled || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecentTable({ rows, tagMap = {} }: { rows: RecentTicket[]; tagMap?: TagMap }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="font-semibold text-white text-sm">Recent Tickets</h3>
        <span className="text-xs text-gray-400">{rows.length} shown</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              {["Task", "Ticket No", "Project", "Tag", "Module", "Subject", "Severity", "Created", "Fixed", "Status"].map((h) => (
                <th key={h} className="px-4 py-2 text-left text-xs text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0
              ? <tr><td colSpan={10} className="px-4 py-6 text-center text-gray-600">No tickets match filters</td></tr>
              : rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{r.task}</td>
                  <td className="px-4 py-2.5 text-blue-400 font-mono text-xs whitespace-nowrap">{r.ticketNo}</td>
                  <td className="px-4 py-2.5 text-gray-300 break-words min-w-[120px]">{r.project}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {(() => { const t = getProjectTag(r.project, tagMap); return t ? <TagBadge tag={t} /> : <span className="text-gray-700">—</span>; })()}
                  </td>
                  <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{r.module || "—"}</td>
                  <td className="px-4 py-2.5 text-gray-200 break-words min-w-[200px]">{r.subject}</td>
                  <td className={`px-4 py-2.5 whitespace-nowrap font-medium ${SEV_CLS[normalizeSeverity(r.severity)] ?? "text-gray-400"}`}>{r.severity}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs">
                    <span className="text-gray-400">{r.createdDate?.split(" ")[0] ?? "—"}</span>
                    {r.createdDate?.includes(" ") && (
                      <span className="block text-gray-600">{r.createdDate.split(" ").slice(1).join(" ")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs">
                    <span className="text-gray-400">{r.fixedDate?.split(" ")[0] || "—"}</span>
                    {r.fixedDate?.includes(" ") && (
                      <span className="block text-gray-600">{r.fixedDate.split(" ").slice(1).join(" ")}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap"><StatusBadge s={r.status} /></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Countdown({ nextAt }: { nextAt: number }) {
  const [rem, setRem] = useState(0);
  useEffect(() => {
    const tick = () => setRem(Math.max(0, Math.round((nextAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextAt]);
  const m = Math.floor(rem / 60), s = rem % 60;
  return <span className="text-xs text-gray-400">Next refresh {m}:{s.toString().padStart(2, "0")}</span>;
}

// ── Ticket Locator ────────────────────────────────────────────────────────────

const PRIORITY_FIELDS = ["Assigned To", "Assignment", "Assignee", "Handler", "Status", "Severity",
  "Project", "Module", "Subject", "Created", "Reported", "Fixed", "Completion"];

function TicketLocator() {
  const [open, setOpen]           = useState(false);
  const [input, setInput]         = useState("");
  const [query, setQuery]         = useState("");
  const [cached, setCached]       = useState<Record<string, string> | null>(null);
  const [live, setLive]           = useState<Record<string, string> | null>(null);
  const [liveUrl, setLiveUrl]     = useState("");
  const [cacheState, setCacheState] = useState<"idle"|"found"|"not-found">("idle");
  const [liveState, setLiveState]   = useState<"idle"|"loading"|"found"|"error">("idle");
  const [liveError, setLiveError]   = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function search(ticketNo: string) {
    const no = ticketNo.trim().toUpperCase();
    if (!no) return;
    setQuery(no);
    setCached(null); setLive(null); setLiveUrl("");
    setCacheState("idle"); setLiveState("idle"); setLiveError("");

    // Phase 1 — instant cache lookup
    const res = await fetch(`/api/ticket?ticketNo=${encodeURIComponent(no)}`);
    const json = await res.json();
    if (json.cached) {
      const c = json.cached;
      const fields: Record<string, string> = {};
      if (c.ticketNo || c.documentNo) fields["Ticket No"]     = c.ticketNo ?? c.documentNo;
      if (c.project)      fields["Project"]      = c.project;
      if (c.task)         fields["Task Type"]    = c.task;
      if (c.type)         fields["Type"]         = c.type;
      if (c.status)       fields["Status"]       = c.status;
      if (c.severity)     fields["Severity"]     = c.severity;
      if (c.module)       fields["Module"]       = c.module;
      if (c.subject)      fields["Subject"]      = c.subject;
      if (c.createdDate)  fields["Created"]      = c.createdDate;
      if (c.reportedDate) fields["Reported"]     = c.reportedDate;
      if (c.fixedDate)    fields["Fixed"]        = c.fixedDate;
      if (c.completion)   fields["Completion"]   = c.completion;
      setCached(fields);
      setCacheState("found");
    } else {
      setCacheState("not-found");
    }

    // Phase 2 — live scrape for full details (including Assigned To)
    setLiveState("loading");
    const lres = await fetch("/api/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketNo: no }),
    });
    const ljson = await lres.json();
    if (ljson.error) {
      setLiveState("error");
      setLiveError(ljson.error);
    } else {
      setLive(ljson.fields ?? {});
      setLiveUrl(ljson.url ?? "");
      setLiveState("found");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    search(input);
  }

  // Sort live fields: priority keys first, then rest alphabetically
  const sortedLiveFields = live ? [
    ...PRIORITY_FIELDS.filter((k) => live[k] !== undefined).map((k) => [k, live[k]] as [string, string]),
    ...Object.entries(live)
      .filter(([k]) => !PRIORITY_FIELDS.includes(k) && !k.startsWith("_"))
      .sort(([a], [b]) => a.localeCompare(b)),
  ] : [];

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700
                   text-gray-400 hover:border-gray-500 hover:text-gray-200 transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        Ticket Locator
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />

      {/* Modal */}
      <div className="relative w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="font-semibold text-white text-sm">Ticket Locator</span>
          </div>
          <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-white transition text-lg leading-none">×</button>
        </div>

        {/* Search bar */}
        <form onSubmit={handleSubmit} className="flex gap-2 p-4 border-b border-gray-800">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter ticket number e.g. TCK2512-1070015"
            className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg px-4 py-2
                       placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
          <button
            type="submit"
            disabled={!input.trim() || liveState === "loading"}
            className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50
                       disabled:cursor-not-allowed text-white text-sm font-medium transition"
          >
            {liveState === "loading" ? "Searching…" : "Search"}
          </button>
        </form>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
          {/* Cache result */}
          {cacheState !== "idle" && (
            <div>
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${cacheState === "found" ? "bg-teal-400" : "bg-gray-600"}`} />
                {cacheState === "found" ? "Found in cache" : `"${query}" not in local cache`}
              </p>
              {cached && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                  {Object.entries(cached).map(([k, v]) => (
                    <div key={k} className="flex flex-col">
                      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{k}</span>
                      <span className="text-sm text-gray-200 font-medium break-words">{v || "—"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Live scrape result */}
          {liveState !== "idle" && (
            <div className="border-t border-gray-800 pt-4">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                {liveState === "loading" && (
                  <><svg className="w-3 h-3 animate-spin text-teal-400" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg> Fetching live details from site…</>
                )}
                {liveState === "found" && (
                  <><span className="w-1.5 h-1.5 rounded-full bg-green-400" /> Live details loaded</>
                )}
                {liveState === "error" && (
                  <><span className="w-1.5 h-1.5 rounded-full bg-red-400" /> {liveError}</>
                )}
              </p>

              {liveState === "found" && sortedLiveFields.length > 0 && (
                <>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                    {sortedLiveFields.map(([k, v]) => (
                      <div key={k} className={`flex flex-col ${
                        k.toLowerCase().includes("assign") ? "col-span-2 bg-teal-900/20 border border-teal-800/40 rounded-lg px-3 py-2" : ""
                      }`}>
                        <span className="text-[10px] text-gray-500 uppercase tracking-wider">{k}</span>
                        <span className={`text-sm font-medium break-words ${
                          k.toLowerCase().includes("assign") ? "text-teal-300" : "text-gray-200"
                        }`}>{v || "—"}</span>
                      </div>
                    ))}
                  </div>
                  {liveUrl && (
                    <p className="mt-3 text-[10px] text-gray-600 break-all">Source: {liveUrl}</p>
                  )}
                </>
              )}

              {liveState === "found" && sortedLiveFields.length === 0 && (
                <p className="text-xs text-gray-500">Detail page loaded but no structured fields were found.</p>
              )}
            </div>
          )}

          {/* Idle state */}
          {cacheState === "idle" && (
            <p className="text-center text-xs text-gray-600 py-8">
              Enter a ticket number above and press Search
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tag Manager ───────────────────────────────────────────────────────────────

function TagManager({
  projects, tagMap, onTagChange, onClose,
}: {
  projects: string[];
  tagMap: TagMap;
  onTagChange: (project: string, tag: ProductTag | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <span className="font-semibold text-white text-sm">Manage Project Tags</span>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition text-lg leading-none">×</button>
        </div>
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 z-10">
              <tr className="border-b border-gray-800">
                <th className="px-5 py-2 text-left text-xs text-gray-400 uppercase tracking-wide">Project</th>
                <th className="px-5 py-2 text-left text-xs text-gray-400 uppercase tracking-wide">Tag</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((proj) => {
                const manual    = tagMap[proj];
                const auto      = autoDetectTag(proj);
                const effective = manual ?? auto;
                return (
                  <tr key={proj} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-5 py-2.5 text-gray-300">{proj}</td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <select
                          value={manual ?? ""}
                          onChange={(e) => onTagChange(proj, (e.target.value as ProductTag) || null)}
                          className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 cursor-pointer"
                        >
                          <option value="">— {auto ? `(auto: ${auto})` : "Untagged"}</option>
                          {PRODUCT_TAGS.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                        {effective && <TagBadge tag={effective} />}
                        {manual && (
                          <button
                            onClick={() => onTagChange(proj, null)}
                            className="text-xs text-gray-600 hover:text-gray-400 transition"
                            title="Reset to auto-detect"
                          >
                            reset
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {projects.length === 0 && (
                <tr><td colSpan={2} className="px-5 py-8 text-center text-gray-600 text-sm">No projects found — refresh data first</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const router = useRouter();
  const [cache, setCache]       = useState<DashboardCache | null>(null);
  const [loading, setLoading]   = useState(true);
  const [scraping, setScraping] = useState(false);
  const [nextAt, setNextAt]     = useState(Date.now() + REFRESH_MS);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters]   = useState<Filters>(() => {
    const { from, to } = getPresetDates("today");
    return { ...EMPTY_FILTERS, datePreset: "today", dateFrom: from, dateTo: to };
  });
  const [username, setUsername] = useState<string | null>(null);
  const [tagMap, setTagMap]     = useState<TagMap>({});
  const [showTagManager, setShowTagManager] = useState(false);
  const [newOpenTickets, setNewOpenTickets] = useState<RecentTicket[]>([]);
  const [showNewTicketModal, setShowNewTicketModal] = useState(false);
  const [showOpenTicketsModal, setShowOpenTicketsModal] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("default");
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem("sf-alerts-enabled") !== "false"; } catch { return true; }
  });
  const prevOpenIdsRef = useRef<Set<string> | null>(null);
  const hasShownInitialModalRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openModalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newModalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef(Date.now());

  // Reset inactivity timer on any user interaction
  useEffect(() => {
    const reset = () => { lastActivityRef.current = Date.now(); };
    window.addEventListener("mousemove", reset);
    window.addEventListener("keydown", reset);
    window.addEventListener("click", reset);
    window.addEventListener("scroll", reset, true);
    return () => {
      window.removeEventListener("mousemove", reset);
      window.removeEventListener("keydown", reset);
      window.removeEventListener("click", reset);
      window.removeEventListener("scroll", reset, true);
    };
  }, []);

  // Sign out after 120 minutes of inactivity
  useEffect(() => {
    const TIMEOUT_MS = 120 * 60 * 1000;
    const id = setInterval(async () => {
      if (Date.now() - lastActivityRef.current >= TIMEOUT_MS) {
        await fetch("/api/auth", { method: "DELETE" }).catch(() => {});
        router.replace("/");
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [router]);

  // Auto-close open tickets modal after 4 minutes
  useEffect(() => {
    if (openModalTimerRef.current) clearTimeout(openModalTimerRef.current);
    if (showOpenTicketsModal) {
      openModalTimerRef.current = setTimeout(() => setShowOpenTicketsModal(false), 4 * 60 * 1000);
    }
    return () => { if (openModalTimerRef.current) clearTimeout(openModalTimerRef.current); };
  }, [showOpenTicketsModal]);

  // Auto-close new ticket popup after 4 minutes
  useEffect(() => {
    if (newModalTimerRef.current) clearTimeout(newModalTimerRef.current);
    if (showNewTicketModal) {
      newModalTimerRef.current = setTimeout(() => setShowNewTicketModal(false), 4 * 60 * 1000);
    }
    return () => { if (newModalTimerRef.current) clearTimeout(newModalTimerRef.current); };
  }, [showNewTicketModal]);

  const fetchData = useCallback(async () => {
    const res = await fetch("/api/data");
    const json = await res.json();
    if (!json.hasCreds) { router.replace("/"); return; }
    setCache(json.cache);
    if (json.username) setUsername(json.username);
    if (json.tags) setTagMap(json.tags);
    setLoading(false);
    if (!hasShownInitialModalRef.current && json.cache?.recentTickets?.some((t: RecentTicket) => t.status === "Open")) {
      hasShownInitialModalRef.current = true;
      setShowOpenTicketsModal(true);
    }
  }, [router]);

  // Sync notification permission state
  useEffect(() => {
    if (!("Notification" in window)) { setNotifPermission("unsupported"); return; }
    setNotifPermission(Notification.permission);
  }, []);

  // Detect new open tickets on each cache update
  useEffect(() => {
    if (!cache) return;
    const openTickets = cache.recentTickets.filter((t) => t.status === "Open");
    const currentIds  = new Set(openTickets.map((t) => t.ticketNo));

    if (prevOpenIdsRef.current === null) {
      // First load — record baseline, do not notify
      prevOpenIdsRef.current = currentIds;
      return;
    }

    const brandNew = openTickets.filter((t) => !prevOpenIdsRef.current!.has(t.ticketNo));
    prevOpenIdsRef.current = currentIds;

    if (brandNew.length === 0) return;

    setBannerDismissed(false);
    setNewOpenTickets((prev) => {
      const existingIds = new Set(prev.map((t) => t.ticketNo));
      return [...prev, ...brandNew.filter((t) => !existingIds.has(t.ticketNo))];
    });
    setShowNewTicketModal(true);

    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted" && alertsEnabled) {
      brandNew.forEach((t) => {
        new Notification("🔴 New Open Ticket — SF Dashboard", {
          body: `${t.ticketNo}  ·  ${t.project}`,
        });
      });
    }
  }, [cache]);

  const triggerScrape = useCallback(async () => {
    setScraping(true);
    const dates = (cache?.recentTickets ?? [])
      .map((t) => toDateOnly(t.createdDate))
      .filter(Boolean) as string[];
    const defaultFrom = dates.length
      ? dates.reduce((a, b) => (a < b ? a : b))
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDateFrom: defaultFrom }),
    }).catch(() => {});
    const before = cache?.scrapedAt;
    const poll = async () => {
      const res  = await fetch("/api/data");
      const json = await res.json();
      if (json.cache?.scrapedAt !== before) {
        setCache(json.cache);
        if (json.tags) setTagMap(json.tags);
        setScraping(false); setNextAt(Date.now() + REFRESH_MS);
      } else setTimeout(poll, 4000);
    };
    setTimeout(poll, 4000);
  }, [cache]);

  const updateTag = useCallback(async (project: string, tag: ProductTag | null) => {
    setTagMap((prev) => {
      const next = { ...prev };
      if (tag) next[project] = tag;
      else delete next[project];
      return next;
    });
    await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, tag }),
    }).catch(() => {});
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setNextAt(Date.now() + REFRESH_MS);
    timerRef.current = setTimeout(async () => { await triggerScrape(); scheduleRefresh(); }, REFRESH_MS);
  }, [triggerScrape]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    scheduleRefresh();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [scheduleRefresh]);

  const allProjects = useMemo(() => {
    if (!cache) return [];
    const set = new Set<string>();
    cache.recentTickets.forEach((t) => { if (t.project) set.add(t.project); });
    cache.unresolvedTickets.forEach((t) => { if (t.project) set.add(t.project); });
    cache.unrespondedTickets.forEach((t) => { if (t.project) set.add(t.project); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [cache]);

  // ── Derive filter options with counts — date filter applied before counting ───
  const ALL_STATUSES = ["Open", "Responded", "Reopen", "Fixed", "Closed", "Cancelled"];

  const options = useMemo(() => {
    const recent      = cache?.recentTickets     ?? [];
    const unresolved  = cache?.unresolvedTickets ?? [];
    const unresponded = cache?.unrespondedTickets ?? [];

    const { dateFrom, dateTo } = filters;

    const inDateRange = (raw: string) => {
      const d = toDateOnly(raw);
      if (!d) return true;
      if (dateFrom && d < dateFrom) return false;
      if (dateTo   && d > dateTo)   return false;
      return true;
    };

    const dateFilteredRecent  = recent.filter((t) => inDateRange(t.createdDate));
    const dateFilteredPartner = [...unresolved, ...unresponded].filter((t) =>
      inDateRange(t.reportedDate)
    );

    const projectCounts: Record<string, number> = {};
    const typeCounts:    Record<string, number> = {};
    const statusCounts:  Record<string, number> = {};
    const tagCounts:     Record<string, number> = {};

    dateFilteredRecent.filter((t) => !isProjectExcluded(t.project, filters.includedInternalProjects, filters.customExcludedProjects)).forEach((t) => {
      if (t.project) projectCounts[t.project] = (projectCounts[t.project] ?? 0) + 1;
      if (t.task)    typeCounts[t.task]        = (typeCounts[t.task]       ?? 0) + 1;
      if (t.status)  statusCounts[t.status]    = (statusCounts[t.status]   ?? 0) + 1;
      const tag = getProjectTag(t.project, tagMap);
      if (tag) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    });
    dateFilteredPartner.filter((t) => !isProjectExcluded(t.project, filters.includedInternalProjects, filters.customExcludedProjects)).forEach((t) => {
      if (t.project) projectCounts[t.project] = (projectCounts[t.project] ?? 0) + 1;
      if (t.type)    typeCounts[t.type]        = (typeCounts[t.type]       ?? 0) + 1;
      if (t.status)  statusCounts[t.status]    = (statusCounts[t.status]   ?? 0) + 1;
    });

    const toOptions = (counts: Record<string, number>): Option[] =>
      Object.entries(counts)
        .filter(([v]) => v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, count]) => ({ value, count }));

    return {
      projects: toOptions(projectCounts).filter((o) => !isProjectExcluded(o.value, filters.includedInternalProjects, filters.customExcludedProjects)),
      types:    toOptions(typeCounts),
      statuses: ALL_STATUSES.map((s) => ({ value: s, count: statusCounts[s] ?? 0 })),
      tags:     PRODUCT_TAGS.map((t) => ({ value: t, count: tagCounts[t] ?? 0 })),
    };
  }, [cache, filters.dateFrom, filters.dateTo, filters.includedInternalProjects, tagMap]);

  // ── Apply filters ────────────────────────────────────────────────────────────
  const SEV_ORDER: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const STATUS_ORDER: Record<string, number> = { Open: 0, Reopen: 1, Responded: 2, Fixed: 3, Closed: 4, Cancelled: 5 };

  const filteredRecent = useMemo(() => {
    const rows = filterRecent(cache?.recentTickets ?? [], filters, tagMap);
    return [...rows].sort((a, b) => {
      const stA = STATUS_ORDER[a.status] ?? 9;
      const stB = STATUS_ORDER[b.status] ?? 9;
      if (stA !== stB) return stA - stB;
      const sevA = SEV_ORDER[normalizeSeverity(a.severity)] ?? 9;
      const sevB = SEV_ORDER[normalizeSeverity(b.severity)] ?? 9;
      if (sevA !== sevB) return sevA - sevB;
      const dA = toDateOnly(a.createdDate) ?? "";
      const dB = toDateOnly(b.createdDate) ?? "";
      return dB.localeCompare(dA); // newest first
    });
  }, [cache, filters]);
  const sortTicketRows = (rows: import("@/lib/store").TicketRow[]) =>
    [...rows].sort((a, b) => {
      const stA = STATUS_ORDER[a.status] ?? 9;
      const stB = STATUS_ORDER[b.status] ?? 9;
      if (stA !== stB) return stA - stB;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return (toDateOnly(b.reportedDate) ?? "").localeCompare(toDateOnly(a.reportedDate) ?? "");
    });

  // Unresponded — keep partner dashboard source (partner-specific view)
  const filteredUnresponded = useMemo(() => sortTicketRows(filterTicketRows(cache?.unrespondedTickets ?? [], filters, tagMap)), [cache, filters, tagMap]);

  // Unresolved table — derived from filteredRecent so it matches the stat card exactly
  const filteredUnresolved = useMemo<import("@/lib/store").TicketRow[]>(() => {
    const UNRESOLVED = new Set(["Open", "Responded", "Reopen"]);
    const rows = (filteredRecent ?? [])
      .filter((t) => UNRESOLVED.has(t.status))
      .map((t) => ({
        documentNo:   t.ticketNo,
        project:      t.project,
        type:         t.task,
        status:       t.status,
        reportedDate: t.reportedDate || t.createdDate,
      }));
    return sortTicketRows(rows);
  }, [filteredRecent]);

  const fc = activeFilterCount(filters);
  const isFiltered = fc > 0;

  const filterLabel = (() => {
    const parts: string[] = [];
    const dateLabel = DATE_PRESETS.find((p) => p.value === filters.datePreset && filters.datePreset !== "custom")?.label;
    if (dateLabel) parts.push(dateLabel);
    else if (filters.dateFrom || filters.dateTo) {
      parts.push(filters.dateFrom === filters.dateTo && filters.dateFrom
        ? filters.dateFrom
        : [filters.dateFrom, filters.dateTo].filter(Boolean).join(" → "));
    }
    const fixDateLabel = DATE_PRESETS.find((p) => p.value === filters.fixDatePreset && filters.fixDatePreset !== "custom")?.label;
    if (fixDateLabel) parts.push(`Fix: ${fixDateLabel}`);
    else if (filters.fixDateFrom || filters.fixDateTo) {
      parts.push(`Fix: ${[filters.fixDateFrom, filters.fixDateTo].filter(Boolean).join(" → ")}`);
    }
    if (filters.tags.length)      parts.push(filters.tags.join(" / "));
    if (filters.projects.length)  parts.push(`${filters.projects.length} project${filters.projects.length > 1 ? "s" : ""}`);
    if (filters.types.length)     parts.push(`${filters.types.length} type${filters.types.length > 1 ? "s" : ""}`);
    if (filters.statuses.length)  parts.push(`${filters.statuses.length} status${filters.statuses.length > 1 ? "es" : ""}`);
    if (filters.customExcludedProjects.length) parts.push(`${filters.customExcludedProjects.length} excluded`);
    return parts.join(" · ") || "filtered";
  })();

  // Unresolved = Open + Responded + Reopen from the ticket list (not from the partner
  // dashboard table, which can be empty or cover a different period).
  const UNRESOLVED_STATUSES = useMemo(() => new Set(["Open", "Responded", "Reopen"]), []);

  const displayTotals = useMemo(() => {
    const count = (s: string) => filteredRecent.filter((t) => t.status === s).length;
    const unresolved = filteredRecent.filter((t) => UNRESOLVED_STATUSES.has(t.status)).length;
    if (!isFiltered) {
      return cache?.totals
        ? { ...cache.totals, unresolved, unresponded: filteredUnresponded.length }
        : null;
    }
    return {
      all:         filteredRecent.length,
      open:        count("Open"),
      responded:   count("Responded"),
      reopen:      count("Reopen"),
      fixed:       count("Fixed"),
      closed:      count("Closed"),
      cancelled:   count("Cancelled"),
      unresolved,
      unresponded: filteredUnresponded.length,
    };
  }, [isFiltered, cache, filteredRecent, filteredUnresponded, UNRESOLVED_STATUSES]);

  const displayModuleBreakdown = useMemo<ModuleRow[]>(() => {
    if (!isFiltered) return cache?.moduleBreakdown ?? [];
    const groups: Record<string, ModuleRow> = {};
    filteredRecent.forEach((t) => {
      const key = t.module || t.project || "Other";
      if (!groups[key]) groups[key] = { module: key, total: 0, critical: 0, high: 0, medium: 0, low: 0, open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0 };
      const g = groups[key];
      const sev = normalizeSeverity(t.severity);
      g.total++;
      if      (sev === "Critical") g.critical++;
      else if (sev === "High")     g.high++;
      else if (sev === "Medium")   g.medium++;
      else if (sev === "Low")      g.low++;
      if      (t.status === "Open")       g.open++;
      else if (t.status === "Responded")  g.responded++;
      else if (t.status === "Reopen")     g.reopen++;
      else if (t.status === "Fixed")      g.fixed++;
      else if (t.status === "Closed")     g.closed++;
      else if (t.status === "Cancelled")  g.cancelled++;
    });
    return Object.values(groups).sort((a, b) => b.total - a.total);
  }, [isFiltered, filteredRecent, cache]);

  const displaySeverityBreakdown = useMemo<SeverityRow[]>(() => {
    if (!isFiltered) return cache?.severityBreakdown ?? [];
    const ORDER = ["Critical", "High", "Medium", "Low"];
    const groups: Record<string, SeverityRow> = {};
    ORDER.forEach((s) => { groups[s] = { severity: s, open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0 }; });
    filteredRecent.forEach((t) => {
      const sev = normalizeSeverity(t.severity) || "Other";
      if (!groups[sev]) groups[sev] = { severity: sev, open: 0, responded: 0, reopen: 0, fixed: 0, closed: 0, cancelled: 0 };
      const g = groups[sev];
      if      (t.status === "Open")      g.open++;
      else if (t.status === "Responded") g.responded++;
      else if (t.status === "Reopen")    g.reopen++;
      else if (t.status === "Fixed")     g.fixed++;
      else if (t.status === "Closed")    g.closed++;
      else if (t.status === "Cancelled") g.cancelled++;
    });
    return [...ORDER, ...Object.keys(groups).filter((s) => !ORDER.includes(s))]
      .map((s) => groups[s])
      .filter((r) => r && Object.values(r).slice(1).some(Boolean));
  }, [isFiltered, filteredRecent, cache]);

  const tagTotals = useMemo(() => {
    const UNRESOLVED = new Set(["Open", "Responded", "Reopen"]);
    const empty = () => ({ total: 0, open: 0, responded: 0, fixed: 0, closed: 0, unresolved: 0, unresponded: 0, reopen: 0, cancelled: 0 });
    const result = Object.fromEntries(PRODUCT_TAGS.map((t) => [t, empty()])) as Record<ProductTag, ReturnType<typeof empty>>;
    filteredRecent.forEach((ticket) => {
      const tag = getProjectTag(ticket.project, tagMap);
      if (!tag) return;
      result[tag].total++;
      if (ticket.status === "Open")      result[tag].open++;
      if (ticket.status === "Responded") result[tag].responded++;
      if (ticket.status === "Fixed")     result[tag].fixed++;
      if (ticket.status === "Closed")    result[tag].closed++;
      if (ticket.status === "Reopen")    result[tag].reopen++;
      if (ticket.status === "Cancelled") result[tag].cancelled++;
      if (UNRESOLVED.has(ticket.status)) result[tag].unresolved++;
    });
    filteredUnresponded.forEach((ticket) => {
      const tag = getProjectTag(ticket.project, tagMap);
      if (tag) result[tag].unresponded++;
    });
    return result;
  }, [filteredRecent, filteredUnresponded, tagMap]);

  const scrapeDataRange = useMemo(() => {
    const tickets = cache?.recentTickets ?? [];
    const dates = tickets.map((t) => toDateOnly(t.createdDate)).filter(Boolean) as string[];
    if (!dates.length) return null;
    const sorted = [...dates].sort();
    return { from: sorted[0], to: sorted[sorted.length - 1] };
  }, [cache]);

  // Open tickets matching the current filter — used for the persistent status banner
  const bannerTickets = useMemo(() => {
    return filteredRecent.filter((t) => t.status === "Open");
  }, [filteredRecent]);


  const t = displayTotals;

  return (
    <div className={`min-h-screen bg-gray-950 ${bannerTickets.length > 0 && !bannerDismissed ? "pt-9" : ""}`}>
      {/* Persistent rolling ticker — all currently open tickets */}
      {bannerTickets.length > 0 && !bannerDismissed && (
        <div className="fixed top-0 left-0 right-0 z-[60] flex items-center h-9 bg-gray-950 border-b border-red-900/60 overflow-hidden shadow-lg">
          {/* Fixed label — click to open modal */}
          <button
            onClick={() => setShowOpenTicketsModal(true)}
            className="flex items-center gap-2 px-4 h-full bg-red-950/80 border-r border-red-800 shrink-0 hover:bg-red-900/80 transition"
          >
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            <span className="text-red-200 text-[15px] font-bold uppercase tracking-widest whitespace-nowrap">
              {bannerTickets.length} Open
            </span>
          </button>
          {/* Scrolling ticker — duplicated for seamless loop */}
          <div className="flex-1 overflow-hidden relative h-full flex items-center">
            <div className="animate-marquee flex items-center">
              {[...bannerTickets, ...bannerTickets].map((ticket, i) => {
                const tag = getProjectTag(ticket.project, tagMap);
                return (
                  <span key={i} className="flex items-center gap-2 text-[15px] px-6">
                    {tag ? (
                      <span className={`inline-flex px-2 py-0.5 rounded text-[15px] font-bold ${TAG_BANNER_CLS[tag]}`}>
                        {tag}
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded text-[15px] font-bold bg-gray-700 text-gray-400 border border-gray-600">
                        Untagged
                      </span>
                    )}
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-200">{ticket.project}</span>
                    <span className="text-gray-600">·</span>
                    <span className="text-amber-300 font-mono font-semibold">{ticket.ticketNo}</span>
                  </span>
                );
              })}
            </div>
          </div>
          {/* Dismiss */}
          <button
            onClick={() => setBannerDismissed(true)}
            title="Dismiss banner"
            className="px-4 h-full text-red-400 hover:text-white hover:bg-red-900/60 transition shrink-0 text-lg leading-none border-l border-red-900/60"
          >
            ×
          </button>
        </div>
      )}

      {/* Open tickets modal */}
      {showOpenTicketsModal && bannerTickets.length > 0 && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
          <div className="absolute inset-0" onClick={() => setShowOpenTicketsModal(false)} />
          <div className="relative w-full max-w-lg bg-gray-900 border border-red-800 rounded-2xl shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 bg-red-950/70 border-b border-red-800">
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 rounded-full bg-red-400 animate-pulse shrink-0" />
                <div>
                  <p className="text-white font-bold text-[50px] uppercase tracking-widest text-center">Open Tickets</p>
                  <p className="text-red-400 text-xs">{bannerTickets.length} ticket{bannerTickets.length > 1 ? "s" : ""} currently open</p>
                </div>
              </div>
              <button onClick={() => setShowOpenTicketsModal(false)} className="text-red-400 hover:text-white transition text-2xl leading-none">×</button>
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-3 px-5 py-2 border-b border-gray-800 bg-gray-900/80">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Product</span>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Project</span>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Ticket No.</span>
            </div>

            {/* Ticket list */}
            <div className="divide-y divide-gray-800/60 max-h-96 overflow-y-auto">
              {bannerTickets.map((ticket) => {
                const tag = getProjectTag(ticket.project, tagMap);
                return (
                  <div key={ticket.ticketNo} className="grid grid-cols-3 items-center px-5 py-3 hover:bg-gray-800/40 transition gap-3">
                    {/* Product */}
                    <div>
                      {tag ? (
                        <span className={`inline-flex px-2 py-0.5 rounded text-[20px] font-bold ${TAG_BANNER_CLS[tag]}`}>
                          {tag}
                        </span>
                      ) : (
                        <span className="inline-flex px-2 py-0.5 rounded text-[20px] font-bold bg-gray-700 text-gray-400 border border-gray-600">
                          Untagged
                        </span>
                      )}
                    </div>
                    {/* Project */}
                    <p className="text-gray-200 text-[20px] break-words">{ticket.project}</p>
                    {/* Ticket No */}
                    <p className="text-amber-300 font-mono text-[20px] font-semibold">{ticket.ticketNo}</p>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-gray-800 flex gap-2">
              <button
                onClick={() => setShowOpenTicketsModal(false)}
                className="flex-1 py-2 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition"
              >
                Close
              </button>
              {notifPermission !== "unsupported" && notifPermission !== "granted" && (
                <button
                  onClick={async () => {
                    const result = await Notification.requestPermission();
                    setNotifPermission(result);
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 text-sm rounded-lg
                             bg-yellow-600/20 border border-yellow-700 text-yellow-400
                             hover:bg-yellow-600/40 transition"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  Enable Alerts
                </button>
              )}
              {notifPermission === "granted" && (
                <div className="flex-1 flex items-center justify-center gap-1.5 py-2 text-sm rounded-lg
                                bg-green-600/20 border border-green-700 text-green-400">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Alerts Enabled
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* New open ticket popup modal */}
      {showNewTicketModal && newOpenTickets.length > 0 && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowNewTicketModal(false)} />
          <div className="relative w-full max-w-md bg-gray-900 border border-red-700 rounded-2xl shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 bg-red-950/70 border-b border-red-800">
              <div className="flex items-center gap-3">
                <span className="w-3 h-3 rounded-full bg-red-400 animate-pulse shrink-0" />
                <div>
                  <p className="text-white font-bold text-sm">New Open Ticket{newOpenTickets.length > 1 ? "s" : ""} Received</p>
                  <p className="text-red-400 text-xs">{newOpenTickets.length} ticket{newOpenTickets.length > 1 ? "s" : ""} need{newOpenTickets.length === 1 ? "s" : ""} attention</p>
                </div>
              </div>
              <button onClick={() => setShowNewTicketModal(false)} className="text-red-400 hover:text-white transition text-2xl leading-none">×</button>
            </div>

            {/* Ticket list */}
            <div className="divide-y divide-gray-800 max-h-80 overflow-y-auto">
              {newOpenTickets.map((t) => {
                const tag = getProjectTag(t.project, tagMap);
                return (
                  <div key={t.ticketNo} className="px-5 py-3.5 hover:bg-gray-800/40 transition">
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <span className="text-blue-400 font-mono text-sm font-semibold">{t.ticketNo}</span>
                      {tag && <TagBadge tag={tag} />}
                    </div>
                    <p className="text-gray-200 text-sm break-words">{t.project}</p>
                    {t.subject && <p className="text-gray-500 text-xs mt-0.5 break-words">{t.subject}</p>}
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-600">
                      {t.createdDate && <span>Created: {t.createdDate}</span>}
                      {t.severity && <span className={SEV_CLS[normalizeSeverity(t.severity)] ?? "text-gray-500"}>{t.severity}</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-gray-800 flex gap-2">
              <button
                onClick={() => setShowNewTicketModal(false)}
                className="flex-1 py-2 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition"
              >
                Close
              </button>
              <button
                onClick={() => { setShowNewTicketModal(false); setNewOpenTickets([]); }}
                className="flex-1 py-2 text-sm rounded-lg bg-red-700/40 hover:bg-red-700/70 text-red-300 border border-red-700 transition"
              >
                Dismiss All
              </button>
            </div>
          </div>
        </div>
      )}

      {showTagManager && (
        <TagManager
          projects={allProjects}
          tagMap={tagMap}
          onTagChange={updateTag}
          onClose={() => setShowTagManager(false)}
        />
      )}
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
              </svg>
            </div>
            <span className="font-bold text-white text-sm">SunFish Support Dashboard</span>
            <span className="hidden sm:inline text-xs text-gray-500">sfsupport.dataon.com</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cache && <Countdown nextAt={nextAt} />}

            {/* Browser notification permission — always visible */}
            {notifPermission !== "unsupported" && (
              <button
                onClick={async () => {
                  if (notifPermission === "denied") return;
                  if (notifPermission !== "granted") {
                    const result = await Notification.requestPermission();
                    setNotifPermission(result);
                    if (result === "granted") {
                      setAlertsEnabled(true);
                      try { localStorage.setItem("sf-alerts-enabled", "true"); } catch {}
                    }
                    return;
                  }
                  const next = !alertsEnabled;
                  setAlertsEnabled(next);
                  try { localStorage.setItem("sf-alerts-enabled", String(next)); } catch {}
                }}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition ${
                  notifPermission === "denied"
                    ? "bg-red-600/20 border-red-700 text-red-400 cursor-not-allowed"
                    : notifPermission === "granted" && alertsEnabled
                    ? "bg-green-600/20 border-green-700 text-green-400 hover:bg-green-600/40 cursor-pointer"
                    : notifPermission === "granted" && !alertsEnabled
                    ? "bg-gray-700/40 border-gray-600 text-gray-400 hover:bg-gray-700 cursor-pointer"
                    : "bg-yellow-600/20 border-yellow-700 text-yellow-400 hover:bg-yellow-600/40 cursor-pointer"
                }`}
                title={
                  notifPermission === "denied"               ? "Notifications blocked — unblock in browser site settings" :
                  notifPermission === "granted" && alertsEnabled  ? "Alerts on — click to turn off for this browser" :
                  notifPermission === "granted" && !alertsEnabled ? "Alerts off — click to turn on for this browser" :
                  "Enable desktop notifications for new open tickets"
                }
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {notifPermission === "denied" ? "Alerts Blocked" :
                 notifPermission === "granted" && alertsEnabled  ? "Alerts On" :
                 notifPermission === "granted" && !alertsEnabled ? "Alerts Off" :
                 "Enable Alerts"}
              </button>
            )}

            <TicketLocator />

            <button
              onClick={() => setShowTagManager(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700
                         text-gray-400 hover:border-gray-500 hover:text-gray-200 transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              Tags
            </button>

            {/* Filter toggle */}
            <button
              onClick={() => setShowFilters((v) => !v)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition ${
                showFilters || fc > 0
                  ? "bg-teal-600/30 border-teal-600 text-teal-300"
                  : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500"
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
              </svg>
              Filters
              {fc > 0 && (
                <span className="bg-teal-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] font-bold">
                  {fc}
                </span>
              )}
            </button>

            {fc > 0 && (
              <button onClick={() => setFilters(EMPTY_FILTERS)}
                className="text-xs text-gray-500 hover:text-white transition">
                Clear filters
              </button>
            )}

            <button
              onClick={triggerScrape} disabled={scraping}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-teal-600/20
                         hover:bg-teal-600/40 text-teal-400 disabled:opacity-50 transition"
            >
              <svg className={`w-3.5 h-3.5 ${scraping ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {scraping ? "Refreshing…" : "Refresh"}
            </button>
            {username && (
              <div className="hidden sm:flex items-center gap-2 border-l border-gray-700 pl-3">
                <div className="w-6 h-6 rounded-full bg-teal-700 flex items-center justify-center text-[10px] font-bold text-white uppercase shrink-0">
                  {username.charAt(0)}
                </div>
                <span className="text-xs text-gray-300 max-w-[140px] truncate">{username}</span>
              </div>
            )}
            <button onClick={async () => { await fetch("/api/auth", { method: "DELETE" }); router.replace("/"); }}
              className="text-xs text-gray-500 hover:text-white transition">Sign Out</button>
          </div>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-6 py-8 space-y-6">

        {/* Status bar */}
        {cache && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500">
            <span>Last updated: <span className="text-gray-300">{new Date(cache.scrapedAt).toLocaleString()}</span></span>
            {scrapeDataRange && (
              <span>
                Scraped data:{" "}
                <span className="text-gray-300">{scrapeDataRange.from}</span>
                <span className="text-gray-600"> → </span>
                <span className="text-gray-300">{scrapeDataRange.to}</span>
                <span className="text-gray-600"> ({cache.recentTickets.length} tickets)</span>
              </span>
            )}
            {/* Show load button when filter date is earlier than scraped range */}
            {filters.dateFrom && scrapeDataRange && filters.dateFrom < scrapeDataRange.from && (
              <button
                onClick={async () => {
                  setScraping(true);
                  const before = cache?.scrapedAt;
                  await fetch("/api/scrape", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ targetDateFrom: filters.dateFrom }),
                  }).catch(() => {});
                  const poll = async () => {
                    const res  = await fetch("/api/data");
                    const json = await res.json();
                    if (json.cache?.scrapedAt !== before) {
                      setCache(json.cache);
                      if (json.tags) setTagMap(json.tags);
                      setScraping(false); setNextAt(Date.now() + REFRESH_MS);
                    } else setTimeout(poll, 4000);
                  };
                  setTimeout(poll, 4000);
                }}
                disabled={scraping}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium
                           bg-amber-600/20 border border-amber-700 text-amber-400
                           hover:bg-amber-600/40 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <svg className={`w-3 h-3 ${scraping ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {scraping ? "Loading…" : `Load data from ${filters.dateFrom}`}
              </button>
            )}
            {cache.error && (
              <span className="text-amber-400 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {cache.error}
              </span>
            )}
          </div>
        )}

        {/* Filter panel */}
        {showFilters && (
          <FilterPanel filters={filters} onChange={setFilters} options={options} />
        )}

        {/* Loading */}
        {(loading || (!cache && !loading)) && (
          <div className="flex flex-col items-center justify-center py-32 gap-4">
            <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400">{loading ? "Loading dashboard…" : "Fetching data from sfsupport.dataon.com…"}</p>
            {!loading && <p className="text-gray-600 text-sm">This takes about 30–60 seconds</p>}
          </div>
        )}

        {cache && (
          <>
            {/* Overview + By Severity side by side */}
            <section>
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Overview</h2>
                  {isFiltered && (
                    <span className="text-xs text-teal-400 border border-teal-700 rounded px-2 py-0.5">{filterLabel}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {DATE_PRESETS.filter((p) => p.value !== "custom").map((p) => {
                    const active = filters.datePreset === p.value;
                    return (
                      <button
                        key={p.value}
                        onClick={() => {
                          if (active) {
                            setFilters((f) => ({ ...f, datePreset: "", dateFrom: "", dateTo: "" }));
                          } else {
                            const { from, to } = getPresetDates(p.value);
                            setFilters((f) => ({ ...f, datePreset: p.value, dateFrom: from, dateTo: to }));
                          }
                        }}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                          active
                            ? "bg-teal-600 border-teal-500 text-white"
                            : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  {filters.datePreset && (
                    <button
                      onClick={() => setFilters((f) => ({ ...f, datePreset: "", dateFrom: "", dateTo: "" }))}
                      className="text-xs text-gray-500 hover:text-gray-300 transition"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
                {/* Stat cards */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <StatCard label="Total Tickets" value={t?.all ?? 0} accent="border-teal-700" />
                  <StatCard label="Open"       value={t?.open ?? 0}      accent={t?.open ? "border-red-800" : undefined} />
                  <StatCard label="Responded"  value={t?.responded ?? 0} accent="border-yellow-800" />
                  <StatCard label="Fixed"      value={t?.fixed ?? 0}     accent="border-green-800" />
                  <StatCard label="Closed"     value={t?.closed ?? 0} />
                  <div className={`bg-gray-900 border rounded-xl p-5 flex flex-col items-center text-center ${t?.unresolved ? "border-red-800" : "border-gray-800"}`}>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Unresolved</p>
                    <p className="text-[80px] font-bold text-white leading-none">{t?.unresolved ?? 0}</p>
                    <div className="mt-2 space-y-1 w-full">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-500">Open</span>
                        <span className="text-red-400 font-semibold">{t?.open ?? 0}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-500">Responded</span>
                        <span className="text-yellow-300 font-semibold">{t?.responded ?? 0}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-500">Reopen</span>
                        <span className="text-orange-400 font-semibold">{t?.reopen ?? 0}</span>
                      </div>
                    </div>
                  </div>
                  <StatCard label="Unresponded" value={t?.unresponded ?? 0} sub="Partner dashboard" accent={t?.unresponded ? "border-orange-800" : undefined} />
                  {(t?.reopen ?? 0) > 0    && <StatCard label="Reopened"  value={t!.reopen}    accent="border-orange-800" />}
                  {(t?.cancelled ?? 0) > 0 && <StatCard label="Cancelled" value={t!.cancelled} />}
                </div>

                {/* By Severity — same column width as stat cards */}
                {displaySeverityBreakdown.length > 0 && (
                  <SeverityTable rows={displaySeverityBreakdown} />
                )}
              </div>

              {/* By Product */}
              <div className="mt-4 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-800" style={{ background: "linear-gradient(to right, #7f1d1d, #1e3a8a, #7c2d12)" }}>
                  <h3 className="font-bold text-white text-[18px] uppercase tracking-wide text-center">By Product</h3>
                </div>
                <div>
                  <table className="w-full text-[20px] table-fixed">
                    <thead>
                      <tr className="border-b border-gray-800">
                        {["Product", "Total", "Open", "Responded", "Fixed", "Closed", "Unresolved", "Unresponded", "Cancelled"].map((h) => (
                          <th key={h} className="px-2 py-2 text-center text-[16px] font-bold text-gray-400 uppercase tracking-wide first:text-left">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {PRODUCT_TAGS.map((tag) => {
                        const c = tagTotals[tag];
                        const rowBg = tag === "Sunfish 6" ? "bg-red-900/40" : tag === "Sunfish 7" ? "bg-blue-900/40" : "bg-orange-900/40";
                        return (
                          <tr key={tag} className={`border-b border-gray-800/50 transition-colors ${rowBg}`}>
                            <td className="px-2 py-2.5"><TagBadge tag={tag} /></td>
                            <td className="px-2 py-2.5 text-center text-white font-semibold">{c.total}</td>
                            <td className="px-2 py-2.5 text-center">{c.open ? <span className="text-red-400 font-medium">{c.open}</span> : <span className="text-gray-600">—</span>}</td>
                            <td className="px-2 py-2.5 text-center text-yellow-300">{c.responded || <span className="text-gray-600">—</span>}</td>
                            <td className="px-2 py-2.5 text-center text-green-400">{c.fixed || <span className="text-gray-600">—</span>}</td>
                            <td className="px-2 py-2.5 text-center text-gray-400">{c.closed || <span className="text-gray-600">—</span>}</td>
                            <td className="px-2 py-2.5 text-center">{c.unresolved ? <span className="text-red-400 font-medium">{c.unresolved}</span> : <span className="text-gray-600">—</span>}</td>
                            <td className="px-2 py-2.5 text-center">{c.unresponded ? <span className="text-orange-400 font-medium">{c.unresponded}</span> : <span className="text-gray-600">—</span>}</td>
                            <td className="px-2 py-2.5 text-center text-purple-400">{c.cancelled || <span className="text-gray-600">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* Attention Required */}
            {(filteredUnresolved.length > 0 || filteredUnresponded.length > 0) && (
              <section>
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Attention Required</h2>
                  {isFiltered && <span className="text-xs text-teal-400 border border-teal-700 rounded px-2 py-0.5">{filterLabel}</span>}
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <TicketMiniTable rows={filteredUnresolved}  title="Unresolved Tickets"  tagMap={tagMap} breakdown />
                  <TicketMiniTable rows={filteredUnresponded} title="Unresponded Tickets" tagMap={tagMap} />
                </div>
              </section>
            )}

            {/* Statistics — module breakdown only (severity is beside Overview) */}
            {displayModuleBreakdown.length > 0 && (
              <section>
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Statistics</h2>
                  {isFiltered
                    ? <span className="text-xs text-teal-400 border border-teal-700 rounded px-2 py-0.5">{filterLabel}</span>
                    : cache.statisticPeriod && (
                      <span className="text-xs text-gray-600 border border-gray-800 rounded px-2 py-0.5">
                        {cache.statisticPeriod}
                      </span>
                    )
                  }
                </div>
                <ModuleTable rows={displayModuleBreakdown} />
              </section>
            )}

            {/* Recent Tickets */}
            {cache.recentTickets.length > 0 && (
              <section>
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Recent Tickets</h2>
                  {isFiltered && <span className="text-xs text-teal-400 border border-teal-700 rounded px-2 py-0.5">{filterLabel}</span>}
                </div>
                <RecentTable rows={filteredRecent} tagMap={tagMap} />
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
