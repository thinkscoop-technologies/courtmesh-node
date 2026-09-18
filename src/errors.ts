/**
 * Typed error hierarchy for the CourtMesh SDK.
 *
 * Every error the client throws for an HTTP failure extends CourtMeshError
 * and carries the HTTP status code, the message and the raw parsed response
 * body (or undefined if the body could not be parsed as JSON).
 */

export type CourtMeshErrorCode =
  | "validation_error"
  | "authentication_error"
  | "permission_error"
  | "not_found"
  | "request_timeout"
  | "insufficient_credits"
  | "rate_limit"
  | "server_error"
  | "bad_gateway"
  | "service_unavailable"
  | "network_error"
  | "unknown_error";

/**
 * Mirrors `API_REFUSAL_CODES` from the research server
 * (server/config/api-tiers.ts), plus the handler-local machine codes used
 * outside that table (`CASE_RESTRICTED`, `PDF_NOT_STORED`, `CASE_NOT_FOUND`,
 * `PARTY_SCREEN_SEARCH_DEGRADED`, `ENTITLEMENT_UNAVAILABLE`, `CURSOR_INVALID`,
 * `PAGE_LIMIT_EXCEEDED`, `PAGINATION_DEPTH_EXCEEDED`, the abuse-control and
 * auth codes, and the JSON/body-parser codes this SDK synthesises client
 * side, since the server itself does not attach a `code` field to those).
 *
 * This is a plain string union rather than a closed enum: the server adds
 * refusal codes over time, and a caller comparing `error.apiCode` against
 * this list should not have its build break the day a new one ships.
 */
export type ApiRefusalCode =
  | "API_ENTERPRISE_ONLY"
  | "API_NOT_AVAILABLE_ON_TRIAL"
  | "API_NO_KEYS"
  | "INSUFFICIENT_API_CREDITS"
  | "FREE_TIER_AI_CAP_REACHED"
  | "ENTITLEMENT_UNAVAILABLE"
  | "API_KEY_LIMIT_REACHED"
  | "API_TIER_NOT_ALLOWED"
  | "PARTY_SCREEN_LIMIT_REACHED"
  | "DISTINCT_NAMES_LIMIT_REACHED"
  | "LIVE_FETCH_NOT_ALLOWED"
  | "LIVE_FETCH_LIMIT_REACHED"
  | "DISTINCT_CASES_LIMIT_REACHED"
  | "PDF_LIMIT_REACHED"
  | "TOO_MANY_KEYS_FROM_IP"
  | "EMAIL_NOT_VERIFIED"
  | "CONCURRENT_ANALYSIS_LIMIT"
  | "REMOTE_FETCH_NOT_ALLOWED"
  | "CURSOR_INVALID"
  | "SEMANTIC_NOT_ALLOWED"
  | "API_RATE_LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "PAGE_LIMIT_EXCEEDED"
  | "PAGINATION_DEPTH_EXCEEDED"
  | "CASE_RESTRICTED"
  | "PDF_NOT_STORED"
  | "CASE_NOT_FOUND"
  | "PARTY_SCREEN_SEARCH_DEGRADED"
  | "API_KEY_MISSING"
  | "API_KEY_INVALID_FORMAT"
  | "API_KEY_INVALID"
  | "API_KEY_REVOKED"
  | "API_KEY_EXPIRED"
  | "ORGANIZATION_DEACTIVATED"
  | "ACCOUNT_STANDING_UNAVAILABLE"
  | "IP_NOT_ALLOWED"
  | "VALIDATION_ERROR"
  | "MALFORMED_JSON"
  | "PAYLOAD_TOO_LARGE";

/**
 * Runtime mirror of `API_REFUSAL_CODES` (server/config/api-tiers.ts) plus the
 * handler-local and SDK-synthesised codes listed on `ApiRefusalCode` above.
 * Kept as a plain object (not a TS `enum`) so it tree shakes and compares by
 * value, exactly like the server's own `as const` object.
 */
