import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// SQL을 실행하지 않는다. 실제 PostgreSQL 제약·권한 검증은 승인된 테스트 DB에서 별도로 필요하다.
const sql = await readFile("prisma/migrations/20260904121549_add_monthly_enrollment_register/migration.sql", "utf8");
const schema = await readFile("prisma/schema.prisma", "utf8");
const statements = sql.replace(/--[^\r\n]*/g, "").split(";").map((statement) => statement.trim()).filter(Boolean);
const tables = ["MonthlyEnrollmentRegister", "MonthlyEnrollmentRegisterRevision"];
const tableBody = (name) => {
  const statement = statements.find((item) => item.startsWith(`CREATE TABLE "${name}" (`));
  assert.ok(statement, `${name} 생성문이 있어야 한다`);
  return statement;
};

test("월 장부와 감사 구조를 하나의 거래에서 생성하고 기존 운영 자료는 변경하지 않는다", () => {
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.filter((item) => item.startsWith("CREATE TABLE ")).length, 2);
  for (const name of tables) tableBody(name);
  assert.equal(statements.some((item) => /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP|TRUNCATE|ALTER\s+DEFAULT\s+PRIVILEGES)\b/i.test(item)), false);
  assert.equal(statements.some((item) => /^ALTER TABLE "(?:Student|Enrollment|Payment|PaymentInvoice)"/i.test(item)), false);
});

test("신규 두 테이블에 RLS를 켜고 PUBLIC·익명·일반 로그인 직접 접근을 회수한다", () => {
  for (const name of tables) {
    assert.ok(statements.includes(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`));
  }
  assert.ok(statements.includes('REVOKE ALL ON TABLE "MonthlyEnrollmentRegister", "MonthlyEnrollmentRegisterRevision" FROM PUBLIC, anon, authenticated'));
  assert.equal(statements.some((item) => /^CREATE POLICY\b/i.test(item)), false);
  assert.equal(statements.some((item) => /^GRANT\b[\s\S]*\bTO\s+(?:PUBLIC|anon|authenticated)\b/i.test(item)), false);
});

test("서버 역할은 장부 삭제 및 감사 기록 수정·삭제 권한을 받지 않는다", () => {
  assert.ok(statements.includes('GRANT SELECT, INSERT, UPDATE ON TABLE "MonthlyEnrollmentRegister" TO service_role'));
  assert.ok(statements.includes('REVOKE DELETE, TRUNCATE ON TABLE "MonthlyEnrollmentRegister" FROM service_role'));
  assert.ok(statements.includes('GRANT SELECT, INSERT ON TABLE "MonthlyEnrollmentRegisterRevision" TO service_role'));
  assert.ok(statements.includes('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "MonthlyEnrollmentRegisterRevision" FROM service_role'));
});

test("학생·월 장부와 장부별 버전은 고유하고 감사 기록은 원장 삭제를 막는다", () => {
  assert.match(sql, /CREATE UNIQUE INDEX "MonthlyEnrollmentRegister_studentId_month_key" ON "MonthlyEnrollmentRegister"\("studentId", "month"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "MonthlyEnrollmentRegisterRevision_registerId_version_key" ON "MonthlyEnrollmentRegisterRevision"\("registerId", "version"\)/);
  assert.match(tableBody(tables[1]), /FOREIGN KEY \("registerId"\)\s+REFERENCES "MonthlyEnrollmentRegister"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/);
  assert.match(schema, /model MonthlyEnrollmentRegister\s*\{[\s\S]*?@@unique\(\[studentId, month\]\)/);
  assert.match(schema, /model MonthlyEnrollmentRegisterRevision\s*\{[\s\S]*?onDelete: Restrict[\s\S]*?@@unique\(\[registerId, version\]\)/);
});

test("대상월·양수버전·상태·확정시각·감사 작업과 사유의 제약이 있다", () => {
  for (const name of tables) {
    const body = tableBody(name);
    assert.ok(body.includes('CHECK ("version" > 0)'));
    assert.ok(body.includes('CHECK ("status" IN (\'DRAFT\', \'CONFIRMED\'))'));
    assert.ok(body.includes('CHECK ("month" ~ \'^(20[2-9][0-9]|2100)-(0[1-9]|1[0-2])$\')'));
  }
  assert.ok(tableBody(tables[0]).includes('CHECK (("status" = \'CONFIRMED\') = ("confirmedAt" IS NOT NULL))'));
  assert.ok(tableBody(tables[1]).includes('CHECK ("action" IN (\'SAVE_DRAFT\', \'CONFIRM\', \'REOPEN\'))'));
  assert.ok(tableBody(tables[1]).includes('CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500)'));
});

test("장부 JSON은 객체·반 배열이며 학생과 월을 외부 컬럼과 일치시킨다", () => {
  for (const name of tables) {
    const body = tableBody(name);
    assert.ok(body.includes('"payload" JSONB NOT NULL'));
    assert.ok(body.includes('jsonb_typeof("payload") = \'object\''));
    assert.ok(body.includes('(\"payload\" ->> \'studentId\') IS NOT DISTINCT FROM "studentId"'));
    assert.ok(body.includes('(\"payload\" ->> \'month\') IS NOT DISTINCT FROM "month"'));
    assert.ok(body.includes('jsonb_typeof("payload" -> \'classes\') = \'array\''));
    assert.ok(body.includes('"payload" ?& ARRAY['));
  }
  assert.ok(tableBody(tables[0]).includes("ARRAY['studentId', 'month', 'classes', 'shuttleAmount', 'shuttleBasis', 'reason']"));
});
