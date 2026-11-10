interface Endpoint {
  method: "GET" | "POST";
  path: string;
  description: string;
  params?: string;
  body?: string;
  example: string;
  notes?: string;
}

const endpoints: Endpoint[] = [
  {
    method: "GET",
    path: "/api/contract/:id",
    description:
      "Executable type, WASM hash, instance storage, indexed creator/deploymentLedger (when available), and historyGaps for a contract.",
    example: "/api/contract/CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5",
    notes:
      "Includes historyGaps ({ fromLedger, toLedger, reason, createdAt }[]) listing any ledger ranges the live indexer skipped due to RPC retention (empty array when no indexer is configured or no gaps occurred). Returns 404 if the contract is not found or unreachable.",
  },
  {
    method: "GET",
    path: "/api/contract/:id/wasm",
    description:
      "WASM bytecode size and a best-effort parsed ABI: function names, args and return types, any events the contract declares (name, topics, data fields), and its own type definitions (structs, unions, enums).",
    example: "/api/contract/CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5/wasm",
    notes:
      "Returns 400 if the contract has no WASM (e.g. a Stellar Asset Contract), 404 if the contract is not found, and 502 if the WASM bytecode could not be fetched.",
  },
  {
    method: "GET",
    path: "/api/contract/:id/events",
    description: "Events emitted by the contract.",
    params: "limit (default 50, max 100), cursor",
    example: "/api/contract/CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5/events?limit=10",
    notes:
      "Full history since the indexer started, when one is configured (see indexer/), newest first. Each response has a nextCursor, null on the last page; pass it back as cursor to get the older events. Without an indexer, the RPC node's retention window (~24h on public nodes) is returned in one response and nextCursor is always null. Returns 400 for an invalid cursor and 502 ({ events: [], nextCursor: null, error }) if the Soroban RPC lookup fails.",
  },
  {
    method: "GET",
    path: "/api/contract/:id/invocations",
    description: "Invocation history for the contract.",
    params: "limit (default 20, max 100), cursor",
    example: "/api/contract/CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5/invocations",
    notes:
      "Full history since the indexer started, when one is configured, newest first, paged with nextCursor as for events. Otherwise derived from recent events and returned in one response, bounded by the same RPC retention window — contracts that never emit events won't show up. Returns 400 for an invalid cursor.",
  },
  {
    method: "GET",
    path: "/api/contract/:id/storage/full",
    description: "Every storage key observed for the contract, at its latest known value.",
    example: "/api/contract/CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5/storage/full",
    notes:
      "Requires the indexer (returns 501 without one) — this is the one thing plain RPC access genuinely cannot do (no method exists to list a contract's storage keys). Forward-only: reflects activity since the indexer started, not full chain history.",
  },
  {
    method: "GET",
    path: "/api/contract/:id/storage",
    description: "Look up one persistent/temporary storage entry by key.",
    params: "key (required), kind: symbol|string|u32|address (required), durability: persistent|temporary (default persistent)",
    example: "/api/contract/CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5/storage?key=Admin&kind=symbol&durability=persistent",
    notes:
      "Works against live chain state via RPC regardless of whether an indexer is configured — you have to already know the key. Returns 400 if key/kind is missing or invalid, and 404 if no entry exists for that key. For enumeration without knowing keys in advance, see /storage/full.",
  },
  {
    method: "POST",
    path: "/api/contract/:id/simulate",
    description: "Simulate a function call against current ledger state (read-only preview).",
    body: '{ "functionName": "current_root", "args": [{ "value": "42", "type": "U32" }], "types"?: [...] }',
    example: "/api/contract/CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5/simulate",
    notes:
      "No signing, no submission, no funds at risk. Rate-limited more tightly than the read routes (10/min). Returns 400 for invalid JSON or arguments and 413 if the request body exceeds 16 KB.",
  },
  {
    method: "GET",
    path: "/api/tx/:hash",
    description:
      "Transaction detail plus decoded Soroban invocation (function/args), resource usage, and indexed returnValue, if any.",
    example: "/api/tx/c4a99120ad6b2c66d4b705b76e334f60c2c99af3f70d8b03be02c9df7dfe2fa6",
    notes: "Returns 404 if the transaction is not found.",
  },
  {
    method: "GET",
    path: "/api/ledger/:seq",
    description: "Ledger detail by sequence number.",
    example: "/api/ledger/4064026",
    notes: "Returns 400 for a non-numeric or out-of-range sequence number and 404 if the ledger is not found.",
  },
];

