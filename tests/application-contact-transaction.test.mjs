import assert from "node:assert/strict";
import test from "node:test";
import { recordApplicationContactAtomically } from "../src/lib/application-contact-transaction.ts";

function contactDb(initialStatus, { failInsert = false } = {}) {
  const state = { status: initialStatus, logs: 0, followUpsCompleted: 0 };
  return {
    state,
    async $transaction(callback) {
      const snapshot = { ...state };
      const tx = {
        async $queryRawUnsafe() { return [{ id: "trial-1" }]; },
        async $executeRawUnsafe(query) {
          if (query.includes('UPDATE "TrialLead"') && state.status === "NEW") state.status = "CONTACTED";
          if (query.includes('UPDATE "ApplicationContactLog"')) state.followUpsCompleted += 1;
          if (query.includes('INSERT INTO "ApplicationContactLog"')) {
            if (failInsert) throw new Error("log insert failed");
            state.logs += 1;
          }
          return 1;
        },
      };
      try { return await callback(tx); }
      catch (error) { Object.assign(state, snapshot); throw error; }
    },
  };
}

const contactedInput = {
  targetType: "TRIAL",
  targetId: "trial-1",
  action: "CONTACTED",
  note: null,
  nextFollowUpAt: null,
  actorUserId: "admin-1",
  actorUserName: "관리자",
};

test("TRIAL 연락 완료는 NEW→CONTACTED와 로그를 같은 transaction에 저장한다", async () => {
  const db = contactDb("NEW");
  assert.deepEqual(await recordApplicationContactAtomically(db, contactedInput), { found: true });
  assert.deepEqual(db.state, { status: "CONTACTED", logs: 1, followUpsCompleted: 1 });
});

test("이미 SCHEDULED인 체험은 연락 완료 기록으로 이전 상태로 후퇴하지 않는다", async () => {
  const db = contactDb("SCHEDULED");
  await recordApplicationContactAtomically(db, contactedInput);
  assert.equal(db.state.status, "SCHEDULED");
  assert.equal(db.state.logs, 1);
});

test("연락 로그 INSERT 실패 시 NEW→CONTACTED 상태 변경도 rollback된다", async () => {
  const db = contactDb("NEW", { failInsert: true });
  await assert.rejects(recordApplicationContactAtomically(db, contactedInput), /log insert failed/);
  assert.deepEqual(db.state, { status: "NEW", logs: 0, followUpsCompleted: 0 });
});
