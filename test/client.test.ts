import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import { CourtMeshError } from "../src/errors.js";
import { queueFetch } from "./helpers.js";

const API_KEY = "cm-abcdefghij1234567890abcdefghijkl-wxyz";

function makeClient(entries: Parameters<typeof queueFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetch, calls } = queueFetch(entries);
  const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 1, ...overrides });
  return { client, calls };
}

describe("auth header", () => {
  it("sends Authorization: Bearer <key> on protected endpoints", async () => {
    const { client, calls } = makeClient([{ status: 200, body: { success: true, data: ["JUSTICE A"] } }]);
    await client.searchJudges({ q: "a" });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("omits Authorization on GET /health", async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { success: true, status: "healthy", version: "1.0.0", timestamp: "2026-08-10T09:00:00.000Z" } },
    ]);
    await client.health();
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe("1. searchJudges", () => {
  it("unwraps the envelope and exposes meta", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: ["JUSTICE A B", "JUSTICE C D"],
          meta: { query: "khanna", responseTime: "3ms", totalMatches: 2 },
        },
      },
    ]);
    const result = await client.searchJudges({ q: "khanna" });
    expect(result.data).toEqual(["JUSTICE A B", "JUSTICE C D"]);
    expect(result.meta?.totalMatches).toBe(2);
  });
});

describe("2. searchCases", () => {
  it("unwraps the envelope with the keyword pagination shape", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ _id: "abc", _score: 12.3, title: "State v. X" }],
          meta: { query: "murder", filters: { court: "Delhi HC" }, responseTime: "10ms" },
          pagination: { total: 1234, hasMore: true, page: 1, limit: 20, nextCursor: [12.34, "68f0"] },
        },
      },
    ]);
    const result = await client.searchCases({ query: "murder", court: "Delhi HC" });
    expect(result.data[0]?._id).toBe("abc");
    expect(result.pagination.total).toBe(1234);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.nextCursor).toEqual([12.34, "68f0"]);
    expect("totalPages" in result.pagination).toBe(false);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ query: "murder", court: "Delhi HC" });
  });

  it("walks pages with iterSearchCases until hasMore is false", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "1", score: 1 }],
          pagination: { total: 2, hasMore: true, page: 1, limit: 1, nextCursor: null },
        },
      },
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "2", score: 1 }],
          pagination: { total: 2, hasMore: false, page: 2, limit: 1, nextCursor: null },
        },
      },
    ]);

    const pages: string[] = [];
    for await (const page of client.iterSearchCases({ query: "x", limit: 1 })) {
      for (const hit of page) pages.push(hit.id);
    }
    expect(pages).toEqual(["1", "2"]);
  });

  it("walks pages with iterSearchCases using the signed cursor (self-serve on)", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "1", score: 1 }],
          pagination: { total: 2, hasMore: true, limit: 1, nextCursor: "signed.cursor.token" },
        },
      },
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "2", score: 1 }],
          pagination: { total: 2, hasMore: false, limit: 1, nextCursor: null },
        },
      },
    ]);

    const ids: string[] = [];
    for await (const page of client.iterSearchCases({ query: "x", limit: 1 })) {
      for (const hit of page) ids.push(hit.id);
    }
    expect(ids).toEqual(["1", "2"]);
    expect(calls[0]?.body).toMatchObject({ page: 1 });
    expect((calls[1]?.body as Record<string, unknown>)?.cursor).toBe("signed.cursor.token");
    expect((calls[1]?.body as Record<string, unknown>)?.page).toBeUndefined();
  });

  it("stops iterSearchCases on an empty page", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: { success: true, data: [], pagination: { total: 0, hasMore: false, page: 1, limit: 20, nextCursor: null } },
      },
    ]);
    const pages = [];
    for await (const page of client.iterSearchCases({ query: "nothing" })) {
      pages.push(page);
    }
    expect(pages).toEqual([]);
  });
});

