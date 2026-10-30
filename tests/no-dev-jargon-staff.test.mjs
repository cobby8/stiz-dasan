// 선생님 앱·기사님 화면에 개발 용어(영어 오류 원문·«서버»·영어 상태값)가 다시 보이지 않게 막는 회귀 테스트
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// 도우미를 실제로 실행해 본다(TS → CJS 로 바꿔 불러오기)
function loadHelper() {
  const source = read("src/components/staff/userErrorMessage.ts");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", "require", js)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
}

test("오류 도우미는 한국어 안내문만 그대로 보이고, 영어 원문·개발 용어는 쉬운 문장으로 바꾼다", () => {
  const { userErrorMessage } = loadHelper();
  const quiet = console.error;
  console.error = () => {}; // 원문 로그는 테스트 출력에서 숨긴다
  try {
    const fallback = "저장하지 못했습니다.";
    assert.equal(userErrorMessage(new Error("링크가 만료되었습니다. 학원에 새 링크를 요청해 주세요."), fallback), "링크가 만료되었습니다. 학원에 새 링크를 요청해 주세요.");
    assert.equal(userErrorMessage(new TypeError("Failed to fetch"), fallback), fallback);
    assert.equal(userErrorMessage(new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"), fallback), fallback);
    assert.equal(userErrorMessage("invalid body", fallback), fallback);
    assert.equal(userErrorMessage("token, serviceDate, type 필수", fallback), fallback);
    assert.equal(userErrorMessage("enrollmentDateId required", fallback), fallback);
    assert.equal(userErrorMessage("네트워크 오류(503)", fallback), fallback);
    assert.equal(userErrorMessage("서버 연결에 실패했습니다.", fallback), fallback);
    assert.equal(userErrorMessage(undefined, fallback), fallback);
    assert.equal(userErrorMessage({ code: "X" }, fallback), fallback);
    assert.equal(userErrorMessage("GPS 신호를 확인해 주세요.", fallback), "GPS 신호를 확인해 주세요.");
  } finally {
    console.error = quiet;
  }
});

// 화면 파일들: 오류 원문(err.message)을 바로 setState 하지 않는다
const SCREENS = [
  "src/app/staff/quick-post/QuickPostClient.tsx",
  "src/app/staff/seasonal/StaffSeasonalClient.tsx",
  "src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx",
  "src/app/staff/shuttle/ShuttleRideStatusButtons.tsx",
  "src/app/shuttle/location/[token]/RegularShuttleLocationClient.tsx",
  "src/app/invite/[token]/InviteAcceptForm.tsx",
  "src/components/staff/ClassBillingSheet.tsx",
  "src/components/staff/ClassPeopleSheet.tsx",
  "src/components/staff/SessionPhotoUploader.tsx",
  "src/components/staff/VoiceToTextButton.tsx",
  "src/components/shuttle/RegularRouteSection.tsx",
  "src/components/shuttle/RegularStopGeocodePanel.tsx",
  "src/components/shuttle/ShuttleGeoEditor.tsx",
  "src/components/shuttle/UnifiedDriverClient.tsx",
];

test("선생님·기사님 화면은 오류 원문을 그대로 띄우지 않고 userErrorMessage 를 거친다", () => {
  for (const file of SCREENS) {
    const source = read(file);
    assert.match(source, /userErrorMessage\(/, `${file}: 도우미를 쓰지 않는다`);
    assert.doesNotMatch(source, /instanceof Error \? \w+\.message/, `${file}: 오류 원문을 그대로 보여 준다`);
    assert.doesNotMatch(source, /\(e as Error\)\.message|e\?\.message \|\|/, `${file}: 오류 원문을 그대로 보여 준다`);
    assert.doesNotMatch(source, /text: result\.error,|setPasswordError\(result\.error\)|setMessage\(data\.error \|\|/, `${file}: 서버 문구를 거르지 않는다`);
  }
});

test("기사님 운행 화면에 «서버» 같은 내부 용어가 보이지 않는다", () => {
  const source = read("src/components/shuttle/UnifiedDriverClient.tsx");
  // 주석은 빼고, 한 줄 안의 큰따옴표 문자열만 본다
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)).join("\n");
  assert.doesNotMatch(code, /"[^"\n]*서버[^"\n]*"/);
  assert.match(source, /저장 상태 확인 완료/);
  assert.match(source, /바뀌지 않았습니다 · 지금 저장된 상태를 보여 드려요/);
  assert.match(source, /운행 종료가 저장됐는지 확인해 주세요/);
});

test("선생님 공지 안내에 «장부·근거·푸시 접수·재처리» 같은 내부 말이 남지 않는다", () => {
  const source = read("src/app/staff/StaffHomeClient.tsx");
  for (const word of ["알림 장부", "수신자 근거", "푸시 접수는", "누락 알림 재처리", "결과 확인 필요: 저장 여부를 조회"]) {
    assert.ok(!source.includes(word), `남은 말: ${word}`);
  }
  // 버튼 문구와 안내문이 같은 이름을 가리킨다
  assert.match(source, />빠진 알림 다시 보내기</);
  assert.match(source, /«빠진 알림 다시 보내기»/);
});

test("수납·초대 화면은 모르는 상태값·역할값을 영어 원문으로 보여 주지 않는다", () => {
  const billing = read("src/app/staff/billing/StaffBillingClient.tsx");
  assert.doesNotMatch(billing, /\?\? (bill|detail)\.status/);
  assert.match(billing, /labels\[status\] \?\? "확인 필요"/);
  const invite = read("src/app/invite/[token]/page.tsx");
  assert.doesNotMatch(invite, /\|\| invitation\.role\}/);
  const form = read("src/app/invite/[token]/InviteAcceptForm.tsx");
  assert.doesNotMatch(form, /이메일 \(ID\)/);
});
