/**
 * Privilege-mirror generation engine (DOps-2026-10-17 plan §4).
 *
 * The three hand-maintained privilege mirrors
 * (`src/saas/db/runtime-privileges.ts`, `deploy/managed-saas-postgres-roles.sql`,
 * `src/saas/db/credential-validation-worker-privileges.ts` +
 * `deploy/managed-saas-validation-worker-role-grants.sql`) are regenerated from
 * the single declarative source of truth in `./privileges-manifest.js`.
 *
 * Only the data-bearing constant arrays / grant-manifest VALUES sections are
 * generated; every surrounding guard, loop skeleton and probe body stays
 * hand-written. Section replacement is anchored on exact, unique strings, and
 * the generated text is byte-identical to the pre-generator mirrors, so the
 * regenerability test doubles as the no-drift fence: hand-editing a generated
 * section without updating the manifest fails CI.
 *
 * The manifest stores one ordered view per mirror (the mirrors order the same
 * facts differently and attach different provenance comments), plus the
 * minimal layout hints needed to reproduce the existing hand layout
 * byte-for-byte. `extractPrivilegeManifest()` reverses the mirrors into the
 * same view shapes; it built the committed manifest once (reverse extraction)
 * and remains available for auditing that correspondence.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MANIFEST_CONTROL_PLANE_COLUMN_GROUPS,
  MANIFEST_CONTROL_PLANE_COLUMN_SQL_ROWS,
  MANIFEST_CONTROL_PLANE_TABLE_GRANTS,
  MANIFEST_CONTROL_PLANE_TABLE_SQL_ROWS,
  MANIFEST_GATEWAY_COLUMN_GROUPS,
  MANIFEST_GATEWAY_COLUMN_SQL_ENTRIES,
  MANIFEST_GATEWAY_READ_SQL_ROWS,
  MANIFEST_GATEWAY_READ_TABLES,
  MANIFEST_WORKER_GRANT_STATEMENTS,
  MANIFEST_WORKER_PROBE_GRANTS,
  type SaasColumnPrivilege,
  type SaasControlPlaneColumnGroup,
  type SaasControlPlaneColumnSqlRow,
  type SaasControlPlaneTableGrant,
  type SaasControlPlaneTableSqlRow,
  type SaasGatewayColumnSqlEntry,
  type SaasGatewayColumnTsGroup,
  type SaasGatewayReadSqlRow,
  type SaasGatewayReadTableTsEntry,
  type SaasWorkerGrantStatement,
  type SaasWorkerProbeGrant,
} from './privileges-manifest.js';

export const RUNTIME_PRIVILEGES_PATH = 'src/saas/db/runtime-privileges.ts';
export const ROLES_TEMPLATE_PATH = 'deploy/managed-saas-postgres-roles.sql';
export const WORKER_PRIVILEGES_PATH = 'src/saas/db/credential-validation-worker-privileges.ts';
export const WORKER_ROLE_GRANTS_PATH = 'deploy/managed-saas-validation-worker-role-grants.sql';

export const MIRROR_PATHS = [
  RUNTIME_PRIVILEGES_PATH,
  ROLES_TEMPLATE_PATH,
  WORKER_PRIVILEGES_PATH,
  WORKER_ROLE_GRANTS_PATH,
] as const;

export function readMirror(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE']);

function isPrivilege(value: string): value is SaasColumnPrivilege {
  return PRIVILEGES.has(value);
}

function splitLines(source: string): string[] {
  if (source.includes('\r')) {
    throw new Error('mirror files must use LF line endings');
  }
  return source.split('\n');
}

/** Serializes a string as a single-quoted TS literal (biome quote style). */
function tsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Replaces the text between two exact, unique anchors (anchors stay in place). */
function replaceBetween(source: string, startAnchor: string, endAnchor: string, body: string): string {
  const singleOccurrence = (needle: string): number => {
    const first = source.indexOf(needle);
    if (first < 0) throw new Error(`anchor not found: ${JSON.stringify(needle.slice(0, 60))}`);
    if (source.indexOf(needle, first + 1) >= 0) {
      throw new Error(`anchor is not unique: ${JSON.stringify(needle.slice(0, 60))}`);
    }
    return first;
  };
  const start = singleOccurrence(startAnchor) + startAnchor.length;
  const end = source.indexOf(endAnchor, start);
  if (end < 0) throw new Error(`end anchor not found after start: ${JSON.stringify(endAnchor.slice(0, 60))}`);
  return source.slice(0, start) + body + source.slice(end);
}

