import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

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
    "@/components/parent/InlineConfirm": { __esModule: true, default: () => null },
    "@/components/parent/customerMessage": { customerMessage: (_, fallback) => fallback },
  }).default;
  for (const resumeOn of ["2027-01-03", null]) {
    const html = renderToStaticMarkup(React.createElement(Client, { initial: {
      effectiveFrom: "2026-12-01", minEffectiveFrom: "2026-11-04", maxEffectiveFrom: "2027-02-03", classes: [],
      children: [{ studentId: "student-a", studentName: "합성", enrollmentId: "enrollment-a", currentClassId: "class-a", currentClassName: "합성 반", currentProgramName: "합성", pending: { id: "request-a", kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn, waitlisted: false } }],
    } }));
    assert.ok(html.includes(rules.pauseResumeLabel(resumeOn)));
  }
});

test("관리자 모바일 목록도 적용일 아래 복귀 예정일 또는 미정을 표시한다", () => {
  const React = nodeRequire("react");
  const { renderToStaticMarkup } = nodeRequire("react-dom/server");
  const Client = load("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx", {
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/app/actions/enrollment-changes": {},
    "@/lib/enrollment/changeRequestRules": rules,
    "@/lib/operations-sync/sheetRetirement": {},
    "@/lib/enrollment/sheetManualCheckRules": {},
    "@/components/admin/AdminQuickActionMenu": { __esModule: true, default: () => null },
    "@/components/admin/list/ListDetailPanel": { __esModule: true, default: () => null },
  }).default;
  for (const resumeOn of ["2027-01-03", null]) {
    const html = renderToStaticMarkup(React.createElement(Client, { status: "ALL", rows: [{
      id: "request-a", studentName: "합성 학생", kind: "PAUSE", kindLabel: "휴원", status: "APPROVED",
      fromClassName: "합성 반", toClassName: null, effectiveFrom: "2026-12-01", resumeOn,
      createdAt: "2026-11-03", proration: null, sheetStatus: null, rallyzStatus: null,
    }] }));
    const mobileText = rules.pauseResumeLabel(resumeOn);
    assert.ok(html.includes(`lg:hidden">${mobileText}</span>`));
    assert.equal(html.split(mobileText).length - 1, 2, "같은 값을 모바일 보조줄과 PC 복귀일 칸에 표시");
  }
});