export const API_REFUSAL_CODES = {
  ENTERPRISE_ONLY: "API_ENTERPRISE_ONLY",
  TRIAL_NOT_ALLOWED: "API_NOT_AVAILABLE_ON_TRIAL",
  NO_API_KEYS: "API_NO_KEYS",
  INSUFFICIENT_CREDITS: "INSUFFICIENT_API_CREDITS",
  FREE_AI_CAP_REACHED: "FREE_TIER_AI_CAP_REACHED",
  ENTITLEMENT_UNAVAILABLE: "ENTITLEMENT_UNAVAILABLE",
  API_KEY_LIMIT_REACHED: "API_KEY_LIMIT_REACHED",
  TIER_NOT_ALLOWED: "API_TIER_NOT_ALLOWED",
  PARTY_SCREEN_LIMIT_REACHED: "PARTY_SCREEN_LIMIT_REACHED",
  DISTINCT_NAMES_LIMIT_REACHED: "DISTINCT_NAMES_LIMIT_REACHED",
  LIVE_FETCH_NOT_ALLOWED: "LIVE_FETCH_NOT_ALLOWED",
  LIVE_FETCH_LIMIT_REACHED: "LIVE_FETCH_LIMIT_REACHED",
  DISTINCT_CASES_LIMIT_REACHED: "DISTINCT_CASES_LIMIT_REACHED",
  PDF_LIMIT_REACHED: "PDF_LIMIT_REACHED",
  TOO_MANY_KEYS_FROM_IP: "TOO_MANY_KEYS_FROM_IP",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  CONCURRENT_ANALYSIS_LIMIT: "CONCURRENT_ANALYSIS_LIMIT",
  REMOTE_FETCH_NOT_ALLOWED: "REMOTE_FETCH_NOT_ALLOWED",
  CURSOR_INVALID: "CURSOR_INVALID",
  SEMANTIC_NOT_ALLOWED: "SEMANTIC_NOT_ALLOWED",
  LEGACY_RATE_LIMIT_EXCEEDED: "API_RATE_LIMIT_EXCEEDED",
  RATE_LIMITED: "RATE_LIMITED",
  PAGE_LIMIT_EXCEEDED: "PAGE_LIMIT_EXCEEDED",
  PAGINATION_DEPTH_EXCEEDED: "PAGINATION_DEPTH_EXCEEDED",
  CASE_RESTRICTED: "CASE_RESTRICTED",
  PDF_NOT_STORED: "PDF_NOT_STORED",
  CASE_NOT_FOUND: "CASE_NOT_FOUND",
  PARTY_SCREEN_SEARCH_DEGRADED: "PARTY_SCREEN_SEARCH_DEGRADED",
  API_KEY_MISSING: "API_KEY_MISSING",
  API_KEY_INVALID_FORMAT: "API_KEY_INVALID_FORMAT",
  API_KEY_INVALID: "API_KEY_INVALID",
  API_KEY_REVOKED: "API_KEY_REVOKED",
  API_KEY_EXPIRED: "API_KEY_EXPIRED",
  ORGANIZATION_DEACTIVATED: "ORGANIZATION_DEACTIVATED",
  ACCOUNT_STANDING_UNAVAILABLE: "ACCOUNT_STANDING_UNAVAILABLE",
  IP_NOT_ALLOWED: "IP_NOT_ALLOWED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  MALFORMED_JSON: "MALFORMED_JSON",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
} as const satisfies Record<string, ApiRefusalCode>;

const DAILY_CAP_429_CODES: ReadonlySet<string> = new Set([
  API_REFUSAL_CODES.DISTINCT_NAMES_LIMIT_REACHED,
  API_REFUSAL_CODES.LIVE_FETCH_LIMIT_REACHED,
  API_REFUSAL_CODES.DISTINCT_CASES_LIMIT_REACHED,
  API_REFUSAL_CODES.PDF_LIMIT_REACHED,
  API_REFUSAL_CODES.TOO_MANY_KEYS_FROM_IP,
]);

