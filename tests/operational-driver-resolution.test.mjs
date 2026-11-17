import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync("src/lib/operational-driver-resolution.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildDriverLookupContext, selectRosterDriverIds, operationalLinkForRole, DRIVER_NOTICE_LINK } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("월말 다음날과 BOTH는 요청 날짜의 월·요일·양방향(명단 방향 포함)을 그대로 사용한다", () => {
  assert.deepEqual(buildDriverLookupContext("2026-09-30", "BOTH"), {
    serviceMonth: "2026-09", dayOfWeek: "Wed", weekday: 3, directions: ["PICKUP", "DROPOFF"], rosterDirections: ["BOARD", "ALIGHT"],
  });
  assert.deepEqual(buildDriverLookupContext("2026-10-01", "PICKUP"), {
    serviceMonth: "2026-10", dayOfWeek: "Thu", weekday: 4, directions: ["PICKUP"], rosterDirections: ["BOARD"],
  });
  assert.deepEqual(buildDriverLookupContext("2026-10-01", "DROPOFF")?.rosterDirections, ["ALIGHT"]);
});

test("연말·윤년·일요일 요일과 잘못된 날짜", () => {
  assert.equal(buildDriverLookupContext("2026-12-31")?.dayOfWeek, "Thu");
  assert.equal(buildDriverLookupContext("2027-01-03")?.weekday, 0);
  assert.equal(buildDriverLookupContext("2028-02-29")?.dayOfWeek, "Tue");
  assert.equal(buildDriverLookupContext("2026-02-30"), null);
  assert.equal(buildDriverLookupContext("2026-9-1"), null);
});

test("그날 명단에 학생이 없거나 기사 계정이 없으면 기사 알림을 보류한다", () => {
  assert.deepEqual(selectRosterDriverIds([]), { driverIds: [], needsConfirmation: true });
  assert.deepEqual(selectRosterDriverIds([null, "", "  "]), { driverIds: [], needsConfirmation: true });
});

test("명단에 학생이 있으면 현재 기사 역할 전원에게, 같은 기사는 한 번만", () => {
  assert.deepEqual(selectRosterDriverIds(["driver-1", "driver-2", "driver-1"]), { driverIds: ["driver-1", "driver-2"], needsConfirmation: false });
});

// 2026-11-17 뒤로 가기 조사(native #12): 기사님이 받는 결석·셔틀 알림이 선생님 홈(/staff)을 가리켜 운행 화면으로 넘어갔다
test("알림 주소: 원장은 관리자 주소, 선생님은 직원 주소, 기사님은 선생님 홈 대신 셔틀 명단", () => {
  assert.equal(DRIVER_NOTICE_LINK, "/staff/shuttle");
  for (const role of ["ADMIN", "VICE_ADMIN"]) {
    assert.equal(operationalLinkForRole(role, "/admin/absence", "/staff"), "/admin/absence", role);
  }
  assert.equal(operationalLinkForRole("INSTRUCTOR", "/admin/absence", "/staff"), "/staff");
  assert.equal(operationalLinkForRole("DRIVER", "/admin/absence", "/staff"), "/staff/shuttle");
  // 운행 날짜를 알면 기사님은 그 날짜 명단을 연다(형식이 이상하면 날짜 없이)
  assert.equal(operationalLinkForRole("DRIVER", "/admin/absence", "/staff", "2026-11-20"), "/staff/shuttle?date=2026-11-20");
  assert.equal(operationalLinkForRole("DRIVER", "/admin/absence", "/staff", "내일"), "/staff/shuttle");
  assert.equal(operationalLinkForRole("INSTRUCTOR", "/admin/absence", "/staff", "2026-11-20"), "/staff");
  // 호출부가 셔틀 주소를 준 경우(날짜·방향 포함)는 그대로
  assert.equal(operationalLinkForRole("DRIVER", "/admin/shuttle", "/staff/shuttle?date=2026-11-14&focus=BOARD"), "/staff/shuttle?date=2026-11-14&focus=BOARD");
  // 직원 주소가 없으면 예전처럼 linkUrl
  assert.equal(operationalLinkForRole("INSTRUCTOR", "/admin/x"), "/admin/x");
  assert.equal(operationalLinkForRole("DRIVER", "/admin/x", null), "/admin/x");
});

test("알림 발송은 역할별 주소 함수 하나로만 주소를 고른다", () => {
  const sendSide = readFileSync("src/lib/operational-staff-notification.ts", "utf8");
  assert.match(sendSide, /linkUrl: operationalLinkForRole\(recipient\.role, input\.linkUrl, input\.staffLinkUrl, input\.driverContext\?\.serviceDate\),/);
  // 기사 수신자는 «DRIVER» 역할로 담긴다(주 역할이 학부모·선생님인 승인 기사님도 같은 주소를 받게)
  assert.match(sendSide, /recipients: selected\.driverIds\.map\(\(id\) => \(\{ id, role: "DRIVER" \}\)\)/);
});
