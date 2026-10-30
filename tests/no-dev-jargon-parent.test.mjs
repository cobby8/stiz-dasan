// 학부모(고객) 화면에 개발 언어가 남지 않게 막는 회귀 테스트 (2026-10-30 원장 지시
// «화면에 개발 언어처럼 남아 있는 부분 확인하고 모두 제거해»).
// 지키는 약속: ① 오류 원문(err.message·영어)을 그대로 띄우지 않는다 → customerMessage 로 고객용 한국어
//             ② 상태값·종류 영어 코드(PENDING 등)를 라벨이 없을 때도 그대로 보이지 않는다
//             ③ 내부 시스템 이름·개발 용어(시트·랠리즈, 자연어, 푸시 구독, 사용자 키…)를 고객 문장에 쓰지 않는다
// 범위 밖: 결제·납부 화면(토스 카드사 심사 중 문구 변경 금지), 다른 작업 중인 MyPageClient·리포트 상세.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(path, "utf8");

function compileModule(path) {
  const compiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  const logged = [];
  vm.runInNewContext(compiled, { module, exports: module.exports, console: { error: (...args) => logged.push(args) } });
  return { ...module.exports, logged };
}

// 학부모 화면 폴더 — 결제 화면과 다른 작업자가 맡은 두 파일은 뺀다
const ROOTS = ["src/app/mypage", "src/app/account", "src/app/request", "src/app/kakao-connect", "src/components/account", "src/components/parent"];
const EXCLUDED = new Set([
  "src/app/mypage/MyPageClient.tsx",
  "src/app/mypage/reports/[sessionId]/page.tsx",
  "src/app/mypage/payments/PaymentRequestClient.tsx",
  "src/app/mypage/payments/page.tsx",
  "src/app/mypage/history/HistoryClient.tsx", // 수납 탭(결제 구역) 포함
]);
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name).replaceAll("\\", "/");
    return statSync(path).isDirectory() ? walk(path) : /\.(tsx?|mjs)$/.test(path) ? [path] : [];
  });
}
const FILES = ROOTS.flatMap(walk).filter((path) => !EXCLUDED.has(path) && !path.endsWith("customerMessage.ts"));

