import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { confirmTrialFeeOnce, confirmTrialFeeWithAudit, trialFeeStatusLabel } from "../src/lib/trial-fee-confirmation.ts";

function fakeDb(responses) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(query, ...values) {
      calls.push({ query, values });
      return responses.shift() ?? [];
    },
  };
}

test("미확인 체험비는 조건부 UPDATE 한 번으로 확인되고 추가 조회하지 않는다", async () => {
  const db = fakeDb([[{ id: "trial-1" }]]);
  const result = await confirmTrialFeeOnce(db, "trial-1");

  assert.deepEqual(result, { found: true, changed: true, alreadyConfirmed: false });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].query, /COALESCE\("trialFeeConfirmed", false\) = false/);
  assert.match(db.calls[0].query, /RETURNING id/);
});

test("이미 확인된 체험비 재요청은 changed=false로 멱등 처리한다", async () => {
  const db = fakeDb([[], [{ trialFeeConfirmed: true }]]);
  const result = await confirmTrialFeeOnce(db, "trial-1");

  assert.deepEqual(result, { found: true, changed: false, alreadyConfirmed: true });
  assert.equal(db.calls.length, 2);
});

test("존재하지 않는 신청 ID는 안전한 결과로 구분한다", async () => {
  const db = fakeDb([[], []]);
  const result = await confirmTrialFeeOnce(db, "missing");

  assert.deepEqual(result, { found: false, changed: false, alreadyConfirmed: false });
});

test("서버 action은 최초 변경일 때만 이력과 캐시 갱신을 수행한다", () => {
  const source = readFileSync("src/app/actions/admin.ts", "utf8");
  const action = source.slice(
    source.indexOf("export async function confirmTrialFeePayment"),
    source.indexOf("export async function updateTrialLead"),
  );
  assert.match(action, /const result = await confirmTrialFeeWithAudit\(prisma, id/);
  assert.match(action, /if \(!result\.found\) return result/);
  assert.doesNotMatch(action, /recordApplicationHistoryLog/);
});

function transactionalFeeDb({ failAudit = false } = {}) {
  const state = { confirmed: false, auditCount: 0 };
  return {
    state,
    async $transaction(callback) {
      const snapshot = { ...state };
      const tx = {
        async $queryRawUnsafe(query) {
          if (query.includes('UPDATE "TrialLead"')) {
            if (state.confirmed) return [];
            state.confirmed = true;
            return [{ id: "trial-1" }];
          }
          return state.confirmed ? [{ trialFeeConfirmed: true }] : [];
        },
        async $executeRawUnsafe() {
          if (failAudit) throw new Error("audit failed");
          state.auditCount += 1;
          return 1;
        },
      };
      try { return await callback(tx); }
      catch (error) { Object.assign(state, snapshot); throw error; }
    },
  };
}

test("동시 입금확인 요청도 값 변경과 감사 이력은 한 번뿐이다", async () => {
  const db = transactionalFeeDb();
  const actor = { userId: "admin-1", userName: "관리자" };
  const results = await Promise.all([
    confirmTrialFeeWithAudit(db, "trial-1", actor),
    confirmTrialFeeWithAudit(db, "trial-1", actor),
  ]);
  assert.equal(results.filter((item) => item.changed).length, 1);
  assert.equal(db.state.auditCount, 1);
});

test("감사 이력 저장 실패 시 입금확인 변경도 rollback된다", async () => {
  const db = transactionalFeeDb({ failAudit: true });
  await assert.rejects(
    confirmTrialFeeWithAudit(db, "trial-1", { userId: "admin-1", userName: "관리자" }),
    /audit failed/,
  );
  assert.deepEqual(db.state, { confirmed: false, auditCount: 0 });
});

// ── 2026-10-09 회귀 방지: 학부모 「비용·계좌 확인」 체크 ≠ 학원의 입금 확인 ──────────────
// 신청서 체크가 trialFeeConfirmed=true 로 저장돼 웹 신청이 전부 「입금 완료」로 보였다.

test("체험비 상태 문구: 관리자 확인 전에는 학부모가 동의했어도 입금 대기다", () => {
  assert.equal(trialFeeStatusLabel({ trialFeeConfirmed: false, trialFeeNoticeAgreedAt: "2026-10-09T01:00:00Z" }), "입금 대기(학부모 동의함)");
  assert.equal(trialFeeStatusLabel({ trialFeeConfirmed: false, trialFeeNoticeAgreedAt: null }), "입금 대기");
  assert.equal(trialFeeStatusLabel({ trialFeeConfirmed: null }), "입금 대기");
  assert.equal(trialFeeStatusLabel({ trialFeeConfirmed: true, trialFeeNoticeAgreedAt: null }), "입금 완료");
  assert.equal(trialFeeStatusLabel({ trialFeeConfirmed: true, trialFeeNoticeAgreedAt: new Date() }), "입금 완료");
});

test("공개 체험 신청은 학부모 동의를 동의 시각에만 남기고 입금 확인은 false 로 시작한다", () => {
  const source = readFileSync("src/app/actions/public.ts", "utf8");
  const fn = source.slice(source.indexOf("export async function submitTrialApplication"));
  const update = fn.slice(fn.indexOf('UPDATE "TrialLead" SET'), fn.indexOf("WHERE id = $19"));
  const insert = fn.slice(fn.indexOf('INSERT INTO "TrialLead"'), fn.indexOf("RETURNING id"));
  assert.ok(update.length > 0 && insert.length > 0, "UPDATE/INSERT 구간을 찾지 못했다");

  // 재제출(UPDATE)은 입금 확인 칸을 아예 건드리지 않고, 동의 시각은 처음 값을 유지한다
  assert.doesNotMatch(update, /"trialFeeConfirmed"\s*=/);
  assert.match(update, /"trialFeeNoticeAgreedAt" = COALESCE\("trialFeeNoticeAgreedAt", NOW\(\)\)/);
  // 신규(INSERT)는 입금 확인 false 고정 + 동의 시각 NOW()
  assert.match(insert, /"trialFeeConfirmed", "trialFeeNoticeAgreedAt"/);
  assert.match(insert, /\$17, false, NOW\(\)/);
  // 학부모가 보낸 값이 입금 확인 칸으로 흘러가는 바인딩이 다시 생기면 안 된다
  assert.doesNotMatch(fn, /data\.trialFeeConfirmed \?\? false/);
});

test("trialFeeConfirmed 를 true 로 쓰는 곳은 관리자 전용 입금 확인 모듈 하나뿐이다", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(full.replace(/\\/g, "/"));
    }
  };
  walk("src");
  const writers = files.filter((file) => /"trialFeeConfirmed"\s*=\s*(true|\$)/.test(readFileSync(file, "utf8")));
  assert.deepEqual(writers, ["src/lib/trial-fee-confirmation.ts"]);

  // 공용 수정 action 허용 목록·수정 모달에서도 빠져 있어야 한다(오래된 화면 값 덮어쓰기 방지)
  const admin = readFileSync("src/app/actions/admin.ts", "utf8");
  const start = admin.indexOf("const TRIAL_LEAD_COLUMNS");
  const whitelist = admin.slice(start, admin.indexOf("] as const;", start));
  assert.doesNotMatch(whitelist, /"trialFeeConfirmed"/);
  const modals = readFileSync("src/app/admin/trial/TrialCrmModals.tsx", "utf8");
  assert.doesNotMatch(modals, /trialFeeConfirmed: form\.trialFeeConfirmed/);
});