/** 429 codes safe to retry automatically. Never includes a daily-cap code (R2). */
const RETRYABLE_429_CODES: ReadonlySet<string> = new Set([
  API_REFUSAL_CODES.RATE_LIMITED,
  API_REFUSAL_CODES.CONCURRENT_ANALYSIS_LIMIT,
]);

/** Whether a 429 response body's `code` is safe to retry automatically (R2). */
export function isRetryable429Code(code: string | undefined): boolean {
  if (code === undefined) return true;
  if (DAILY_CAP_429_CODES.has(code)) return false;
  return RETRYABLE_429_CODES.has(code);
}

/** Common fields every error subclass can carry, in addition to its own. */
export interface CourtMeshErrorExtra {
  /**
   * The server's `code` field verbatim, for example `"API_TIER_NOT_ALLOWED"`
   * or `"RATE_LIMITED"`. Not the SDK's own `code` discriminant (see
   * `CourtMeshError.code`). One of `ApiRefusalCode`'s values when the server
   * sent a recognised one, but kept as `string` since the server may add new
   * codes before this SDK's union is updated.
   */
  apiCode?: string;
  /**
   * Echoed from the server's `requestId` field (sent once the API's
   * `X-Request-Id` middleware ships) or, failing that, the `X-Request-Id`
   * response header, when either is present. Undefined on older server
   * builds that do not yet send one.
   */
  requestId?: string;
}

/** Base class for every error the SDK throws for a failed request. */
export class CourtMeshError extends Error {
  /** Discriminant usable in a switch or type guard, one value per subclass. */
  readonly code: CourtMeshErrorCode;
  /** The HTTP status code, undefined for network level failures. */
  readonly statusCode: number | undefined;
  /** The raw parsed response body, undefined if it was not valid JSON. */
  readonly body: unknown;
  /** The server's `code` field verbatim. See `CourtMeshErrorExtra.apiCode`. */
  readonly apiCode?: string;
  /** See `CourtMeshErrorExtra.requestId`. */
  readonly requestId?: string;

  constructor(
    message: string,
    code: CourtMeshErrorCode,
    statusCode: number | undefined,
    body: unknown,
    extra: CourtMeshErrorExtra = {},
  ) {
    super(message);
    this.name = "CourtMeshError";
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
    this.apiCode = extra.apiCode;
    this.requestId = extra.requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 400, request failed validation, an invalid pagination cursor
 * (`CURSOR_INVALID`), or a per tier pagination cap
 * (`PAGE_LIMIT_EXCEEDED`/`PAGINATION_DEPTH_EXCEEDED`).
 *
 * `details` mirrors the server's `details` array when present (the generic
 * zod validation failure shape). `limit` and `tier` are populated for the
 * two pagination cap codes, whose response body carries no `error`/`message`
 * field at all (`{ success: false, code, limit, tier }`) - `message` is
 * synthesised from `code` in that case, see `mapStatusToError`.
 */
export class ValidationError extends CourtMeshError {
  readonly details?: string[];
  /** Populated for `PAGE_LIMIT_EXCEEDED`/`PAGINATION_DEPTH_EXCEEDED`. */
  readonly limit?: number;
  /** Populated for `PAGE_LIMIT_EXCEEDED`/`PAGINATION_DEPTH_EXCEEDED`. */
  readonly tier?: string;

