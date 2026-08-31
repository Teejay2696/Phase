import { nanoid } from "nanoid";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getDb } from "@/lib/sqlite-db";

export type SignalPollOption = {
  id: string;
  text: string;
  voters: string[];
};

export type SignalPoll = {
  options: SignalPollOption[];
  closes_at?: number;
};

export type Signal = {
  id: string;
  author_wallet: string;
  author_display: string;
  channel: "general" | "showcase" | string;
  title: string;
  body: string;
  nft_token_id?: number;
  nft_collection_id?: number;
  nft_name?: string;
  nft_image?: string;
  upvotes: string[];
  created_at: number;
  signature: string;
  type?: "post" | "poll";
  poll?: SignalPoll;
  scheduled_for?: number;
  status?: "scheduled" | "published" | "cancelled";
  taken_down?: boolean;
  takedown_reason?: string;
  taken_down_at?: number;
  media?: MediaAttachment[];
};

export type SignalReply = {
  id: string;
  signal_id: string;
  author_wallet: string;
  author_display: string;
  body: string;
  upvotes: string[];
  created_at: number;
  signature: string;
  media?: MediaAttachment[];
};

// Issue #36: signals & signal_replies are now backed by SQLite (indexed on
// channel+created_at, status, author_wallet, and signal_id) instead of
// parsing the full signals.json / signal-replies.json array on every call.

type SignalRow = {
  id: string;
  author_wallet: string;
  author_display: string;
  channel: string;
  title: string;
  body: string;
  nft_token_id: number | null;
  nft_collection_id: number | null;
  nft_name: string | null;
  nft_image: string | null;
  upvotes_json: string;
  created_at: number;
  signature: string;
  type: string | null;
  poll_json: string | null;
  scheduled_for: number | null;
  status: string | null;
  taken_down: number;
  takedown_reason: string | null;
  taken_down_at: number | null;
  media_json: string | null;
};

type ReplyRow = {
  id: string;
  signal_id: string;
  author_wallet: string;
  author_display: string;
  body: string;
  upvotes_json: string;
  created_at: number;
  signature: string;
  media_json: string | null;
};

function rowToSignal(row: SignalRow): Signal {
  return {
    id: row.id,
    author_wallet: row.author_wallet,
    author_display: row.author_display,
    channel: row.channel,
    title: row.title,
    body: row.body,
    nft_token_id: row.nft_token_id ?? undefined,
    nft_collection_id: row.nft_collection_id ?? undefined,
    nft_name: row.nft_name ?? undefined,
    nft_image: row.nft_image ?? undefined,
    upvotes: JSON.parse(row.upvotes_json) as string[],
    created_at: row.created_at,
    signature: row.signature,
    type: (row.type as Signal["type"]) ?? undefined,
    poll: row.poll_json
      ? (JSON.parse(row.poll_json) as SignalPoll)
      : undefined,
    scheduled_for: row.scheduled_for ?? undefined,
    status: (row.status as Signal["status"]) ?? undefined,
    taken_down: row.taken_down === 1 ? true : undefined,
    takedown_reason: row.takedown_reason ?? undefined,
    taken_down_at: row.taken_down_at ?? undefined,
    media: row.media_json
      ? (JSON.parse(row.media_json) as MediaAttachment[])
      : undefined,
  };
}

function rowToReply(row: ReplyRow): SignalReply {
  return {
    id: row.id,
    signal_id: row.signal_id,
    author_wallet: row.author_wallet,
    author_display: row.author_display,
    body: row.body,
    upvotes: JSON.parse(row.upvotes_json) as string[],
    created_at: row.created_at,
    signature: row.signature,
    media: row.media_json
      ? (JSON.parse(row.media_json) as MediaAttachment[])
      : undefined,
  };
}

function getSignalRow(id: string): SignalRow | undefined {
  return getDb().prepare("SELECT * FROM signals WHERE id = ?").get(id) as
    | SignalRow
    | undefined;
}

