import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";
import { createRequire } from "node:module";
import Module from "node:module";
import { resolve } from "node:path";
import ts from "typescript";

// 체험 수업 셔틀 요청(2026-11-19 원장 결정).
// 같은 요청을 ① 학부모 체험 신청서 ② 관리자 체험 상세 두 길로 넣는다 → 검사 규칙(순수 모듈)을 실제로 돌려 보고,
// 화면·서버가 그 한 곳을 쓰는지, 신청 저장이 «칸 없음»으로 신청을 잃지 않게 짜였는지 소스로 못박는다.

const rules = await loadTsModule("src/lib/trial/trialShuttleRequest.ts");
const store = await loadTsModule("src/lib/trial/trialShuttleRequestStore.ts");
const {
    normalizeTrialShuttleRequest,
    trialShuttleFormErrors,
    trialShuttleFormFromColumns,
    trialShuttleColumnsFromRow,
    trialShuttleRequestSame,
    trialShuttleSummaryLines,
    trialShuttleMemoText,
    trialShuttlePlaceLabels,
    trialShuttleReleaseReasonForLeadUpdate,
    EMPTY_TRIAL_SHUTTLE_COLUMNS,
    EMPTY_TRIAL_SHUTTLE_FORM,
} = rules;

const read = (file) => fs.readFileSync(file, "utf8");
// 합성 위치(실제 학생 주소 아님)
const home = { name: "합성아파트 후문", address: "경기 남양주시 합성로 49", latitude: 37.61, longitude: 127.15 };
const grandma = { name: "합성상가 앞", address: "경기 남양주시 합성로 100", latitude: 37.62, longitude: 127.16 };
const valid = { needed: true, direction: "BOTH", pickup: home, dropoffDifferent: false, dropoff: null };

test("기본값은 «필요 없음»이고, 필요 없음이면 적어 둔 것이 있어도 모든 칸을 비운다", () => {
    assert.equal(EMPTY_TRIAL_SHUTTLE_FORM.needed, false);
    for (const input of [undefined, null, {}, "x", { needed: false, direction: "BOTH", pickup: home }, { needed: "true", pickup: home }]) {
        const result = normalizeTrialShuttleRequest(input);
        assert.equal(result.ok, true);
        assert.deepEqual(result.columns, EMPTY_TRIAL_SHUTTLE_COLUMNS);
    }
    assert.deepEqual(trialShuttleFormErrors(EMPTY_TRIAL_SHUTTLE_FORM), {});
});

test("필요: 방향은 허용값만 받는다", () => {
    for (const direction of ["BOTH", "PICKUP", "DROPOFF"]) {
        const result = normalizeTrialShuttleRequest({ ...valid, direction });
        assert.equal(result.ok, true, direction);
        assert.equal(result.columns.shuttleDirection, direction);
        assert.equal(result.columns.shuttleNeeded, true);
    }
    for (const direction of ["", "both", "RETURN", null, undefined, 1]) {
        const result = normalizeTrialShuttleRequest({ ...valid, direction });
        assert.equal(result.ok, false, String(direction));
        assert.ok(result.errors.direction);
    }
});

test("필요: 위치(좌표)가 없거나 대한민국 밖이면 그 칸 안내와 함께 막는다", () => {
    const cases = [
        null,
        { ...home, latitude: null },
        { ...home, longitude: "" },
        { ...home, latitude: 0, longitude: 0 },
        { ...home, latitude: 127.15, longitude: 37.61 }, // 위도·경도 뒤바뀜
        { ...home, latitude: 35.68, longitude: 139.76 }, // 해외
        { ...home, latitude: Number.NaN },
    ];
    for (const pickup of cases) {
        const result = normalizeTrialShuttleRequest({ ...valid, pickup });
        assert.equal(result.ok, false, JSON.stringify(pickup));
        assert.match(result.errors.pickupLocation, /지도에서 .*골라 주세요/);
        // 지도가 안 열리는 휴대폰에서도 신청은 할 수 있게 다른 길을 알려 준다
        assert.match(result.errors.pickupLocation, /필요 없음/);
        assert.equal(result.message, result.errors.pickupLocation);
    }
    // 문자열 좌표(폼·DB 에서 글자로 온 값)는 숫자로 바꿔 받는다
    const asText = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, latitude: "37.61", longitude: "127.15" } });
    assert.equal(asText.ok, true);
    assert.equal(asText.columns.shuttlePickupLat, 37.61);
    assert.equal(asText.columns.shuttlePickupLng, 127.15);
});

test("필요: 위치명은 필수 — 비었거나 주소를 그대로 적었거나 너무 길면 막는다", () => {
    for (const name of ["", "   ", undefined, home.address, "경기 남양주시합성로 49"]) {
        const result = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, name } });
        assert.equal(result.ok, false, String(name));
        assert.match(result.errors.pickupName, /이름을 적어 주세요/);
        assert.equal(result.errors.pickupLocation, undefined);
    }
    const tooLong = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, name: "가".repeat(151) } });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.errors.pickupName, /150자 이내/);
    const maxLength = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, name: "가".repeat(150) } });
    assert.equal(maxLength.ok, true);
});

test("저장 값은 앞뒤 공백을 지우고, 주소는 300자에서 자른다", () => {
    const result = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, name: "  합성아파트 후문  ", address: `  ${"나".repeat(400)}  ` } });
    assert.equal(result.ok, true);
    assert.equal(result.columns.shuttlePickupName, "합성아파트 후문");
    assert.equal(result.columns.shuttlePickupAddress.length, 300);
    // 주소가 없어도(지도가 주소를 못 준 위치) 좌표와 이름이 있으면 받는다
    const noAddress = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, address: "" } });
    assert.equal(noAddress.ok, true);
    assert.equal(noAddress.columns.shuttlePickupAddress, null);
});

test("하원 위치: 생략하면 4칸 모두 비움(= 등원과 같은 곳), «다릅니다»를 켜면 필수", () => {
    const same = normalizeTrialShuttleRequest({ ...valid, dropoffDifferent: false, dropoff: grandma });
    assert.equal(same.ok, true);
    assert.deepEqual(
        [same.columns.shuttleDropoffName, same.columns.shuttleDropoffAddress, same.columns.shuttleDropoffLat, same.columns.shuttleDropoffLng],
        [null, null, null, null],
        "체크를 끄면 적어 둔 하원 위치는 저장하지 않는다",
    );

    const different = normalizeTrialShuttleRequest({ ...valid, dropoffDifferent: true, dropoff: grandma });
    assert.equal(different.ok, true);
    assert.equal(different.columns.shuttleDropoffName, "합성상가 앞");
    assert.equal(different.columns.shuttleDropoffLat, 37.62);

    const missing = normalizeTrialShuttleRequest({ ...valid, dropoffDifferent: true, dropoff: null });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.dropoffLocation);
    const noName = normalizeTrialShuttleRequest({ ...valid, dropoffDifferent: true, dropoff: { ...grandma, name: "" } });
    assert.equal(noName.ok, false);
    assert.match(noName.errors.dropoffName, /내리는 곳 이름/);

    // 등원만·하원만은 한 곳만 받는다 — «다릅니다»가 켜져 와도 하원 칸은 비운다
    for (const direction of ["PICKUP", "DROPOFF"]) {
        const single = normalizeTrialShuttleRequest({ ...valid, direction, dropoffDifferent: true, dropoff: null });
        assert.equal(single.ok, true, direction);
        assert.equal(single.columns.shuttleDropoffLat, null);
    }
});

