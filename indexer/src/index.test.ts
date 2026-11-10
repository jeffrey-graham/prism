import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  commitPage,
  healthReport,
  metricLedgersProcessed,
  metricPagesProcessed,
  seedLastLedger,
} from "./index.js";

describe("backoffDelay", () => {
  it("doubles the delay for each consecutive failure", () => {
    const upperBound = (failures: number) => backoffDelay(failures, () => 1);
    expect([1, 2, 3, 4].map(upperBound)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("never lets a later failure wait less than an earlier one could, until the cap", () => {
    // Failure 7 onward hits the 60s cap, so the ranges overlap from there on.
    for (let failures = 2; failures <= 6; failures++) {
      const shortest = backoffDelay(failures, () => 0);
      const longestBefore = backoffDelay(failures - 1, () => 1);
      expect(shortest).toBeGreaterThanOrEqual(longestBefore);
    }
  });

  it("caps the delay at the maximum", () => {
    expect(backoffDelay(50, () => 1)).toBe(60_000);
    expect(backoffDelay(50, () => 0)).toBe(30_000);
  });
});

describe("healthReport", () => {
  const base = { cursor: 100, latestLedger: 102, lastPollFailed: false };

  it("is healthy when the cursor is within the lag threshold", () => {
    expect(healthReport(base, 60)).toEqual({ healthy: true, ...base, lag: 2 });
  });

  it("is unhealthy when the lag passes the threshold", () => {
    expect(healthReport({ ...base, latestLedger: 161 }, 60)).toMatchObject({ healthy: false, lag: 61 });
    expect(healthReport({ ...base, latestLedger: 160 }, 60)).toMatchObject({ healthy: true, lag: 60 });
  });

  it("is unhealthy when the last poll failed", () => {
    expect(healthReport({ ...base, lastPollFailed: true }, 60)).toMatchObject({ healthy: false });
  });

  it("never reports a negative lag", () => {
    expect(healthReport({ ...base, latestLedger: 90 }, 60)).toMatchObject({ healthy: true, lag: 0 });
  });
});

describe("seedLastLedger", () => {
  const network = { latestLedger: 500, oldestLedger: 400 };

  it("seeds at the latest ledger when INDEXER_START_LEDGER is unset or blank", () => {
    expect(seedLastLedger(undefined, network)).toBe(500);
    expect(seedLastLedger("  ", network)).toBe(500);
  });

  it("seeds one below the start ledger, so the start ledger is the first one indexed", () => {
    expect(seedLastLedger("450", network)).toBe(449);
  });

  it("accepts both edges of the retention window", () => {
    expect(seedLastLedger("400", network)).toBe(399);
    expect(seedLastLedger("500", network)).toBe(499);
  });

  it("rejects a start ledger outside the retention window", () => {
    expect(() => seedLastLedger("399", network)).toThrow(/retention window/);
    expect(() => seedLastLedger("501", network)).toThrow(/retention window/);
  });

  it("rejects values that are not positive integers", () => {
    for (const raw of ["abc", "1.5", "0", "-3"]) {
      expect(() => seedLastLedger(raw, network)).toThrow(/positive integer/);
    }
  });
});

describe("commitPage", () => {
  type Client = Parameters<typeof commitPage>[2];

  /**
   * Fake client whose $transaction stages writes and applies them only when the
   * callback resolves, mirroring a rollback on error. `failOn` injects a throw
   * from the named table's write, after earlier writes in the same transaction.
   */
  function fakeClient(failOn?: "indexerCursor") {
    const committed = {
      gaps: [] as unknown[],
      cursor: { lastLedger: 100, paginationCursor: null as string | null },
    };
    const client = {
      $transaction: async (fn: (db: unknown) => Promise<void>) => {
        const staged = { gaps: [] as unknown[], cursor: undefined as undefined | typeof committed.cursor };
        const db = {
          indexerGap: {
            create: async ({ data }: { data: unknown }) => {
              staged.gaps.push(data);
            },
          },
          indexerCursor: {
            upsert: async ({ update }: { update: typeof committed.cursor }) => {
              if (failOn === "indexerCursor") throw new Error("injected failure");
              staged.cursor = update;
            },
          },
        };
        await fn(db);
        committed.gaps.push(...staged.gaps);
        committed.cursor = staged.cursor ?? committed.cursor;
      },
    };
    return { client: client as unknown as Client, committed };
  }

  it("applies the gap record and the cursor together", async () => {
    const { client, committed } = fakeClient();
    const gap = { fromLedger: 101, toLedger: 300, reason: "RPC retention" };
    await commitPage([], { lastLedger: 300, paginationCursor: null, gap }, client);
    expect(committed.gaps).toEqual([gap]);
    expect(committed.cursor).toEqual({ lastLedger: 300, paginationCursor: null });
  });

  it("leaves no new rows and an unchanged cursor when a failure follows the inserts", async () => {
    const { client, committed } = fakeClient("indexerCursor");
    const gap = { fromLedger: 101, toLedger: 300, reason: "RPC retention" };
    await expect(
      commitPage([], { lastLedger: 300, paginationCursor: null, gap }, client)
    ).rejects.toThrow("injected failure");
    expect(committed.gaps).toEqual([]);
    expect(committed.cursor).toEqual({ lastLedger: 100, paginationCursor: null });
  });

  it("records the number of ledgers advanced (40 when advancing from 100 to 140)", async () => {
    metricLedgersProcessed.reset();
    metricPagesProcessed.reset();
    const { client } = fakeClient();

    await commitPage([], { lastLedger: 140, paginationCursor: null }, client, 100);

    const ledgersMetric = await metricLedgersProcessed.get();
    const pagesMetric = await metricPagesProcessed.get();
    expect(ledgersMetric.values[0]?.value ?? 0).toBe(40);
    expect(pagesMetric.values[0]?.value ?? 0).toBe(0);
  });

  it("counts a ledger split across three pages once in ledgers_processed and three times in pages_processed", async () => {
    metricLedgersProcessed.reset();
    metricPagesProcessed.reset();

    const nopClient = {
      $transaction: async () => {},
    } as unknown as Client;
    const dummyTx = {} as never;

    await commitPage([dummyTx], { lastLedger: 105, paginationCursor: "c1" }, nopClient, 104);
    await commitPage([dummyTx], { lastLedger: 105, paginationCursor: "c2" }, nopClient, 105);
    await commitPage([dummyTx], { lastLedger: 105, paginationCursor: null }, nopClient, 105);

    const ledgersMetric = await metricLedgersProcessed.get();
    const pagesMetric = await metricPagesProcessed.get();
    expect(ledgersMetric.values[0]?.value ?? 0).toBe(1);
    expect(pagesMetric.values[0]?.value ?? 0).toBe(3);
  });
});