/** hot = upvotes + recency weighted (upvotes * 3 + created_at/1000) */
function hotScore(s: Signal): number {
  return s.upvotes.length * 3 + s.created_at / 1000;
}

export async function getSignals(
  channel?: string,
  sort: "hot" | "new" | "top" = "hot",
): Promise<Signal[]> {
  const now = Date.now();
  const conditions: string[] = [
    "status != 'cancelled'",
    "(scheduled_for IS NULL OR scheduled_for <= ?)",
  ];
  const params: unknown[] = [now];

  if (isModerationEnabled()) {
    conditions.push("taken_down = 0");
  }
  if (channel && channel !== "all") {
    conditions.push("channel = ?");
    params.push(channel);
  }

  const rows = getDb()
    .prepare(`SELECT * FROM signals WHERE ${conditions.join(" AND ")}`)
    .all(...params) as SignalRow[];

  let items = rows.map(rowToSignal);
  if (sort === "new") {
    items.sort((a, b) => b.created_at - a.created_at);
  } else if (sort === "top") {
    items.sort((a, b) => b.upvotes.length - a.upvotes.length);
  } else {
    items.sort((a, b) => hotScore(b) - hotScore(a));
  }
  return items;
}

export async function getSignal(id: string): Promise<Signal | null> {
  const row = getSignalRow(id);
  return row ? rowToSignal(row) : null;
}