describe("3. semanticSearch", () => {
  it("unwraps the envelope with the semantic pagination shape", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "c1", title: "A v. B", similarity: 0.82 }],
          meta: { query: "breach of contract", appliedFilters: {}, responseTime: "50ms", searchType: "semantic" },
          pagination: { page: 1, limit: 20, total: 41, totalPages: 3, hasMore: true },
        },
      },
    ]);
    const result = await client.semanticSearch({ query: "breach of contract" });
    expect(result.data[0]).toMatchObject({ id: "c1", similarity: 0.82 });
    expect(result.pagination.totalPages).toBe(3);
    expect("nextCursor" in result.pagination).toBe(false);
  });

  it("throws CourtMeshError when the HTTP 200 body has success: false", async () => {
    const { client } = makeClient([
      { status: 200, body: { success: false, error: "Failed to generate query embedding" } },
    ]);
    const error = await client.semanticSearch({ query: "abc" }).catch((e) => e);
    expect(error).toBeInstanceOf(CourtMeshError);
    expect(error.message).toBe("Failed to generate query embedding");
    expect(error.statusCode).toBe(200);
  });

  it("walks pages with iterSemanticSearch until hasMore is false", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "1", similarity: 0.9 }],
          pagination: { page: 1, limit: 1, total: 2, totalPages: 2, hasMore: true },
        },
      },
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "2", similarity: 0.8 }],
          pagination: { page: 2, limit: 1, total: 2, totalPages: 2, hasMore: false },
        },
      },
    ]);
    const ids: string[] = [];
    for await (const page of client.iterSemanticSearch({ query: "x", limit: 1 })) {
      for (const item of page) ids.push((item as { id: string }).id);
    }
    expect(ids).toEqual(["1", "2"]);
  });

  it("sends both the top level fields and the free-form filters object (filters wins on overlap, server side)", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [],
          meta: { query: "x", responseTime: "1ms", message: "No similar cases found." },
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
        },
      },
    ]);
    await client.semanticSearch({ query: "x", court: "Bombay HC", filters: { court: "Delhi HC", caseYear: 2024 } });
    expect(calls[0]?.body).toMatchObject({ court: "Bombay HC", filters: { court: "Delhi HC", caseYear: 2024 } });
  });
});

describe("4. getCase", () => {
  it("unwraps the case details envelope", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { id: "abc123", title: "State v. X", hasDocuments: true, hasAnalysis: false },
          meta: { responseTime: "5ms", note: "Use /cases/:id/analysis endpoint to get AI analysis separately" },
        },
      },
    ]);
    const result = await client.getCase("abc123");
    expect(result.data.id).toBe("abc123");
    expect(calls[0]?.url).toContain("/cases/abc123");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("5. getCaseAnalysis", () => {
  it("unwraps the not-available variant", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { id: "abc123", hasAnalysis: false, message: "AI analysis not available for this case" },
          meta: { responseTime: "2ms", note: "Use POST /cases/:id/analyze to generate AI analysis" },
        },
      },
    ]);
    const result = await client.getCaseAnalysis("abc123");
    expect(result.data.hasAnalysis).toBe(false);
  });

  it("unwraps the available variant", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { id: "abc123", hasAnalysis: true, analysis: { summary: "s", keyFacts: ["a"] } },
          meta: { responseTime: "2ms", note: "" },
        },
      },
    ]);
    const result = await client.getCaseAnalysis("abc123");
    expect(result.data.hasAnalysis).toBe(true);
    if (result.data.hasAnalysis) {
      expect(result.data.analysis.summary).toBe("s");
    }
  });
});

describe("6. getRelated", () => {
  it("unwraps related documents and timeline", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            relatedDocuments: [
              { id: "1", caseNumber: "CN1", decisionDate: "2024-01-01", isCurrent: true },
            ],
            timeline: [{ date: "2024-01-01", status: "Final Judgment", statusLabel: "Final Judgment", documentId: "1" }],
          },
          meta: { responseTime: "4ms", caseNumber: "CN1", totalDocuments: 1, timelineEvents: 1 },
        },
      },
    ]);
    const result = await client.getRelated("1");
    expect(result.data.relatedDocuments).toHaveLength(1);
    expect(result.data.timeline[0]?.status).toBe("Final Judgment");
  });
});

