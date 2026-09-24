/**
 * Trade journal record validation (T2, docs/PLAN_TRADE_JOURNAL.md).
 *
 * Pure: no I/O, no env, no clock (the caller passes `now` and the id generator).
 * Validates what the GPT sends to POST /api/journal and builds the stored record from
 * an explicit field list, so nothing outside the list (wallet, key, address) is ever
 * stored. `text` is required; every number is optional; `kind` is an enum
 * (default `note`); `engineRef` is an optional object of short strings.
 */

export const JOURNAL_SCHEMA_VERSION = 'journal-1';
export const MAX_RECORD_BYTES = 4096;
export const MAX_TEXT_CHARS = 1000;
export const KINDS = Object.freeze(['open', 'close', 'adjust', 'skip', 'note']);
export const DIRECTIONS = Object.freeze(['long', 'short']);
export const REC_CLASSES = Object.freeze(['GOOD', 'WATCH', 'BAD', 'DATA_UNAVAILABLE']);

/** Price-like numbers must be > 0; result numbers may be any finite value. */
const POSITIVE_FIELDS = Object.freeze(['entry', 'stop', 'tp1', 'sizeUsd', 'leverage', 'exitPrice']);
const SIGNED_FIELDS = Object.freeze(['resultR', 'resultUsd']);
const ENGINE_REF_FIELDS = Object.freeze(['candidateId', 'planId', 'recClass', 'reasonCode']);

/** Stored record keys, in order. */
export const RECORD_KEYS = Object.freeze([
  'id', 'schemaVersion', 'receivedAt', 'saidAt', 'kind', 'symbol', 'direction',
  ...POSITIVE_FIELDS, ...SIGNED_FIELDS, 'engineRef', 'text'
]);

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = (v) => v === undefined || v === null;

/** UTF-8 byte length of a string. */
export function byteLength(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

/**
 * Validate a request body and build the record to store.
 * @param {*} body - parsed JSON body
 * @param {{now: Date|number|string, newId: () => string}} ctx
 * @returns {{ok: true, record: Object} | {ok: false, errors: string[]}}
 */
export function validateJournalEntry(body, { now, newId }) {
  const errors = [];
  if (!isObj(body)) return { ok: false, errors: ['body must be a JSON object'] };

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) errors.push('text is required');
  else if (text.length > MAX_TEXT_CHARS) errors.push(`text exceeds ${MAX_TEXT_CHARS} characters`);

  let kind = 'note';
  if (!absent(body.kind)) {
    if (typeof body.kind === 'string' && KINDS.includes(body.kind.toLowerCase())) kind = body.kind.toLowerCase();
    else errors.push(`kind must be one of ${KINDS.join(', ')}`);
  }

  let symbol = null;
  if (!absent(body.symbol)) {
    const s = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    if (SYMBOL_RE.test(s)) symbol = s;
    else errors.push('symbol must be 1-12 letters or digits');
  }

  let direction = null;
  if (!absent(body.direction)) {
    const d = typeof body.direction === 'string' ? body.direction.toLowerCase() : '';
    if (DIRECTIONS.includes(d)) direction = d;
    else errors.push('direction must be long, short or null');
  }

  const numbers = {};
  for (const k of [...POSITIVE_FIELDS, ...SIGNED_FIELDS]) {
    const v = body[k];
    if (absent(v)) { numbers[k] = null; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${k} must be a number or null`); continue; }
    if (POSITIVE_FIELDS.includes(k) && v <= 0) { errors.push(`${k} must be greater than 0`); continue; }
    numbers[k] = v;
  }

  let engineRef = null;
  if (!absent(body.engineRef)) {
    if (!isObj(body.engineRef)) errors.push('engineRef must be an object or null');
    else {
      const ref = {};
      for (const k of ENGINE_REF_FIELDS) {
        const v = body.engineRef[k];
        if (absent(v)) { ref[k] = null; continue; }
        if (typeof v !== 'string' || v.length > 200) { errors.push(`engineRef.${k} must be a string of at most 200 characters`); continue; }
        ref[k] = v;
      }
      if (ref.recClass !== null && ref.recClass !== undefined && !REC_CLASSES.includes(ref.recClass)) {
        errors.push(`engineRef.recClass must be one of ${REC_CLASSES.join(', ')}`);
      }
      engineRef = ref;
    }
  }

  let saidAt = null;
  if (!absent(body.saidAt)) {
    const ms = typeof body.saidAt === 'string' ? Date.parse(body.saidAt) : NaN;
    if (Number.isFinite(ms)) saidAt = new Date(ms).toISOString();
    else errors.push('saidAt must be an ISO 8601 time');
  }

  let id = null;
  if (!absent(body.id)) {
    if (typeof body.id === 'string' && ID_RE.test(body.id)) id = body.id;
    else errors.push('id must be 8-64 characters of A-Z, a-z, 0-9, _ or -');
  }

  if (errors.length) return { ok: false, errors };

  const record = {
    id: id || newId(),
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    receivedAt: new Date(now).toISOString(),
    saidAt,
    kind,
    symbol,
    direction,
    ...numbers,
    engineRef,
    text
  };
  if (byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) return { ok: false, errors: [`record exceeds ${MAX_RECORD_BYTES} bytes`] };
  return { ok: true, record };
}

/** UTC day (YYYY-MM-DD) of an ISO time. */
export function journalDay(iso) {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

/** Blob pathname of a day file. */
export function journalDayPath(day) {
  return `journal/${day}.jsonl`;
}

export const JOURNAL_MANIFEST_PATH = 'journal/manifest.json';

/** Parse JSONL text; torn or non-object lines are skipped. */
export function parseJournalLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (isObj(row)) out.push(row);
    } catch { /* skipped */ }
  }
  return out;
}
