// 2026-11-13 대시보드·통계 개편 — 통계 규칙(학년·성별·지점·유니폼·비율·월 시리즈)을 실제 실행으로 못박는다.
// 학년·월 경계는 눈으로 읽어서는 틀린 걸 못 찾는다(요일 하루 밀림 버그가 그렇게 살아남았다).
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const r = await loadTsModule("src/lib/stats/statsRules.ts");
const s = await loadTsModule("src/lib/stats/sourceLabels.ts");

test("학년도는 3월 1일에 바뀐다 — 2월 말까지는 전년도", () => {
  assert.equal(r.schoolYearOf("2026-02-28"), 2025);
  assert.equal(r.schoolYearOf("2026-03-01"), 2026);
  assert.equal(r.schoolYearOf("2026-01-01"), 2025);
  assert.equal(r.schoolYearOf("2026-12-31"), 2026);
  assert.equal(r.schoolYearOf("2026-13-01"), null);
});

test("학년 = 학년도 − 출생연도 − 6 (3월 경계·1·2월)", () => {
  // 2014년생: 2026학년도 초6
  assert.equal(r.schoolGradeFromBirth("2014-05-10", "2026-11-13"), "초6");
  // 같은 아이가 2027년 2월(아직 2026학년도)엔 그대로 초6, 3월이 되면 중1
  assert.equal(r.schoolGradeFromBirth("2014-05-10", "2027-02-28"), "초6");
  assert.equal(r.schoolGradeFromBirth("2014-05-10", "2027-03-01"), "중1");
  // 1·2월생도 출생연도로만 센다(조기입학 관례를 따지지 않는다 — 원장 확정 기준)
  assert.equal(r.schoolGradeFromBirth("2014-01-15", "2026-11-13"), "초6");
  // 연말: 12월 31일과 다음 해 1월 1일은 같은 학년도
  assert.equal(r.schoolGradeFromBirth("2011-03-02", "2026-12-31"), "중3");
  assert.equal(r.schoolGradeFromBirth("2011-03-02", "2027-01-01"), "중3");
  assert.equal(r.schoolGradeFromBirth("2010-07-07", "2026-11-13"), "고1");
  assert.equal(r.schoolGradeFromBirth("2008-07-07", "2026-11-13"), "고3");
});

test("미취학(0 이하) = «7세 이하», 13 이상 = «성인», 못 읽으면 «미상»", () => {
  assert.equal(r.schoolGradeFromBirth("2020-04-01", "2026-11-13"), "7세 이하");
  assert.equal(r.schoolGradeFromBirth("2019-12-31", "2026-02-10"), "7세 이하");
  assert.equal(r.schoolGradeFromBirth("2019-12-31", "2026-03-02"), "초1");
  assert.equal(r.schoolGradeFromBirth("1990-01-01", "2026-11-13"), "성인");
  assert.equal(r.schoolGradeFromBirth(null, "2026-11-13"), "미상");
  assert.equal(r.schoolGradeFromBirth("2014/05/10", "2026-11-13"), "미상");
  assert.equal(r.schoolGradeFromBirth("2030-01-01", "2026-11-13"), "미상"); // 미래 생일 = 오입력
  assert.equal(r.gradeBandOf("초3"), "초등");
  assert.equal(r.gradeBandOf("중1"), "중등");
  assert.equal(r.gradeBandOf("7세 이하"), "7세 이하");
});

test("적힌 학년 글 읽기와 «확인 필요» 판정", () => {
  assert.equal(r.gradeLabelFromText("초6"), "초6");
  assert.equal(r.gradeLabelFromText("2026년 초등 5학년"), "초5");
  assert.equal(r.gradeLabelFromText("4학년"), "초4");
  assert.equal(r.gradeLabelFromText("중1"), "중1");
  assert.equal(r.gradeLabelFromText("고1"), "고1");
  assert.equal(r.gradeLabelFromText("7세"), "7세 이하");
  assert.equal(r.gradeLabelFromText("성인"), "성인");
  assert.equal(r.gradeLabelFromText(""), null);
  assert.equal(r.gradeLabelFromText("모름"), null);
  assert.equal(r.gradeNeedsCheck("초6", "초6"), false);
  assert.equal(r.gradeNeedsCheck("중1", "초6"), true);
  assert.equal(r.gradeNeedsCheck("초6", null), false); // 빈 글은 비교하지 않는다
  assert.equal(r.gradeNeedsCheck("미상", "초6"), false);
});

test("성별 표기 다섯 가지를 남·여·미입력으로", () => {
  for (const v of ["남자", "남", "MALE", "male", "M"]) assert.equal(r.normalizeGender(v), "남", v);
  for (const v of ["여자", "여", "FEMALE", "F"]) assert.equal(r.normalizeGender(v), "여", v);
  for (const v of [null, "", "  ", "기타"]) assert.equal(r.normalizeGender(v), "미입력", String(v));
});

