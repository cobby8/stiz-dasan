import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";
import { createClient } from "@supabase/supabase-js";
const { resolveApprovalParent, listApprovalParentCandidates, reopenEnrollmentForReview, isActiveApprovalAuthUser, approvalAuthFetch } = await loadTsModule("src/lib/enrollment/approval-parent.ts");
test("Auth 조회는 제한 시간 취소와 기존 취소 신호를 보존", async () => {
  const fakeFetch = (_input, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) return reject(init.signal.reason);
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  // AbortSignal.timeout 타이머는 event loop를 붙잡지 않으므로 시험 동안만 유지한다.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(approvalAuthFetch(fakeFetch, 15)("https://example.invalid"), error => error.name === "TimeoutError");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(approvalAuthFetch(fakeFetch)("https://example.invalid", { signal: controller.signal }), error => error.name === "AbortError");
  } finally { clearInterval(keepAlive); }
});
test("실제 Supabase getUserById도 전용 fetch 취소를 오류로 돌려주며 새 연결로 진행하지 않는다", async (t) => {
  t.mock.method(console, "error", () => {}); // SDK의 예상된 취소 오류 로그만 숨긴다.
  const keepAlive = setInterval(() => {}, 1000);
  let calls = 0;
  const client = createClient("https://example.invalid", "synthetic-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: approvalAuthFetch((_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }, 15) },
  });
  try {
    const result = await client.auth.admin.getUserById("00000000-0000-4000-8000-000000000001");
    assert.equal(result.data.user, null);
    assert.ok(result.error);
    assert.equal(calls, 1);
  } finally { clearInterval(keepAlive); }
});
test("정확한 Auth ID이며 삭제·현재차단·잘못된 차단정보가 없는 계정만 허용", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  assert.equal(isActiveApprovalAuthUser({ id: "auth" }, "auth", now), true);
  assert.equal(isActiveApprovalAuthUser({ id: "auth", banned_until: "2026-10-19T00:00:00Z" }, "auth", now), true);
  for (const user of [null, { id: "foreign" }, { id: "auth", deleted_at: "2026-10-19" }, { id: "auth", banned_until: "2026-10-21" }, { id: "auth", banned_until: "invalid" }]) {
    assert.equal(isActiveApprovalAuthUser(user, "auth", now), false);
  }
});
const app = { parentPhone: "010-2345-6789" };
const account = (role = "PARENT", id = "parent", authUserId = null) => ({ id, role, authUserId, name: "합성보호자", phone: "01023456789" });
function reader(users, authIds = users) {
  return { calls: [], async $queryRawUnsafe(sql, ...values) {
    this.calls.push({ sql, values });
    if (sql.includes("pg_advisory")) return [];
    if (sql.includes('WHERE "authUserId"')) return authIds.filter(u => u.authUserId === values[0]).map(u => ({ id: u.id }));
    return users;
  } };
}
test("신규·단일 PARENT 모두 명시 선택하며 기존 명시 연결은 복원", async () => {
  for (const users of [[], [account()]]) {
    for (const missing of [undefined, ""]) {
      await assert.rejects(resolveApprovalParent(reader(users), app, missing, async () => true), /직접 선택/);
    }
  }
  assert.equal(await resolveApprovalParent(reader([]), app, "__NEW__", async () => true), null);
  assert.equal(await resolveApprovalParent(reader([account()]), app, "parent", async () => true), "parent");
  assert.equal(await resolveApprovalParent(reader([account()]), { ...app, parentUserId: "parent" }, undefined, async () => true), "parent");
});
test("신규 명시값도 기존 후보·기존 연결을 덮어쓸 수 없다", async () => {
  await assert.rejects(resolveApprovalParent(reader([account()]), app, "__NEW__", async () => true), /직접 선택/);
  await assert.rejects(resolveApprovalParent(reader([]), { ...app, parentUserId: "parent" }, "__NEW__", async () => true), /다릅니다/);
});
for (const role of ["ADMIN", "VICE_ADMIN", "INSTRUCTOR"]) {
  test(`${role}는 자동선택 금지, 정확 Auth 확인 후 명시 연결`, async () => {
    const db = reader([account(role, "staff", "auth")]);
    await assert.rejects(resolveApprovalParent(db, app, undefined, async () => true), /직접 선택/);
    let seen;
    assert.equal(await resolveApprovalParent(db, app, "staff", async id => { seen = id; return true; }), "staff");
    assert.equal(seen, "auth");
    assert.equal(db.calls.some(c => /^\s*(UPDATE|INSERT)/.test(c.sql)), false);
  });
}
test("동일 전화 복수 PARENT도 첫 행 자동선택 금지", async () => {
  await assert.rejects(resolveApprovalParent(reader([account(), account("PARENT", "other")]), app, undefined, async () => true), /직접 선택/);
});
test("Auth 누락·삭제·중복연결·조회실패·DRIVER는 명시해도 차단", async () => {
  for (const user of [account("ADMIN"), account("DRIVER", "parent", "auth")]) {
    await assert.rejects(resolveApprovalParent(reader([user]), app, user.id, async () => true), /확인할 수 없습니다/);
  }
  const user = account("ADMIN", "parent", "auth");
  await assert.rejects(resolveApprovalParent(reader([user]), app, user.id, async () => false), /확인할 수 없습니다/);
  await assert.rejects(resolveApprovalParent(reader([user], [user, { ...user, id: "duplicate" }]), app, user.id, async () => true));
  await assert.rejects(resolveApprovalParent(reader([user]), app, user.id, async () => { throw new Error("auth unavailable"); }), /auth unavailable/);
});
test("기존 명시 연결 override·사라진 계정·후보 아닌 ID는 신규 fallback 없이 차단", async () => {
  await assert.rejects(resolveApprovalParent(reader([account()]), { ...app, parentUserId: "parent" }, "other", async () => true), /다릅니다/);
  await assert.rejects(resolveApprovalParent(reader([]), { ...app, parentUserId: "missing" }, undefined, async () => true));
  await assert.rejects(resolveApprovalParent(reader([account()]), app, "foreign", async () => true));
});
test("후보는 최소 마스킹만 제공하고 Auth 없는 직원 매치는 별도 차단 표시", async () => {
  const result = await listApprovalParentCandidates(reader([account("ADMIN", "staff", "auth"), account("ADMIN", "legacy")]), app, "staff", async () => true);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0], { id: "staff", name: "합성보호자", role: "ADMIN", phoneLast4: "6789", authLinked: true, isCurrentAccount: true });
  assert.equal(result.hasUnselectableMatches, true);
  assert.doesNotMatch(JSON.stringify(result), /01023456789|authUserId|email/);
});
function writer(status = "REJECTED", convertedStudentId = null, changed = 1) {
  return { calls: [], async $queryRawUnsafe(sql) { this.calls.push({ sql }); return [{ status, convertedStudentId }]; },
    async $executeRawUnsafe(sql, ...values) { this.calls.push({ sql, values }); return changed; } };
}
test("반려 재검토는 잠금+조건부 갱신+동일 tx 이력이며 이전 반려사유 보존", async () => {
  const tx = writer();
  assert.deepEqual(await reopenEnrollmentForReview(tx, "app", "재상담 확인", { id: "admin", name: "관리자" }), { ok: true, status: "PENDING" });
  assert.match(tx.calls[0].sql, /FOR UPDATE/);
  assert.match(tx.calls[1].sql, /status = 'REJECTED' AND "convertedStudentId" IS NULL/);
  assert.doesNotMatch(tx.calls[1].sql, /processedNote|processedAt/);
  assert.match(tx.calls[2].sql, /ApplicationContactLog/);
});
test("재검토 뒤 승인으로 처리 메모를 교체해도 이전 반려 사유·시각은 이력 한 건에 남는다", async () => {
  const application = { status: "REJECTED", convertedStudentId: null, processedNote: "이전 반려 사유", processedAt: new Date("2026-04-03T01:30:00Z") };
  const history = [];
  const tx = {
    async $queryRawUnsafe(sql) {
      assert.match(sql, /"processedNote", "processedAt"/);
      return [{ ...application }];
    },
    async $executeRawUnsafe(sql, ...values) {
      if (sql.includes('UPDATE "EnrollmentApplication"')) application.status = "PENDING";
      else if (sql.includes('INSERT INTO "ApplicationContactLog"')) history.push(values[1]);
      return 1;
    },
  };
  await reopenEnrollmentForReview(tx, "app", "재상담 완료", { id: "admin", name: null });
  assert.equal(application.processedNote, "이전 반려 사유");
  // 실제 승인 액션도 processedNote를 새 승인 메모로 교체한다.
  application.status = "APPROVED";
  application.processedNote = "새 승인 메모";
  assert.equal(history.length, 1);
  assert.match(history[0], /반려 신청 재검토: 재상담 완료/);
  assert.match(history[0], /이전 반려 사유: 이전 반려 사유/);
  assert.match(history[0], /이전 반려 시각: 2026-04-03T01:30:00.000Z/);
});
test("이미 승인/전환/재검토된 신청·경합 0건은 상태나 이력 추가 금지", async () => {
  for (const tx of [writer("APPROVED"), writer("PENDING"), writer("REJECTED", "student")]) {
    await assert.rejects(reopenEnrollmentForReview(tx, "app", "사유", { id: "admin", name: null }));
    assert.equal(tx.calls.length, 1);
  }
  const raced = writer("REJECTED", null, 0);
  await assert.rejects(reopenEnrollmentForReview(raced, "app", "사유", { id: "admin", name: null }), /변경되었습니다/);
  assert.equal(raced.calls.length, 2);
});
test("빈 사유와 과도한 사유는 조회 전 차단", async () => {
  const tx = writer();
  for (const reason of [" ", "a".repeat(501)]) await assert.rejects(reopenEnrollmentForReview(tx, "app", reason, { id: "admin", name: null }));
  assert.equal(tx.calls.length, 0);
});
