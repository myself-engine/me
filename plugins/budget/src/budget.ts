// Budget rules: per-day delegation caps and per-provider quota floors.
// Pure functions only (no kernel, no spawn), so tests run with a fake clock and canned meter output.

export interface BudgetConfig {
  dailyCap: number;
  autoApplyCap: number;
  minRemainingPercent: number;
  hardStopPercent: number;
  meterCmd: string[];
  meterTimeoutMs: number;
  cacheSec: number;
  /** harness id -> meter provider, e.g. {"local.codex": "codex"}. */
  providers: Record<string, string>;
  opencodeProvider: string;
  opencodeModelPrefix: string;
}

export const DEFAULT_CONFIG: BudgetConfig = {
  dailyCap: 30,
  autoApplyCap: 10,
  minRemainingPercent: 10,
  hardStopPercent: 3,
  meterCmd: ["meter", "status", "--json"],
  meterTimeoutMs: 5000,
  cacheSec: 60,
  providers: { "local.codex": "codex", "local.claude-code": "claude" },
  opencodeProvider: "opencode-go",
  opencodeModelPrefix: "opencode-go",
};

export function parseConfig(raw: unknown): BudgetConfig {
  const c = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);
  const arr = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === "string") ? (v as string[]) : fallback;
  const rec = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string" && val) out[k] = val;
    }
    return out;
  };
  return {
    dailyCap: num(c.dailyCap, DEFAULT_CONFIG.dailyCap),
    autoApplyCap: num(c.autoApplyCap, DEFAULT_CONFIG.autoApplyCap),
    minRemainingPercent: num(c.minRemainingPercent, DEFAULT_CONFIG.minRemainingPercent),
    hardStopPercent: num(c.hardStopPercent, DEFAULT_CONFIG.hardStopPercent),
    meterCmd: arr(c.meterCmd, DEFAULT_CONFIG.meterCmd),
    meterTimeoutMs: num(c.meterTimeoutMs, DEFAULT_CONFIG.meterTimeoutMs),
    cacheSec: num(c.cacheSec, DEFAULT_CONFIG.cacheSec),
    providers: { ...DEFAULT_CONFIG.providers, ...rec(c.providers) },
    opencodeProvider: str(c.opencodeProvider, DEFAULT_CONFIG.opencodeProvider),
    opencodeModelPrefix: str(c.opencodeModelPrefix, DEFAULT_CONFIG.opencodeModelPrefix),
  };
}

export interface MeterBucket {
  id?: unknown;
  label?: unknown;
  limit?: unknown;
  remaining?: unknown;
  unit?: unknown;
  used?: unknown;
  resetAt?: unknown;
}

export interface MeterSnapshot {
  provider: string;
  state?: string;
  buckets: MeterBucket[];
}

/** Parses `meter status --json`: {snapshots: [{provider, state, buckets: [{id,label,limit,remaining,unit,used,resetAt}]}]}. */
export function parseMeterOutput(text: string): MeterSnapshot[] {
  const doc = JSON.parse(text) as { snapshots?: unknown };
  const snaps = Array.isArray(doc) ? doc : doc?.snapshots;
  if (!Array.isArray(snaps)) throw new Error("meter output has no snapshots array");
  return snaps
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as { provider?: unknown }).provider === "string")
    .map((s) => ({
      provider: s.provider as string,
      ...(typeof s.state === "string" ? { state: s.state } : {}),
      buckets: Array.isArray(s.buckets) ? (s.buckets as MeterBucket[]) : [],
    }));
}

export interface ProviderUsage {
  provider: string;
  bucket: string;
  remainingPercent: number;
  resetAt?: string;
}

/** Buckets without a positive numeric limit/remaining pair (e.g. spend totals) are skipped. */
export function usagesFor(snapshots: MeterSnapshot[], provider: string): ProviderUsage[] {
  const snap = snapshots.find((s) => s.provider === provider);
  if (!snap) return [];
  const out: ProviderUsage[] = [];
  for (const b of snap.buckets) {
    if (typeof b.limit !== "number" || typeof b.remaining !== "number" || !(b.limit > 0)) continue;
    out.push({
      provider,
      bucket: typeof b.label === "string" && b.label ? b.label : typeof b.id === "string" ? b.id : "",
      remainingPercent: (b.remaining / b.limit) * 100,
      ...(typeof b.resetAt === "string" ? { resetAt: b.resetAt } : {}),
    });
  }
  return out;
}

const PROVIDER_KO: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  "command-code": "Command Code",
  "opencode-go": "Opencode",
};

export function providerKo(provider: string): string {
  return PROVIDER_KO[provider] ?? provider;
}

/** Meter labels are English ("Weekly", "5-hour"); the user reads Korean. Unknown labels pass through. */
export function bucketKo(label: string): string {
  const l = label.toLowerCase();
  if (l.startsWith("weekly")) return "주간";
  if (l.startsWith("monthly")) return "월간";
  if (l.startsWith("daily")) return "일간";
  if (l === "5-hour" || l === "five-hour") return "5시간";
  if (l.startsWith("session")) return "세션";
  return label;
}

export interface QuotaVerdict {
  ok: boolean;
  needsApproval?: true;
  reason?: string;
  worst?: ProviderUsage;
}

/** Below minRemainingPercent the user is asked; below hardStopPercent delegation stops. */
export function evaluateQuota(usages: ProviderUsage[], cfg: BudgetConfig): QuotaVerdict {
  if (usages.length === 0) return { ok: true };
  let worst = usages[0] as ProviderUsage;
  for (const u of usages) {
    if (u.remainingPercent < worst.remainingPercent) worst = u;
  }
  const where = `${providerKo(worst.provider)}${worst.bucket ? ` ${bucketKo(worst.bucket)}` : ""} 한도가 ${Math.floor(worst.remainingPercent)}% 남았어요`;
  if (worst.remainingPercent < cfg.hardStopPercent) return { ok: false, reason: `${where} · 위임을 멈췄어요`, worst };
  if (worst.remainingPercent < cfg.minRemainingPercent)
    return { ok: true, needsApproval: true, reason: `${where} · 계속할까요?`, worst };
  return { ok: true, worst };
}

/** Maps a harness (and, for gjc/opencode, the model id) to a meter provider. Null means "no quota to check". */
export function harnessProvider(harness: unknown, model: unknown, cfg: BudgetConfig): string | null {
  if (typeof harness === "string" && cfg.providers[harness]) return cfg.providers[harness] as string;
  if (typeof model === "string" && model.startsWith(cfg.opencodeModelPrefix)) return cfg.opencodeProvider;
  return null;
}

/** Local calendar day (YYYY-MM-DD) so caps reset at local midnight. */
export function localDay(nowMs: number): string {
  const d = new Date(nowMs);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function capReason(kind: "delegations" | "auto", count: number, cap: number): string {
  return kind === "delegations"
    ? `오늘 위임 ${count}건이 한도(${cap}건)에 닿았어요 · 내일 다시 시작해요`
    : `오늘 자동 적용 ${count}건이 한도(${cap}건)에 닿았어요 · 직접 확인해 주세요`;
}
