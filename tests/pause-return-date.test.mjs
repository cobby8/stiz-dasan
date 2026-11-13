import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as seatLevelModule from "../src/lib/seats/seatLevel.ts";

const nodeRequire = createRequire(import.meta.url);
const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : nodeRequire(name);
  module._compile(compiled, absolute);
  return module.exports;
};
const rules = load("src/lib/enrollment/changeRequestRules.ts");
const changeStatus = load("src/lib/enrollment/parentChangeStatus.ts");

function requestHarness() {
  let saved = null;
  const writes = [];
  const prisma = {
    async $queryRawUnsafe(sql) {
      if (sql.includes('SELECT e.id, e."classId"')) return [{ id: "enrollment-a", classId: "class-a", studentId: "student-a", studentName: "합성 학생", className: "합성 반" }];
      if (sql.includes('SELECT 1 FROM "EnrollmentChangeRequest"')) return [];
      if (sql.includes('SELECT s.id AS "studentId"')) {
        assert.match(sql, /to_char\(r\."resumeOn",'YYYY-MM-DD'\) AS "pendingResumeOn"/);
        return [{ studentId: "student-a", studentName: "합성 학생", enrollmentId: "enrollment-a", currentClassId: "class-a", currentClassName: "합성 반", currentProgramName: "합성", pendingId: saved ? "request-a" : null, pendingKind: saved?.kind, pendingEffectiveFrom: saved?.effectiveFrom, pendingResumeOn: saved?.resumeOn, pendingWaitlisted: false }];
      }
      return [];
    },
    async $executeRawUnsafe(sql, ...values) {
      assert.match(sql, /INSERT INTO "EnrollmentChangeRequest"/);
      writes.push({ sql, values });
      saved = { kind: values[4], effectiveFrom: values[5], resumeOn: values[6] };
      return 1;
    },
  };
  const api = load("src/lib/enrollment/parent-change-request.ts", {
    "@/lib/account/child-access": { childAccessSql: async () => "s.parentId = $2" },
    "@/lib/prisma": { prisma },
    "@/lib/studentVisibility": { notMergedStudent: () => "TRUE" },
    "@/lib/datetime/kst": load("src/lib/datetime/kst.ts"),
    "@/lib/enrollment/changeRequestRules": rules,
    "@/lib/enrollment/parentChangeStatus": changeStatus,
    "@/lib/seats/seatLevel": seatLevelModule,
    "@/lib/operational-staff-notification": { notifyOperationalStaff: async () => {} },
  });
  return { api, writes };
}

test("휴원 복귀 예정일 저장 뒤 학부모 신청 내역을 다시 읽어 같은 날짜를 표시한다", async () => {
  const { api, writes } = requestHarness();
  const result = await api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enrollment-a", kind: "PAUSE", resumeOn: "2099-03-14", reason: "합성" });
  assert.equal(result.ok, true);
  assert.equal(writes[0].values[6], "2099-03-14");
  const reread = await api.getEnrollmentChangeOptions("parent-a");
  assert.equal(reread.children[0].pending.resumeOn, "2099-03-14");
  assert.equal(rules.pauseResumeLabel(reread.children[0].pending.resumeOn), "2099-03-14 복귀 예정");
});

