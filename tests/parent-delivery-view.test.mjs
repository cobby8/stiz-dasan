import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// 셔틀 변경 화면의 «알림 결과 한 줄» 판정 (2026-11-15 리뷰 필수 2).
// 예전 판정은 «받은 사람이 있나»만 봐서, 선생님만 받고 기사님은 못 받았는데도 «기사님께 알렸어요»가 나갈 수 있었다.
// 지금은 알림 장부의 «기사 행»을 따로 본다. 실제 함수를 불러 실행해 확인한다(장부 줄 → 요약 → 화면 글).

function load(file) {
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports });
  return module.exports;
}
const status = load("src/lib/parent-staff-status.ts");

// 장부 한 줄(받는 사람 × 채널)
const row = (role, channel, state, extra = {}) => ({ recipientUserId: `${role}-1`, studentId: "kid", channel, status: state, role, ...extra });
const view = (rows) => status.parentDeliveryView(status.summarizeDeliveryStatus(rows));

test("받는 사람 0명 → «알림을 못 보냈어요» + 전화 버튼", () => {
  const result = view([]);
  assert.equal(result.kind, "FAILED");
  assert.equal(result.text, "알림을 못 보냈어요. 학원에 전화해 주세요");
  assert.equal(result.call, true);
});

test("기사님 알림함에만(휴대폰 알림 꺼짐) → «기사님 알림함에 남겼어요» + 전화 버튼", () => {
  const off = view([row("DRIVER", "IN_APP", "SENT"), row("DRIVER", "PUSH", "SKIPPED", { errorCode: "NO_SUBSCRIPTION" })]);
  assert.equal(off.kind, "DRIVER_INBOX");
  assert.equal(off.text, "기사님 알림함에 남겼어요. 급하면 학원에 전화해 주세요");
  assert.equal(off.call, true);
  // 휴대폰 알림이 실패한 경우도 같다
  assert.equal(view([row("DRIVER", "IN_APP", "SENT"), row("DRIVER", "PUSH", "FAILED")]).kind, "DRIVER_INBOX");
  // 선생님 휴대폰 알림이 성공했어도 기사님은 알림함뿐이면 «기사님께 알렸다»고 하지 않는다
  assert.equal(view([row("DRIVER", "IN_APP", "SENT"), row("INSTRUCTOR", "IN_APP", "SENT"), row("INSTRUCTOR", "PUSH", "SENT")]).kind, "DRIVER_INBOX");
});

test("기사님은 실패 + 선생님은 성공 → «학원에 알렸어요»(기사님께 알렸다고 하지 않는다)", () => {
  const result = view([row("DRIVER", "PUSH", "FAILED"), row("INSTRUCTOR", "IN_APP", "SENT"), row("INSTRUCTOR", "PUSH", "SENT")]);
  assert.equal(result.kind, "ACADEMY");
  assert.equal(result.text, "학원에 알렸어요");
  assert.equal(result.call, false);
  // 기사님이 받는 사람에 아예 없고 선생님만 받은 경우도 같다
  assert.equal(view([row("INSTRUCTOR", "IN_APP", "SENT")]).kind, "ACADEMY");
});

test("정상: 기사님 휴대폰 알림이 나감 → «기사님께 알렸어요»(전화 버튼 없음)", () => {
  const result = view([row("DRIVER", "IN_APP", "SENT"), row("DRIVER", "PUSH", "SENT"), row("INSTRUCTOR", "IN_APP", "SENT")]);
  assert.equal(result.kind, "DRIVER");
  assert.equal(result.text, "기사님께 알렸어요");
  assert.equal(result.call, false);
  // 기기 여러 대 중 일부만 받은 경우(PARTIAL)도 «나갔다»로 본다
  assert.equal(view([row("DRIVER", "PUSH", "PARTIAL")]).kind, "DRIVER");
});