interface ErrorStatus {
  code: number;
  summary: string;
  detail: string;
}

const errorStatuses: ErrorStatus[] = [
  {
    code: 400,
    summary: "Bad Request",
    detail:
      "Invalid query parameter or request body — e.g. calling /wasm on a Stellar Asset Contract, an invalid pagination cursor on /events or /invocations, missing/invalid key or kind on /storage, invalid ledger sequence on /ledger/:seq, or malformed JSON / argument count mismatch on /simulate.",
  },
  {
    code: 404,
    summary: "Not Found",
    detail:
      "The requested contract (/api/contract/:id, /wasm), storage entry (/storage), transaction (/api/tx/:hash), or ledger (/api/ledger/:seq) does not exist.",
  },
  {
    code: 413,
    summary: "Payload Too Large",
    detail: "POST /api/contract/:id/simulate request body exceeds the 16 KB limit.",
  },
  {
    code: 429,
    summary: "Too Many Requests",
    detail:
      "Per-client rate limit exceeded (30/min on GET routes, 10/min on POST /simulate). Includes a Retry-After header with the number of seconds until the window resets.",
  },
  {
    code: 501,
    summary: "Not Implemented",
    detail:
      "GET /api/contract/:id/storage/full was called on a deployment without an indexer (DATABASE_URL not configured).",
  },
  {
    code: 502,
    summary: "Bad Gateway",
    detail:
      "Upstream Soroban RPC lookup failed — e.g. GET /api/contract/:id/wasm could not fetch WASM bytecode, or GET /api/contract/:id/events failed to query RPC ({ events: [], nextCursor: null, error }).",
  },
];

export default function DocsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">API</h1>
      <p className="text-prism-muted text-sm mb-8 max-w-2xl">
        Read-only JSON endpoints backing the explorer — the same data layer the UI uses. All GET routes are
        rate-limited to 30 requests/minute per client; <code className="font-mono">/simulate</code> to
        10/minute. No API key required.
      </p>

      <div className="space-y-6">
        {endpoints.map((ep) => (
          <div key={ep.method + ep.path} className="rounded-xl border border-prism-border bg-prism-surface p-5">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <span
                className={`font-mono text-xs font-bold px-2 py-0.5 rounded ${
                  ep.method === "GET" ? "bg-prism-accent/20 text-prism-accent" : "bg-prism-green/20 text-prism-green"
                }`}
              >
                {ep.method}
              </span>
              <span className="font-mono text-sm">{ep.path}</span>
            </div>
            <p className="text-sm text-prism-muted mb-3">{ep.description}</p>
            {ep.params && (
              <p className="text-xs font-mono text-prism-muted mb-1">
                <span className="text-prism-strong">params:</span> {ep.params}
              </p>
            )}
            {ep.body && (
              <p className="text-xs font-mono text-prism-muted mb-1 break-all">
                <span className="text-prism-strong">body:</span> {ep.body}
              </p>
            )}
            <p className="text-xs font-mono text-prism-muted break-all mt-2">
              <span className="text-prism-strong">example:</span> {ep.example}
            </p>
            {ep.notes && <p className="text-xs text-prism-muted mt-2 italic">{ep.notes}</p>}
          </div>
        ))}
      </div>

      <div className="mt-10">
        <h2 className="text-lg font-bold mb-2">Errors</h2>
        <p className="text-prism-muted text-sm mb-4 max-w-2xl">
          Non-200 responses return JSON with an <code className="font-mono">{`{ "error": string }`}</code> body
          describing the failure (<code className="font-mono">/simulate</code> argument errors include{" "}
          <code className="font-mono">{`"success": false`}</code>, and <code className="font-mono">/events</code>{" "}
          502 responses return <code className="font-mono">{`{ "events": [], "nextCursor": null, "error": string }`}</code>
          ). When rate-limited (<code className="font-mono">429</code>), the response includes a{" "}
          <code className="font-mono">Retry-After</code> header (in seconds).
        </p>

        <div className="rounded-xl border border-prism-border bg-prism-surface divide-y divide-prism-border">
          {errorStatuses.map((status) => (
            <div key={status.code} className="p-4 flex flex-col sm:flex-row sm:items-baseline gap-2 sm:gap-4">
              <div className="flex items-center gap-2 shrink-0 sm:w-48">
                <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-red-500/20 text-red-400">
                  {status.code}
                </span>
                <span className="font-mono text-xs text-prism-strong">{status.summary}</span>
              </div>
              <p className="text-xs text-prism-muted">{status.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