// 2026-11-14 원장 결정: 이 사이트는 다산2호점만 관리한다(평내호평점은 앞으로 없다). «미지정»은 없다 — 비어 있으면 다산2호점.
test("지점 묶음 — 비어 있으면 다산2호점, 옛 기록의 지점(다산1·평내호평)은 이름 유지·열쇠 other", () => {
  assert.deepEqual(r.branchGroup("다산2호점"), { key: "dasan2", label: "다산2호점" });
  assert.deepEqual(r.branchGroup(""), { key: "dasan2", label: "다산2호점" });
  assert.deepEqual(r.branchGroup(null), { key: "dasan2", label: "다산2호점" });
  assert.deepEqual(r.branchGroup("다산1호점"), { key: "other", label: "다산1호점" });
  assert.deepEqual(r.branchGroup("평내호평점"), { key: "other", label: "평내호평점" });
  assert.equal(r.isStatsBranchKey("dasan2"), true);
  assert.equal(r.isStatsBranchKey("other"), false);
  // 고를 수 있는 지점은 없다 — 평내호평·미지정 열쇠가 다시 생기면 실패
  assert.deepEqual(r.STATS_BRANCHES.map((b) => b.key), ["all", "dasan2"]);
  assert.equal(r.isStatsBranchKey("pyeongnae"), false);
  assert.equal(r.isStatsBranchKey("none"), false);
});

test("유니폼 상태 9종 → 보유/진행 중/없음/확인 필요/해당없음", () => {
  const expected = {
    보유: "보유", 수령완료: "보유",
    신청: "진행 중", 주문: "진행 중", 미수령: "진행 중",
    미보유: "없음", 미신청: "없음",
    확인보류: "확인 필요", 해당없음: "해당없음",
  };
  for (const [status, group] of Object.entries(expected)) assert.equal(r.uniformGroup(status), group, status);
  assert.equal(r.uniformGroup(null), "확인 필요");
  assert.equal(r.uniformGroup(""), "확인 필요");
  assert.equal(r.uniformGroup("이상한 값"), "확인 필요");
});

test("비율 — 분모 0 이면 null(화면은 «–»), %p 표기", () => {
  assert.equal(r.rate(1, 3), 33);
  assert.equal(r.rate(2, 3), 67);
  assert.equal(r.rate(0, 0), null);
  assert.equal(r.rate(5, 0), null);
  assert.equal(r.formatRate(null), "–");
  assert.equal(r.formatRate(87), "87%");
  assert.equal(r.diffPoint(90, 87), 3);
  assert.equal(r.diffPoint(90, null), null);
  assert.equal(r.formatPoint(3), "+3%p");
  assert.equal(r.formatPoint(-2), "−2%p");
  assert.equal(r.formatPoint(null), "–");
  assert.equal(r.formatKRW(425000), "42.5만원");
  assert.equal(r.formatKRW(9000), "9,000원");
});

test("월 시리즈 — 연말을 넘어가고, 1월엔 연도 표시", () => {
  assert.deepEqual(r.monthSeries("2026-11", 4), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.deepEqual(r.lastMonths("2027-02", 4), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.deepEqual(r.lastMonths("2026-01", 2), ["2025-12", "2026-01"]);
  assert.deepEqual(r.monthSeries("bad", 3), []);
  assert.equal(r.monthShortLabel("2027-01"), "'27.1월");
  assert.equal(r.monthShortLabel("2026-11"), "11월");
});

test("구성 집계 — 정한 순서 먼저, 나머지는 많은 순", () => {
  assert.deepEqual(r.countBy(["초2", "초1", "초2", "성인", "기타", "기타", "기타"], ["초1", "초2"]), [
    { label: "초1", count: 1 }, { label: "초2", count: 2 }, { label: "기타", count: 3 }, { label: "성인", count: 1 },
  ]);
});

test("탭·기간 — 모르는 값은 기본값, 유니폼은 기간 없음", () => {
  assert.equal(r.isStatsTabKey("billing"), true);
  assert.equal(r.isStatsTabKey("x"), false);
  assert.equal(r.normalizeStatsPeriod("students", "6m"), "6m");
  assert.equal(r.normalizeStatsPeriod("students", "30d"), "12m");
  assert.equal(r.normalizeStatsPeriod("funnel", undefined), "30d");
  assert.equal(r.normalizeStatsPeriod("uniform", "12m"), "");
  assert.equal(r.periodMonths("6m"), 6);
});

test("유입경로 — 코드값 라벨과 원생 가입경로 문장 모으기", () => {
  assert.equal(s.sourceLabel("NAVER_SEARCH"), "네이버 키워드 검색");
  assert.equal(s.sourceLabel(""), "미입력");
  assert.equal(s.sourceLabel("NEW_CODE"), "NEW_CODE");
  const cases = {
    "네이버 키워드 검색(남양주 농구교실, 다산농구교실 등)": "네이버 키워드 검색",
    "네이버 키워드 검색": "네이버 키워드 검색",
    NAVER_SEARCH: "네이버 키워드 검색",
    "스티즈농구교실 네이버 블로그": "네이버 블로그",
    "네이버 외(다음, 구글 등) 포털검색": "기타 포털검색",
    "지인소개": "지인소개",
    REFERRAL: "지인소개",
    "지나가다 발견": "지나가다 발견",
    "기존수강생 또는 이전 수강이력 있음": "기존 수강생",
    "숨고": "숨고",
    "인스타그램": "인스타그램",
  };
  for (const [raw, label] of Object.entries(cases)) assert.equal(s.normalizeReferral(raw), label, raw);
  assert.equal(s.normalizeReferral(null), "미입력");
  assert.equal(s.normalizeReferral("처음 보는 경로"), "처음 보는 경로");
});