test("그 곳을 부르는 이름: 하원만이면 «내리는 곳», 둘 다(같은 곳)이면 «타고 내리는 곳»", () => {
    assert.equal(trialShuttlePlaceLabels("PICKUP", false).main, "타는 곳");
    assert.equal(trialShuttlePlaceLabels("DROPOFF", false).main, "내리는 곳");
    assert.equal(trialShuttlePlaceLabels("BOTH", false).main, "타고 내리는 곳");
    assert.deepEqual(trialShuttlePlaceLabels("BOTH", true), { main: "타는 곳", dropoff: "내리는 곳" });
    const dropoffOnly = normalizeTrialShuttleRequest({ ...valid, direction: "DROPOFF", pickup: { ...home, name: "" } });
    assert.match(dropoffOnly.errors.pickupName, /내리는 곳 이름/);
});

test("저장된 칸 ↔ 화면 입력값: 고치기를 열면 그대로 채워지고, 다시 저장하면 같은 요청이다", () => {
    const saved = normalizeTrialShuttleRequest({ ...valid, dropoffDifferent: true, dropoff: grandma }).columns;
    const form = trialShuttleFormFromColumns(saved);
    assert.equal(form.needed, true);
    assert.equal(form.dropoffDifferent, true);
    assert.deepEqual(form.pickup, home);
    assert.deepEqual(form.dropoff, grandma);
    assert.equal(trialShuttleRequestSame(saved, normalizeTrialShuttleRequest(form).columns), true);

    // 요청이 없던 건에서 «넣기»를 열면 «필요»가 켜진 빈 값
    const fresh = trialShuttleFormFromColumns(EMPTY_TRIAL_SHUTTLE_COLUMNS);
    assert.deepEqual(fresh, { needed: true, direction: "BOTH", pickup: null, dropoffDifferent: false, dropoff: null });

    // DB 줄(칸 이름이 소문자로 오거나 좌표가 글자로 와도)에서 같은 값을 뽑는다. 칸이 없으면 «필요 없음»
    const fromRow = trialShuttleColumnsFromRow({ shuttleneeded: true, shuttleDirection: "PICKUP", shuttlePickupName: "합성아파트 후문", shuttlePickupLat: "37.61", shuttlePickupLng: 127.15 });
    assert.equal(fromRow.shuttleNeeded, true);
    assert.equal(fromRow.shuttleDirection, "PICKUP");
    assert.equal(fromRow.shuttlePickupLat, 37.61);
    assert.deepEqual(trialShuttleColumnsFromRow({ id: "x" }), EMPTY_TRIAL_SHUTTLE_COLUMNS);
    assert.deepEqual(trialShuttleColumnsFromRow(null), EMPTY_TRIAL_SHUTTLE_COLUMNS);
});

test("요청 비교: 방향·이름·좌표·하원 위치 중 하나라도 다르면 다른 요청이다", () => {
    const base = normalizeTrialShuttleRequest(valid).columns;
    assert.equal(trialShuttleRequestSame(base, { ...base }), true);
    assert.equal(trialShuttleRequestSame(base, { ...base, shuttleDirection: "PICKUP" }), false);
    assert.equal(trialShuttleRequestSame(base, { ...base, shuttlePickupName: "합성아파트 정문" }), false);
    assert.equal(trialShuttleRequestSame(base, { ...base, shuttlePickupLat: 37.6101 }), false);
    assert.equal(trialShuttleRequestSame(base, { ...base, shuttleDropoffLat: 37.62, shuttleDropoffLng: 127.16, shuttleDropoffName: "합성상가 앞" }), false);
    assert.equal(trialShuttleRequestSame(base, EMPTY_TRIAL_SHUTTLE_COLUMNS), false);
});

test("관리자 화면 요약과 메모 대체 글: 방향·위치명·주소(메모에는 좌표까지)", () => {
    const both = normalizeTrialShuttleRequest({ ...valid, dropoffDifferent: true, dropoff: grandma }).columns;
    assert.deepEqual(trialShuttleSummaryLines(both), [
        { label: "방향", value: "둘 다" },
        { label: "타는 곳", value: "합성아파트 후문 · 경기 남양주시 합성로 49" },
        { label: "내리는 곳", value: "합성상가 앞 · 경기 남양주시 합성로 100" },
    ]);
    assert.deepEqual(trialShuttleSummaryLines(EMPTY_TRIAL_SHUTTLE_COLUMNS), []);
    const memo = trialShuttleMemoText(both);
    assert.match(memo, /^\[셔틀 요청\] 방향: 둘 다/);
    assert.match(memo, /타는 곳: 합성아파트 후문 \(경기 남양주시 합성로 49 \/ 좌표 37\.61, 127\.15\)/);
    assert.match(memo, /내리는 곳: 합성상가 앞/);
    assert.equal(trialShuttleMemoText(EMPTY_TRIAL_SHUTTLE_COLUMNS), "");
    const dropoffOnly = normalizeTrialShuttleRequest({ ...valid, direction: "DROPOFF" }).columns;
    assert.match(trialShuttleMemoText(dropoffOnly), /방향: 하원만 · 내리는 곳: 합성아파트 후문/);
});

test("배정 풀기 판단: 취소·이탈, 또는 확정 날짜·반이 실제로 바뀔 때만", () => {
    const previous = { scheduledDate: new Date("2026-11-21T07:00:00.000Z"), scheduledClassId: "class-a" };
    const reason = trialShuttleReleaseReasonForLeadUpdate;
    assert.equal(reason(previous, { status: "CANCELLED" }), "CANCELLED");
    assert.equal(reason(previous, { status: "LOST" }), "LOST");
    assert.equal(reason(previous, { memo: "메모만 고침" }), null);
    assert.equal(reason(previous, { status: "ATTENDED" }), null);
    // 같은 날짜·반을 다시 저장(일정 확정 창을 그대로 저장) → 풀지 않는다. 글자·Date 어느 모양이든 같은 시각이면 같다
    assert.equal(reason(previous, { status: "SCHEDULED", scheduledDate: "2026-11-21T16:00:00+09:00", scheduledClassId: "class-a" }), null);
    assert.equal(reason(previous, { scheduledDate: new Date("2026-11-21T07:00:00.000Z") }), null);
    assert.equal(reason(previous, { scheduledDate: "2026-11-28T16:00:00+09:00" }), "RESCHEDULED");
    assert.equal(reason(previous, { scheduledClassId: "class-b" }), "RESCHEDULED");
    assert.equal(reason(previous, { scheduledDate: null }), "RESCHEDULED");
    assert.equal(reason({ scheduledDate: null, scheduledClassId: null }, { scheduledDate: "2026-11-28T16:00:00+09:00", scheduledClassId: "class-b" }), "RESCHEDULED");
    assert.equal(reason({ scheduledDate: null, scheduledClassId: null }, { scheduledDate: null, scheduledClassId: "" }), null);
});

