import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ATTENDANCE_TONE, PAYMENT_TONE, REQUEST_TONE, SHUTTLE_TONE, STATUS_TONES,
  TONE_BADGE_CLASS, TONE_BORDER_CLASS, TONE_SOLID_CLASS, TONE_TEXT_CLASS, statusBadgeClass, toneFor,
} from "../src/lib/ui/statusTones.ts";

// 상태 → 색 지도 한 곳(2026-11-09 원장 결정 · 색상 정리 3단계)을 못 박는다.
// 같은 «대기중»이 화면마다 달랐던 것을 되풀이하지 않게, 업무별 뜻 배정이 결정표와 같은지 본다.

test("출결: 출석 정상 · 지각 주의 · 결석 위험 · 보강 정보 · 휴무 중립", () => {
  assert.deepEqual(
    ["PRESENT", "LATE", "ABSENT", "MAKEUP", "HOLIDAY"].map((s) => ATTENDANCE_TONE[s]),
    ["success", "warning", "danger", "info", "neutral"],
  );
});

test("결제: 납부 정상 · 미납 주의 · 연체 위험 · 입금 확인 중 정보 · 환불/취소 중립", () => {
  assert.deepEqual(
    ["PAID", "PENDING", "OVERDUE", "CONFIRMING", "REFUNDED", "CANCELED"].map((s) => PAYMENT_TONE[s]),
    ["success", "warning", "danger", "info", "neutral", "neutral"],
  );
});

test("셔틀: 탑승 정상 · 체크 대기 주의 · 미탑승/결석 위험 · 오늘만 변경 정보 · 자차 중립(보라 없음)", () => {
  assert.deepEqual(
    ["BOARDED", "PENDING", "NOSHOW", "ABSENT", "CHANGED", "SELF"].map((s) => SHUTTLE_TONE[s]),
    ["success", "warning", "danger", "danger", "info", "neutral"],
  );
  const css = readFileSync("src/components/shuttle/DriverWorkspace.module.css", "utf8");
  assert.match(css, /--color-driver-self: var\(--color-academy-neutral\)/);
  assert.match(css, /--color-driver-note: var\(--color-academy-info\)/);
  assert.doesNotMatch(css, /#6b46c1|#2557a7/, "기사님 화면만 따로 쓰던 보라·파랑이 없다");
});

test("신청: 승인 정상 · 대기 주의 · 반려 위험", () => {
  assert.deepEqual(["APPROVED", "PENDING", "REQUESTED", "REJECTED"].map((s) => REQUEST_TONE[s]), ["success", "warning", "warning", "danger"]);
  assert.equal(REQUEST_TONE.NO_SHOW, "danger", "체험 노쇼 = 위험(리뷰 지적·PM 결정)");
});

test("모르는 상태는 중립 — «정상»처럼 보이게 하지 않는다", () => {
  assert.equal(toneFor(PAYMENT_TONE, "SOMETHING_NEW"), "neutral");
  assert.equal(toneFor(PAYMENT_TONE, null), "neutral");
  assert.equal(toneFor(PAYMENT_TONE, "OVERDUE", "warning"), "danger");
});

test("다섯 갈래 모두 배지·글자·채움·테두리 클래스가 있고, 색은 토큰(var)만 쓴다", () => {
  for (const tone of STATUS_TONES) {
    for (const map of [TONE_BADGE_CLASS, TONE_TEXT_CLASS, TONE_SOLID_CLASS, TONE_BORDER_CLASS]) {
      assert.ok(map[tone], tone);
      assert.doesNotMatch(map[tone], /#[0-9a-f]{3,6}|-(red|green|amber|yellow|blue|gray)-\d/i, `${tone}: ${map[tone]}`);
    }
  }
  assert.equal(statusBadgeClass("info"), "bg-[var(--color-academy-info-soft)] text-[var(--color-academy-info)]");
});
