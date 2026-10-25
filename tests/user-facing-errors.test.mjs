import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(file, dependencies = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const errors = load("src/lib/user-facing-error.ts");
const fallback = "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";

for (const internal of [
  'Invalid prisma.user.findUnique() invocation: column "secretColumn" does not exist',
  '오류: SELECT * FROM "User" WHERE token=private-value',
  "저장 실패: PostgreSQL connection refused at internal-host",
  "StorageApiError: bucket private-media not found",
  "인증 오류: auth provider internal error request-id=private-value",
  "회원가입 인증 보안키가 설정되지 않았습니다.",
  "보호자 계정 활성화 보안키가 설정되지 않았습니다.",
  "GOOGLE_SERVICE_ACCOUNT_KEY가 없어 구글 시트 자동 반영을 사용할 수 없습니다.",
  "권한 확인 DB 오류: permission denied for relation User",
  "관리자 권한이 필요합니다. SQL: private-value",
]) {
  test(`내부 오류 원문을 일반 안내로 교체: ${internal.split(":")[0]}`, () => {
    assert.equal(errors.userFacingError(new Error(internal), fallback), fallback);
  });
}

for (const message of [
  "관리자 권한이 필요합니다.",
  "인증이 필요합니다. 로그인해주세요.",
  "담당 수업에만 접근할 수 있습니다.",
  "휴대폰 인증을 먼저 완료해 주세요.",
  "휴대폰 인증 증표가 없거나 만료되었습니다.",
  "유효하지 않거나 만료된 활성화 링크입니다.",
  "인증번호는 60초 후 다시 요청할 수 있습니다.",
  "오늘 인증번호 요청 횟수를 초과했습니다.",
  "인증 시도가 잠겼습니다. 15분 후 다시 시도해 주세요.",
  "이미 사용 중인 로그인 아이디입니다.",
  "이미 사용 중인 이메일입니다.",
  "이미 가입된 휴대폰 번호입니다. 기존 아이디로 로그인한 뒤 마이페이지 → 간편로그인 연결에서 Apple·Google 을 연결해 주세요.",
  "비밀번호는 8자 이상 입력해 주세요.",
  "수강신청 연결 시간이 만료되었습니다.",
  "회원가입 휴대전화와 수강신청 보호자 연락처가 일치하지 않습니다.",
  "같은 연락처의 보호자 계정이 여러 개여서 관리자 확인이 필요합니다.",
  "학생 정보를 찾을 수 없습니다.",
  "진행 중인 수업의 사진만 삭제할 수 있습니다.",
  "현재 수업의 재원 학생만 사진 대상으로 선택할 수 있습니다.",
  "이미 학생과 연결된 대표팀 원본 행입니다.",
  "원본 행과 연결할 학생을 선택해주세요.",
  "유효한 월을 입력해 주세요.",
  "먼저 시트와 랠리즈의 실제 반영을 모두 확인해 주세요.",
  "구글 시트 반영과 재확인을 먼저 완료해 주세요.",
  "시트와 무관한 이유로 보류된 건이라 시트 수동 확인으로 풀 수 없습니다. 보류 사유를 먼저 확인해 주세요.",
  "선택한 수업 행에 다른 요일 수업도 있어 공통 상태를 자동 변경할 수 없습니다. 시트에서 수업별 행을 분리하거나 직접 확인해 주세요.",
  "적용일(2026-11-01) 이전에는 시트에 반영할 수 없습니다.",
  "적용일(미확정) 이전에는 홈페이지 상태를 변경할 수 없습니다.",
  "3건은 승인 후 수강 상태가 달라져 반영하지 않았습니다. 요청을 다시 검토해 주세요.",
]) {
  test(`구체적인 업무 안내 보존: ${message}`, () => {
    assert.equal(errors.userFacingError(new Error(message), fallback), message);
  });
}

test("가변 안내에 임의의 내용이나 식별자를 끼워 넣어도 노출하지 않는다", () => {
  for (const value of [
    "적용일(private-token) 이전에는 시트에 반영할 수 없습니다.",
    "적용일(2026-11-01) 이전에는 SELECT secret FROM User",
    "3건은 승인 후 수강 상태가 달라져 반영하지 않았습니다. 요청을 다시 검토해 주세요. SQL=secret",
  ]) assert.equal(errors.userFacingError(new Error(value), fallback), fallback);
  for (const value of [null, undefined, "private-value", { message: "private-value" }]) {
    assert.equal(errors.userFacingError(value, fallback), fallback);
  }
});

test("알려진 인증 공급자 코드만 번역하고 알 수 없는 원문은 숨긴다", () => {
  assert.match(errors.loginErrorMessage({ code: "invalid_credentials", message: "provider-private" }), /비밀번호가 올바르지/);
  assert.match(errors.loginErrorMessage({ code: "email_not_confirmed", message: "provider-private" }), /이메일 인증/);
  assert.match(errors.loginErrorMessage({ code: "over_request_rate_limit", message: "provider-private" }), /잠시 후/);
  assert.match(errors.loginErrorMessage({ message: "Invalid login credentials" }), /비밀번호가 올바르지/);
  assert.match(errors.loginErrorMessage({ message: "Email not confirmed" }), /이메일 인증/);
  assert.equal(errors.loginErrorMessage({ code: "unexpected_failure", message: "DB SQL private-value" }), "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  assert.equal(errors.userFacingError(new Error("Staff permission is required."), fallback), "선생님 권한이 필요합니다.");
});

function financeFixture(failure) {
  const calls = [];
  const route = load("src/app/api/admin/finance/sheet-reconcile/route.ts", {
    "@/lib/user-facing-error": errors,
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/lib/auth-guard": { requireAdmin: async () => undefined },
    "@/lib/prisma": { prisma: { $queryRawUnsafe: async (...args) => { calls.push(args); throw failure; } } },
  });
  return { route, calls };
}

test("실제 수납 점검 조회: DB 원문은 숨기고 응답 구조·상태 유지", async () => {
  const { route, calls } = financeFixture(new Error('한국어 DB 오류 SELECT private FROM "User"'));
  const result = await route.GET({ nextUrl: new URL("https://fixture.invalid/?year=2026&month=10") });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: "시트 기준 수납 점검에 실패했습니다." });
  assert.equal(calls.length, 3); // 원래 조회의 병렬 읽기 세 건을 유지한다.
});

