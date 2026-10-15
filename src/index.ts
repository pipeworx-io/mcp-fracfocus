interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * fracfocus -- U.S. hydraulic fracturing chemical disclosures (fleet #2982).
 *
 * Data: FracFocus (fracfocus.org), the national hydraulic-fracturing
 * chemical disclosure registry run jointly by the Ground Water Protection
 * Council and the Interstate Oil and Gas Compact Commission -- well-level
 * job records (operator, API number, location, dates) and the chemical
 * additives/ingredients (trade name, supplier, purpose, CAS number, mass,
 * percent of job) disclosed for each job. FracFocus publishes only a bulk
 * CSV download (fracfocus.org/data-download) with no per-request API, so
 * this pack builds a copy (scripts/fracfocus/load-data.mjs) into a D1
 * database the gateway hands it as `_d1` (pack-manifest "d1Binding":
 * "FRACFOCUS_DB"). Design note: this file + store.ts.
 *
 * FracFocus terms of use (quoted, not paraphrased): "Downloaded data may be
 * aggregated or combined with other datasets, but the FracFocus data may
 * not be altered in any way." This pack reformats CSV rows into SQL rows
 * and scopes the ingredients table to a recent date window (see
 * load-data.mjs) -- it does not change any retained value.
 *
 * SCOPE: ff_disclosures (well headers) loads FracFocus's full history.
 * ff_ingredients (chemical-level detail, ~20x the row volume) loads only
 * disclosures on or after a cutoff date -- see load-data.mjs "SCOPE OF
 * THIS FIRST LOAD" and README.md "Known gaps". frac_chemicals and
 * chemical_usage both read ff_ingredients, so they answer only within that
 * window; frac_wells (ff_disclosures only) covers full history.
 *
 * Every response carries `source`, `source_url`, `license`, and the
 * ingredients coverage window (`ingredients_since`), so a caller can tell
 * "this well disclosed no chemicals" apart from "this well's job predates
 * what we've loaded".
 */
import {
  countChemicalUsage,
  countIngredientsByDisclosureIds,
  countWells,
  findChemicalUsage,
  findDisclosuresByApi,
  findIngredientsByDisclosureIds,
  findWells,
  getMeta,
  normalizeApiNumber,
  normalizeCas,
  requireDb,
  sampleChemicalName,
  SOURCE,
  type D1Like,
} from './store.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'frac_wells',
    description:
      'Hydraulic fracturing job disclosures (wells) from FracFocus, the national frac-chemical disclosure registry -- filter by state, county, and/or operator name (operator matches as a substring, case-insensitive). Returns each well\'s API number, operator, well name, location, job dates, and base fluid volumes, newest job first. Covers FracFocus\'s full disclosure history (back to its earliest submissions, most of it from 2011 on). Pass the API number from a result into frac_chemicals to get that job\'s chemical ingredient list. At least one of state, county, or operator is required -- an unscoped scan of ~250k disclosures is not supported.',
    summary: 'Search FracFocus well-level frac job disclosures by state/county/operator.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', description: 'US state name, e.g. "Texas" (full name, case-insensitive; FracFocus stores state as a name, not a postal code).' },
        county: { type: 'string', description: 'County name, e.g. "Martin". Case-insensitive exact match.' },
        operator: { type: 'string', description: 'Operator name, substring match, case-insensitive, e.g. "Pioneer".' },
        limit: { type: 'number', description: 'Max rows, 1-200. Default 50. A truncated response carries truncated:true, total_matching, and a hint for narrowing.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
      anyOf: [{ required: ['state'] }, { required: ['county'] }, { required: ['operator'] }],
    },
  },
  {
    name: 'frac_chemicals',
    description:
      'Chemical ingredient list disclosed for one well, by API number (the American Petroleum Institute well identifier, e.g. "42-317-37262-00-00" or "4231737262" -- dashes optional). Returns, per disclosed job on that well: trade name, supplier, purpose (e.g. "Surfactant", "Biocide", "Proppant"), CAS number, ingredient name, percent of the hydraulic fracturing job by mass, and mass in pounds; trade-secret ingredients carry no CAS number and the claimant company instead. Ingredient-level detail is only loaded for jobs on or after this pack\'s coverage cutoff (see data_as_of/ingredients_since in the response) -- a well found in frac_wells but outside that window returns found:false with reason "outside_ingredients_coverage", distinct from reason "unknown_api_number" when the well itself does not exist in FracFocus at all.',
    summary: 'Chemical ingredients disclosed for one well by API number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        api_number: { type: 'string', description: 'API well number, with or without dashes, e.g. "42-317-37262-00-00" or "4231737262".' },
        limit: { type: 'number', description: 'Max ingredient rows, 1-500. Default 100.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
      required: ['api_number'],
    },
  },
  {
    name: 'chemical_usage',
    description:
      'Where a chemical has been used in hydraulic fracturing jobs, by CAS number (e.g. "7732-18-5" for water, dashes optional) -- optionally scoped to one state. Returns a summary (total ingredient-disclosure rows, distinct wells, distinct states) plus a sample of matching usage records: well, operator, state/county, trade name, purpose, and mass. Only searches this pack\'s ingredients coverage window (see ingredients_since in the response), not FracFocus\'s full history. A CAS number that is valid but never appears in the loaded window returns found:false, not an empty success.',
    summary: 'Find wells/jobs that used a given chemical (by CAS number), optionally scoped to a state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cas_number: { type: 'string', description: 'CAS Registry Number, with or without dashes, e.g. "7732-18-5" or "7732185".' },
        state: { type: 'string', description: 'US state name to scope the search, e.g. "Texas". Optional.' },
        limit: { type: 'number', description: 'Max sample rows, 1-200. Default 50.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
      required: ['cas_number'],
    },
  },
];

