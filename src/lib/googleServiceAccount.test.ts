import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node의 타입 제거 실행기는 런타임 확장자를 요구한다.
import { parseGoogleServiceAccount } from "./googleServiceAccount.ts";

test("JSON 바깥쪽의 리터럴 줄바꿈만 복구한다", () => {
  const raw = String.raw`{\n  "client_email": "sync@example.com",\n  "private_key": "line1\nline2"\n}`;
  const parsed = parseGoogleServiceAccount(raw);
  assert.equal(parsed.client_email, "sync@example.com");
  assert.equal(parsed.private_key, "line1\nline2");
});

test("필수 인증 항목이 없으면 비밀 내용을 포함하지 않은 오류를 낸다", () => {
  assert.throws(() => parseGoogleServiceAccount('{"type":"service_account"}'), /필수 항목/);
});
