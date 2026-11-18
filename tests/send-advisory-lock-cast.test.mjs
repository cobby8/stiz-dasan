// 발송 잠금 가드 (2026-11-17 운영 사고)
// pg_advisory_xact_lock 은 «void»를 돌려준다. $queryRawUnsafe(결과를 읽는 방식)로 그대로 부르면
// Prisma 가 «Failed to deserialize column of type 'void'»(P2010)로 실패해 발송 접수가 통째로 멈춘다.
// 그날 원장이 누른 «학부모 가입 안내 151명 보내기»가 이 오류로 두 번 멈췄다.
// → 결과를 읽는 방식으로 부를 땐 끝에 ::text 를 붙여 글자로 돌려받는다($executeRawUnsafe 는 그대로 괜찮다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// 문자·알림 발송 접수 경로 — 여기서 멈추면 고객에게 아무것도 안 나간다
const SEND_FILES = [
  "src/app/actions/customer-notice.ts",
  "src/app/actions/parent-notice.ts",
  "src/lib/billing/noticeQueue.ts",
];

// $queryRawUnsafe(`SELECT pg_advisory_xact_lock(...)`  ← 바로 백틱으로 끝나면(= ::text 없음) 실패
const BAD_LOCK = /\$queryRawUnsafe\(\s*`SELECT pg_advisory_xact_lock\([^`]*\)`/g;

test("발송 경로: $queryRawUnsafe 로 부르는 pg_advisory_xact_lock 은 모두 ::text 로 받는다", () => {
  for (const file of SEND_FILES) {
    const source = readFileSync(file, "utf8");
    const bad = source.match(BAD_LOCK) ?? [];
    assert.deepEqual(bad, [], `${file}: void 결과를 그대로 읽는 잠금 호출`);
  }
});

// 2026-11-18: 같은 실수가 카카오채널 접수(결석·보강·셔틀·챗봇)·사진 동의·SNS 초안 8곳에 남아 있었다.
// 발송 경로만 보던 검사를 src 전체로 넓혀, 새로 쓰는 잠금도 같은 실수를 못 하게 막는다.
test("src 전체: void 결과를 그대로 읽는 잠금 호출이 없다", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        const hits = readFileSync(full, "utf8").match(BAD_LOCK) ?? [];
        for (const hit of hits) offenders.push(`${full}: ${hit}`);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});