function clampInt(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
function str(v: unknown): string | null {
  return v != null && v !== '' ? String(v).trim() : null;
}

async function fracWellsTool(db: D1Like, args: Record<string, unknown>) {
  const meta = await getMeta(db);
  const state = str(args.state);
  const county = str(args.county);
  const operator = str(args.operator);
  if (!state && !county && !operator) {
    return {
      found: false,
      reason: 'no_scope',
      message: 'At least one of state, county, or operator is required.',
      data_as_of: meta.loaded_at,
    };
  }
  const limit = clampInt(args.limit, 1, 200, 50);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const filter = { state: state ?? undefined, county: county ?? undefined, operator: operator ?? undefined, limit, offset };
  const [rows, total] = await Promise.all([findWells(db, filter), countWells(db, filter)]);
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_match',
      state: state ?? null,
      county: county ?? null,
      operator: operator ?? null,
      message: `No FracFocus disclosures matched state=${JSON.stringify(state)}, county=${JSON.stringify(county)}, operator=${JSON.stringify(operator)}.`,
      disclosures_through: meta.disclosures_through,
      data_as_of: meta.loaded_at,
    };
  }
  const truncated = rows.length + offset < total;
  return {
    found: true,
    state: state ?? null,
    county: county ?? null,
    operator: operator ?? null,
    returned: rows.length,
    total_matching: total,
    truncated,
    ...(truncated ? { hint: 'More rows exist than were returned. Narrow with county and/or operator, or page with limit/offset.' } : {}),
    wells: rows.map((r) => ({
      disclosure_id: r.disclosure_id,
      api_number: r.api_number,
      operator: r.operator,
      well_name: r.well_name,
      state: r.state,
      county: r.county,
      latitude: r.latitude,
      longitude: r.longitude,
      job_start_date: r.job_start_date,
      job_end_date: r.job_end_date,
      total_base_water_volume_gal: r.total_base_water_volume,
      total_base_non_water_volume_gal: r.total_base_non_water_volume,
      federal_well: !!r.federal_well,
      indian_well: !!r.indian_well,
    })),
    source: SOURCE.source_dataset,
    source_url: SOURCE.source_url,
    license: SOURCE.license,
    disclosures_through: meta.disclosures_through,
    data_as_of: meta.loaded_at,
  };
}