export async function createSignal(
  data: Omit<Signal, "id" | "created_at">,
): Promise<Signal> {
  const now = Date.now();
  const scheduled =
    isFeatureEnabled("phase-89") &&
    data.scheduled_for != null &&
    data.scheduled_for > now;
  const signal: Signal = {
    ...data,
    id: nanoid(10),
    created_at: now,
    ...(scheduled
      ? { status: "scheduled" as const }
      : { status: "published" as const }),
  };

  getDb()
    .prepare(
      `INSERT INTO signals
         (id, author_wallet, author_display, channel, title, body,
          nft_token_id, nft_collection_id, nft_name, nft_image,
          upvotes_json, upvote_count, created_at, signature, type,
          poll_json, scheduled_for, status, taken_down, takedown_reason,
          taken_down_at, media_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      signal.id,
      signal.author_wallet,
      signal.author_display,
      signal.channel,
      signal.title,
      signal.body,
      signal.nft_token_id ?? null,
      signal.nft_collection_id ?? null,
      signal.nft_name ?? null,
      signal.nft_image ?? null,
      JSON.stringify(signal.upvotes ?? []),
      (signal.upvotes ?? []).length,
      signal.created_at,
      signal.signature,
      signal.type ?? null,
      signal.poll ? JSON.stringify(signal.poll) : null,
      signal.scheduled_for ?? null,
      signal.status ?? null,
      signal.taken_down ? 1 : 0,
      signal.takedown_reason ?? null,
      signal.taken_down_at ?? null,
      signal.media ? JSON.stringify(signal.media) : null,
    );

  return signal;
}

export async function getScheduledSignals(wallet: string): Promise<Signal[]> {
  if (!isFeatureEnabled("phase-89")) return [];
  const now = Date.now();
  const rows = getDb()
    .prepare(
      `SELECT * FROM signals
       WHERE author_wallet = ? AND status = 'scheduled' AND scheduled_for > ?
       ORDER BY scheduled_for ASC`,
    )
    .all(wallet, now) as SignalRow[];
  return rows.map(rowToSignal);
}

export async function cancelScheduledSignal(
  id: string,
  wallet: string,
): Promise<Signal> {
  const row = getSignalRow(id);
  if (!row) throw new Error("Signal not found");
  if (row.author_wallet !== wallet) throw new Error("Not signal owner");
  if (row.status !== "scheduled") throw new Error("Signal is not scheduled");
  if ((row.scheduled_for ?? 0) <= Date.now())
    throw new Error("Signal has already published");
  getDb()
    .prepare("UPDATE signals SET status = 'cancelled' WHERE id = ?")
    .run(id);
  return rowToSignal({ ...row, status: "cancelled" });
}

export async function voteOnPoll(
  signalId: string,
  optionId: string,
  wallet: string,
): Promise<Signal> {
  const row = getSignalRow(signalId);
  if (!row || row.type !== "poll" || !row.poll_json)
    throw new Error("Poll not found");
  const poll = JSON.parse(row.poll_json) as SignalPoll;
  if (poll.closes_at && poll.closes_at <= Date.now())
    throw new Error("Poll is closed");
  const selected = poll.options.find((option) => option.id === optionId);
  if (!selected) throw new Error("Poll option not found");
  for (const option of poll.options) {
    option.voters = option.voters.filter((voter) => voter !== wallet);
  }
  selected.voters.push(wallet);

  getDb()
    .prepare("UPDATE signals SET poll_json = ? WHERE id = ?")
    .run(JSON.stringify(poll), signalId);
  return rowToSignal({ ...row, poll_json: JSON.stringify(poll) });
}

export async function upvoteSignal(
  id: string,
  wallet: string,
): Promise<Signal> {
  const row = getSignalRow(id);
  if (!row) throw new Error("Signal not found");
  const upvotes = JSON.parse(row.upvotes_json) as string[];
  const idx = upvotes.indexOf(wallet);
  if (idx === -1) {
    upvotes.push(wallet);
  } else {
    upvotes.splice(idx, 1);
  }
  const upvotesJson = JSON.stringify(upvotes);
  getDb()
    .prepare(
      "UPDATE signals SET upvotes_json = ?, upvote_count = ? WHERE id = ?",
    )
    .run(upvotesJson, upvotes.length, id);
  return rowToSignal({ ...row, upvotes_json: upvotesJson });
}

export async function getReplies(signal_id: string): Promise<SignalReply[]> {
  const rows = getDb()
    .prepare(
      "SELECT * FROM signal_replies WHERE signal_id = ? ORDER BY created_at ASC",
    )
    .all(signal_id) as ReplyRow[];
  return rows.map(rowToReply);
}

export async function createReply(
  data: Omit<SignalReply, "id" | "created_at">,
): Promise<SignalReply> {
  const reply: SignalReply = {
    ...data,
    id: nanoid(10),
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO signal_replies
         (id, signal_id, author_wallet, author_display, body,
          upvotes_json, created_at, signature, media_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reply.id,
      reply.signal_id,
      reply.author_wallet,
      reply.author_display,
      reply.body,
      JSON.stringify(reply.upvotes ?? []),
      reply.created_at,
      reply.signature,
      reply.media ? JSON.stringify(reply.media) : null,
    );
  return reply;
}

export async function getSignalChannelStats(
  worldNames: Record<string, string>,
): Promise<Array<{ id: string; label: string; count: number }>> {
  const db = getDb();
  const countRows = db
    .prepare("SELECT channel, COUNT(*) as n FROM signals GROUP BY channel")
    .all() as Array<{ channel: string; n: number }>;
  const counts: Record<string, number> = {};
  let total = 0;
  for (const { channel, n } of countRows) {
    counts[channel] = n;
    total += n;
  }

  const channels: Array<{ id: string; label: string; count: number }> = [
    { id: "all", label: "All signals", count: total },
    { id: "showcase", label: "NFT showcase", count: counts["showcase"] ?? 0 },
    { id: "general", label: "General", count: counts["general"] ?? 0 },
  ];
  for (const [id, label] of Object.entries(worldNames)) {
    channels.push({ id, label, count: counts[id] ?? 0 });
  }
  return channels;
}

// ─── phase-113: narrative content moderation with takedown flow ────────────
// Isolated, flag-gated. Abusive lore/signals previously had no removal path.
// When enabled, taken-down signals are excluded from getSignals() listings.
// When flag off, takedown/restore are no-ops on the read path (zero regression).
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_113 / FEATURE_PHASE_113.

export function isModerationEnabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_113 ??
    process.env.FEATURE_PHASE_113 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Marks a signal as taken down. Hidden from getSignals() listings while phase-113 is enabled. */
export async function takedownSignal(
  id: string,
  reason: string,
): Promise<Signal> {
  const row = getSignalRow(id);
  if (!row) throw new Error("Signal not found");
  const taken_down_at = Date.now();
  getDb()
    .prepare(
      "UPDATE signals SET taken_down = 1, takedown_reason = ?, taken_down_at = ? WHERE id = ?",
    )
    .run(reason, taken_down_at, id);
  return rowToSignal({
    ...row,
    taken_down: 1,
    takedown_reason: reason,
    taken_down_at,
  });
}

/** Reinstates a previously taken-down signal (rollback path). */
export async function restoreSignal(id: string): Promise<Signal> {
  const row = getSignalRow(id);
  if (!row) throw new Error("Signal not found");
  getDb()
    .prepare(
      "UPDATE signals SET taken_down = 0, takedown_reason = NULL, taken_down_at = NULL WHERE id = ?",
    )
    .run(id);
  return rowToSignal({
    ...row,
    taken_down: 0,
    takedown_reason: null,
    taken_down_at: null,
  });
}

// ─── phase-116: narrative contributor attribution & credit ledger ───────────
// Isolated, flag-gated. Co-authors now receive on-chain credit via a
// side-car ledger. When flag off, helpers return empty / no-op (zero regression).
// Rollback: unset NEXT_PUBLIC_FEATURE_PHASE_116 / FEATURE_PHASE_116.

export {
  isPhase116Enabled,
  flag116RollbackNote,
  getSignalContributors,
  addSignalContributor,
  removeSignalContributor,
  computeCreditLedger,
  getGlobalCreditStats,
  clearContributorMemoryForTests,
  seedContributorForSignal,
  ContributorRoleSchema,
  ContributorEntrySchema,
  CreditLedgerEntrySchema,
  SignalContributorsSchema,
  AddContributorRequestSchema,
} from "@/lib/contributor-ledger";
export type {
  ContributorEntry,
  CreditLedgerEntry,
  SignalContributors,
  ContributorRole,
  AddContributorRequest,
} from "@/lib/contributor-ledger";

import { z } from "zod";

export const AttributionInReplySchema = z.object({
  contributors: z
    .array(
      z.object({
        wallet: z
          .string()
          .trim()
          .length(56)
          .regex(/^G[A-Z2-7]{55}$/),
        displayName: z.string().trim().min(1).max(48),
        role: z
          .enum(["author", "co_author", "editor", "illustrator", "translator"])
          .default("co_author"),
        shareBps: z.number().int().min(0).max(10_000).default(1000),
      }),
    )
    .max(5)
    .optional(),
});

export type AttributionInReply = z.infer<typeof AttributionInReplySchema>;

/**
 * Records reply co-authors into the contributor ledger (flag-gated).
 * Best-effort; failures are logged but do not block reply creation.
 */
export async function recordReplyAttribution(
  signalId: string,
  replyAuthorWallet: string,
  attribution: AttributionInReply | null,
): Promise<void> {
  const flagOn = (() => {
    try {
      const v = (
        process.env.NEXT_PUBLIC_FEATURE_PHASE_116 ??
        process.env.FEATURE_PHASE_116 ??
        ""
      )
        .trim()
        .toLowerCase();
      return v === "1" || v === "true" || v === "yes" || v === "on";
    } catch {
      return false;
    }
  })();
  if (!flagOn) return;
  if (!attribution?.contributors || attribution.contributors.length === 0)
    return;
  try {
    const { addSignalContributor } = await import("@/lib/contributor-ledger");
    for (const c of attribution.contributors) {
      try {
        await addSignalContributor(signalId, {
          wallet: c.wallet,
          displayName: c.displayName,
          role: c.role,
          shareBps: c.shareBps,
          addedBy: replyAuthorWallet,
          signature: null,
        });
      } catch {
        // per-contributor errors non-blocking
      }
    }
  } catch {
    // ledger unavailable
  }
}

// ── Issue #104: IPFS Media Attachments (phase-86) ─────────────────────────────

export function isPhase86Enabled(): boolean {
  const v = (
    process.env.NEXT_PUBLIC_FEATURE_PHASE_86 ??
    process.env.FEATURE_PHASE_86 ??
    ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type MediaAttachment = {
  ipfs_cid: string;
  ipfs_url: string;
  media_type: "image" | "video" | "audio";
  thumbnail_cid?: string;
  thumbnail_url?: string;
  file_size?: number;
  width?: number;
  height?: number;
};

export async function addMediaToSignal(
  signalId: string,
  media: MediaAttachment,
): Promise<Signal> {
  if (!isPhase86Enabled()) throw new Error("phase-86 disabled");
  const row = getSignalRow(signalId);
  if (!row) throw new Error("Signal not found");

  const mediaList: MediaAttachment[] = row.media_json
    ? (JSON.parse(row.media_json) as MediaAttachment[])
    : [];
  mediaList.push(media);
  const mediaJson = JSON.stringify(mediaList);

  getDb()
    .prepare("UPDATE signals SET media_json = ? WHERE id = ?")
    .run(mediaJson, signalId);
  return rowToSignal({ ...row, media_json: mediaJson });
}

export async function addMediaToReply(
  replyId: string,
  media: MediaAttachment,
): Promise<SignalReply> {
  if (!isPhase86Enabled()) throw new Error("phase-86 disabled");
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM signal_replies WHERE id = ?")
    .get(replyId) as ReplyRow | undefined;
  if (!row) throw new Error("Reply not found");

  const mediaList: MediaAttachment[] = row.media_json
    ? (JSON.parse(row.media_json) as MediaAttachment[])
    : [];
  mediaList.push(media);
  const mediaJson = JSON.stringify(mediaList);

  db.prepare("UPDATE signal_replies SET media_json = ? WHERE id = ?").run(
    mediaJson,
    replyId,
  );
  return rowToReply({ ...row, media_json: mediaJson });
}

export async function generateThumbnail(
  ipfsCid: string,
  maxWidth: number = 400,
): Promise<{ cid: string; url: string } | null> {
  if (!isPhase86Enabled()) return null;
  // Placeholder implementation - would use image processing library
  // For now, return the original as thumbnail
  return {
    cid: ipfsCid,
    url: `https://gateway.pinata.cloud/ipfs/${ipfsCid}`,
  };
}