function extractBetween(source: string, startAnchor: string, endAnchor: string): string {
  const first = source.indexOf(startAnchor);
  if (first < 0) throw new Error(`anchor not found: ${JSON.stringify(startAnchor.slice(0, 60))}`);
  const start = first + startAnchor.length;
  const end = source.indexOf(endAnchor, start);
  if (end < 0) throw new Error(`end anchor not found: ${JSON.stringify(endAnchor.slice(0, 60))}`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// runtime-privileges.ts anchors
// ---------------------------------------------------------------------------

const CP_COLUMN_GRANTS_START =
  'export const SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS: readonly SaasControlPlaneColumnGrant[] = [\n';
const CP_COLUMN_GRANTS_END = '\n] as const;';
const CP_TABLE_GRANTS_START =
  'export const SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS: readonly SaasControlPlaneTableGrant[] = [\n';
const CP_TABLE_GRANTS_END = '\n];';
const GATEWAY_READ_TABLES_START = 'export const SAAS_GATEWAY_RUNTIME_READ_TABLES = [\n';
const GATEWAY_READ_TABLES_END = '\n] as const;';
const GATEWAY_COLUMN_GRANTS_START =
  'export const SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS: readonly SaasGatewayColumnGrant[] = [\n';
const GATEWAY_COLUMN_GRANTS_END = '\n] as const;';

// ---------------------------------------------------------------------------
// managed-saas-postgres-roles.sql anchors
// ---------------------------------------------------------------------------

const ROLES_CP_COLUMN_VALUES_START =
  '    SELECT manifest.table_name, manifest.privilege_type,\n' +
  "           pg_catalog.string_to_array(manifest.column_names, ' ') AS column_names\n" +
  '    FROM (VALUES\n';
const ROLES_CP_COLUMN_VALUES_END = '\n    ) AS manifest(table_name, privilege_type, column_names)';
const ROLES_CP_TABLE_VALUES_START = '    SELECT manifest.table_name, manifest.privilege_type\n    FROM (VALUES\n';
const ROLES_CP_TABLE_VALUES_END = '\n    ) AS manifest(table_name, privilege_type)';
const ROLES_GATEWAY_READ_VALUES_START = '    SELECT read_relation.table_name\n    FROM (VALUES\n';
const ROLES_GATEWAY_READ_VALUES_END = '\n    ) AS read_relation(table_name)';
const ROLES_GATEWAY_COLUMN_VALUES_START =
  '    SELECT manifest.table_name, manifest.privilege_type,\n' +
  '           pg_catalog.array_agg(manifest.column_name ORDER BY manifest.column_name) AS column_names\n' +
  '    FROM (VALUES\n';
const ROLES_GATEWAY_COLUMN_VALUES_END = '\n    ) AS manifest(table_name, column_name, privilege_type)';

// ---------------------------------------------------------------------------
// credential-validation-worker-privileges.ts anchors
// ---------------------------------------------------------------------------

const WORKER_PROBE_VALUES_START =
  'expected_column_privileges(table_name, column_name, privilege_type) AS (\n  VALUES\n';
const WORKER_PROBE_VALUES_END = '\n)\nSELECT';

// ---------------------------------------------------------------------------
// managed-saas-validation-worker-role-grants.sql anchors
// ---------------------------------------------------------------------------

const WORKER_GRANTS_START =
  'GRANT EXECUTE ON FUNCTION model_router_saas.saas_catalog_valid_scope(text[])\n' +
  '  TO model_router_saas_validation_worker;\n\n';
const WORKER_GRANTS_END = '\n\nCOMMIT;';

// ===========================================================================
// Extraction (mirror files → manifest views)
// ===========================================================================

export interface ExtractedPrivilegeManifest {
  readonly controlPlaneColumnGroups: readonly SaasControlPlaneColumnGroup[];
  readonly controlPlaneColumnSqlRows: readonly SaasControlPlaneColumnSqlRow[];
  readonly controlPlaneTableGrants: readonly SaasControlPlaneTableGrant[];
  readonly controlPlaneTableSqlRows: readonly SaasControlPlaneTableSqlRow[];
  readonly gatewayReadTables: readonly SaasGatewayReadTableTsEntry[];
  readonly gatewayReadSqlRows: readonly SaasGatewayReadSqlRow[];
  readonly gatewayColumnGroups: readonly SaasGatewayColumnTsGroup[];
  readonly gatewayColumnSqlEntries: readonly SaasGatewayColumnSqlEntry[];
  readonly gatewayAuxiliary: {
    readonly fullInsertTables: readonly string[];
    readonly deleteTables: readonly string[];
    readonly usageSequence: string;
  };
  readonly workerProbeGrants: readonly SaasWorkerProbeGrant[];
  readonly workerGrantStatements: readonly SaasWorkerGrantStatement[];
}

function extractCommercialPriceVersionColumns(source: string): readonly string[] {
  const match = source.match(/const COMMERCIAL_PRICE_VERSION_COLUMNS = \[\n([\s\S]*?)\] as const;/);
  if (!match) throw new Error('COMMERCIAL_PRICE_VERSION_COLUMNS not found');
  return match[1]
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
    .map((line) => {
      const column = line.match(/^\s*'([^']+)',?\s*$/);
      if (!column) throw new Error(`unexpected COMMERCIAL_PRICE_VERSION_COLUMNS line: ${tsString(line)}`);
      return column[1];
    });
}

function extractControlPlaneColumnGroups(source: string): readonly SaasControlPlaneColumnGroup[] {
  const commercial = extractCommercialPriceVersionColumns(source);
  const body = extractBetween(source, CP_COLUMN_GRANTS_START, CP_COLUMN_GRANTS_END);
  const lines = splitLines(body);
  const groups: SaasControlPlaneColumnGroup[] = [];
  let comment: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === '') {
      if (index !== lines.length - 1) throw new Error(`unexpected blank line in CP column grants: ${index}`);
      index++;
      continue;
    }
    const commentMatch = line.match(/^ {2}\/\/ ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      index++;
      continue;
    }
    const header = line.match(/^ {2}\.\.\.columnGrants\('([^']+)', '([^']+)', (.*)$/);
    if (!header) throw new Error(`unrecognized CP column grant line: ${tsString(line)}`);
    const table = header[1];
    const privilege = header[2];
    if (!isPrivilege(privilege)) throw new Error(`bad privilege: ${privilege}`);
    const rest = header[3];
    const base = { ...(comment.length ? { tsComment: comment } : {}), table, privilege } as const;
    comment = [];
    if (rest === 'COMMERCIAL_PRICE_VERSION_COLUMNS),') {
      groups.push({ ...base, columns: [...commercial], tsRender: 'commercial-ref' });
      index++;
      continue;
    }
    const singleLine = rest.match(/^\[(.*)\]\),$|^\[(.*)\]$/);
    if (singleLine) {
      const inner = singleLine[1] ?? singleLine[2] ?? '';
      const columns = inner.split(', ').map((entry) => {
        const column = entry.match(/^'([^']+)'(?:,)?$/);
        if (!column) throw new Error(`bad single-line CP columns: ${tsString(line)}`);
        return column[1];
      });
      groups.push({ ...base, columns });
      index++;
      continue;
    }
    if (rest !== '[') throw new Error(`unrecognized CP column grant body: ${tsString(line)}`);
    // Multi-line array literal (or the commercial splice form).
    const columns: string[] = [];
    const columnComments: { before: number; lines: string[] }[] = [];
    let render: SaasControlPlaneColumnGroup['tsRender'];
    index++;
    while (lines[index] !== '  ]),') {
      const arrayComment = lines[index].match(/^ {4}\/\/ ?(.*)$/);
      if (arrayComment) {
        if (columnComments.at(-1)?.before === columns.length) {
          columnComments.at(-1)?.lines.push(arrayComment[1]);
        } else {
          columnComments.push({ before: columns.length, lines: [arrayComment[1]] });
        }
        index++;
        continue;
      }
      const entry = lines[index].match(/^ {4}(.+?),?$/);
      if (!entry) throw new Error(`unrecognized CP column array line: ${JSON.stringify(lines[index])}`);
      const text = entry[1];
      const slice = text.match(/^\.\.\.COMMERCIAL_PRICE_VERSION_COLUMNS\.slice\((\d+)(?:, (\d+))?\)$/);
      const literal = text.match(/^'([^']+)'$/);
      if (slice) {
        const from = Number(slice[1]);
        const to = slice[2] === undefined ? undefined : Number(slice[2]);
        if (render === undefined && from === 0) render = 'commercial-splice';
        else if (render !== 'commercial-splice') {
          throw new Error(`unexpected commercial slice placement: ${JSON.stringify(lines[index])}`);
        }
        columns.push(...commercial.slice(from, to));
      } else if (literal) {
        columns.push(literal[1]);
      } else {
        throw new Error(`unrecognized CP column array entry: ${JSON.stringify(lines[index])}`);
      }
      index++;
      if (index >= lines.length) throw new Error('unterminated CP column array');
    }
    index++;
    groups.push({
      ...base,
      columns,
      ...(render ? { tsRender: render } : {}),
      ...(columnComments.length ? { tsColumnComments: columnComments } : {}),
    });
  }
  return groups;
}

