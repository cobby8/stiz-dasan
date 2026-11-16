// 선생님 «음성으로 기록»: 마이크 허용 문서 규칙·새로 불러오기 판정·원인별 안내·음성 변환 라우트(2026-11-17)
// 날짜·시계에 기대는 단정은 없다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  pathFromDocumentUrl,
  readMicFeatureAllowed,
  shouldReloadStaffDocument,
  staffDocumentAllowsMic,
} from "../src/lib/staff/documentPolicy.ts";
import { VOICE_START_MESSAGES, voiceErrorName, voiceStartFailure } from "../src/lib/staff/voiceStartError.ts";
import { userErrorMessage } from "../src/components/staff/userErrorMessage.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ── 마이크 허용 문서 규칙 ───────────────────────────────────────────

test("처음 불러온 문서가 선생님 화면(설치 안내 제외)일 때만 마이크 허용으로 본다", () => {
  for (const path of ["/staff", "/staff/", "/staff/sessions/a", "/staff/login", "/staff/run", "/staff/install/extra"]) {
    assert.equal(staffDocumentAllowsMic(path), true, path);
  }
  for (const path of ["/staff/install", "/staff/install/", "/login", "/mypage", "/", "/store-app", "/auth/continue", "/teacher-app", "/staffx", "/api/staff/x", "", null, undefined]) {
    assert.equal(staffDocumentAllowsMic(path), false, String(path));
  }
});

test("경로 규칙이 next.config.ts 의 머리글 규칙과 같다(한쪽만 바뀌면 깨진다)", () => {
  const config = read("next.config.ts");
  const policyOf = (source) => {
    // 같은 주소가 «주소 바꿔 주기» 규칙에도 나오므로, 머리글(headers) 규칙 묶음만 본다
    const blocks = config.split(/(?=source: ")/).filter((block) => block.startsWith(`source: "${source}",`) && /^source: "[^"]*",\s*headers: \[/.test(block));
    assert.equal(blocks.length, 1, `${source} 머리글 규칙이 하나여야 한다`);
    const match = blocks[0].match(/key: "Permissions-Policy", value: "([^"]*)"/);
    assert.ok(match, `${source} 에 Permissions-Policy 가 없다`);
    return match[1];
  };
  const headerRuleAt = (source) => config.search(new RegExp(`source: "${source.replace(/[/*]/g, "\\$&")}",\\s*headers: \\[`));
  assert.match(policyOf("/staff/:path*"), /microphone=\(self\)/);
  assert.match(policyOf("/staff/install"), /microphone=\(\)/);
  // 설치 안내 규칙이 일반 선생님 규칙 «뒤»에 있어야 덮어쓴다
  assert.ok(headerRuleAt("/staff/:path*") > -1 && headerRuleAt("/staff/install") > headerRuleAt("/staff/:path*"));
  // 그 밖의 화면을 맡는 일반 규칙은 선생님 화면을 빼고 마이크를 막는다
  const general = config.match(/source: "\/\(\(\?!staff\(\?:\/\|\$\)[^\n]*\n[\s\S]*?key: "Permissions-Policy", value: "([^"]*)"/);
  assert.ok(general, "일반 규칙을 찾지 못했다");
  assert.match(general[1], /microphone=\(\)/);
  // 사이트 전체에 마이크를 여는 규칙은 선생님 화면·선생님 API 둘뿐이다
  assert.equal((config.match(/microphone=\(self\)/g) ?? []).length, 2);
});

// ── 새로 불러오기 판정 ──────────────────────────────────────────────

const base = { featureAllowed: null, initialDocumentPath: null, alreadyTriedFor: null, currentPath: "/staff" };

test("새로 불러오기: 같은 화면에서 이미 해 봤으면 다시 하지 않는다", () => {
  assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: false }), true);
  assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: false, alreadyTriedFor: "/staff" }), false);
  assert.equal(shouldReloadStaffDocument({ ...base, initialDocumentPath: "/login", alreadyTriedFor: "/staff" }), false);
  // 다른 화면에서 해 본 표식은 지금 화면을 막지 않는다
  assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: false, alreadyTriedFor: "/staff/students" }), true);
});

