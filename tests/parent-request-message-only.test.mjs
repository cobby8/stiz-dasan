import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 원장 지적(2026-08-09): "학원에 요청하기"가 결석 신고와 겹치는데 실제 기능과 연결이 안 된
// 메모였다. 유형별로 나눠 받으면 그 유형대로 처리되는 것처럼 보인다.
// → 진짜 기능이 있는 것(결석)은 그 기능으로 보내고, 나머지는 자유 메시지 하나로 받는다.
// (요청하기 자체의 제거는 카카오 채널이 붙을 때 함께 한다 — 지금 지우면 문의 창구가 없어진다)

const client = await readFile("src/app/mypage/MyPageClient.tsx", "utf8");
const action = await readFile("src/app/actions/admin.ts", "utf8");

test("요청 유형 선택이 화면에서 사라졌다", () => {
  assert.doesNotMatch(client, /const REQUEST_TYPES = \[/);
  assert.doesNotMatch(client, /setReqType/);
  assert.doesNotMatch(client, /"EARLY_LEAVE"/);
});

test("보내는 값은 항상 자유 메시지(OTHER)다", () => {
  assert.match(client, /type: "OTHER"/);
  assert.match(client, /title: `\$\{child\.name\} 문의\$\{dateLabel\}`/);
});

test("결석은 메시지가 아니라 결석 기능으로 보낸다", () => {
  // 여기 적으면 셔틀 자동 제외가 안 되므로 반드시 길을 안내해야 한다.
  assert.match(client, /결석은 여기 적지 마시고[\s\S]{0,200}\/mypage\/regular-absence/);
  assert.match(client, /\/mypage\/seasonal/);
});

test("셔틀 변경은 전용 처리 화면으로 보내고 자유 메시지와 구분한다", () => {
  assert.match(client, /\/mypage\/shuttle/);
  assert.doesNotMatch(client, /setReqContent\(\(prev\) => prev \|\| "셔틀 변경 요청: "\)/);
});

test("서버는 기존 유형을 계속 받아들인다", () => {
  // 화면만 좁혔다. 서버까지 좁히면 예전 데이터·다른 경로가 깨진다.
  assert.match(action, /allowedTypes = new Set\(\["ABSENCE", "SHUTTLE", "EARLY_LEAVE", "OTHER"\]\)/);
});

test("문구가 메시지 형태로 통일됐다", () => {
  for (const label of ["학원에 메시지 보내기", "보낸 메시지", "메시지 보내기", "보낸 메시지가 없습니다"]) {
    assert.ok(client.includes(label), `${label} 문구가 있어야 합니다.`);
  }
  assert.doesNotMatch(client, /요청 접수하기/);
});
