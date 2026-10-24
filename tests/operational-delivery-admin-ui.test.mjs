import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const api = await readFile("src/app/api/admin/operational-deliveries/route.ts", "utf8");
const client = await readFile("src/app/admin/notification-deliveries/OperationalDeliveryClient.tsx", "utf8");

test("운영 전달 장부 API는 내부 결석·셔틀 알림만 조회한다", () => {
  assert.match(api, /d\.source='AUTO'/);
  assert.match(api, /d\."audienceScope"='INTERNAL'/);
  assert.match(api, /d\.trigger IN \('ABSENCE','SHUTTLE_EXCEPTION'\)/);
  assert.match(api, /d\.channel IN \('IN_APP','PUSH'\)/);
});

test("전달 장부 API는 푸시 payload와 연락처를 반환하지 않는다", () => {
  const selectClause = api.slice(api.indexOf("`SELECT"), api.indexOf("FROM \"NotificationDelivery\""));
  assert.doesNotMatch(selectClause, /payloadJSON|recipientPhone|endpoint/);
  assert.doesNotMatch(api, /errorCode: row\.errorCode/);
});

test("푸시 미설정과 구독 없음은 인앱 알림을 별도 확인하도록 안내한다", () => {
  assert.match(api, /VAPID_NOT_CONFIGURED/);
  assert.match(api, /푸시 발송 설정이 완료되지 않았습니다\. 사이트 내부 알림은 별도로 확인해 주세요\./);
  assert.match(api, /푸시 구독이 없습니다\. 사이트 내부 알림은 별도로 확인해 주세요\./);
});

test("관리자 화면은 상태·채널 필터와 안전한 전달 정보를 표시한다", () => {
  for (const label of ["전체", "확인 필요", "처리 중", "성공", "사이트 알림", "휴대폰 푸시"]) {
    assert.match(client, new RegExp(label));
  }
  assert.match(client, /studentName/);
  assert.match(client, /recipientRole/);
  assert.match(client, /attemptCount/);
  assert.doesNotMatch(client, /수동 재시도|재발송/);
});
