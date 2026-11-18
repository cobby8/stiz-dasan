import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-08-03 실제 사고의 재발 방지.
//
// 무슨 일이 있었나:
//   장부 함수가 **메시지 종류(LMS)를 발송 채널(channel) 칸**에 넣었다. channel 은 CHECK 제약으로
//   IN_APP/PUSH/SMS 만 허용하므로, **장문(LMS) 문자는 전부 장부 기록이 터졌다**.
//   그런데 호출부는 그 예외를 "발송 실패"로 표시했다 — 문자는 이미 공급자에게 넘어간 뒤였다.
//   원장이 실패로 보고 다시 눌러 **학부모 13명이 같은 안내를 두 번 받았다**.
//
// 그래서 잠그는 것 두 가지:
//   ① 장부는 허용되지 않는 channel 값을 받아도 터지지 않는다.
//   ② 장부 기록 실패가 **발송 성공 판정을 뒤집지 않는다**(뒤집으면 중복 발송으로 이어진다).

const ledger = readFileSync(new URL("../src/lib/message-ledger.ts", import.meta.url), "utf8");
const adminActions = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
// 2026-11-18: 예약 문자 크론(/api/cron/scheduled-messages)은 예약을 넣는 길이 없어 지웠다 — 그 크론만 보던 단언도 뺐다.

test("① 장부는 허용 채널 목록으로 값을 거른다", () => {
  assert.match(ledger, /ALLOWED_DELIVERY_CHANNELS/);
  // 걸러진 값은 channel 에 들어가지 않는다.
  assert.match(ledger, /ALLOWED_DELIVERY_CHANNELS\.has\(rawChannel\)/);
});

test("① 코드의 허용 채널과 DB CHECK 제약이 정확히 일치한다", () => {
  // 둘이 어긋나면 둘 중 하나에서 조용히 터진다.
  //   · DB 가 좁으면 → 기록 실패(2026-08-03 LMS 사고)
  //   · 코드가 좁으면 → 값이 조용히 버려져 이력이 비어 보인다
  const migration = readFileSync(
    new URL("../prisma/migrations/20260803090000_widen_delivery_channel_check/migration.sql", import.meta.url),
    "utf8",
  );
  const fromDb = [...migration.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
  const block = /const ALLOWED_DELIVERY_CHANNELS = new Set\(\[([\s\S]*?)\]\)/.exec(ledger);
  assert.ok(block, "ALLOWED_DELIVERY_CHANNELS 선언을 찾지 못했다");
  const fromCode = [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fromCode)].sort(), [...new Set(fromDb)].sort());
});

test("① 코드 허용 목록이 실제 채널 타입을 모두 담는다", () => {
  const policy = readFileSync(new URL("../src/lib/message-channel-policy.ts", import.meta.url), "utf8");
  const declared = /export type MessageChannel = ([^;]+);/.exec(policy);
  assert.ok(declared, "MessageChannel 타입 선언을 찾지 못했다");
  const channels = [...declared[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).filter((c) => c !== "AUTO");
  for (const ch of channels) {
    assert.match(ledger, new RegExp(`"${ch}"`), `${ch} 가 장부 허용 목록에 없다 — 기록이 실패한다`);
  }
});

test("① 메시지 종류는 channel 이 아니라 messageType 칸에 기록된다", () => {
  assert.match(ledger, /"messageType" = COALESCE\(\$13, "messageType"\)/);
  // 예전처럼 같은 파라미터를 channel 과 messageType 에 함께 쓰면 안 된다.
  assert.doesNotMatch(ledger, /channel = COALESCE\(\$5, channel\),\s*\n\s*"messageType" = \$5/);
});

test("② 수동 발송: 장부 기록이 실패해도 발송 성공은 성공으로 보고한다", () => {
  const start = adminActions.indexOf("} catch (ledgerError) {");
  assert.ok(start > 0, "장부 실패 처리 블록을 찾지 못했다");
  const block = adminActions.slice(start, start + 900);
  // 공급자 응답(sent.ok)으로 판정해야 한다. 무조건 false 로 내리면 재발송을 유발한다.
  assert.match(block, /ok: sent\.ok/);
  assert.doesNotMatch(block, /ok: false,\s*\n\s*status: "UNCERTAIN"/);
  assert.match(block, /다시 보내지 마세요/, "원장이 재발송하지 않도록 문구로 알려야 한다");
});

test("예외를 로그 없이 삼키지 않는다(원인 추적 가능)", () => {
  // 08:00 발송이 왜 실패했는지 로그만으로는 끝내 알 수 없었던 원인.
  assert.match(adminActions, /console\.error\("\[manual-sms\] 장부 기록 실패/);
});
