/**
 * Vercel Blob JSONL helpers shared by the trade journal (api/journal.js) and the
 * served-calls recorder (lib/servedCalls.js).
 *
 * Pure over an injected store `{get, put}` (the @vercel/blob functions in production,
 * in-memory fakes in tests): no env, no clock. Every blob is public with a fixed
 * pathname; writes are read-modify-write guarded by the blob ETag (ifMatch) and retried
 * when a concurrent write wins. A day manifest `{schemaVersion, baseUrl, days[], updatedAt}`
 * lets the tracker fetch the day files with plain HTTP (no list call, no token).
 */

export const WRITE_ATTEMPTS = 3;

export const isPreconditionFailed = (err) => err && (err.name === 'BlobPreconditionFailedError' || /precondition/i.test(String(err.message)));

/**
 * T6 completion plan A4 (docs/PLAN_T6_COMPLETION_V2.md): the first-write race.
 * `updateBlob`'s ifMatch guard only applies once a blob already exists (`current` is
 * non-null); on a brand-new day file, two concurrent requests can both read `current:
 * null`, both think they are first, and both `put()` with no `ifMatch` - whichever wins
 * the network race silently overwrites the other's rows (no error, no retry, lost
 * write). `BlobAccessError` is what `put()` throws when `allowOverwrite: false` finds
 * the blob already exists - the signal `writeBlob`'s create path now asks for instead of
 * `allowOverwrite: true`.
 */
export const isOverwriteConflict = (err) => err && (err.name === 'BlobAccessError' || /already exists/i.test(String(err.message)));

/** {text, etag, url} of a blob, or null when it does not exist. Always bypasses the CDN cache. */
/**
 * @vercel/blob signals a missing blob two ways depending on the call and version:
 * `BlobNotFoundError` (get) or a plain Error "The requested blob does not exist" (head,
 * seen live 2026-09-25: it made the kill-switch read fail safe -> every order refused).
 * Only these two shapes mean "missing"; every other error still propagates (fail safe).
 */
export function isBlobNotFound(err) {
  if (!err) return false;
  if (err.name === 'BlobNotFoundError') return true;
  return /the requested blob does not exist/i.test(String(err.message || ''));
}

export async function readBlob(get, pathname) {
  let res;
  try {
    res = await get(pathname, { access: 'public', useCache: false });
  } catch (err) {
    if (isBlobNotFound(err)) return null;
    throw err;
  }
  if (!res) return null;
  const text = res.stream ? await new Response(res.stream).text() : '';
  return { text, etag: res.blob ? strongEtag(res.blob.etag) : null, url: res.blob ? res.blob.url : null };
}

/**
 * `get()` can return a weak ETag (`W/"..."`, added by the CDN's compression) while
 * `put({ifMatch})` only matches the strong form (`"..."`). Passing the weak one made every
 * append after a day's first write fail with "Precondition failed: ETag mismatch".
 */
export function strongEtag(etag) {
  return typeof etag === 'string' ? etag.replace(/^W\//, '') : etag ?? null;
}

/**
 * `etag` set (updating a blob known to exist): `ifMatch` guards the write - Vercel Blob
 * treats a matched `ifMatch` as implying `allowOverwrite`, so a concurrent writer that
 * changed the blob first makes this throw `BlobPreconditionFailedError`, not silently
 * overwrite. `etag` absent (the caller believes this is the first write - A4): asks for
 * `allowOverwrite: false` instead of `true`, so a concurrent request that already
 * created the blob makes this throw `BlobAccessError` instead of silently overwriting
 * it - the create path gets the same "someone else won, go re-read and retry" signal
 * the update path already had via `ifMatch`.
 */
export function writeBlob(put, pathname, body, contentType, etag) {
  return put(pathname, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: !!etag,
    contentType,
    cacheControlMaxAge: 60,
    ...(etag ? { ifMatch: etag } : {})
  });
}

/**
 * Read-modify-write with ETag guard, retried on a concurrent write - both the update
 * race (`isPreconditionFailed`, an existing blob's `ifMatch` lost the race) and the
 * first-write race (`isOverwriteConflict`, A4: two requests both thought they were
 * creating the blob). `change` returns the new text or null (no write).
 */
/** Body straight from the public blob URL, bypassing any edge cache. null on failure. */
async function fetchFreshBody(url, fetchImpl = globalThis.fetch) {
  if (!url || typeof fetchImpl !== 'function') return null;
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${url}${sep}nocache=${Date.now()}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(5000) });
    return res && res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Strict fresh read for state that gates a decision (the execution kill flag): `get`,
 * then `head`; when head's ETag differs from get's, the body is re-fetched from the blob
 * URL with a cache-buster. Throws (name `BlobStaleRead`) when the mismatch cannot be
 * resolved or head fails - the caller decides how to fail (the kill read fails closed).
 * A blob missing on `get` is checked with `head` too (a stale 404); null only when both
 * agree it does not exist.
 * @param {{get:Function, head?:Function, fetchImpl?:Function}} store
 * @returns {Promise<{text:string, etag:string|null, url:string|null}|null>}
 */
