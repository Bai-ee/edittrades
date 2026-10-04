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
    if (!res || !res.ok) return null;
    const etag = res.headers && typeof res.headers.get === 'function' ? strongEtag(res.headers.get('etag')) : null;
    return { text: await res.text(), etag: etag || null };
  } catch {
    return null;
  }
}

export const FRESH_BODY_TRIES = 3;
const FRESH_BODY_GAP_MS = 250;

/**
 * The body whose version is `wantEtag`, or null. The cache-busted fetch can still be served
 * the old copy; pairing an old body with the new ETag lets a guarded write pass and silently
 * drop the last writer's change (2026-10-03: a lock saved by the webhook vanished on the next
 * cron tick; the same LOCK NOW re-sent a minute later, 10 of 101). So the response's own ETag
 * must match; a response without an ETag header is accepted (nothing to compare).
 */
async function fetchBodyAtEtag(url, wantEtag, fetchImpl) {
  for (let i = 0; i < FRESH_BODY_TRIES; i++) {
    if (i) await new Promise((r) => setTimeout(r, FRESH_BODY_GAP_MS));
    const got = await fetchFreshBody(url, fetchImpl);
    if (got && (!got.etag || !wantEtag || got.etag === wantEtag)) return got.text;
  }
  return null;
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
  const text = await fetchBodyAtEtag((current && current.url) || meta.url, fresh, fetchImpl);
  if (typeof text !== 'string') throw stale(`fresh body unavailable after an etag mismatch (get ${current ? current.etag : 'none'}, head ${fresh})`);
  return { text, etag: fresh, url: (current && current.url) || meta.url || null };
}

/**
 * Body AND ETag from the blob's origin, past the CDN: the public blob URL with a unique query
 * (`get`'s `useCache: false` only bypasses the cache for PRIVATE blobs in @vercel/blob 2.x, so
 * on this public store every `get` can be a CDN copy up to cacheControlMaxAge (60 s) old -
 * seen live 2026-10-03/04: a lock saved by one tap was missing for the next tap 9-18 s later).
 * The ETag comes from the same response as the body, so the two always match. null on failure.
 */
async function fetchOrigin(url, fetchImpl = globalThis.fetch) {
  if (!url || typeof fetchImpl !== 'function') return null;
  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${url}${sep}nocache=${Date.now()}${Math.random().toString(36).slice(2, 8)}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(5000) });
    if (!res || !res.ok) return null;
    const text = await res.text();
    const etag = res.headers && typeof res.headers.get === 'function' ? strongEtag(res.headers.get('etag')) : null;
    return { text, etag: etag || null };
  } catch {
    return null;
  }
}

/**
 * Read-your-write read for state a button tap acts on (the Telegram state): with a real store
 * (`head` given) the body and ETag come from the origin (fetchOrigin), else / on failure the
 * plain `get`. `source` says which ('origin' | 'get') for the caller's log. A `get` 404 is
 * double-checked with `head` (a stale 404 right after the first write).
 * @returns {Promise<{text:string, etag:string|null, url:string|null, source:string}|null>}
 */
export async function readBlobOrigin({ get, head, fetchImpl }, pathname) {
  const current = await readBlob(get, pathname);
  if (typeof head !== 'function') return current ? { ...current, source: 'get' } : null;
  let url = current && current.url;
  let headEtag = null;
  if (!url) {
    let meta = null;
    try { meta = await head(pathname); } catch (err) { if (!isBlobNotFound(err)) throw err; }
    if (!meta) return null;
    url = meta.url || null;
    headEtag = meta.etag ? strongEtag(meta.etag) : null;
  }
  const fresh = await fetchOrigin(url, fetchImpl);
  if (fresh) {
    let etag = fresh.etag;
    if (!etag) {
      try { const meta = await head(pathname); etag = meta && meta.etag ? strongEtag(meta.etag) : headEtag; } catch { etag = headEtag; }
    }
    return { text: fresh.text, etag: etag || (current && current.etag) || null, url, source: 'origin' };
  }
  return current ? { ...current, source: 'get' } : null;
}