describe("7. getCasePdf", () => {
  it("unwraps the pdf envelope", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { pdfUrl: "cipher-text", expiresIn: 3600, caseId: "1", caseNumber: "CN1", caseTitle: "T" },
          meta: { responseTime: "1ms", note: "The PDF URL is encrypted and expires in 1 hour. Use the decryption key provided in your SDK." },
        },
      },
    ]);
    const result = await client.getCasePdf("1");
    expect(result.data.expiresIn).toBe(3600);
  });
});

describe("8. analyzeCase", () => {
  it("unwraps the processing (202) variant", async () => {
    const { client, calls } = makeClient([
      {
        status: 202,
        body: {
          success: true,
          data: { message: "Analysis has been started", status: "processing" },
          meta: { responseTime: "1ms", note: "You can check the analysis status by calling the GET /cases/:id endpoint in 30-60 seconds." },
        },
      },
    ]);
    const result = await client.analyzeCase("1");
    expect("status" in result.data && result.data.status).toBe("processing");
    expect(calls[0]?.body).toEqual({ force: false });
  });

  it("passes force: true through", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { message: "Analysis already exists", analysis: { summary: "s" }, alreadyExists: true },
          meta: { responseTime: "1ms", note: "" },
        },
      },
    ]);
    await client.analyzeCase("1", { force: true });
    expect(calls[0]?.body).toEqual({ force: true });
  });

  it("passes allowRemoteFetch: true through only when requested", async () => {
    const { client, calls } = makeClient([
      {
        status: 202,
        body: {
          success: true,
          data: { message: "Analysis has been started", status: "processing" },
          meta: { responseTime: "1ms", note: "" },
        },
      },
    ]);
    await client.analyzeCase("1", { allowRemoteFetch: true });
    expect(calls[0]?.body).toEqual({ force: false, allowRemoteFetch: true });
  });
});

describe("9. analyzeConsolidated", () => {
  it("unwraps the success status", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            status: "success",
            consolidatedAnalysis: { summary: "s", outcome: "allowed" },
            message: "done",
          },
          meta: { responseTime: "100ms", relatedCases: 5 },
        },
      },
    ]);
    const result = await client.analyzeConsolidated("1");
    expect(result.data.status).toBe("success");
    expect(result.meta?.relatedCases).toBe(5);
  });
});

describe("10. requestTimeline", () => {
  it("sends case_id and unwraps the job", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { requestId: "job1", status: "pending" },
          meta: { liveFetch: false, responseTime: "3ms" },
        },
      },
    ]);
    const result = await client.requestTimeline("abc123");
    expect(result.data.requestId).toBe("job1");
    expect(result.meta?.liveFetch).toBe(false);
    expect(calls[0]?.body).toEqual({ case_id: "abc123" });
  });

  it("sends refresh: true only when requested, and surfaces liveFetch/liveFetchSupported", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { requestId: "job2", status: "completed", liveFetchSupported: false },
          meta: { liveFetch: true, responseTime: "500ms" },
        },
      },
    ]);
    const result = await client.requestTimeline("abc123", { refresh: true });
    expect(calls[0]?.body).toEqual({ case_id: "abc123", refresh: true });
    expect(result.meta?.liveFetch).toBe(true);
    expect(result.data.liveFetchSupported).toBe(false);
  });
});

describe("11. getTimeline", () => {
  it("unwraps the polled job", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { requestId: "job1", status: "completed", createdAt: "t1", updatedAt: "t2", orderCount: 2, totalOrderCount: 2 },
          meta: { responseTime: "2ms" },
        },
      },
    ]);
    const result = await client.getTimeline("job1");
    expect(result.data.status).toBe("completed");
    expect(calls[0]?.url).toContain("/get-timeline/job1");
  });
});

describe("12. health", () => {
  it("is not enveloped in data", async () => {
    const { client } = makeClient([
      { status: 200, body: { success: true, status: "healthy", version: "1.0.0", timestamp: "2026-08-10T09:00:00.000Z" } },
    ]);
    const result = await client.health();
    expect(result.status).toBe("healthy");
    expect(result.version).toBe("1.0.0");
  });
});

