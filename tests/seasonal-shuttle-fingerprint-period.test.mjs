import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 셔틀 확정본 «변동 감지» 지문(SOURCE_FINGERPRINT_SQL)에 기간·날짜 칸을 덧붙인 일(2026-11-18)이
// 기존 신청서의 지문을 바꾸지 않는지 지킨다. 지문이 바뀌면 이미 확정한 명단 전원이 «변동됨»으로 뜬다.
const src = readFileSync("src/lib/seasonal/shuttleRoster.ts", "utf8");
const start = src.indexOf("const SOURCE_FINGERPRINT_SQL = `");
const end = src.indexOf("`;", start);
const fingerprintSql = src.slice(start, end);

// 2026-11-18 이전의 지문 인자 목록(글자 하나까지 같아야 한다 — 바뀌면 기존 확정본 지문이 어긋난다)
const LEGACY_ARGS = [
  `a."childName", a."childGrade", a."childGender", a."childPhone", a."parentName", a."parentPhone",`,
  `it."offeringId", COALESCE(it."titleSnapshot", o.title), array_to_string(a."selectedWeekdays", ','),`,
  `r."pickupLocation", r."pickupAddress", r."pickupRoadAddress",`,
  `r."pickupLatitude"::text, r."pickupLongitude"::text, r."pickupTime",`,
  `r."dropoffLocation", r."dropoffAddress", r."dropoffRoadAddress",`,
  `r."dropoffLatitude"::text, r."dropoffLongitude"::text,`,
  `COALESCE(r."dropoffSameAsPickup", false)::text,`,
  `r.status, a.status, it.status, o.status,`,
];
const NEW_TAIL = `NULLIF(array_to_string(a."selectedDates", ','), ''), a."periodStartDate", a."periodEndDate"))`;

test("기존 지문 인자는 순서·글자 그대로 앞에 남아 있다", () => {
  assert.ok(start >= 0, "SOURCE_FINGERPRINT_SQL 을 찾지 못했다");
  const body = fingerprintSql.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(body[0], "const SOURCE_FINGERPRINT_SQL = `md5(concat_ws('|',");
  assert.deepEqual(body.slice(1, 1 + LEGACY_ARGS.length), LEGACY_ARGS);
});

test("새 칸은 맨 끝에 «기본값이면 NULL» 모양으로만 붙는다", () => {
  const lines = fingerprintSql.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(lines[lines.length - 1], NEW_TAIL);
  // 빈 배열이 '' 로 남으면 concat_ws 가 구분자를 붙인다 — NULLIF 로 반드시 NULL 로 만든다
  assert.doesNotMatch(fingerprintSql, /[^(]array_to_string\(a\."selectedDates"/);
  // 기간 칸을 COALESCE(…, '') 로 감싸면 NULL 이 '' 가 되어 지문이 바뀐다
  assert.doesNotMatch(fingerprintSql, /COALESCE\(a\."period(Start|End)Date"/);
});

// ── PostgreSQL 함수 의미를 그대로 옮긴 작은 흉내(지문 문자열이 같은지 실행으로 확인) ──
// concat_ws: NULL 인자는 구분자째 건너뛴다(빈 문자열은 건너뛰지 않는다)
const concatWs = (sep, ...args) => args.filter((v) => v !== null && v !== undefined).join(sep);
// array_to_string(빈 배열) = '' / NULLIF(x, '') = x 가 '' 면 NULL
const arrayToString = (arr, sep) => (arr == null ? null : arr.join(sep));
const nullIf = (value, other) => (value === other ? null : value);

function legacyFingerprintText(app, item, offering, req) {
  return concatWs("|",
    app.childName, app.childGrade, app.childGender, app.childPhone, app.parentName, app.parentPhone,
    item.offeringId, item.titleSnapshot ?? offering.title, arrayToString(app.selectedWeekdays, ","),
    req.pickupLocation, req.pickupAddress, req.pickupRoadAddress,
    req.pickupLatitude, req.pickupLongitude, req.pickupTime,
    req.dropoffLocation, req.dropoffAddress, req.dropoffRoadAddress,
    req.dropoffLatitude, req.dropoffLongitude,
    String(req.dropoffSameAsPickup ?? false),
    req.status, app.status, item.status, offering.status,
  );
}
function newFingerprintText(app, item, offering, req) {
  return concatWs("|",
    legacyFingerprintText(app, item, offering, req),
    nullIf(arrayToString(app.selectedDates, ","), ""), app.periodStartDate, app.periodEndDate,
  );
}

const baseApp = {
  childName: "홍길동", childGrade: "초3", childGender: null, childPhone: null,
  parentName: "홍부모", parentPhone: "010-0000-0000", selectedWeekdays: ["MON", "WED"], status: "APPROVED",
};
const item = { offeringId: "off-1", titleSnapshot: null, status: "APPROVED" };
const offering = { title: "초등 고학년", status: "OPEN" };
const req = {
  pickupLocation: "정문", pickupAddress: null, pickupRoadAddress: null, pickupLatitude: "37.1", pickupLongitude: "127.1",
  pickupTime: "13:00", dropoffLocation: null, dropoffAddress: null, dropoffRoadAddress: null,
  dropoffLatitude: null, dropoffLongitude: null, dropoffSameAsPickup: true, status: "REQUESTED",
};

test("기존 신청서(고른 날짜 빈 배열·기간 NULL)는 지문 문자열이 예전과 같다", () => {
  const app = { ...baseApp, selectedDates: [], periodStartDate: null, periodEndDate: null };
  assert.equal(newFingerprintText(app, item, offering, req), legacyFingerprintText(app, item, offering, req));
});

test("기간·날짜를 고른 신청서는 지문이 달라져 변동이 감지된다", () => {
  const legacy = legacyFingerprintText({ ...baseApp }, item, offering, req);
  const period = { ...baseApp, selectedDates: [], periodStartDate: "2026-12-22", periodEndDate: "2027-01-09" };
  const dated = { ...baseApp, selectedDates: ["2026-12-22", "2026-12-24"], periodStartDate: null, periodEndDate: null };
  assert.notEqual(newFingerprintText(period, item, offering, req), legacy);
  assert.notEqual(newFingerprintText(dated, item, offering, req), legacy);
  assert.notEqual(newFingerprintText(period, item, offering, req), newFingerprintText(dated, item, offering, req));
});