test("실제 수납 점검 입력 오류는 상세 안내를 보존하고 DB에 접근하지 않는다", async () => {
  const { route, calls } = financeFixture(new Error("Unexpected database access"));
  const result = await route.GET({ nextUrl: new URL("https://fixture.invalid/?year=2026&month=13") });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: "유효한 월을 입력해 주세요." });
  assert.equal(calls.length, 0);
});

test("자료 가져오기 이력은 실패 원문만 숨기며 성공·경고 및 원본 저장값은 유지", async () => {
  const batches = [
    { id: "failed", status: "FAILED", message: "DB SQL private-value", createdAt: new Date("2026-10-01T00:00:00Z"), completedAt: null },
    { id: "complete", status: "COMPLETED", message: "원생 3명의 자료를 가져왔습니다.", createdAt: new Date("2026-10-01T00:00:00Z"), completedAt: null },
    { id: "warning", status: "COMPLETED", message: "연락처가 없는 학생 1명은 직접 확인해 주세요.", createdAt: new Date("2026-10-01T00:00:00Z"), completedAt: null },
  ];
  const original = structuredClone(batches);
  const route = load("src/app/api/admin/import-students/history/route.ts", {
    "@/lib/user-facing-error": errors,
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/lib/auth-guard": { requireAdmin: async () => undefined },
    "@/lib/prisma": { prisma: { $queryRawUnsafe: async (sql) => sql.includes('FROM "StudentSheetImportBatch"') ? batches : [] } },
  });
  const result = await route.GET();
  assert.equal(result.status, 200);
  assert.equal(result.body.batches[0].message, "자료 가져오기를 완료하지 못했습니다. 다시 시도해 주세요.");
  assert.equal(result.body.batches[1].message, batches[1].message);
  assert.equal(result.body.batches[2].message, batches[2].message);
  assert.deepEqual(batches, original);
});
