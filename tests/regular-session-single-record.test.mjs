import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 같은 반·같은 날 정규 수업 기록(Session)은 하나 — 2026-11-08.
// 사고 유형: 관리자가 먼저 출결을 저장하면 «키 없는» 기록이 생기고, 뒤에 코치가 수업을 시작하면
//            키로만 찾아 기록을 하나 더 만들었다 → 같은 날 출결이 두 기록으로 갈라진다(운영 0건, 잠재 위험).
// 이제 관리자 출결·수업일지·랠리즈·코치 시작·예정 내용이 모두 regularSession.ts 의 같은 함수를 쓴다.

const mod = await loadTsModule("src/lib/regular/regularSession.ts");

/** Session 테이블을 흉내 내는 가짜 db — regularSession.ts 가 보내는 SQL 세 종류만 이해한다. */
function fakeDb(initial = []) {
  const rows = initial.map((r, i) => ({ seasonal: null, sessionKey: null, createdAt: i, ...r }));
  const calls = [];
  let seq = 0;
  return {
    rows,
    calls,
    async $executeRawUnsafe(sql, ...values) {
      if (sql.includes("pg_advisory_xact_lock")) { calls.push("lock"); return 0; }
      if (sql.includes(`UPDATE "Session" SET "sessionKey"`)) {
        calls.push("adopt");
        const [classId, ymd, key] = values;
        if (rows.some((r) => r.sessionKey === key)) return 0;
        const cand = rows
          .filter((r) => r.classId === classId && r.date === ymd && !r.seasonal && r.sessionKey == null)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
        if (!cand) return 0;
        cand.sessionKey = key;
        return 1;
      }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
    async $queryRawUnsafe(sql, ...values) {
      if (sql.includes(`SELECT id FROM "Session" WHERE id = $1 AND "classId" = $2`)) {
        calls.push("pick");
        assert.match(sql, /FOR UPDATE/, "수정 대상 기록은 잠그고 읽는다");
        const [id, classId] = values;
        return rows.filter((r) => r.id === id && r.classId === classId).map(({ id }) => ({ id }));
      }
      if (sql.includes(`INSERT INTO "Session"`)) {
        calls.push("upsert");
        const [classId, ymd, key] = values;
        const hit = rows.find((r) => r.sessionKey === key);
        if (hit) return [{ id: hit.id }];
        const row = { id: `new-${++seq}`, classId, date: ymd, sessionKey: key, seasonal: null, createdAt: 100 + seq };
        rows.push(row);
        return [{ id: row.id }];
      }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
  };
}

/** 코치 «수업 시작»의 기록 찾기 순서를 그대로 흉내 낸다: 입양 → 키로 찾기 → 없으면 키로 새로 만들기. */
async function coachStart(db, classId, ymd) {
  await mod.adoptRegularSessionKey(db, classId, ymd);
  const key = mod.regularSessionKey(classId, ymd);
  const hit = db.rows.find((r) => r.sessionKey === key);
  if (hit) return hit.id;
  const row = { id: `coach-${db.rows.length}`, classId, date: ymd, sessionKey: key, seasonal: null, createdAt: 999 };
  db.rows.push(row);
  return row.id;
}

test("키는 반·KST 날짜 그대로 — 코치 앱 옛 키 형식(`반id:YYYY-MM-DD`)과 같다", () => {
  assert.equal(mod.regularSessionKey("c1", "2026-11-08"), "c1:2026-11-08");
  assert.throws(() => mod.regularSessionKey("c1", "2026-02-30"), /날짜/);
  assert.throws(() => mod.regularSessionKey("c1", "2026-11-08T00:00:00Z"), /날짜/);
  assert.throws(() => mod.regularSessionKey("", "2026-11-08"), /수업/);
});

test("관리자가 먼저 저장 → 코치가 시작해도 같은 기록 하나", async () => {
  const db = fakeDb();
  const adminId = await mod.findOrCreateRegularSession(db, { classId: "c1", dateYmd: "2026-11-08" });
  const coachId = await coachStart(db, "c1", "2026-11-08");
  assert.equal(coachId, adminId);
  assert.equal(db.rows.length, 1);
});

test("옛 코드가 만든 «키 없는» 관리자 기록이 이미 있으면 새로 만들지 않고 그 기록에 키를 붙인다", async () => {
  const db = fakeDb([{ id: "legacy", classId: "c1", date: "2026-11-08" }]);
  const coachId = await coachStart(db, "c1", "2026-11-08");
  assert.equal(coachId, "legacy");
  const adminId = await mod.findOrCreateRegularSession(db, { classId: "c1", dateYmd: "2026-11-08" });
  assert.equal(adminId, "legacy");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].sessionKey, "c1:2026-11-08");
});

