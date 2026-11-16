// 대관 신청자 앱 알림(종·푸시) — 2026-11-16 원장 지시: 앱에서 신청·승인했는데 알림이 안 왔다(문자만 나가던 구조)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const r = await loadTsModule("src/lib/rental/gym-rental-rules.ts");
const base = { applicantName: "김보호", applicantPhone: "01012345678", rentalDate: "2026-11-21", startHour: 10, endHour: 12, startMinute: 600, endMinute: 720,
  headcount: 6, useAircon: false, usageFee: 0, deposit: 0, totalAmount: 0, memberFree: true };

test("무료 승인(바로 확정 PAID)은 «확정» 문구, 유료 승인은 금액과 «입금하면 확정», 거절은 사유", () => {
  const free = r.buildRentalAppNotice("approved", { ...base, status: "PAID" });
  assert.equal(free.title, "체육관 대관이 확정됐어요");
  assert.match(free.message, /^2026년 11월 21일\(토\) 10:00~12:00/);
  const paid = r.buildRentalAppNotice("approved", { ...base, status: "APPROVED", totalAmount: 30000, memberFree: true });
  assert.equal(paid.title, "체육관 대관이 승인됐어요");
  assert.match(paid.message, /30,000원을 입금하면 확정돼요/);
  assert.doesNotMatch(paid.message, /\d{6,}/, "계좌번호를 앱 알림에 넣지 않는다");
  const rej = r.buildRentalAppNotice("rejected", { ...base, rejectReason: "그 시간 수업 있음" });
  assert.equal(rej.title, "체육관 대관 신청이 거절됐어요");
  assert.match(rej.message, /사유: 그 시간 수업 있음/);
  assert.equal(r.buildRentalAppNotice("confirmed", { ...base, status: "PAID" }).title, "체육관 대관이 확정됐어요");
});

test("승인·거절·확정 처리와 내용 수정 재안내에서 문자와 함께 앱 알림을 보낸다(계정 없는 외부 손님은 건너뜀)", () => {
  const action = readFileSync("src/app/actions/rental.ts", "utf8");
  assert.match(action, /sms = await sendRentalApplicantSms\(kind, r\);\s*\/\/[^\n]*\n\s*if \(kind !== "received"\) await sendRentalApplicantAppNotice\(kind, r\);/);
  assert.match(action, /await sendRentalApplicantAppNotice\(kind, result\.request\);/);
  const notify = readFileSync("src/lib/rental/gym-rental-notify.ts", "utf8");
  assert.match(notify, /if \(!request\.applicantUserId\) return false;/);
  assert.match(notify, /linkUrl: "\/mypage\/rental"/);
});
