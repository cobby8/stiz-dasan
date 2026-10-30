import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const adminActions = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");

test("보강 «취소» 버튼도 상태 변경과 같은 길(잠금 + 보강권 복구)을 탄다", () => {
  const start = adminActions.indexOf("export async function cancelMakeupSession");
  const end = adminActions.indexOf("export async function updateMakeupStatus");
  assert.ok(start > 0 && end > start, "cancelMakeupSession 다음에 updateMakeupStatus 가 있어야 한다");
  const body = adminActions.slice(start, end);
  // 예전엔 MakeupSession 만 직접 UPDATE 해서 보강권이 RESERVED 로 묶였다
  assert.match(body, /updateMakeupStatus\(id, "CANCELLED"\)/);
  assert.doesNotMatch(body, /UPDATE "MakeupSession"/);
});
