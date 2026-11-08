import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * 관리자 «현장 결제» 창 문구·흐름 고정 (2026-11-08 개편).
 *
 * 토스 POS 플러그인이 주문 메모·금액을 넣고 결제창을 자동으로 열게 되면서,
 * 사람이 결제 번호를 보고 POS 메모에 옮겨 적던 단계를 화면에서 없앴다.
 * 옛 안내(번호를 메모에 넣어라·30분·메모를 빼면…)가 되살아나면 선생님이 할 필요 없는 일을 하게 되므로 막는다.
 * 결제 번호(shortCode)는 서버 매칭용 내부 값이라 보류·지난 요청 줄의 작은 글씨로만 남는다.
 */

const MODAL = "src/app/admin/finance/PosChargeRequestModal.tsx";

test("상태별 문구가 새 흐름대로 있다", async () => {
  const code = await readFile(MODAL, "utf8");
  // 대기 요청 없음 / 지난 요청 → 다시 보내기
  assert.match(code, /POS로 결제 보내기/);
  assert.match(code, /을 토스 POS 로 보낼까요\? POS에 결제창이 바로 열립니다\./);
  // PENDING·SENT
  assert.match(code, /POS로 보냈어요 · 결제 기다리는 중/);
  assert.match(code, /보통 몇 초 안에 POS에 결제창이 열려요\. 안 열리면 POS의 STIZ 탭에서 결제할 수 있어요\./);
  assert.match(code, />\s*요청 취소\s*</);
  assert.match(code, /tone: "danger"/, "요청 취소는 위험 작업 확인 창을 거친다");
  // PAID
  assert.match(code, /납부완료로 반영됐습니다/);
  assert.doesNotMatch(code, /랠리즈/, "랠리즈 사용 중단(2026-11-08) — 랠리즈 처리 안내 없음");
  // HELD
  assert.match(code, /자동 반영 보류/);
  assert.match(code, /슬랙 결제 확인 알림에서 처리해 주세요\./);
  // EXPIRED·CANCELLED
  assert.match(code, /지난 요청 · /);
  assert.match(code, /CANCELLED: "취소됨"/);
  assert.match(code, /EXPIRED: "만료됨"/);
});

test("사람이 번호를 옮겨 적던 옛 안내·버튼이 없다", async () => {
  const code = await readFile(MODAL, "utf8");
  for (const old of [
    /주문 메모에/,
    /30분 동안/,
    /메모를 빼면/,
    /결제 번호 만들기/,
    /번호 취소/,
    /결제 확인<|"결제 확인"/,
    /request\.memo/,
    /text-5xl/,
  ]) {
    assert.doesNotMatch(code, old, `옛 흐름 흔적: ${old}`);
  }
});

test("기다리는 동안만 3초마다 자동으로 다시 읽고, 탭이 숨겨지거나 창이 닫히면 멈춘다", async () => {
  const code = await readFile(MODAL, "utf8");
  assert.match(code, /const POS_CHARGE_POLL_MS = 3000;/);
  assert.match(code, /setInterval\(\(\) => void refresh\(\), POS_CHARGE_POLL_MS\)/);
  // 대기 상태에서만 켠다
  assert.match(code, /if \(!isWaiting\) return;/);
  // 탭 숨김 감지
  assert.match(code, /document\.visibilityState === "visible"/);
  assert.match(code, /addEventListener\("visibilitychange"/);
  assert.match(code, /removeEventListener\("visibilitychange"/);
  // 정리 함수에서 타이머를 멈춘다(창 닫힘)
  assert.match(code, /clearInterval\(timer\)/);
});

test("POS 가 90초 넘게 안 받아 가면(PENDING) 확인 안내 · 요청은 자동 취소하지 않는다 · 오류가 나도 «보내는 중…»에서 굳지 않는다", async () => {
  const code = await readFile(MODAL, "utf8");
  assert.match(code, /request\.status === "PENDING" && request\.pickupLate/);
  assert.match(code, /POS가 응답이 없어요\. POS가 켜져 있고 STIZ 탭이 연결돼 있는지 확인해 주세요\./);
  // 보내기·요청 취소 둘 다 finally 에서 busy 를 푼다
  assert.equal((code.match(/finally \{\s*if \(mountedRef\.current\) setBusy\(false\);/g) ?? []).length, 2);
  assert.doesNotMatch(code, /pickupLate[^\n]*cancelPosChargeRequest/, "무응답이어도 요청을 자동 취소하지 않는다");
});
