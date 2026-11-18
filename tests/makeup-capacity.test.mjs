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
  // 2026-11-17: 운영 빌드는 서버 액션이 던진 오류 문구를 가린다 → 정원 초과·이월 정산 충돌은
  // 던지지 않고 { ok: false, message } 로 돌려준다(실제 동작은 아래 «실제로 돌린다» 테스트가 지킨다).
  const body = bookMakeupBody();
  const txAt = body.indexOf("prisma.$transaction(");
  const refusalReturn = "if (refusal) return { ok: false, message: refusal };";
  const preReturnAt = body.indexOf(refusalReturn);
  const txReturnAt = body.indexOf(refusalReturn, txAt);
  const genericAt = body.indexOf('throw new Error("보강 예약 실패")');
  assert.ok(preReturnAt > 0 && preReturnAt < txAt, "미리 확인에서 걸린 사유도 결과로 돌려줘야 한다");
  assert.ok(txReturnAt > txAt, "잠금 뒤 재확인에서 걸린 사유도 결과로 돌려줘야 한다");
  assert.ok(txReturnAt < genericAt, "«보강 예약 실패»로 바꾸기 전에 사유를 돌려줘야 한다");
  // 사유 판정: 정원 문구와 이월 정산 충돌 둘뿐 — 그 밖의 오류는 사유로 새지 않는다
  const helperStart = adminActions.indexOf("function expectedMakeupRefusal");
  const helper = adminActions.slice(helperStart, adminActions.indexOf("export async function bookMakeupSession"));
  assert.ok(helperStart > 0);
  assert.match(helper, /if \(e instanceof CompensationConflict\) return e\.message;/);
  assert.match(helper, /e\.message === MAKEUP_CAPACITY_FULL_MESSAGE\) return e\.message;/);
  assert.equal((helper.match(/return /g) ?? []).length, 3, "사유 2가지 + null 뿐이어야 한다");
  // 예상한 사유를 다시 던지는 코드는 남아 있지 않다(던지면 운영에서 문구가 가려진다)
  assert.doesNotMatch(body, /CompensationConflict\) throw e;|MAKEUP_CAPACITY_FULL_MESSAGE\) throw e;/);
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
// 선택 인자(2026-11-17 «사유를 결과로» 테스트용 — 기본값은 예전 동작 그대로):
//  · preCheckWaitFor: 미리 확인이 몇 건 모이면 함께 답할지(동시 예약 2건 경쟁 = 2, 혼자 예약 = 1)
//  · carried: true 면 그 결석이 이월로 정산돼 있다(이월 정산 표가 있고 그 결석 줄이 나온다)
//  · classMissing: true 면 보강 반이 없다 / insertError: 주면 INSERT 가 그 오류로 실패한다(예상 밖 오류)
function fakeMakeupDb({ capacity, enrolled, preCheckWaitFor = 2, carried = false, classMissing = false, insertError = null }) {
  const state = {
    saved: [],            // 커밋된 보강
    preCheckCounts: [],   // 미리 확인(트랜잭션 밖)이 돌려받은 보강 수
    recheckCounts: [],    // 잠금 뒤 재확인(트랜잭션 안)이 돌려받은 보강 수
    events: [],           // 잠금·커밋·되돌림 순서
    lockHolders: 0,
    maxLockHolders: 0,    // 동시에 잠금을 쥔 트랜잭션 수의 최댓값(1 이어야 한 줄)
    waitedForLock: 0,     // 남이 잠금을 쥐고 있어 기다린 트랜잭션 수
    insertAttempts: 0,    // INSERT 가 DB 로 나간 횟수(커밋 여부와 무관)
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
      if (/FROM "Class" c/.test(sql)) return classMissing ? [] : [{ capacity, enrolled }];
      if (/FROM "MakeupSession" ms/.test(sql)) {
        if (!tx) {
          if (++preCheckArrived === preCheckWaitFor) openPreCheckGate();
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
      if (/to_regclass/.test(sql)) return [{ found: carried ? "BillingAbsenceResolution" : null }]; // 표 없음 → 이월 충돌 검사는 통과
      if (carried && /JOIN "BillingAbsenceResolution" r/.test(sql)) return [{ id: "absence-carried" }]; // 이월로 정산한 결석
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
        state.insertAttempts++;
        if (insertError) throw insertError;
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
// admin.ts 를 가짜 DB 로 불러 «학생 한 명 예약» 함수를 돌려준다.
// revalidated = 성공 뒤 캐시 무효화(revalidatePath)가 불린 경로 — 거절됐을 때는 불리지 않아야 한다.
function loadBooking(prisma, mutate = null) {
  const revalidated = [];
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
    "next/cache": { revalidatePath(path) { revalidated.push(path); }, revalidateTag() {} },
  }, mutate);
  const book = (studentId) => admin.bookMakeupSession({
    studentId,
    originalClassId: "class-original",
    originalDate: "2026-11-10",
    makeupClassId: "class-makeup",
    makeupDate: "2026-11-20",
  });
  return { book, revalidated };
}

async function raceTwoBookings(mutate = null) {
  const { prisma, state } = fakeMakeupDb({ capacity: 10, enrolled: 9 });
  const { book } = loadBooking(prisma, mutate);
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

  // 결과: 성공 1 · 거절 1, 거절은 원장이 보는 정원 문구 그대로.
  // 2026-11-17: 거절은 던지지 않고 { ok: false, message } 로 돌아온다(던지면 운영 빌드가 문구를 가린다).
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], "정원 초과는 던져지지 않고 결과로 돌아와야 한다");
  const values = results.map((r) => r.value);
  const accepted = values.filter((v) => v?.ok === true);
  const refused = values.filter((v) => v?.ok === false);
  assert.equal(accepted.length, 1, "한 건만 성공해야 한다");
  assert.equal(refused.length, 1, "한 건은 거절돼야 한다");
  assert.deepEqual(accepted[0], { ok: true });
  assert.deepEqual(refused[0], { ok: false, message: MAKEUP_CAPACITY_FULL_MESSAGE });
  // 저장된 보강은 정확히 1건(정원 10 = 수강 9 + 보강 1) — 진 쪽은 INSERT 조차 나가지 않았다
  assert.equal(state.saved.length, 1, "남은 자리 1에 보강이 1건만 저장돼야 한다");
  assert.equal(state.insertAttempts, 1, "거절된 예약은 INSERT 를 보내지 않는다");
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
  assert.deepEqual(results.map((r) => r.value), [{ ok: true }, { ok: true }], "사본에서는 둘 다 «성공»으로 돌아온다");
  assert.equal(state.saved.length, 2, "재확인이 없으면 남은 자리 1에 2건이 저장된다(초과)");
});

