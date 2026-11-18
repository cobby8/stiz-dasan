// 방학특강 후속 4건(2026-11-18 원장 결정표 승인) 중 1·3·4번을 고정한다. 2번(청구 작업대 특강 제외)은 billing-workbench.test.mjs.
//  1. 시즌 폼에 소개·약관·환불 규정 여러 줄 입력칸 → API·공개 상세까지 이어지는가
//  3. 특강 신청서 «어떻게 알게 되셨나요» — 선택(필수 아님)·허용 목록 정규화·저장·관리자 표시
//  4. 홈 안내 띠 판정(모집 중/중간 합류만) · sitemap · 상세 검색 제목·설명
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const contracts = await loadTsModule("src/lib/seasonal/contracts.ts");
const seo = await loadTsModule("src/lib/seasonal/public-seo.ts");
const referral = await loadTsModule("src/lib/enrollment/referralSources.ts");

// ── 1. 소개·약관·환불 규정 ─────────────────────────────────────────

test("1. 시즌 폼에 description·termsText·cancellationPolicy 여러 줄 칸이 있고 기존 값을 채운다", () => {
  const admin = read("src/app/admin/seasonal/SeasonalAdminClient.tsx");
  for (const name of ["description", "termsText", "cancellationPolicy"]) assert.match(admin, new RegExp(`name: "${name}"`));
  assert.match(admin, /<textarea name=\{field\.name\}[^>]*defaultValue=\{initial\?\.\[field\.name\] \?\? ""\}/);
  assert.match(admin, /extra=\{<><SeasonTextFields initial=\{initial\} \/><SeasonDateSelectFields initial=\{initial\} \/><\/>\}/);
});

test("1. API 는 세 칸을 만들기·고치기 모두 받고, 공개 상세는 소개·환불 규정을 보인다", () => {
  const route = read("src/app/api/admin/seasonal/route.ts");
  assert.match(route, /termsText: cleanText\(data\.termsText, 10000\), cancellationPolicy: cleanText\(data\.cancellationPolicy, 10000\)/);
  assert.match(route, /if \(data\.cancellationPolicy !== undefined\) update\.cancellationPolicy = cleanText\(data\.cancellationPolicy, 10000\) \|\| null;/);
  const service = read("src/lib/seasonal/service.ts");
  assert.match(service, /summary: season\.description \|\| undefined/);
  assert.match(service, /refundPolicy: season\.cancellationPolicy \|\| undefined/);
  const detail = read("src/components/seasonal/SeasonalDetailClient.tsx");
  assert.match(detail, /program\.refundPolicy && <Notice title="취소·환불 안내"/);
});

// ── 3. 어떻게 알게 되셨나요 ─────────────────────────────────────────

function application(overrides = {}) {
  return {
    idempotencyKey: "test-key",
    child: { name: "홍길동", birthDate: "2015-01-01" },
    parent: { name: "보호자", phone: "010-1234-5678" },
    agreedTerms: true,
    agreedPrivacy: true,
    selectedWeekdays: ["MON"],
    items: [{ offeringId: "o1" }],
    ...overrides,
  };
}

test("3. 고르지 않으면 칸이 없고(저장 NULL), 신청은 그대로 통과한다", () => {
  for (const value of [undefined, null, "", "   "]) {
    const parsed = contracts.parseApplicationInput(application(value === undefined ? {} : { referralSource: value }));
    assert.equal("referralSource" in parsed, false, `입력 ${JSON.stringify(value)}`);
  }
});

test("3. 허용 값은 그대로, 목록 밖·문자열 아닌 값은 «기타»(OTHER)", () => {
  assert.equal(contracts.parseApplicationInput(application({ referralSource: "INSTAGRAM" })).referralSource, "INSTAGRAM");
  assert.equal(contracts.parseApplicationInput(application({ referralSource: " NAVER_SEARCH " })).referralSource, "NAVER_SEARCH");
  assert.equal(contracts.parseApplicationInput(application({ referralSource: "<script>" })).referralSource, "OTHER");
  assert.equal(contracts.parseApplicationInput(application({ referralSource: 123 })).referralSource, "OTHER");
});

