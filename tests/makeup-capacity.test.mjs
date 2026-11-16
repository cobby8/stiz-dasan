import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  activeMakeupSql,
  computeRemainingSeats,
  isMakeupSlotFull,
  formatSeatLabel,
  MAKEUP_CAPACITY_FULL_MESSAGE,
} from "../src/lib/makeup/capacity.ts";

// 2026-08-05 사고 재발 방지.
//
// 무슨 일이 있었나:
//   보강 예약 모달이 잔여석을 계산하지 않고 **총정원을 그대로** 잔여석처럼 보여줬다
//   (remaining: c.capacity). 원장이 그 숫자를 "빈 자리"로 읽고 예약을 넣어 정원 초과가 났다.
//
// 그래서 잠그는 것 세 가지:
//   ① 잔여석 = 정원 − 수강 인원 − 그 날 활성 보강 수. 취소된 보강은 자리를 차지하지 않는다.
//   ② 모르는 값을 최대값으로 낙관 표시하지 않는다.
//   ③ 화면 표시뿐 아니라 **저장 시점에 서버가 다시 검증**한다(두 예약 경로 모두).

const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const adminActions = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const makeupClient = readFileSync(
  new URL("../src/app/admin/makeup/MakeupClient.tsx", import.meta.url),
  "utf8",
);

// ── ① 계산식 ────────────────────────────────────────────────────────────────

test("① 잔여석 = 정원 − 수강 인원 − 그 날 활성 보강 수", () => {
  assert.equal(
    computeRemainingSeats({ capacity: 10, enrolled: 6, bookedMakeups: 2 }),
    2,
  );
  assert.equal(
    computeRemainingSeats({ capacity: 8, enrolled: 8, bookedMakeups: 0 }),
    0,
  );
});

test("① 정원을 넘겨도 음수가 아니라 0(마감)으로 본다", () => {
  assert.equal(computeRemainingSeats({ capacity: 5, enrolled: 5, bookedMakeups: 3 }), 0);
  assert.equal(isMakeupSlotFull({ capacity: 5, enrolled: 5, bookedMakeups: 3 }), true);
});

test("① 잔여석이 0이면 마감, 1 이상이면 예약 가능", () => {
  assert.equal(isMakeupSlotFull({ capacity: 10, enrolled: 9, bookedMakeups: 1 }), true);
  assert.equal(isMakeupSlotFull({ capacity: 10, enrolled: 9, bookedMakeups: 0 }), false);
});

test("① 값이 비어 있어도(null/undefined) 계산이 깨지지 않는다", () => {
  assert.equal(
    computeRemainingSeats({ capacity: 6, enrolled: undefined, bookedMakeups: null }),
    6,
  );
});

test("① 취소된 보강은 자리를 차지하지 않는다 — 활성 판정은 status <> 'CANCELLED'", () => {
  // 기존 중복 방지 로직(regular-absence-admin)과 동일한 판정을 써야 한다.
  assert.equal(activeMakeupSql("ms"), `ms.status <> 'CANCELLED'`);
  // 조회/저장 검증 SQL 모두 이 조건을 통해 CANCELLED 를 제외한다.
  assert.match(queries, /activeMakeupSql\("ms"\)/);
  assert.match(adminActions, /activeMakeupSql\("ms"\)/);
});

// ── ② 낙관 표시 금지 ────────────────────────────────────────────────────────

test("② 잔여석을 모르면 총정원을 잔여석처럼 보여주지 않는다", () => {
  const label = formatSeatLabel({ capacity: 12, enrolled: 0, bookedMakeups: 0 }, false);
  assert.match(label, /확인 중/);
  assert.doesNotMatch(label, /잔여 12석/);
});

test("② 잔여석을 알면 '잔여 N석 · 정원 M명', 마감이면 '정원 마감'", () => {
  assert.equal(
    formatSeatLabel({ capacity: 12, enrolled: 9, bookedMakeups: 1 }, true),
    "잔여 2석 · 정원 12명",
  );
  assert.match(
    formatSeatLabel({ capacity: 12, enrolled: 12, bookedMakeups: 0 }, true),
    /정원 마감/,
  );
});

