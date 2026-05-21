// Schema parity: keep backend/sql/schema.sql in sync with backend/prisma/schema.prisma.
//
// We don't try to reproduce the full type system (Prisma's `cuid()` → TEXT,
// `String[]` → TEXT[], etc. are mapped by convention). Instead we assert that
// every Prisma model has a corresponding SQL CREATE TABLE and every scalar
// field has a column. Relation fields (which don't materialize as columns)
// are skipped using a small two-pass scan: first collect model + enum names,
// then ignore any field whose type names a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PRIMITIVES = new Set(['String', 'Int', 'Boolean', 'DateTime', 'Float', 'Json', 'Bytes', 'BigInt', 'Decimal']);

function parsePrisma(src) {
  const models = {};
  const enums = new Set();
  for (const m of src.matchAll(/^enum\s+(\w+)\s*\{/gm)) enums.add(m[1]);
  for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    models[m[1]] = { _body: m[2] };
  }
  for (const [name, model] of Object.entries(models)) {
    const fields = [];
    for (const rawLine of model._body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const [fname, ftypeRaw] = parts;
      if (!/^[a-z]/.test(fname)) continue; // skip block-level directives
      const baseType = ftypeRaw.replace(/[?[\]]/g, '');
      const isPrimitive = PRIMITIVES.has(baseType);
      const isEnum = enums.has(baseType);
      const isRelation = baseType in models;
      if (isRelation && !isPrimitive && !isEnum) continue; // virtual field
      fields.push(fname);
    }
    models[name] = fields;
  }
  return { models, enums };
}

function parseSql(src) {
  const tables = {};
  const enums = new Set();
  for (const m of src.matchAll(/CREATE TYPE\s+"(\w+)"\s+AS ENUM/g)) enums.add(m[1]);
  for (const m of src.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"(\w+)"\s*\(([\s\S]*?)\n\);/g)) {
    const name = m[1];
    const body = m[2];
    const cols = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;
      // Table-level constraints (UNIQUE(...), PRIMARY KEY(...), etc.) start with a keyword, not a quoted identifier
      if (!line.startsWith('"')) continue;
      const colMatch = line.match(/^"(\w+)"/);
      if (colMatch) cols.push(colMatch[1]);
    }
    tables[name] = cols;
  }
  return { tables, enums };
}

const prismaSrc = fs.readFileSync(path.join(ROOT, 'backend/prisma/schema.prisma'), 'utf8');
const sqlSrc = fs.readFileSync(path.join(ROOT, 'backend/sql/schema.sql'), 'utf8');
const prisma = parsePrisma(prismaSrc);
const sql = parseSql(sqlSrc);

test('every Prisma enum has a matching SQL enum type', () => {
  for (const e of prisma.enums) {
    assert.ok(sql.enums.has(e), `Missing SQL enum: ${e}`);
  }
});

test('every Prisma model has a matching SQL table', () => {
  for (const name of Object.keys(prisma.models)) {
    assert.ok(sql.tables[name], `Missing SQL table: "${name}"`);
  }
});

test('every Prisma scalar field has a matching SQL column', () => {
  for (const [model, fields] of Object.entries(prisma.models)) {
    const cols = new Set(sql.tables[model] || []);
    for (const f of fields) {
      assert.ok(cols.has(f), `"${model}"."${f}" missing from schema.sql`);
    }
  }
});

test('no orphan SQL tables (every SQL table maps to a Prisma model)', () => {
  for (const name of Object.keys(sql.tables)) {
    assert.ok(prisma.models[name], `Orphan SQL table "${name}" — no corresponding Prisma model`);
  }
});