// ── 사유는 결과로, 예상 밖 오류는 던진다(2026-11-17) ─────────────────────────────
// 왜: 운영 빌드는 서버 액션이 던진 오류 문구를 가린다(화면에는 영어 일반 문구만 간다).
// 원장이 예상할 수 있는 두 사유(정원 초과·이월로 정산한 결석)는 { ok: false, message } 로 돌려준다.

test("사유 — 이미 가득 찬 반은 «미리 확인»에서 던지지 않고 정원 문구를 결과로 돌려준다(저장·캐시 무효화 없음)", { timeout: 20000 }, async () => {
  const { prisma, state } = fakeMakeupDb({ capacity: 10, enrolled: 10, preCheckWaitFor: 1 });
  const { book, revalidated } = loadBooking(prisma);
  assert.deepEqual(await book("student-1"), { ok: false, message: MAKEUP_CAPACITY_FULL_MESSAGE });
  assert.deepEqual(state.events, [], "미리 확인에서 걸리면 트랜잭션(잠금)까지 가지 않는다");
  assert.equal(state.insertAttempts, 0);
  assert.equal(state.saved.length, 0);
  assert.deepEqual(revalidated, [], "거절이면 화면 캐시를 건드리지 않는다");
});

test("사유 — 이월로 정산한 결석은 던지지 않고 그 안내 문구를 결과로 돌려준다(저장 없음)", { timeout: 20000 }, async () => {
  const { prisma, state } = fakeMakeupDb({ capacity: 10, enrolled: 5, preCheckWaitFor: 1, carried: true });
  const { book, revalidated } = loadBooking(prisma);
  const result = await book("student-1");
  assert.equal(result.ok, false);
  assert.equal(result.message, "이월로 정산한 결석입니다. 청구·이월 내역을 먼저 확인해 주세요.");
  assert.deepEqual(state.events, ["잠금:1", "되돌림:1"], "잠금 뒤 검사에서 걸려 트랜잭션이 되돌려진다");
  assert.equal(state.insertAttempts, 0, "이월 정산 결석이면 INSERT 가 나가지 않는다");
  assert.equal(state.saved.length, 0);
  assert.deepEqual(revalidated, []);
});