async function fracChemicalsTool(db: D1Like, args: Record<string, unknown>) {
  const meta = await getMeta(db);
  const apiNorm = normalizeApiNumber(args.api_number);
  if (!apiNorm) {
    return {
      found: false,
      reason: 'invalid_api_number',
      message: `${JSON.stringify(args.api_number)} does not look like an API well number (need at least 6 digits).`,
      data_as_of: meta.loaded_at,
    };
  }
  const disclosures = await findDisclosuresByApi(db, apiNorm);
  if (!disclosures.length) {
    return {
      found: false,
      reason: 'unknown_api_number',
      api_number: args.api_number,
      message: `No FracFocus disclosure found for API number ${JSON.stringify(args.api_number)}.`,
      disclosures_through: meta.disclosures_through,
      data_as_of: meta.loaded_at,
    };
  }
  const limit = clampInt(args.limit, 1, 500, 100);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const disclosureIds = disclosures.map((d) => d.disclosure_id);
  const [rows, total] = await Promise.all([
    findIngredientsByDisclosureIds(db, disclosureIds, limit, offset),
    countIngredientsByDisclosureIds(db, disclosureIds),
  ]);
  if (!rows.length) {
    return {
      found: false,
      reason: 'outside_ingredients_coverage',
      api_number: args.api_number,
      wells: disclosures.map((d) => ({ disclosure_id: d.disclosure_id, operator: d.operator, well_name: d.well_name, job_start_date: d.job_start_date })),
      message: `API number ${JSON.stringify(args.api_number)} is a real FracFocus well, but its disclosed job(s) predate this pack's ingredients coverage window (loaded since ${meta.ingredients_since}). Well header data is available; chemical-level detail is not loaded for this job yet.`,
      ingredients_since: meta.ingredients_since,
      data_as_of: meta.loaded_at,
    };
  }
  const truncated = rows.length + offset < total;
  return {
    found: true,
    api_number: args.api_number,
    wells: disclosures.map((d) => ({ disclosure_id: d.disclosure_id, operator: d.operator, well_name: d.well_name, state: d.state, county: d.county, job_start_date: d.job_start_date })),
    returned: rows.length,
    total_matching: total,
    truncated,
    ...(truncated ? { hint: 'More ingredient rows exist than were returned. Page with limit/offset.' } : {}),
    ingredients: rows.map((r) => ({
      disclosure_id: r.disclosure_id,
      trade_name: r.trade_name,
      supplier: r.supplier,
      purpose: r.purpose,
      cas_number: r.cas_number,
      ingredient_name: r.ingredient_name,
      ingredient_common_name: r.ingredient_common_name,
      percent_hf_job: r.percent_hf_job,
      mass_lbs: r.mass_lbs,
      msds: !!r.msds,
      claimant_company: r.claimant_company,
    })),
    source: SOURCE.source_dataset,
    source_url: SOURCE.source_url,
    license: SOURCE.license,
    ingredients_since: meta.ingredients_since,
    data_as_of: meta.loaded_at,
  };
}

async function chemicalUsageTool(db: D1Like, args: Record<string, unknown>) {
  const meta = await getMeta(db);
  const casNorm = normalizeCas(args.cas_number);
  if (!casNorm) {
    return {
      found: false,
      reason: 'invalid_cas_number',
      message: `${JSON.stringify(args.cas_number)} does not look like a CAS Registry Number (need at least 4 digits).`,
      data_as_of: meta.loaded_at,
    };
  }
  const state = str(args.state);
  const limit = clampInt(args.limit, 1, 200, 50);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const filter = { cas_norm: casNorm, state: state ?? undefined, limit, offset };
  const [rows, counts, name] = await Promise.all([findChemicalUsage(db, filter), countChemicalUsage(db, filter), sampleChemicalName(db, casNorm)]);
  if (!rows.length) {
    return {
      found: false,
      reason: 'no_match',
      cas_number: args.cas_number,
      state: state ?? null,
      message: `No disclosed use of CAS ${JSON.stringify(args.cas_number)} found${state ? ` in ${state}` : ''} within this pack's ingredients coverage window (loaded since ${meta.ingredients_since}).`,
      ingredients_since: meta.ingredients_since,
      data_as_of: meta.loaded_at,
    };
  }
  const truncated = rows.length + offset < counts.rows;
  return {
    found: true,
    cas_number: args.cas_number,
    ingredient_name: name?.ingredient_name ?? null,
    ingredient_common_name: name?.ingredient_common_name ?? null,
    state: state ?? null,
    total_ingredient_rows: counts.rows,
    distinct_wells: counts.wells,
    distinct_states: counts.states,
    returned: rows.length,
    truncated,
    ...(truncated ? { hint: 'More usage rows exist than were returned. Narrow with state, or page with limit/offset.' } : {}),
    usage: rows.map((r) => ({
      disclosure_id: r.disclosure_id,
      job_start_date: r.job_start_date,
      api_number: r.api_number,
      state: r.state,
      county: r.county,
      operator: r.operator,
      well_name: r.well_name,
      trade_name: r.trade_name,
      supplier: r.supplier,
      purpose: r.purpose,
      percent_hf_job: r.percent_hf_job,
      mass_lbs: r.mass_lbs,
    })),
    source: SOURCE.source_dataset,
    source_url: SOURCE.source_url,
    license: SOURCE.license,
    ingredients_since: meta.ingredients_since,
    data_as_of: meta.loaded_at,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const bound = requireDb(args._d1);
  switch (name) {
    case 'frac_wells':
      return fracWellsTool(bound, args);
    case 'frac_chemicals':
      return fracChemicalsTool(bound, args);
    case 'chemical_usage':
      return chemicalUsageTool(bound, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