test("코치가 먼저 시작 → 관리자 저장도 같은 기록", async () => {
  const db = fakeDb();
  const coachId = await coachStart(db, "c1", "2026-11-08");
  const adminId = await mod.findOrCreateRegularSession(db, { classId: "c1", dateYmd: "2026-11-08" });
  assert.equal(adminId, coachId);
  assert.equal(db.rows.length, 1);
});

test("다른 날·다른 반·방학특강 회차 기록은 입양하지 않는다", async () => {
  const db = fakeDb([
    { id: "other-day", classId: "c1", date: "2026-11-07" },
    { id: "other-class", classId: "c2", date: "2026-11-08" },
    { id: "seasonal", classId: "c1", date: "2026-11-08", seasonal: "sd1", sessionKey: "seasonal:sd1" },
  ]);
  const id = await mod.findOrCreateRegularSession(db, { classId: "c1", dateYmd: "2026-11-08" });
  assert.ok(!["other-day", "other-class", "seasonal"].includes(id));
  assert.equal(db.rows.find((r) => r.id === "other-day").sessionKey, null);
  assert.equal(db.rows.find((r) => r.id === "other-class").sessionKey, null);
});

test("이미 갈라진 날(키 기록 + 키 없는 기록)은 키 기록을 쓰고 키 없는 쪽에 키를 붙이려다 충돌하지 않는다", async () => {
  const db = fakeDb([
    { id: "orphan", classId: "c1", date: "2026-11-08" },
    { id: "keyed", classId: "c1", date: "2026-11-08", sessionKey: "c1:2026-11-08" },
  ]);
  const id = await mod.findOrCreateRegularSession(db, { classId: "c1", dateYmd: "2026-11-08" });
  assert.equal(id, "keyed");
  assert.equal(db.rows.find((r) => r.id === "orphan").sessionKey, null);
});

test("키 없는 기록이 여럿이면 가장 먼저 만든 것 하나만 입양한다", async () => {
  const db = fakeDb([
    { id: "b-later", classId: "c1", date: "2026-11-08", createdAt: 5 },
    { id: "a-first", classId: "c1", date: "2026-11-08", createdAt: 1 },
  ]);
  const id = await mod.findOrCreateRegularSession(db, { classId: "c1", dateYmd: "2026-11-08" });
  assert.equal(id, "a-first");
  assert.equal(db.rows.find((r) => r.id === "b-later").sessionKey, null);
});

test("잠금 → 입양 → 찾기/만들기 순서(동시 요청이 섞이지 않게)", async () => {
  const db = fakeDb();
  await mod.findOrCreateRegularSession(db, { classId: "c1", dateYmd: "2026-11-08" });
  assert.deepEqual(db.calls, ["lock", "adopt", "upsert"]);
});

// ── 입력 경로가 모두 같은 함수를 쓰는지(한쪽만 고치는 사고 방지) ──
const admin = readFileSync("src/app/actions/admin.ts", "utf8");
const staff = readFileSync("src/app/actions/staff-sessions.ts", "utf8");
const rallyz = readFileSync("src/app/actions/rallyz-attendance-sync.ts", "utf8");

