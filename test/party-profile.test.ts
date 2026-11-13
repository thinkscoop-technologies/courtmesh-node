import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import {
  BadGatewayError,
  ConflictError,
  CourtMeshError,
  InsufficientCreditsError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  ValidationError,
} from "../src/errors.js";
import { isPartyProfileAccepted } from "../src/party-profile.js";
import type { PartyProfileOptions } from "../src/party-profile.js";
import type { FetchLike } from "../src/client.js";
import { queueFetch } from "./helpers.js";

const API_KEY = "cm-abcdefghij1234567890abcdefghijkl-wxyz";
const BASE = "https://research.courtmesh.ai/api/v1/prod";
const CNR = "ZZAB010000012024";
const REQUEST_ID = "ppr_0123456789abcdef0123456789abcdef";

function makeClient(entries: Parameters<typeof queueFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetch, calls } = queueFetch(entries);
  const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 1, ...overrides });
  return { client, calls };
}

const QUICK: PartyProfileOptions = {
  name: "Ravi Example",
  entityType: "person",
  purpose: "due_diligence",
  knownPersons: ["Mohan Example"],
  address: { state: "Example State" },
  mode: "quick",
  include: ["documents", "acts", "fir", "status", "summary"],
  minConfidence: "probable",
};

const quickBody = {
  success: true,
  data: {
    subject: { name: "Ravi Example", entityType: "person" },
    verdict: "identity_found",
    summary: "One identity at probable confidence with 1 case.",
    identities: [
      {
        confidence: "probable",
        why: ["The person you named is recorded as a relation in 1 case of this group."],
        caseCount: 1,
        profile: { pending: 1, disposed: 0, byCourtType: { "District Court": 1 } },
        cases: [
          {
            caseId: "000000000000000000000001",
            cnr: CNR,
            court: "District Court, Example City",
            courtType: "District Court",
            partyRole: "respondent",
            status: "pending",
            nextHearingDate: "2026-12-01",
            decisionDate: null,
            courtRecordActs: [{ act: "EXAMPLE ACT", sections: ["12", "14"] }],
            courtRecordFir: [{ policeStation: "EXAMPLE POLICE STATION", firNumber: "98", firYear: "2023" }],
            confidence: "probable",
            matchReasons: ["same state as the given address"],
            documents: [
              {
                documentId: "00000000000000000000000a",
                kind: "order",
                date: "2026-11-06",
                links: { text: "/cases/000000000000000000000001/orders/00000000000000000000000a/text", pdf: null },
              },
            ],
          },
        ],
      },
    ],
    possibleOtherPeople: [],
    relatedButUnverified: [],
    notes: [],
  },
  meta: {
    creditsCharged: 100,
    metered: true,
    creditsBreakdown: {
      searches: { count: 5, credits: 5 },
      caseRecords: { count: 1, credits: 1 },
      documentLists: { count: 1, credits: 1 },
      minimumCharge: { credits: 93 },
    },
    adjudicated: false,
    corpusAsOf: "2026-11-10T09:30:00.000Z",
  },
};

const acceptedBody = {
  success: true,
  data: {
    requestId: REQUEST_ID,
    mode: "full",
    status: "queued",
    statusUrl: `/api/v1/prod/party/profile/${REQUEST_ID}`,
    maxCredits: 1000,
    webhook: { signingSecret: "whsec_example", note: "Shown once." },
  },
  meta: { creditsCharged: 0, metered: true },
};

function errorBody(code: string, extra: Record<string, unknown> = {}) {
  return { success: false, code, message: `refused: ${code}`, error: `refused: ${code}`, ...extra };
}