describe("13. screenParty", () => {
  it("sends the request body and unwraps matches, coverage and meta", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            query: { name: "Acme Textiles Pvt Ltd", aliases: [], entityType: "company", purpose: "due_diligence", limit: 40, displayThreshold: 0.5 },
            summary: {
              matchCount: 1,
              byBand: { confirmed: 1, probable: 0, possible: 0, unlikely: 0 },
              highestBand: "confirmed",
              verdict: "matches_found",
            },
            matches: [
              {
                caseId: "abc123",
                title: "Acme Textiles Pvt Ltd v. State",
                court: "Delhi High Court",
                petitioners: ["Acme Textiles Pvt Ltd"],
                respondents: ["State"],
                partyRole: "petitioner",
                confidence: { band: "confirmed", score: 0.96, calibrated: 0.96, engine: "rules" },
                evidence: {
                  entityMatch: true,
                  matchedFields: ["name", "gstin"],
                  strategies: ["exact", "fuzzy"],
                  signals: [{ name: "gstin_match", status: "matched", weight: "strong", evidence: "07AAAAA0000A1Z5" }],
                  nameSimilarity: 0.98,
                  disambiguatorPresent: true,
                },
                rationale: "GSTIN and name both match.",
                casePageUrl: "https://research.courtmesh.ai/case/abc123",
              },
            ],
            relatedButUnverified: [],
            coverage: {
              exhaustive: true,
              exhaustiveWithinFilters: true,
              planClamped: false,
              anyStrategyErrored: false,
              strategiesRun: ["exact", "fuzzy"],
              someRecordsWithheld: false,
            },
            adjudicationsRun: 0,
            notice: "Results are public court records. See the case removal policy for takedown requests.",
          },
          meta: { creditsCharged: 100, adjudicated: false, corpusAsOf: "2026-09-17" },
        },
      },
    ]);

    const result = await client.screenParty({
      name: "Acme Textiles Pvt Ltd",
      entityType: "company",
      purpose: "due_diligence",
      identifiers: { gstin: "07AAAAA0000A1Z5" },
    });

    expect(result.data.summary.verdict).toBe("matches_found");
    expect(result.data.matches[0]?.confidence.band).toBe("confirmed");
    expect(result.data.coverage.exhaustive).toBe(true);
    expect(result.meta?.creditsCharged).toBe(100);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/party/screen");
    expect(calls[0]?.body).toMatchObject({
      name: "Acme Textiles Pvt Ltd",
      entityType: "company",
      purpose: "due_diligence",
      identifiers: { gstin: "07AAAAA0000A1Z5" },
    });
  });

  it("unwraps the no matches variant", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            query: { name: "A Very Uncommon Name", aliases: [], entityType: "person", purpose: "kyc", limit: 40, displayThreshold: 0.5 },
            summary: {
              matchCount: 0,
              byBand: { confirmed: 0, probable: 0, possible: 0, unlikely: 0 },
              highestBand: null,
              verdict: "no_matches_found",
            },
            matches: [],
            relatedButUnverified: [],
            coverage: {
              exhaustive: true,
              exhaustiveWithinFilters: true,
              planClamped: false,
              anyStrategyErrored: false,
              strategiesRun: ["exact", "fuzzy"],
              someRecordsWithheld: false,
            },
            adjudicationsRun: 0,
            notice: "Results are public court records.",
          },
          meta: { creditsCharged: 20, adjudicated: false, corpusAsOf: "2026-09-17" },
        },
      },
    ]);

    const result = await client.screenParty({ name: "A Very Uncommon Name", entityType: "person", purpose: "kyc" });
    expect(result.data.summary.verdict).toBe("no_matches_found");
    expect(result.meta?.creditsCharged).toBe(20);
  });
});

