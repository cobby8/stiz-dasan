import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 3년 재원 유니폼 무료 증정 — 규칙은 순수 함수로, 신청 처리는 가짜 DB 로 «실제로 돌려» 확인한다
const rules = await loadTsModule("src/lib/uniform-free-grant-rules.ts");
const service = await loadTsModule("src/lib/uniform-free-grant.ts");

const NOW = Date.parse("2026-11-05T03:00:00Z");
const FUTURE = new Date(NOW + 7 * 86400_000);
const PAST = new Date(NOW - 1000);

// ─── 순수 규칙 ──────────────────────────────────────────────────────────────

test("토큰은 24바이트 base64url(32글자)만 받는다", () => {
  const token = service.generateUniformFreeToken();
  assert.equal(token.length, 32);
  assert.ok(rules.isWellFormedGrantToken(token));
  assert.notEqual(service.generateUniformFreeToken(), token); // 매번 다르다
  for (const bad of ["", "short", `${token}x`, `${token.slice(0, 31)}=`, "../../etc/passwd", null, 123]) {
    assert.equal(rules.isWellFormedGrantToken(bad), false, String(bad));
  }
});

test("상태 판정: ISSUED·미만료만 사용 가능, 이미 신청한 링크는 만료 뒤에도 «이미 신청»", () => {
  assert.deepEqual(rules.evaluateFreeGrant({ status: "ISSUED", expiresAt: FUTURE }, NOW), { usable: true });
  assert.deepEqual(rules.evaluateFreeGrant(null, NOW), { usable: false, reason: "NOT_FOUND" });
  assert.deepEqual(rules.evaluateFreeGrant({ status: "USED", expiresAt: PAST }, NOW), { usable: false, reason: "USED" });
  assert.deepEqual(rules.evaluateFreeGrant({ status: "REVOKED", expiresAt: FUTURE }, NOW), { usable: false, reason: "REVOKED" });
  assert.deepEqual(rules.evaluateFreeGrant({ status: "ISSUED", expiresAt: PAST }, NOW), { usable: false, reason: "EXPIRED" });
  // 만료 시각 «정각» 은 이미 만료
  assert.deepEqual(rules.evaluateFreeGrant({ status: "ISSUED", expiresAt: new Date(NOW) }, NOW), { usable: false, reason: "EXPIRED" });
  // 만료 시각이 없거나 깨졌으면 안전하게 거절
  assert.equal(rules.evaluateFreeGrant({ status: "ISSUED", expiresAt: null }, NOW).usable, false);
  assert.equal(rules.evaluateFreeGrant({ status: "ISSUED", expiresAt: "nope" }, NOW).usable, false);
  assert.equal(rules.evaluateFreeGrant({ status: "WEIRD", expiresAt: FUTURE }, NOW).reason, "NOT_FOUND");
});

test("무료 주문 메모 표시와 판정", () => {
  assert.equal(rules.buildFreeUniformMemo(""), "[3년 재원 무료 증정]");
  assert.equal(rules.buildFreeUniformMemo("  사이즈 상담  "), "[3년 재원 무료 증정] 사이즈 상담");
  assert.ok(rules.isFreeUniformOrderMemo(rules.buildFreeUniformMemo("x")));
  assert.equal(rules.isFreeUniformOrderMemo("일반 주문"), false);
  assert.equal(rules.isFreeUniformOrderMemo(null), false);
});

// ─── 가짜 DB: 행 잠금(FOR UPDATE)·커밋/롤백을 흉내 낸다 ─────────────────────