export async function readBlobFresh({ get, head, fetchImpl }, pathname) {
  const stale = (msg) => { const e = new Error(msg); e.name = 'BlobStaleRead'; return e; };
  const current = await readBlob(get, pathname);
  if (typeof head !== 'function') return current;
  let meta;
  try {
    meta = await head(pathname);
  } catch (err) {
    if (isBlobNotFound(err) && !current) return null;
    throw err;
  }
  if (!meta) {
    if (!current) return null;
    throw stale('head found no blob that get returned');
  }
  const fresh = meta.etag ? strongEtag(meta.etag) : null;
  if (current && fresh && fresh === current.etag) return current;
  const text = await fetchFreshBody((current && current.url) || meta.url, fetchImpl);
  if (typeof text !== 'string') throw stale('fresh body unavailable after an etag mismatch');
  return { text, etag: fresh, url: (current && current.url) || meta.url || null };
}

export async function updateBlob({ get, put, head, fetchImpl }, pathname, contentType, change, { forceOnExhaust = true } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    let current = await readBlob(get, pathname);
    let etag = current ? current.etag : null;
    // `get` can be served from a regional cache for up to cacheControlMaxAge; `head` is
    // the metadata endpoint and carries the current ETag. When they disagree the BODY we
    // read is stale too, so re-fetch it straight from the blob URL with a cache-buster
    // before applying `change` - otherwise the guarded write lands on an old body and
    // silently drops whatever the last writer added (seen 2026-09-25: alert memory lost).
    if (current && typeof head === 'function') {
      try {
        const meta = await head(pathname);
        const fresh = meta && meta.etag ? strongEtag(meta.etag) : null;
        if (fresh && fresh !== etag) {
          const freshText = await fetchFreshBody(current.url || (meta && meta.url), fetchImpl);
          if (typeof freshText === 'string') current = { ...current, text: freshText, etag: fresh };
          etag = fresh;
        }
      } catch { /* keep the etag and body from get */ }
    }
    const next = change(current ? current.text : null);
    if (next === null) return { written: false, current };
    try {
      const result = await writeBlob(put, pathname, next, contentType, etag);
      return { written: true, result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (!(isPreconditionFailed(err) || isOverwriteConflict(err))) throw err;
    }
  }
  // Repeated ETag mismatches with no real concurrent writer happen when the read is
  // served stale (regional cache) - seen in production 2026-09-24 on the Telegram state,
  // which is rewritten every minute. After WRITE_ATTEMPTS guarded tries, overwrite
  // unguarded rather than fail forever; the first-write race (overwrite conflict) still
  // gives up, because there a real second writer exists.
  if (forceOnExhaust && isPreconditionFailed(lastErr)) {
    const current = await readBlob(get, pathname);
    const next = change(current ? current.text : null);
    if (next === null) return { written: false, current };
    const result = await put(pathname, next, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType, cacheControlMaxAge: 60 });
    return { written: true, result, forced: true, attempts: WRITE_ATTEMPTS + 1 };
  }
  throw lastErr;
}

export function baseUrlOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** JSON objects from JSONL text; torn or non-object lines are skipped. */
export function parseJsonlObjects(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch { /* torn line skipped */ }
  }
  return rows;
}

/** Add `day` to the manifest at `manifestPath` unless it is already listed under the same baseUrl. */
export async function updateManifest(store, { manifestPath, manifestSchema, baseUrl, day, updatedAt }) {
  return updateBlob(store, manifestPath, 'application/json', (text) => {
    let manifest = null;
    try { manifest = text ? JSON.parse(text) : null; } catch { manifest = null; }
    const days = Array.isArray(manifest && manifest.days) ? manifest.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
    const known = manifest && manifest.baseUrl === baseUrl && days.includes(day);
    if (known) return null;
    const next = {
      schemaVersion: manifestSchema,
      baseUrl: baseUrl || (manifest && manifest.baseUrl) || null,
      days: [...new Set([...days, day])].sort(),
      updatedAt
    };
    return `${JSON.stringify(next, null, 2)}\n`;
  });
}

/**
 * Append the rows whose `keyOf` is not already in the day file, then list the day in the
 * manifest. All duplicates -> no write and no manifest update.
 * @param {{get: Function, put: Function}} store
 * @param {Object} o
 * @param {string} o.day - YYYY-MM-DD
 * @param {string} o.dayPath - e.g. served/2026-09-24.jsonl
 * @param {string} o.manifestPath
 * @param {string} o.manifestSchema
 * @param {Array<Object>} o.rows
 * @param {(row: Object) => string} o.keyOf
 * @param {string} o.nowIso - manifest updatedAt
 * @returns {Promise<{added:number, duplicates:number}>}
 */
export async function appendJsonlDay(store, { day, dayPath, manifestPath, manifestSchema, rows, keyOf, nowIso }) {
  let fresh = [];
  const { written, result } = await updateBlob(store, dayPath, 'text/plain; charset=utf-8', (text) => {
    const seen = new Set(parseJsonlObjects(text).map(keyOf));
    fresh = [];
    for (const row of rows) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(row);
    }
    if (!fresh.length) return null;
    const base = text && !text.endsWith('\n') ? `${text}\n` : (text || '');
    return `${base}${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`;
  });
  if (!written) return { added: 0, duplicates: rows.length };
  await updateManifest(store, { manifestPath, manifestSchema, baseUrl: baseUrlOf(result && result.url), day, updatedAt: nowIso });
  return { added: fresh.length, duplicates: rows.length - fresh.length };
}
