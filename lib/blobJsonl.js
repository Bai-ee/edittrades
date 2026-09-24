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

/** {text, etag, url} of a blob, or null when it does not exist. Always bypasses the CDN cache. */
export async function readBlob(get, pathname) {
  let res;
  try {
    res = await get(pathname, { access: 'public', useCache: false });
  } catch (err) {
    if (err && err.name === 'BlobNotFoundError') return null;
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

export function writeBlob(put, pathname, body, contentType, etag) {
  return put(pathname, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    cacheControlMaxAge: 60,
    ...(etag ? { ifMatch: etag } : {})
  });
}

/** Read-modify-write with ETag guard, retried on a concurrent write. `change` returns the new text or null (no write). */
export async function updateBlob({ get, put }, pathname, contentType, change) {
  for (let attempt = 1; ; attempt++) {
    const current = await readBlob(get, pathname);
    const next = change(current ? current.text : null);
    if (next === null) return { written: false, current };
    try {
      const result = await writeBlob(put, pathname, next, contentType, current ? current.etag : null);
      return { written: true, result };
    } catch (err) {
      if (attempt < WRITE_ATTEMPTS && isPreconditionFailed(err)) continue;
      throw err;
    }
  }
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
