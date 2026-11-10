import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { checkDatabaseHealth, isIndexerConfigured } from "@/lib/indexed-db";

export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 5_000;

export interface DependencyStatus {
  ok: boolean;
  configured?: boolean;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkHorizon(): Promise<DependencyStatus> {
  try {
    const res = await fetch(`${config.horizonUrl}/ledgers?order=desc&limit=1`, {
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `Horizon returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function checkRpc(): Promise<DependencyStatus> {
  try {
    const res = await fetch(config.sorobanRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `Soroban RPC returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      result?: { status?: string };
      error?: { message?: string };
    };
    if (body.error) {
      return { ok: false, error: body.error.message ?? "Soroban RPC error" };
    }
    if (body.result?.status && body.result.status !== "healthy") {
      return { ok: false, error: `Soroban RPC status: ${body.result.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function checkDatabase(): Promise<DependencyStatus> {
  if (!isIndexerConfigured()) {
    return { ok: true, configured: false };
  }
  try {
    await checkDatabaseHealth();
    return { ok: true, configured: true };
  } catch (err) {
    return { ok: false, configured: true, error: errorMessage(err) };
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const deepParam = url.searchParams.get("deep");
  const isDeep = deepParam === "1" || deepParam === "true";

  if (!isDeep) {
    return NextResponse.json(
      { status: "ok" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  const [horizon, rpc, database] = await Promise.all([
    checkHorizon(),
    checkRpc(),
    checkDatabase(),
  ]);

  const healthy = horizon.ok && rpc.ok && database.ok;
  return NextResponse.json(
    {
      status: healthy ? "ok" : "unhealthy",
      checks: { horizon, rpc, database },
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
