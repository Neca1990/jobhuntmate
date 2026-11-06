// A stand-in for Cloudflare D1 on Node's built-in SQLite, with the same prepare/bind/first/all/run/batch calls.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    // D1 tells the database size after each query; tests can pretend a size with db.fakeSize
    const size = this.db.fakeSize ?? this.db.prepare("SELECT page_count * page_size AS s FROM pragma_page_count(), pragma_page_size()").get().s;
    return { meta: { changes: r.changes, size_after: size } };
  }
}

export function testDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../db/migrations/", import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  return {
    raw: db,
    set fakeSize(bytes) { db.fakeSize = bytes; },
    prepare: (sql) => new Statement(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
