// 학생 상세 «수강 반» ⋯ 메뉴 — 반 이동 · 잘못 등록한 수강 삭제 (2026-11-09 원장 지시)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const edit = await loadTsModule("src/lib/enrollment/admin-enrollment-edit.ts");
const actions = readFileSync("src/app/actions/enrollment-admin-edit.ts", "utf8");
const detail = readFileSync("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");

const target = { id: "class-b", capacity: 10, activeCount: 3, deleted: false, seasonal: false };
const from = { status: "ACTIVE", classId: "class-a", startsOn: "2026-10-01" };
const base = { from, target, targetExistingStatus: null, effectiveDate: "2026-11-09", today: "2026-11-09" };

test("반 이동: 새 반 개시일 = 적용일, 개시 전 수강은 원래 개시일을 이어받는다", () => {
  assert.deepEqual(edit.planEnrollmentMove(base), { ok: true, newStartsOn: "2026-11-09" });
  // 허재원 사례 — 개시일 11-13 인 수강을 11-09 에 옮기면 새 반도 11-13 부터(청구 시수·출석부 기준 보존)
  assert.deepEqual(edit.planEnrollmentMove({ ...base, from: { ...from, startsOn: "2026-11-13" } }), { ok: true, newStartsOn: "2026-11-13" });
  assert.deepEqual(edit.planEnrollmentMove({ ...base, from: { ...from, startsOn: null } }), { ok: true, newStartsOn: "2026-11-09" });
  // 지난 날짜 적용도 허용(상태 변경과 같은 규칙)
  assert.equal(edit.planEnrollmentMove({ ...base, effectiveDate: "2026-11-01" }).newStartsOn, "2026-11-01");
});

test("반 이동: 막는 경우 — 미래 적용일·같은 반·이미 수강/휴원·수강 중 아님·없는 반·정원", () => {
  const no = (patch) => edit.planEnrollmentMove({ ...base, ...patch });
  assert.equal(no({ effectiveDate: "2026-11-10" }).ok, false);
  assert.equal(no({ effectiveDate: "2026-02-30" }).ok, false);
  assert.equal(no({ target: { ...target, id: "class-a" } }).ok, false);
  assert.equal(no({ targetExistingStatus: "ACTIVE" }).ok, false);
  assert.equal(no({ targetExistingStatus: "PAUSED" }).ok, false);
  assert.equal(no({ targetExistingStatus: "WITHDRAWN" }).ok, true, "예전에 그만둔 반은 되살린다");
  assert.equal(no({ from: { ...from, status: "PAUSED" } }).ok, false);
  assert.equal(no({ target: null }).ok, false);
  assert.equal(no({ target: { ...target, deleted: true } }).ok, false);
  assert.equal(no({ target: { ...target, seasonal: true } }).ok, false);
  const full = no({ target: { ...target, activeCount: 10 } });
  assert.equal(full.code, "OVER_CAPACITY");
  assert.equal(no({ target: { ...target, activeCount: 10 }, allowOverCapacity: true }).ok, true);
});

test("삭제: 연결 기록이 하나라도 있으면 막고 «수강 종료» 안내", () => {
  const zero = { attendance: 0, payments: 0, billingDrafts: 0, makeups: 0, makeupCredits: 0, seasonalItems: 0, openChangeRequests: 0 };
  assert.deepEqual(edit.enrollmentDeleteBlockers(zero), []);
  for (const key of Object.keys(zero)) assert.equal(edit.enrollmentDeleteBlockers({ ...zero, [key]: 1 }).length, 1, key);
  const msg = edit.enrollmentDeleteBlockedMessage(edit.enrollmentDeleteBlockers({ ...zero, attendance: 2, payments: 1 }));
  assert.match(msg, /출석 2건 · 청구·수납 1건/);
  assert.match(msg, /«수강 종료»/);
});