function extractControlPlaneTableGrants(source: string): readonly SaasControlPlaneTableGrant[] {
  const body = extractBetween(source, CP_TABLE_GRANTS_START, CP_TABLE_GRANTS_END);
  const lines = splitLines(body);
  const grants: SaasControlPlaneTableGrant[] = [];
  let comment: string[] = [];
  for (const line of lines) {
    if (line === '') continue;
    const commentMatch = line.match(/^ {2}\/\/ ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }
    const tuple = line.match(/^ {2}\['([^']+)', 'DELETE'\],$/);
    if (!tuple) throw new Error(`unrecognized CP table grant line: ${tsString(line)}`);
    grants.push({ ...(comment.length ? { tsComment: comment } : {}), table: tuple[1] });
    comment = [];
  }
  return grants;
}

function extractGatewayReadTables(source: string): readonly SaasGatewayReadTableTsEntry[] {
  const body = extractBetween(source, GATEWAY_READ_TABLES_START, GATEWAY_READ_TABLES_END);
  const lines = splitLines(body);
  const tables: SaasGatewayReadTableTsEntry[] = [];
  let comment: string[] = [];
  for (const line of lines) {
    if (line === '') continue;
    const commentMatch = line.match(/^ {2}\/\/ ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }
    const tuple = line.match(/^ {2}'([^']+)',?$/);
    if (!tuple) throw new Error(`unrecognized gateway read table line: ${tsString(line)}`);
    tables.push({ ...(comment.length ? { tsComment: comment } : {}), table: tuple[1] });
    comment = [];
  }
  return tables;
}

interface GatewayEntry {
  readonly comment: readonly string[];
  readonly text: string;
}

/** Splits the gateway column grant array into comment blocks and entry text spans. */
function splitGatewayEntries(source: string): readonly GatewayEntry[] {
  const body = extractBetween(source, GATEWAY_COLUMN_GRANTS_START, GATEWAY_COLUMN_GRANTS_END);
  const lines = splitLines(body);
  const entries: GatewayEntry[] = [];
  let comment: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === '') {
      if (index !== lines.length - 1) throw new Error(`unexpected blank line in gateway column grants: ${index}`);
      index++;
      continue;
    }
    const commentMatch = line.match(/^ {2}\/\/ ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      index++;
      continue;
    }
    // An entry runs until its parentheses balance back to zero.
    let depth = 0;
    const entryLines: string[] = [];
    do {
      depth += (lines[index].match(/\(/g) ?? []).length - (lines[index].match(/\)/g) ?? []).length;
      entryLines.push(lines[index]);
      index++;
      if (index > lines.length) throw new Error(`unterminated gateway entry: ${JSON.stringify(entryLines[0])}`);
    } while (depth > 0);
    if (depth !== 0) throw new Error(`unbalanced gateway entry: ${JSON.stringify(entryLines[0])}`);
    entries.push({ comment, text: entryLines.join('\n') });
    comment = [];
  }
  return entries;
}

const COLUMN_LIST = "'[a-z0-9_]+'(?:, '[a-z0-9_]+')*";

function parseColumnList(text: string): string[] {
  return [...text.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
}

function classifyGatewayEntry(text: string): SaasGatewayColumnTsGroup {
  const inline = text.match(/^ {2}\['([a-z0-9_]+)', '([a-z0-9_]+)', '(SELECT|INSERT|UPDATE)'\],$/);
  if (inline) {
    return {
      table: inline[1],
      privilege: inline[3] as SaasColumnPrivilege,
      columns: [inline[2]],
      tsStyle: 'inline',
    };
  }
  const mapTarget = text.match(/\['([a-z0-9_]+)', column, '(SELECT|INSERT|UPDATE)'\] as const/);
  if (!mapTarget) throw new Error(`unrecognized gateway column grant entry form:\n${text}`);
  const table = mapTarget[1];
  const privilege = mapTarget[2] as SaasColumnPrivilege;
  if (text.startsWith('  ...(\n')) {
    const afterParen = text.slice('  ...(\n'.length);
    if (afterParen.startsWith('    [\n')) {
      const columns = parseColumnList(afterParen.slice('    [\n'.length, afterParen.indexOf('    ] as const')));
      return { table, privilege, columns, tsStyle: 'map-paren-multi' };
    }
    const single = afterParen.match(new RegExp(`^ {4}\\[(${COLUMN_LIST})\\] as const\\n`));
    if (single) {
      return { table, privilege, columns: parseColumnList(single[1]), tsStyle: 'map-paren-single' };
    }
    throw new Error(`unrecognized gateway paren entry form:\n${text}`);
  }
  const flatOrCallback = text.match(new RegExp(`^ {2}\\.\\.\\.\\(\\[(${COLUMN_LIST})\\] as const\\)\\.map\\(`));
  if (!flatOrCallback) throw new Error(`unrecognized gateway column grant entry form:\n${text}`);
  const columns = parseColumnList(flatOrCallback[1]);
  return {
    table,
    privilege,
    columns,
    tsStyle: text.endsWith('),') && text.includes('\n') ? 'map-callback' : 'map-flat',
  };
}

/** SaasGatewayColumnTsGroup with writable fields, for run accumulation during extraction. */
type MutableGatewayColumnGroup = { -readonly [K in keyof SaasGatewayColumnTsGroup]: SaasGatewayColumnTsGroup[K] };

function extractGatewayColumnGroups(source: string): readonly SaasGatewayColumnTsGroup[] {
  const entries = splitGatewayEntries(source);
  const groups: MutableGatewayColumnGroup[] = [];
  for (const entry of entries) {
    const group = classifyGatewayEntry(entry.text);
    const previous = groups[groups.length - 1];
    if (
      previous !== undefined &&
      previous.tsStyle === 'inline' &&
      group.tsStyle === 'inline' &&
      previous.table === group.table &&
      previous.privilege === group.privilege &&
      entry.comment.length === 0
    ) {
      previous.columns = [...previous.columns, ...group.columns];
      continue;
    }
    groups.push({
      ...(entry.comment.length ? { tsComment: entry.comment } : {}),
      ...group,
    });
  }
  return groups;
}

function extractRolesControlPlaneColumnRows(source: string): readonly SaasControlPlaneColumnSqlRow[] {
  const body = extractBetween(source, ROLES_CP_COLUMN_VALUES_START, ROLES_CP_COLUMN_VALUES_END);
  const lines = splitLines(body);
  const rows: SaasControlPlaneColumnSqlRow[] = [];
  let comment: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '') {
      if (index !== lines.length - 1) throw new Error(`unexpected blank line in CP column VALUES: ${index}`);
      continue;
    }
    const commentMatch = line.match(/^ {6}-- ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }
    const isLast = index === lines.length - 1;
    const tuple = line.match(
      new RegExp(`^ {6}\\('([^']+)', '(SELECT|INSERT|UPDATE)', '([^']+)'\\)${isLast ? '' : ','}$`),
    );
    if (!tuple) throw new Error(`unrecognized CP column VALUES line: ${tsString(line)}`);
    if (!isPrivilege(tuple[2])) throw new Error(`bad privilege: ${tuple[2]}`);
    rows.push({
      ...(comment.length ? { sqlComment: comment } : {}),
      table: tuple[1],
      privilege: tuple[2],
      columns: tuple[3].split(' '),
    });
    comment = [];
  }
  return rows;
}

