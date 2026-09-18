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