test("사유 — 성공하면 { ok: true } 를 돌려주고 보강 화면 캐시를 무효화한다", { timeout: 20000 }, async () => {
  const { prisma, state } = fakeMakeupDb({ capacity: 10, enrolled: 5, preCheckWaitFor: 1 });
  const { book, revalidated } = loadBooking(prisma);
  assert.deepEqual(await book("student-1"), { ok: true });
  assert.deepEqual(state.events, ["잠금:1", "커밋:1"]);
  assert.equal(state.saved.length, 1);
  assert.ok(revalidated.includes("/admin/makeup"));
});

test("예상 밖 오류 — 저장(INSERT)이 실패하면 지금처럼 «보강 예약 실패»를 던진다(성공·사유로 둔갑하지 않는다)", { timeout: 20000 }, async () => {
  const { prisma, state } = fakeMakeupDb({
    capacity: 10, enrolled: 5, preCheckWaitFor: 1, insertError: new Error("connection terminated unexpectedly"),
  });
  const { book, revalidated } = loadBooking(prisma);
  const consoleError = console.error;
  console.error = () => {}; // 액션이 원문을 console 에 남긴다 — 테스트 출력만 조용히
  try {
    await assert.rejects(book("student-1"), (error) => error.message === "보강 예약 실패");
  } finally {
    console.error = consoleError;
  }
  assert.deepEqual(state.events, ["잠금:1", "되돌림:1"]);
  assert.equal(state.saved.length, 0);
  assert.deepEqual(revalidated, []);
});

test("예상 밖 오류 — 보강 반이 없으면 «미리 확인»이 지금처럼 던진다", { timeout: 20000 }, async () => {
  const { prisma, state } = fakeMakeupDb({ capacity: 10, enrolled: 5, preCheckWaitFor: 1, classMissing: true });
  const { book } = loadBooking(prisma);
  await assert.rejects(book("student-1"), (error) => error.message === "보강 반을 찾을 수 없습니다.");
  assert.equal(state.insertAttempts, 0);
});

// 결석 화면의 «보강 지정» 액션(scheduleMakeupForAbsence)을 실제로 돌린다 — bookMakeupSession 만 대역.
function loadScheduleForAbsence(bookMakeupSession) {
  const revalidated = [];
  const booked = [];
  const prisma = {
    $queryRawUnsafe: async (sql) => {
      if (/FROM "RegularAbsence" ra/.test(sql)) return [{ studentId: "student-1", classId: "class-original", date: "2026-11-10" }];
      if (/FROM "MakeupSession"/.test(sql)) return []; // 이미 지정된 보강 없음
      throw new Error(`가짜 DB 가 모르는 조회: ${sql.slice(0, 80)}`);
    },
  };
  const actions = load("src/app/actions/regular-absence-admin.ts", {
    "@/lib/prisma": { prisma },
    "@/lib/auth-guard": { requireAdmin: async () => ({ appUserId: "admin" }) },
    "@/app/actions/admin": {
      bookMakeupSession: async (data) => { booked.push(data); return bookMakeupSession(data); },
    },
    "next/cache": { revalidatePath(path) { revalidated.push(path); } },
  });
  const schedule = () => actions.scheduleMakeupForAbsence({
    absenceId: "absence-1", makeupClassId: "class-makeup", makeupDate: "2026-11-20",
  });
  return { schedule, revalidated, booked };
}

test("결석 → 보강 지정 — 예약이 사유로 거절되면 그 문구를 그대로 돌려주고 화면 캐시는 건드리지 않는다", async () => {
  for (const message of [MAKEUP_CAPACITY_FULL_MESSAGE, "이월로 정산한 결석입니다. 청구·이월 내역을 먼저 확인해 주세요."]) {
    const { schedule, revalidated, booked } = loadScheduleForAbsence(async () => ({ ok: false, message }));
    assert.deepEqual(await schedule(), { ok: false, message });
    assert.equal(booked.length, 1);
    assert.deepEqual(revalidated, [], "거절인데 성공처럼 새로고침하면 안 된다");
  }
});