describe("14. coverage", () => {
  it("unwraps the coverage snapshot without requiring auth to be present", async () => {
    const { fetch, calls } = queueFetch([
      {
        status: 200,
        body: {
          success: true,
          data: {
            generatedAt: "2026-09-18T00:00:00.000Z",
            index: "courtmesh_cases_v3",
            total: 315_600_000,
            documentBearing: 12_000_000,
            statusOnly: 303_600_000,
            byCourtType: [{ courtType: "High Court", records: 40_000_000, documentBearing: 8_000_000, latestDecisionDate: "2026-09-17" }],
            byYear: [{ year: 2026, records: 1_200_000 }],
            courts: [
              {
                court: "Delhi High Court",
                courtType: "High Court",
                records: 2_000_000,
                documentBearing: 500_000,
                earliestDecisionDate: "1950-01-01",
                latestDecisionDate: "2026-09-17",
                businessDaysBehind: 1,
              },
            ],
            districtCourts: { records: 300_000_000, documentBearing: 1_000_000, latestDecisionDate: "2026-09-16", businessDaysBehind: 2 },
          },
          meta: { generatedAt: "2026-09-18T00:00:00.000Z", cacheTtlSeconds: 21600, corpusNote: "Counted 2026-09-18." },
        },
      },
    ]);
    const client = new CourtMeshClient({ fetch, maxRetries: 1 });

    const result = await client.coverage();

    expect(result.data.total).toBe(315_600_000);
    expect(result.data.districtCourts.records).toBe(300_000_000);
    expect(result.meta?.cacheTtlSeconds).toBe(21600);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/coverage");
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("sends the API key when the client is configured with one", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            generatedAt: "2026-09-18T00:00:00.000Z",
            index: "courtmesh_cases_v3",
            total: 1,
            documentBearing: 1,
            statusOnly: 0,
            byCourtType: [],
            byYear: [],
            courts: [],
            districtCourts: { records: 0, documentBearing: 0 },
          },
          meta: { generatedAt: "2026-09-18T00:00:00.000Z", cacheTtlSeconds: 21600 },
        },
      },
    ]);
    await client.coverage();
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });
});

describe("15. usage", () => {
  it("unwraps tier, balance, limits and per endpoint usage", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            tier: "payg",
            walletOwner: { type: "user", id: "u1" },
            balance: { total: 5000, monthlyGrant: 0, signupGrant: 1000, purchased: 4000 },
            limits: { requestsPerMinute: 60, requestsPerDay: 5000, requestsPerMonth: 100000, maxPageSize: 50, maxPaginationDepth: 500, distinctCaseFetchesPerDay: 200, pdfCallsPerMonth: 200, aiCallsPerMonth: 100, concurrentAnalyzeJobs: 2, apiKeys: 5, semanticSearchAllowed: true, liveFetchAllowed: true, liveFetchesPerDay: 20, analysisReadAllowed: true, partyScreensPerMonth: 100 },
            period: { start: "2026-09-01T00:00:00.000Z", end: "2026-09-30T18:29:59.999Z", key: "2026-09" },
            creditsUsedThisPeriod: 340,
            byEndpoint: [{ endpoint: "/api/v1/prod/search/cases", calls: 12, credits: 12 }],
            subscriptionRenewsAt: null,
          },
          meta: { requestId: "req-usage-1" },
        },
      },
    ]);

    const result = await client.usage();

    expect(result.data.tier).toBe("payg");
    expect(result.data.balance.total).toBe(5000);
    expect(result.data.byEndpoint[0]?.calls).toBe(12);
    expect(result.meta?.requestId).toBe("req-usage-1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/usage");
  });
});

describe("16. health(deep)", () => {
  it("plain form sends no query and is not enveloped in data", async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { success: true, status: "healthy", version: "1.0.0", commit: "abc123", timestamp: "2026-09-18T00:00:00.000Z" } },
    ]);
    const result = await client.health();
    expect(result.status).toBe("healthy");
    expect(result.checks).toBeUndefined();
    expect(calls[0]?.url).not.toContain("deep");
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("deep form sends ?deep=1 and surfaces checks", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          status: "degraded",
          version: "1.0.0",
          commit: "abc123",
          checks: { mongo: { status: "ok", latencyMs: 12 }, opensearch: { status: "degraded", latencyMs: 900 } },
          timestamp: "2026-09-18T00:00:00.000Z",
        },
      },
    ]);
    const result = await client.health({ deep: true });
    expect(result.status).toBe("degraded");
    expect(result.checks?.opensearch?.status).toBe("degraded");
    expect(calls[0]?.url).toContain("deep=1");
  });
});