test("② 모달이 remaining 에 총정원을 넣던 코드가 남아 있지 않다", () => {
  assert.doesNotMatch(makeupClient, /remaining:\s*c\.capacity/);
  // 표시는 공용 계산식(formatSeatLabel)을 그대로 쓴다.
  assert.match(makeupClient, /formatSeatLabel\(slot, seatsLoaded\)/);
  // 마감된 슬롯은 선택 자체가 막힌다.
  assert.match(makeupClient, /disabled=\{full\}/);
});

test("② 날짜 기준으로 잔여석을 다시 조회한다", () => {
  assert.match(makeupClient, /loadMakeupSlotAvailability\(/);
  // 그 날의 보강만 세도록 makeupDate 로 필터한다.
  // 2026-11-14 검수: makeupDate 는 timestamptz, DB 는 UTC — 한국 날짜로 바꿔 센다(학부모 예약은 KST 자정 = 전날 15:00Z 로 저장된다)
  assert.match(queries, /\(ms\."makeupDate" AT TIME ZONE 'Asia\/Seoul'\)::date = \$1::date/);
  assert.doesNotMatch(queries, /ms\."makeupDate"::date/, "UTC 날짜로 세면 학부모 예약이 하루 앞 날짜로 잡힌다");
});

// ── ③ 저장 시점 서버 재검증 ─────────────────────────────────────────────────

test("③ 예약 저장 전에 서버가 정원을 다시 확인한다", () => {
  assert.match(adminActions, /async function assertMakeupSeatAvailable/);
  const bookIndex = adminActions.indexOf("export async function bookMakeupSession");
  assert.ok(bookIndex > 0, "bookMakeupSession 이 있어야 한다");
  const body = adminActions.slice(bookIndex, bookIndex + 2500);
  const guardAt = body.indexOf("assertMakeupSeatAvailable(data.makeupClassId");
  const insertAt = body.indexOf('INSERT INTO "MakeupSession"');
  assert.ok(guardAt > 0, "저장 전에 정원 검증을 호출해야 한다");
  assert.ok(guardAt < insertAt, "정원 검증은 INSERT 보다 먼저여야 한다");
});

// 2026-11-17 이월 리뷰 M-1 — «미리 확인»은 잠금 밖이라 마지막 한 자리에 두 예약이 동시에 오면
// 둘 다 통과해 정원을 1명 넘길 수 있었다. 잠금(lockCompensation) 뒤에 같은 연결(tx)로 다시 센다.
// 두 겹으로 잠근다: 바로 아래 3건은 소스 순서(어디에 무엇이 있는지)를 못박고,
// 그 뒤 «실제로 돌린다» 2건은 admin.ts 를 가짜 DB 로 불러 동시 예약 두 건을 실제로 실행한다.
function bookMakeupBody() {
  const start = adminActions.indexOf("export async function bookMakeupSession");
  const end = adminActions.indexOf("export async function cancelMakeupSession");
  assert.ok(start > 0 && end > start, "bookMakeupSession 본문을 찾을 수 있어야 한다");
  return adminActions.slice(start, end);
}
function seatGuardBody() {
  const start = adminActions.indexOf("async function assertMakeupSeatAvailable");
  const end = adminActions.indexOf("export async function bookMakeupSession");
  assert.ok(start > 0 && end > start, "assertMakeupSeatAvailable 본문을 찾을 수 있어야 한다");
  return adminActions.slice(start, end);
}

test("③ 잠금 뒤·INSERT 앞에 트랜잭션 연결(tx)로 정원을 한 번 더 확인한다", () => {
  const body = bookMakeupBody();
  const preCheckAt = body.indexOf("assertMakeupSeatAvailable(data.makeupClassId, data.makeupDate);");
  const txAt = body.indexOf("prisma.$transaction(");
  const lockAt = body.indexOf("await lockCompensation(tx)");
  const recheckAt = body.indexOf("await assertMakeupSeatAvailable(data.makeupClassId, data.makeupDate, tx)");
  const insertAt = body.indexOf('INSERT INTO "MakeupSession"');
  assert.ok(preCheckAt > 0, "트랜잭션 밖 «미리 확인»은 그대로 남아 있어야 한다");
  assert.ok(recheckAt > 0, "트랜잭션 안에서 tx 를 넘겨 정원을 다시 확인해야 한다");
  assert.ok(preCheckAt < txAt, "미리 확인은 트랜잭션 시작 전이어야 한다");
  assert.ok(txAt < lockAt, "잠금은 트랜잭션 안에서 건다");
  assert.ok(lockAt < recheckAt, "정원 재확인은 잠금 뒤여야 한다(잠금 전이면 동시 예약이 둘 다 통과한다)");
  assert.ok(recheckAt < insertAt, "정원 재확인은 INSERT 보다 먼저여야 한다");
});

// 왜 넘겨받은 연결(tx)로만 세나: 전역 prisma 로 세면, 트랜잭션이 연결 하나를 쥔 채 풀에서 두 번째 연결을
// 또 기다리게 된다. 서버당 연결 한도(10)에서 여러 예약이 그렇게 서로 막힐 수 있다.
test("③ 정원 확인 쿼리는 넘겨받은 연결(db)로만 나간다 — 전역 prisma 로 나가면 연결을 쥔 채 또 연결을 기다린다", () => {
  const guard = seatGuardBody();
  assert.match(guard, /db: CompensationTransaction = prisma/, "기본값은 전역 prisma(트랜잭션 밖 미리 확인)");
  assert.equal((guard.match(/db\.\$queryRawUnsafe/g) ?? []).length, 2, "반 정원·보강 수 두 쿼리 모두 db 로");
  assert.doesNotMatch(guard, /prisma\.\$queryRawUnsafe/);
  // 트랜잭션 안에서는 실패한 쿼리를 삼키지 않는다(삼켜도 트랜잭션이 이미 중단돼 뒤 INSERT 가 실패한다).
  const catchAt = guard.indexOf("} catch (e) {");
  const rethrowAt = guard.indexOf("if (db !== prisma) throw e;");
  const swallowAt = guard.indexOf("console.warn(");
  assert.ok(catchAt > 0 && rethrowAt > catchAt, "트랜잭션 안 호출은 집계 실패를 그대로 던져야 한다");
  assert.ok(rethrowAt < swallowAt, "던지기가 «0건으로 보고 넘어가기»보다 먼저여야 한다");
});

test("③ 잠금 뒤 재확인에서 가득 차도 원장에게 같은 정원 문구가 전달된다", () => {
  const body = bookMakeupBody();
  const rethrowAt = body.indexOf("e.message === MAKEUP_CAPACITY_FULL_MESSAGE) throw e;");
  const genericAt = body.indexOf('throw new Error("보강 예약 실패")');
  assert.ok(rethrowAt > 0, "정원 초과 오류는 그대로 다시 던져야 한다");
  assert.ok(rethrowAt < genericAt, "«보강 예약 실패»로 바꾸기 전에 다시 던져야 한다");
  // 이월 정산 충돌 안내도 그대로 유지
  assert.match(body, /if \(e instanceof CompensationConflict\) throw e;/);
});

// ── ③ 실제로 돌린다 — 마지막 한 자리에 동시 예약 두 건 ─────────────────────────
// admin.ts 를 가짜 DB 로 불러 bookMakeupSession 을 진짜로 실행한다(로드 방식은 staff-session-review.test.mjs 와 같다).

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const nodeRequire = createRequire(import.meta.url);

// mutate = 소스 문자열을 고쳐서 불러오는 선택 인자(대조 실험용 — 프로덕션 파일은 건드리지 않는다)
function load(path, mocks = {}, mutate = null) {
  const absolute = resolve(ROOT, path);
  let source = readFileSync(absolute, "utf8");
  if (mutate) source = mutate(source);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(ROOT);
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    // 보강 예약이 쓰지 않는 의존(@/·next/)은 빈 대역으로 돌린다 — admin.ts 가 불러오는 모듈이 수십 개라서다
    if (name.startsWith("@/") || name.startsWith("next/")) {
      return new Proxy({}, { get: (_t, key) => (key === "__esModule" ? true : async () => undefined) });
    }
    return nodeRequire(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}

const nextTurn = () => new Promise((done) => setImmediate(done));

// 가짜 DB — 보강 예약이 보내는 SQL 만 안다(모르는 SQL 은 던져서 테스트를 깨뜨린다).
//  · advisory 잠금: 잠금을 건 트랜잭션이 끝나야(커밋·되돌림) 다음 트랜잭션이 잠금을 얻는다.
//  · 저장: 트랜잭션 안 INSERT 는 커밋돼야 남에게 보인다. 던지면 버려진다.
//  · 트랜잭션 밖 «미리 확인»의 보강 수 조회는 두 건이 다 도착한 뒤에 함께 답한다 → 둘 다 «자리 있음»을 본다(경쟁 상황 고정).
function fakeMakeupDb({ capacity, enrolled }) {
  const state = {
    saved: [],            // 커밋된 보강
    preCheckCounts: [],   // 미리 확인(트랜잭션 밖)이 돌려받은 보강 수
    recheckCounts: [],    // 잠금 뒤 재확인(트랜잭션 안)이 돌려받은 보강 수
    events: [],           // 잠금·커밋·되돌림 순서
    lockHolders: 0,
    maxLockHolders: 0,    // 동시에 잠금을 쥔 트랜잭션 수의 최댓값(1 이어야 한 줄)
    waitedForLock: 0,     // 남이 잠금을 쥐고 있어 기다린 트랜잭션 수
  };
  let lockTail = Promise.resolve();
  let lockSeq = 0;
  let preCheckArrived = 0;
  let openPreCheckGate;
  const preCheckGate = new Promise((open) => (openPreCheckGate = open));
  const countFor = (rows, classId, ymd) =>
    rows.filter((r) => r.makeupClassId === classId && r.makeupDate.slice(0, 10) === String(ymd).slice(0, 10)).length;

  const client = (tx) => ({
    $queryRawUnsafe: async (sql, ...params) => {
      await nextTurn();
      if (/FROM "Class" c/.test(sql)) return [{ capacity, enrolled }];
      if (/FROM "MakeupSession" ms/.test(sql)) {
        if (!tx) {
          if (++preCheckArrived === 2) openPreCheckGate();
          await preCheckGate;
          const booked = countFor(state.saved, params[0], params[1]);
          state.preCheckCounts.push(booked);
          return [{ booked }];
        }
        // 트랜잭션 안: 커밋된 것 + 내가 방금 넣은 것
        const booked = countFor([...state.saved, ...tx.pending], params[0], params[1]);
        state.recheckCounts.push(booked);
        return [{ booked }];
      }
      if (/to_regclass/.test(sql)) return [{ found: null }]; // 이월 정산 표 없음 → 이월 충돌 검사는 통과
      throw new Error(`가짜 DB 가 모르는 조회: ${sql.slice(0, 80)}`);
    },
    $executeRawUnsafe: async (sql, ...params) => {
      await nextTurn();
      if (/pg_advisory_xact_lock/.test(sql)) {
        if (!tx) throw new Error("잠금은 트랜잭션 안에서만 걸 수 있다");
        await tx.acquireLock();
        return 1;
      }
      if (/^\s*INSERT INTO "MakeupSession"/.test(sql)) {
        if (!tx) throw new Error("보강 저장은 트랜잭션 안에서만 한다");
        tx.pending.push({ studentId: params[0], makeupClassId: params[3], makeupDate: params[4] });
        return 1;
      }
      if (/CREATE (TABLE|INDEX)/.test(sql)) return 0; // ensureMakeupSessionTable
      throw new Error(`가짜 DB 가 모르는 실행문: ${sql.slice(0, 80)}`);
    },
  });

  const prisma = client(null);
  prisma.$transaction = async (run) => {
    let releaseLock = null;
    const tx = { pending: [], id: 0 };
    tx.acquireLock = async () => {
      const previous = lockTail;
      lockTail = new Promise((release) => (releaseLock = release));
      if (state.lockHolders > 0) state.waitedForLock++;
      await previous; // 앞 트랜잭션이 끝날 때까지 여기서 멈춘다
      tx.id = ++lockSeq;
      state.lockHolders++;
      state.maxLockHolders = Math.max(state.maxLockHolders, state.lockHolders);
      state.events.push(`잠금:${tx.id}`);
    };
    const end = (how) => {
      if (!releaseLock) return;
      state.events.push(`${how}:${tx.id}`);
      state.lockHolders--;
      releaseLock(); // 트랜잭션이 끝나야 잠금이 풀린다
    };
    try {
      const result = await run(client(tx));
      state.saved.push(...tx.pending); // 커밋 — 이제 남에게 보인다
      end("커밋");
      return result;
    } catch (error) {
      end("되돌림"); // 넣던 것은 버린다
      throw error;
    }
  };
  return { prisma, state };
}

const RECHECK_LINE = "await assertMakeupSeatAvailable(data.makeupClassId, data.makeupDate, tx);";

// 남은 자리 1(정원 10·수강 9)인 반에 서로 다른 학생 두 명의 보강을 동시에 넣는다. 날짜는 고정 문자열.
async function raceTwoBookings(mutate = null) {
  const { prisma, state } = fakeMakeupDb({ capacity: 10, enrolled: 9 });
  // 규칙 모듈은 진짜를 쓴다(잠금·이월 충돌 검사·정원 계산·통합 학생 조건)
  const admin = load("src/app/actions/admin.ts", {
    "@/lib/prisma": { prisma },
    "@/lib/billing/absence-compensation-guard": load("src/lib/billing/absence-compensation-guard.ts"),
    "@/lib/makeup/capacity": load("src/lib/makeup/capacity.ts"),
    "@/lib/studentVisibility": load("src/lib/studentVisibility.ts"),
    "@/lib/auth-guard": {
      requireAdmin: async () => ({ id: "admin" }),
      requireOwner: async () => ({ id: "admin" }),
      requireVerifiedParent: async () => ({}),
      forgetAppUserRoleCache() {},
    },
    "next/cache": { revalidatePath() {}, revalidateTag() {} },
  }, mutate);
  const book = (studentId) => admin.bookMakeupSession({
    studentId,
    originalClassId: "class-original",
    originalDate: "2026-11-10",
    makeupClassId: "class-makeup",
    makeupDate: "2026-11-20",
  });
  const results = await Promise.allSettled([book("student-1"), book("student-2")]);
  return { results, state };
}

test("③ 실제로 돌린다 — 남은 자리 1에 동시 예약 2건이면 1건만 저장되고 1건은 정원 문구로 거절된다", { timeout: 20000 }, async () => {
  const { results, state } = await raceTwoBookings();

  // 전제 ① 경쟁 상황이 맞다 — 트랜잭션 밖 «미리 확인» 두 건 모두 보강 0건(= 자리 있음)을 봤다
  assert.deepEqual(state.preCheckCounts, [0, 0], "미리 확인은 두 건 다 «자리 있음»을 봐야 경쟁이다");
  // 전제 ② 가짜 DB 가 트랜잭션을 한 줄로 세웠다 — 앞이 끝나야 뒤가 잠금을 얻는다
  assert.equal(state.waitedForLock, 1, "두 번째 트랜잭션은 잠금을 기다렸어야 한다");
  assert.equal(state.maxLockHolders, 1, "잠금을 동시에 쥔 트랜잭션은 하나뿐이어야 한다");
  assert.deepEqual(state.events, ["잠금:1", "커밋:1", "잠금:2", "되돌림:2"]);
  // 잠금 뒤 재확인이 본 값: 첫 예약은 0건, 둘째는 앞 예약이 커밋된 뒤라 1건
  assert.deepEqual(state.recheckCounts, [0, 1]);

  // 결과: 성공 1 · 실패 1, 실패는 원장이 보는 정원 문구 그대로
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "한 건만 성공해야 한다");
  assert.equal(rejected.length, 1, "한 건은 거절돼야 한다");
  assert.equal(rejected[0].reason.message, MAKEUP_CAPACITY_FULL_MESSAGE);
  // 저장된 보강은 정확히 1건(정원 10 = 수강 9 + 보강 1)
  assert.equal(state.saved.length, 1, "남은 자리 1에 보강이 1건만 저장돼야 한다");
});

test("③ 대조 — 잠금 뒤 재확인 한 줄을 뺀 사본은 같은 상황에서 2건이 저장된다(위 테스트가 그 줄을 지킨다는 증거)", { timeout: 20000 }, async () => {
  assert.equal(adminActions.split(RECHECK_LINE).length, 2, "지울 재확인 호출은 소스에 정확히 한 번 있어야 한다");
  const { results, state } = await raceTwoBookings((source) => source.replace(RECHECK_LINE, ""));

  // 전제는 위 테스트와 똑같다 — 달라진 것은 재확인 한 줄뿐
  assert.deepEqual(state.preCheckCounts, [0, 0]);
  assert.equal(state.waitedForLock, 1);
  assert.equal(state.maxLockHolders, 1);
  assert.deepEqual(state.recheckCounts, [], "사본에서는 잠금 뒤 재확인이 돌지 않는다");
  // 잠금으로 한 줄을 서도, 다시 세지 않으면 둘 다 저장된다 = 정원 초과
  assert.deepEqual(state.events, ["잠금:1", "커밋:1", "잠금:2", "커밋:2"]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  assert.equal(state.saved.length, 2, "재확인이 없으면 남은 자리 1에 2건이 저장된다(초과)");
});

test("③ 정원 초과 거부 문구는 원장이 다음 행동을 알 수 있어야 한다", () => {
  assert.match(MAKEUP_CAPACITY_FULL_MESSAGE, /정원이 찼습니다/);
  assert.match(MAKEUP_CAPACITY_FULL_MESSAGE, /다른 날짜나 반/);
  assert.match(adminActions, /throw new Error\(MAKEUP_CAPACITY_FULL_MESSAGE\)/);
});

test("③ 결석 신고 → 보강 지정 경로도 같은 검증을 통과한다", () => {
  const absenceAdmin = readFileSync(
    new URL("../src/app/actions/regular-absence-admin.ts", import.meta.url),
    "utf8",
  );
  // 이 경로는 bookMakeupSession 을 재사용하므로 정원 검증이 함께 적용된다.
  assert.match(absenceAdmin, /await bookMakeupSession\(\{/);
  // 기존 중복 방지(같은 학생·원래반·결석일)는 그대로 유지되어야 한다.
  assert.match(absenceAdmin, /이미 지정된 보강이 있습니다/);
});

test("③ 수강 인원 판정은 출결 화면과 같은 기준(ACTIVE + 통합 학생 제외)", () => {
  // 조회와 저장 검증이 같은 기준을 써야 화면·저장이 어긋나지 않는다.
  for (const source of [queries, adminActions]) {
    assert.match(source, /WHERE e\."classId" = c\.id AND e\.status = 'ACTIVE'/);
  }
  assert.match(adminActions, /JOIN "Student" s ON s\.id = e\."studentId" AND \$\{notMergedStudent\("s"\)\}/);
});