test("3. 신청 화면 선택지는 모두 허용 목록 안이고, 이름은 한 곳(REFERRAL_SOURCE_LABELS)에서 가져온다", () => {
  const client = read("src/components/seasonal/SeasonalApplyClient.tsx");
  const block = client.match(/const SEASONAL_REFERRAL_VALUES[^=]*= \[([\s\S]*?)\];/);
  assert.ok(block, "선택지 목록을 찾지 못했다");
  const values = [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 5);
  for (const value of values) assert.ok(referral.REFERRAL_SOURCE_VALUES.includes(value), `${value} 이 허용 목록에 없다`);
  assert.match(client, /<option value="">선택 안 함<\/option>/);
  assert.match(client, /REFERRAL_SOURCE_LABELS\[value\]/);
  // 필수 아님 — 고르지 않으면 보내지 않는다
  assert.match(client, /\.\.\.\(form\.referralSource \? \{ referralSource: form\.referralSource \} : \{\}\)/);
});

test("3. 서버가 저장하고(마이그레이션·스키마 추가만) 관리자 상세가 이름으로 보인다", () => {
  assert.match(read("src/lib/seasonal/service.ts"), /referralSource: input\.referralSource \?\? null,/);
  const sql = read("prisma/migrations/20261118210000_seasonal_referral_source/migration.sql");
  assert.match(sql, /ALTER TABLE "SpecialProgramApplication"\s+ADD COLUMN IF NOT EXISTS "referralSource" TEXT;/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /DROP|DELETE|TRUNCATE|NOT NULL/i);
  assert.match(read("prisma/schema.prisma"), /model SpecialProgramApplication \{[\s\S]*?referralSource\s+String\?[\s\S]*?\n\}/);
  const admin = read("src/app/admin/seasonal/SeasonalAdminClient.tsx");
  assert.match(admin, /<Info label="알게 된 경로">\{referralSourceLabel\(application\.referralSource\) \|\| "선택 안 함"\}<\/Info>/);
});

// ── 4. 홈 안내 띠 · 검색 ─────────────────────────────────────────

const season = (overrides = {}) => ({
  slug: "2027-winter",
  title: "2027 겨울방학특강",
  status: "OPEN",
  lateJoinOpen: false,
  operationStart: "2027-01-03T15:00:00.000Z", // KST 2027-01-04(월) 00:00
  operationEnd: "2027-02-26T14:59:00.000Z",
  classes: [{ targetGrade: "초1~초3" }, { targetGrade: "초4~초6" }, { targetGrade: "초1~초3" }],
  ...overrides,
});

test("4. 모집 중 시즌이면 «모집 중 · 개강일» 띠, 링크는 상세 주소", () => {
  const banner = seo.pickHomeSeasonBanner([season()], "2026-11-18");
  assert.deepEqual(banner, { href: "/seasonal/2027-winter", text: "2027 겨울방학특강 모집 중 · 1/4(월) 개강" });
});

test("4. 개강일 KST 경계 — UTC 로는 전날(1/3 15:00Z)이어도 KST 1/4 로 표시, 개강 당일·이후엔 개강일을 빼고", () => {
  assert.equal(seo.pickHomeSeasonBanner([season()], "2027-01-03").text, "2027 겨울방학특강 모집 중 · 1/4(월) 개강");
  assert.equal(seo.pickHomeSeasonBanner([season()], "2027-01-04").text, "2027 겨울방학특강 모집 중");
});

test("4. 중간 합류 가능 시즌은 «중간 합류 신청 가능», 모집 중이 있으면 모집 중이 먼저", () => {
  const late = season({ slug: "late", title: "여름특강", status: "CLOSED", lateJoinOpen: true });
  assert.equal(seo.pickHomeSeasonBanner([late], "2026-11-18").text, "여름특강 중간 합류 신청 가능");
  assert.equal(seo.pickHomeSeasonBanner([late, season()], "2026-11-18").href, "/seasonal/2027-winter");
});