describe("17. me", () => {
  it("unwraps the account identity", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: { success: true, data: { userId: "u1", email: "a@b.com", name: "A B", role: "ORG_ADMIN", organizationId: "org1" } },
      },
    ]);
    const result = await client.me();
    expect(result.data.userId).toBe("u1");
    expect(result.data.organizationId).toBe("org1");
    expect(calls[0]?.url).toContain("/me");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });
});

describe("18. audit", () => {
  it("sends query params and unwraps hits, summary and pagination", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            hits: [{ id: "h1", endpoint: "/api/v1/prod/search/cases", method: "POST", statusCode: 200, responseTime: 120, createdAt: "2026-09-18T00:00:00.000Z" }],
            summary: { totalHits: 1, totalAiAnalysisHits: 0, avgResponseTime: 120, successfulHits: 1, successRate: "100.0", totalCreditsDeducted: 1 },
            topEndpoints: [{ endpoint: "/api/v1/prod/search/cases", count: 1 }],
          },
          pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
        },
      },
    ]);

    const result = await client.audit({ userId: "u1", limit: 50, offset: 0 });

    expect(result.data.hits).toHaveLength(1);
    expect(result.data.summary.successRate).toBe("100.0");
    expect(result.pagination.total).toBe(1);
    expect(calls[0]?.url).toContain("userId=u1");
    expect(calls[0]?.url).toContain("limit=50");
  });
});

describe("19. referenceCourts", () => {
  it("unwraps the court hierarchy without requiring auth", async () => {
    const { fetch, calls } = queueFetch([
      {
        status: 200,
        body: {
          success: true,
          data: {
            courtTypes: ["Supreme Court", "High Court", "District Court", "Tribunal"],
            courtsByType: { "High Court": ["Delhi High Court"] },
            courtNamesByCourt: { "Delhi High Court": ["High Court of Delhi"] },
          },
        },
      },
    ]);
    const client = new CourtMeshClient({ fetch, maxRetries: 1 });

    const result = await client.referenceCourts();

    expect(result.data.courtTypes).toContain("High Court");
    expect(result.data.courtsByType["High Court"]).toContain("Delhi High Court");
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe("20. referenceCaseTypes", () => {
  it("unwraps the flattened case type list", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ code: "CRL.A", fullForm: "Criminal Appeal", primaryType: "Criminal", nature: "Appellate" }],
        },
      },
    ]);
    const result = await client.referenceCaseTypes();
    expect(result.data[0]?.code).toBe("CRL.A");
  });
});

describe("21. screenPartyBatch", () => {
  const batchBody = {
    success: true,
    data: {
      results: [
        {
          clientRef: "row-1",
          index: 0,
          ok: true,
          screen: {
            query: { name: "Acme Textiles Pvt Ltd", aliases: [], entityType: "company", purpose: "due_diligence", limit: 40, displayThreshold: 0.5 },
            summary: { matchCount: 0, byBand: { confirmed: 0, probable: 0, possible: 0, unlikely: 0 }, highestBand: null, verdict: "no_matches_found" },
            matches: [],
            relatedButUnverified: [],
            coverage: { exhaustive: true, exhaustiveWithinFilters: true, planClamped: false, anyStrategyErrored: false, strategiesRun: ["exact"], someRecordsWithheld: false },
            adjudicationsRun: 0,
            notice: "Results are public court records.",
          },
        },
        {
          clientRef: "row-2",
          index: 1,
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "name must be 2..200 characters" },
        },
      ],
      summary: { items: 2, matchesFound: 0, noMatches: 1, inconclusive: 0, errors: 1 },
    },
    meta: { creditsCharged: 20, requestId: "req-batch-1" },
  };

  it("sends items/purpose and unwraps per item ok/error results", async () => {
    const { client, calls } = makeClient([{ status: 200, body: batchBody }]);

    const result = await client.screenPartyBatch({
      items: [
        { clientRef: "row-1", name: "Acme Textiles Pvt Ltd", entityType: "company" },
        { clientRef: "row-2", name: "A" },
      ],
      purpose: "due_diligence",
    });

    expect(result.data.summary.items).toBe(2);
    expect(result.data.results[0]?.ok).toBe(true);
    expect(result.data.results[1]?.ok).toBe(false);
    if (result.data.results[1]?.ok === false) {
      expect(result.data.results[1].error.code).toBe("VALIDATION_ERROR");
    }
    expect(result.meta?.creditsCharged).toBe(20);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/party/screen/batch");
    expect(calls[0]?.body).toMatchObject({ purpose: "due_diligence" });
  });
});

