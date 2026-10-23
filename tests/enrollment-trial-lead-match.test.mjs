import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 실제 사고: 체험 등록 때 아이 이름 오타 → 관리자가 체험 기록 이름을 고침 →
// 부모는 안내 링크 없이 직접 수강 신청 → 이름 "완전 일치"만 보던 예전 규칙이 못 찾아
// "체험 후 등록"으로 안 잡혔다. 오타 1글자는 잡되, 애매하면 자동 연결하지 않는지 실제로 돌려 본다.

const {
    decideTrialLeadMatch,
    syllableEditDistance,
    normalizeSchool,
    isEligibleTrialCandidate,
    selectApplicationForTrialAutoLink,
} = await loadTsModule("src/lib/enrollment/trialLeadMatch.ts");

const APP = {
    applicationId: "app-1",
    childName: "김민수",
    parentPhone: "010-1234-5678",
    childSchool: "다산초등학교",
    childGrade: "초3",
    childBirthYmd: "2017-05-01",
    preferredSlotKeys: "Mon-4,Wed-6",
    appliedYmd: "2026-10-20",
};

function lead(overrides = {}) {
    return {
        id: "t-1",
        childName: "김민수",
        parentPhone: "01012345678",
        status: "ATTENDED",
        childSchool: null,
        childGrade: null,
        childBirthYmd: null,
        slotKey: null,
        createdYmd: "2026-10-01",
        trialYmd: "2026-10-10",
        enrollApplicationId: null,
        ...overrides,
    };
}

test("한글 편집거리는 음절 단위로 센다", () => {
    assert.equal(syllableEditDistance("김민수", "김민서"), 1);
    assert.equal(syllableEditDistance("김민수", "김수"), 1);
    assert.equal(syllableEditDistance("김민수", "이민서"), 2);
    assert.equal(syllableEditDistance("김민수", "김민수"), 0);
});

test("학교 이름은 '초등학교/초' 표기 차이를 무시한다", () => {
    assert.equal(normalizeSchool("다산초등학교"), normalizeSchool("다산초"));
    assert.equal(normalizeSchool(" 다산 초 "), "다산");
    assert.equal(normalizeSchool("초"), "");
});

test("번호 같고 이름 같으면 AUTO", () => {
    const r = decideTrialLeadMatch(APP, [lead()]);
    assert.equal(r.decision, "AUTO");
    assert.equal(r.trialLeadId, "t-1");
});

test("형(민수) 체험 + 동생(민서) 신청 — 번호·성 같고 1글자 차이여도 같은 아이 근거가 없으면 SUGGEST", () => {
    const app = { ...APP, childName: "김민서", childSchool: null, childGrade: null, childBirthYmd: null, preferredSlotKeys: null };
    const r = decideTrialLeadMatch(app, [lead({ childName: "김민수" })]);
    assert.equal(r.decision, "SUGGEST");
    assert.equal(r.trialLeadId, null);
    assert.match(r.candidates[0].reason, /근거 없음/);
    // 학교만 같은 것도 근거 부족(형제는 같은 학교를 다닌다)
    const schoolOnly = decideTrialLeadMatch(APP, [lead({ childName: "김민서", childSchool: "다산초" })]);
    assert.equal(schoolOnly.decision, "SUGGEST");
});

test("번호·성 같고 1글자 오타 + 생년월일 같음이면 AUTO (실제 사고 유형)", () => {
    const r = decideTrialLeadMatch(APP, [lead({ childName: "김민서", childBirthYmd: "2017-05-01" })]);
    assert.equal(r.decision, "AUTO");
    assert.equal(r.trialLeadId, "t-1");
    assert.match(r.reason, /1글자/);
});

test("1글자 오타 + (학교+학년 같음) 또는 (체험 반 = 희망 반 + 학년 같음)이면 AUTO", () => {
    const schoolGrade = decideTrialLeadMatch(APP, [lead({ childName: "김민서", childSchool: "다산초", childGrade: "초등 3학년" })]);
    assert.equal(schoolGrade.decision, "AUTO");
    const slotGrade = decideTrialLeadMatch(APP, [lead({ childName: "김민서", slotKey: "Mon-4", childGrade: "초3" })]);
    assert.equal(slotGrade.decision, "AUTO");
});

test("1글자 오타 + 체험 반만 같음(학년·생년 정보 없음)은 형제일 수 있어 SUGGEST", () => {
    const slotOnly = decideTrialLeadMatch(APP, [lead({ childName: "김민서", slotKey: "Mon-4" })]);
    assert.equal(slotOnly.decision, "SUGGEST");
});

