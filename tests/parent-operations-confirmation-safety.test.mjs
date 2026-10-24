import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const action = await readFile("src/app/actions/parent-operations-request.ts", "utf8");
const form = await readFile("src/app/request/[token]/ParentRequestForm.tsx", "utf8");
const operations = await readFile("src/app/actions/operations-sync.ts", "utf8");

test("학부모 제출은 링크를 트랜잭션 안에서 한 번만 선점한다", () => {
  assert.match(action, /prisma\.\$transaction\(async \(tx\)/);
  assert.match(action, /UPDATE "ParentOperationsRequestLink" SET "revokedAt"=now\(\),"lastUsedAt"=now\(\)/);
  assert.match(action, /WHERE id=\$1 AND "revokedAt" IS NULL AND "expiresAt">now\(\)/);
  assert.match(action, /if \(claimed !== 1\) throw new Error\("REQUEST_LINK_ALREADY_USED"\)/);
});

test("접수 직후에는 DRAFT이며 청구와 알림은 HELD다", () => {
  assert.match(action, /VALUES \(\$1,\$2,\$3,'DRAFT'/);
  assert.match(action, /'HELD','HELD'\)/);
  assert.match(action, /return \{ ok: true as const, requestId, status: "DRAFT" as const \}/);
});

test("학부모 제출 경로는 시트·랠리즈·홈페이지 외부 반영 함수를 호출하지 않는다", () => {
  assert.doesNotMatch(action, /applyOperationsWebsite\s*\(/);
  assert.doesNotMatch(action, /send(?:Sms|Notification|Message)\s*\(/i);
  assert.doesNotMatch(action, /googleapis|sheets\.spreadsheets|rallyz/i);
  assert.match(operations, /if \(!requests\[0\] \|\| !\['APPROVED', 'PARTIAL', 'PENDING'\]\.includes\(requests\[0\]\.status\)\)/);
});

test("UNKNOWN은 서버 저장 시 자동 실행하지 않고 HELD 처리한다", () => {
  assert.match(action, /command\.kind === "UNKNOWN" \? "기타 요청은 원장이 내용을 확인해야 합니다\." : null/);
  assert.match(action, /holdReason \? "HELD" : "PENDING"/);
});

test("모바일 확인 화면은 항목 수정·추가·삭제를 제공한다", () => {
  assert.match(form, /function update\(/);
  assert.match(form, /function add\(/);
  assert.match(form, /aria-label=\{`요청 \$\{index \+ 1\} 삭제`\}/);
  for (const label of ["요청 종류", "희망 적용일", "현재 수업", "변경할 수업", "셔틀 변경", "추가 설명"]) assert.ok(form.includes(label), `${label} 편집 필드가 필요합니다.`);
});

test("셔틀 편집 선택값은 서버의 START·STOP·EXEMPT·CHANGE 규칙과 일치한다", () => {
  for (const id of ["START", "STOP", "EXEMPT", "CHANGE"]) {
    assert.match(form, new RegExp(`id: "${id}"`), `${id} 선택값이 필요합니다.`);
  }
  assert.doesNotMatch(form, /id: "USE"/);
});

test("필수값이나 확인 질문이 남으면 전송을 차단한다", () => {
  assert.match(form, /const incomplete = commands\.some/);
  assert.match(form, /const canSubmit = commands\.length > 0 && questions\.length === 0 && !incomplete/);
  assert.match(form, /disabled=\{isPending \|\| !canSubmit\}/);
  assert.match(form, /확인이 필요한 항목을 모두 수정해 주세요/);
});

test("학부모에게 승인 전 무반영과 청구·문자 보류를 명시한다", () => {
  for (const notice of ["원장님 검토대기로 접수됩니다", "제출 즉시 수업·셔틀 정보가 바뀌지 않습니다", "청구서와 안내 문자도 별도 승인 전까지 보류됩니다"]) assert.ok(form.includes(notice), `${notice} 안내가 필요합니다.`);
});
