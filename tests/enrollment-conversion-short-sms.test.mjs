import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertSolapiShortSms,
  getSolapiSmsByteLength,
  isSolapiShortSms,
  SOLAPI_SMS_MAX_BYTES,
} from "../src/lib/sms-byte-length.ts";

const recommendedBody = (shortUrl) =>
  `스티즈 수강신청서\n링크에서 작성해주세요 :)\n${shortUrl}`;

test("솔라피 단문 계산은 한글 2바이트, ASCII와 줄바꿈은 1바이트다", () => {
  assert.equal(getSolapiSmsByteLength("가A1 \n:)"), 8);
});

test("권장 문구와 공식 도메인의 16자 코드는 90바이트 이내다", () => {
  const body = recommendedBody("https://www.stiz-dasan.kr/e/Ab3x9KCd7Ef9Gh2J");

  assert.equal(getSolapiSmsByteLength(body), 87);
  assert.equal(isSolapiShortSms(body), true);
  assert.doesNotThrow(() => assertSolapiShortSms(body));
});

test("90바이트는 SMS이고 한 바이트라도 넘으면 공급자 호출 전에 실패한다", () => {
  const baseBody = recommendedBody("https://stiz.kr/e/");
  const remaining = SOLAPI_SMS_MAX_BYTES - getSolapiSmsByteLength(baseBody);
  const exactBoundary = `${baseBody}${"A".repeat(remaining)}`;

  assert.equal(getSolapiSmsByteLength(exactBoundary), 90);
  assert.equal(isSolapiShortSms(exactBoundary), true);
  assert.doesNotThrow(() => assertSolapiShortSms(exactBoundary));

  const oversized = `${exactBoundary}A`;
  assert.equal(getSolapiSmsByteLength(oversized), 91);
  assert.equal(isSolapiShortSms(oversized), false);
  assert.throws(
    () => assertSolapiShortSms(oversized),
    /SMS_BODY_TOO_LONG:91\/90/,
  );
});

// 2026-11-07: 준비물·스포츠고글 제휴 안내가 들어가며 수강신청 안내는 장문(LMS)도 허용한다.
test("등록전환 발송부는 단문 강제 없이 추적 발송하고 학원 전화를 넘긴다", () => {
  const admin = readFileSync(
    new URL("../src/app/actions/admin.ts", import.meta.url),
    "utf8",
  );
  const start = admin.indexOf("export async function sendPostTrialEnrollGuide");
  const end = admin.indexOf("type TrialApplicationSmsResendResult", start);
  const body = admin.slice(start, end);

  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(body, /assertSolapiShortSms|forceSms/);
  assert.match(body, /templateVariables = \{ childName, parentName, enrollLink, academyPhone \}/);
  assert.match(
    body,
    /eventType:\s*"TRIAL_ENROLL_GUIDE"[\s\S]*?eventId:\s*`trial:\$\{trialLeadId\}:enroll-guide`/,
  );
});

test("90바이트를 통과한 안내만 공급자에 SMS로 강제 전달한다", () => {
  const notification = readFileSync(new URL("../src/lib/notification.ts", import.meta.url), "utf8");
  const dispatch = readFileSync(new URL("../src/lib/message-dispatch.ts", import.meta.url), "utf8");
  const sms = readFileSync(new URL("../src/lib/sms.ts", import.meta.url), "utf8");

  assert.match(notification, /forceSms:\s*input\.forceSms/);
  assert.match(dispatch, /input\.forceSms[\s\S]*?\{\s*messageType:\s*"SMS"\s*\}/);
  assert.match(sms, /const messageType = options\?\.messageType \?\? getSmsMessageType\(body\)/);
});