  constructor(
    message: string,
    body: unknown,
    details?: string[],
    limit?: number,
    tier?: string,
    extra: CourtMeshErrorExtra = {},
  ) {
    super(message, "validation_error", 400, body, extra);
    this.name = "ValidationError";
    this.details = details;
    this.limit = limit;
    this.tier = tier;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401, missing, malformed, unknown or deactivated API key. */
export class AuthenticationError extends CourtMeshError {
  constructor(message: string, body: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "authentication_error", 401, body, extra);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 403, organization or account state prevents the call, or a plan limit was
 * hit. `callsToday` and `maxAllowed` are populated only for the plan limit
 * variant. `apiCode` and `upgradeUrl` are populated for the tier restriction
 * variants, for example `API_NOT_AVAILABLE_ON_TRIAL`, `API_TIER_NOT_ALLOWED`
 * (free tier calling an AI analysis endpoint, `party/screen` past its free
 * allowance, `adjudicate: true` on Free, or semantic search on Free, which
 * uses `SEMANTIC_NOT_ALLOWED` instead), or `PARTY_SCREEN_LIMIT_REACHED`.
 */
export class PermissionError extends CourtMeshError {
  readonly callsToday?: number;
  readonly maxAllowed?: number;
  readonly upgradeUrl?: string;
  /** Present alongside most tier-restriction refusals (`LIVE_FETCH_NOT_ALLOWED`, `SEMANTIC_NOT_ALLOWED`, `API_TIER_NOT_ALLOWED`, ...). */
  readonly tier?: string;

  constructor(
    message: string,
    body: unknown,
    callsToday?: number,
    maxAllowed?: number,
    upgradeUrl?: string,
    tier?: string,
    extra: CourtMeshErrorExtra = {},
  ) {
    super(message, "permission_error", 403, body, extra);
    this.name = "PermissionError";
    this.callsToday = callsToday;
    this.maxAllowed = maxAllowed;
    this.upgradeUrl = upgradeUrl;
    this.tier = tier;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 404, case, request or job not found (`CASE_NOT_FOUND` on the pdf endpoint),
 * or `PDF_NOT_STORED` (no stored document for this case - see `hint` on the
 * raw `body` for what else to try).
 */
export class NotFoundError extends CourtMeshError {
  constructor(message: string, body: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "not_found", 404, body, extra);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 408, the OpenSearch query took too long, or the SDK's own client side timeout fired. */
export class RequestTimeoutError extends CourtMeshError {
  constructor(message: string, body: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "request_timeout", 408, body, extra);
    this.name = "RequestTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 402, the account does not have enough API credits for this call. Applies
 * to every priced endpoint (each one pre-flight reserves the charge before
 * doing any work), not only `party/screen`. `wallet` is always `"api_credits"`
 * today; `walletOwner` is `"user"` or `"org"`. Either `topUpUrl` or
 * `contactAdmin: true` is present, never both - an org member without
 * billing rights is told to contact their admin instead of being handed a
 * top up link they cannot use.
 */
export class InsufficientCreditsError extends CourtMeshError {
  /** Credits required for this call. */
  readonly required?: number;
  /** Credits currently available. */
  readonly balance?: number;
  /** `required - balance`. */
  readonly shortfall?: number;
  readonly topUpUrl?: string;
  /** Always `"api_credits"` today. */
  readonly wallet?: string;
  /** Whose wallet was charged against: the caller's own, or their organization's. */
  readonly walletOwner?: "user" | "org";
  /** True when this account cannot self serve a top up and must contact its admin instead. Mutually exclusive with `topUpUrl`. */
  readonly contactAdmin?: boolean;

  constructor(
    message: string,
    body: unknown,
    required?: number,
    balance?: number,
    shortfall?: number,
    topUpUrl?: string,
    wallet?: string,
    walletOwner?: "user" | "org",
    contactAdmin?: boolean,
    extra: CourtMeshErrorExtra = {},
  ) {
    super(message, "insufficient_credits", 402, body, extra);
    this.name = "InsufficientCreditsError";
    this.required = required;
    this.balance = balance;
    this.shortfall = shortfall;
    this.topUpUrl = topUpUrl;
    this.wallet = wallet;
    this.walletOwner = walletOwner;
    this.contactAdmin = contactAdmin;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 429: the per key/IP rate limit (`RATE_LIMITED`), a concurrency cap
 * (`CONCURRENT_ANALYSIS_LIMIT`), or a daily/monthly cap
 * (`DISTINCT_NAMES_LIMIT_REACHED`, `LIVE_FETCH_LIMIT_REACHED`,
 * `DISTINCT_CASES_LIMIT_REACHED`, `PDF_LIMIT_REACHED`,
 * `TOO_MANY_KEYS_FROM_IP`). Only the first two are ever retried
 * automatically (R2) - a daily cap will not clear before `Retry-After`
 * anyway, and this SDK never loops for that long unattended (R1).
 */
export class RateLimitError extends CourtMeshError {
  /** Seconds to wait before retrying, from the `Retry-After` header or the JSON body's `retryAfter`. */
  readonly retryAfter?: number;
  /** Alias of `retryAfter`, spelled out for callers that grepped for this exact name. */
  readonly retryAfterSeconds?: number;
  /** ISO timestamp of when the limit resets. */
  readonly resetTime?: string;

  constructor(
    message: string,
    body: unknown,
    retryAfter?: number,
    resetTime?: string,
    extra: CourtMeshErrorExtra = {},
  ) {
    super(message, "rate_limit", 429, body, extra);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = retryAfter;
    this.resetTime = resetTime;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 500, an unhandled server side error. */
export class ServerError extends CourtMeshError {
  constructor(message: string, body: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "server_error", 500, body, extra);
    this.name = "ServerError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 502, the API failed to connect to an upstream dependency, or `PARTY_SCREEN_SEARCH_DEGRADED` (the underlying case search itself errored and returned nothing usable - retry). */
export class BadGatewayError extends CourtMeshError {
  constructor(message: string, body: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "bad_gateway", 502, body, extra);
    this.name = "BadGatewayError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 503, account standing could not be verified (`ENTITLEMENT_UNAVAILABLE`), or the service is otherwise unavailable. Safe to retry. */
export class ServiceUnavailableError extends CourtMeshError {
  constructor(message: string, body: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "service_unavailable", 503, body, extra);
    this.name = "ServiceUnavailableError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 413, the request body was larger than the server accepts. Not retried. */
export class PayloadTooLargeError extends CourtMeshError {
  constructor(message: string, body: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "validation_error", 413, body, { ...extra, apiCode: extra.apiCode ?? API_REFUSAL_CODES.PAYLOAD_TOO_LARGE });
    this.name = "PayloadTooLargeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No HTTP response was received at all, DNS failure, connection refused, aborted request, and similar. */
export class NetworkError extends CourtMeshError {
  constructor(message: string, cause?: unknown, extra: CourtMeshErrorExtra = {}) {
    super(message, "network_error", undefined, cause, extra);
    this.name = "NetworkError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard, and the discriminant to narrow on when you only have `unknown`. */
export function isCourtMeshError(error: unknown): error is CourtMeshError {
  return error instanceof CourtMeshError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(body: unknown, key: string): string | undefined {
  return isRecord(body) && typeof body[key] === "string" ? (body[key] as string) : undefined;
}

function numberField(body: unknown, key: string): number | undefined {
  return isRecord(body) && typeof body[key] === "number" ? (body[key] as number) : undefined;
}

function booleanField(body: unknown, key: string): boolean | undefined {
  return isRecord(body) && typeof body[key] === "boolean" ? (body[key] as boolean) : undefined;
}

/**
 * Synthesise a human message for a body that carries a machine `code` but no
 * `error`/`message` field of its own - today only the two tier pagination
 * caps (`middleware/api-tier-limits.ts`'s `enforceTierQueryLimits`), whose
 * response is deliberately `{ success: false, code, limit, tier }`.
 */
function synthesizeMessageFromCode(code: string, body: unknown): string {
  const limit = numberField(body, "limit");
  const tier = stringField(body, "tier");
  switch (code) {
    case API_REFUSAL_CODES.PAGE_LIMIT_EXCEEDED:
      return `Requested page size${limit !== undefined ? ` (${limit})` : ""} exceeds the maximum for the${tier ? ` ${tier}` : ""} tier.`;
    case API_REFUSAL_CODES.PAGINATION_DEPTH_EXCEEDED:
      return `This query has paged deeper than the${tier ? ` ${tier}` : ""} tier allows. Narrow the query instead of paging further.`;
    default:
      return `Request refused with code ${code}.`;
  }
}

/** Looks like the body-parser `entity.parse.failed`/`SyntaxError` message for a malformed JSON request body. */
function looksLikeMalformedJson(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes("json") && (m.includes("unexpected token") || m.includes("unexpected end") || m.includes("parse"));
}

export function extractRequestId(body: unknown, headerRequestId?: string): string | undefined {
  return stringField(body, "requestId") ?? headerRequestId;
}

/**
 * Maps an HTTP status code plus a parsed response body to the matching typed
 * error. `headerRequestId` is the `X-Request-Id` response header, used when
 * the body itself carries no `requestId` field (older server builds, or a
 * body that failed to parse as JSON).
 */
export function mapStatusToError(
  statusCode: number,
  message: string,
  body: unknown,
  headerRequestId?: string,
): CourtMeshError {
  const apiCode = stringField(body, "code");
  const requestId = extractRequestId(body, headerRequestId);
  const extra: CourtMeshErrorExtra = { apiCode, requestId };

  switch (statusCode) {
    case 400: {
      if (apiCode === API_REFUSAL_CODES.PAGE_LIMIT_EXCEEDED || apiCode === API_REFUSAL_CODES.PAGINATION_DEPTH_EXCEEDED) {
        const limit = numberField(body, "limit");
        const tier = stringField(body, "tier");
        return new ValidationError(synthesizeMessageFromCode(apiCode, body), body, undefined, limit, tier, extra);
      }
      if (apiCode === API_REFUSAL_CODES.CURSOR_INVALID) {
        return new ValidationError(message, body, undefined, undefined, undefined, extra);
      }
      const details = isRecord(body) && Array.isArray(body.details) ? (body.details as string[]) : undefined;
      if (looksLikeMalformedJson(message)) {
        return new ValidationError(message, body, details, undefined, undefined, {
          ...extra,
          apiCode: extra.apiCode ?? API_REFUSAL_CODES.MALFORMED_JSON,
        });
      }
      return new ValidationError(message, body, details, undefined, undefined, {
        ...extra,
        apiCode: extra.apiCode ?? API_REFUSAL_CODES.VALIDATION_ERROR,
      });
    }
    case 401:
      return new AuthenticationError(message, body, extra);
    case 402: {
      const required = numberField(body, "required");
      const balance = numberField(body, "balance");
      const shortfall = numberField(body, "shortfall");
      const topUpUrl = stringField(body, "topUpUrl");
      const wallet = stringField(body, "wallet");
      const walletOwnerRaw = stringField(body, "walletOwner");
      const walletOwner = walletOwnerRaw === "user" || walletOwnerRaw === "org" ? walletOwnerRaw : undefined;
      const contactAdmin = booleanField(body, "contactAdmin");
      return new InsufficientCreditsError(
        message,
        body,
        required,
        balance,
        shortfall,
        topUpUrl,
        wallet,
        walletOwner,
        contactAdmin,
        { ...extra, apiCode: extra.apiCode ?? API_REFUSAL_CODES.INSUFFICIENT_CREDITS },
      );
    }
    case 403: {
      const callsToday = numberField(body, "callsToday");
      const maxAllowed = numberField(body, "maxAllowed");
      const upgradeUrl = stringField(body, "upgradeUrl");
      const tier = stringField(body, "tier");
      return new PermissionError(message, body, callsToday, maxAllowed, upgradeUrl, tier, extra);
    }
    case 404:
      return new NotFoundError(message, body, extra);
    case 408:
      return new RequestTimeoutError(message, body, extra);
    case 413:
      return new PayloadTooLargeError(message, body, extra);
    case 429: {
      const retryAfter = numberField(body, "retryAfter");
      const resetTime = stringField(body, "resetTime");
      return new RateLimitError(message, body, retryAfter, resetTime, {
        ...extra,
        apiCode: extra.apiCode ?? API_REFUSAL_CODES.RATE_LIMITED,
      });
    }
    case 500:
      return new ServerError(message, body, extra);
    case 502:
      return new BadGatewayError(message, body, extra);
    case 503:
      return new ServiceUnavailableError(message, body, {
        ...extra,
        apiCode: extra.apiCode ?? API_REFUSAL_CODES.ENTITLEMENT_UNAVAILABLE,
      });
    default:
      return new CourtMeshError(message, "unknown_error", statusCode, body, extra);
  }
}
