// 공개 홈페이지·로그인/가입 화면에 «개발 언어»(영어 오류 원문·HTTP 번호·영문 장식 라벨)가
// 다시 나타나지 않게 잠근다. (원장 지시 2026-10-30 「화면에 개발 언어처럼 남아 있는 부분 모두 제거」)
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { publicErrorText } from "../src/components/ui/public-error-text.ts";

const read = (path) => readFileSync(path, "utf8");
const FALLBACK = "잠시 후 다시 시도해 주세요.";

test("영어·개발 용어 오류 원문은 화면용 쉬운 안내로 바뀐다", () => {
  for (const raw of [
    "Authentication required",
    "enrollmentDateId required",
    "GEMINI_API_KEY 환경변수가 설정되지 않았습니다.",
    "An error occurred in the Server Components render.",
    "DB 연결 실패",
    "서버 오류가 발생했습니다 (status 500)",
    "Invalid login credentials",
    "[object Object]",
    "undefined",
  ]) {
    assert.equal(publicErrorText(new Error(raw), FALLBACK), FALLBACK, raw);
    assert.equal(publicErrorText(raw, FALLBACK), FALLBACK, raw);
  }
  // 에러가 아닌 값·빈 문장도 안내로
  assert.equal(publicErrorText(null, FALLBACK), FALLBACK);
  assert.equal(publicErrorText(undefined, FALLBACK), FALLBACK);
  assert.equal(publicErrorText({ message: "x" }, FALLBACK), FALLBACK);
  assert.equal(publicErrorText(new Error("   "), FALLBACK), FALLBACK);
});

test("한국어 업무 안내(입력 검증·중복 안내)는 그대로 보여 준다", () => {
  for (const message of [
    "아이 이름을 입력해주세요.",
    "올바른 전화번호를 입력해주세요. 예: 010-1234-5678",
    "신청이 너무 많이 접수되었습니다. 잠시 후 다시 시도해주세요.",
    "이미 가입된 휴대폰 번호입니다. 기존 아이디로 로그인한 뒤 마이페이지 → 간편로그인 연결에서 Apple·Google 을 연결해 주세요.",
    "Google 연결이 취소되었거나 완료되지 않았습니다.",
    "답변을 생성하는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
  ]) {
    assert.equal(publicErrorText(new Error(message), FALLBACK), message);
  }
});

test("공개 신청·로그인·특강·챗봇은 오류 원문 대신 publicErrorText 를 거친다", () => {
  const files = [
    "src/app/apply/enroll/EnrollApplicationForm.tsx",
    "src/app/apply/trial/TrialApplicationForm.tsx",
    "src/app/apply/uniform/UniformApplicationForm.tsx",
    "src/app/login/page.tsx",
    "src/app/setup/page.tsx",
    "src/components/seasonal/SeasonalApplyClient.tsx",
    "src/components/seasonal/StudentDetailModal.tsx",
    "src/components/seasonal/RouteSection.tsx",
    "src/components/chat/ChatPanel.tsx",
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /publicErrorText\(/, file);
    // 화면 상태에 err.message 를 그대로 넣는 옛 모양 금지
    assert.doesNotMatch(source, /set(Error|Message|Err)\([^)]*\b\w+\??\.message\b/, file);
  }
  // 로그인 주소창 ?error= 값도 거른다
  assert.match(read("src/app/login/page.tsx"), /publicErrorText\(searchParams\.get\("error"\)/);
  // 챗봇은 서버 data.error 를 그대로 말풍선에 넣지 않는다
  assert.doesNotMatch(read("src/components/chat/ChatPanel.tsx"), /data\.error \|\|/);
});

test("404 숫자와 영문 장식 라벨이 공개 화면에 없다", () => {
  assert.doesNotMatch(read("src/app/not-found.tsx"), />404</);
  assert.match(read("src/app/not-found.tsx"), /페이지를 찾을 수 없습니다/);

  const about = read("src/app/about/page.tsx");
  assert.doesNotMatch(about, /label="(INTRODUCTION|PHILOSOPHY|COACHES|FACILITIES|LOCATION)"/);
  assert.match(about, /title="원장 인사말"/);
  assert.match(about, /title="오시는 길"/);

  const apply = read("src/app/apply/ApplyPageClient.tsx");
  assert.doesNotMatch(apply, />Trial Class<|>Enrollment<|label="FAQ"/);
  assert.match(apply, />체험수업<\/p>/);
  assert.match(apply, />정규 수강<\/p>/);
  assert.match(apply, /title="자주 묻는 질문"/);
});

// 공개 화면 범위 전체를 훑어 영어 상태값·개발 문장이 JSX 글자로 박히지 않았는지 본다.
const SCOPE = [
  "src/app/page.tsx", "src/app/LandingPageClient.tsx", "src/app/about", "src/app/schedule", "src/app/annual",
  "src/app/gallery", "src/app/notices", "src/app/faq", "src/app/apply", "src/app/seasonal", "src/app/shop",
  "src/app/simulator", "src/app/login", "src/app/signup", "src/app/setup", "src/app/terms", "src/app/privacy",
  "src/app/error.tsx", "src/app/not-found.tsx", "src/app/parent-app", "src/app/teacher-app", "src/app/store-app",
  "src/components/landing", "src/components/chat", "src/components/guide-tour", "src/components/seasonal",
];
function collect(path, out = []) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) collect(join(path, name), out);
  } else if (path.endsWith(".tsx")) out.push(path);
  return out;
}

test("공개 화면 JSX 글자에 영어 상태값·개발 용어·SectionLayout 영문 라벨이 없다", () => {
  const files = SCOPE.flatMap((path) => collect(path));
  assert.ok(files.length > 30);
  const jsxText = />\s*(OPEN|CLOSED|FULL|PENDING|ACTIVE|null|undefined|NaN|TODO|Lorem[^<]*|Loading\.\.\.|Error)\s*</;
  const devSentence = />[^<{]*(API|Supabase|Vercel|PgBouncer|쿼리|환경변수|에러 코드)[^<{]*</;
  for (const file of files) {
    // 주석은 화면에 안 보이므로 빼고 본다
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    assert.doesNotMatch(source, jsxText, file);
    assert.doesNotMatch(source, devSentence, file);
    assert.doesNotMatch(source, /<SectionLayout[^>]*\blabel="[A-Z][A-Z ]+"/, file);
  }
});
