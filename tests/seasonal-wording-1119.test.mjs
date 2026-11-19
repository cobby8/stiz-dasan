import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-19 원장 점검표 답 — 방학특강 4건
//   1. «기존/신규» → «재원생/신입생» (보이는 글자만, 코드 값 EXISTING/NEW 는 그대로)
//   2. 기간별 수강료가 제대로 세팅됐는지 한 줄 요약(신입생·재원생·셔틀·마감)
//   3. 재원생 기준을 신청 화면 선택지 옆에
//   4. 공개 «프로그램» 목록에서 방학특강 전용 프로그램 빼기

const pricing = await loadTsModule("src/lib/seasonal/period-pricing.ts");
const read = (file) => readFileSync(file, "utf8");

test("구분 이름: EXISTING = 재원생 · NEW = 신입생 · 모르는 값은 fallback", () => {
  assert.equal(pricing.APPLICANT_TYPE_LABEL.EXISTING, "재원생");
  assert.equal(pricing.APPLICANT_TYPE_LABEL.NEW, "신입생");
  assert.equal(pricing.applicantTypeLabel("EXISTING"), "재원생");
  assert.equal(pricing.applicantTypeLabel("NEW"), "신입생");
  assert.equal(pricing.applicantTypeLabel(null), "");
  assert.equal(pricing.applicantTypeLabel("OTHER", "-"), "-");
});

// 운영 DB 1차 시즌(2027-winter-1) 초등 반 6개 × 기간 2줄 — 2026-11-19 읽기 전용 SELECT 로 뽑은 값 그대로
//   (반 셔틀비: 주2회 10,000 · 주3회 15,000 · 주5회 20,000, 기간 셔틀비는 모두 비어 있음 = 반 셔틀비)
const FOUR_CLOSE = "2027-01-01T09:00:00.000Z"; // KST 1/1(금) 18:00
const THREE_CLOSE = "2027-01-08T09:00:00.000Z"; // KST 1/8(금) 18:00
const DB_ROWS = [];
for (const grade of ["초등 고학년", "초등 저학년"]) {
  for (const [freq, shuttleFee, four, three] of [
    ["주2회", 10000, [240000, 240000, 200000], [180000, 180000, 150000]],
    ["주3회", 15000, [324000, 324000, 264000], [243000, 243000, 198000]],
    ["매일(주5회)", 20000, [480000, 480000, 400000], [360000, 360000, 300000]],
  ]) {
    const offering = { title: `${grade} ${freq}`, shuttleAvailable: true, shuttleFee };
    DB_ROWS.push({ offering, period: { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: four[0], newApplicantPrice: four[1], existingApplicantPrice: four[2], shuttleFee: null, isActive: true, applicationClosesAt: FOUR_CLOSE } });
    DB_ROWS.push({ offering, period: { label: "3주", startDate: "2027-01-11", endDate: "2027-01-29", price: three[0], newApplicantPrice: three[1], existingApplicantPrice: three[2], shuttleFee: null, isActive: true, applicationClosesAt: THREE_CLOSE } });
  }
}

test("기간 요약: 운영 DB 12줄이 «기간 · 신입생 · 재원생 · 셔틀 · 마감» 한 줄로 그대로 렌더된다", () => {
  assert.equal(DB_ROWS.length, 12);
  const html = renderToStaticMarkup(React.createElement("div", null,
    DB_ROWS.map(({ offering, period }, index) => React.createElement("p", { key: index, "data-period-summary": "" }, `${offering.title} ${pricing.periodPriceSummary(period, offering)}`))));
  const expected = [
    "초등 고학년 주2회 4주 · 신입생 240,000원 · 재원생 200,000원 · 셔틀 10,000원 · 마감 1/1(금) 18:00",
    "초등 고학년 주2회 3주 · 신입생 180,000원 · 재원생 150,000원 · 셔틀 10,000원 · 마감 1/8(금) 18:00",
    "초등 고학년 주3회 4주 · 신입생 324,000원 · 재원생 264,000원 · 셔틀 15,000원 · 마감 1/1(금) 18:00",
    "초등 고학년 주3회 3주 · 신입생 243,000원 · 재원생 198,000원 · 셔틀 15,000원 · 마감 1/8(금) 18:00",
    "초등 고학년 매일(주5회) 4주 · 신입생 480,000원 · 재원생 400,000원 · 셔틀 20,000원 · 마감 1/1(금) 18:00",
    "초등 고학년 매일(주5회) 3주 · 신입생 360,000원 · 재원생 300,000원 · 셔틀 20,000원 · 마감 1/8(금) 18:00",
    "초등 저학년 주2회 4주 · 신입생 240,000원 · 재원생 200,000원 · 셔틀 10,000원 · 마감 1/1(금) 18:00",
    "초등 저학년 주2회 3주 · 신입생 180,000원 · 재원생 150,000원 · 셔틀 10,000원 · 마감 1/8(금) 18:00",
    "초등 저학년 주3회 4주 · 신입생 324,000원 · 재원생 264,000원 · 셔틀 15,000원 · 마감 1/1(금) 18:00",
    "초등 저학년 주3회 3주 · 신입생 243,000원 · 재원생 198,000원 · 셔틀 15,000원 · 마감 1/8(금) 18:00",
    "초등 저학년 매일(주5회) 4주 · 신입생 480,000원 · 재원생 400,000원 · 셔틀 20,000원 · 마감 1/1(금) 18:00",
    "초등 저학년 매일(주5회) 3주 · 신입생 360,000원 · 재원생 300,000원 · 셔틀 20,000원 · 마감 1/8(금) 18:00",
  ];
  for (const line of expected) assert.ok(html.includes(`<p data-period-summary="">${line}</p>`), line);
});