test("결석 → 보강 지정 — 예약이 성공하면 { ok: true } 와 캐시 무효화, 예약이 던지면 그대로 던진다", async () => {
  const success = loadScheduleForAbsence(async () => ({ ok: true }));
  assert.deepEqual(await success.schedule(), { ok: true });
  assert.deepEqual(success.booked, [{
    studentId: "student-1", originalClassId: "class-original", originalDate: "2026-11-10",
    makeupClassId: "class-makeup", makeupDate: "2026-11-20",
  }]);
  assert.deepEqual(success.revalidated, ["/admin/absence"]);

  const broken = loadScheduleForAbsence(async () => { throw new Error("보강 예약 실패"); });
  await assert.rejects(broken.schedule(), (error) => error.message === "보강 예약 실패");
  assert.deepEqual(broken.revalidated, []);
});

// 화면 두 곳 — 결과의 문구를 보이고, 거절이면 성공 흐름(닫기·새로고침)으로 가지 않는다.
function sliceBetween(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} 구간을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

test("보강 화면 — 예약 결과가 거절이면 서버가 준 문구를 보이고 멈춘다(성공 흐름·예상 밖 오류 안내는 그대로)", () => {
  const fn = sliceBetween(makeupClient, "async function handleBook()", "return (");
  const callAt = fn.indexOf("const result = await bookMakeupSession({");
  const refusedAt = fn.indexOf("if (!result.ok) {");
  const noticeAt = fn.indexOf("showNotice(result.message);");
  const stopAt = fn.indexOf("return;", noticeAt);
  const successAt = fn.indexOf("await onSuccess();");
  assert.ok(callAt > 0, "예약 결과를 받아야 한다(버리면 거절이 성공으로 처리된다)");
  assert.ok(callAt < refusedAt && refusedAt < noticeAt && noticeAt < stopAt && stopAt < successAt,
    "결과 확인 → 문구 표시 → 멈춤 → (성공일 때만) onSuccess 순서여야 한다");
  assert.equal(fn.split("await onSuccess();").length, 2, "성공 처리는 한 곳뿐");
  // 예상 밖 오류(던져진 것)는 예전처럼 대체 문구, 버튼 잠금은 어느 길이든 풀린다
  assert.match(fn, /catch \(e: any\) \{\s*showNotice\(adminErrorText\(e, "보강 예약 실패"\)\);\s*\} finally \{\s*setBusy\(false\);/);
});

test("결석 화면 — 보강 지정 결과가 거절이면 서버가 준 문구를 보이고 창을 닫지 않는다(성공 흐름은 그대로)", () => {
  const absenceClient = readFileSync(
    new URL("../src/app/admin/absence/RegularAbsenceAdminClient.tsx", import.meta.url),
    "utf8",
  );
  const fn = sliceBetween(absenceClient, "const submitMakeup = useCallback(", "// 보강 취소.");
  const callAt = fn.indexOf("const result = await scheduleMakeupForAbsence({ absenceId, makeupClassId, makeupDate });");
  const refusedAt = fn.indexOf("if (!result.ok) {");
  const errAt = fn.indexOf("setErr(result.message);");
  const stopAt = fn.indexOf("return;", errAt);
  const closeAt = fn.indexOf('setMakeupOpenId((cur) => (cur === absenceId ? "" : cur));');
  const reloadAt = fn.indexOf("await reload(classId);");
  assert.ok(callAt > 0, "보강 지정 결과를 받아야 한다(버리면 거절이 성공으로 처리된다)");
  assert.ok(callAt < refusedAt && refusedAt < errAt && errAt < stopAt && stopAt < closeAt && closeAt < reloadAt,
    "결과 확인 → 문구 표시 → 멈춤 → (성공일 때만) 창 닫기 → 새로고침 순서여야 한다");
  assert.match(fn, /\} finally \{\s*setBusyId\(""\);/,"버튼 잠금은 어느 길이든 풀린다");
  // 그 문구가 보이는 자리: 보강 지정 창 안의 알림 줄
  assert.match(absenceClient, /\{err && \(\s*<p role="alert"[^>]*>\{err\}<\/p>/);
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