test("번호로 좁혀 읽는 신청 제출 경로는 체험 생성일 기간으로 자르지 않는다(완전 일치 회귀 방지)", async () => {
    const svc = await readFile("src/lib/enrollment/trialLeadLinkService.ts", "utf8");
    const select = svc.slice(svc.indexOf("const CANDIDATE_SELECT"), svc.indexOf("function toCandidate"));
    assert.doesNotMatch(select, /createdAt"\s*>=\s*NOW\(\)/, "공통 후보 SELECT 에 기간 조건이 있으면 오래된 완전 일치 체험이 안 붙는다");
});

test("이름 띄어쓰기 차이는 같은 이름으로 본다", () => {
    const r = decideTrialLeadMatch(APP, [lead({ childName: "김 민수 " })]);
    assert.equal(r.decision, "AUTO");
});

test("번호 같아도 성이 다르면(1글자 차이) 자동 연결하지 않고 SUGGEST", () => {
    const r = decideTrialLeadMatch(APP, [lead({ childName: "이민수" })]);
    assert.equal(r.decision, "SUGGEST");
    assert.equal(r.trialLeadId, null);
    assert.equal(r.candidates[0].trialLeadId, "t-1");
});

test("번호 같고 오타 후보지만 생년월일이 다르면(형제자매 의심) SUGGEST", () => {
    const r = decideTrialLeadMatch(APP, [lead({ childName: "김민서", childBirthYmd: "2019-02-02" })]);
    assert.equal(r.decision, "SUGGEST");
    assert.equal(r.trialLeadId, null);
});

test("이름이 2글자 이상 다르면 번호가 같아도 후보 아님(형제자매)", () => {
    const r = decideTrialLeadMatch(APP, [lead({ childName: "김지아" })]);
    assert.equal(r.decision, "NONE");
});

test("번호가 다르면 이름이 같아도 추가 근거 없이는 NONE", () => {
    const r = decideTrialLeadMatch(APP, [lead({ parentPhone: "010-9999-0000" })]);
    assert.equal(r.decision, "NONE");
});

test("번호가 달라도 이름 같고 학교/학년/생년/체험 반 중 하나가 같으면 SUGGEST", () => {
    const school = decideTrialLeadMatch(APP, [lead({ parentPhone: "010-9999-0000", childSchool: "다산초" })]);
    assert.equal(school.decision, "SUGGEST");
    assert.match(school.candidates[0].reason, /학교 같음/);

    const slot = decideTrialLeadMatch(APP, [lead({ parentPhone: "010-9999-0000", childName: "김민서", slotKey: "Wed-6" })]);
    assert.equal(slot.decision, "SUGGEST");
    assert.match(slot.candidates[0].reason, /체험 반 같음/);

    const birth = decideTrialLeadMatch(APP, [lead({ parentPhone: "010-9999-0000", childBirthYmd: "2017-05-01" })]);
    assert.equal(birth.decision, "SUGGEST");
    // 번호가 다른 경우는 절대 AUTO 가 아니다
    assert.equal(birth.trialLeadId, null);
});

test("오타 후보가 2명이면(쌍둥이 등) AUTO 금지 → SUGGEST, 둘 다 후보", () => {
    const r = decideTrialLeadMatch(APP, [
        lead({ id: "t-1", childName: "김민서", childBirthYmd: "2017-05-01" }),
        lead({ id: "t-2", childName: "김민우", childBirthYmd: "2017-05-01" }),
    ]);
    assert.equal(r.decision, "SUGGEST");
    assert.equal(r.trialLeadId, null);
    assert.deepEqual(r.candidates.map((c) => c.trialLeadId).sort(), ["t-1", "t-2"]);
    assert.ok(r.candidates.every((c) => c.strength === "SUGGEST"));
});

test("이름 완전 일치가 있으면 비슷한 이름(형제) 후보보다 우선해 AUTO", () => {
    const r = decideTrialLeadMatch(APP, [
        lead({ id: "sib", childName: "김민서" }),
        lead({ id: "me", childName: "김민수", status: "SCHEDULED" }),
    ]);
    assert.equal(r.decision, "AUTO");
    assert.equal(r.trialLeadId, "me");
});

test("같은 아이 체험 기록 중복(이름·번호 완전 일치 2건)은 예전 규칙대로 가장 진행된 기록에 AUTO", () => {
    const r = decideTrialLeadMatch(APP, [
        lead({ id: "new-dup", status: "NEW", createdYmd: "2026-10-05", trialYmd: null }),
        lead({ id: "attended", status: "ATTENDED" }),
    ]);
    assert.equal(r.decision, "AUTO");
    assert.equal(r.trialLeadId, "attended");
});

test("이미 다른 신청서와 연결된 체험은 제외, 같은 신청서를 가리키면 허용", () => {
    assert.equal(decideTrialLeadMatch(APP, [lead({ enrollApplicationId: "app-other" })]).decision, "NONE");
    assert.equal(decideTrialLeadMatch(APP, [lead({ enrollApplicationId: "app-1" })]).decision, "AUTO");
});

test("종료 상태(CONVERTED·LOST·CANCELLED)는 제외", () => {
    for (const status of ["CONVERTED", "LOST", "CANCELLED"]) {
        assert.equal(decideTrialLeadMatch(APP, [lead({ status })]).decision, "NONE", status);
    }
});

test("기간 제한(120일·7일·30일)은 오타·SUGGEST 판정에만 적용", () => {
    const typo = { childName: "김민서", childBirthYmd: "2017-05-01" };
    // 신청일 2026-10-20 기준 121일 전 = 2026-06-21
    assert.equal(decideTrialLeadMatch(APP, [lead({ ...typo, createdYmd: "2026-06-21", trialYmd: null })]).decision, "NONE");
    assert.equal(decideTrialLeadMatch(APP, [lead({ ...typo, createdYmd: "2026-06-22", trialYmd: null })]).decision, "AUTO");
    // 신청 8일 뒤에 만든 체험 기록
    assert.equal(decideTrialLeadMatch(APP, [lead({ ...typo, createdYmd: "2026-10-28", trialYmd: null })]).decision, "NONE");
    // 체험일이 신청 31일 뒤
    assert.equal(decideTrialLeadMatch(APP, [lead({ ...typo, trialYmd: "2026-11-20" })]).decision, "NONE");
    assert.equal(decideTrialLeadMatch(APP, [lead({ ...typo, trialYmd: "2026-11-19" })]).decision, "AUTO");
    // 번호 다른 SUGGEST 도 기간 밖이면 후보 아님
    assert.equal(decideTrialLeadMatch(APP, [lead({ parentPhone: "010-9999-0000", childSchool: "다산초", createdYmd: "2025-01-01", trialYmd: null })]).decision, "NONE");
});

test("이름·번호 완전 일치는 예전처럼 기간 제한 없이 AUTO (종료 상태·타 신청 연결 제외는 유지)", () => {
    assert.equal(decideTrialLeadMatch(APP, [lead({ createdYmd: "2025-01-01", trialYmd: "2025-01-10" })]).decision, "AUTO");
    assert.equal(decideTrialLeadMatch(APP, [lead({ createdYmd: "", trialYmd: null })]).decision, "AUTO");
    assert.equal(decideTrialLeadMatch(APP, [lead({ createdYmd: "2025-01-01", status: "LOST" })]).decision, "NONE");
    assert.equal(decideTrialLeadMatch(APP, [lead({ createdYmd: "2025-01-01", enrollApplicationId: "app-other" })]).decision, "NONE");
});

test("재제출: 자기 신청서에 연결된 체험은 applicationId 를 넘기면 그대로 AUTO", () => {
    const linkedToMe = lead({ enrollApplicationId: "app-1" });
    assert.equal(decideTrialLeadMatch(APP, [linkedToMe]).trialLeadId, "t-1");
    // applicationId 를 안 넘기면 '다른 신청서와 연결'로 제외된다 — 그래서 public.ts 가 기존 신청서 id 를 넘긴다
    assert.equal(decideTrialLeadMatch({ ...APP, applicationId: null }, [linkedToMe]).decision, "NONE");
});

test("체험 수정 후 재비교: 이 체험을 AUTO 로 가리키는 신청서 선택 규칙", () => {
    const auto = (id) => ({ decision: "AUTO", trialLeadId: id, reason: "", candidates: [] });
    const none = { decision: "NONE", trialLeadId: null, reason: "", candidates: [] };
    // 1건이면 그것
    assert.equal(selectApplicationForTrialAutoLink("t", "김민수", [
        { applicationId: "a", childName: "김민서", decision: auto("t") },
        { applicationId: "b", childName: "김민수", decision: auto("other") },
        { applicationId: "c", childName: "김민수", decision: none },
    ]), "a");
    // 2건 이상 → 이름 완전 일치 1건만 있으면 그것
    assert.equal(selectApplicationForTrialAutoLink("t", "김민수", [
        { applicationId: "a", childName: "김민서", decision: auto("t") },
        { applicationId: "b", childName: "김 민수", decision: auto("t") },
    ]), "b");
    // 2건 이상인데 완전 일치가 0건이거나 2건 이상이면 자동 연결하지 않는다
    assert.equal(selectApplicationForTrialAutoLink("t", "김민수", [
        { applicationId: "a", childName: "김민서", decision: auto("t") },
        { applicationId: "b", childName: "김민우", decision: auto("t") },
    ]), null);
    assert.equal(selectApplicationForTrialAutoLink("t", "김민수", [
        { applicationId: "a", childName: "김민수", decision: auto("t") },
        { applicationId: "b", childName: "김민수", decision: auto("t") },
    ]), null);
    assert.equal(selectApplicationForTrialAutoLink("t", "김민수", []), null);
});

test("빈 번호·자리채움 번호로는 AUTO 하지 않는다", () => {
    const app = { ...APP, parentPhone: "000-0000-0000" };
    const r = decideTrialLeadMatch(app, [lead({ parentPhone: "00000000000" })]);
    assert.notEqual(r.decision, "AUTO");
});

test("자격 판정: 날짜가 깨진 후보는 안전하게 제외", () => {
    assert.equal(isEligibleTrialCandidate(APP, lead({ createdYmd: "" })), false);
    assert.equal(isEligibleTrialCandidate({ ...APP, appliedYmd: "2026-02-30" }, lead()), false);
});

// ── 연결부 소스 가드 ───────────────────────────────────────────────────

const service = await readFile("src/lib/enrollment/trialLeadLinkService.ts", "utf8");
const publicActions = await readFile("src/app/actions/public.ts", "utf8");
const adminActions = await readFile("src/app/actions/admin.ts", "utf8");

test("연결부는 raw SQL 만 쓰고, 문자·알림을 보내지 않는다", () => {
    assert.doesNotMatch(service, /\.(findMany|findFirst|findUnique|create|update|upsert|delete)\(/);
    assert.doesNotMatch(service, /sendParentSms|sendSms|notifyAdmins|solapi/i);
    // 이미 연결된 쪽을 덮어쓰지 않는 조건부 UPDATE
    assert.match(service, /"trialLeadId" IS NULL/);
    assert.match(service, /t\."enrollApplicationId" IS NULL OR t\."enrollApplicationId" = \$1/);
    assert.match(service, /\$transaction/);
});

test("신청 제출은 이름 완전일치 SQL 대신 판정 모듈로 연결하고, AUTO 만 자동 연결한다", () => {
    assert.match(publicActions, /decideTrialLeadForNewApplication\(/);
    assert.match(publicActions, /decision\.decision === "AUTO" \? decision\.trialLeadId : null/);
    assert.doesNotMatch(publicActions, /WHERE TRIM\("childName"\) = \$1/);
});

test("재제출은 기존 체험 연결을 지우지 않는다(COALESCE) + 기존 신청서 id 를 판정에 넘긴다", () => {
    assert.match(publicActions, /"trialLeadId" = COALESCE\(\$1, "trialLeadId"\)/);
    assert.doesNotMatch(publicActions, /^\s*"trialLeadId" = \$1,\s*$/m);
    assert.match(publicActions, /applicationId: priorApplicationId,/);
    assert.match(publicActions, /matchedTrialLeadId = priorRows\[0\]\?\.trialLeadId \?\? null/);
    // 재비교가 첫 건을 잡지 않고 선택 규칙을 쓴다
    assert.match(service, /selectApplicationForTrialAutoLink\(/);
    assert.doesNotMatch(service, /break; \/\/ 체험 기록 1건/);
});

test("체험 기록 이름·번호 수정 후 재비교, 관리자 연결 액션은 requireAdmin", () => {
    assert.match(adminActions, /data\.childName !== undefined \|\| data\.parentPhone !== undefined[\s\S]{0,200}autoLinkApplicationsForTrialLead\(/);
    assert.match(adminActions, /export async function linkEnrollApplicationToTrialLead[\s\S]{0,120}await requireAdmin\(\)/);
    assert.match(adminActions, /export async function getEnrollTrialLinkSuggestions[\s\S]{0,120}await requireAdmin\(\)/);
});
