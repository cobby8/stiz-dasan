import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 방학특강 셔틀 "확정 명단 3단계"(화면에서 확정하고, 확정본만 고치기)의 구조 회귀 테스트.
//
// 지켜야 하는 약속:
//   (a) 확정한 뒤에는 원본 신청서를 절대 건드리지 않는다 — 판단은 **서버가** 한다(클라이언트 말을 믿지 않는다)
//   (b) 확정 여부는 명단을 고른 것과 같은 기준으로 판정한다(전원 제외해도 폴백으로 되돌아가지 않는다)
//   (c) 확정 후에는 확정 버튼이 사라진다(재확정 한 번에 원장이 손으로 고친 값이 되돌아가면 안 된다)
//   (d) 게이트웨이를 **읽는** 화면은 **쓰기도** 확정본으로 보낸다(읽기·쓰기가 갈리면 조용한 no-op가 된다)
//
// ⚠️ SQL 조립 규칙(중복 컬럼·파라미터 번호·핀 우선순위)은 여기서 검사하지 않는다.
//    문자열 매칭으로는 잡히지 않아서 실행 테스트로 옮겼다 → seasonal-shuttle-roster-edit-sql.test.mjs

const gateway = readFileSync(new URL("../src/lib/seasonal/shuttleRoster.ts", import.meta.url), "utf8");
const edit = readFileSync(new URL("../src/lib/seasonal/shuttleRosterEdit.ts", import.meta.url), "utf8");
const roster = readFileSync(new URL("../src/lib/seasonal/shuttle-roster.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/admin/seasonal/shuttle-roster/route.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/app/admin/seasonal/shuttle/ShuttleRosterClient.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/admin/seasonal/shuttle/page.tsx", import.meta.url), "utf8");
const ddl = readFileSync(new URL("../prisma/sql/add_seasonal_shuttle_roster.sql", import.meta.url), "utf8");
const shuttleService = readFileSync(new URL("../src/lib/shuttle/service.ts", import.meta.url), "utf8");

/** 소스에서 함수 하나의 본문을 대강 잘라낸다(다음 export 선언 전까지). */
function block(src, startMarker, endMarker) {
    const from = src.indexOf(startMarker);
    assert.notEqual(from, -1, `${startMarker} 를 찾지 못했다`);
    const to = endMarker ? src.indexOf(endMarker, from + startMarker.length) : -1;
    return src.slice(from, to === -1 ? undefined : to);
}

// ── (a) 확정 후 저장은 원본 테이블을 건드리지 않는다 ───────────────