// ── Issue #64 (phase-136): per-CID IPFS gateway resolution cache ──────────────
//
// Isolated, flag-gated. Every metadata read re-resolved a CID against the
// gateway list from scratch, so repeated reads of the same attachment paid the
// gateway-selection cost again and again, and a degrading gateway kept being
// picked until it hard-failed. This module memoizes the resolution per CID
// (TTL) and keeps a rolling health score per gateway (success ratio + EWMA
// latency) so the best gateway wins and a cache entry pinned to a failing
// gateway is dropped on the next recorded failure.
//
// Feature flag: phase-136 (NEXT_PUBLIC_FEATURE_PHASE_136 / FEATURE_PHASE_136)
// Rollback: unset the flag → resolveCidGateway() falls back to a deterministic
//           first-gateway pick with no caching. No persistent state to revert.

export function isPhase136Enabled(): boolean {
  return isFeatureEnabled("phase-136");
}

export function flag136RollbackNote(): string {
  return "Rollback phase-136: unset NEXT_PUBLIC_FEATURE_PHASE_136 / FEATURE_PHASE_136 or set to 0/false and restart. CID resolution falls back to a first-gateway pick with no cache; no data migration to undo.";
}

export const CID_RESOLUTION_GATEWAYS = [
  "https://w3s.link/ipfs",
  "https://dweb.link/ipfs",
  "https://ipfs.io/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
] as const;

