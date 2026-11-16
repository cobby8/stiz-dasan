import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-16 원장 지시 «DB 동시 연결 수 올리기» — 접속 주소의 connection_limit 항목 하나만 바꾼다.
const rules = await loadTsModule("src/lib/db/connectionLimit.ts");

test("connection_limit 만 바꾸고 주소의 나머지는 한 글자도 건드리지 않는다", () => {
  const base = "postgresql://user.name:p%40ss%3Aw%2Frd@host.example.com:6543/postgres";
  assert.equal(rules.withConnectionLimit(`${base}?pgbouncer=true&connection_limit=5`, 10), `${base}?pgbouncer=true&connection_limit=10`);
  assert.equal(rules.withConnectionLimit(`${base}?connection_limit=5&pgbouncer=true&pool_timeout=20`, 10), `${base}?pgbouncer=true&pool_timeout=20&connection_limit=10`);
  assert.equal(rules.withConnectionLimit(`${base}?pgbouncer=true`, 10), `${base}?pgbouncer=true&connection_limit=10`);
  assert.equal(rules.withConnectionLimit(base, 10), `${base}?connection_limit=10`);
  // 같은 항목이 두 번 있어도 하나로
  assert.equal(rules.withConnectionLimit(`${base}?connection_limit=5&connection_limit=3`, 8), `${base}?connection_limit=8`);
  // 비슷한 이름의 다른 항목은 건드리지 않는다
  assert.equal(rules.withConnectionLimit(`${base}?my_connection_limit=5`, 8), `${base}?my_connection_limit=5&connection_limit=8`);
  // 비었으면 그대로
  assert.equal(rules.withConnectionLimit("", 10), "");
  assert.equal(rules.withConnectionLimit(undefined, 10), "");
});

test("덮어쓰기 값은 1~30 정수만 받고, 아니면 기본 10", () => {
  assert.equal(rules.DEFAULT_CONNECTION_LIMIT, 10);
  assert.equal(rules.resolveConnectionLimit(undefined), 10);
  assert.equal(rules.resolveConnectionLimit(""), 10);
  assert.equal(rules.resolveConnectionLimit("8"), 8);
  assert.equal(rules.resolveConnectionLimit(" 12 "), 12);
  for (const bad of ["0", "31", "100", "-1", "5.5", "many", "1e1"]) assert.equal(rules.resolveConnectionLimit(bad), 10, bad);
});

test("Prisma 는 바꾼 주소로 열고, 주소를 기록하지 않는다", () => {
  const prisma = readFileSync("src/lib/prisma.ts", "utf8");
  assert.match(prisma, /new PrismaClient\(\{ datasources: \{ db: \{ url: withConnectionLimit\(url, limit\) \} \} \}\)/);
  assert.match(prisma, /if \(!url\) return new PrismaClient\(\);/);
  for (const file of ["src/lib/prisma.ts", "src/lib/db/connectionLimit.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /console\.|logger\./, `${file}: 접속 주소를 기록하지 않는다`);
  }
});