test("삭제: 연결 기록 수는 학생+반 기준으로 세고, 청구 준비 표는 있을 때만 센다", async () => {
  const calls = [];
  const db = (hasDrafts) => ({ async $queryRawUnsafe(sql, ...values) {
    calls.push({ sql, values });
    if (sql.includes('"BillingWorkbenchDraft" WHERE')) return [{ count: 4 }];
    return [{ attendance: 1, payments: 0, makeups: 2, makeupCredits: 0, seasonalItems: 0, openChangeRequests: 0, hasDrafts }];
  } });
  const ids = { enrollmentId: "e1", studentId: "s1", classId: "c1" };
  const noTable = await edit.readEnrollmentLinkCounts(db(false), ids);
  assert.equal(noTable.billingDrafts, 0);
  assert.equal(calls.length, 1, "표가 없으면 두 번째 조회를 하지 않는다");
  assert.deepEqual(calls[0].values, ["e1", "s1", "c1"]);
  for (const t of ['"Attendance"', '"Payment"', '"MakeupSession"', '"MakeupCredit"', '"SpecialProgramApplicationItem"', '"EnrollmentChangeRequest"']) assert.ok(calls[0].sql.includes(t), t);
  const withTable = await edit.readEnrollmentLinkCounts(db(true), ids);
  assert.equal(withTable.billingDrafts, 4);
  assert.equal(withTable.makeups, 2);
});

test("서버 동작: 한 트랜잭션·잠금·기존 기록 방식 재사용, 삭제는 서버가 다시 센 뒤에만", () => {
  const move = actions.slice(actions.indexOf("export async function moveEnrollmentToClass"), actions.indexOf("export async function removeMistakenEnrollment"));
  const remove = actions.slice(actions.indexOf("export async function removeMistakenEnrollment"));
  for (const fn of [move, remove]) {
    assert.match(fn, /requireAdmin\(\)/);
    assert.match(fn, /prisma\.\$transaction/);
    assert.match(fn, /FOR UPDATE OF e/);
  }
  // 반 이동 = 학부모 반 변경 신청과 같은 이력 표(CLASS_CHANGE, 관리자 즉시 적용 APPLIED) + 운영 동기화 원장 두 건
  assert.match(move, /'CLASS_CHANGE'/);
  assert.match(move, /'APPLIED'/);
  assert.match(move, /status = 'WITHDRAWN'.*WHERE id = \$1 AND status = 'ACTIVE'/);
  assert.match(move, /ON CONFLICT \("studentId", "classId"\) DO UPDATE SET status = 'ACTIVE', "startsOn" = EXCLUDED\."startsOn"/);
  assert.equal((move.match(/enqueueWebsiteOperationsEventInTransaction\(tx,/g) || []).length, 2);
  assert.match(move, /planEnrollmentMove\(/);
  // 삭제 = 트랜잭션 안에서 다시 센 뒤 DELETE, 이력은 연결만 끊고 감사 기록
  const recount = remove.indexOf("readEnrollmentLinkCounts(tx");
  const del = remove.indexOf('DELETE FROM "Enrollment"');
  assert.ok(recount > 0 && recount < del, "DELETE 전에 서버가 연결 기록을 다시 센다");
  assert.match(remove, /SET "enrollmentId" = NULL/);
  assert.match(remove, /ENROLLMENT_DELETED_MISTAKE/);
  assert.doesNotMatch(remove, /DELETE FROM "EnrollmentChangeRequest"/);
});

test("화면: 반 단위는 «수강 종료», 삭제는 빨간 확인 창(학생·반 이름)", () => {
  assert.match(detail, /\{ value: "WITHDRAWN", label: "수강 종료" \}/);
  assert.doesNotMatch(detail, /\{ value: "WITHDRAWN", label: "퇴원" \}/);
  assert.match(detail, /WITHDRAWN: \{ label: "퇴원"/, "학생 대표 상태의 «퇴원»은 그대로");
  assert.match(detail, /title: `"\$\{student\.name\}" 학생의 «\$\{enrollment\.className\}» 수강 삭제`/);
  assert.match(detail, /tone: "danger"/);
  assert.match(detail, /key: "move", *\n? *label: "반 이동"|key: "move",\s*label: "반 이동"/);
});