function extractRolesControlPlaneTableRows(source: string): readonly SaasControlPlaneTableSqlRow[] {
  const body = extractBetween(source, ROLES_CP_TABLE_VALUES_START, ROLES_CP_TABLE_VALUES_END);
  const lines = splitLines(body);
  const rows: SaasControlPlaneTableSqlRow[] = [];
  let comment: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '') {
      if (index !== lines.length - 1) throw new Error(`unexpected blank line in CP table VALUES: ${index}`);
      continue;
    }
    const commentMatch = line.match(/^ {6}-- ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }
    const isLast = index === lines.length - 1;
    const tuple = line.match(new RegExp(`^ {6}\\('([^']+)', 'DELETE'\\)${isLast ? '' : ','}$`));
    if (!tuple) throw new Error(`unrecognized CP table VALUES line: ${tsString(line)}`);
    rows.push({ ...(comment.length ? { sqlComment: comment } : {}), table: tuple[1] });
    comment = [];
  }
  return rows;
}

function extractRolesGatewayReadRows(source: string): readonly SaasGatewayReadSqlRow[] {
  const body = extractBetween(source, ROLES_GATEWAY_READ_VALUES_START, ROLES_GATEWAY_READ_VALUES_END);
  const lines = splitLines(body);
  const rows: SaasGatewayReadSqlRow[] = [];
  let comment: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '') {
      if (index !== lines.length - 1) throw new Error(`unexpected blank line in gateway read VALUES: ${index}`);
      continue;
    }
    const commentMatch = line.match(/^ {6}-- ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }
    const isLast = index === lines.length - 1;
    const tupleLine = line.match(new RegExp(`^ {6}((?:\\('[^']+'\\)(?:, )?)+)${isLast ? '' : ',?'}$`));
    if (!tupleLine) throw new Error(`unrecognized gateway read VALUES line: ${tsString(line)}`);
    const tables = [...tupleLine[1].matchAll(/\('([^']+)'\)/g)].map((match) => match[1]);
    rows.push({ ...(comment.length ? { sqlComment: comment } : {}), tables });
    comment = [];
  }
  return rows;
}

function extractRolesGatewayColumnEntries(source: string): readonly SaasGatewayColumnSqlEntry[] {
  const body = extractBetween(source, ROLES_GATEWAY_COLUMN_VALUES_START, ROLES_GATEWAY_COLUMN_VALUES_END);
  const lines = splitLines(body);
  const entries: SaasGatewayColumnSqlEntry[] = [];
  let comment: string[] = [];
  let tupleCount = 0;
  let totalTuples = 0;
  for (const line of lines) {
    if (/^ {6}-- ?/.test(line) || line === '') continue;
    totalTuples += (line.match(/\('/g) ?? []).length;
  }
  for (const line of lines) {
    if (line === '') continue;
    const commentMatch = line.match(/^ {6}-- ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }
    const tuples = [...line.matchAll(/\('([^']+)', '([^']+)', '([^']+)'\)/g)];
    if (tuples.length === 0) throw new Error(`unrecognized gateway column VALUES line: ${tsString(line)}`);
    for (const [position, tuple] of tuples.entries()) {
      tupleCount++;
      // The overall last tuple has no trailing comma; every other line's last
      // tuple does, so a tuple that does not start its line joins the previous one.
      const isLastTuple = tupleCount === totalTuples;
      const startsLine = position === 0 || isLastTuple;
      if (startsLine && !line.includes(`('${tuple[1]}', '${tuple[2]}', '${tuple[3]}')`)) {
        throw new Error(`gateway column tuple mismatch: ${tsString(line)}`);
      }
      entries.push({
        ...(comment.length ? { sqlComment: comment } : {}),
        table: tuple[1],
        column: tuple[2],
        privilege: tuple[3] as SaasColumnPrivilege,
        ...(position > 0 ? { sqlJoinLine: true } : {}),
      });
      comment = [];
    }
  }
  return entries;
}

function extractGatewayAuxiliary(source: string): {
  readonly fullInsertTables: readonly string[];
  readonly deleteTables: readonly string[];
  readonly usageSequence: string;
} {
  const fullInsert = source.match(/const GATEWAY_FULL_INSERT_TABLES = \[([^\]]*)\] as const;/);
  if (!fullInsert) throw new Error('GATEWAY_FULL_INSERT_TABLES not found');
  const deleteTables = source.match(/export const GATEWAY_DELETE_TABLES = \[([^\]]*)\] as const;/);
  if (!deleteTables) throw new Error('GATEWAY_DELETE_TABLES not found');
  const sequence = source.match(/const GATEWAY_SEQUENCE = '([^']+)' as const;/);
  if (!sequence) throw new Error('GATEWAY_SEQUENCE not found');
  const parseList = (text: string): string[] => parseColumnList(text);
  return {
    fullInsertTables: parseList(fullInsert[1]),
    deleteTables: parseList(deleteTables[1]),
    usageSequence: sequence[1],
  };
}

function extractWorkerProbeGrants(source: string): readonly SaasWorkerProbeGrant[] {
  const body = extractBetween(source, WORKER_PROBE_VALUES_START, WORKER_PROBE_VALUES_END);
  const lines = splitLines(body);
  const grants: SaasWorkerProbeGrant[] = [];
  let comment: string[] = [];
  for (const line of lines) {
    if (line === '') continue;
    const commentMatch = line.match(/^ {4}-- ?(.*)$/);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }
    const tuple = line.match(/^ {4}\('([^']+)', '([^']+)', '(SELECT|INSERT|UPDATE)'\),?$/);
    if (!tuple) throw new Error(`unrecognized worker probe VALUES line: ${tsString(line)}`);
    grants.push({
      ...(comment.length ? { comment } : {}),
      table: tuple[1],
      column: tuple[2],
      privilege: tuple[3] as SaasColumnPrivilege,
    });
    comment = [];
  }
  return grants;
}