test("새로 불러오기: 브라우저가 알려 준 값이 처음 문서 경로보다 먼저다", () => {
  // 브라우저가 «된다»고 하면 경로가 무엇이든 그대로 둔다
  assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: true, initialDocumentPath: "/login" }), false);
  // 브라우저가 «안 된다»고 하면 경로가 선생님 화면이어도 새로 불러온다
  assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: false, initialDocumentPath: "/staff" }), true);
});

test("새로 불러오기: 브라우저가 모르면 처음 문서 경로로, 둘 다 모르면 하지 않는다", () => {
  for (const from of ["/login", "/mypage", "/", "/store-app", "/auth/continue", "/teacher-app", "/staff/install"]) {
    assert.equal(shouldReloadStaffDocument({ ...base, initialDocumentPath: from }), true, from);
  }
  for (const from of ["/staff", "/staff/sessions/a", "/staff/login"]) {
    assert.equal(shouldReloadStaffDocument({ ...base, initialDocumentPath: from }), false, from);
  }
  assert.equal(shouldReloadStaffDocument({ ...base }), false);
  assert.equal(shouldReloadStaffDocument({ ...base, initialDocumentPath: "" }), false);
});

test("새로 불러오기: 기사님 운행 화면과, 새로 불러와도 소용없는 화면은 건너뛴다", () => {
  for (const currentPath of ["/staff/run", "/staff/run/", "/staff/run/open"]) {
    assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: false, initialDocumentPath: "/login", currentPath }), false, currentPath);
  }
  // 이름만 비슷한 화면은 예외가 아니다
  assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: false, currentPath: "/staff/runner" }), true);
  // 설치 안내 화면은 새로 받아도 마이크 금지라 하지 않는다
  assert.equal(shouldReloadStaffDocument({ ...base, featureAllowed: false, currentPath: "/staff/install" }), false);
});

test("브라우저 값 읽기: 비표준 기능이 없거나 이상하면 «모름»(null)", () => {
  assert.equal(readMicFeatureAllowed({ featurePolicy: { allowsFeature: (name) => name === "microphone" } }), true);
  assert.equal(readMicFeatureAllowed({ featurePolicy: { allowsFeature: () => false } }), false);
  // this 가 정책 객체로 묶여 불린다(묶지 않으면 실제 브라우저에서 예외)
  const policy = { allowed: true, allowsFeature() { return this.allowed; } };
  assert.equal(readMicFeatureAllowed({ featurePolicy: policy }), true);
  assert.equal(readMicFeatureAllowed({}), null);
  assert.equal(readMicFeatureAllowed(null), null);
  assert.equal(readMicFeatureAllowed({ featurePolicy: {} }), null);
  assert.equal(readMicFeatureAllowed({ featurePolicy: { allowsFeature: () => "yes" } }), null);
  assert.equal(readMicFeatureAllowed({ featurePolicy: { allowsFeature: () => { throw new Error("x"); } } }), null);
  assert.equal(readMicFeatureAllowed({ get featurePolicy() { throw new Error("x"); } }), null);
});

test("문서 주소에서 경로만 꺼낸다(못 풀면 null)", () => {
  assert.equal(pathFromDocumentUrl("https://www.stiz-dasan.kr/login?next=%2Fstaff#a"), "/login");
  assert.equal(pathFromDocumentUrl("https://www.stiz-dasan.kr/staff/sessions/a"), "/staff/sessions/a");
  assert.equal(pathFromDocumentUrl("/staff"), null);
  assert.equal(pathFromDocumentUrl(""), null);
  assert.equal(pathFromDocumentUrl(undefined), null);
});