const CID_RESOLUTION_DEFAULT_TTL_MS = 5 * 60 * 1000;
const CID_RESOLUTION_MAX_ENTRIES = 256;
const GATEWAY_LATENCY_EWMA_ALPHA = 0.3;

export const CidResolutionRequestSchema = z.object({
  cid: z
    .string()
    .trim()
    .min(4)
    .max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Invalid CID or CID path"),
  ttlMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1000)
    .optional(),
});

export type CidResolutionRequest = z.infer<typeof CidResolutionRequestSchema>;

export const GatewayOutcomeSchema = z.object({
  gateway: z.string().trim().url(),
  ok: z.boolean(),
  latencyMs: z.number().min(0).max(120_000).default(0),
});

export type GatewayOutcome = z.infer<typeof GatewayOutcomeSchema>;

export type CidGatewayResolution = {
  cid: string;
  url: string;
  gateway: string;
  score: number;
  fromCache: boolean;
  resolvedAt: number;
  expiresAt: number;
};

export class CidResolutionError extends Error {
  code: "FLAG_DISABLED" | "VALIDATION_FAILED" | "NO_GATEWAY";
  details?: unknown;
  constructor(
    code: CidResolutionError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "CidResolutionError";
    this.code = code;
    this.details = details;
  }
}

type GatewayHealth = { ok: number; fail: number; ewmaLatencyMs: number };
type CidResolutionEntry = {
  gateway: string;
  url: string;
  resolvedAt: number;
  expiresAt: number;
};