test("확정본 분기는 확정본 함수만 부른다", () => {
    const confirmedBranch = block(route, "if (body?.rosterId)", "// ── 확정 전");
    assert.match(confirmedBranch, /updateConfirmedShuttleRosterRow\(/);
    assert.doesNotMatch(confirmedBranch, /updateShuttleRosterRow\(/);
});

test("★R-5 원본을 고치기 전에 서버가 확정 여부를 직접 확인한다", () => {
    // 클라이언트가 보낸 rosterId 유무만 믿으면, 확정 전에 열어 둔 탭이 확정 후에 저장하는 순간
    // 원본 신청서가 수정되고 화면엔 "저장됨"이 뜬다(확정본 미반영 = 아이가 옛 주소에서 기다린다).
    const guardAt = route.indexOf("isShuttleRequestConfirmed(");
    const writeAt = route.indexOf("await updateShuttleRosterRow(");
    assert.notEqual(guardAt, -1, "서버측 확정 확인이 없다");
    assert.notEqual(writeAt, -1, "원본 저장 호출을 찾지 못했다");
    assert.ok(guardAt < writeAt, "확정 확인이 원본 저장보다 뒤에 있다(막지 못한다)");
    assert.match(route, /status: 409/);
    assert.match(route, /명단이 확정되었습니다\. 새로고침 후 다시 시도해주세요\./);
});

test("★R-5 확인 함수는 확정본을 직접 조회한다(살아 있는 행 기준)", () => {
    const fn = block(gateway, "export async function isShuttleRequestConfirmed", "\n/**");
    assert.match(fn, /confirmedModeEnabled\(\)/); // 킬 스위치가 꺼져 있으면 원본이 정본이다
    assert.match(fn, /FROM "SeasonalShuttleRoster"/);
    assert.match(fn, /"shuttleRequestId" = \$1/);
    assert.match(fn, /"removedAt" IS NULL/);
});

test("화면이 409를 받으면 목록을 다시 읽는다", () => {
    // 문구만 띄우면 사용자는 계속 옛 목록(rosterId 없음) 위에서 저장을 반복하게 된다.
    assert.match(client, /status = r\.status/);
    assert.match(client, /status === 409/);
    const saveFn = block(client, "async function save(", "async function refresh");
    assert.match(saveFn, /refresh\(\)/);
});

test("확정본 수정 경로 어디에도 원본 테이블이 등장하지 않는다", () => {
    const editBlock = block(gateway, "export async function updateConfirmedShuttleRosterRow", "export async function removeConfirmedShuttleRosterRow");
    assert.match(editBlock, /UPDATE "SeasonalShuttleRoster"/);
    assert.doesNotMatch(editBlock, /"SpecialProgramShuttleRequest"/);
    for (const update of editBlock.match(/UPDATE "\w+"/g) ?? []) {
        assert.equal(update, 'UPDATE "SeasonalShuttleRoster"');
    }
    // SQL 조립 규칙을 담은 순수 모듈도 원본 테이블과 무관해야 한다.
    assert.doesNotMatch(edit, /SpecialProgramShuttleRequest/);
});

test("SQL 조립 규칙 모듈은 의존성이 없다(실행 테스트가 가능해야 한다)", () => {
    // import가 하나라도 생기면 실행 테스트가 죽고, 다시 문자열 매칭으로 되돌아간다.
    assert.doesNotMatch(edit, /^import\s/m);
    assert.match(gateway, /from "\.\/shuttleRosterEdit"/);
});

// ── (b) 확정 여부 판정 ──────────────────────────────────────────────

test("명단 한 줄에 origin과 rosterId가 실려 온다", () => {
    assert.match(roster, /origin: ShuttleRosterSource;/);
    assert.match(roster, /rosterId: string \| null;/);
    assert.match(roster, /origin: e\.origin,/);
    assert.match(roster, /rosterId: e\.rosterId,/);
    assert.match(roster, /import \{ getConfirmedShuttleRoster \} from "\.\/shuttleRoster"/);
});

test("★R-7① 전원을 명단에서 빼도 폴백이 되살아나지 않는다", () => {
    // 되살아나면 일부러 뺀 학생이 기사님 CSV에 다시 나타나고, 재확정도 ON CONFLICT라 빠져나갈 수 없다.
    const fn = block(gateway, "export async function getConfirmedShuttleRoster(", "async function confirmedSeasonRoster");
    assert.doesNotMatch(fn, /if \(rows\.length > 0\)/, "보이는 행 수로 확정 여부를 판정하고 있다");
    // 확정 여부는 «확정본이 있는 시즌 목록»(제외 행 포함)으로 판정한다 — 보이는 행이 아니다.
    assert.match(fn, /confirmedSeasonIds\(seasonId\)/);
    // 시즌을 지정하면 그 시즌 확정본을 그대로 돌려준다(비어도 폴백으로 새지 않는다).
    assert.match(fn, /if \(seasonId\) return confirmedRows;/);
    // 확정한 시즌은 폴백에서 뺀다 — 한 시즌 안에서 확정본과 원본을 섞지 않는다.
    assert.match(fn, /fallbackSeasonRoster\(null, confirmedSeasons\)/);
});

test("★R-7② 확정 전 시즌(다음 방학) 신청자는 다른 시즌이 확정돼도 사라지지 않는다", () => {
    const fallback = block(gateway, "async function fallbackSeasonRoster", "// ────");
    assert.match(fallback, /excludeSeasonIds: string\[\] = \[\]/);
    assert.match(fallback, /NOT \(a\."seasonId" = ANY\(/, "확정한 시즌만 빼야 한다(전체를 빼면 다음 시즌이 사라진다)");
    const ids = block(gateway, "async function confirmedSeasonIds", "async function confirmedRosterExists");
    assert.match(ids, /FROM "SeasonalShuttleRoster"/);
    assert.doesNotMatch(ids, /"removedAt" IS NULL/, "제외된 행을 빼고 세면 전원 제외 시 폴백이 되살아난다");
    // 확정하기는 이미 확정한 시즌을 다시 채우지 않는다(확정 후 새 신청이 슬며시 들어가면 안 된다).
    const confirm = block(gateway, "export async function confirmSeasonalShuttleRoster", "export async function updateConfirmedShuttleRosterRow");
    assert.match(confirm, /NOT EXISTS \(SELECT 1 FROM "SeasonalShuttleRoster" done WHERE done\."seasonId" = a\."seasonId"\)/);
});

test("★R-7① 존재 확인은 제외된 행도 센다", () => {
    const fn = block(gateway, "async function confirmedRosterExists", "// ────");
    assert.match(fn, /FROM "SeasonalShuttleRoster"/);
    assert.doesNotMatch(fn, /"removedAt" IS NULL/, "제외된 행을 빼고 세면 전원 제외 시 폴백이 되살아난다");
});

test("확정 여부는 명단을 고른 것과 같은 기준으로 판정한다", () => {
    const info = block(gateway, "export async function shuttleRosterConfirmationInfo", "export async function isShuttleRequestConfirmed");
    assert.match(info, /confirmedModeEnabled\(\)/);
    assert.match(info, /confirmedRosterExists\(seasonId\)/);
    assert.match(info, /confirmed/);
    // 화면·API는 서버 판정과 행 출처를 함께 본다(한쪽만 믿으면 확정 후에도 "확정 전"으로 보인다).
    assert.match(route, /info\.confirmed \|\| roster\.some/);
    assert.match(client, /confirmedFlag \|\| rows\.some/);
    assert.match(client, /origin === "CONFIRMED"/);
    assert.match(page, /initialConfirmed=/);
});

test("GET 응답은 기존 roster 키를 유지한 채 확정 정보를 덧붙인다", () => {
    assert.match(route, /\{ roster, confirmed, confirmedCount: info\.count, confirmedAt: info\.confirmedAt \}/);
});

test("확정일시는 지어낸 컬럼이 아니라 DDL에 있는 confirmedAt이다", () => {
    assert.match(ddl, /"confirmedAt" TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    assert.match(gateway, /min\(sr\."confirmedAt"\) AS "confirmedAt"/);
});

// ── (c) 확정 후에는 확정 버튼이 없다 ────────────────────────────────

test("확정 버튼은 확정 전에만 그린다", () => {
    // 확정 배너(확정한 시즌)에는 확정 버튼이 없다.
    const afterConfirm = block(client, "{confirmed ? (", ") : null}");
    assert.doesNotMatch(afterConfirm, /confirmRoster/);
    assert.doesNotMatch(afterConfirm, /확정하기/);
    // 처음 확정 전 배너
    const beforeConfirm = block(client, "{!confirmed && (", "{lastRemoved && (");
    assert.match(beforeConfirm, /onClick=\{confirmRoster\}/);
    assert.match(beforeConfirm, /확정하기/);
    // R-7② 확정한 시즌 + 확정 전 새 시즌 — 새 시즌만 따로 확정하는 버튼(새 시즌 탑승자가 있을 때만)
    const pending = block(client, "{confirmed && pendingRideCount > 0 && (", "{!confirmed && (");
    assert.match(pending, /onClick=\{confirmRoster\}/);
    assert.match(pending, /새 시즌 \$\{pendingRideCount\}명 확정하기/);
});

test("확정 전 배너는 '명단이 함께 바뀐다'고 알려준다", () => {
    assert.match(client, /이 명단은 아직 확정 전입니다\. 신청이 바뀌면 명단도 함께 바뀝니다\./);
});

test("확정 후 배너는 건수와 확정일시를 보여준다", () => {
    assert.match(client, /확정됨 · 탑승 \{confirmedRideCount\}명/);
    assert.match(client, /confirmedAtLabel/);
    assert.match(client, /확정본 \{confirmedCount\}건/);
});

test("확정 버튼은 확인창을 거치고 성공 후 목록을 다시 읽는다", () => {
    const fn = block(client, "async function confirmRoster", "async function removeRow");
    assert.match(fn, /window\.confirm\(/);
    assert.match(fn, /callApi\("POST"\)/);
    assert.match(fn, /refresh\(\)/);
});

test("재확정으로 원장이 고친 값이 덮이지 않는다", () => {
    assert.match(route, /confirmSeasonalShuttleRoster\(\)/);
    assert.match(gateway, /ON CONFLICT \("seasonId", "shuttleRequestId"\) DO NOTHING/);
});

// ── (d) 게이트웨이를 읽는 화면은 쓰기도 확정본으로 보낸다 (T-1) ──────

test("★T-1 노선 편성 화면의 핀 저장이 확정본으로 간다", () => {
    // 이 화면의 미배정 명단은 게이트웨이(=확정본)에서 읽는다. 쓰기만 원본으로 가면
    // 핀을 찍어도 좌표가 그대로인 채 "저장했습니다"만 뜬다(조용한 no-op).
    assert.match(shuttleService, /import \{ getConfirmedShuttleRoster, applyConfirmedRosterPin \}/);
    const fn = block(shuttleService, "export async function updateShuttleRequestLocation", "export async function updateStudentShuttleLocation");
    const routedAt = fn.indexOf("applyConfirmedRosterPin(");
    const originalAt = fn.indexOf("tx.specialProgramShuttleRequest.update(");
    assert.notEqual(routedAt, -1, "확정본 라우팅이 없다");
    assert.notEqual(originalAt, -1, "원본 저장 경로를 찾지 못했다");
    assert.ok(routedAt < originalAt, "확정본 라우팅이 원본 저장보다 뒤에 있다(원본이 먼저 바뀐다)");
    // 확정본에 저장했으면 원본 경로로 내려가지 않고 끝낸다.
    assert.match(fn, /if \(routed\.applied\)/);
    const routedBranch = fn.slice(fn.indexOf("if (routed.applied)"), originalAt);
    assert.match(routedBranch, /return/);
    assert.doesNotMatch(routedBranch, /specialProgramShuttleRequest\.update/);
});

test("★T-1 확정본이 없을 때만 원본에 저장한다", () => {
    const fn = block(gateway, "export async function applyConfirmedRosterPin", "\n// ─");
    assert.match(fn, /confirmedModeEnabled\(\)/);
    assert.match(fn, /return \{ applied: false \}/);
    assert.match(fn, /FROM "SeasonalShuttleRoster"/);
    assert.match(fn, /"removedAt" IS NULL/);
    assert.match(fn, /updateConfirmedShuttleRosterRow\(rosterId, patch\)/);
    // 확정본에 쓰는 함수가 원본 테이블을 건드리면 안 된다.
    assert.doesNotMatch(fn, /SpecialProgramShuttleRequest/);
});

test("★T-1 권한이 없으면 조용히 원본에 쓰지 않고 이유를 알린다", () => {
    const fn = block(shuttleService, "export async function updateShuttleRequestLocation", "export async function updateStudentShuttleLocation");
    assert.match(fn, /CONFIRMED_ROSTER_OWNER_ONLY/);
    assert.match(fn, /403/);
});

// ── 제외 / 되돌리기 ────────────────────────────────────────────────

test("행 제외·되돌리기는 확정본 전용 함수로만 간다", () => {
    assert.match(route, /removeConfirmedShuttleRosterRow\(body\.rosterId/);
    assert.match(route, /restoreConfirmedShuttleRosterRow\(body\.rosterId\)/);
    assert.match(client, /action: "remove"/);
    assert.match(client, /action: "restore"/);
    const del = block(route, "export async function DELETE");
    assert.match(del, /removeConfirmedShuttleRosterRow/);
    assert.doesNotMatch(del, /DELETE FROM/);
});

test("제외 버튼은 확정 후에만 보인다", () => {
    assert.match(client, /onClick=\{\(\) => removeRow\(r\)\}/);
    const cell = block(client, "onClick={() => removeRow(r)}");
    assert.ok(client.slice(0, client.indexOf("onClick={() => removeRow(r)}")).includes("{confirmed && ("));
    assert.ok(cell.length > 0);
});

// ── R-8 저장 실패 시 화면이 거짓말하지 않는다 ───────────────────────

test("★R-8 저장이 실패하면 낙관 반영을 되돌린다", () => {
    // 되돌리지 않으면 403/400/409에도 새 값과 초록 핀이 화면에 남아 "저장된 것처럼" 보인다.
    const fn = block(client, "async function save(", "async function refresh");
    assert.match(fn, /const before/);
    assert.match(fn, /apply\(row\.requestId, before\)/);
    // 롤백은 catch 안에서 일어나야 한다.
    const catchPart = fn.slice(fn.indexOf("catch"));
    assert.match(catchPart, /apply\(row\.requestId, before\)/);
});

// ── 안전장치(6번 지워진 이력) ───────────────────────────────────────

test("미탑승 기본 숨김·기사님 CSV 탑승자 한정은 그대로다", () => {
    assert.match(client, /showNonRiders \? searched : searched\.filter\(\(r\) => r\.ride\)/);
    assert.match(client, /미탑승 \{nonRiderCount\}명 보기/);
    assert.match(client, /const exportRows = useMemo\(\(\) => searched\.filter\(\(r\) => r\.ride\), \[searched\]\)/);
    assert.match(client, /for \(const r of exportRows\)/);
    assert.match(client, /방학특강_셔틀_탑승자명단_/);
});

test("화면과 API는 대상자 SQL을 직접 짜지 않는다", () => {
    for (const [name, src] of [["route", route], ["client", client], ["page", page]]) {
        assert.doesNotMatch(src, /SELECT /, `${name} 에 직접 SQL이 들어갔다`);
        assert.doesNotMatch(src, /queryRawUnsafe/, `${name} 에 직접 DB 접근이 들어갔다`);
    }
});

test("핀은 확정본에 이미 있는 컬럼에만 쓴다(새 컬럼·마이그레이션 금지)", () => {
    for (const kind of ["pickup", "dropoff"]) {
        for (const col of ["Latitude", "Longitude", "Address", "RoadAddress", "PlaceId", "LocationSource", "AccuracyMeters", "ConfirmedAt"]) {
            assert.match(ddl, new RegExp(`ADD COLUMN IF NOT EXISTS "${kind}${col}"`), `${kind}${col} 컬럼이 DDL에 없다`);
        }
    }
    assert.doesNotMatch(gateway, /ALTER TABLE "SeasonalShuttleRoster"/);
});

test("'등원과 동일'이면 등원 핀을 하원에 복제한다", () => {
    const editBlock = block(gateway, "export async function updateConfirmedShuttleRosterRow", "export async function removeConfirmedShuttleRosterRow");
    assert.match(editBlock, /"dropoffLatitude" = "pickupLatitude"/);
    assert.match(editBlock, /"dropoffLongitude" = "pickupLongitude"/);
    assert.match(editBlock, /"dropoffConfirmedAt" = CASE WHEN "pickupLatitude" IS NOT NULL/);
});
