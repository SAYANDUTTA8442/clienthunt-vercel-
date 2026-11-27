'use strict';
/**
 * In-memory MODEL of Firestore + Auth for fast unit tests. It models: versioned documents, optimistic transactions that
 * abort and re-run when a document they READ (including a non-existent one) changed, reads-before-writes enforcement,
 * atomic commits (a failed create applies nothing), Timestamp values, and interleaving at every await.
 * It is a model, NOT Firestore. Concurrency claims are only verified by test/emulator/*.
 */
const store = new Map();            // path -> { data, v }
const stats = { txCallbacks: 0, txConflicts: 0 };
const yieldTick = () => new Promise((r) => setImmediate(r));

class Timestamp {
  constructor(ms) { this._ms = ms; this._seconds = Math.floor(ms / 1000); this._nanoseconds = (ms % 1000) * 1e6; }
  toMillis() { return this._ms; } toDate() { return new Date(this._ms); }
}
function ser(o) {
  if (o instanceof Date) return new Timestamp(o.getTime());
  if (o instanceof Timestamp) return o;
  if (Array.isArray(o)) return o.map(ser);
  if (o && typeof o === 'object') { const r = {}; for (const k in o) if (o[k] !== undefined) r[k] = ser(o[k]); return r; }
  return o;
}
const clone = (o) => (o instanceof Timestamp ? o : Array.isArray(o) ? o.map(clone) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clone(v)])) : o);
const err = (code, msg) => Object.assign(new Error(msg), { code });

class Snap { constructor(ref, rec) { this.ref = ref; this.id = ref.id; this.exists = !!rec; this._d = rec && rec.data; } data() { return this._d === undefined ? undefined : clone(this._d); } }
const ver = (path) => (store.has(path) ? store.get(path).v : 0);
function applyWrite(path, op, data) {
  if (op === 'delete') { store.delete(path); return; }
  const cur = store.get(path), v = (cur ? cur.v : 0) + 1;
  store.set(path, { data: op === 'merge' || op === 'update' ? Object.assign({}, cur ? cur.data : {}, ser(data)) : ser(data), v });
}
class Doc {
  constructor(col, id) { this.col = col; this.id = id; this.path = col + '/' + id; }
  async get() { await yieldTick(); return new Snap(this, store.get(this.path)); }
  async set(d, o) { await yieldTick(); applyWrite(this.path, o && o.merge && store.has(this.path) ? 'merge' : 'set', d); }
  async update(d) { await yieldTick(); if (!store.has(this.path)) throw err(5, 'NOT_FOUND'); applyWrite(this.path, 'update', d); }
  async delete() { await yieldTick(); applyWrite(this.path, 'delete'); }
}
class Query {
  constructor(col) { this.col = col; this.f = []; this.o = null; this.l = Infinity; }
  where(k, op, v) { const q = Object.assign(new Query(this.col), this); q.f = this.f.concat([[k, v]]); return q; }
  orderBy(k, d) { const q = Object.assign(new Query(this.col), this); q.o = [k, d || 'asc']; return q; }
  limit(n) { const q = Object.assign(new Query(this.col), this); q.l = n; return q; }
  async get() {
    await yieldTick();
    let rows = [...store.entries()].filter(([p]) => p.startsWith(this.col + '/')).map(([p, rec]) => ({ ref: new Doc(this.col, p.split('/')[1]), rec }));
    rows = rows.filter((r) => this.f.every(([k, v]) => r.rec.data[k] === v));
    if (this.o) rows.sort((a, b) => (a.rec.data[this.o[0]] < b.rec.data[this.o[0]] ? -1 : 1) * (this.o[1] === 'desc' ? -1 : 1));
    const docs = rows.slice(0, this.l).map((r) => new Snap(r.ref, r.rec));
    return { docs, empty: !docs.length, size: docs.length };
  }
}
class Col extends Query {
  doc(id) { return new Doc(this.col, id); }
  async add(d) { const id = 'auto' + Math.random().toString(36).slice(2); await this.doc(id).set(d); return this.doc(id); }
}

const db = {
  settings() {},
  collection: (c) => new Col(c),
  async runTransaction(fn, opts) {
    const max = (opts && opts.maxAttempts) || 5;
    for (let attempt = 1; ; attempt++) {
      stats.txCallbacks++;
      const reads = new Map(), writes = []; let wrote = false;
      const w = (kind) => (ref, d) => { wrote = true; writes.push({ kind, ref, d }); };
      const tx = {
        get: async (ref) => {
          if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          if (!reads.has(ref.path)) reads.set(ref.path, ver(ref.path));   // a non-existent doc is version 0 and is protected too
          await yieldTick();
          return new Snap(ref, store.get(ref.path));
        },
        set: w('set'), update: w('update'), create: w('create'), delete: w('delete')
      };
      const out = await fn(tx);
      await yieldTick();
      // ---- commit: synchronous, so it is atomic ----
      if ([...reads].some(([p, v]) => ver(p) !== v)) {
        stats.txConflicts++;
        if (attempt >= max) throw err(10, 'ABORTED: too much contention on these documents');
        continue;                                                           // the SDK re-runs the callback
      }
      for (const x of writes) {
        if (x.kind === 'create' && store.has(x.ref.path)) throw err(6, 'ALREADY_EXISTS');
        if (x.kind === 'update' && !store.has(x.ref.path)) throw err(5, 'NOT_FOUND');
      }
      for (const x of writes) applyWrite(x.ref.path, x.kind === 'delete' ? 'delete' : x.kind === 'update' ? 'update' : 'set', x.d);
      return out;
    }
  },
  batch() { const q = []; return { delete: (r) => q.push(() => r.delete()), set: (r, d) => q.push(() => r.set(d)), commit: async () => { for (const f of q) await f(); } }; }
};

const users = new Map();
const auth = {
  async createUser({ email, password, displayName }) { if ([...users.values()].some((u) => u.email === email)) throw Object.assign(new Error('exists'), { code: 'auth/email-already-exists' }); const uid = 'uid' + users.size; users.set(uid, { uid, email, password, displayName, disabled: false }); return users.get(uid); },
  async getUserByEmail(email) { const u = [...users.values()].find((x) => x.email === email); if (!u) throw Object.assign(new Error('nf'), { code: 'auth/user-not-found' }); return u; },
  async updateUser(uid, p) { Object.assign(users.get(uid), p); return users.get(uid); }
};

const reset = () => { store.clear(); users.clear(); stats.txCallbacks = 0; stats.txConflicts = 0; };
const docs = (col) => [...store.entries()].filter(([p]) => p.startsWith(col + '/')).map(([p, r]) => ({ id: p.split('/')[1], data: clone(r.data) }));
const put = (path, data) => applyWrite(path, 'set', data);

module.exports = { db, auth, store, users, stats, reset, docs, put, Timestamp, FieldValue: {}, admin: {} };
