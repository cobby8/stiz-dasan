import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  REQUIRED_ACCOUNT_WITHDRAWAL_COLUMNS,
  findAccountWithdrawalIssues,
} from "../scripts/account-withdrawal-db-preflight.mjs";

// 회원 탈퇴(계정 삭제)는 구글플레이 등록 필수 요건이고, 개인정보처리방침이 이미 약속한 기능이다.
// 방침에는 "회원 탈퇴 시 즉시 파기"가 적혀 있는데 정작 탈퇴할 방법이 없었다(2026-10-24 확인).
//
// 이 파일이 지키는 것 — DB 칸과 코드가 어긋나면 **학부모가 «탈퇴»를 눌렀을 때만** 터진다.
// 빌드·타입검사는 통과하므로 사람이 못 잡는다. 그래서 구조를 테스트로 묶는다.

const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
const migration = fs.readFileSync(
  "prisma/migrations/20261024120000_add_user_account_withdrawal/migration.sql",
  "utf8",
);
const releasePreflight = fs.readFileSync("scripts/release-preflight.mjs", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

test("schema.prisma 의 User 가 탈퇴 칸을 timestamptz 로 들고 있다", () => {
  // 날짜·시간 전역 규칙: 시각 컬럼은 timestamptz 로 둔다(무tz 컬럼은 KST 변환을 두 번 걸어야 해 사고가 난다).
  assert.match(schema, /withdrawRequestedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
  assert.match(schema, /withdrawnAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
});

test("마이그레이션이 멱등이고 되돌릴 수 있는 형태다", () => {
  // 이 프로젝트는 Vercel 이 migrate deploy 를 돌리지 않아 운영 DB 에 직접 적용한다.
  // 두 번 적용돼도 안전해야 한다.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "withdrawRequestedAt" TIMESTAMPTZ/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "withdrawnAt" TIMESTAMPTZ/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "User_withdraw_pending_idx"/);
  // 대기 목록만 보는 부분 인덱스여야 한다(탈퇴 완료분까지 담으면 계속 커진다).
  assert.match(migration, /WHERE "withdrawnAt" IS NULL/);
  // 기존 데이터를 바꾸는 구문이 섞이면 안 된다.
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE|UPDATE)\b/);
});

test("preflight 가 요구하는 칸이 schema.prisma 와 같다", () => {
  // 한쪽만 늘어나면 배포는 통과하고 화면만 깨진다.
  for (const column of REQUIRED_ACCOUNT_WITHDRAWAL_COLUMNS.User) {
    assert.match(schema, new RegExp(`${column}\\s+DateTime\\?`), `${column} 가 schema.prisma 에 없다`);
    assert.match(migration, new RegExp(`"${column}"`), `${column} 가 마이그레이션에 없다`);
  }
  assert.equal(REQUIRED_ACCOUNT_WITHDRAWAL_COLUMNS.User.length, 2);
});

test("preflight 가 칸·인덱스 누락을 실제로 잡는다", () => {
  const ok = [
    { table_name: "User", column_name: "withdrawnAt" },
    { table_name: "User", column_name: "withdrawRequestedAt" },
  ];
  const idx = [{ table_name: "User", index_name: "User_withdraw_pending_idx" }];

  // 통과만 하는 검사는 장식이다 — 빠진 경우를 실제로 넣어 본다.
  assert.equal(findAccountWithdrawalIssues({ columnRows: ok, indexRows: idx }).length, 0);
  assert.equal(findAccountWithdrawalIssues({ columnRows: [], indexRows: [] }).length, 3);
  assert.deepEqual(
    findAccountWithdrawalIssues({ columnRows: [ok[0]], indexRows: idx }),
    [{ table: "User", column: "withdrawRequestedAt" }],
    "칸이 하나만 있을 때 나머지 하나를 지목해야 한다",
  );
  assert.deepEqual(
    findAccountWithdrawalIssues({ columnRows: ok, indexRows: [] }),
    [{ type: "index", table: "User", index: "User_withdraw_pending_idx" }],
  );
});

test("배포 경로가 이 preflight 를 실제로 거친다", () => {
  // 스크립트를 만들어 두고 연결을 빠뜨리면 아무것도 막지 못한다.
  assert.match(packageJson.scripts["build:vercel"], /account-withdrawal-db-preflight\.mjs/);
  assert.match(releasePreflight, /accountWithdrawalDbPreflight/);
  assert.match(releasePreflight, /회원 탈퇴 DB 준비 상태/);
});

test("개인정보처리방침이 탈퇴와 법령 보관을 함께 규정하고 있다", () => {
  // 설계 근거 — 방침이 "즉시 파기"와 "법령 보존 기간은 예외"를 둘 다 적고 있어서
  // 학생·결제 기록을 남기면서도 탈퇴를 구현할 수 있다. 이 문구가 사라지면 설계 근거가 사라진다.
  const policies = fs.readFileSync("src/lib/defaultPolicies.ts", "utf8");
  assert.match(policies, /회원 탈퇴 시: 즉시 파기/);
  assert.match(policies, /법령에 따른 보존 기간이 있는 경우/);
  assert.match(policies, /5년 \(전자상거래법\)/);
});