describe("buildPartyProfile", () => {
  it("POSTs the options as the body to /party/profile and returns a quick profile", async () => {
    const { client, calls } = makeClient([{ status: 200, body: quickBody }]);
    const res = await client.buildPartyProfile(QUICK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/party/profile`);
    expect(calls[0]?.body).toEqual(QUICK);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(isPartyProfileAccepted(res.data)).toBe(false);
    if (isPartyProfileAccepted(res.data)) throw new Error("expected a quick profile");
    const firstCase = res.data.identities[0]?.cases[0];
    expect(firstCase?.courtRecordFir?.[0]?.firNumber).toBe("98");
    expect(firstCase?.courtRecordActs?.[0]?.sections).toEqual(["12", "14"]);
    expect(firstCase?.decisionDate).toBeNull();
  });

  it("sends the full mode fields and returns the accepted request on 202", async () => {
    const { client, calls } = makeClient([{ status: 202, body: acceptedBody }]);
    const options: PartyProfileOptions = {
      name: "Example Works Private Limited",
      entityType: "company",
      purpose: "bgv",
      identifiers: { cin: "U00000ZZ2020PTC000001" },
      mode: "full",
      maxCredits: 150,
      webhook: { url: "https://hooks.example.com/profile", headers: { Authorization: "Bearer your-own-token" } },
    };
    const res = await client.buildPartyProfile(options);
    expect(calls[0]?.body).toEqual(options);
    expect(isPartyProfileAccepted(res.data)).toBe(true);
    if (!isPartyProfileAccepted(res.data)) throw new Error("expected an accepted request");
    expect(res.data.requestId).toBe(REQUEST_ID);
    expect(res.data.webhook?.signingSecret).toBe("whsec_example");
  });

  it("sends no Idempotency-Key by default", async () => {
    const { client, calls } = makeClient([{ status: 200, body: quickBody }]);
    await client.buildPartyProfile(QUICK);
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("sends an explicit idempotencyKey verbatim and surfaces a replay", async () => {
    const { client, calls } = makeClient([
      { status: 200, body: quickBody, headers: { "Idempotency-Replayed": "true" } },
    ]);
    const res = await client.buildPartyProfile(QUICK, { idempotencyKey: "profile-001" });
    expect(calls[0]?.headers["idempotency-key"]).toBe("profile-001");
    expect(res.replayed).toBe(true);
  });

  it("generates one Idempotency-Key with retryPosts and reuses it on the retry", async () => {
    const { client, calls } = makeClient([
      { status: 502, body: errorBody("PARTY_SCREEN_SEARCH_DEGRADED") },
      { status: 200, body: quickBody },
    ]);
    await client.buildPartyProfile(QUICK, { retryPosts: true });
    expect(calls).toHaveLength(2);
    const key = calls[0]?.headers["idempotency-key"];
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls[1]?.headers["idempotency-key"]).toBe(key);
  });

  it("does not retry a 502 without retryPosts", async () => {
    const { client, calls } = makeClient([{ status: 502, body: errorBody("PARTY_SCREEN_SEARCH_DEGRADED") }]);
    const error = await client.buildPartyProfile(QUICK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayError);
    expect((error as BadGatewayError).apiCode).toBe("PARTY_SCREEN_SEARCH_DEGRADED");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a network error without retryPosts", async () => {
    let count = 0;
    const fetch: FetchLike = async () => {
      count += 1;
      throw new TypeError("fetch failed");
    };
    const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 2 });
    const error = await client.buildPartyProfile(QUICK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CourtMeshError);
    expect((error as CourtMeshError).code).toBe("network_error");
    expect(count).toBe(1);
  });

  it("retries a 503 ENTITLEMENT_UNAVAILABLE with retryPosts on", async () => {
    const { client, calls } = makeClient([
      { status: 503, body: errorBody("ENTITLEMENT_UNAVAILABLE") },
      { status: 200, body: quickBody },
    ]);
    const res = await client.buildPartyProfile(QUICK, { retryPosts: true });
    expect(calls).toHaveLength(2);
    expect(res.success).toBe(true);
  });

  it("never retries a 503 PARTY_PROFILE_FULL_UNAVAILABLE, even with retryPosts on", async () => {
    const { client, calls } = makeClient([
      { status: 503, body: errorBody("PARTY_PROFILE_FULL_UNAVAILABLE") },
      { status: 202, body: acceptedBody },
    ]);
    const error = await client.buildPartyProfile({ ...QUICK, mode: "full" }, { retryPosts: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as ServiceUnavailableError).apiCode).toBe("PARTY_PROFILE_FULL_UNAVAILABLE");
    expect(calls).toHaveLength(1);
  });

  it("never retries a 503 whose debit outcome is unknown, even with retryPosts on", async () => {
    for (const body of [errorBody("SETTLEMENT_UNCONFIRMED"), { success: false, error: "Service unavailable" }]) {
      const { client, calls } = makeClient([
        { status: 503, body },
        { status: 200, body: quickBody },
      ]);
      const error = await client.buildPartyProfile(QUICK, { retryPosts: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(calls).toHaveLength(1);
    }
  });

  it("maps 400 VALIDATION_ERROR to ValidationError", async () => {
    const { client } = makeClient([{ status: 400, body: errorBody("VALIDATION_ERROR") }]);
    const error = await client.buildPartyProfile(QUICK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).apiCode).toBe("VALIDATION_ERROR");
  });

  it("maps 402 to InsufficientCreditsError", async () => {
    const { client } = makeClient([
      { status: 402, body: errorBody("INSUFFICIENT_API_CREDITS", { required: 304, balance: 50 }) },
    ]);
    const error = await client.buildPartyProfile(QUICK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect((error as InsufficientCreditsError).required).toBe(304);
  });

  it.each(["API_TIER_NOT_ALLOWED", "API_NOT_AVAILABLE_ON_TRIAL", "API_ENTERPRISE_ONLY"])(
    "maps 403 %s to PermissionError",
    async (code) => {
      const { client } = makeClient([
        { status: 403, body: errorBody(code, { tier: "free", upgradeUrl: "https://example.com/upgrade" }) },
      ]);
      const error = await client.buildPartyProfile(QUICK).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermissionError);
      expect((error as PermissionError).apiCode).toBe(code);
    },
  );

  it.each(["IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS"])("maps 409 %s to ConflictError", async (code) => {
    const { client } = makeClient([{ status: 409, body: errorBody(code) }]);
    const error = await client.buildPartyProfile(QUICK, { idempotencyKey: "profile-002" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).apiCode).toBe(code);
  });

  it.each(["PARTY_PROFILE_TOO_MANY_ACTIVE", "DISTINCT_NAMES_LIMIT_REACHED"])(
    "maps 429 %s to RateLimitError without retrying",
    async (code) => {
      const { client, calls } = makeClient([
        { status: 429, body: errorBody(code), headers: { "Retry-After": "1" } },
        { status: 200, body: quickBody },
      ]);
      const error = await client.buildPartyProfile(QUICK).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).apiCode).toBe(code);
      expect(calls).toHaveLength(1);
    },
  );

  it("retries a 429 RATE_LIMITED, which ran nothing", async () => {
    const { client, calls } = makeClient([
      { status: 429, body: errorBody("RATE_LIMITED"), headers: { "Retry-After": "0" } },
      { status: 200, body: quickBody },
    ]);
    await client.buildPartyProfile(QUICK);
    expect(calls).toHaveLength(2);
  });
});

describe("getPartyProfileRequest", () => {
  const statusBody = {
    success: true,
    data: {
      requestId: REQUEST_ID,
      mode: "full",
      status: "running",
      stage: "analyse",
      progress: {
        casesFound: 3,
        refreshesStarted: 2,
        refreshesFinished: 2,
        casesAnalysed: 1,
        casesNotAnalysed: 0,
        partyAnalysis: "pending",
      },
      createdAt: "2026-11-11T09:30:00.000Z",
      startedAt: "2026-11-11T09:30:02.000Z",
      finishedAt: null,
      resultExpiresAt: null,
      credits: {
        charged: 20,
        maxCredits: 1000,
        breakdown: {
          search: { credits: 9 },
          courtRefreshes: { count: 2, credits: 2 },
          caseAnalyses: { full: 1, short: 0, existing: 0, tokens: 4000, credits: 9 },
          partyAnalysis: { tokens: 0, credits: 0 },
        },
      },
    },
    meta: { creditsCharged: 0, metered: true },
  };

  it("GETs /party/profile/{requestId} with no body and no Idempotency-Key", async () => {
    const { client, calls } = makeClient([{ status: 200, body: statusBody }]);
    const res = await client.getPartyProfileRequest(REQUEST_ID);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/party/profile/${REQUEST_ID}`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(res.data.status).toBe("running");
    expect(res.data.credits.breakdown.courtRefreshes.count).toBe(2);
  });

  it("refuses an id that is not a ppr_ request id before sending anything", async () => {
    const { client, calls } = makeClient([]);
    for (const bad of ["", "ppr_123", "../audit", `${REQUEST_ID}/x`, "PPR_0123456789ABCDEF0123456789ABCDEF"]) {
      const error = await client.getPartyProfileRequest(bad).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it("maps 404 to NotFoundError", async () => {
    const { client } = makeClient([{ status: 404, body: errorBody("JOB_NOT_FOUND") }]);
    const error = await client.getPartyProfileRequest(REQUEST_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it("retries a 503 on the free status read", async () => {
    const { client, calls } = makeClient([
      { status: 503, body: errorBody("ACCOUNT_STANDING_UNAVAILABLE") },
      { status: 200, body: statusBody },
    ]);
    await client.getPartyProfileRequest(REQUEST_ID);
    expect(calls).toHaveLength(2);
  });
});

describe("deleteAuditActivityBefore", () => {
  const deletedBody = {
    success: true,
    data: {
      before: "2026-11-05T00:00:00.000Z",
      removed: 120,
      complete: true,
      note: "Activity of this API key before this time is deleted.",
    },
    meta: { creditsCharged: 0, metered: false },
  };

  it("sends DELETE /audit with before as a query parameter and no body", async () => {
    const { client, calls } = makeClient([{ status: 200, body: deletedBody }]);
    const res = await client.deleteAuditActivityBefore({ before: "2026-11-05T00:00:00Z" });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/audit?before=2026-11-05T00%3A00%3A00Z`);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(res.data.removed).toBe(120);
    expect(res.data.complete).toBe(true);
  });

  it("sends a Date as its UTC ISO string", async () => {
    const { client, calls } = makeClient([{ status: 200, body: deletedBody }]);
    await client.deleteAuditActivityBefore({ before: new Date(Date.UTC(2026, 10, 5)) });
    expect(new URL(calls[0]?.url ?? "").searchParams.get("before")).toBe("2026-11-05T00:00:00.000Z");
  });

  it("refuses a missing, blank or invalid before without sending anything", async () => {
    const { client, calls } = makeClient([]);
    for (const before of ["", "   ", new Date("not a date")]) {
      const error = await client.deleteAuditActivityBefore({ before }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
    }
    const missing = await client
      .deleteAuditActivityBefore({} as unknown as { before: string })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("is not retried after a network error, whatever retryPosts says", async () => {
    let count = 0;
    const fetch: FetchLike = async () => {
      count += 1;
      throw new TypeError("fetch failed");
    };
    const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 3, retryPosts: true });
    const error = await client.deleteAuditActivityBefore({ before: "2026-11-05T00:00:00Z" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CourtMeshError);
    expect((error as CourtMeshError).code).toBe("network_error");
    expect(count).toBe(1);
  });

  it.each([
    [500, ServerError, "INTERNAL_ERROR"],
    [502, BadGatewayError, "UPSTREAM_UNAVAILABLE"],
    [503, ServiceUnavailableError, "ACCOUNT_STANDING_UNAVAILABLE"],
    [504, CourtMeshError, "UPSTREAM_TIMEOUT"],
  ] as const)("is not retried after a %i", async (status, ErrorClass, code) => {
    const { client, calls } = makeClient(
      [
        { status, body: errorBody(code) },
        { status: 200, body: deletedBody },
      ],
      { maxRetries: 3 },
    );
    const error = await client.deleteAuditActivityBefore({ before: "2026-11-05T00:00:00Z" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(calls).toHaveLength(1);
  });

  it("is not retried after a timeout", async () => {
    let count = 0;
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        count += 1;
        init?.signal?.addEventListener("abort", () => {
          const abort = new Error("aborted");
          abort.name = "AbortError";
          reject(abort);
        });
      });
    const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 3 });
    const error = await client
      .deleteAuditActivityBefore({ before: "2026-11-05T00:00:00Z" }, { timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect((error as CourtMeshError).code).toBe("request_timeout");
    expect(count).toBe(1);
  });

  it("still retries a 429 RATE_LIMITED, which ran nothing", async () => {
    const { client, calls } = makeClient([
      { status: 429, body: errorBody("RATE_LIMITED"), headers: { "Retry-After": "0" } },
      { status: 200, body: deletedBody },
    ]);
    const res = await client.deleteAuditActivityBefore({ before: "2026-11-05T00:00:00Z" });
    expect(calls).toHaveLength(2);
    expect(res.data.complete).toBe(true);
  });

  it("maps 400, 401 and 403 to their typed errors", async () => {
    const { client } = makeClient([
      { status: 400, body: errorBody("VALIDATION_ERROR") },
      { status: 401, body: { error: "Invalid API key" } },
      { status: 403, body: errorBody("API_ENTERPRISE_ONLY") },
    ]);
    const before = { before: "2099-01-01T00:00:00Z" };
    await expect(client.deleteAuditActivityBefore(before)).rejects.toBeInstanceOf(ValidationError);
    await expect(client.deleteAuditActivityBefore(before)).rejects.toMatchObject({ code: "authentication_error" });
    await expect(client.deleteAuditActivityBefore(before)).rejects.toBeInstanceOf(PermissionError);
  });

  it("reports complete: false so the caller can send it again", async () => {
    const { client } = makeClient([
      { status: 200, body: { ...deletedBody, data: { ...deletedBody.data, removed: 5000, complete: false } } },
    ]);
    const res = await client.deleteAuditActivityBefore({ before: "2026-11-05T00:00:00Z" });
    expect(res.data.complete).toBe(false);
  });
});

describe("1.8.0 response fields", () => {
  it("search exposes cnrLookup and sameMatter", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [
            {
              id: "000000000000000000000003",
              score: 1,
              sameMatter: [{ caseId: "000000000000000000000004", caseType: "Order", decisionDate: null }],
            },
          ],
          cnrLookup: { cnr: CNR, status: "pending", requestId: "req_example" },
          meta: { query: "", filters: {}, responseTime: "5ms" },
          pagination: { total: 1, hasMore: false, limit: 20, nextCursor: null },
        },
      },
    ]);
    const res = await client.searchCases({ cnr: CNR });
    expect(res.cnrLookup?.status).toBe("pending");
    expect(res.data[0]?.sameMatter?.[0]?.caseId).toBe("000000000000000000000004");
  });

  it("orders expose unavailableReason, ordersTextWithheld and withheldReason", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            caseId: "000000000000000000000001",
            ordersTextWithheld: true,
            withheldReason: "not_published",
            documents: [
              {
                id: "00000000000000000000000a",
                kind: "order",
                date: "2026-11-06",
                orderNumber: "1",
                textAvailable: false,
                pdfAvailable: false,
                unavailableReason: "not_published",
              },
            ],
          },
        },
      },
    ]);
    const res = await client.listCaseOrders("000000000000000000000001");
    expect(res.data.ordersTextWithheld).toBe(true);
    expect(res.data.withheldReason).toBe("not_published");
    expect(res.data.documents[0]?.unavailableReason).toBe("not_published");
  });

  it("case by CNR exposes bench, courtRecordActs and courtRecordFir on the case", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            cnr: CNR,
            status: "found",
            case: {
              id: "000000000000000000000001",
              bench: "Example Bench",
              courtRecordActs: [{ act: "EXAMPLE ACT", sections: ["3"] }],
              courtRecordFir: [{ firNumber: "7", firYear: "2024" }],
            },
          },
        },
      },
    ]);
    const res = await client.getCaseByCnr(CNR);
    expect(res.data.case?.bench).toBe("Example Bench");
    expect(res.data.case?.courtRecordActs?.[0]?.act).toBe("EXAMPLE ACT");
    expect(res.data.case?.courtRecordFir?.[0]?.policeStation).toBeUndefined();
  });

  it("change feed exposes withheld", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [
            {
              id: "evt_example",
              type: "case.order_added",
              createdAt: "2026-11-10T00:00:00.000Z",
              cnr: CNR,
              caseId: null,
              withheld: "case_restricted",
              watchlists: [],
              data: {},
            },
          ],
          pagination: { nextCursor: "c1", hasMore: false },
        },
      },
    ]);
    const res = await client.listChanges();
    expect(res.data[0]?.withheld).toBe("case_restricted");
    expect(res.data[0]?.caseId).toBeNull();
  });
});