function body(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} 함수가 없습니다`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("관리자 출결 저장(정규)·수업일지·랠리즈는 findOrCreateRegularSession 으로 기록을 찾는다", () => {
  assert.match(body(admin, "saveAttendance"), /findOrCreateRegularSession\(tx, \{ classId, dateYmd: date \}\)/);
  assert.match(body(admin, "saveSessionLog"), /resolveSessionLogTarget\(tx, \{ classId: data\.classId, dateYmd: data\.date, sessionId: data\.sessionId \}\)/);
  assert.match(body(rallyz, "applyRallyzAttendanceSync"), /findOrCreateRegularSession\(tx,/);
});

test("관리자 쪽에 «키 없는» 정규 기록을 만드는 INSERT 가 남아 있지 않다", () => {
  // 방학특강 회차 기록은 seasonal 키로 만들므로 제외 — sessionKey 없이 Session 을 INSERT 하는 문장이 없어야 한다.
  const inserts = [...admin.matchAll(/INSERT INTO "Session" \(([^)]*)\)/g)].map((m) => m[1]);
  for (const cols of inserts) assert.match(cols, /"sessionKey"/, `키 없는 Session INSERT: ${cols}`);
});

test("코치 수업 시작·예정 내용 저장은 같은 키 함수 + 키 없는 기록 입양을 거친다", () => {
  for (const name of ["startClassSession", "savePlannedClassContent"]) {
    const b = body(staff, name);
    assert.match(b, /regularSessionKey\(/, `${name}: regularSessionKey`);
    assert.match(b, /adoptRegularSessionKey\(tx,/, `${name}: adoptRegularSessionKey`);
    assert.doesNotMatch(b, /`\$\{(input\.)?classId\}:\$\{(input\.)?date\}`/, `${name}: 키를 손으로 조립하지 않는다`);
  }
});

// ── 수업일지 수정: 반 상세 목록의 방학특강 회차 기록을 고쳐도 정규 기록이 새로 생기지 않는다(검수 필수1) ──
test("특강 회차 기록을 수정하면 그 기록만 고치고 새 정규 기록을 만들지 않는다", async () => {
  const db = fakeDb([{ id: "seasonal-1", classId: "c1", date: "2026-11-08", seasonal: "spd-1" }]);
  const id = await mod.resolveSessionLogTarget(db, { classId: "c1", dateYmd: "2026-11-08", sessionId: "seasonal-1" });
  assert.equal(id, "seasonal-1");
  assert.equal(db.rows.length, 1, "정규 기록이 새로 생기지 않는다");
  assert.deepEqual(db.calls, ["pick"]);
});

test("다른 반 기록 id 로는 수정하지 못한다(새 기록도 만들지 않는다)", async () => {
  const db = fakeDb([{ id: "other", classId: "c2", date: "2026-11-08" }]);
  await assert.rejects(() => mod.resolveSessionLogTarget(db, { classId: "c1", dateYmd: "2026-11-08", sessionId: "other" }), /이 반에서 찾지 못했습니다/);
  assert.equal(db.rows.length, 1);
});

test("새로 작성(기록 id 없음)은 같은 반·같은 날 정규 기록 하나 규칙을 탄다", async () => {
  const db = fakeDb([{ id: "legacy", classId: "c1", date: "2026-11-08" }]);
  assert.equal(await mod.resolveSessionLogTarget(db, { classId: "c1", dateYmd: "2026-11-08" }), "legacy");
  assert.deepEqual(db.calls, ["lock", "adopt", "upsert"]);
});

test("수업일지 화면은 수정 모드에서 날짜를 그대로 두면 기록 id 를 함께 보낸다", () => {
  const modal = readFileSync("src/app/admin/classes/[id]/SessionLogModal.tsx", "utf8");
  assert.match(modal, /sessionId: initialData && initialData\.date === date \? initialData\.id : undefined/);
});

test("관리자 출결 화면은 같은 날 기록이 둘이면 키 있는 기록을 먼저 고른다", () => {
  const queries = readFileSync("src/lib/queries.ts", "utf8");
  const start = queries.indexOf("export const getAttendanceByDateAndClass");
  const b = queries.slice(start, queries.indexOf("\nexport ", start + 1));
  assert.match(b, /"specialProgramSessionDateId" IS NULL\s+ORDER BY \("sessionKey" IS NULL\), "createdAt" LIMIT 1/);
});
