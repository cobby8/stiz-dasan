import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync("src/app/request/reconfirm/[token]/page.tsx", "utf8");
const client = fs.readFileSync("src/app/request/reconfirm/[token]/KakaoParentReconfirmationClient.tsx", "utf8");

test("일회용 토큰의 서버 조회와 확정 함수만 사용한다", () => {
  assert.match(page, /getKakaoParentReconfirmationPreview\(token\)/);
  assert.match(page, /confirmKakaoParentReconfirmation\(token\)/);
  assert.doesNotMatch(client, /textarea|type="date"|<select/);
});

test("관리자 보완 내용을 읽기 전용으로 요약한다", () => {
  for (const label of ["확인할 학생","요청 종류","적용일","현재 수업","희망 수업","셔틀 요청","상세 내용"]) assert.match(client, new RegExp(label));
  assert.match(client, /학생의 위 요청 내용이 맞음을 확인했습니다/);
  assert.match(client, /확인한 내용으로 확정/);
  assert.match(client, /preview\.fromClassLabel/);
  assert.match(client, /preview\.toClassLabel/);
  assert.doesNotMatch(client, /fromClassName|toClassName/);
});

test("링크 상태와 외부 반영 안전 경계를 분명히 안내한다", () => {
  for (const status of ["INVALID","EXPIRED","USED","NOT_REQUIRED","CONFIRMED"]) assert.match(client, new RegExp(status));
  assert.match(client, /원장님의 최종 승인 전까지/);
  assert.match(client, /시트·랠리즈·사이트 반영은 보류/);
  assert.match(client, /일회용 링크/);
});
