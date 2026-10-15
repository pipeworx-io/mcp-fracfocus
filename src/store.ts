/**
 * Reads for fracfocus (fleet #2982).
 *
 * Data: FracFocus (fracfocus.org) -- the national hydraulic-fracturing
 * chemical disclosure registry operated jointly by the Ground Water
 * Protection Council and the Interstate Oil and Gas Compact Commission.
 * FracFocus publishes only a bulk CSV download, no per-request API, so
 * this pack builds a copy into a D1 database the gateway hands this pack
 * as `_d1` (pack-manifest "d1Binding": "FRACFOCUS_DB") by
 * scripts/fracfocus/load-data.mjs -- never by a deploy.
 *
 * Two tables:
 *   - ff_disclosures: one row per hydraulic-fracturing job disclosure
 *     (well header: operator, API number, location, dates). Loaded for
 *     EVERY disclosure FracFocus has ever published (full history).
 *   - ff_ingredients: one row per chemical ingredient used on a job,
 *     linked to ff_disclosures by disclosure_id. Loaded only for
 *     disclosures on or after a cutoff date (see load-data.mjs
 *     "SCOPE OF THIS FIRST LOAD") -- ingredient-level detail is ~20x the
 *     row volume of the well headers, so the first load scopes it to
 *     recent years and documents how to extend further back, same shape
 *     as mcps/bts-ontime's "most recent N months" first load.
 *
 * Every response carries `source`, `source_url`, `license` and
 * `data_as_of` plus the ingredients coverage window, so a caller can tell
 * "this well has no disclosed chemicals" apart from "this well's job
 * predates what we've loaded".
 */

/** The slice of Cloudflare's D1Database this pack uses, declared here so the
 *  pack needs no workers-types and a test can pass a node:sqlite stub. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'fracfocus: the FracFocus store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCE = {
  source_dataset:
    'FracFocus (Ground Water Protection Council / Interstate Oil and Gas Compact Commission), national hydraulic fracturing chemical disclosure registry',
  source_url: 'https://fracfocus.org/data-download',
  license:
    'FracFocus terms of use: "Downloaded data may be aggregated or combined with other datasets, but the FracFocus data may not be altered in any way." No warranty; data reflects operator self-submission as-is.',
};

export interface Meta {
  loaded_at: string | null;
  disclosures_through: string | null;
  ingredients_since: string | null;
}
export async function getMeta(db: D1Like): Promise<Meta> {
  const r = await db.prepare(`SELECT key, value FROM ff_meta`).all<{ key: string; value: string }>();
  const m = new Map(r.results.map((row) => [row.key, row.value]));
  return {
    loaded_at: m.get('loaded_at') ?? null,
    disclosures_through: m.get('disclosures_through') ?? null,
    ingredients_since: m.get('ingredients_since') ?? null,
  };
}

/** Strip anything that isn't a digit -- lets a caller pass an API number
 *  with or without dashes/spaces ("42-317-37262-00-00" or "4231737262"). */
export function normalizeApiNumber(input: unknown): string | null {
  if (input == null) return null;
  const digits = String(input).replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

/** Strip anything that isn't a digit -- lets a caller pass a CAS number
 *  with or without dashes ("7732-18-5" or "7732185"). */
export function normalizeCas(input: unknown): string | null {
  if (input == null) return null;
  const digits = String(input).replace(/\D/g, '');
  return digits.length >= 4 ? digits : null;
}

export interface DisclosureRow {
  disclosure_id: string;
  job_start_date: string | null;
  job_end_date: string | null;
  api_number: string;
  state: string;
  county: string | null;
  operator: string | null;
  well_name: string | null;
  latitude: number | null;
  longitude: number | null;
  total_base_water_volume: number | null;
  total_base_non_water_volume: number | null;
  federal_well: number;
  indian_well: number;
}

export interface WellsFilter {
  state?: string;
  county?: string;
  operator?: string;
  limit: number;
  offset: number;
}

export async function findWells(db: D1Like, f: WellsFilter): Promise<DisclosureRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.state) {
    where.push('state = ? COLLATE NOCASE');
    params.push(f.state);
  }
  if (f.county) {
    where.push('county = ? COLLATE NOCASE');
    params.push(f.county);
  }
  if (f.operator) {
    where.push('operator LIKE ? COLLATE NOCASE');
    params.push(`%${f.operator}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT disclosure_id, job_start_date, job_end_date, api_number, state, county, operator, well_name, latitude, longitude, total_base_water_volume, total_base_non_water_volume, federal_well, indian_well
    FROM ff_disclosures ${whereSql}
    ORDER BY job_start_date DESC
    LIMIT ? OFFSET ?`;
  params.push(f.limit, f.offset);
  const r = await db.prepare(sql).bind(...params).all<DisclosureRow>();
  return r.results;
}

export async function countWells(db: D1Like, f: Omit<WellsFilter, 'limit' | 'offset'>): Promise<number> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.state) {
    where.push('state = ? COLLATE NOCASE');
    params.push(f.state);
  }
  if (f.county) {
    where.push('county = ? COLLATE NOCASE');
    params.push(f.county);
  }
  if (f.operator) {
    where.push('operator LIKE ? COLLATE NOCASE');
    params.push(`%${f.operator}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ff_disclosures ${whereSql}`).bind(...params).first<{ n: number }>();
  return r?.n ?? 0;
}

/** All disclosures (there can be more than one job on the same well over
 *  time) matching a given API number, newest first. */