test("날짜를 지우거나 미정으로 신청하면 null을 보존하고 미정으로 다시 표시한다", async () => {
  for (const resumeOn of [undefined, "", null]) {
    const { api, writes } = requestHarness();
    assert.equal((await api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enrollment-a", kind: "PAUSE", resumeOn })).ok, true);
    assert.equal(writes[0].values[6], null);
    const reread = await api.getEnrollmentChangeOptions("parent-a");
    assert.equal(reread.children[0].pending.resumeOn, null);
    assert.equal(rules.pauseResumeLabel(reread.children[0].pending.resumeOn), "복귀일 미정");
  }
});

test("달력에 없는 복귀일과 휴원 이전 복귀일은 서버 저장 전에 막는다", async () => {
  for (const resumeOn of ["2099-02-30", "2099-2-1", "2000-01-01", {}, " "]) {
    const { api, writes } = requestHarness();
    const result = await api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enrollment-a", kind: "PAUSE", resumeOn });
    assert.equal(result.ok, false);
    assert.equal(writes.length, 0);
  }
});

test("휴원 시작일 당일 복귀는 금지하고 다음 날부터 고를 수 있다", () => {
  for (const [start, next] of [["2026-11-01", "2026-11-02"], ["2026-12-31", "2027-01-01"], ["2028-02-28", "2028-02-29"]]) {
    assert.equal(rules.earliestResumeOn(start), next);
    assert.equal(rules.validateChangeRequest({ kind: "PAUSE", resumeOn: start }, { currentClassId: "class-a", effectiveFrom: start }).error, "RESUME_BEFORE_START");
    assert.equal(rules.validateChangeRequest({ kind: "PAUSE", resumeOn: next }, { currentClassId: "class-a", effectiveFrom: start }).ok, true);
  }
});

test("재조회한 휴원 날짜·미정은 실제 학부모 신청 내역에 렌더링한다", () => {
  const React = nodeRequire("react");
  const { renderToStaticMarkup } = nodeRequire("react-dom/server");
  const Client = load("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx", {
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/enrollment/changeRequestRules": rules,
    "@/lib/enrollment/parentChangeStatus": changeStatus,
    "@/lib/seats/seatLevel": seatLevelModule,
    "@/components/parent/InlineConfirm": { __esModule: true, default: () => null },
    "@/lib/mypage/requestPreset": { presetIndex: () => 0, presetFirst: (list) => [...list] }, "@/components/parent/customerMessage": { customerMessage: (_, fallback) => fallback },
  }).default;
  for (const resumeOn of ["2027-01-03", null]) {
    const html = renderToStaticMarkup(React.createElement(Client, { initial: {
      effectiveFrom: "2026-12-01", minEffectiveFrom: "2026-11-04", maxEffectiveFrom: "2027-02-03", classes: [],
      children: [{ studentId: "student-a", studentName: "합성", enrollmentId: "enrollment-a", currentClassId: "class-a", currentClassName: "합성 반", currentProgramName: "합성", pending: { id: "request-a", kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn, waitlisted: false } }],
    } }));
    assert.ok(html.includes(rules.pauseResumeLabel(resumeOn)));
  }
});

function renderAdminChange(props) {
  const React = nodeRequire("react");
  const { renderToStaticMarkup } = nodeRequire("react-dom/server");
  const Client = load("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx", {
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/app/actions/enrollment-changes": {},
    "@/lib/enrollment/changeRequestRules": rules,
    "@/lib/enrollment/parentChangeStatus": changeStatus,
    "@/lib/seats/seatLevel": seatLevelModule,
    "@/lib/operations-sync/sheetRetirement": load("src/lib/operations-sync/sheetRetirement.ts"),
    "@/lib/enrollment/sheetManualCheckRules": load("src/lib/enrollment/sheetManualCheckRules.ts"),
    // 휴원 수강료 처리 이름표(순수 모듈 그대로)
    "@/lib/enrollment/pause-settlement-plan": load("src/lib/enrollment/pause-settlement-plan.ts"),
    "@/components/admin/AdminQuickActionMenu": { __esModule: true, default: () => null },
    "@/components/admin/list/ListDetailPanel": { __esModule: true, default: () => null },
  }).default;
  return renderToStaticMarkup(React.createElement(Client, props));
}

test("관리자 모바일 목록도 적용일 아래 복귀 예정일 또는 미정을 표시한다", () => {
  for (const resumeOn of ["2027-01-03", null]) {
    const html = renderAdminChange({ status: "ALL", rows: [{
      id: "request-a", studentName: "합성 학생", kind: "PAUSE", kindLabel: "휴원", status: "APPROVED",
      fromClassName: "합성 반", toClassName: null, effectiveFrom: "2026-12-01", resumeOn,
      createdAt: "2026-11-03", proration: null, sheetStatus: null, rallyzStatus: null,
    }] });
    const mobileText = rules.pauseResumeLabel(resumeOn);
    assert.ok(html.includes(`lg:hidden">${mobileText}</span>`));
    assert.equal(html.split(mobileText).length - 1, 2, "같은 값을 모바일 보조줄과 PC 복귀일 칸에 표시");
  }
});

test("신청함 휴원 상세에서 반별 사이트 상태와 확인해야 할 이유를 같이 표시한다", () => {
  const pause = {
    id: "request-a", studentName: "합성 학생", kind: "PAUSE", kindLabel: "휴원",
    fromClassName: "월요일 반", effectiveFrom: "2026-11-03", effectiveDateReached: true,
    createdAt: "2026-10-29", enrollmentStatus: "PAUSED",
  };
  const html = renderAdminChange({ inline: true, rows: [
    { ...pause, status: "APPROVED", syncCommandStatus: "HELD", syncHoldReason: "신청 보호자와 현재 학생 연결 재확인 필요" },
    { ...pause, id: "request-b", fromClassName: "수요일 반", status: "APPLIED", appliedAt: "2026-11-03 09:00",
      syncCommandId: "operation-b", sheetStatus: "SKIPPED", rallyzStatus: "PENDING" },
  ] });
  assert.match(html, /월요일 반[\s\S]*?반영 확인 필요[\s\S]*?사이트 수강 상태 · 휴원[\s\S]*?신청 보호자와 현재 학생 연결 재확인 필요/);
  assert.match(html, /수요일 반[\s\S]*?사이트 반영됨 · 랠리즈 확인 필요[\s\S]*?사이트 수강 상태 · 휴원[\s\S]*?>랠리즈 반영 확인</);
  assert.doesNotMatch(html, /href=|수강료 처리 실행/);
});

test("신청함 휴원 수강료 조회 실패에서는 승인만 막고 재조회와 거절은 가능하다", () => {
  const html = renderAdminChange({ inline: true, rows: [{
    id: "request-a", studentName: "합성 학생", kind: "PAUSE", kindLabel: "휴원", status: "PENDING",
    fromClassName: "월요일 반", effectiveFrom: "2026-11-03", createdAt: "2026-10-29",
    enrollmentStatus: "ACTIVE", settlementReadFailed: true,
  }] });
  assert.match(html, /수강료 처리 내역을 확인하지 못했습니다\.[\s\S]*?>다시 조회</);
  assert.match(html, /<button type="button" class="[^"]+">거절</);
  assert.match(html, /<button type="button" disabled="" class="[^"]+">승인</);
});

test("신청함 상세는 관리자 확인 후 선택한 신청 ID만 조회한다", async () => {
  const calls = [];
  let admin = false;
  const { readEnrollmentChangesForInbox } = load("src/app/actions/enrollment-changes.ts", {
    "next/cache": {},
    "@/lib/user-facing-error": {},
    "@/lib/auth-guard": { requireAdmin: async () => { if (!admin) throw new Error("권한 없음"); } },
    "@/lib/enrollment/admin-change-request": {
      getEnrollmentChangeRequests: async (status, ids) => { calls.push([status, ids]); return ids.map((id) => ({ id })); },
      getEnrollmentCancelRequests: async (ids) => { calls.push(["CANCEL", ids]); return []; },
    },
    "@/lib/enrollment/pause-settlement": {},
    "@/lib/prisma": {},
    "@/lib/enrollment/change-cache": {},
    "@/app/actions/operations-sync": {},
    "@/lib/operations-sync/sheetRetirement": { isSheetSyncRetired: () => true },
  });
  await assert.rejects(readEnrollmentChangesForInbox(["request-a"]), /권한 없음/);
  assert.deepEqual(calls, []);
  admin = true;
  await assert.rejects(readEnrollmentChangesForInbox([]), /다시 선택/);
  assert.deepEqual(calls, []);
  const result = await readEnrollmentChangesForInbox(["request-b", "request-a", "request-a"]);
  assert.deepEqual(calls, [
    ["ALL", ["request-b", "request-a"]],
    ["CANCEL", ["request-b", "request-a"]],
  ]);
  assert.deepEqual(result.rows.map((row) => row.id), ["request-b", "request-a"]);
});
