import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import {
  API_REFUSAL_CODES,
  AuthenticationError,
  BadGatewayError,
  ConflictError,
  InsufficientCreditsError,
  NotFoundError,
  PayloadTooLargeError,
  PermissionError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  ServiceUnavailableError,
  ValidationError,
  isCourtMeshError,
} from "../src/errors.js";
import { queueFetch } from "./helpers.js";

const API_KEY = "cm-abcdefghij1234567890abcdefghijkl-wxyz";

function makeClient(entries: Parameters<typeof queueFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetch, calls } = queueFetch(entries);
  const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 1, ...overrides });
  return { client, calls };
}

describe("error class mapping", () => {
  it("400 -> ValidationError with details", async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: {
          success: false,
          error: "Validation failed. Please check your request and try again.",
          details: ["query: Search query cannot be empty."],
        },
      },
    ]);
    const error = await client.searchCases({ query: "" }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual(["query: Search query cannot be empty."]);
    expect(isCourtMeshError(error)).toBe(true);
    expect(error.code).toBe("validation_error");
  });

  it("401 -> AuthenticationError from a bare (non-enveloped) body", async () => {
    const { client } = makeClient([{ status: 401, body: { error: "Invalid API key" } }]);
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe("Invalid API key");
  });

  it("403 -> PermissionError with callsToday/maxAllowed", async () => {
    const { client } = makeClient([
      { status: 403, body: { error: "Daily call limit exceeded", callsToday: 500, maxAllowed: 500 } },
    ]);
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.callsToday).toBe(500);
    expect(error.maxAllowed).toBe(500);
  });

  it("403 -> PermissionError with code/upgradeUrl for a tier restriction", async () => {
    const { client } = makeClient([
      {
        status: 403,
        body: {
          error: "AI analysis is not available on the Free tier.",
          code: "API_TIER_NOT_ALLOWED",
          upgradeUrl: "https://courtmesh.ai/pricing",
        },
      },
    ]);
    const error = await client.analyzeCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.apiCode).toBe("API_TIER_NOT_ALLOWED");
    expect(error.upgradeUrl).toBe("https://courtmesh.ai/pricing");
  });

  it("402 -> InsufficientCreditsError with required/balance/shortfall/topUpUrl", async () => {
    const { client } = makeClient([
      {
        status: 402,
        body: {
          error: "Insufficient API credits for this call.",
          code: "INSUFFICIENT_API_CREDITS",
          required: 180,
          balance: 40,
          shortfall: 140,
          topUpUrl: "https://courtmesh.ai/pricing",
        },
      },
    ]);
    const error = await client.screenParty({ name: "Acme Pvt Ltd", entityType: "company", purpose: "kyc", adjudicate: true }).catch((e) => e);
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error.statusCode).toBe(402);
    expect(error.required).toBe(180);
    expect(error.balance).toBe(40);
    expect(error.shortfall).toBe(140);
    expect(error.topUpUrl).toBe("https://courtmesh.ai/pricing");
  });

  it("404 -> NotFoundError", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: "Case not found" } }]);
    const error = await client.getCase("missing").catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
  });

  it("409 -> ConflictError with apiCode IDEMPOTENCY_KEY_REUSED", async () => {
    const { client } = makeClient([
      {
        status: 409,
        body: {
          success: false,
          error: "This Idempotency-Key was already used with a different request body.",
          code: "IDEMPOTENCY_KEY_REUSED",
        },
      },
    ]);
    const error = await client.analyzeCase("1", {}, { idempotencyKey: "dup-1" }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.statusCode).toBe(409);
    expect(error.apiCode).toBe(API_REFUSAL_CODES.IDEMPOTENCY_KEY_REUSED);
    expect(error.code).toBe("conflict");
  });

  it("409 -> ConflictError with apiCode IDEMPOTENCY_IN_PROGRESS", async () => {
    const { client } = makeClient([
      {
        status: 409,
        body: {
          success: false,
          error: "A request with this Idempotency-Key is still being processed.",
          code: "IDEMPOTENCY_IN_PROGRESS",
        },
      },
    ]);
    const error = await client.requestTimeline("1", {}, { idempotencyKey: "in-flight-1" }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.apiCode).toBe(API_REFUSAL_CODES.IDEMPOTENCY_IN_PROGRESS);
  });

  it("408 -> RequestTimeoutError", async () => {
    const { client } = makeClient([
      { status: 408, body: { success: false, error: "Request timeout - OpenSearch query took too long" } },
    ]);
    const error = await client.searchCases({ query: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error.statusCode).toBe(408);
  });

  it("429 -> RateLimitError exposing retryAfter and resetTime", async () => {
    const { client } = makeClient(
      [
        {
          status: 429,
          body: {
            error: "Rate limit exceeded",
            message: "Too many requests. Maximum 10 requests per minute allowed.",
            retryAfter: 37,
            resetTime: "2026-08-10T09:15:00.000Z",
          },
        },
      ],
      { maxRetries: 0 },
    );
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBe(37);
    expect(error.resetTime).toBe("2026-08-10T09:15:00.000Z");
  });

  it("429 -> RateLimitError exposing the distinct-names-per-day code on party/screen", async () => {
    const { client } = makeClient(
      [
        {
          status: 429,
          body: {
            error: "Distinct names per day limit reached for this plan.",
            code: "DISTINCT_NAMES_LIMIT_REACHED",
            retryAfter: 3600,
          },
        },
      ],
      { maxRetries: 0 },
    );
    const error = await client.screenParty({ name: "Acme Pvt Ltd", entityType: "company", purpose: "kyc" }).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.apiCode).toBe("DISTINCT_NAMES_LIMIT_REACHED");
    expect(error.retryAfter).toBe(3600);
  });

  it("500 -> ServerError", async () => {
    const { client } = makeClient([{ status: 500, body: { success: false, error: "Internal server error" } }]);
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
  });

  it("502 -> BadGatewayError after retries are exhausted", async () => {
    const { client } = makeClient(
      [
        { status: 502, body: { success: false, error: "Failed to connect" } },
        { status: 502, body: { success: false, error: "Failed to connect" } },
      ],
      { maxRetries: 1 },
    );
    const error = await client.searchCases({ query: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(BadGatewayError);
  });

  it("503 -> ServiceUnavailableError", async () => {
    const { client } = makeClient(
      [{ status: 503, body: { error: "Unable to verify account standing. Please retry." } }],
      { maxRetries: 0 },
    );
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
  });

  it("413 -> PayloadTooLargeError", async () => {
    const { client } = makeClient([{ status: 413, body: { message: "request entity too large" } }], {
      maxRetries: 0,
    });
    const error = await client.searchCases({ query: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect(error.apiCode).toBe(API_REFUSAL_CODES.PAYLOAD_TOO_LARGE);
  });

  it("400 -> ValidationError synthesizes a message for PAGE_LIMIT_EXCEEDED (no error/message field on the wire)", async () => {
    const { client } = makeClient([
      { status: 400, body: { success: false, code: "PAGE_LIMIT_EXCEEDED", limit: 500, tier: "free" } },
    ]);
    const error = await client.searchCases({ query: "x", limit: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.apiCode).toBe("PAGE_LIMIT_EXCEEDED");
    expect(error.limit).toBe(500);
    expect(error.tier).toBe("free");
    expect(typeof error.message).toBe("string");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("400 -> ValidationError for CURSOR_INVALID", async () => {
    const { client } = makeClient([
      { status: 400, body: { success: false, code: "CURSOR_INVALID", message: "This pagination cursor is invalid or expired." } },
    ]);
    const error = await client.searchCases({ query: "x", cursor: "bogus" }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.apiCode).toBe("CURSOR_INVALID");
  });

  it("402 -> InsufficientCreditsError exposes wallet, walletOwner and contactAdmin", async () => {
    const { client } = makeClient([
      {
        status: 402,
        body: {
          success: false,
          error: "Insufficient API credits",
          code: "INSUFFICIENT_API_CREDITS",
          required: 100,
          balance: 10,
          shortfall: 90,
          wallet: "api_credits",
          walletOwner: "org",
          contactAdmin: true,
        },
      },
    ]);
    const error = await client.screenParty({ name: "Acme", entityType: "company", purpose: "kyc" }).catch((e) => e);
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error.wallet).toBe("api_credits");
    expect(error.walletOwner).toBe("org");
    expect(error.contactAdmin).toBe(true);
    expect(error.topUpUrl).toBeUndefined();
  });
});

describe("ApiRefusalCode mirroring", () => {
  it("API_REFUSAL_CODES covers the handler-local and auth codes", () => {
    expect(API_REFUSAL_CODES.CASE_RESTRICTED).toBe("CASE_RESTRICTED");
    expect(API_REFUSAL_CODES.PDF_NOT_STORED).toBe("PDF_NOT_STORED");
    expect(API_REFUSAL_CODES.CASE_NOT_FOUND).toBe("CASE_NOT_FOUND");
    expect(API_REFUSAL_CODES.PARTY_SCREEN_SEARCH_DEGRADED).toBe("PARTY_SCREEN_SEARCH_DEGRADED");
    expect(API_REFUSAL_CODES.ENTITLEMENT_UNAVAILABLE).toBe("ENTITLEMENT_UNAVAILABLE");
    expect(API_REFUSAL_CODES.CURSOR_INVALID).toBe("CURSOR_INVALID");
    expect(API_REFUSAL_CODES.PAGE_LIMIT_EXCEEDED).toBe("PAGE_LIMIT_EXCEEDED");
    expect(API_REFUSAL_CODES.PAGINATION_DEPTH_EXCEEDED).toBe("PAGINATION_DEPTH_EXCEEDED");
    expect(API_REFUSAL_CODES.TOO_MANY_KEYS_FROM_IP).toBe("TOO_MANY_KEYS_FROM_IP");
    expect(API_REFUSAL_CODES.DISTINCT_CASES_LIMIT_REACHED).toBe("DISTINCT_CASES_LIMIT_REACHED");
    expect(API_REFUSAL_CODES.PDF_LIMIT_REACHED).toBe("PDF_LIMIT_REACHED");
    expect(API_REFUSAL_CODES.CONCURRENT_ANALYSIS_LIMIT).toBe("CONCURRENT_ANALYSIS_LIMIT");
    expect(API_REFUSAL_CODES.REMOTE_FETCH_NOT_ALLOWED).toBe("REMOTE_FETCH_NOT_ALLOWED");
    expect(API_REFUSAL_CODES.EMAIL_NOT_VERIFIED).toBe("EMAIL_NOT_VERIFIED");
    expect(API_REFUSAL_CODES.API_KEY_MISSING).toBe("API_KEY_MISSING");
    expect(API_REFUSAL_CODES.API_KEY_INVALID_FORMAT).toBe("API_KEY_INVALID_FORMAT");
    expect(API_REFUSAL_CODES.API_KEY_INVALID).toBe("API_KEY_INVALID");
    expect(API_REFUSAL_CODES.API_KEY_REVOKED).toBe("API_KEY_REVOKED");
    expect(API_REFUSAL_CODES.API_KEY_EXPIRED).toBe("API_KEY_EXPIRED");
    expect(API_REFUSAL_CODES.ORGANIZATION_DEACTIVATED).toBe("ORGANIZATION_DEACTIVATED");
    expect(API_REFUSAL_CODES.ACCOUNT_STANDING_UNAVAILABLE).toBe("ACCOUNT_STANDING_UNAVAILABLE");
    expect(API_REFUSAL_CODES.IP_NOT_ALLOWED).toBe("IP_NOT_ALLOWED");
    expect(API_REFUSAL_CODES.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(API_REFUSAL_CODES.MALFORMED_JSON).toBe("MALFORMED_JSON");
    expect(API_REFUSAL_CODES.PAYLOAD_TOO_LARGE).toBe("PAYLOAD_TOO_LARGE");
    expect(API_REFUSAL_CODES.INSUFFICIENT_CREDITS).toBe("INSUFFICIENT_API_CREDITS");
  });
});

describe("retry behaviour", () => {
  it("retries a 429 and honours the Retry-After header over the JSON retryAfter", async () => {
    const { client, calls } = makeClient(
      [
        {
          status: 429,
          headers: { "Retry-After": "0" },
          body: { error: "Rate limit exceeded", message: "Too many requests.", retryAfter: 999, resetTime: "later" },
        },
        {
          status: 200,
          body: { success: true, data: { id: "1" }, meta: { responseTime: "1ms", note: "" } },
        },
      ],
      { maxRetries: 1 },
    );
    const result = await client.getCase("1");
    expect(result.data.id).toBe("1");
    expect(calls).toHaveLength(2);
  });

  it("falls back to the JSON body retryAfter when no Retry-After header is present", async () => {
    const { client, calls } = makeClient(
      [
        { status: 429, body: { error: "Rate limit exceeded", message: "Too many requests.", retryAfter: 0 } },
        { status: 200, body: { success: true, data: { id: "1" }, meta: { responseTime: "1ms", note: "" } } },
      ],
      { maxRetries: 1 },
    );
    const result = await client.getCase("1");
    expect(result.data.id).toBe("1");
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and throws the mapped error", async () => {
    const { client, calls } = makeClient(
      [
        { status: 429, headers: { "Retry-After": "0" }, body: { error: "Rate limit exceeded", message: "Too many requests." } },
        { status: 429, headers: { "Retry-After": "0" }, body: { error: "Rate limit exceeded", message: "Too many requests." } },
      ],
      { maxRetries: 1 },
    );
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(2);
  });

  it("retries a network error and eventually succeeds", async () => {
    let call = 0;
    const client = new CourtMeshClient({
      apiKey: API_KEY,
      maxRetries: 1,
      fetch: async () => {
        call += 1;
        if (call === 1) {
          throw new TypeError("fetch failed");
        }
        return new Response(
          JSON.stringify({ success: true, data: { id: "1" }, meta: { responseTime: "1ms", note: "" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await client.getCase("1");
    expect(result.data.id).toBe("1");
    expect(call).toBe(2);
  });

  it("R1: raises RateLimitError immediately, without sleeping, when the advertised delay exceeds maxRetryAfterSeconds", async () => {
    const { client, calls } = makeClient(
      [{ status: 429, body: { error: "Rate limit exceeded", code: "RATE_LIMITED", retryAfter: 86400 } }],
      { maxRetries: 3 },
    );
    const start = Date.now();
    const error = await client.getCase("1").catch((e) => e);
    expect(Date.now() - start).toBeLessThan(500);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfterSeconds).toBe(86400);
    expect(calls).toHaveLength(1);
  });

  it("R1: maxRetryAfterSeconds is configurable (a lower cap raises immediately on a delay the default cap would have retried)", async () => {
    const { fetch, calls } = queueFetch([
      { status: 429, body: { error: "Rate limit exceeded", code: "RATE_LIMITED", retryAfter: 10 } },
    ]);
    const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 3, maxRetryAfterSeconds: 5 });
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfterSeconds).toBe(10);
    expect(calls).toHaveLength(1);
  });

  it("R2: never retries a daily-cap 429 code even when the delay is well within the cap", async () => {
    const { client, calls } = makeClient(
      [{ status: 429, body: { error: "limit reached", code: "DISTINCT_CASES_LIMIT_REACHED", retryAfter: 5 } }],
      { maxRetries: 3 },
    );
    const error = await client.getCase("1").catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
  });

  it("R2: still retries CONCURRENT_ANALYSIS_LIMIT on 429", async () => {
    const { client, calls } = makeClient(
      [
        { status: 429, body: { error: "busy", code: "CONCURRENT_ANALYSIS_LIMIT", retryAfter: 0 } },
        { status: 200, body: { success: true, data: { id: "1" }, meta: { responseTime: "1ms", note: "" } } },
      ],
      { maxRetries: 1 },
    );
    const result = await client.getCase("1");
    expect(result.data.id).toBe("1");
    expect(calls).toHaveLength(2);
  });

  it("R3: does not retry a POST after a network error by default", async () => {
    let call = 0;
    const client = new CourtMeshClient({
      apiKey: API_KEY,
      maxRetries: 2,
      fetch: async () => {
        call += 1;
        throw new TypeError("fetch failed");
      },
    });
    const error = await client.searchCases({ query: "x" }).catch((e) => e);
    expect(isCourtMeshError(error)).toBe(true);
    expect(call).toBe(1);
  });

  it("R3: retries a POST after a network error when retryPosts: true", async () => {
    let call = 0;
    const client = new CourtMeshClient({
      apiKey: API_KEY,
      maxRetries: 2,
      retryPosts: true,
      fetch: async () => {
        call += 1;
        if (call < 2) throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({ success: true, data: [], meta: { responseTime: "1ms" }, pagination: { total: 0, hasMore: false, limit: 20, nextCursor: null } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await client.searchCases({ query: "x" });
    expect(result.data).toEqual([]);
    expect(call).toBe(2);
  });

  it("R3: does not retry a POST on 502 by default, but does with retryPosts: true", async () => {
    const { client, calls } = makeClient(
      [
        { status: 502, body: { success: false, error: "bad gateway" } },
        { status: 200, body: { success: true, data: [], meta: { responseTime: "1ms" }, pagination: { total: 0, hasMore: false, limit: 20, nextCursor: null } } },
      ],
      { maxRetries: 1, retryPosts: true },
    );
    const result = await client.searchCases({ query: "x" });
    expect(result.data).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