test("화면 부품: 그리는 것 없이 마운트 때 한 번만 판정하고, 레이아웃에 한 번 놓인다", () => {
  const part = read("src/app/staff/StaffDocumentReload.tsx");
  assert.match(part, /^"use client";/);
  assert.match(part, /return null;\s*\}\s*$/);
  // 화면 전환마다 다시 판정하지 않는다(의존 값 없음·경로 훅 없음)
  assert.match(part, /window\.location\.reload\(\);\s*\}, \[\]\);/);
  assert.doesNotMatch(part, /usePathname|useRouter/);
  // 판정은 순수 규칙 한 곳
  assert.match(part, /shouldReloadStaffDocument\(\{ \.\.\.input, alreadyTriedFor \}\)/);
  assert.match(part, /readMicFeatureAllowed\(document\)/);
  assert.match(part, /performance\.getEntriesByType\("navigation"\)\[0\]\?\.name/);
  // 표식을 못 읽거나 못 적으면 새로 불러오지 않는다(무한 반복 방지): 읽기·쓰기 모두 실패 시 바로 끝낸다
  assert.match(part, /alreadyTriedFor = window\.sessionStorage\.getItem\(RELOAD_MARK_KEY\);\s*\} catch \{\s*return;/);
  assert.match(part, /window\.sessionStorage\.setItem\(RELOAD_MARK_KEY, currentPath\);\s*\} catch \{\s*return;/);
  // 새로 불러오기는 표식을 적은 «뒤»에만
  assert.ok(part.indexOf("sessionStorage.setItem(RELOAD_MARK_KEY") < part.indexOf("window.location.reload()"));
  assert.equal((part.match(/window\.location\.reload\(\)/g) ?? []).length, 1);

  const layout = read("src/app/staff/layout.tsx");
  assert.match(layout, /import StaffDocumentReload from "\.\/StaffDocumentReload";/);
  assert.equal((layout.match(/<StaffDocumentReload \/>/g) ?? []).length, 1);
  // 레이아웃의 기존 순서는 그대로(알림 줄 → 화면 → 아래 메뉴)
  assert.match(layout, /<StaffPushBanner \/>\}[\s\S]*?\{children\}\s*<StaffBottomNav /);
});

// ── 버튼 안내 문구 ──────────────────────────────────────────────────

test("녹음 시작 실패 안내는 원인별로 다르다", () => {
  const M = VOICE_START_MESSAGES;
  // 문서가 마이크 금지라고 브라우저가 답함 → 새로 불러오기 안내 + 버튼
  assert.deepEqual(voiceStartFailure("NotAllowedError", false), { message: M.reload, offerReload: true });
  assert.deepEqual(voiceStartFailure("SecurityError", false), { message: M.reload, offerReload: true });
  // 문서는 허용(또는 모름)인데 거부 → 휴대폰 권한 안내
  assert.deepEqual(voiceStartFailure("NotAllowedError", true), { message: M.permission, offerReload: false });
  assert.deepEqual(voiceStartFailure("NotAllowedError", null), { message: M.permission, offerReload: false });
  for (const name of ["NotFoundError", "OverconstrainedError"]) assert.deepEqual(voiceStartFailure(name, false), { message: M.notFound, offerReload: false }, name);
  for (const name of ["NotReadableError", "AbortError"]) assert.deepEqual(voiceStartFailure(name, null), { message: M.busy, offerReload: false }, name);
  // 그 밖(녹음 기능 없음 등)
  for (const name of ["TypeError", "ReferenceError", "SecurityError", "", null]) {
    assert.deepEqual(voiceStartFailure(name, null), { message: M.unsupported, offerReload: false }, String(name));
  }
  // 다섯 문구가 서로 다르고, 선생님 화면 오류 도우미를 그대로 통과하는 쉬운 한국어다
  const all = Object.values(M);
  assert.equal(new Set(all).size, 5);
  for (const text of all) assert.equal(userErrorMessage(text, "대체 문구"), text);
  assert.equal(M.reload, "화면을 새로 불러온 뒤 다시 눌러 주세요.");
  assert.equal(M.permission, "마이크 권한이 꺼져 있어요. 휴대폰 설정 › 앱 › 권한에서 마이크를 허용해 주세요.");
});