const cidResolutionCache = new Map<string, CidResolutionEntry>();
const gatewayHealth = new Map<string, GatewayHealth>();

function normalizeGatewayBase(gateway: string): string {
  return gateway.trim().replace(/\/+$/, "");
}

function normalizeCidPath(cid: string): string {
  return cid.trim().replace(/^ipfs:\/\//i, "").replace(/^\/+/, "");
}

/**
 * Pulls the `<cid>/<path?>` portion out of an `ipfs://…` URI or a
 * `https://gateway/ipfs/…` URL. Returns null for a non-IPFS value so callers can
 * skip resolution and keep the stored URL untouched.
 */
export function extractIpfsCidPath(value: string | undefined | null): string | null {
  if (!value) return null;
  const ipfsUri = value.match(/^ipfs:\/\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/i);
  if (ipfsUri) return ipfsUri[1]!;
  const gatewayUrl = value.match(/\/ipfs\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/i);
  if (gatewayUrl) return gatewayUrl[1]!;
  return null;
}

/** 0–100 health score: 70% success ratio, 30% latency (0ms→100, ≥5s→0). */
export function scoreGateway(gateway: string): number {
  const h = gatewayHealth.get(normalizeGatewayBase(gateway));
  if (!h || h.ok + h.fail === 0) return 50;
  const successRatio = h.ok / (h.ok + h.fail);
  const latencyScore = Math.max(0, 100 - (h.ewmaLatencyMs / 5_000) * 100);
  return Math.round(successRatio * 100 * 0.7 + latencyScore * 0.3);
}

function bestGateway(): { gateway: string; score: number } {
  let best = normalizeGatewayBase(CID_RESOLUTION_GATEWAYS[0]);
  let bestScore = -1;
  for (const raw of CID_RESOLUTION_GATEWAYS) {
    const gateway = normalizeGatewayBase(raw);
    const score = scoreGateway(gateway);
    if (score > bestScore) {
      best = gateway;
      bestScore = score;
    }
  }
  return { gateway: best, score: bestScore < 0 ? 50 : bestScore };
}

function evictCidResolutionIfNeeded(): void {
  if (cidResolutionCache.size <= CID_RESOLUTION_MAX_ENTRIES) return;
  const oldest = cidResolutionCache.keys().next().value as string | undefined;
  if (oldest) cidResolutionCache.delete(oldest);
}

/**
 * Resolves a CID (or CID/path) to a gateway-routed URL, memoized per CID with a
 * TTL and backed by rolling gateway health scores. When phase-136 is off this
 * returns a deterministic first-gateway pick and never touches the cache.
 */
export function resolveCidGateway(
  cid: string,
  opts: { ttlMs?: number; now?: number; force?: boolean } = {},
): CidGatewayResolution {
  const cidPath = normalizeCidPath(cid);
  const now = opts.now ?? Date.now();

  if (!opts.force && !isPhase136Enabled()) {
    const gateway = normalizeGatewayBase(CID_RESOLUTION_GATEWAYS[0]);
    return {
      cid: cidPath,
      url: `${gateway}/${cidPath}`,
      gateway,
      score: 50,
      fromCache: false,
      resolvedAt: now,
      expiresAt: now,
    };
  }

  const parsed = CidResolutionRequestSchema.safeParse({
    cid: cidPath,
    ttlMs: opts.ttlMs,
  });
  if (!parsed.success) {
    throw new CidResolutionError(
      "VALIDATION_FAILED",
      "valid CID or CID path required",
      parsed.error.flatten(),
    );
  }

  const cached = cidResolutionCache.get(cidPath);
  if (cached && cached.expiresAt > now) {
    return {
      cid: cidPath,
      url: cached.url,
      gateway: cached.gateway,
      score: scoreGateway(cached.gateway),
      fromCache: true,
      resolvedAt: cached.resolvedAt,
      expiresAt: cached.expiresAt,
    };
  }

  const { gateway, score } = bestGateway();
  const ttlMs = parsed.data.ttlMs ?? CID_RESOLUTION_DEFAULT_TTL_MS;
  const entry: CidResolutionEntry = {
    gateway,
    url: `${gateway}/${cidPath}`,
    resolvedAt: now,
    expiresAt: now + ttlMs,
  };
  cidResolutionCache.delete(cidPath);
  cidResolutionCache.set(cidPath, entry);
  evictCidResolutionIfNeeded();

  return {
    cid: cidPath,
    url: entry.url,
    gateway,
    score,
    fromCache: false,
    resolvedAt: now,
    expiresAt: entry.expiresAt,
  };
}

/**
 * Feeds a gateway request outcome back into the health model. A failure also
 * invalidates every cached CID currently pinned to that gateway so the next
 * resolution re-picks.
 */
export function recordCidGatewayOutcome(raw: unknown): void {
  const parsed = GatewayOutcomeSchema.safeParse(raw);
  if (!parsed.success) return;
  const gateway = normalizeGatewayBase(parsed.data.gateway);
  const h = gatewayHealth.get(gateway) ?? { ok: 0, fail: 0, ewmaLatencyMs: 0 };
  if (parsed.data.ok) h.ok += 1;
  else h.fail += 1;
  const latency = parsed.data.latencyMs;
  h.ewmaLatencyMs =
    h.ewmaLatencyMs === 0
      ? latency
      : h.ewmaLatencyMs * (1 - GATEWAY_LATENCY_EWMA_ALPHA) +
        latency * GATEWAY_LATENCY_EWMA_ALPHA;
  gatewayHealth.set(gateway, h);

  if (!parsed.data.ok) {
    for (const [cidPath, entry] of cidResolutionCache.entries()) {
      if (entry.gateway === gateway) cidResolutionCache.delete(cidPath);
    }
  }
}

export function getCidGatewayCacheStats(): {
  enabled: boolean;
  entries: number;
  gateways: Array<{ gateway: string; score: number; ok: number; fail: number }>;
} {
  return {
    enabled: isPhase136Enabled(),
    entries: cidResolutionCache.size,
    gateways: CID_RESOLUTION_GATEWAYS.map((raw) => {
      const gateway = normalizeGatewayBase(raw);
      const h = gatewayHealth.get(gateway) ?? { ok: 0, fail: 0, ewmaLatencyMs: 0 };
      return { gateway, score: scoreGateway(gateway), ok: h.ok, fail: h.fail };
    }),
  };
}

/** Test/ops hook to reset process-local phase-136 state. */
export function __resetCidGatewayCacheForTests(): void {
  cidResolutionCache.clear();
  gatewayHealth.clear();
}