/**
 * Snapshot-addressed state (2026-10-04, locks "could not be saved" / vanished). On this PUBLIC
 * store every read of a fixed path can be a CDN copy up to cacheControlMaxAge old, and a
 * cache-busting query does not bypass it (seen live: the busted fetch returned the previous
 * version every time). A never-requested pathname is always read from the origin, so each
 * write also stores its body at a unique snapshot path and names that snapshot in the fixed
 * blob's contentType (`application/json; snap=<id>`). `head` (the API, not the CDN) then
 * points at the exact current body. The fixed blob keeps the full body for other readers.
 */
export const snapshotPathOf = (pathname, id) => `${pathname.replace(/\.json$/, '')}.v/${id}.json`;
const SNAP_RE = /;\s*snap=([0-9a-z-]{6,64})/i;
export const snapIdOf = (contentType) => {
  const m = typeof contentType === 'string' ? SNAP_RE.exec(contentType) : null;
  return m ? m[1] : null;
};
const newSnapId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const SNAP_TRIES = 3;
const SNAP_GAP_MS = 300;

/** Base URL (origin) of a blob URL, for building a sibling snapshot URL. */
function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * Exact current body via head -> snapshot id -> snapshot URL (never cached). null when the
 * blob has no snapshot yet (written before this scheme) or the snapshot cannot be fetched.
 * @returns {Promise<{text:string, etag:string|null, url:string|null, snapId:string, source:'snapshot'}|null>}
 */
export async function readBlobSnapshot({ head, fetchImpl = globalThis.fetch }, pathname) {
  if (typeof head !== 'function' || typeof fetchImpl !== 'function') return null;
  let meta;
  try { meta = await head(pathname); } catch (err) { if (isBlobNotFound(err)) return null; throw err; }
  const id = meta ? snapIdOf(meta.contentType) : null;
  const base = meta ? originOf(meta.url) : null;
  if (!id || !base) return null;
  const url = `${base}/${snapshotPathOf(pathname, id)}`;
  for (let i = 0; i < SNAP_TRIES; i++) {
    if (i) await new Promise((r) => setTimeout(r, SNAP_GAP_MS));
    try {
      const res = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (res && res.ok) return { text: await res.text(), etag: meta.etag ? strongEtag(meta.etag) : null, url: meta.url || null, snapId: id, source: 'snapshot' };
    } catch { /* retry */ }
  }
  return null;
}

