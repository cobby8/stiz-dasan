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
    assert.match(fn, /askConfirm\(/);
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

// R-8②(2026-11-17): 되돌리기가 «방금 뺀 한 명»에게만 떠서, 새로고침하거나 두 명을 연달아 빼면
// 먼저 뺀 학생을 이 화면에서 되돌릴 길이 없었다. → 표 아래 «뺀 학생 N명» 묶음.
// (조회·되돌리기의 실제 동작은 seasonal-shuttle-roster-per-season.test.mjs 가 돌려 본다.)
test("★R-8② 뺀 학생 목록: 첫 화면·새로고침 모두에서 받고, 0명이면 그리지 않는다", () => {
    // 첫 화면(서버 렌더)부터 실려 와야 새로고침 뒤에도 되돌릴 수 있다.
    assert.match(page, /removedShuttleRosterRows\(\)/);
    assert.match(page, /initialRemoved=\{initialRemoved\}/);
    assert.match(client, /useState<RemovedRosterRow\[\]>\(initialRemoved\)/);
    // 목록 새로고침(refresh)이 새 키까지 받는다.
    const refreshFn = block(client, "async function refresh()", "async function confirmRoster");
    assert.match(refreshFn, /setRemoved\(Array\.isArray\(data\.removed\)/);
    // GET 은 기존 키를 그대로 둔 채 새 키만 덧붙인다.
    assert.match(route, /\{ \.\.\.base, removed \}/);
    assert.match(route, /const removed = await removedShuttleRosterRows\(\)/);
    // 0명이면 묶음 자체가 없다. 기본은 접힘.
    assert.match(client, /\{removed\.length > 0 && \(/);
    assert.match(client, /뺀 학생 \{removed\.length\}명/);
    assert.match(client, /const \[removedOpen, setRemovedOpen\] = useState\(false\)/);
    assert.match(client, /aria-expanded=\{removedOpen\}/);
});

test("★R-8② 뺀 학생 한 줄: 이유·KST 날짜·되돌리기(확인 거침)", () => {
    const section = block(client, "{removed.length > 0 && (", "{pinEdit && pinRow && (");
    assert.match(section, /removedReasonLabel\(item\)/);
    // 날짜는 공용 KST 모듈로만 만든다.
    assert.match(client, /import \{ toKstYmd \} from "@\/lib\/datetime\/kst"/);
    assert.match(section, /toKstYmd\(item\.removedAt\)/);
    assert.doesNotMatch(section, /toISOString|toLocaleDateString|toLocaleString/);
    assert.match(section, /onClick=\{\(\) => restoreRemoved\(item\)\}/);
    assert.match(section, /academy-button-secondary academy-button-sm/);
    // 좁은 화면에서 줄이 깨지지 않게 줄바꿈, 긴 값은 자르지 않는다.
    assert.match(section, /flex-wrap/);
    assert.doesNotMatch(section, /truncate|line-clamp|text-ellipsis/);

    const fn = block(client, "async function restoreRemoved", "async function savePin");
    // 브라우저 confirm 이 아니라 공용 확인창 + 문구 규칙(수강 취소면 그 사실을 넣는다)은 순수 모듈.
    assert.match(fn, /askConfirm\(restoreConfirmMessage\(item\)\)/);
    assert.match(fn, /action: "restore"/);
    assert.match(fn, /refresh\(\)/);
    // 띠(방금 뺀 학생)와 어긋나지 않게: 목록에서 되돌린 학생이 띠에 남아 있으면 띠도 닫는다.
    assert.match(fn, /setLastRemoved\(\(cur\) => \(cur\?\.rosterId === item\.rosterId \? null : cur\)\)/);
});

test("★R-8② 수강이 취소된 학생 줄은 되돌리기 버튼 대신 안내 글자를 그린다(서버도 같은 이유로 거부)", () => {
    const section = block(client, "{removed.length > 0 && (", "{pinEdit && pinRow && (");
    // 버튼과 안내 글자는 enrollmentCancelled 하나로 갈린다 — 안내가 먼저, 버튼은 그 반대쪽.
    const hintAt = section.indexOf("{RESTORE_BLOCKED_HINT}");
    const forkAt = section.indexOf("{item.enrollmentCancelled ? (");
    const buttonAt = section.indexOf("onClick={() => restoreRemoved(item)}");
    assert.ok(forkAt !== -1 && forkAt < hintAt && hintAt < buttonAt, "수강 취소 줄에 버튼이 그대로 그려진다");
    assert.equal(section.split("restoreRemoved(item)").length - 1, 1, "되돌리기 버튼은 한 곳에만 있어야 한다");
    assert.match(edit, /export const RESTORE_BLOCKED_HINT = "수강을 되살린 뒤 다시 넣을 수 있습니다";/);
    // 화면 상태가 낡았어도(다른 탭에서 수강 취소) 요청을 보내지 않고, 보내도 서버가 막는다.
    const fn = block(client, "async function restoreRemoved", "async function savePin");
    assert.match(fn, /if \(item\.enrollmentCancelled\) return;/);
    const restore = block(gateway, "export async function restoreConfirmedShuttleRosterRow", "\n/**");
    assert.ok(restore.indexOf("throw new Error(RESTORE_BLOCKED_ENROLLMENT_CANCELLED)") < restore.indexOf(`UPDATE "SeasonalShuttleRoster"`), "거부가 UPDATE 보다 먼저여야 한다");
    assert.match(restore, /\$\{ROSTER_ENROLLMENT_CANCELLED_SQL\} AS "enrollmentCancelled"/);
    // 좁은 경합: 원본 신청서 복구는 확정본 행이 지금도 살아 있을 때만.
    assert.match(restore, /AND EXISTS \(SELECT 1 FROM "SeasonalShuttleRoster" sr WHERE sr\.id = \$2 AND sr\."removedAt" IS NULL\)/);
    // API 가 이 거부를 500 으로 뭉개지 않고 한글 이유 + 4xx 로 내린다.
    assert.match(route, /if \(\/수강이 취소된\/\.test\(msg\)\) return \{ status: 409, message: msg \};/);
    assert.match(gateway, /RESTORE_BLOCKED_ENROLLMENT_CANCELLED = "수강이 취소된 학생입니다\. 수강을 되살린 뒤 다시 넣어 주세요\."/);
});

test("★R-8② 뺀 학생 묶음 안에서 난 되돌리기 오류는 그 묶음 안에도 보인다", () => {
    const section = block(client, "{removed.length > 0 && (", "{pinEdit && pinRow && (");
    assert.match(section, /\{removedError && \(\s+<p role="alert"[^>]*text-\[var\(--color-academy-danger\)\][^>]*>\{removedError\}<\/p>/);
    const fn = block(client, "async function restoreRemoved", "async function savePin");
    assert.match(fn, /setRemovedError\(null\)/);      // 다시 시도하면 옛 오류를 지운다
    assert.match(fn, /setRemovedError\(message\)/);   // 실패하면 묶음 안에 띄운다
    assert.match(fn, /setError\(message\)/);          // 위쪽 표시는 그대로 둔다
    // 띠(방금 뺀 학생)에서 난 오류는 묶음에 띄우지 않는다 — 목록에서 난 오류만 따로 든다.
    const band = block(client, "async function restoreRow", "async function restoreRemoved");
    assert.doesNotMatch(band, /setRemovedError/);
});

test("★R-8② 빼면 뺀 학생 목록에 바로 나타나고, 확인 문구가 그 자리를 알려준다", () => {
    const fn = block(client, "async function removeRow", "async function restoreRow");
    assert.match(fn, /아래 «뺀 학생»에서 언제든 다시 넣을 수 있습니다\./);
    assert.doesNotMatch(client, /되돌리기로 다시 넣을 수 있습니다/);
    assert.match(fn, /setRemoved\(\(cur\) => \[/);
    assert.match(fn, /setLastRemoved\(\{ rosterId, name: row\.childName \}\)/);
    // 띠에서 되돌리면 목록도 서버 값으로 다시 맞춘다.
    const band = block(client, "async function restoreRow", "async function restoreRemoved");
    assert.match(band, /refresh\(\)/);
});

test("★R-8② 뺀 학생 조회는 명단 출구(get*)가 아니고, 기사님 화면·배차가 쓰지 않는다", () => {
    const fn = block(gateway, "export async function removedShuttleRosterRows", "\n/**");
    assert.match(fn, /requireAdmin\(\)/);
    assert.match(fn, /confirmedModeEnabled\(\)/);
    assert.match(fn, /seasonScope\(\{ roster: "sr", season: "s" \}, seasonId\)/);
    assert.match(fn, /sr\."removedAt" IS NOT NULL/);
    assert.match(fn, /catch \{\s+return \[\];/);
    // 뺀 사람을 읽는 함수가 배차·기사님 쪽으로 새면 일부러 뺀 학생이 다시 태워진다.
    assert.doesNotMatch(shuttleService, /removedShuttleRosterRows/);
    assert.doesNotMatch(roster, /removedShuttleRosterRows/);
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