test("4. 모집 전·마감(중간 합류 없음)·끝난 시즌만 있으면 띠 없음(null)", () => {
  assert.equal(seo.pickHomeSeasonBanner([], "2026-11-18"), null);
  assert.equal(seo.pickHomeSeasonBanner([season({ status: "UPCOMING" }), season({ status: "CLOSED" }), season({ status: "ENDED", lateJoinOpen: true })], "2026-11-18"), null);
});

test("4. 띠 글자에 인원·자리 숫자가 없다(공개 화면 인원 비공개)", () => {
  const banner = seo.pickHomeSeasonBanner([season({ classes: [{ targetGrade: "초1" }] })], "2026-11-18");
  assert.doesNotMatch(banner.text, /명|자리|정원|마감임박/);
});

test("4. 상세 검색 제목은 지역어 포함, 설명은 기간·대상(중복 학년 한 번만)", () => {
  const result = seo.seasonDetailSeo(season());
  assert.equal(result.title, "2027 겨울방학특강 | 남양주 다산 농구 방학특강 | STIZ 다산2호점");
  assert.equal(result.description, "2027 겨울방학특강 — 수업 기간 1/4(월)~2/26(금) · 대상 초1~초3·초4~초6. 스티즈 농구교실 다산2호점 방학특강 안내를 확인하고 모바일로 신청하세요.");
  assert.deepEqual(seo.seasonDetailSeo(null), { ...seo.SEASON_DETAIL_FALLBACK_SEO });
  assert.match(seo.SEASON_DETAIL_FALLBACK_SEO.title, /남양주 다산 농구 방학특강/);
});

test("4. 홈은 특강 조회 실패를 따로 받아 띠만 숨기고, 캐시 정책(revalidate 60)은 그대로", () => {
  const page = read("src/app/page.tsx");
  assert.match(page, /export const revalidate = 60;/);
  assert.match(page, /listPublishedSeasons\(\)\.catch\(/);
  assert.match(page, /seasonBanner = pickHomeSeasonBanner\(seasons\);/);
  const landing = read("src/app/LandingPageClient.tsx");
  assert.match(landing, /\{seasonBanner && <Link/);
  assert.match(landing, /bg-\[var\(--color-public-secondary-soft\)\]/);
  assert.match(landing, /min-h-11/);
});

test("4. sitemap 에 /seasonal 과 공개 시즌 상세가 들어가고, 조회 실패해도 나머지 주소는 낸다", () => {
  const sitemap = read("src/app/sitemap.ts");
  assert.match(sitemap, /url: `\$\{baseUrl\}\/seasonal`/);
  assert.match(sitemap, /url: `\$\{baseUrl\}\/seasonal\/\$\{encodeURIComponent\(season\.slug\)\}`/);
  assert.match(sitemap, /season\.status !== "ENDED"/);
  assert.match(sitemap, /\} catch \(error\) \{/);
  assert.match(sitemap, /export const revalidate = 3600;/);
});

test("4. 상세 페이지는 buildPublicMetadata 로 메타를 만들고, 목록 메타에도 지역어가 있다", () => {
  const detail = read("src/app/seasonal/[slug]/page.tsx");
  assert.match(detail, /export async function generateMetadata/);
  assert.match(detail, /getPublishedSeason\(slug\)\.catch\(\(\) => null\)/);
  assert.match(detail, /buildPublicMetadata\(\{ \.\.\.seo, path: `\/seasonal\/\$\{encodeURIComponent\(slug\)\}` \}\)/);
  assert.match(read("src/app/seasonal/page.tsx"), /title: "남양주 다산 농구 방학특강 \| STIZ 농구교실 다산2호점"/);
});