test("저장 SQL: 요청 있음 = REQUESTED + 요청 시각, 필요 없음 = NONE + 비움. 이 코드는 ASSIGNED·UNAVAILABLE 을 쓰지 않는다", async () => {
    const calls = [];
    const db = { async $executeRawUnsafe(query, ...values) { calls.push({ query, values }); return 1; } };
    const columns = normalizeTrialShuttleRequest({ ...valid, dropoffDifferent: true, dropoff: grandma }).columns;
    await store.writeTrialShuttleRequest(db, "lead-1", columns);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, [
        "lead-1", true, "BOTH",
        "합성아파트 후문", "경기 남양주시 합성로 49", 37.61, 127.15,
        "합성상가 앞", "경기 남양주시 합성로 100", 37.62, 127.16,
    ]);
    assert.match(calls[0].query, /"shuttleStatus" = CASE WHEN \$2::boolean THEN 'REQUESTED' ELSE 'NONE' END/);
    assert.match(calls[0].query, /"shuttleRequestedAt" = CASE WHEN \$2::boolean THEN NOW\(\) ELSE NULL END/);
    assert.match(calls[0].query, /WHERE id = \$1/);
    const storeSource = read("src/lib/trial/trialShuttleRequestStore.ts");
    assert.doesNotMatch(storeSource, /THEN 'ASSIGNED'|THEN 'UNAVAILABLE'|"shuttleStatus" = '/, "배정됨·어려움으로 «만드는» 문장은 없다");
    assert.equal([...storeSource.matchAll(/"shuttleStatus" = /g)].length, 1, "상태를 쓰는 곳은 CASE 한 줄뿐");
    assert.doesNotMatch(storeSource, /^s*["']use server["']/m, "서버 액션 파일에 두면 누구나 부를 수 있는 주소가 된다");

    await store.writeTrialShuttleRequest(db, "lead-1", EMPTY_TRIAL_SHUTTLE_COLUMNS);
    assert.deepEqual(calls[1].values, ["lead-1", false, null, null, null, null, null, null, null, null, null]);

    // 메모 덧붙이기는 기존 메모를 지우지 않는다
    await store.appendTrialLeadMemo(db, "lead-1", "[셔틀 요청] 합성");
    assert.match(calls[2].query, /memo \|\| E'\\n' \|\| \$2/);
    assert.deepEqual(calls[2].values, ["lead-1", "[셔틀 요청] 합성"]);

    // 저장된 요청 읽기: 신청이 없으면 null
    const queryDb = { async $queryRawUnsafe() { return []; } };
    assert.equal(await store.readTrialShuttleRequest(queryDb, "none"), null);
    const found = await store.readTrialShuttleRequest({ async $queryRawUnsafe() { return [{ id: "lead-1", ...columns }]; } }, "lead-1");
    assert.equal(trialShuttleRequestSame(found, columns), true);
});

test("문구: 질문은 «셔틀이 필요하신가요?», 안내 두 줄은 원장 지정 그대로 — 요금 문구는 없다", () => {
    assert.equal(rules.TRIAL_SHUTTLE_QUESTION, "셔틀이 필요하신가요?");
    assert.deepEqual([...rules.TRIAL_SHUTTLE_NOTICES], [
        "셔틀은 요청이며, 노선·자리에 따라 어려울 수 있고 확정되면 문자로 안내합니다.",
        "거리가 멀면 배정이 어려울 수 있습니다.",
    ]);
    assert.deepEqual(rules.TRIAL_SHUTTLE_DIRECTION_LABEL, { BOTH: "둘 다", PICKUP: "등원만", DROPOFF: "하원만" });

    const fields = read("src/components/trial/TrialShuttleRequestFields.tsx");
    // 화면은 규칙 모듈의 문구를 그대로 그린다(따로 적지 않는다)
    assert.match(fields, /\{TRIAL_SHUTTLE_QUESTION\}/);
    assert.match(fields, /TRIAL_SHUTTLE_NOTICES\.map/);
    assert.match(fields, /필요 없음/);
    assert.match(fields, /하원 위치가 다릅니다/);
    assert.match(fields, /지도에서 위치 고르기/);
    // 정규 배정처럼 지도 창에서 장소명을 꼭 받는다
    assert.match(fields, /<LocationPickerModal[\s\S]*?requirePlaceName/);
    // 체험 셔틀은 무료 — 금액·요금 글자가 없다
    assert.doesNotMatch(fields, /요금|[0-9],?[0-9]{3}원|셔틀비|유료/);
    assert.doesNotMatch(read("src/lib/trial/trialShuttleRequest.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /요금|셔틀비|유료/);
    // 화면 규칙: 색은 토큰만(색 코드 금지) · 굵기 400~700 · 브라우저 기본 창 금지 · 아이콘 부품 없음
    assert.doesNotMatch(fields, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(fields, /font-\[(800|900)\]|font-extrabold|font-black/);
    assert.doesNotMatch(fields, /\b(alert|confirm|prompt)\(/);
    assert.doesNotMatch(fields, /material-symbols|FontFreeIcon|lucide/);
    assert.match(fields, /min-h-11/);
    assert.doesNotMatch(fields, /font-\[\d+\]/, "굵기는 이름 붙은 클래스(font-medium·font-semibold)로");
    // 신청서에만 보이는 한 줄(관리자 화면에는 없음). 원장 지정 두 줄은 그대로다
    assert.equal(rules.TRIAL_SHUTTLE_CHANGE_NOTICE, "셔틀 변경·취소는 전화로 알려 주세요.");
    assert.match(fields, /\{!hideQuestion && <li>\{TRIAL_SHUTTLE_CHANGE_NOTICE\}<\/li>\}/);
});

test("신청서: 셔틀 칸은 2단계 끝(신청경로 아래)에 있고, 문제가 있으면 다음 단계로 못 간다", () => {
    const form = read("src/app/apply/trial/TrialApplicationForm.tsx");
    const step2 = form.slice(form.indexOf("{step === 2 && ("), form.indexOf("{step === 3 && ("));
    assert.ok(step2.indexOf("<TrialShuttleRequestFields") > step2.indexOf('label="신청경로"'), "신청경로 아래에 둔다");
    assert.match(form, /if \(!validateStep2\(\)\) return;\s*if \(!validateShuttle\(\)\) return;/);
    assert.match(form, /if \(!validateShuttle\(\)\) \{ setStep\(2\); return; \}/, "마지막 제출 전에도 다시 본다");
    assert.match(form, /trialShuttleFormErrors\(shuttle\)/);
    // «필요»일 때만 보낸다(«필요 없음»은 예전 전송 모양 그대로)
    assert.match(form, /\.\.\.\(shuttle\.needed \? \{ shuttle \} : \{\}\)/);
    // 기본값은 «필요 없음»
    assert.match(form, /useState<TrialShuttleFormValue>\(EMPTY_TRIAL_SHUTTLE_FORM\)/);
});

test("신청 저장: 셔틀은 본문 저장 «뒤» 따로 — 칸이 없어도 신청은 남고 내용은 관리 메모로", () => {
    const source = read("src/app/actions/public.ts");
    const submit = source.slice(source.indexOf("export async function submitTrialApplication"), source.indexOf("// 빈자리 수업 조회"));
    // 서버에서도 같은 규칙으로 검사
    assert.match(submit, /normalizeTrialShuttleRequest\(data\.shuttle\)/);
    assert.match(submit, /if \(!shuttleRequest\.ok\) throw new Error\(shuttleRequest\.message\)/);
    // 본문 INSERT·UPDATE 문에는 셔틀 칸을 섞지 않는다(«칸 없음»으로 신청을 잃지 않게)
    const statements = [...submit.matchAll(/`(?:INSERT INTO|UPDATE) "TrialLead"[\s\S]*?`/g)].map((m) => m[0]);
    assert.equal(statements.length, 2);
    for (const statement of statements) assert.doesNotMatch(statement, /shuttle/i);
    // 두 갈래(기존 신청 덮어쓰기·새 신청) 모두 저장한다
    assert.match(submit, /applyTrialShuttleOnResubmit\(existingId, shuttleColumns\)/);
    assert.match(submit, /saveTrialShuttleForNewApplication\(rows\[0\]\.id, shuttleColumns\)/);
    assert.ok(submit.indexOf("saveTrialShuttleForNewApplication(rows[0].id") > submit.indexOf("RETURNING id"), "새 신청은 INSERT 뒤에 저장");

    const helper = source.slice(source.indexOf("async function leaveTrialShuttleMemoFallback"), source.indexOf("// 전화번호 정규화"));
    assert.match(helper, /appendTrialLeadMemo\(prisma, leadId, trialShuttleMemoText\(columns\)\)/);
    // 로그인 없는 재제출 길은 배정을 «요청 내용 변경»으로 풀지 않는다 — 판단은 순수 함수, 쓰기는 «배정 전일 때만»
    assert.match(helper, /decideTrialShuttleResubmit\(/);
    assert.match(helper, /writeTrialShuttleRequest\(prisma, leadId, columns, "OPEN_ONLY"\)/);
    assert.doesNotMatch(source, /"REQUEST_CHANGED"/, "신청서 재제출은 요청 변경을 이유로 배정을 풀지 않는다");
    // 재제출에도 속도 제한 — 본문 UPDATE 보다 먼저
    assert.ok(submit.indexOf("countRecentTrialResubmits(prisma, normalizedPhoneDigits)") > 0);
    assert.ok(submit.indexOf("countRecentTrialResubmits(") < submit.indexOf('`UPDATE "TrialLead" SET'), "한도 확인이 저장보다 먼저");
    // 관리자 알림에 한 마디. 학부모 문자·알림톡 틀(변수)은 그대로
    assert.match(submit, /셔틀 요청 있음/);
    assert.match(submit, /"TRIAL_CONFIRM_PARENT",\s*\{ childName, parentName \},/);
});

test("관리자: 셔틀 요청 저장은 전용 액션(검사·상태 규칙·배정 풀기), 일정 변경·취소·이탈·삭제 때 배정을 푼다", () => {
    const source = read("src/app/actions/admin.ts");
    const action = source.slice(source.indexOf("export async function updateTrialLeadShuttleRequest"), source.indexOf("// (2026-11-09) 체험 완료 문자 재시도"));
    assert.match(action, /const admin = await requireAdmin\(\);/);
    assert.match(action, /normalizeTrialShuttleRequest\(input\)/);
    assert.match(action, /trialShuttleRequestSame\(previous, next\)\) return \{ ok: true, changed: false/);
    assert.ok(action.indexOf("releaseTrialShuttleSafely(id, \"REQUEST_CHANGED\")") < action.indexOf("writeTrialShuttleRequest(prisma, id, next, \"NOT_ASSIGNED\")"), "풀기 먼저, 요청 칸 쓰기 나중");
    // 풀기와 쓰기 사이에 다른 관리자가 배정하면(또는 풀기가 실패하면) 쓰지 않고 알린다
    assert.match(action, /if \(written === 0\) \{[\s\S]*?다른 화면에서 셔틀 배정이 바뀌었습니다\. 새로고침한 뒤 다시 시도해 주세요\./);
    // 공용 수정 허용 칸에는 셔틀 칸을 넣지 않는다(검사 없이 상태를 바꾸는 길을 만들지 않는다)
    const columns = source.slice(source.indexOf("const TRIAL_LEAD_COLUMNS = ["), source.indexOf("] as const;", source.indexOf("const TRIAL_LEAD_COLUMNS = [")));
    assert.doesNotMatch(columns, /shuttle/i);

    const update = source.slice(source.indexOf("export async function updateTrialLead("), source.indexOf("export async function updateTrialLeadShuttleRequest"));
    assert.match(update, /trialShuttleReleaseReasonForLeadUpdate\(/);
    assert.match(update, /if \(shuttleReleaseReason\) \{\s*shuttleReleaseFailed = !\(await releaseTrialShuttleSafely\(id, shuttleReleaseReason\)\);/);
    // 예전 신청 조회 SELECT 에 셔틀 칸을 넣지 않는다(칸이 없는 DB 에서 공용 수정이 통째로 죽지 않게)
    const previousSelect = update.slice(update.indexOf("const previousRows"), update.indexOf("const previousLead"));
    assert.doesNotMatch(previousSelect, /shuttle/i);

    // 체험 삭제 액션은 2026-11-18 옛 코드 정리 C 에서 «부르는 곳 없음»으로 지웠다 — 다시 만들면 지우기 전에 배정부터 풀 것
    assert.doesNotMatch(source, /export async function deleteTrialLead\b/);

    // 런타임 칸 보장은 마이그레이션과 같은 이름·타입
    const ensure = source.slice(source.indexOf("export async function ensureTrialLeadTable"), source.indexOf("export async function createTrialLead"));
    const migration = read("prisma/migrations/20261119100000_trial_shuttle/migration.sql");
    const ensured = [...ensure.matchAll(/ADD COLUMN IF NOT EXISTS ("shuttle\w+" [A-Za-z0-9() ']+?)(?:,|`)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
    assert.equal(ensured.length, 13);
    for (const column of ensured) assert.ok(migration.replace(/\s+/g, " ").includes(`ADD COLUMN IF NOT EXISTS ${column}`), `마이그레이션과 다름: ${column}`);
});

test("풀기 호출 래퍼: 던지지 않는다 — 배정 쪽이 failed 를 알리거나 모듈을 못 부르면 false(화면이 «배정을 확인해 주세요»를 띄운다)", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
        const calls = [];
        const loader = (result) => async () => ({ releaseTrialShuttleOnLeadChange: async (id, reason) => { calls.push([id, reason]); return typeof result === "function" ? result() : result; } });
        // 풀었거나(1줄) 풀 것이 없었음(0줄) = 성공
        assert.equal(await store.releaseTrialShuttleSafely("lead-1", "CANCELLED", loader({ released: 1, failed: false })), true);
        assert.equal(await store.releaseTrialShuttleSafely("lead-1", "LOST", loader({ released: 0, failed: false })), true);
        assert.deepEqual(calls, [["lead-1", "CANCELLED"], ["lead-1", "LOST"]]);
        assert.deepEqual(await store.releaseTrialShuttleWithResult("lead-1", "RESCHEDULED", loader({ released: 2, failed: false })), { ok: true, released: 2 });
        // 배정 쪽이 «풀지 못했다»고 알림 → false
        assert.equal(await store.releaseTrialShuttleSafely("lead-1", "RESCHEDULED", loader({ released: 0, failed: true })), false);
        assert.deepEqual(await store.releaseTrialShuttleWithResult("lead-1", "RESCHEDULED", loader({ released: 0, failed: true })), { ok: false, released: 0 });
        // failed 칸이 없는 옛 모양({ released })은 성공으로 본다
        assert.equal(await store.releaseTrialShuttleSafely("lead-1", "CANCELLED", loader({ released: 0 })), true);
        // 던지거나 모듈을 못 불러와도 이 래퍼는 던지지 않는다
        assert.equal(await store.releaseTrialShuttleSafely("lead-1", "CANCELLED", loader(() => { throw new Error("fixture"); })), false);
        assert.equal(await store.releaseTrialShuttleSafely("lead-1", "CANCELLED", async () => { throw new Error("module missing"); }), false);
        // 평소(바꿔 끼우지 않음)에는 셔틀 배정 모듈을 부른다 — 이 테스트 환경에서는 그 경로를 못 불러와 실패 갈래가 돈다
        assert.equal(await store.releaseTrialShuttleSafely("lead-1", "CANCELLED"), false);
    } finally {
        console.warn = warn;
    }
    assert.match(read("src/lib/trial/trialShuttleRequestStore.ts"), /import\("@\/lib\/shuttle\/trialShuttle"\)/);
});

test("쓰기 조건: 재제출은 «배정 전일 때만», 관리자 고치기는 «배정됨이 아닐 때만» — 바뀐 줄 수를 돌려준다", async () => {
    const queries = [];
    const db = (count) => ({ async $executeRawUnsafe(query) { queries.push(query); return count; } });
    const columns = normalizeTrialShuttleRequest(valid).columns;
    assert.equal(await store.writeTrialShuttleRequest(db(1), "lead-1", columns), 1);
    assert.match(queries[0], /WHERE id = \$1 \s*$/);
    assert.equal(await store.writeTrialShuttleRequest(db(0), "lead-1", columns, "OPEN_ONLY"), 0);
    assert.match(queries[1], /WHERE id = \$1 AND COALESCE\("shuttleStatus", 'NONE'\) IN \('NONE', 'REQUESTED'\)/);
    assert.equal(await store.writeTrialShuttleRequest(db(0), "lead-1", columns, "NOT_ASSIGNED"), 0);
    assert.match(queries[2], /WHERE id = \$1 AND "shuttleStatus" IS DISTINCT FROM 'ASSIGNED'/);
});

test("위치명·주소의 줄바꿈·제어문자는 공백으로 바꾼 뒤 다듬는다(한 줄 글에 다른 줄을 끼워 넣지 못한다)", () => {
    assert.equal(rules.cleanTrialShuttleText("  합성아파트\n후문\t앞\r\n "), "합성아파트 후문 앞");
    assert.equal(rules.cleanTrialShuttleText("가\u0000나\u2028다\u0085라"), "가 나 다 라");
    assert.equal(rules.cleanTrialShuttleText(null), "");
    const result = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, name: "합성아파트 후문\n[셔틀 변경 요청 1/1] 가짜", address: "경기 남양주시\n합성로 49" } });
    assert.equal(result.ok, true);
    assert.equal(result.columns.shuttlePickupName, "합성아파트 후문 [셔틀 변경 요청 1/1] 가짜");
    assert.equal(result.columns.shuttlePickupAddress, "경기 남양주시 합성로 49");
    assert.doesNotMatch(trialShuttleMemoText(result.columns), /[\n\r]/);
    // 제어문자만 적은 이름은 빈 이름이다
    const onlyControl = normalizeTrialShuttleRequest({ ...valid, pickup: { ...home, name: "\n\t\r" } });
    assert.equal(onlyControl.ok, false);
    assert.ok(onlyControl.errors.pickupName);
});

test("다시 낸 신청서의 셔틀 판단: 배정됨·어려움은 건드리지 않고, 배정 전만 바꾼다", () => {
    const decide = rules.decideTrialShuttleResubmit;
    const saved = normalizeTrialShuttleRequest(valid).columns;
    const moved = normalizeTrialShuttleRequest({ ...valid, pickup: grandma }).columns;
    // 필요 없음으로 다시 냄 → 전 요청 유지(어떤 상태든)
    for (const status of ["NONE", "REQUESTED", "ASSIGNED", "UNAVAILABLE"]) {
        assert.equal(decide({ previous: saved, previousStatus: status, next: EMPTY_TRIAL_SHUTTLE_COLUMNS }), "KEEP");
        // 같은 내용 → 아무것도 안 함
        assert.equal(decide({ previous: saved, previousStatus: status, next: { ...saved } }), "KEEP");
    }
    // 내용이 바뀜
    assert.equal(decide({ previous: saved, previousStatus: "REQUESTED", next: moved }), "OVERWRITE");
    assert.equal(decide({ previous: EMPTY_TRIAL_SHUTTLE_COLUMNS, previousStatus: "NONE", next: moved }), "OVERWRITE");
    assert.equal(decide({ previous: null, previousStatus: undefined, next: moved }), "OVERWRITE");
    assert.equal(decide({ previous: saved, previousStatus: "ASSIGNED", next: moved }), "HOLD_FOR_ADMIN");
    assert.equal(decide({ previous: saved, previousStatus: "UNAVAILABLE", next: moved }), "HOLD_FOR_ADMIN");
    // 모르는 상태 값은 안전한 쪽으로
    assert.equal(decide({ previous: saved, previousStatus: "SOMETHING_NEW", next: moved }), "HOLD_FOR_ADMIN");

    // 변경 요청 메모: «[셔틀 변경 요청 M/D] 방향 … · 위치 …»
    assert.equal(
        rules.trialShuttleChangeMemoText(moved, "2026-12-01"),
        "[셔틀 변경 요청 12/1] 방향: 둘 다 · 타고 내리는 곳: 합성상가 앞 (경기 남양주시 합성로 100 / 좌표 37.62, 127.16)",
    );
    assert.match(rules.trialShuttleChangeMemoText(moved, ""), /^\[셔틀 변경 요청\] /);

    // 재제출이 «확정 전 일정»을 비우는가: 확정(SCHEDULED)이면 일정이 유지되고, 그 밖에 날짜가 있었으면 비워진다
    const clears = rules.trialResubmitClearsSchedule;
    assert.equal(clears({ status: "SCHEDULED", scheduledDate: new Date("2026-12-01T07:00:00Z") }), false);
    assert.equal(clears({ status: "CONTACTED", scheduledDate: new Date("2026-12-01T07:00:00Z") }), true);
    assert.equal(clears({ status: "NEW", scheduledDate: "2026-12-01T16:00:00+09:00" }), true);
    assert.equal(clears({ status: "NEW", scheduledDate: null }), false);
    assert.equal(clears({ status: "NEW" }), false);
    assert.equal(rules.TRIAL_RESUBMIT_LIMIT, 5);
});

test("관리자 화면: 상세에 «셔틀» 구역(넣기·고치기·필요 없음·배정 부품), 목록에 글자 배지", () => {
    const section = read("src/app/admin/trial/TrialShuttleSection.tsx");
    assert.match(section, /"셔틀 요청 고치기" : "셔틀 요청 넣기"/);
    assert.match(section, /셔틀 필요 없음으로 바꾸기/);
    assert.match(section, /<TrialShuttleRequestFields[\s\S]*?hideQuestion/, "신청서와 같은 입력 부품");
    assert.match(section, /updateTrialLeadShuttleRequest\(lead\.id, input\)/);
    // 배정 부품은 요청이 있는 건에만
    assert.match(section, /\{columns\.shuttleNeeded && !editing && \([\s\S]*?<TrialShuttleAssignPanel leadId=\{lead\.id\}/);
    assert.match(section, /askConfirm\(/);
    assert.doesNotMatch(section, /\b(window\.)?(alert|confirm|prompt)\(/);
    assert.doesNotMatch(section, /useBackToClose|#[0-9a-fA-F]{6}\b/);

    const client = read("src/app/admin/trial/TrialCrmClient.tsx");
    assert.match(client, /<TrialShuttleSection lead=\{lead\} onChanged=\{onShuttleChanged\} onFeedback=\{onShuttleFeedback\} \/>/);
    // 목록 배지: 요청이 있는 건만, 글자(상태 라벨) + 상태색
    assert.match(client, /const shuttleBadgeShown = Boolean\(lead\.shuttleStatus\) && lead\.shuttleStatus !== "NONE" && !isClosedTrialStatus\(lead\.status\);/, "끝난 신청에는 배지를 그리지 않는다");
    assert.match(section, /columns\.shuttleNeeded && closed \?[\s\S]{0,260}셔틀 요청 있었음/, "끝난 신청의 상세는 회색 «셔틀 요청 있었음»");
    assert.match(client, /statusBadgeClass\(trialShuttleStatusTone\(lead\.shuttleStatus\)\)[\s\S]{0,80}\{trialShuttleStatusLabel\(lead\.shuttleStatus\)\}/);
    // 목록 조회가 셔틀 칸을 실어 보낸다(칸이 없으면 «요청 없음»)
    const queries = read("src/lib/queries.ts");
    assert.match(queries, /shuttleStatus: r\.shuttleStatus \?\? "NONE",/);
    assert.match(queries, /shuttleNeeded: r\.shuttleNeeded === true,/);
});

test("상태 글자·색은 셔틀 배정 쪽 규칙 한 곳: 대기 = 주의 · 배정 = 완료 · 어려움 = 보류", async () => {
    const shuttleRules = await loadTsModule("src/lib/shuttle/trialShuttleRules.ts");
    assert.equal(shuttleRules.trialShuttleStatusTone("REQUESTED"), "warning");
    assert.equal(shuttleRules.trialShuttleStatusTone("ASSIGNED"), "success");
    assert.equal(shuttleRules.trialShuttleStatusTone("UNAVAILABLE"), "neutral");
    for (const status of ["REQUESTED", "ASSIGNED", "UNAVAILABLE"]) assert.match(shuttleRules.trialShuttleStatusLabel(status), /^셔틀 /);
    // 이쪽이 쓰는 풀기 이유는 모두 그쪽이 아는 값이다
    for (const reason of ["RESCHEDULED", "CANCELLED", "LOST", "REQUEST_CHANGED"]) assert.equal(shuttleRules.isTrialShuttleReleaseReason(reason), true, reason);
});

// ── 신청 저장을 실제로 돌려 본다(가짜 DB) ───────────────────────────────────────
// tests/referral-source-allowlist.test.mjs 와 같은 방식의 로더: public.ts 를 대역 의존으로 실행한다.
const nodeRequire = createRequire(import.meta.url);
function loadCjs(path, mocks = {}) {
    const absolute = resolve(path);
    const compiled = ts.transpileModule(fs.readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute }).outputText;
    const module = new Module(absolute);
    module.filename = absolute;
    module.paths = Module._nodeModulePaths(resolve("."));
    module.require = (name) => {
        if (name in mocks) return mocks[name];
        if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
        return nodeRequire(name);
    };
    module._compile(compiled, absolute);
    return module.exports;
}

/**
 * 신청 저장을 «진짜 저장 모듈 + 상태를 가진 가짜 DB»로 돌린다.
 *  - lead: 이미 있는 진행 중 신청(없으면 새 신청 갈래). shuttle 칸·상태·메모가 실제로 바뀌는지 본다
 *  - missingShuttleColumns: 운영 DB 에 셔틀 칸이 아직 없는 상황(셔틀 칸을 읽거나 쓰면 오류)
 *  - release: 셔틀 배정 쪽 풀기 함수의 대역(부른 기록을 남긴다)
 */
function submitHarness({ lead = null, missingShuttleColumns = false, memoFails = false, resubmitCount = 0, release = () => ({ released: 0, failed: false }), beforeShuttleWrite = null } = {}) {
    const log = [];
    const notices = [];
    const historyNotes = [];
    const releaseCalls = [];
    const row = lead ? { id: "lead-old", status: "NEW", scheduledDate: null, memo: null, shuttleStatus: "NONE", ...realRulesCjs.EMPTY_TRIAL_SHUTTLE_COLUMNS, ...lead } : null;
    let created = null;
    const target = (id) => (row && id === row.id ? row : created);
    const missing = () => { throw new Error('column "shuttleNeeded" of relation "TrialLead" does not exist'); };
    const prisma = {
        async $queryRawUnsafe(sql, ...args) {
            if (/INSERT INTO "TrialLead"/.test(sql)) {
                log.push("INSERT 본문");
                created = { id: "new-id", status: "NEW", scheduledDate: null, memo: null, shuttleStatus: "NONE", ...realRulesCjs.EMPTY_TRIAL_SHUTTLE_COLUMNS };
                return [{ id: "new-id" }];
            }
            if (sql.includes('FROM "ApplicationContactLog"')) return [{ count: resubmitCount }];
            if (sql.includes("COUNT(*)")) return [{ count: 0 }];
            if (sql.includes('"shuttleStatus"')) {
                if (missingShuttleColumns) missing();
                const found = target(args[0]);
                return found ? [{ ...found }] : [];
            }
            if (sql.includes('FROM "TrialLead"')) return row ? [{ id: row.id, status: row.status, scheduledDate: row.scheduledDate }] : [];
            return [];
        },
        async $executeRawUnsafe(sql, ...args) {
            if (/INSERT INTO "ApplicationContactLog"/.test(sql)) { historyNotes.push(args[1]); return 1; }
            if (/"shuttleNeeded" = \$2/.test(sql)) {
                if (missingShuttleColumns) missing();
                beforeShuttleWrite?.(row);
                const found = target(args[0]);
                const status = found.shuttleStatus ?? "NONE";
                if (sql.includes("IN ('NONE', 'REQUESTED')") && !["NONE", "REQUESTED"].includes(status)) return 0;
                if (sql.includes("IS DISTINCT FROM 'ASSIGNED'") && status === "ASSIGNED") return 0;
                const [, needed, direction, pName, pAddress, pLat, pLng, dName, dAddress, dLat, dLng] = args;
                Object.assign(found, {
                    shuttleNeeded: needed, shuttleDirection: direction,
                    shuttlePickupName: pName, shuttlePickupAddress: pAddress, shuttlePickupLat: pLat, shuttlePickupLng: pLng,
                    shuttleDropoffName: dName, shuttleDropoffAddress: dAddress, shuttleDropoffLat: dLat, shuttleDropoffLng: dLng,
                    shuttleStatus: needed ? "REQUESTED" : "NONE",
                });
                log.push(`셔틀 저장 ${found.id}`);
                return 1;
            }
            if (/SET memo = /.test(sql)) {
                if (memoFails) missing();
                const found = target(args[0]);
                found.memo = found.memo ? `${found.memo}\n${args[1]}` : args[1];
                log.push(`메모 ${found.id}`);
                return 1;
            }
            if (/^\s*UPDATE "TrialLead" SET\n/.test(sql)) {
                log.push("UPDATE 본문");
                // 본문 UPDATE 는 확정(SCHEDULED)이 아니면 scheduledDate 를 비운다(실제 SQL 의 CASE 와 같은 결과)
                if (row && row.status !== "SCHEDULED") row.scheduledDate = null;
                return 1;
            }
            return 1;
        },
    };
    const realStore = loadCjs("src/lib/trial/trialShuttleRequestStore.ts", {
        "@/lib/trial/trialShuttleRequest": realRulesCjs,
        "@/lib/shuttle/trialShuttle": {
            releaseTrialShuttleOnLeadChange: async (id, reason) => {
                releaseCalls.push(`${id} ${reason}`);
                const result = release(row);
                return result;
            },
        },
    });
    const actions = loadCjs("src/app/actions/public.ts", {
        "@/lib/prisma": { prisma },
        "@/lib/enrollment/referralSources": loadCjs("src/lib/enrollment/referralSources.ts"),
        "@/lib/datetime/kst": loadCjs("src/lib/datetime/kst.ts"),
        "@/lib/enrollment/commencement": { requireCommencement: (value) => value, commencementYmd: (value) => value ?? null },
        "@/app/actions/admin": { ensureTrialLeadTable: async () => {} },
        "@/lib/enrollment/trialLeadLinkService": { decideTrialLeadForNewApplication: async () => ({ decision: "NONE" }) },
        "@/lib/notification": { notifyAdmins: async (type, title, message, link, options) => { notices.push({ title, message, options }); }, sendParentSms: async () => {} },
        "@/lib/contactSaveName": { buildContactSaveName: () => "저장용 이름" },
        "@/lib/trial-fee/trialFeePaymentService": { issueTrialPaymentToken: async () => null },
        "@/lib/enrollment-account-handoff": { issueEnrollmentAccountHandoff: async () => null },
        "@/lib/seasonal/contracts": { SHUTTLE_LOCATION_CONSENT_VERSION: "test" },
        "@/lib/enrollment/shuttle-place-name": { shuttlePlaceNameError: () => null },
        "@/lib/seats/seatLevel": { seatLevelFromCounts: () => "OPEN" },
        "@/lib/trial/trialShuttleRequest": realRulesCjs,
        "@/lib/trial/trialShuttleRequestStore": realStore,
        "next/cache": { revalidatePath() {}, revalidateTag() {} },
    });
    const input = (shuttle) => ({
        trialDate: "2026-12-01", trialDay: "화", trialPeriod: "5",
        childName: "합성 학생", childGrade: "초3", childGender: "남", childSchool: "합성초",
        parentName: "합성 보호자", parentPhone: "010-0000-1111",
        source: "OTHER", trialFeeNoticeAgreed: true, agreedTerms: true, agreedPrivacy: true,
        ...(shuttle === undefined ? {} : { shuttle }),
    });
    return {
        submit: (shuttle) => actions.submitTrialApplication(input(shuttle)),
        log, notices, historyNotes, releaseCalls,
        row: () => row ?? created,
    };
}

const realRulesCjs = loadCjs("src/lib/trial/trialShuttleRequest.ts", {
    "@/lib/shuttle/academyLocation": loadCjs("src/lib/shuttle/academyLocation.ts"),
    "@/lib/shuttle/placeNameRule": loadCjs("src/lib/shuttle/placeNameRule.ts"),
    "@/lib/enrollment/shuttle-place-name": loadCjs("src/lib/enrollment/shuttle-place-name.ts"),
});
const savedColumns = realRulesCjs.normalizeTrialShuttleRequest(valid).columns;
const movedRequest = { ...valid, pickup: grandma };
/** 요청 칸만 뽑아 비교용으로 */
const shuttleOf = (row) => realRulesCjs.trialShuttleColumnsFromRow(row);

// 서버 로그(console.error·warn)가 테스트 출력을 어지럽히지 않게 그 동안만 끈다
async function quiet(run) {
    const original = { error: console.error, warn: console.warn };
    console.error = () => {};
    console.warn = () => {};
    try { return await run(); } finally { Object.assign(console, original); }
}

test("실행: 새 신청 — 본문 저장 뒤 셔틀 요청을 저장하고(배정 대기), 관리자 알림에 «셔틀 요청 있음»이 붙는다", async () => {
    const ui = submitHarness();
    const result = await ui.submit(valid);
    assert.equal(result.success, true);
    assert.deepEqual(ui.log, ["INSERT 본문", "셔틀 저장 new-id"]);
    assert.equal(ui.row().shuttleStatus, "REQUESTED");
    assert.deepEqual(shuttleOf(ui.row()), savedColumns);
    assert.match(ui.notices[0].message, /셔틀 요청 있음$/);
    assert.deepEqual(ui.releaseCalls, []);

    // «필요 없음»(또는 옛 화면처럼 칸 자체가 없음)이면 셔틀 저장을 부르지 않고 알림 문구도 예전 그대로
    for (const shuttle of [undefined, { needed: false }]) {
        const none = submitHarness();
        assert.equal((await none.submit(shuttle)).success, true);
        assert.deepEqual(none.log, ["INSERT 본문"]);
        assert.doesNotMatch(none.notices[0].message, /셔틀/);
    }
});

test("실행: 셔틀 칸 저장이 실패해도(운영 DB 에 칸이 아직 없을 때) 신청은 남고 내용은 관리 메모에 남는다", async () => {
    const ui = submitHarness({ missingShuttleColumns: true });
    const result = await quiet(() => ui.submit(valid));
    assert.equal(result.success, true, "신청 자체는 접수된다");
    assert.equal(result.id, "new-id");
    assert.deepEqual(ui.log, ["INSERT 본문", "메모 new-id"]);
    assert.equal(ui.row().memo, "[셔틀 요청] 방향: 둘 다 · 타고 내리는 곳: 합성아파트 후문 (경기 남양주시 합성로 49 / 좌표 37.61, 127.15)");

    // 메모 저장까지 실패해도 신청은 접수된다
    const worst = submitHarness({ missingShuttleColumns: true, memoFails: true });
    assert.equal((await quiet(() => worst.submit(valid))).success, true);

    // 다시 낸 신청서(UPDATE 갈래)에서 셔틀 칸을 못 읽어도 같다 — 관리자에게도 알린다
    const resubmit = submitHarness({ lead: {}, missingShuttleColumns: true });
    const again = await quiet(() => resubmit.submit(valid));
    assert.equal(again.mode, "updated");
    assert.deepEqual(resubmit.log, ["UPDATE 본문", "메모 lead-old"]);
    assert.match(resubmit.row().memo, /^\[셔틀 요청\]/);
    assert.equal(resubmit.notices.length, 1);
});

test("실행: 잘못된 셔틀 요청(위치 없음·방향 조작)은 아무것도 저장하기 전에 거절한다", async () => {
    for (const shuttle of [{ ...valid, pickup: null }, { ...valid, direction: "HACK" }, { ...valid, pickup: { ...home, name: "" } }]) {
        const ui = submitHarness();
        await assert.rejects(ui.submit(shuttle), (error) => error.message.length > 0 && !/오류가 발생/.test(error.message));
        assert.deepEqual(ui.log, []);
    }
});

test("실행(H-1): 이미 배정된 신청에 다른 위치로 다시 내도 요청 칸·상태·배정은 그대로 — 메모와 관리자 알림만 남는다", async () => {
    for (const status of ["ASSIGNED", "UNAVAILABLE"]) {
        const ui = submitHarness({ lead: { status: "SCHEDULED", scheduledDate: new Date("2026-12-01T07:00:00Z"), ...savedColumns, shuttleStatus: status } });
        const result = await ui.submit(movedRequest);
        assert.equal(result.mode, "updated", "신청서 본문 수정은 예전처럼 접수된다");
        // 요청 칸·상태 불변, 풀기 호출 없음
        assert.equal(ui.row().shuttleStatus, status, status);
        assert.deepEqual(shuttleOf(ui.row()), savedColumns);
        assert.deepEqual(ui.releaseCalls, [], "확정된 배정을 풀지 않는다");
        assert.deepEqual(ui.log, ["UPDATE 본문", "메모 lead-old"]);
        // 새로 낸 내용은 관리 메모 한 줄로
        assert.match(ui.row().memo, /^\[셔틀 변경 요청 \d{1,2}\/\d{1,2}\] 방향: 둘 다 · 타고 내리는 곳: 합성상가 앞 \(경기 남양주시 합성로 100 \/ 좌표 37\.62, 127\.16\)$/);
        // 관리자 알림(문자·코치 없음)과 이력
        assert.equal(ui.notices.length, 1);
        assert.equal(ui.notices[0].title, "체험 셔틀 변경 요청 — 배정을 확인해 주세요");
        assert.match(ui.notices[0].message, /^합성 학생 — 셔틀 변경 요청이 들어왔습니다/);
        assert.deepEqual(ui.notices[0].options, { notifyCoaches: false });
        assert.equal(ui.historyNotes.length, 1);
        assert.match(ui.historyNotes[0], /^학부모가 신청서를 다시 냈습니다\. 셔틀 변경 요청이 들어왔습니다/);
    }
});

test("실행: 배정 전(배정 대기·요청 없음)에 내용을 바꿔 다시 내면 덮어쓰고, 관리자 알림·이력이 남는다", async () => {
    const waiting = submitHarness({ lead: { ...savedColumns, shuttleStatus: "REQUESTED" } });
    await waiting.submit(movedRequest);
    assert.deepEqual(waiting.log, ["UPDATE 본문", "셔틀 저장 lead-old"]);
    assert.equal(waiting.row().shuttleStatus, "REQUESTED");
    assert.equal(waiting.row().shuttlePickupName, "합성상가 앞");
    assert.equal(waiting.row().memo, null);
    assert.deepEqual(waiting.releaseCalls, []);
    assert.equal(waiting.notices.length, 1);
    assert.equal(waiting.notices[0].title, "체험 셔틀 요청");
    assert.match(waiting.historyNotes[0], /셔틀 요청이 바뀌었습니다\.$/);

    // 전에 요청이 없던 신청에 처음 셔틀을 넣어 다시 냄
    const first = submitHarness({ lead: {} });
    await first.submit(valid);
    assert.equal(first.row().shuttleStatus, "REQUESTED");
    assert.deepEqual(shuttleOf(first.row()), savedColumns);
    assert.equal(first.notices.length, 1);
});

test("실행: 같은 내용으로 다시 내면 셔틀은 아무것도 하지 않고, «필요 없음»으로 다시 내면 전 요청을 유지한다", async () => {
    for (const status of ["REQUESTED", "ASSIGNED", "UNAVAILABLE"]) {
        for (const shuttle of [valid, { needed: false }, undefined]) {
            const ui = submitHarness({ lead: { ...savedColumns, shuttleStatus: status } });
            await ui.submit(shuttle);
            assert.deepEqual(ui.log, ["UPDATE 본문"], `${status} ${JSON.stringify(shuttle)}`);
            assert.equal(ui.row().shuttleStatus, status);
            assert.deepEqual(shuttleOf(ui.row()), savedColumns);
            assert.equal(ui.row().memo, null);
            assert.deepEqual(ui.releaseCalls, []);
            assert.deepEqual(ui.notices, [], "셔틀에 바뀐 것이 없으면 알림도 없다");
            // 이력 한 줄은 남는다(누가 언제 다시 냈는지 · 속도 제한 장부)
            assert.deepEqual(ui.historyNotes, ["학부모가 신청서를 다시 냈습니다."]);
        }
    }
});

test("실행: 읽은 뒤 쓰기 전에 관리자가 배정했으면 덮어쓰지 않고 메모+알림으로 돌린다", async () => {
    const ui = submitHarness({
        lead: { ...savedColumns, shuttleStatus: "REQUESTED" },
        beforeShuttleWrite: (row) => { row.shuttleStatus = "ASSIGNED"; },
    });
    await ui.submit(movedRequest);
    assert.equal(ui.row().shuttleStatus, "ASSIGNED");
    assert.deepEqual(shuttleOf(ui.row()), savedColumns, "배정된 요청 칸은 그대로");
    assert.deepEqual(ui.log, ["UPDATE 본문", "메모 lead-old"]);
    assert.match(ui.row().memo, /^\[셔틀 변경 요청 /);
    assert.equal(ui.notices[0].title, "체험 셔틀 변경 요청 — 배정을 확인해 주세요");
});

test("실행: 다시 낸 신청서에도 속도 제한(10분에 5번) — 넘으면 아무것도 저장하지 않고 그 문구로 거절한다", async () => {
    const blocked = submitHarness({ lead: { ...savedColumns, shuttleStatus: "ASSIGNED" }, resubmitCount: 5 });
    await assert.rejects(blocked.submit(movedRequest), { message: "신청이 너무 많이 접수되었습니다. 잠시 후 다시 시도해주세요." });
    assert.deepEqual(blocked.log, []);
    assert.deepEqual(blocked.historyNotes, []);
    assert.deepEqual(blocked.notices, []);
    // 한도 안(4번째까지 낸 뒤 5번째)은 정상 접수
    const allowed = submitHarness({ lead: {}, resubmitCount: 4 });
    assert.equal((await allowed.submit(undefined)).mode, "updated");
    assert.deepEqual(allowed.log, ["UPDATE 본문"]);
});

test("실행: 다시 낸 신청서가 «확정 전 일정»을 비우면 그 날짜의 셔틀 배정을 풀고 관리자에게 알린다(확정된 일정은 그대로)", async () => {
    // 상태가 SCHEDULED 가 아닌데 날짜가 잡혀 있던 신청 → 본문 UPDATE 가 날짜를 비운다 → 배정 풀기(RESCHEDULED)
    const cleared = submitHarness({
        lead: { status: "CONTACTED", scheduledDate: new Date("2026-12-01T07:00:00Z"), ...savedColumns, shuttleStatus: "ASSIGNED" },
        release: (row) => { row.shuttleStatus = "REQUESTED"; return { released: 1, failed: false }; },
    });
    await cleared.submit(undefined);
    assert.deepEqual(cleared.releaseCalls, ["lead-old RESCHEDULED"]);
    assert.equal(cleared.row().scheduledDate, null);
    assert.equal(cleared.notices.length, 1);
    assert.equal(cleared.notices[0].title, "체험 셔틀 변경 요청 — 배정을 확인해 주세요");
    assert.match(cleared.notices[0].message, /일정이 다시 접수돼 셔틀 배정이 풀렸습니다\./);
    assert.match(cleared.historyNotes[0], /셔틀 배정이 풀렸습니다\./);

    // 풀기가 실패했다고 알려 오면 그 사실을 알린다(접수는 유지)
    const failed = submitHarness({
        lead: { status: "NEW", scheduledDate: new Date("2026-12-01T07:00:00Z"), ...savedColumns, shuttleStatus: "ASSIGNED" },
        release: () => ({ released: 0, failed: true }),
    });
    assert.equal((await quiet(() => failed.submit(undefined))).mode, "updated");
    assert.match(failed.notices[0].message, /셔틀 배정을 풀지 못했습니다\./);

    // 풀 배정이 없었으면(0줄) 알리지 않는다
    const nothing = submitHarness({ lead: { status: "NEW", scheduledDate: new Date("2026-12-01T07:00:00Z") } });
    await nothing.submit(undefined);
    assert.deepEqual(nothing.releaseCalls, ["lead-old RESCHEDULED"]);
    assert.deepEqual(nothing.notices, []);

    // 확정(SCHEDULED)된 신청은 재제출이 일정을 건드리지 않는다 → 풀기를 부르지 않는다
    const scheduled = submitHarness({ lead: { status: "SCHEDULED", scheduledDate: new Date("2026-12-01T07:00:00Z"), ...savedColumns, shuttleStatus: "ASSIGNED" } });
    await scheduled.submit(undefined);
    assert.deepEqual(scheduled.releaseCalls, []);
    assert.equal(scheduled.row().shuttleStatus, "ASSIGNED");
    assert.deepEqual(scheduled.notices, []);
});