function createFakeDb(grants) {
  const state = { grants: new Map(grants.map((g) => [g.token, { ...g }])), orders: [], items: [] };
  const locks = new Map(); // token → Promise(잠금 해제 시 resolve)

  async function runTransaction(fn) {
    const writes = []; // 커밋 전까지 모아 두었다가 성공하면 반영
    const held = [];
    const tx = {
      async $queryRawUnsafe(sql, ...values) {
        if (/FOR UPDATE/.test(sql)) {
          const token = values[0];
          // 다른 트랜잭션이 잡고 있으면 끝날 때까지 기다린다(실제 DB 와 같은 동작)
          while (locks.has(token)) await locks.get(token);
          let release;
          locks.set(token, new Promise((resolve) => { release = resolve; }));
          held.push(() => { locks.delete(token); release(); });
          const g = state.grants.get(token);
          return g ? [{ id: g.id, status: g.status, expiresAt: g.expiresAt, student_name: g.studentName }] : [];
        }
        if (/AS guardian_phone/.test(sql) && /WHERE g\.id = \$1/.test(sql)) {
          const g = [...state.grants.values()].find((x) => x.id === values[0]);
          return g ? [{ guardian_phone: g.storedPhone ?? null, parent_phone: null }] : [];
        }
        throw new Error(`예상하지 못한 조회: ${sql}`);
      },
      async $executeRawUnsafe(sql, ...values) {
        if (/INSERT INTO "UniformOrder"\s/.test(sql)) {
          const [id, partnerRequestId, parentName, parentPhone, parentPhoneDigits, customerMemo, itemSignature, stizSyncStatus, stizMessage] = values;
          writes.push(() => state.orders.push({ id, partnerRequestId, parentName, parentPhone, parentPhoneDigits, customerMemo, itemSignature, stizSyncStatus, stizMessage }));
          return 1;
        }
        if (/INSERT INTO "UniformOrderItem"/.test(sql)) {
          const [id, uniformOrderId, studentName, design, initials, backNumber, topSize, bottomSize, quantity] = values;
          writes.push(() => state.items.push({ id, uniformOrderId, studentName, design, initials, backNumber, topSize, bottomSize, quantity }));
          return 1;
        }
        if (/UPDATE "UniformFreeGrant"/.test(sql)) {
          const [grantId, orderId] = values;
          const g = [...state.grants.values()].find((x) => x.id === grantId);
          if (!g || g.status !== "ISSUED") return 0;
          writes.push(() => Object.assign(g, { status: "USED", usedAt: new Date(), uniformOrderId: orderId }));
          return 1;
        }
        throw new Error(`예상하지 못한 쓰기: ${sql}`);
      },
    };
    try {
      const result = await fn(tx);
      writes.forEach((w) => w()); // 커밋
      return result;
    } finally {
      held.forEach((r) => r()); // 성공·실패 모두 잠금 해제(실패면 writes 는 버려진다 = 롤백)
    }
  }

  return { state, runTransaction };
}

const TOKEN = "A".repeat(16) + "b_-9".repeat(4);
const VALID_INPUT = {
  parentName: "김학부모",
  parentPhone: "01012345678",
  design: "DYG 블랙&화이트",
  initials: "GENO",
  backNumber: "7",
  topSize: "S(160)",
  bottomSize: "M",
  memo: "감사합니다",
  agreedPrivacy: true,
};

function issuedGrant(overrides = {}) {
  return { id: "grant-1", token: TOKEN, status: "ISSUED", expiresAt: new Date(Date.now() + 86400_000), studentName: "김아이", ...overrides };
}

// 본사 발송은 fetch 로 나간다 — 호출 횟수를 센다. 키도 «정상» 으로 넣어 두어, 만약 dispatch 가 불리면 실제로 fetch 까지 간다
function watchFetch(t) {
  const calls = [];
  const original = globalThis.fetch;
  const originalSecret = process.env.STIZ_PARTNER_SECRET;
  process.env.STIZ_PARTNER_SECRET = "a".repeat(64);
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error("본사 발송이 호출되면 안 된다"); };
  t.after(() => {
    globalThis.fetch = original;
    if (originalSecret === undefined) delete process.env.STIZ_PARTNER_SECRET;
    else process.env.STIZ_PARTNER_SECRET = originalSecret;
  });
  return calls;
}

test("무료 신청: 주문은 NEEDS_REVIEW 로 저장되고 본사 발송(fetch)은 한 번도 일어나지 않는다", async (t) => {
  const fetchCalls = watchFetch(t);
  const db = createFakeDb([issuedGrant()]);
  const result = await db.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, TOKEN, VALID_INPUT));

  assert.equal(result.ok, true);
  assert.equal(fetchCalls.length, 0);
  assert.equal(db.state.orders.length, 1);
  const order = db.state.orders[0];
  assert.equal(order.stizSyncStatus, "NEEDS_REVIEW");
  assert.equal(order.stizMessage, "무료 증정: 원장 확인 후 본사 발송");
  assert.equal(order.partnerRequestId, `dasan-uniform-${order.id}`);
  assert.ok(order.customerMemo.startsWith("[3년 재원 무료 증정]"));
  assert.equal(order.parentPhone, "010-1234-5678");

  const [item] = db.state.items;
  assert.equal(item.uniformOrderId, order.id);
  assert.equal(item.studentName, "김아이"); // 링크의 학생 이름 고정
  assert.equal(item.quantity, 2); // 상의 S(160) + 하의 M — 일반 주문과 같은 수량 규칙
  assert.equal(item.topSize, "S(160)");

  const grant = db.state.grants.get(TOKEN);
  assert.equal(grant.status, "USED");
  assert.equal(grant.uniformOrderId, order.id);
  assert.ok(grant.usedAt instanceof Date);
});