function extractWorkerGrantStatements(source: string): readonly SaasWorkerGrantStatement[] {
  const body = extractBetween(source, WORKER_GRANTS_START, WORKER_GRANTS_END);
  const lines = splitLines(body);
  const statements: SaasWorkerGrantStatement[] = [];
  let preamble: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === '') {
      if (index !== lines.length - 1) preamble.push('');
      index++;
      continue;
    }
    const commentMatch = line.match(/^-- ?(.*)$/);
    if (commentMatch) {
      preamble.push(commentMatch[1]);
      index++;
      continue;
    }
    const header = line.match(/^GRANT (SELECT|INSERT|UPDATE) \($/);
    if (header) {
      const columnLines: string[][] = [];
      index++;
      while (lines[index] !== undefined && !/^\)? ?ON TABLE model_router_saas\.[a-z0-9_]+$/.test(lines[index])) {
        const columns = lines[index].match(/^ {2}([a-z0-9_]+(?:, [a-z0-9_]+)*),?$/);
        if (!columns) throw new Error(`unrecognized worker grant column line: ${JSON.stringify(lines[index])}`);
        columnLines.push(columns[1].split(', '));
        index++;
        if (index >= lines.length) throw new Error('unterminated worker grant statement');
      }
      const table = lines[index].match(/^\)? ?ON TABLE model_router_saas\.([a-z0-9_]+)$/);
      if (!table) throw new Error(`unrecognized worker grant table line: ${JSON.stringify(lines[index])}`);
      index++;
      if (lines[index] !== '  TO model_router_saas_validation_worker;') {
        throw new Error(`unrecognized worker grant TO line: ${JSON.stringify(lines[index])}`);
      }
      index++;
      statements.push({
        ...(preamble.length ? { preamble } : {}),
        privilege: header[1] as SaasColumnPrivilege,
        table: table[1],
        columnLines,
      });
      preamble = [];
      continue;
    }
    const singleLine = line.match(/^GRANT (SELECT|INSERT|UPDATE) \(([a-z0-9_]+(?:, [a-z0-9_]+)*)\)$/);
    if (singleLine) {
      index++;
      const table = lines[index].match(/^ {2}ON TABLE model_router_saas\.([a-z0-9_]+)$/);
      if (!table) throw new Error(`unrecognized worker grant table line: ${JSON.stringify(lines[index])}`);
      index++;
      if (lines[index] !== '  TO model_router_saas_validation_worker;') {
        throw new Error(`unrecognized worker grant TO line: ${JSON.stringify(lines[index])}`);
      }
      index++;
      statements.push({
        ...(preamble.length ? { preamble } : {}),
        privilege: singleLine[1] as SaasColumnPrivilege,
        table: table[1],
        columnLines: [singleLine[2].split(', ')],
        singleLine: true,
      });
      preamble = [];
      continue;
    }
    throw new Error(`unrecognized worker grant line: ${tsString(line)}`);
  }
  return statements;
}

export function extractPrivilegeManifest(): ExtractedPrivilegeManifest {
  const runtime = readMirror(RUNTIME_PRIVILEGES_PATH);
  const roles = readMirror(ROLES_TEMPLATE_PATH);
  const worker = readMirror(WORKER_PRIVILEGES_PATH);
  const workerGrants = readMirror(WORKER_ROLE_GRANTS_PATH);
  return {
    controlPlaneColumnGroups: extractControlPlaneColumnGroups(runtime),
    controlPlaneColumnSqlRows: extractRolesControlPlaneColumnRows(roles),
    controlPlaneTableGrants: extractControlPlaneTableGrants(runtime),
    controlPlaneTableSqlRows: extractRolesControlPlaneTableRows(roles),
    gatewayReadTables: extractGatewayReadTables(runtime),
    gatewayReadSqlRows: extractRolesGatewayReadRows(roles),
    gatewayColumnGroups: extractGatewayColumnGroups(runtime),
    gatewayColumnSqlEntries: extractRolesGatewayColumnEntries(roles),
    gatewayAuxiliary: extractGatewayAuxiliary(runtime),
    workerProbeGrants: extractWorkerProbeGrants(worker),
    workerGrantStatements: extractWorkerGrantStatements(workerGrants),
  };
}

// ===========================================================================
// Rendering (manifest views → mirror sections)
// ===========================================================================

function quoteColumnList(columns: readonly string[]): string {
  return columns.map((column) => `'${column}'`).join(', ');
}

function renderTsComment(comment: readonly string[] | undefined, indent: string): string {
  if (!comment || comment.length === 0) return '';
  return `${comment.map((line) => (line === '' ? `${indent}//` : `${indent}// ${line}`)).join('\n')}\n`;
}

/** Biome renders the array literal inline iff the whole statement fits 120 columns. */
const TS_LINE_WIDTH = 120;

function renderControlPlaneColumnGroups(groups: readonly SaasControlPlaneColumnGroup[]): string {
  const chunks: string[] = [];
  for (const group of groups) {
    let entry: string;
    if (group.tsRender === 'commercial-ref') {
      entry = `  ...columnGrants('${group.table}', '${group.privilege}', COMMERCIAL_PRICE_VERSION_COLUMNS),`;
    } else if (group.tsRender === 'commercial-splice') {
      const insertAt = group.columns.indexOf('resolved_model');
      if (insertAt < 0) throw new Error('commercial-splice group is missing resolved_model');
      entry =
        `  ...columnGrants('${group.table}', '${group.privilege}', [\n` +
        `    ...COMMERCIAL_PRICE_VERSION_COLUMNS.slice(0, ${insertAt}),\n` +
        "    'resolved_model',\n" +
        `    ...COMMERCIAL_PRICE_VERSION_COLUMNS.slice(${insertAt}),\n` +
        '  ]),';
    } else {
      const inline = `  ...columnGrants('${group.table}', '${group.privilege}', [${quoteColumnList(group.columns)}]),`;
      if (inline.length <= TS_LINE_WIDTH) {
        if (group.tsColumnComments) {
          throw new Error(`single-line CP group cannot carry in-array comments: ${group.table}`);
        }
        entry = inline;
      } else {
        const body: string[] = [];
        for (const [position, column] of group.columns.entries()) {
          for (const comment of group.tsColumnComments ?? []) {
            if (comment.before === position) body.push(...comment.lines.map((line) => `    // ${line}`));
          }
          body.push(`    '${column}',`);
        }
        entry = `  ...columnGrants('${group.table}', '${group.privilege}', [\n${body.join('\n')}\n  ]),`;
      }
    }
    chunks.push(`${renderTsComment(group.tsComment, '  ')}${entry}`);
  }
  return chunks.join('\n');
}

function renderControlPlaneTableGrants(grants: readonly SaasControlPlaneTableGrant[]): string {
  return grants.map((grant) => `${renderTsComment(grant.tsComment, '  ')}  ['${grant.table}', 'DELETE'],`).join('\n');
}

function renderGatewayReadTables(tables: readonly SaasGatewayReadTableTsEntry[]): string {
  return tables.map((entry) => `${renderTsComment(entry.tsComment, '  ')}  '${entry.table}',`).join('\n');
}

function renderGatewayColumnGroup(group: SaasGatewayColumnTsGroup): string {
  const columns = quoteColumnList(group.columns);
  let entry: string;
  switch (group.tsStyle) {
    case 'inline':
      entry = group.columns.map((column) => `  ['${group.table}', '${column}', '${group.privilege}'],`).join('\n');
      break;
    case 'map-flat':
      entry = `  ...([${columns}] as const).map((column) => ['${group.table}', column, '${group.privilege}'] as const),`;
      break;
    case 'map-paren-single':
      entry = `  ...(\n    [${columns}] as const\n  ).map((column) => ['${group.table}', column, '${group.privilege}'] as const),`;
      break;
    case 'map-paren-multi':
      entry =
        `  ...(\n    [\n${group.columns.map((column) => `      '${column}',`).join('\n')}\n    ] as const\n` +
        `  ).map((column) => ['${group.table}', column, '${group.privilege}'] as const),`;
      break;
    case 'map-callback':
      entry =
        `  ...([${columns}] as const).map(\n` +
        `    (column) => ['${group.table}', column, '${group.privilege}'] as const,\n  ),`;
      break;
  }
  return renderTsComment(group.tsComment, '  ') + entry;
}

