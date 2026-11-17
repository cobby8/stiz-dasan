// 발송 잠금 가드 (2026-11-17 운영 사고)
// pg_advisory_xact_lock 은 «void»를 돌려준다. $queryRawUnsafe(결과를 읽는 방식)로 그대로 부르면
// Prisma 가 «Failed to deserialize column of type 'void'»(P2010)로 실패해 발송 접수가 통째로 멈춘다.
// 그날 원장이 누른 «학부모 가입 안내 151명 보내기»가 이 오류로 두 번 멈췄다.
// → 결과를 읽는 방식으로 부를 땐 끝에 ::text 를 붙여 글자로 돌려받는다($executeRawUnsafe 는 그대로 괜찮다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 문자·알림 발송 접수 경로 — 여기서 멈추면 고객에게 아무것도 안 나간다
const SEND_FILES = [
  "src/app/actions/customer-notice.ts",
  "src/app/actions/parent-notice.ts",
  "src/lib/billing/noticeQueue.ts",
];

test("발송 경로: $queryRawUnsafe 로 부르는 pg_advisory_xact_lock 은 모두 ::text 로 받는다", () => {
  for (const file of SEND_FILES) {
    const source = readFileSync(file, "utf8");
    // $queryRawUnsafe(`SELECT pg_advisory_xact_lock(...)`  ← 바로 백틱으로 끝나면(= ::text 없음) 실패
    const bad = source.match(/\$queryRawUnsafe\(\s*`SELECT pg_advisory_xact_lock\([^`]*\)`/g) ?? [];
    assert.deepEqual(bad, [], `${file}: void 결과를 그대로 읽는 잠금 호출`);
  }
});
