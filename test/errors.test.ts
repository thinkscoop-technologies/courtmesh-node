import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import {
  AuthenticationError,
  BadGatewayError,
  NotFoundError,
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

  it("404 -> NotFoundError", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: "Case not found" } }]);
    const error = await client.getCase("missing").catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.statusCode).toBe(404);
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
});