function renderGatewayColumnGroups(groups: readonly SaasGatewayColumnTsGroup[]): string {
  return groups.map(renderGatewayColumnGroup).join('\n');
}

function renderSqlComment(comment: readonly string[] | undefined, indent: string): string {
  if (!comment || comment.length === 0) return '';
  return `${comment.map((line) => (line === '' ? `${indent}--` : `${indent}-- ${line}`)).join('\n')}\n`;
}

function renderRolesControlPlaneColumnRows(rows: readonly SaasControlPlaneColumnSqlRow[]): string {
  return rows
    .map((row, index) => {
      const comma = index === rows.length - 1 ? '' : ',';
      return `${renderSqlComment(row.sqlComment, '      ')}      ('${row.table}', '${row.privilege}', '${row.columns.join(' ')}')${comma}`;
    })
    .join('\n');
}

function renderRolesControlPlaneTableRows(rows: readonly SaasControlPlaneTableSqlRow[]): string {
  return rows
    .map((row, index) => {
      const comma = index === rows.length - 1 ? '' : ',';
      return `${renderSqlComment(row.sqlComment, '      ')}      ('${row.table}', 'DELETE')${comma}`;
    })
    .join('\n');
}

function renderRolesGatewayReadRows(rows: readonly SaasGatewayReadSqlRow[]): string {
  return rows
    .map((row, index) => {
      const comma = index === rows.length - 1 ? '' : ',';
      return (
        renderSqlComment(row.sqlComment, '      ') +
        `      ${row.tables.map((table) => `('${table}')`).join(', ')}${comma}`
      );
    })
    .join('\n');
}

function renderRolesGatewayColumnEntries(entries: readonly SaasGatewayColumnSqlEntry[]): string {
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const tuple = `('${entry.table}', '${entry.column}', '${entry.privilege}')${isLast ? '' : ','}`;
    if (entry.sqlJoinLine === true) {
      const previous = lines.pop();
      if (previous === undefined || previous.includes('--')) {
        throw new Error(`gateway column VALUES tuple cannot join the previous line: ${entry.table}.${entry.column}`);
      }
      lines.push(`${previous} ${tuple}`);
      continue;
    }
    if (entry.sqlComment) lines.push(...entry.sqlComment.map((line) => `      -- ${line}`));
    lines.push(`      ${tuple}`);
  }
  return lines.join('\n');
}

function renderWorkerProbeGrants(grants: readonly SaasWorkerProbeGrant[]): string {
  return grants
    .map((grant, index) => {
      const comma = index === grants.length - 1 ? '' : ',';
      return (
        renderSqlComment(grant.comment, '    ') +
        `    ('${grant.table}', '${grant.column}', '${grant.privilege}')${comma}`
      );
    })
    .join('\n');
}

function renderWorkerGrantStatements(statements: readonly SaasWorkerGrantStatement[]): string {
  return statements
    .map((statement) => {
      const columns = statement.columnLines.map((line) => line.join(', '));
      const grant = statement.singleLine
        ? `GRANT ${statement.privilege} (${columns.join(', ')})\n  ON TABLE model_router_saas.${statement.table}`
        : `GRANT ${statement.privilege} (\n${columns
            .map((line, index) => `  ${line}${index === columns.length - 1 ? '' : ','}`)
            .join('\n')}\n) ON TABLE model_router_saas.${statement.table}`;
      const preamble = (statement.preamble ?? []).map((line) => (line === '' ? '' : `-- ${line}`)).join('\n');
      return (
        ((statement.preamble?.length ?? 0) > 0 ? `${preamble}\n` : '') +
        grant +
        '\n  TO model_router_saas_validation_worker;'
      );
    })
    .join('\n');
}

// ===========================================================================
// Whole-file regeneration
// ===========================================================================

export function regenerateRuntimePrivileges(source: string): string {
  let next = replaceBetween(
    source,
    CP_COLUMN_GRANTS_START,
    CP_COLUMN_GRANTS_END,
    renderControlPlaneColumnGroups(MANIFEST_CONTROL_PLANE_COLUMN_GROUPS),
  );
  next = replaceBetween(
    next,
    CP_TABLE_GRANTS_START,
    CP_TABLE_GRANTS_END,
    renderControlPlaneTableGrants(MANIFEST_CONTROL_PLANE_TABLE_GRANTS),
  );
  next = replaceBetween(
    next,
    GATEWAY_READ_TABLES_START,
    GATEWAY_READ_TABLES_END,
    renderGatewayReadTables(MANIFEST_GATEWAY_READ_TABLES),
  );
  return replaceBetween(
    next,
    GATEWAY_COLUMN_GRANTS_START,
    GATEWAY_COLUMN_GRANTS_END,
    renderGatewayColumnGroups(MANIFEST_GATEWAY_COLUMN_GROUPS),
  );
}

export function regenerateRolesTemplate(source: string): string {
  let next = replaceBetween(
    source,
    ROLES_CP_COLUMN_VALUES_START,
    ROLES_CP_COLUMN_VALUES_END,
    renderRolesControlPlaneColumnRows(MANIFEST_CONTROL_PLANE_COLUMN_SQL_ROWS),
  );
  next = replaceBetween(
    next,
    ROLES_CP_TABLE_VALUES_START,
    ROLES_CP_TABLE_VALUES_END,
    renderRolesControlPlaneTableRows(MANIFEST_CONTROL_PLANE_TABLE_SQL_ROWS),
  );
  next = replaceBetween(
    next,
    ROLES_GATEWAY_READ_VALUES_START,
    ROLES_GATEWAY_READ_VALUES_END,
    renderRolesGatewayReadRows(MANIFEST_GATEWAY_READ_SQL_ROWS),
  );
  return replaceBetween(
    next,
    ROLES_GATEWAY_COLUMN_VALUES_START,
    ROLES_GATEWAY_COLUMN_VALUES_END,
    renderRolesGatewayColumnEntries(MANIFEST_GATEWAY_COLUMN_SQL_ENTRIES),
  );
}

export function regenerateWorkerPrivileges(source: string): string {
  return replaceBetween(
    source,
    WORKER_PROBE_VALUES_START,
    WORKER_PROBE_VALUES_END,
    renderWorkerProbeGrants(MANIFEST_WORKER_PROBE_GRANTS),
  );
}

export function regenerateWorkerRoleGrants(source: string): string {
  return replaceBetween(
    source,
    WORKER_GRANTS_START,
    WORKER_GRANTS_END,
    renderWorkerGrantStatements(MANIFEST_WORKER_GRANT_STATEMENTS),
  );
}

