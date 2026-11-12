/**
 * CNR lookup, case monitoring and webhook types, plus the two client side
 * helpers that do not need a network call: `normalizeCnr` and
 * `verifyWebhookSignature`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* CNR normalisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A canonical CNR is 16 characters: a 6 character establishment code that
 * begins with a 2 letter state code (almost always 4 letters then 2 digits,
 * for example `DLHC01`), 6 serial digits and a 4 digit year.
 */
const CNR_PATTERN = /^[A-Z]{2}[A-Z0-9]{4}[0-9]{10}$/;

/**
 * Normalises a CNR the way the server does: trims, uppercases, removes
 * spaces, hyphens, slashes, dots and colons, and drops a leading `CNR`,
 * `CNR:`, `CNR NO` or `CNR NUMBER` label. Returns the canonical 16 character form, or
 * `null` when the input cannot be a CNR.
 *
 * The server is the authority; this exists so you can validate input before
 * spending a request.
 *
 * @example
 * normalizeCnr("CNR: DLHC-01-008421-2021"); // "DLHC010084212021"
 */
export function normalizeCnr(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toUpperCase().replace(/[\s\-/.:]+/g, "");
  if (!CNR_PATTERN.test(value)) {
    if (value.startsWith("CNRNUMBER")) value = value.slice(9);
    else if (value.startsWith("CNRNO")) value = value.slice(5);
    else if (value.startsWith("CNR")) value = value.slice(3);
  }
  return CNR_PATTERN.test(value) ? value : null;
}