/** Store `body` at a new snapshot path; returns the snapshot id. */
async function putSnapshot(put, pathname, body) {
  const id = newSnapId();
  await put(snapshotPathOf(pathname, id), body, { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json', cacheControlMaxAge: 31536000 });
  return id;
}

/** Best-effort delete of a snapshot that is no longer current. */
async function dropSnapshot(del, pathname, id) {
  if (!id || typeof del !== 'function') return;
  try { await del(snapshotPathOf(pathname, id)); } catch { /* an orphan costs storage only */ }
}

export async function updateBlob({ get, put, head, fetchImpl, del, snapshotPaths }, pathname, contentType, change, { forceOnExhaust = true, snapshots: snapOpt } = {}) {
  // Snapshot-addressed paths: per call, or listed on the store (the Telegram state).
  const snapshots = snapOpt ?? (Array.isArray(snapshotPaths) && snapshotPaths.includes(pathname));
  let lastErr = null;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, SNAP_GAP_MS));
    // Snapshot-addressed read first (exact body for head's ETag); the paths below are the fallback.
    const snap = snapshots ? await readBlobSnapshot({ head, fetchImpl }, pathname) : null;
    if (snap) {
      const next = change(snap.text);
      if (next === null) return { written: false, current: snap };
      const id = await putSnapshot(put, pathname, next);
      try {
        const result = await writeBlob(put, pathname, next, `${contentType}; snap=${id}`, snap.etag);
        await dropSnapshot(del, pathname, snap.snapId);
        return { written: true, result, attempts: attempt, snapshot: id };
      } catch (err) {
        await dropSnapshot(del, pathname, id);
        lastErr = err;
        if (!(isPreconditionFailed(err) || isOverwriteConflict(err))) throw err;
        continue;
      }
    }
    let current = await readBlob(get, pathname);
    let etag = current ? current.etag : null;
    // Real store: body + ETag from the origin (fetchOrigin), so the guarded write never lands on a
    // CDN copy. Falls through to the head check below when the origin fetch fails.
    let fromOrigin = false;
    if (current && typeof head === 'function') {
      const fresh = await fetchOrigin(current.url, fetchImpl);
      if (fresh && fresh.etag) { current = { ...current, text: fresh.text, etag: fresh.etag }; etag = fresh.etag; fromOrigin = true; }
    }
    // `get` can be served from a regional cache for up to cacheControlMaxAge; `head` is
    // the metadata endpoint and carries the current ETag. When they disagree the BODY we
    // read is stale too, so re-fetch it straight from the blob URL with a cache-buster
    // before applying `change` - otherwise the guarded write lands on an old body and
    // silently drops whatever the last writer added (seen 2026-09-25: alert memory lost).
    if (current && !fromOrigin && typeof head === 'function') {
      try {
        const meta = await head(pathname);
        const fresh = meta && meta.etag ? strongEtag(meta.etag) : null;
        if (fresh && fresh !== etag) {
          const freshText = await fetchBodyAtEtag(current.url || (meta && meta.url), fresh, fetchImpl);
          // No body at the current version: keep the stale body with ITS etag, so the guarded
          // write fails (precondition) and the next attempt re-reads, instead of landing on it.
          if (typeof freshText === 'string') { current = { ...current, text: freshText, etag: fresh }; etag = fresh; }
        }
      } catch { /* keep the etag and body from get */ }
    }
    const next = change(current ? current.text : null);
    if (next === null) return { written: false, current };
    try {
      const id = snapshots ? await putSnapshot(put, pathname, next) : null;
      const result = await writeBlob(put, pathname, next, id ? `${contentType}; snap=${id}` : contentType, etag);
      return { written: true, result, attempts: attempt, ...(id ? { snapshot: id } : {}) };
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
    // The unguarded overwrite must start from the FRESH body: a stale read here silently
    // drops the previous writer's change (2026-10-03: a flag-flow alert memory was lost and
    // the same LOCK OPPORTUNITY re-sent a minute later). Fresh body or nothing: an unguarded write on a stale body is exactly the lost update this
    // path exists to avoid. BlobStaleRead propagates; the caller skips this write.
    const snap = snapshots ? await readBlobSnapshot({ head, fetchImpl }, pathname) : null;
    let current = snap;
    if (!current) {
      try { current = await readBlobFresh({ get, head, fetchImpl }, pathname); } catch (err) {
        // Bootstrap only: a snapshot-enabled blob with no snapshot yet (written before the scheme)
        // has no exact read on a public store; this one write starts from `get` and creates the
        // first snapshot, after which every read is exact.
        if (!snapshots || !err || err.name !== 'BlobStaleRead') throw err;
        current = await readBlob(get, pathname);
      }
    }
    const next = change(current ? current.text : null);
    if (next === null) return { written: false, current };
    const id = snapshots ? await putSnapshot(put, pathname, next) : null;
    const result = await put(pathname, next, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: id ? `${contentType}; snap=${id}` : contentType, cacheControlMaxAge: 60 });
    if (snap) await dropSnapshot(del, pathname, snap.snapId);
    return { written: true, result, forced: true, attempts: WRITE_ATTEMPTS + 1, ...(id ? { snapshot: id } : {}) };
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