export interface MirrorRegeneration {
  readonly path: string;
  readonly regenerate: (source: string) => string;
}

export const MIRROR_REGENERATIONS: readonly MirrorRegeneration[] = [
  { path: RUNTIME_PRIVILEGES_PATH, regenerate: regenerateRuntimePrivileges },
  { path: ROLES_TEMPLATE_PATH, regenerate: regenerateRolesTemplate },
  { path: WORKER_PRIVILEGES_PATH, regenerate: regenerateWorkerPrivileges },
  { path: WORKER_ROLE_GRANTS_PATH, regenerate: regenerateWorkerRoleGrants },
];

export function regenerateMirrorContents(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const mirror of MIRROR_REGENERATIONS) {
    output[mirror.path] = mirror.regenerate(readMirror(mirror.path));
  }
  return output;
}

// ===========================================================================
// Manifest serialization (used once for the reverse extraction)
// ===========================================================================

function serializeComment(name: string, comment: readonly string[] | undefined): string {
  if (!comment || comment.length === 0) return '';
  return `    ${name}: [\n${comment.map((line) => `      ${tsString(line)},`).join('\n')}\n    ],\n`;
}

function serializeControlPlaneColumnGroup(group: SaasControlPlaneColumnGroup): string {
  const columnComments = group.tsColumnComments
    ? `    tsColumnComments: [\n${group.tsColumnComments
        .map(
          (comment) =>
            `      { before: ${comment.before}, lines: [${comment.lines.map((line) => tsString(line)).join(', ')}] },`,
        )
        .join('\n')}\n    ],\n`
    : '';
  return (
    '  {\n' +
    serializeComment('tsComment', group.tsComment) +
    `    table: ${tsString(group.table)},\n` +
    `    privilege: '${group.privilege}',\n` +
    `    columns: [${group.columns.map((column) => `'${column}'`).join(', ')}],\n` +
    (group.tsRender ? `    tsRender: '${group.tsRender}',\n` : '') +
    columnComments +
    '  },'
  );
}

function serializeControlPlaneColumnSqlRow(row: SaasControlPlaneColumnSqlRow): string {
  return (
    '  {\n' +
    serializeComment('sqlComment', row.sqlComment) +
    `    table: ${tsString(row.table)},\n` +
    `    privilege: '${row.privilege}',\n` +
    `    columns: [${row.columns.map((column) => `'${column}'`).join(', ')}],\n` +
    '  },'
  );
}

function serializeControlPlaneTableGrant(grant: SaasControlPlaneTableGrant): string {
  return `  {\n${serializeComment('tsComment', grant.tsComment)}    table: ${tsString(grant.table)},\n  },`;
}

function serializeControlPlaneTableSqlRow(row: SaasControlPlaneTableSqlRow): string {
  return `  {\n${serializeComment('sqlComment', row.sqlComment)}    table: ${tsString(row.table)},\n  },`;
}

function serializeGatewayReadTable(entry: SaasGatewayReadTableTsEntry): string {
  return `  {\n${serializeComment('tsComment', entry.tsComment)}    table: ${tsString(entry.table)},\n  },`;
}

function serializeGatewayReadSqlRow(row: SaasGatewayReadSqlRow): string {
  return (
    '  {\n' +
    serializeComment('sqlComment', row.sqlComment) +
    `    tables: [${row.tables.map((table) => `'${table}'`).join(', ')}],\n` +
    '  },'
  );
}

function serializeGatewayColumnGroup(group: SaasGatewayColumnTsGroup): string {
  return (
    '  {\n' +
    serializeComment('tsComment', group.tsComment) +
    `    table: ${tsString(group.table)},\n` +
    `    privilege: '${group.privilege}',\n` +
    `    columns: [${group.columns.map((column) => `'${column}'`).join(', ')}],\n` +
    `    tsStyle: '${group.tsStyle}',\n` +
    '  },'
  );
}

function serializeGatewayColumnSqlEntry(entry: SaasGatewayColumnSqlEntry): string {
  return (
    '  {\n' +
    serializeComment('sqlComment', entry.sqlComment) +
    `    table: ${tsString(entry.table)},\n` +
    `    column: ${tsString(entry.column)},\n` +
    `    privilege: '${entry.privilege}',\n` +
    (entry.sqlJoinLine ? '    sqlJoinLine: true,\n' : '') +
    '  },'
  );
}

function serializeWorkerProbeGrant(grant: SaasWorkerProbeGrant): string {
  return (
    '  {\n' +
    serializeComment('comment', grant.comment) +
    `    table: ${tsString(grant.table)},\n` +
    `    column: ${JSON.stringify(grant.column)},\n` +
    `    privilege: '${grant.privilege}',\n` +
    '  },'
  );
}

function serializeWorkerGrantStatement(statement: SaasWorkerGrantStatement): string {
  return (
    '  {\n' +
    serializeComment('preamble', statement.preamble) +
    `    privilege: '${statement.privilege}',\n` +
    `    table: ${tsString(statement.table)},\n` +
    `    columnLines: [\n${statement.columnLines.map((line) => `      [${line.map((column) => `'${column}'`).join(', ')}],`).join('\n')}\n    ],\n` +
    (statement.singleLine ? '    singleLine: true,\n' : '') +
    '  },'
  );
}

const MANIFEST_HEADER = `/**
 * Single source of truth for the managed-SaaS PostgreSQL privilege mirrors
 * (DOps-2026-10-17 plan §4). GENERATED DATA — edit the manifest, then run
 * \`npx tsx scripts/generate-privileges.ts\` to regenerate the mirrors:
 *
 *   - src/saas/db/runtime-privileges.ts (constant-array sections)
 *   - deploy/managed-saas-postgres-roles.sql (grant-manifest VALUES sections)
 *   - src/saas/db/credential-validation-worker-privileges.ts (probe VALUES)
 *   - deploy/managed-saas-validation-worker-role-grants.sql (GRANT statements)
 *
 * The manifest carries one ordered view per mirror: the mirrors order the same
 * facts differently and attach different provenance comments, so each view
 * keeps its own comment text and the minimal layout hints (VALUES row packing,
 * TS spread style) needed to reproduce the existing hand layout byte-for-byte.
 * tests/saas/db/privileges-manifest.test.ts fences both directions: the views
 * must encode the same grant facts, and every mirror file must be
 * byte-identical to its regeneration from this manifest.
 */

`;