describe("Idempotency-Key", () => {
  it("does not send an Idempotency-Key by default", async () => {
    const { client, calls } = makeClient([{ status: 202, body: { success: true, data: { message: "Analysis has been started", status: "processing" }, meta: { responseTime: "10ms", note: "" } } }]);
    await client.analyzeCase("case1");
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("sends an explicit idempotencyKey verbatim", async () => {
    const { client, calls } = makeClient([{ status: 202, body: { success: true, data: { message: "Analysis has been started", status: "processing" }, meta: { responseTime: "10ms", note: "" } } }]);
    await client.analyzeCase("case1", {}, { idempotencyKey: "my-key-123" });
    expect(calls[0]?.headers["idempotency-key"]).toBe("my-key-123");
  });

  it("auto-generates a UUID v4 Idempotency-Key when retryPosts is enabled and no key was given", async () => {
    const { client, calls } = makeClient(
      [{ status: 202, body: { success: true, data: { message: "Analysis has been started", status: "processing" }, meta: { responseTime: "10ms", note: "" } } }],
      { retryPosts: true },
    );
    await client.analyzeCase("case1");
    const key = calls[0]?.headers["idempotency-key"];
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("per-call retryPosts: true also triggers auto-generation for that one call", async () => {
    const { client, calls } = makeClient([{ status: 200, body: { success: true, data: { requestId: "job1", status: "completed" }, meta: { liveFetch: false, responseTime: "5ms" } } }]);
    await client.requestTimeline("case1", {}, { retryPosts: true });
    expect(calls[0]?.headers["idempotency-key"]).toBeTruthy();
  });

  it("surfaces Idempotency-Replayed: true as response.replayed", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: { success: true, data: { message: "Analysis has been started", status: "processing" }, meta: { responseTime: "10ms", note: "" } },
        headers: { "Idempotency-Replayed": "true" },
      },
    ]);
    const result = await client.analyzeCase("case1", {}, { idempotencyKey: "dup-1" });
    expect(result.replayed).toBe(true);
  });

  it("does not set replayed when the header is absent", async () => {
    const { client } = makeClient([{ status: 200, body: { success: true, status: "healthy", version: "1.0.0", timestamp: "2026-09-18T00:00:00.000Z" } }]);
    const result = await client.health();
    expect(result.requestId).toBeUndefined();
  });
});

describe("X-Request-Id backfill", () => {
  it("backfills response.requestId from the X-Request-Id header when the body has none", async () => {
    const { client } = makeClient([
      { status: 200, body: { success: true, status: "healthy", version: "1.0.0", timestamp: "2026-09-18T00:00:00.000Z" }, headers: { "X-Request-Id": "hdr-req-1" } },
    ]);
    const result = await client.health();
    expect(result.requestId).toBe("hdr-req-1");
  });

  it("does not overwrite an already present body-level requestId", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: { success: true, data: { userId: "u1", name: null, role: null }, requestId: "body-req-1" },
        headers: { "X-Request-Id": "hdr-req-2" },
      },
    ]);
    const result = await client.me();
    expect(result.requestId).toBe("body-req-1");
  });
});
