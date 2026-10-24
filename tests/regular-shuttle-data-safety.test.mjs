import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { validateRegularDispatchVehicles } from "../src/lib/regular/regularDispatchPayload.ts";
import { koreaServiceMonth } from "../src/lib/regular/serviceMonth.ts";

// Node 직접 실행에서도 앱과 같은 TypeScript 원본을 변환해 검증한다.
const orderPayloadTs = readFileSync("src/lib/regular/regularOrderPayload.ts", "utf8")
  .replace(/import \{ isServiceMonth \} from "\.\/serviceMonth";\s*/, "");
const serviceMonthTs = readFileSync("src/lib/regular/serviceMonth.ts", "utf8");
const transpiledOrderPayload = ts.transpileModule(`${serviceMonthTs}\n${orderPayloadTs}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { validateRegularStopOrderPayload } = await import(`data:text/javascript;base64,${Buffer.from(transpiledOrderPayload).toString("base64")}`);

const importSource = readFileSync("src/lib/shuttle/regularImport.ts", "utf8");
const rosterEdit = readFileSync("src/lib/shuttle/regularRosterEdit.ts", "utf8");
const sheetImportApi = readFileSync("src/app/api/admin/shuttle/regular-import/route.ts", "utf8");
const roster = readFileSync("src/lib/regular/shuttleRoster.ts", "utf8");
const diff = readFileSync("src/lib/regular/regularShuttleDiff.ts", "utf8");
const route = readFileSync("src/lib/regular/regularDispatchRoute.ts", "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");
const parent = readFileSync("src/lib/shuttle/parent.ts", "utf8");
const orderApi = readFileSync("src/app/api/admin/shuttle/regular-order/route.ts", "utf8");
const noticeApi = readFileSync("src/app/api/admin/shuttle/regular-notice/route.ts", "utf8");

// 2026-10-02 구글 시트 가져오기 종료 — 앱에서 편집한 명단이 시트 기준으로 덮어써지면 안 된다.
test("구글 시트 가져오기 API 는 410 으로 막고 DB 를 건드리지 않는다", () => {
  assert.match(sheetImportApi, /status: 410/);
  assert.match(sheetImportApi, /구글 시트 가져오기는 종료됐습니다\. 셔틀 명단 화면에서 직접 편집하세요\./);
  assert.doesNotMatch(sheetImportApi, /prisma|importRegularShuttleFromSheet|request\.json/);
  assert.doesNotMatch(importSource, /importRegularShuttleFromSheet|docs\.google\.com|fetch\(/);
});

test("셔틀 명단 삭제는 id·월 단위로만 하고 월 전체를 지우지 않는다", () => {
  assert.match(rosterEdit, /DELETE FROM "RegularShuttleStop"\s+WHERE "id" = ANY\(\$1::text\[\]\) AND "serviceMonth"=\$2/);
  assert.doesNotMatch(rosterEdit, /DELETE FROM "RegularShuttleStop"\s+WHERE "serviceMonth"=\$1/);
  assert.doesNotMatch(importSource, /DELETE FROM "RegularShuttleStop"/);
});

test("정규 차량표는 studentId를 저장하고 월 비교·배차가 이를 우선한다", () => {
  assert.match(schema, /model RegularShuttleStop[\s\S]*studentId\s+String\?/);
  assert.match(rosterEdit, /"studentName","studentId","studentPhone"/);
  assert.match(diff, /if \(stop\.studentId\) return `student:\$\{stop\.studentId\}`/);
  assert.match(roster, /COALESCE\(rss\."studentId", st\."id", 'stop:' \|\| rss\."id"\)/);
});

test("학부모 ETA는 요청한 월의 확정 배차만 읽는다", () => {
  assert.match(route, /getConfirmedRegularDispatchEtas\([\s\S]*serviceMonth: string = koreaServiceMonth\(\)/);
  assert.match(route, /AND "serviceMonth"=\$2/);
  assert.match(route, /dows, serviceMonth/);
  assert.match(parent, /routePlan\.serviceDate/);
  assert.match(parent, /getConfirmedRegularDispatchEtas\(pairs, serviceMonth\)/);
});

test("한국시간 월 경계는 UTC 월과 달라도 한국 월을 반환한다", () => {
  assert.equal(koreaServiceMonth(new Date("2026-08-31T15:30:00.000Z")), "2026-09");
});

test("확정 배차 payload는 최소 구조와 학생 중복을 검증한다", () => {
  const valid = [{ driverUserId: "driver-1", stops: [{ label: "정문", lat: 37.6, lng: 127.1, students: [{ requestId: "student-1" }] }] }];
  assert.equal(validateRegularDispatchVehicles(valid), valid);
  assert.throws(() => validateRegularDispatchVehicles([{ stops: [{ label: "", students: [] }] }]));
  assert.throws(() => validateRegularDispatchVehicles([{ stops: [{ label: "정문", students: [{ requestId: "a" }, { requestId: "a" }] }] }]));
  assert.throws(() => validateRegularDispatchVehicles(new Array(21).fill({ stops: [] })));
  assert.throws(() => validateRegularDispatchVehicles([{ stops: [{ label: "정문", lat: 91, lng: 127, students: [] }] }]));
  assert.throws(() => validateRegularDispatchVehicles([{ stops: [{ label: "정문", etaMinutes: -1, students: [] }] }]));
  assert.throws(() => validateRegularDispatchVehicles([{ driverUserId: "", stops: [] }]));
  assert.throws(() => validateRegularDispatchVehicles([{ driverUserId: " driver-1 ", stops: [] }]));
  assert.match(route, /role='DRIVER'/);
  assert.match(route, /drivers\.length !== driverIds\.length/);
});

test("정차 순서 저장은 월과 모든 행을 fail-closed 검증한다", () => {
  const valid = validateRegularStopOrderPayload({ serviceMonth: "2026-09", updates: [{ id: "stop-1", sortOrder: 0, arriveTime: "10:30" }] });
  assert.equal(valid.serviceMonth, "2026-09");
  assert.throws(() => validateRegularStopOrderPayload({ updates: [{ id: "stop-1", sortOrder: 0 }] }));
  assert.throws(() => validateRegularStopOrderPayload({ serviceMonth: "2026-09", updates: [{ id: "stop-1", sortOrder: 0, arriveTime: "25:00" }] }));
  assert.match(orderApi, /validateRegularStopOrderPayload/);
  assert.match(importSource, /WHERE "id"=\$3 AND "serviceMonth"=\$4/);
  assert.match(importSource, /if \(count !== updates\.length\)/);
});

test("문자 발송은 서버 정본과 승인 상태를 사용하고 실패 시 잠근다", () => {
  assert.match(noticeApi, /getRegularShuttleStops\(compareMonth\)/);
  assert.match(noticeApi, /diffRegularShuttleMonths/);
  assert.match(noticeApi, /changeKey\?\.startsWith\("student:"\)/);
  assert.match(noticeApi, /status='APPROVED'/);
  assert.match(noticeApi, /status='SENDING'/);
  assert.match(noticeApi, /status='UNCERTAIN'/);
  assert.match(noticeApi, /catch\(\(\) => undefined\)/);
});

test("유효 명단 조회 실패 시 과거 저장 노선을 그대로 노출하지 않는다", () => {
  assert.match(route, /유효 명단을 확인하지 못한 저장본은 휴원·퇴원생이 섞였는지 알 수 없어 사용하지 않는다/);
  assert.match(route, /vehicles = \[\];/);
});
