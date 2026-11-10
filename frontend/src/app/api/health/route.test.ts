import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsIndexerConfigured, mockCheckDatabaseHealth } = vi.hoisted(() => ({
  mockIsIndexerConfigured: vi.fn<() => boolean>(),
  mockCheckDatabaseHealth: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/indexed-db", () => ({
  isIndexerConfigured: mockIsIndexerConfigured,
  checkDatabaseHealth: mockCheckDatabaseHealth,
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIndexerConfigured.mockReturnValue(false);
    mockCheckDatabaseHealth.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("answers immediately with 200 on the cheap liveness path without calling Horizon, RPC, or Postgres", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await GET(new Request("http://localhost:3000/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCheckDatabaseHealth).not.toHaveBeenCalled();
  });

  it("returns 200 on ?deep=1 when Horizon, RPC, and the configured database are healthy", async () => {
    mockIsIndexerConfigured.mockReturnValue(true);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ledgers")) {
        return new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "healthy" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const res = await GET(new Request("http://localhost:3000/api/health?deep=1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ok",
      checks: {
        horizon: { ok: true },
        rpc: { ok: true },
        database: { ok: true, configured: true },
      },
    });
  });

  it("returns 503 and reports Horizon when Horizon is unreachable on ?deep=1", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ledgers")) {
        throw new Error("connect ECONNREFUSED");
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "healthy" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const res = await GET(new Request("http://localhost:3000/api/health?deep=1"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unhealthy");
    expect(body.checks.horizon).toEqual({ ok: false, error: "connect ECONNREFUSED" });
    expect(body.checks.rpc).toEqual({ ok: true });
    expect(body.checks.database).toEqual({ ok: true, configured: false });
  });

  it("returns 503 and reports the database when Postgres fails on ?deep=1", async () => {
    mockIsIndexerConfigured.mockReturnValue(true);
    mockCheckDatabaseHealth.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/ledgers")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "healthy" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const res = await GET(new Request("http://localhost:3000/api/health?deep=1"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("unhealthy");
    expect(body.checks.horizon).toEqual({ ok: true });
    expect(body.checks.rpc).toEqual({ ok: true });
    expect(body.checks.database).toEqual({
      ok: false,
      configured: true,
      error: "connection terminated unexpectedly",
    });
  });
});