test("기간 요약: 빈 칸은 기본 수강료로 계산 · 셔틀 불가 반은 셔틀 생략 · 마감 없으면 시즌 마감 · 기간 셔틀비 우선", () => {
  const base = { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: 240000 };
  assert.equal(pricing.periodPriceSummary(base, { shuttleAvailable: false }), "4주 · 신입생 240,000원 · 재원생 240,000원 · 마감 = 시즌 모집 마감");
  assert.equal(pricing.periodPriceSummary({ ...base, existingApplicantPrice: 200000, shuttleFee: 0 }, { shuttleAvailable: true, shuttleFee: 10000 }), "4주 · 신입생 240,000원 · 재원생 200,000원 · 셔틀 0원 · 마감 = 시즌 모집 마감");
  // KST 자정 경계 — UTC 1/1 15:00 = KST 1/2(토) 00:00
  assert.equal(pricing.periodPriceSummary({ ...base, applicationClosesAt: new Date("2027-01-01T15:00:00.000Z") }, null), "4주 · 신입생 240,000원 · 재원생 240,000원 · 마감 1/2(토) 00:00");
});

test("관리자 화면: 기간 요약을 반 편집 줄(입력 중 값)과 시즌 화면 가격 카드 두 곳에 쓴다 · 칸 라벨은 재원생/신입생", () => {
  const admin = read("src/app/admin/seasonal/SeasonalAdminClient.tsx");
  assert.match(admin, /적용: \{periodPriceSummary\(periodFromDraft\(row\), shuttle\)\}/);
  assert.match(admin, /\{periodPriceSummary\(period, \{ shuttleAvailable: group\.baseClass\.shuttleAvailable, shuttleFee: rule\.shuttleFee \}\)\}/);
  assert.match(admin, />신입생 수강료<input /);
  assert.match(admin, />재원생 수강료<input /);
  assert.match(admin, /label="신입생 수강료"/);
  assert.match(admin, /label="재원생 수강료"/);
  assert.match(admin, /신입생 \{\(rule\.newPrice \?\? rule\.price\)\.toLocaleString\(\)\}원/);
  assert.match(admin, /재원생 \{\(rule\.existingPrice \?\? rule\.price\)\.toLocaleString\(\)\}원/);
  // 저장된 값이 칸에 채워지는가 — 기간 행 → 입력칸 변환(periodDraftFrom)이 신입생·재원생 값을 그대로 옮긴다
  assert.match(admin, /newApplicantPrice: text\(period\.newApplicantPrice\)/);
  assert.match(admin, /existingApplicantPrice: text\(period\.existingApplicantPrice\)/);
});

test("보이는 글자에 «기존 회원/신규 회원·기존/신규» 구분이 남지 않는다(특강 화면·서버 오류)", () => {
  const files = [
    "src/components/seasonal/SeasonalApplyClient.tsx",
    "src/components/seasonal/StudentDetailModal.tsx",
    "src/app/admin/seasonal/SeasonalAdminClient.tsx",
    "src/app/api/admin/seasonal/route.ts",
    "src/lib/seasonal/admin-period-rules.ts",
  ];
  for (const file of files) {
    // 주석 줄은 빼고 본다
    const code = read(file).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)).join("\n");
    assert.doesNotMatch(code, /기존 회원|신규 회원|"신규"|"기존"|신규 수강료|재원 수강료|회당 신규|회당 재원 /, file);
  }
  const apply = read("src/components/seasonal/SeasonalApplyClient.tsx");
  assert.match(apply, /재원생·신입생 구분 \*/);
  assert.match(apply, /APPLICANT_TYPE_CHOICES\.map/);
});

test("공개 프로그램 목록: 방학특강 전용 프로그램(연결 반이 모두 Seasonal)을 /programs·홈에서 뺀다, 관리자 조회는 그대로", () => {
  const queries = read("src/lib/queries.ts");
  assert.match(queries, /EXISTS \(SELECT 1 FROM "Class" c WHERE c\."programId" = p\.id AND c\."dayOfWeek" = 'Seasonal'\)/);
  assert.match(queries, /NOT EXISTS \(SELECT 1 FROM "Class" c WHERE c\."programId" = p\.id AND c\."dayOfWeek" NOT IN \('Seasonal', 'Archived'\)\)\) AS "seasonalOnly"/);
  assert.match(queries, /seasonalOnly: r\.seasonalOnly === true/);
  // getPrograms 는 행을 빼지 않는다(관리자·운영 화면이 같은 함수를 쓴다) — 표식만 단다
  assert.match(queries, /WHERE p\."deletedAt" IS NULL\s*ORDER BY p\."order" ASC, p\."createdAt" DESC/);
  assert.match(read("src/app/programs/page.tsx"), /allPrograms\.filter\(\(program\) => hasSellablePrice\(program\) && !program\.seasonalOnly\)/);
  const home = read("src/app/page.tsx");
  assert.match(home, /\.filter\(\(p\) => p\.imageUrl && hasSellablePrice\(p\) && !p\.seasonalOnly\)/);
  assert.match(home, /programs\.filter\(\(p\) => hasSellablePrice\(p\) && !p\.seasonalOnly\)\.length/);
});