const MANIFEST_TYPES = `export type SaasColumnPrivilege = 'SELECT' | 'INSERT' | 'UPDATE';

/** Control-plane column grants, ordered as rendered in runtime-privileges.ts. */
export interface SaasControlPlaneColumnGroup {
  /** Provenance comment rendered above the runtime-privileges.ts entry. */
  readonly tsComment?: readonly string[];
  readonly table: string;
  readonly privilege: SaasColumnPrivilege;
  readonly columns: readonly string[];
  /**
   * Special render form for the shared COMMERCIAL_PRICE_VERSION_COLUMNS list.
   * The columns field always holds the resolved column list; tsRender only
   * controls how runtime-privileges.ts spells it.
   */
  readonly tsRender?: 'commercial-ref' | 'commercial-splice';
  /** Provenance comments rendered inside the TS array literal, keyed by the resolved column index they precede. */
  readonly tsColumnComments?: readonly { readonly before: number; readonly lines: readonly string[] }[];
}

/** Control-plane column grants as ordered in the roles.sql VALUES manifest. */
export interface SaasControlPlaneColumnSqlRow {
  /** Provenance comment rendered above the roles.sql VALUES row. */
  readonly sqlComment?: readonly string[];
  readonly table: string;
  readonly privilege: SaasColumnPrivilege;
  readonly columns: readonly string[];
}

/** Control-plane table-level DELETE grants (runtime-privileges.ts order). */
export interface SaasControlPlaneTableGrant {
  readonly tsComment?: readonly string[];
  readonly table: string;
}

/** Control-plane table-level DELETE grants (roles.sql VALUES order). */
export interface SaasControlPlaneTableSqlRow {
  readonly sqlComment?: readonly string[];
  readonly table: string;
}

/** Gateway read-only relations (runtime-privileges.ts order). */
export interface SaasGatewayReadTableTsEntry {
  readonly tsComment?: readonly string[];
  readonly table: string;
}

/** Gateway read-only relations, one entry per roles.sql VALUES line. */
export interface SaasGatewayReadSqlRow {
  readonly sqlComment?: readonly string[];
  readonly tables: readonly string[];
}

/** TS spread form used to render a gateway column-grant group. */
export type SaasGatewayColumnTsStyle =
  | 'inline'
  | 'map-flat'
  | 'map-paren-single'
  | 'map-paren-multi'
  | 'map-callback';

/** Gateway column grants, ordered as rendered in runtime-privileges.ts. */
export interface SaasGatewayColumnTsGroup {
  readonly tsComment?: readonly string[];
  readonly table: string;
  readonly privilege: SaasColumnPrivilege;
  readonly columns: readonly string[];
  readonly tsStyle: SaasGatewayColumnTsStyle;
}

/** Gateway column grants as ordered in the roles.sql VALUES manifest. */
export interface SaasGatewayColumnSqlEntry {
  readonly sqlComment?: readonly string[];
  readonly table: string;
  readonly column: string;
  readonly privilege: SaasColumnPrivilege;
  /** Render this tuple on the same VALUES line as the previous tuple. */
  readonly sqlJoinLine?: boolean;
}

/** Gateway table-level facts mirrored between runtime-privileges.ts and roles.sql. */
export interface SaasGatewayAuxiliaryGrants {
  readonly fullInsertTables: readonly string[];
  readonly deleteTables: readonly string[];
  readonly usageSequence: string;
}

/** Worker column grants in probe VALUES order (credential-validation-worker-privileges.ts). */
export interface SaasWorkerProbeGrant {
  readonly comment?: readonly string[];
  readonly table: string;
  readonly column: string;
  readonly privilege: SaasColumnPrivilege;
}

/** Worker GRANT statements (managed-saas-validation-worker-role-grants.sql). */
export interface SaasWorkerGrantStatement {
  /**
   * Exact lines rendered before the GRANT keyword: each entry is a provenance
   * comment line ('' renders a blank separator line).
   */
  readonly preamble?: readonly string[];
  readonly privilege: SaasColumnPrivilege;
  readonly table: string;
  /** Column list exactly as wrapped across the statement's lines. */
  readonly columnLines: readonly (readonly string[])[];
  /** Render the GRANT column list on one line instead of a wrapped block. */
  readonly singleLine?: boolean;
}

`;

export function serializePrivilegeManifest(manifest: ExtractedPrivilegeManifest): string {
  const section = (name: string, type: string, items: readonly string[]): string =>
    `export const ${name}: readonly ${type}[] = [\n${items.join('\n')}\n];\n`;
  return (
    MANIFEST_HEADER +
    MANIFEST_TYPES +
    section(
      'MANIFEST_CONTROL_PLANE_COLUMN_GROUPS',
      'SaasControlPlaneColumnGroup',
      manifest.controlPlaneColumnGroups.map(serializeControlPlaneColumnGroup),
    ) +
    '\n' +
    section(
      'MANIFEST_CONTROL_PLANE_COLUMN_SQL_ROWS',
      'SaasControlPlaneColumnSqlRow',
      manifest.controlPlaneColumnSqlRows.map(serializeControlPlaneColumnSqlRow),
    ) +
    '\n' +
    section(
      'MANIFEST_CONTROL_PLANE_TABLE_GRANTS',
      'SaasControlPlaneTableGrant',
      manifest.controlPlaneTableGrants.map(serializeControlPlaneTableGrant),
    ) +
    '\n' +
    section(
      'MANIFEST_CONTROL_PLANE_TABLE_SQL_ROWS',
      'SaasControlPlaneTableSqlRow',
      manifest.controlPlaneTableSqlRows.map(serializeControlPlaneTableSqlRow),
    ) +
    '\n' +
    section(
      'MANIFEST_GATEWAY_READ_TABLES',
      'SaasGatewayReadTableTsEntry',
      manifest.gatewayReadTables.map(serializeGatewayReadTable),
    ) +
    '\n' +
    section(
      'MANIFEST_GATEWAY_READ_SQL_ROWS',
      'SaasGatewayReadSqlRow',
      manifest.gatewayReadSqlRows.map(serializeGatewayReadSqlRow),
    ) +
    '\n' +
    section(
      'MANIFEST_GATEWAY_COLUMN_GROUPS',
      'SaasGatewayColumnTsGroup',
      manifest.gatewayColumnGroups.map(serializeGatewayColumnGroup),
    ) +
    '\n' +
    section(
      'MANIFEST_GATEWAY_COLUMN_SQL_ENTRIES',
      'SaasGatewayColumnSqlEntry',
      manifest.gatewayColumnSqlEntries.map(serializeGatewayColumnSqlEntry),
    ) +
    '\n' +
    `export const MANIFEST_GATEWAY_AUXILIARY: SaasGatewayAuxiliaryGrants = {\n` +
    `  fullInsertTables: [${manifest.gatewayAuxiliary.fullInsertTables.map((table) => `'${table}'`).join(', ')}],\n` +
    `  deleteTables: [${manifest.gatewayAuxiliary.deleteTables.map((table) => `'${table}'`).join(', ')}],\n` +
    `  usageSequence: '${manifest.gatewayAuxiliary.usageSequence}',\n` +
    `};\n` +
    '\n' +
    section(
      'MANIFEST_WORKER_PROBE_GRANTS',
      'SaasWorkerProbeGrant',
      manifest.workerProbeGrants.map(serializeWorkerProbeGrant),
    ) +
    '\n' +
    section(
      'MANIFEST_WORKER_GRANT_STATEMENTS',
      'SaasWorkerGrantStatement',
      manifest.workerGrantStatements.map(serializeWorkerGrantStatement),
    )
  );
}