export async function findDisclosuresByApi(db: D1Like, apiNorm: string): Promise<DisclosureRow[]> {
  const r = await db
    .prepare(
      `SELECT disclosure_id, job_start_date, job_end_date, api_number, state, county, operator, well_name, latitude, longitude, total_base_water_volume, total_base_non_water_volume, federal_well, indian_well
       FROM ff_disclosures WHERE api_number_norm = ? ORDER BY job_start_date DESC`,
    )
    .bind(apiNorm)
    .all<DisclosureRow>();
  return r.results;
}

export interface IngredientRow {
  disclosure_id: string;
  trade_name: string | null;
  supplier: string | null;
  purpose: string | null;
  cas_number: string | null;
  ingredient_name: string | null;
  ingredient_common_name: string | null;
  percent_hf_job: number | null;
  mass_lbs: number | null;
  msds: number;
  claimant_company: string | null;
}

const INGREDIENT_COLUMNS =
  'disclosure_id, trade_name, supplier, purpose, cas_number, ingredient_name, ingredient_common_name, percent_hf_job, mass_lbs, msds, claimant_company';

export async function findIngredientsByDisclosureIds(db: D1Like, disclosureIds: string[], limit: number, offset: number): Promise<IngredientRow[]> {
  if (!disclosureIds.length) return [];
  const placeholders = disclosureIds.map(() => '?').join(',');
  const r = await db
    .prepare(
      `SELECT ${INGREDIENT_COLUMNS} FROM ff_ingredients WHERE disclosure_id IN (${placeholders}) ORDER BY disclosure_id, trade_name, cas_number LIMIT ? OFFSET ?`,
    )
    .bind(...disclosureIds, limit, offset)
    .all<IngredientRow>();
  return r.results;
}

export async function countIngredientsByDisclosureIds(db: D1Like, disclosureIds: string[]): Promise<number> {
  if (!disclosureIds.length) return 0;
  const placeholders = disclosureIds.map(() => '?').join(',');
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM ff_ingredients WHERE disclosure_id IN (${placeholders})`)
    .bind(...disclosureIds)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface UsageRow {
  disclosure_id: string;
  job_start_date: string | null;
  api_number: string;
  state: string;
  county: string | null;
  operator: string | null;
  well_name: string | null;
  trade_name: string | null;
  supplier: string | null;
  purpose: string | null;
  cas_number: string | null;
  ingredient_name: string | null;
  percent_hf_job: number | null;
  mass_lbs: number | null;
}

export interface UsageFilter {
  cas_norm: string;
  state?: string;
  limit: number;
  offset: number;
}

const USAGE_SELECT = `SELECT d.disclosure_id AS disclosure_id, d.job_start_date AS job_start_date, d.api_number AS api_number,
       d.state AS state, d.county AS county, d.operator AS operator, d.well_name AS well_name,
       i.trade_name AS trade_name, i.supplier AS supplier, i.purpose AS purpose, i.cas_number AS cas_number,
       i.ingredient_name AS ingredient_name, i.percent_hf_job AS percent_hf_job, i.mass_lbs AS mass_lbs
     FROM ff_ingredients i JOIN ff_disclosures d ON d.disclosure_id = i.disclosure_id`;

export async function findChemicalUsage(db: D1Like, f: UsageFilter): Promise<UsageRow[]> {
  const where: string[] = ['i.cas_number_norm = ?'];
  const params: unknown[] = [f.cas_norm];
  if (f.state) {
    where.push('d.state = ? COLLATE NOCASE');
    params.push(f.state);
  }
  const sql = `${USAGE_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.job_start_date DESC LIMIT ? OFFSET ?`;
  params.push(f.limit, f.offset);
  const r = await db.prepare(sql).bind(...params).all<UsageRow>();
  return r.results;
}

export async function countChemicalUsage(db: D1Like, f: Omit<UsageFilter, 'limit' | 'offset'>): Promise<{ rows: number; wells: number; states: number }> {
  const where: string[] = ['i.cas_number_norm = ?'];
  const params: unknown[] = [f.cas_norm];
  if (f.state) {
    where.push('d.state = ? COLLATE NOCASE');
    params.push(f.state);
  }
  const whereSql = where.join(' AND ');
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS rows, COUNT(DISTINCT d.disclosure_id) AS wells, COUNT(DISTINCT d.state) AS states
       FROM ff_ingredients i JOIN ff_disclosures d ON d.disclosure_id = i.disclosure_id WHERE ${whereSql}`,
    )
    .bind(...params)
    .first<{ rows: number; wells: number; states: number }>();
  return { rows: r?.rows ?? 0, wells: r?.wells ?? 0, states: r?.states ?? 0 };
}

/** One representative ingredient_name / ingredient_common_name for a CAS
 *  number, so chemical_usage can echo back "what is this chemical" even
 *  though the name string is operator-submitted free text that varies row
 *  to row. */
export async function sampleChemicalName(db: D1Like, casNorm: string): Promise<{ ingredient_name: string | null; ingredient_common_name: string | null } | null> {
  return db
    .prepare(
      `SELECT ingredient_name, ingredient_common_name FROM ff_ingredients WHERE cas_number_norm = ? AND (ingredient_name IS NOT NULL OR ingredient_common_name IS NOT NULL) LIMIT 1`,
    )
    .bind(casNorm)
    .first<{ ingredient_name: string | null; ingredient_common_name: string | null }>();
}