test("무료 주문 상태(NEEDS_REVIEW)는 크론 자동 발송 대상(PENDING·RETRY_WAIT)이 아니다", () => {
  // 크론이 집어 가는 상태 목록을 실제 소스에서 꺼내 비교(목록이 바뀌면 이 테스트가 알려 준다)
  const source = readFileSync("src/lib/uniform-order-service.ts", "utf8");
  const block = source.slice(source.indexOf("export async function dispatchDueUniformOrders"));
  const list = JSON.parse(block.match(/stizSyncStatus:\s*\{\s*in:\s*(\[[^\]]*\])/)[1]);
  assert.deepEqual(list, ["PENDING", "RETRY_WAIT"]);
  assert.equal(list.includes(rules.FREE_UNIFORM_SYNC_STATUS), false);
});

test("무료 신청 경로는 본사 발송 모듈을 import 하지 않는다", () => {
  for (const file of ["src/lib/uniform-free-grant.ts", "src/app/actions/uniform-free.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.equal(/from\s+["']@\/lib\/uniform-order-service["']/.test(source), false, file);
    assert.equal(/dispatchUniformOrderById\s*\(/.test(source), false, file);
  }
});

test("같은 링크로 두 번 제출하면 두 번째는 «이미 신청» 으로 거절, 주문은 1건", async (t) => {
  watchFetch(t);
  const db = createFakeDb([issuedGrant()]);
  const first = await db.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, TOKEN, VALID_INPUT));
  const second = await db.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, TOKEN, VALID_INPUT));
  assert.equal(first.ok, true);
  assert.deepEqual({ ok: second.ok, reason: second.reason }, { ok: false, reason: "USED" });
  assert.equal(db.state.orders.length, 1);
});

test("동시에 5번 제출해도(잠금 대기) 주문은 1건만 만들어진다", async (t) => {
  watchFetch(t);
  const db = createFakeDb([issuedGrant()]);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => db.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, TOKEN, VALID_INPUT))),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.reason === "USED").length, 4);
  assert.equal(db.state.orders.length, 1);
  assert.equal(db.state.items.length, 1);
});

test("만료·취소·없는 링크는 아무것도 쓰지 않는다", async (t) => {
  watchFetch(t);
  for (const [grants, token, reason] of [
    [[issuedGrant({ expiresAt: new Date(Date.now() - 1000) })], TOKEN, "EXPIRED"],
    [[issuedGrant({ status: "REVOKED" })], TOKEN, "REVOKED"],
    [[], TOKEN, "NOT_FOUND"],
    [[issuedGrant()], "not-a-token", "NOT_FOUND"],
  ]) {
    const db = createFakeDb(grants);
    const result = await db.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, token, VALID_INPUT));
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(db.state.orders.length, 0);
  }
});

test("입력이 틀리면 잠그기 전에 거절하고 링크는 그대로 ISSUED", async (t) => {
  watchFetch(t);
  for (const patch of [
    { design: "" },
    { design: "없는 디자인" },
    { initials: "  " },
    { topSize: "", bottomSize: "" },
    { topSize: "XXXXL" },
    { backNumber: "12a" },
    { parentPhone: "0101" },
    { parentName: " " },
    { agreedPrivacy: false },
  ]) {
    const db = createFakeDb([issuedGrant()]);
    const result = await db.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, TOKEN, { ...VALID_INPUT, ...patch }));
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.reason, "INVALID");
    assert.ok(result.message.length > 0);
    assert.equal(db.state.grants.get(TOKEN).status, "ISSUED");
    assert.equal(db.state.orders.length, 0);
  }
});