test("아무에게도 못 감(전부 실패) → 실패 / 아직 보내는 중·결과 모름 → 줄을 그리지 않는다(null)", () => {
  assert.equal(view([row("DRIVER", "PUSH", "FAILED"), row("INSTRUCTOR", "PUSH", "FAILED")]).kind, "FAILED");
  assert.equal(view([row("DRIVER", "PUSH", "PENDING")]), null, "보내는 중이면 실패라고 하지 않는다");
  assert.equal(status.parentDeliveryView(null), null);
  assert.equal(status.parentDeliveryView(undefined), null);
});

test("요약의 기사 파생값은 «기사 행»만 본다 — 기존 건수는 그대로(전달 동작 불변)", () => {
  const summary = status.summarizeDeliveryStatus([row("DRIVER", "IN_APP", "SENT"), row("INSTRUCTOR", "PUSH", "SENT")]);
  assert.equal(summary.driverLinked, true);
  assert.equal(summary.driverInApp, true);
  assert.equal(summary.driverPushDelivered, false, "선생님 휴대폰 알림 성공을 기사님 것으로 세지 않는다");
  assert.equal(summary.inAppCount, 1);
  assert.equal(summary.pushAcceptedCount, 1);
  assert.equal(summary.recipientCount, 2);
});

test("화면은 이 판정 한 곳만 쓴다 — 전화 버튼은 설정값 번호(없으면 글자만), 홈 문의 폼으로 보내지 않는다", () => {
  const client = fs.readFileSync("src/app/mypage/shuttle/ShuttleExceptionClient.tsx", "utf8");
  assert.match(client, /function parentDeliveryText\(summary: DeliveryStatusSummary \| null \| undefined\): string \{\s*return parentDeliveryView\(summary\)\?\.text \?\? "";/);
  assert.match(client, /\{done && notifyCall && \([\s\S]{0,500}<CallAcademy phone=\{academyPhone\} \/>/);
  assert.match(client, /if \(tel\.length < 8\) return null;\s*return <a href=\{`tel:\$\{tel\}`\}/);
  assert.doesNotMatch(client, /parent-request-form|driverLinked === false/);
  // 번호는 코드에 박지 않고 설정값에서 — 자리채움 번호(010-0000-0000)는 쓰지 않는다
  const page = fs.readFileSync("src/app/mypage/shuttle/page.tsx", "utf8");
  assert.match(page, /getUsableAcademyPhone\(\)/);
  const phone = fs.readFileSync("src/lib/academyPhone.ts", "utf8");
  assert.match(phone, /digits\.length < 8 \|\| digits === "01000000000"\) return null;/);
});

test("가족 연결 화면: 문의는 «학원에 전화하기»(설정값 번호) — 자녀 없는 계정이 못 쓰는 홈 문의 폼 링크는 없다", () => {
  const client = fs.readFileSync("src/app/mypage/children/ChildConnectionsClient.tsx", "utf8");
  assert.doesNotMatch(client, /parent-request-form/);
  assert.match(client, /academyTel\.length >= 8\s*\? <a href=\{`tel:\$\{academyTel\}`\}[^>]*>학원에 전화하기<\/a>\s*: null;/);
  assert.equal((client.match(/\{callAcademy\}/g) || []).length, 2, "목록에 없는 아이 · 가족에게 요청 두 곳");
  assert.match(client, /먼저 연결된 보호자가 없는 미성년 자녀는 이 요청으로 연결되지 않아요/);
  // 성인 수강생 안내는 /account/children 맥락에서만
  assert.match(client, /const accountContext = backHref !== "\/mypage";/);
  assert.match(client, /\{accountContext \? " 성인 수강생은 본인 이름·생년월일·등록된 휴대폰 번호로 확인해요\." : ""\}/);
  for (const page of ["src/app/mypage/children/page.tsx", "src/app/account/children/page.tsx"]) {
    assert.match(fs.readFileSync(page, "utf8"), /academyPhone=\{await getUsableAcademyPhone\(\)\}/, page);
  }
});