/** Like `normalizeCnr` but throws a `TypeError` for input that cannot be a CNR. */
export function assertCnr(input: unknown): string {
  const cnr = normalizeCnr(input);
  if (cnr === null) {
    throw new TypeError("Not a valid CNR: expected 16 characters, for example DLHC010084212021.");
  }
  return cnr;
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

/** Pagination block of the monitoring list endpoints. */
export interface CursorPagination {
  /** Opaque cursor to pass back as `cursor`. On `/changes` it is returned even on an empty page so you can poll forward. */
  nextCursor: string | null;
  hasMore?: boolean;
  limit?: number;
}

/** Success envelope of a monitoring list endpoint. */
export interface CursorListResponse<T> {
  success: true;
  data: T[];
  pagination: CursorPagination;
  meta?: Record<string, unknown>;
  requestId?: string;
}

/** Options shared by every monitoring list method. */
export interface CursorListOptions {
  cursor?: string;
  /** 1..100. */
  limit?: number;
}

/* -------------------------------------------------------------------------- */
/* CNR lookup                                                                 */
/* -------------------------------------------------------------------------- */

export interface GetCaseByCnrOptions {
  /**
   * Whether to check the court's official source for a CNR we do not hold.
   *
   * Left out (the default): the server checks it when your plan includes
   * live fetch, and otherwise answers `NotFoundError` on a miss. `false`:
   * never check, a miss throws `NotFoundError` (`CASE_NOT_FOUND`) straight
   * away. `true`: require the check; on a plan without live fetch this
   * throws `PermissionError` (`LIVE_FETCH_NOT_ALLOWED`).
   *
   * A check starts with a free `pending` (202) answer; the poll that
   * returns the record is the single 1 credit charge, and a check that
   * finds no case is free. New CNR checks count against a daily per account
   * cap (`RateLimitError`, `LIVE_FETCH_LIMIT_REACHED`). If the court had
   * nothing for this CNR in the last 24 hours, it is not checked again and
   * the call throws `NotFoundError` straight away.
   */
  fetch?: boolean;
}

/** `not_found` is never returned in a 200 body: it surfaces as `NotFoundError` (`CASE_NOT_FOUND`). */
export type CnrLookupStatus = "found" | "pending" | "not_found";

export interface CnrLookupData {
  /** Canonical 16 character CNR. */
  cnr: string;
  status: CnrLookupStatus;
  /** Present when `status` is `found`, same shape as `GET /cases/{id}`. */
  case?: Record<string, unknown> | null;
  /** Present when `status` is `pending`. Opaque: poll the same `getCaseByCnr` call; it is not accepted by `getTimeline`. */
  requestId?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Watchlists                                                                 */
/* -------------------------------------------------------------------------- */

export interface WatchlistItemInput {
  /** Any common CNR spelling, normalised before sending. */
  cnr: string;
  /** Your own id for this case, up to 200 characters. Echoed back on every event. */
  reference?: string;
  /** A display label, up to 200 characters. */
  label?: string;
}

export interface CreateWatchlistOptions {
  /** 1..100 characters. */
  name: string;
  /** Up to 100 CNRs to start watching. */
  items?: WatchlistItemInput[];
  /** Free form JSON, up to 2 KB. */
  metadata?: Record<string, unknown>;
}

export interface UpdateWatchlistOptions {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface Watchlist {
  /** Starts with `wl_`. */
  id: string;
  name: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * `cap_exceeded` covers three limits: your watched CNR cap, the daily limit on
 * adding CNRs we do not hold yet, and the daily add allowance per account
 * (Free 50, Pay As You Go 5,000, Scale 50,000, Enterprise 500,000, counted per
 * Indian calendar day). `message` says which. `not_found` also covers a case
 * that was taken down (it is stored as an `unavailable` item) and a CNR the
 * court portal had nothing for in the last 24 hours (nothing is refetched
 * until that cooldown passes).
 */
export type WatchItemResultCode = "watching" | "pending" | "invalid" | "duplicate" | "cap_exceeded" | "not_found";

/** Outcome of adding one CNR. A partial success is still HTTP 200. */
export interface WatchItemResult {
  cnr: string;
  result: WatchItemResultCode;
  message?: string;
}

/** `POST /watchlists` returns the watchlist plus one result per item. */
export interface CreateWatchlistResult extends Watchlist {
  results: WatchItemResult[];
}

export interface AddWatchlistItemsResult {
  results: WatchItemResult[];
  itemCount?: number;
}

/**
 * `unavailable` means the case was taken down at a party's request. No events
 * are sent for it, and `caseId`, `court`, `title`, `snapshot`, `lastCheckedAt`
 * and `lastChangedAt` are all `null`.
 */
export type WatchItemStatus = "watching" | "pending" | "not_found" | "error" | "unavailable";

/** Dates are `YYYY-MM-DD` (Indian calendar). A court's year 9999 "no date" comes back as `null`. */
export interface WatchSnapshot {
  caseStatus?: string | null;
  caseStage?: string | null;
  nextHearingDate?: string | null;
  lastListedOn?: string | null;
  orderCount?: number | null;
  latestOrderDate?: string | null;
  disposalNature?: string | null;
}

export interface WatchlistItem {
  cnr: string;
  reference?: string | null;
  label?: string | null;
  status: WatchItemStatus;
  caseId?: string | null;
  court?: string | null;
  title?: string | null;
  lastCheckedAt?: string | null;
  lastChangedAt?: string | null;
  snapshot?: WatchSnapshot | null;
  addedAt: string;
}

export interface ListWatchlistItemsOptions extends CursorListOptions {
  /** Filter by item status. */
  status?: WatchItemStatus;
}

export interface DeleteResult {
  deleted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Changes feed                                                               */
/* -------------------------------------------------------------------------- */

export type ChangeEventType =
  | "case.tracking_started"
  | "case.order_added"
  | "case.hearing_date_changed"
  | "case.status_changed"
  | "case.stage_changed"
  | "case.disposed"
  | "case.not_found"
  | "webhook.test";

export interface ChangeEventWatchlistRef {
  id: string;
  reference?: string | null;
}

/**
 * One change event. The feed and the webhook body are identical.
 *
 * `case.tracking_started` arrives once the first fresh refresh of the case
 * completes (immediately when the stored record is already current), not at
 * the moment of the add. After that, a burst of new orders announces only the
 * newest 20, and an order dated more than 7 days before you started watching
 * is never announced to you. A taken down case sends no events.
 */
export interface ChangeEvent<TData = Record<string, unknown>> {
  /** Starts with `evt_`. Dedupe on this: delivery is at least once. */
  id: string;
  type: ChangeEventType | (string & {});
  createdAt: string;
  cnr: string;
  caseId?: string | null;
  watchlists: ChangeEventWatchlistRef[];
  data: TData;
}

export interface ListChangesOptions extends CursorListOptions {
  /**
   * ISO timestamp, used when there is no `cursor`. It is turned into a feed
   * position once; the `nextCursor` you get back continues from there.
   * Cursors are opaque: store them, never build or parse them.
   */
  since?: string;
  /** Event types to include. */
  types?: ChangeEventType | string | Array<ChangeEventType | string>;
  /** Only events for this CNR. */
  cnr?: string;
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateWebhookOptions {
  /** https only. */
  url: string;
  /** Event types to receive. Defaults to every `case.*` type; the response and later reads echo the full list. */
  events?: Array<ChangeEventType | string>;
  /** Limit to these watchlists. Defaults to all; `[]` also means all and is what the response echoes when you send none. */
  watchlistIds?: string[];
  /** Up to 200 characters. */
  description?: string;
}

export interface UpdateWebhookOptions {
  url?: string;
  events?: Array<ChangeEventType | string>;
  watchlistIds?: string[];
  description?: string;
  enabled?: boolean;
}

export interface Webhook {
  /** Starts with `wh_`. */
  id: string;
  url: string;
  events: string[];
  watchlistIds?: string[] | null;
  description?: string | null;
  enabled: boolean;
  disabledReason?: string | null;
  /** True for 24 hours after a secret rotation, while both secrets sign. */
  secretRotating?: boolean;
  createdAt: string;
  updatedAt?: string;
}

/** Returned by create and rotate only. `secret` is never shown again. */
export interface WebhookWithSecret extends Webhook {
  /** `whsec_` followed by 32 random bytes, base64url. */
  secret: string;
}

export type WebhookDeliveryStatus = "pending" | "succeeded" | "failed";

/**
 * `lastError` is `"expired"` on a delivery that was never attempted for 24
 * hours and was therefore marked `failed` instead of being sent.
 */
export interface WebhookDelivery {
  /** Starts with `whd_`. */
  id: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null;
  lastResponseStatus?: number | null;
  lastError?: string | null;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Webhook signature verification                                             */
/* -------------------------------------------------------------------------- */

/** Thrown by `verifyWebhookSignature` for any reason a delivery must not be trusted. */
export class WebhookSignatureError extends Error {
  /** Machine readable reason: `missing_header`, `malformed_header`, `timestamp_out_of_tolerance`, `signature_mismatch` or `invalid_body`. */
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "WebhookSignatureError";
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface VerifyWebhookSignatureOptions {
  /** Maximum allowed difference between now and the signed timestamp. Default 300. */
  toleranceSeconds?: number;
  /** Current time in unix seconds. For tests; defaults to the system clock. */
  now?: number;
}

/**
 * Verifies the `CourtMesh-Signature` header of a webhook delivery and returns
 * the parsed event. Throws `WebhookSignatureError` when it must not be trusted.
 *
 * Pass the RAW request body exactly as received (a string or Buffer), never a
 * re-serialised object, or the signature will not match.
 *
 * The header looks like `t=1790000000,v1=<hex>`. During a secret rotation it
 * carries two `v1=` values (one per secret); a match on any of them is
 * accepted. `secret` may be a string or, to cover your side of a rotation, an
 * array of strings.
 */
export function verifyWebhookSignature<TEvent = ChangeEvent>(
  rawBody: string | Uint8Array,
  header: string | string[] | null | undefined,
  secret: string | string[],
  options: VerifyWebhookSignatureOptions = {},
): TEvent {
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const headerValue = Array.isArray(header) ? header.join(",") : header;
  if (!headerValue) {
    throw new WebhookSignatureError("Missing CourtMesh-Signature header.", "missing_header");
  }

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of headerValue.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (/^\d+$/.test(value) && Number.isSafeInteger(parsed)) timestamp = parsed;
    } else if (key === "v1" && /^[0-9a-fA-F]+$/.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookSignatureError("Malformed CourtMesh-Signature header.", "malformed_header");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError("Webhook timestamp is outside the allowed tolerance.", "timestamp_out_of_tolerance");
  }

  const bodyBuffer = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const secrets = Array.isArray(secret) ? secret : [secret];
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), bodyBuffer]);

  let matched = false;
  for (const candidate of secrets) {
    const expected = createHmac("sha256", candidate).update(signedPayload).digest();
    for (const signature of signatures) {
      const provided = Buffer.from(signature, "hex");
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) matched = true;
    }
  }
  if (!matched) {
    throw new WebhookSignatureError("Webhook signature does not match.", "signature_mismatch");
  }

  try {
    return JSON.parse(bodyBuffer.toString("utf8")) as TEvent;
  } catch {
    throw new WebhookSignatureError("Webhook body is not valid JSON.", "invalid_body");
  }
}
