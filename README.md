# @pipeworx/fracfocus

U.S. hydraulic fracturing chemical disclosures -- well-level frac job
records (operator, API number, location, dates, base fluid volumes) and
the chemical additives/ingredients disclosed for each job (trade name,
supplier, purpose, CAS number, mass, percent of job). Fleet #2982.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1807+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `frac_wells(state?, county?, operator?, limit?, offset?)` -- search
  FracFocus well-level disclosures by state, county, and/or operator name
  (operator matches as a substring). At least one of the three is
  required. Covers FracFocus's full disclosure history. Returns each
  well's API number, operator, well name, location, job dates, and base
  fluid volumes, newest job first.
- `frac_chemicals(api_number, limit?, offset?)` -- the chemical ingredient
  list disclosed for one well, by API number (dashes optional). Returns
  trade name, supplier, purpose, CAS number, ingredient name, percent of
  the job by mass, and mass in pounds per ingredient; trade-secret
  ingredients carry no CAS number and a claimant company instead.
  Ingredient-level detail is only loaded for jobs on or after this pack's
  coverage cutoff -- a well that exists in `frac_wells` but predates that
  cutoff returns `found:false, reason:"outside_ingredients_coverage"`,
  distinct from `reason:"unknown_api_number"` when the well itself is not
  in FracFocus at all.
- `chemical_usage(cas_number, state?, limit?, offset?)` -- where a
  chemical has been used, by CAS number (dashes optional), optionally
  scoped to one state. Returns a summary (total ingredient-disclosure
  rows, distinct wells, distinct states) plus a sample of matching usage
  records. Only searches the ingredients coverage window, same caveat as
  `frac_chemicals`.

Every response carries `source`, `source_url`, `license`, and the
ingredients coverage window (`ingredients_since` / `disclosures_through`),
so a caller can tell "this well disclosed no chemicals" apart from "this
well's job predates what we've loaded."

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds
the data; a standalone `npm install` has no data to read, and every tool
throws a clear "not bound in this runtime" error there instead of
returning an empty list.

## Data sources

- FracFocus (Ground Water Protection Council / Interstate Oil and Gas
  Compact Commission) -- the national hydraulic fracturing chemical
  disclosure registry. FracFocus publishes only a bulk CSV download, no
  per-request API, so this pack builds a copy into D1
  (`scripts/fracfocus/load-data.mjs`) rather than proxying per request.
  **Licence (quoted verbatim, checked live 2026-10-14):** *"Downloaded
  data may be aggregated or combined with other datasets, but the
  FracFocus data may not be altered in any way."* Also: *"Data submitted
  appears as it was submitted by the operator or operator's authorized
  agent. FracFocus does not warrant the data in any way."* This pack
  reformats CSV rows into SQL rows and scopes the ingredients table to a
  recent date window (below) -- it does not change any retained value.

### Known gaps -- read before extending this pack

**The ingredients table (`ff_ingredients`) is NOT full history.** FracFocus's
bulk download holds ~250k well disclosures (`DisclosureList_#.csv`, loaded
in full) but ~7.3M chemical-ingredient rows (`FracFocusRegistry_#.csv`,
measured 2026-10-14) -- each disclosure's ingredient rows also repeat every
well-header column, which this pack does not store a second time (it joins
back to `ff_disclosures` by `disclosure_id` instead). Loading all 7.3M
ingredient rows in one pass would mean roughly 10x the `wrangler d1 execute`
round trips of the first load. **The first load scopes `ff_ingredients` to
jobs on or after `--since` (default `2024-01-01`)** -- measured 2026-10-14,
that is ~646k rows after dropping ~11% pure-placeholder rows that carry
neither a CAS number nor an ingredient name ("Ingredient Container"
administrative rows with no chemical content). `frac_wells` (which only
reads `ff_disclosures`) covers full history regardless; `frac_chemicals`
and `chemical_usage` (which read `ff_ingredients`) only answer within the
loaded window, and say so explicitly (`reason:"outside_ingredients_coverage"`)
rather than returning an empty success for an older well.

**Same shape as `mcps/bts-ontime`'s "most recent N months" first load** --
see that pack's README for the precedent. Extend coverage further back with
`node scripts/fracfocus/load-data.mjs --since 2020-01-01` (or any earlier
date); `ff_ingredients` inserts are additive and filtered by date, so a
wider `--since` on a later run adds older rows without re-touching what is
already loaded, while `ff_disclosures` is fully reloaded every run (cheap,
small table, and the simplest way to pick up newly-published disclosures).

**WaterSource data is not loaded.** FracFocus 4.0 (12/1/2023) added an
optional water-source-of-supply file (`WaterSource_#.csv`, ~5MB,
well-level). Not in this pack's tool set -- add a table for it if a future
tool needs it.

### Refreshing the data

FracFocus updates "5 days a week" per its own download page and publishes
no incremental/delta feed, so a refresh re-downloads and reprocesses the
full bulk zip: `node scripts/fracfocus/load-data.mjs` (needs `wrangler`
logged in to the Pipeworx Cloudflare account, and the `unzip` CLI). Run
monthly, or with a wider `--since` to extend historical ingredient
coverage further back.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fracfocus": {
      "url": "https://gateway.pipeworx.io/fracfocus/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fracfocus/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1807+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/frac_wells \
  -H 'Content-Type: application/json' \
  -d '{"state":"Texas","county":"Martin","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/frac_wells`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "fracfocus": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fracfocus"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-fracfocus
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fracfocus data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