test("링크 상태를 USED 로 못 바꾸면 롤백되어 주문이 남지 않는다", async (t) => {
  watchFetch(t);
  const db = createFakeDb([issuedGrant()]);
  // 잠금 뒤 다른 경로가 상태를 바꾼 상황을 흉내: UPDATE 가 0건
  const result = db.runTransaction(async (tx) => {
    const wrapped = { ...tx, $executeRawUnsafe: async (sql, ...v) => (/UPDATE "UniformFreeGrant"/.test(sql) ? 0 : tx.$executeRawUnsafe(sql, ...v)) };
    return service.submitFreeUniformOrderInTx(wrapped, TOKEN, VALID_INPUT);
  });
  await assert.rejects(result);
  assert.equal(db.state.orders.length, 0);
  assert.equal(db.state.items.length, 0);
});

test("발급 함수: 토큰을 만들어 INSERT 하고, 잘못된 값은 거절", async () => {
  const calls = [];
  const tx = { async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return [{ id: "g1", token: values[1] }]; } };
  const created = await service.createUniformFreeGrant(tx, { studentId: "s1", tenureMonths: 38, expiresAt: FUTURE });
  assert.ok(rules.isWellFormedGrantToken(created.token));
  assert.match(calls[0].sql, /INSERT INTO "UniformFreeGrant"/);
  assert.deepEqual(calls[0].values.slice(2), ["TENURE_3Y", 38, FUTURE.toISOString()]);
  await assert.rejects(service.createUniformFreeGrant(tx, { studentId: "s1", tenureMonths: -1, expiresAt: FUTURE }));
  await assert.rejects(service.createUniformFreeGrant(tx, { studentId: "s1", tenureMonths: 35, expiresAt: FUTURE })); // 3년 미만
  await assert.rejects(service.createUniformFreeGrant(tx, { studentId: "s1", tenureMonths: 1.5, expiresAt: FUTURE }));
  await assert.rejects(service.createUniformFreeGrant(tx, { studentId: "", tenureMonths: 38, expiresAt: FUTURE }));
  await assert.rejects(service.createUniformFreeGrant(tx, { studentId: "s1", tenureMonths: 38, expiresAt: new Date("x") }));
});

test("화면 조회: 사용 가능하면 학생·보호자 정보, 아니면 안내 문구", async () => {
  const db = (row) => ({ async $queryRawUnsafe() { return row ? [row] : []; } });
  const row = { status: "ISSUED", expiresAt: FUTURE, tenureMonths: 38, student_name: "김아이", guardian_name: null, guardian_phone: null, parent_name: "김학부모", parent_phone: "010-1111-2222" };
  assert.deepEqual(await service.getFreeGrantView(db(row), TOKEN, NOW), {
    state: "USABLE", studentName: "김아이", tenureMonths: 38, parentName: "김학부모", parentPhoneMask: "010-****-2222",
  });
  // 링크가 남에게 넘어가도 전체 번호는 화면으로 내려가지 않는다
  assert.equal(JSON.stringify(await service.getFreeGrantView(db(row), TOKEN, NOW)).includes("1111"), false);
  const withGuardian = await service.getFreeGrantView(db({ ...row, guardian_name: "박보호", guardian_phone: "010-3333-4444" }), TOKEN, NOW);
  assert.equal(withGuardian.parentName, "박보호");
  assert.equal((await service.getFreeGrantView(db({ ...row, status: "USED" }), TOKEN, NOW)).state, "USED");
  assert.equal((await service.getFreeGrantView(db(null), TOKEN, NOW)).state, "NOT_FOUND");
  // 형식이 틀린 토큰은 DB 를 조회하지도 않는다
  const never = { async $queryRawUnsafe() { throw new Error("조회하면 안 된다"); } };
  assert.equal((await service.getFreeGrantView(never, "bad", NOW)).state, "NOT_FOUND");
});

test("휴대폰 칸을 비워 두면 저장된 번호로 주문하고, 저장된 번호도 없으면 다시 입력을 요청한다", async () => {
  const db = createFakeDb([issuedGrant({ storedPhone: "010-5555-6666" })]);
  const ok = await db.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, TOKEN, { ...VALID_INPUT, parentPhone: "" }));
  assert.equal(ok.ok, true);
  assert.equal(db.state.orders[0].parentPhone, "010-5555-6666");

  const none = createFakeDb([issuedGrant({ storedPhone: null })]);
  const bad = await none.runTransaction((tx) => service.submitFreeUniformOrderInTx(tx, TOKEN, { ...VALID_INPUT, parentPhone: "" }));
  assert.equal(bad.ok, false);
  assert.equal(none.state.orders.length, 0);
});