test("오류에서는 이름만 읽는다", () => {
  assert.equal(voiceErrorName(Object.assign(new Error("본문"), { name: "NotAllowedError" })), "NotAllowedError");
  assert.equal(voiceErrorName(new TypeError("x")), "TypeError");
  assert.equal(voiceErrorName({ name: "NotFoundError" }), "NotFoundError");
  for (const value of [null, undefined, "NotAllowedError", { name: 3 }, { name: "" }]) assert.equal(voiceErrorName(value), null);
});

test("버튼: 시작 실패를 한 문구로 뭉개지 않고, 금지 문서일 때만 «새로 불러오기»를 보인다", () => {
  const voice = read("src/components/staff/VoiceToTextButton.tsx");
  assert.ok(!voice.includes("마이크 권한을 허용해 주세요."));
  assert.doesNotMatch(voice, /\} catch \{\s*onBusyChange\?\.\(false\);\s*setMessage\("/);
  assert.match(voice, /\} catch \(error\) \{\s*onBusyChange\?\.\(false\);[\s\S]*?const failure = voiceStartFailure\(voiceErrorName\(error\), readMicFeatureAllowed\(document\)\);\s*setMessage\(failure\.message\);\s*setOfferReload\(failure\.offerReload\);/);
  // 다시 누르면 지난 «새로 불러오기» 버튼은 치운다
  assert.match(voice, /async function start\(\) \{\s*setOfferReload\(false\);/);
  // 글자 버튼(아이콘 없음)·보조 등급·기본 높이 44px(크기 유틸을 덧붙이지 않는다)
  assert.match(voice, /\{offerReload && <button type="button" onClick=\{\(\) => window\.location\.reload\(\)\} className="academy-button-secondary">새로 불러오기<\/button>\}/);
  assert.match(read("src/app/academy-theme.css"), /\.academy-button-secondary,[^{]*\{[^}]*min-height: 2\.75rem;/);
  // 그 밖의 동작은 그대로
  assert.match(voice, /timer\.current = setTimeout\(stop, 60_000\);/);
  assert.match(voice, /fetch\("\/api\/staff\/transcribe", \{ method: "POST", body: form \}\)/);
  assert.match(voice, /onText\(data\.text\);/);
  assert.match(voice, /if \(appLacksVoice\) return <p [^>]*>음성 입력은 앱 다음 버전부터 됩니다<\/p>;/);
  assert.doesNotMatch(voice, /\balert\(|\bconfirm\(|font-(extrabold|black)|material-symbols/);
});

// ── 음성 변환 라우트 ────────────────────────────────────────────────

const route = read("src/app/api/staff/transcribe/route.ts");

test("라우트: 모델 기본값은 사이트 공용 모델이고 옛 모델 이름이 남아 있지 않다", () => {
  assert.match(route, /import \{ GEMINI_CHAT_MODEL \} from "@\/lib\/gemini-client";/);
  assert.match(route, /const modelName = process\.env\.GEMINI_TRANSCRIBE_MODEL\?\.trim\(\) \|\| GEMINI_CHAT_MODEL;/);
  assert.match(route, /getGenerativeModel\(\{ model: modelName \}\)/);
  assert.ok(!route.includes("gemini-2.0-flash"));
  assert.doesNotMatch(read("src/lib/gemini-client.ts"), /GEMINI_CHAT_MODEL = "gemini-2\.0-flash"/);
  // 키가 없으면 예전처럼 503
  assert.match(route, /if \(!apiKey\) return NextResponse\.json\(\{ error: "[^"]*" \}, \{ status: 503 \}\);/);
});

// 라우트의 failureLog 를 꺼내 실제로 실행한다(TS → JS)
function loadFailureLog() {
  const match = route.match(/function failureLog\(error: unknown\) \{[\s\S]*?\n\}\n/);
  assert.ok(match, "failureLog 를 찾지 못했다");
  const js = ts.transpileModule(`${match[0]}\nmodule.exports = failureLog;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", js)(module, module.exports);
  return { failureLog: module.exports, source: match[0] };
}

test("라우트: 실패 기록에는 오류 이름과 번호만 남고 본문은 남지 않는다", () => {
  const { failureLog, source } = loadFailureLog();
  const secret = "받아쓴 문장과 요청 본문";
  // 라이브러리의 통신 오류 모양(status?: number, statusText?: string)
  const fetchError = Object.assign(new Error(secret), { status: 404, statusText: "Not Found", errorDetails: [{ reason: secret }] });
  assert.deepEqual(failureLog(fetchError), { name: "Error", status: 404, statusText: "Not Found" });
  assert.equal(failureLog(Object.assign(new Error(secret), { statusText: "가".repeat(200) })).statusText.length, 80);
  // 번호가 숫자·글자가 아니면 남기지 않는다
  assert.deepEqual(failureLog(Object.assign(new TypeError(secret), { status: "404", statusText: 5 })), { name: "TypeError" });
  assert.deepEqual(failureLog(new Error(secret)), { name: "Error" });
  assert.deepEqual(failureLog("문자열"), { name: "UnknownError" });
  assert.deepEqual(failureLog(null), { name: "UnknownError" });
  for (const value of [fetchError, new Error(secret)]) assert.ok(!JSON.stringify(failureLog(value)).includes(secret));
  assert.doesNotMatch(source, /message|errorDetails|stack/);
  // 기록은 전부 failureLog 를 거친다(오류 객체를 통째로 넘기지 않는다)
  const logs = route.match(/console\.(error|warn|log|info)\([^\n]*/g) ?? [];
  assert.equal(logs.length, 2);
  for (const line of logs) assert.match(line, /^console\.error\("\[staff-transcribe\] [a-z ]+", failureLog\(error\)\);$/, line);
});

test("라우트: 로그인 풀림·권한 없음은 «음성 인식 실패»(500)가 아니라 401 로 나간다", () => {
  // 직원 확인은 본문 try 밖의 문지기에서 따로 잡는다
  assert.match(route, /async function staffOrNull\(\) \{\s*try \{\s*return await requireStaff\(\);\s*\} catch \(error\) \{[\s\S]*?return null;\s*\}\s*\}/);
  assert.match(route, /export async function POST\(req: Request\) \{\s*const staff = await staffOrNull\(\);\s*if \(!staff\) return NextResponse\.json\(\{ error: "로그인이 풀렸어요\. 다시 로그인해 주세요\.", code: "UNAUTHORIZED" \}, \{ status: 401 \}\);\s*try \{/);
  assert.equal((route.match(/requireStaff\(\)/g) ?? []).length, 1);
});

test("라우트: 화면에 나가는 문구는 쉬운 한국어이고, 설정 이름이 든 문구는 버튼이 걸러 낸다", () => {
  const quiet = console.error;
  console.error = () => {}; // 걸러진 원문 기록은 테스트 출력에서 숨긴다
  try {
    const fallback = "음성 인식에 실패했습니다. 다시 말씀해 주세요.";
    const messages = [...route.matchAll(/NextResponse\.json\(\{ error: "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(messages.length, 8);
    for (const text of messages) {
      const shown = userErrorMessage(text, fallback);
      // 버튼에 실제로 보이는 글에는 모델·키 이름이 없다
      assert.doesNotMatch(shown, /gemini|GEMINI|API|KEY|flash/i, text);
      // 걸러지면 준비한 쉬운 문구, 아니면 원래 문구 — 둘 중 하나만 보인다
      assert.ok(shown === text || shown === fallback, text);
      if (text.includes("GEMINI_API_KEY")) assert.equal(shown, fallback);
    }
    // 새로 넣은 로그인 안내는 그대로 보인다
    assert.equal(userErrorMessage("로그인이 풀렸어요. 다시 로그인해 주세요.", fallback), "로그인이 풀렸어요. 다시 로그인해 주세요.");
  } finally {
    console.error = quiet;
  }
  // 버튼은 서버 문구를 도우미로 걸러 보여 준다
  assert.match(read("src/components/staff/VoiceToTextButton.tsx"), /setMessage\(userErrorMessage\(data\.error, "음성 인식에 실패했습니다\. 다시 말씀해 주세요\."\)\)/);
});