// 주석을 지운 뒤 «사람에게 보이는 한국어 글»만 뽑는다(코드 식별자·주석·console 은 대상 아님)
function visibleKorean(source) {
  const noComments = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line) && !/console\.(log|error|warn)/.test(line))
    .map((line) => line.replace(/\s\/\/[^"'`]*$/, ""))
    .join("\n");
  return [...noComments.matchAll(/["'`>]([^"'`<>{}]*[가-힣][^"'`<>{}]*)/g)].map((m) => m[1]);
}

test("customerMessage: 고객용 한국어만 그대로, 영어 원문·개발 용어는 쉬운 문장으로 바꾸고 원문은 console 에 남긴다", () => {
  const { customerMessage, isCustomerFriendly, logged } = compileModule("src/components/parent/customerMessage.ts");
  const fallback = "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  assert.equal(customerMessage("이미 예약된 보강입니다.", fallback), "이미 예약된 보강입니다.");
  assert.equal(customerMessage(new Error("자리가 없습니다."), fallback), "자리가 없습니다.");
  assert.equal(customerMessage(new TypeError("Failed to fetch"), fallback), fallback);
  assert.equal(customerMessage(new SyntaxError("Unexpected token < in JSON at position 0"), fallback), fallback);
  assert.equal(customerMessage("서버 오류(500)가 발생했습니다", fallback), fallback);
  assert.equal(customerMessage("세션이 만료되었습니다", fallback), fallback);
  assert.equal(customerMessage("undefined", fallback), fallback);
  assert.equal(customerMessage(undefined, fallback), fallback);
  assert.equal(customerMessage("", fallback), fallback);
  assert.ok(logged.length >= 4, "바꿔 치운 원문은 개발자 도구에 남긴다");
  // 금액·날짜 숫자가 든 정상 안내는 막지 않는다
  assert.ok(isCustomerFriendly("9월 셔틀비 50,000원을 확인해 주세요."));
});

test("학부모 화면은 오류 원문(err.message)을 그대로 띄우지 않는다", () => {
  const raw = [
    /\(e as Error\)\.message/,
    /reason instanceof Error \? reason\.message/,
    /e instanceof Error \? e\.message/,
    /setErr\(r\.message\)/,
    /setError\(result\.error\)/,
    /text: result\.error \}/,
    /setMessage\(result\.message\)/,
  ];
  for (const path of FILES) {
    const source = read(path);
    for (const pattern of raw) assert.doesNotMatch(source, pattern, `${path}: 오류 원문 노출 → customerMessage 사용`);
  }
  // 주소로 넘어온 간편로그인 오류도 고객용 문장인지 거른다
  assert.match(read("src/app/mypage/login-methods/page.tsx"), /customerMessage\(params\.error\.slice\(0, 200\)/);
});

test("상태·종류 라벨이 없을 때도 영어 코드를 그대로 보이지 않는다", () => {
  const rawFallback = /(\?\?|\|\|)\s*(item|row|m|c|p|preview|child\.pending|command)\.(status|kind|direction|shuttleIntent)\s*\}/;
  for (const path of FILES) assert.doesNotMatch(read(path), rawFallback, `${path}: 라벨 없는 상태값이 영어 그대로 보임`);
  for (const path of FILES) assert.doesNotMatch(read(path), /\?\? preview\.(kind|shuttleIntent)\b/, `${path}: 요청 종류 코드 노출`);
});

test("고객 문장에 개발 용어·내부 시스템 이름을 쓰지 않는다", () => {
  const jargon = /(서버|토큰|세션|쿼리|캐시|웹뷰|네이티브|동기화|개발자|디버그|자연어|해석된|시트·랠리즈|외부 반영|사용자 키|원문|권한 이관|운행 명단 변경 기록|푸시 구독|푸시 전송 접수|사이트 알림 등록|담당 기사 연결|\bAPI\b|\bDB\b|Supabase|OAuth|undefined|null|NaN|TODO)/;
  for (const path of FILES) {
    for (const text of visibleKorean(read(path))) assert.doesNotMatch(text, jargon, `${path}: «${text.trim()}»`);
  }
});

test("셔틀 당일 변경 화면은 관리자용 알림 결과 문장 대신 학부모용 문장을 쓴다(건수·저장 흐름은 그대로)", () => {
  const source = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  assert.doesNotMatch(source, /deliveryStatusText\(|import \{[^}]*deliveryStatusText/);
  assert.match(source, /function parentDeliveryText\(summary: DeliveryStatusSummary \| null \| undefined\): string/);
  assert.match(source, /parentDeliveryText\(item\.notificationStatus\)/);
  assert.match(source, /if \(response\.status >= 500\) return reconcile\(body\);/);
  assert.match(source, /담당 기사님 배정은 학원에서 확인 중/);
});

test("카카오 요청 화면: 쉬운 말로 바꿔도 확인 단계·안전 안내는 그대로", () => {
  const form = read("src/app/request/[token]/ParentRequestForm.tsx");
  assert.match(form, /"편하게 적기"/);
  assert.match(form, /"요청 내용 정리하기"/);
  assert.match(form, /제출 즉시 수업·셔틀 정보가 바뀌지 않습니다/);
  assert.match(form, /확인한 내용으로 요청 보내기/);
  const reconfirm = read("src/app/request/reconfirm/[token]/KakaoParentReconfirmationClient.tsx");
  assert.match(reconfirm, /원장님의 최종 승인 전까지 수업·셔틀·청구 정보와 학원 기록은 바뀌지 않습니다/);
  assert.match(reconfirm, /확인한 내용으로 확정/);
});
