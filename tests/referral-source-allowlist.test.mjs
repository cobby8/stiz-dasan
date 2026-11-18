// 이월 리뷰 R-2 — 공개 신청서의 «유입 경로»가 아무 글자나 저장되던 문제.
// ① 정규화 함수를 실제로 돌린다(허용 값·공백·목록 밖·빈 값·문자열 아닌 입력·긴 글자·대소문자).
// ② 화면 선택지(공개 신청서 2곳·관리자 화면)가 모두 허용 목록 안에 있는지 소스에서 값을 뽑아 비교한다
//    — 누가 화면에 선택지를 추가하고 목록을 안 고치면 여기서 깨진다(안 고치면 그 값이 «기타»로 저장된다).
// ③ public.ts 의 저장 함수 두 개를 가짜 DB 로 «실제로 돌려» INSERT·UPDATE 두 갈래에 들어가는 값을 본다.
// ④ 한글 이름 표가 한 곳(REFERRAL_SOURCE_LABELS)인지 — 키 = 허용 목록, 공개 신청서 글자와 같음,
//    통계 표 = 16개 + UNKNOWN, 관리자·통계 화면에 손으로 적은 이름·선택지가 없음(2026-11-17).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

// tests/staff-session-review.test.mjs 와 같은 로더. mutate = 대조 실험용(소스 한 줄을 바꾼 사본을 돌린다)
function load(path, mocks = {}, mutate = null) {
  const absolute = resolve(path);
  const original = readFileSync(absolute, "utf8");
  const compiled = ts.transpileModule(mutate ? mutate(original) : original, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
    return require(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}

const rules = load("src/lib/enrollment/referralSources.ts");
const ALLOWED = new Set(rules.REFERRAL_SOURCE_VALUES);
const normalize = rules.normalizeReferralSource;

// ── ① 정규화 함수 ─────────────────────────────────────────────────────

test("허용 목록 — 중복이 없고 «기타»(목록 밖 값의 저장값)가 들어 있다", () => {
  assert.equal(ALLOWED.size, rules.REFERRAL_SOURCE_VALUES.length, "같은 값이 두 번 있으면 안 된다");
  assert.equal(rules.REFERRAL_SOURCE_FALLBACK, "OTHER");
  assert.ok(ALLOWED.has(rules.REFERRAL_SOURCE_FALLBACK));
  // 운영 DB 에 지금 들어 있는 값(2026-11-17 확인분) — 학부모가 기존 신청서를 불러와 다시 내도 바뀌면 안 된다
  for (const value of ["NAVER_SEARCH", "PASSBY", "REFERRAL", "PORTAL_OTHER", "NAVER_BLOG", "WEBSITE", "NAVER_AD", "OTHER"]) {
    assert.ok(ALLOWED.has(value), `운영 값 ${value} 이 목록에 없다`);
  }
});

test("정규화 — 허용 값은 그대로, 앞뒤 공백은 떼고 그대로", () => {
  for (const value of rules.REFERRAL_SOURCE_VALUES) {
    assert.equal(normalize(value), value);
    assert.equal(normalize(`  ${value}\n`), value);
    assert.equal(rules.isKnownReferralSource(value), true);
  }
});

test("정규화 — 목록 밖 글자는 «기타»(OTHER)", () => {
  for (const value of ["HACKED", "네이버", "지인소개", "NAVER_SEARCH;DROP", "NAVER SEARCH", "NAVER_AD,OTHER", "<script>", "0", "null", "undefined"]) {
    assert.equal(normalize(value), "OTHER", value);
  }
  // 객체에 원래 있는 이름도 «있는 값»으로 통과하면 안 된다(객체 키 조회로 만들면 뚫린다)
  for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty", "length"]) {
    assert.equal(normalize(value), "OTHER", value);
    assert.equal(rules.isKnownReferralSource(value), false, value);
  }
  // 아주 긴 글자 — 던지지 않고, 그대로 저장되지도 않는다
  assert.equal(normalize("A".repeat(1_000_000)), "OTHER");
  assert.equal(normalize(`NAVER_AD${"x".repeat(5000)}`), "OTHER");
});

test("정규화 — 대소문자는 맞춰 주지 않는다(글자 그대로만 허용)", () => {
  // 화면은 항상 목록의 글자 그대로 보낸다. 다르게 온 값은 화면 밖 요청이라 추측해 살리지 않는다.
  assert.equal(normalize("naver_ad"), "OTHER");
  assert.equal(normalize("Naver_Search"), "OTHER");
  assert.equal(normalize("other"), "OTHER");
  assert.equal(normalize("website"), "OTHER");
});

test("정규화 — 빈 값(없음·빈 문자열·공백만)은 빈 값 그대로(필수 검사·기본값은 부르는 쪽 몫)", () => {
  for (const value of [undefined, null, "", " ", "   ", "\t\n", "　"]) {
    assert.equal(normalize(value), "", JSON.stringify(value));
  }
  // 부르는 쪽의 기본값이 예전과 같게 동작한다
  assert.equal(normalize("") || "WEBSITE", "WEBSITE");
  assert.equal(normalize(undefined) || null, null);
});

test("정규화 — 문자열이 아닌 입력도 던지지 않고 «기타»", () => {
  const hostile = { toString() { throw new Error("부르면 안 된다"); }, trim() { throw new Error("부르면 안 된다"); } };
  for (const value of [0, 1, NaN, true, false, {}, [], ["NAVER_AD"], { value: "NAVER_AD" }, hostile, Symbol("x"), 10n, () => "NAVER_AD", new String("NAVER_AD")]) {
    assert.doesNotThrow(() => normalize(value));
    assert.equal(normalize(value), "OTHER");
    assert.equal(rules.isKnownReferralSource(value), false);
  }
});

// ── ② 화면 선택지 ⊂ 허용 목록 ─────────────────────────────────────────

/** `const NAME ... = [` 또는 `{` 부터 닫는 줄까지 잘라 온다 */
function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `소스에서 ${startMarker} 를 찾지 못했다`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${startMarker} 의 끝을 찾지 못했다`);
  return source.slice(start, end);
}
const optionValues = (source) => [...block(source, "const SOURCE_OPTIONS = [", "\n];").matchAll(/value:\s*"([^"]*)"/g)].map((m) => m[1]);
function assertAllAllowed(values, where) {
  assert.ok(values.length > 0, `${where}: 값을 하나도 뽑지 못했다(소스 모양이 바뀌었나)`);
  const missing = values.filter((value) => !ALLOWED.has(value));
  assert.deepEqual(missing, [], `${where} 의 값이 허용 목록(src/lib/enrollment/referralSources.ts)에 없다 — 목록에 추가하지 않으면 «기타»로 저장된다`);
}

const trialForm = read("src/app/apply/trial/TrialApplicationForm.tsx");
const enrollForm = read("src/app/apply/enroll/EnrollApplicationLaterSteps.tsx");

test("공개 체험 신청서의 선택지 값은 모두 허용 목록 안", () => {
  const values = optionValues(trialForm);
  assert.equal(values.length, 11, "선택지 수가 바뀌었다 — 허용 목록도 같이 봤는지 확인");
  assertAllAllowed(values, "체험 신청서 SOURCE_OPTIONS");
  // 광고 주소로 들어왔을 때의 초기값도 목록 안
  const page = read("src/app/apply/trial/page.tsx");
  const initial = page.match(/const initialSource = [^;]*\? "([^"]+)" : "";/);
  assert.ok(initial, "apply/trial/page.tsx 의 initialSource 줄을 찾지 못했다");
  assertAllAllowed([initial[1]], "체험 신청 광고 초기값");
});

test("공개 수강 신청서의 선택지 값은 모두 허용 목록 안 — 체험에서 이어받는 값도", () => {
  const values = optionValues(enrollForm);
  assert.equal(values.length, 10, "선택지 수가 바뀌었다 — 허용 목록도 같이 봤는지 확인");
  assertAllAllowed(values, "수강 신청서 SOURCE_OPTIONS");
  // 수강 신청서는 체험 때 고른 값을 이어받는다 → 체험 선택지(NAVER_AD·OTHER 포함)가 수강 쪽에도 정상 값이다
  assert.match(read("src/app/apply/enroll/EnrollApplicationForm.tsx"), /referralSource: trialData\?\.source \|\| ""/);
  assertAllAllowed(optionValues(trialForm), "수강 신청서가 이어받는 체험 선택지");
});

// 관리자 선택 상자가 «허용 목록에서 만들어지는» 모양 — 선택지 값이 곧 허용 목록이라 목록 밖 값이 나올 수 없다
const GENERATED_OPTIONS = /\{REFERRAL_SOURCE_VALUES\.map\(\(value\) => \(\s*<option key=\{value\} value=\{value\}>\{REFERRAL_SOURCE_LABELS\[value\]\}<\/option>\s*\)\)\}/;
const applyModals = read("src/app/admin/apply/ApplyAdminModals.tsx");
const trialModals = read("src/app/admin/trial/TrialCrmModals.tsx");
const trialClient = read("src/app/admin/trial/TrialCrmClient.tsx");
/** 손으로 적은 선택지 값(<option value="…">) — 허용 목록에서 만들어진 것은 여기 잡히지 않는다 */
const handWrittenOptionValues = (select) => [...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);

test("관리자 화면의 유입 경로 선택 상자는 허용 목록에서 만들어진다 — 16개 전부·목록 순서", () => {
  // 수강 신청 수정 창 — «선택 안 함»(빈 값) 하나만 손으로 적고 나머지는 허용 목록에서
  const applySelects = [...applyModals.matchAll(/<select value=\{form\.referralSource\}[\s\S]*?<\/select>/g)].map((m) => m[0]);
  assert.equal(applySelects.length, 1, "수강 신청 수정 창의 유입 경로 select 는 한 곳");
  assert.match(applySelects[0], GENERATED_OPTIONS);
  assert.deepEqual(handWrittenOptionValues(applySelects[0]), [""], "손으로 적은 선택지는 «선택 안 함» 하나뿐");
  // 체험 수정 창·새 체험 등록 창의 <select> 두 개 — 손으로 적은 선택지가 없다
  const selects = [...trialModals.matchAll(/<select\s+value=\{form\.source\}[\s\S]*?<\/select>/g)].map((m) => m[0]);
  assert.equal(selects.length, 2, "유입 경로 select 는 수정 창·등록 창 두 곳");
  for (const [index, select] of selects.entries()) {
    assert.match(select, GENERATED_OPTIONS, `TrialCrmModals 유입 경로 select #${index + 1}`);
    assert.deepEqual(handWrittenOptionValues(select), [], `TrialCrmModals 유입 경로 select #${index + 1} 에 손으로 적은 선택지가 있다`);
  }
  // 세 창 모두 같은 모듈의 값을 쓴다(다른 곳에서 같은 이름을 들여오면 위 단정이 뜻을 잃는다)
  for (const [where, source] of [["ApplyAdminModals", applyModals], ["TrialCrmModals", trialModals]]) {
    assert.match(source, /import \{[^}]*\bREFERRAL_SOURCE_LABELS\b[^}]*\bREFERRAL_SOURCE_VALUES\b[^}]*\} from "@\/lib\/enrollment\/referralSources";/, where);
  }
  // 관리자 쪽 기본값(값이 없을 때 넣는 글자)
  const defaults = [...trialModals.matchAll(/source: (?:lead\.source \?\? |form\.source \|\| )?"([A-Z_]+)"/g)].map((m) => m[1]);
  assertAllAllowed(defaults, "TrialCrmModals 기본값");
});

// ── ④ 한글 이름은 한 곳(REFERRAL_SOURCE_LABELS) ────────────────────────

const LABELS = rules.REFERRAL_SOURCE_LABELS;
const optionPairs = (source) => [...block(source, "const SOURCE_OPTIONS = [", "\n];").matchAll(/value:\s*"([^"]*)",\s*label:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]);
const statsLabels = load("src/lib/stats/sourceLabels.ts", { "@/lib/enrollment/referralSources": rules });

test("이름 표의 키 = 허용 목록(빠짐·남음 없음) — 이름은 비어 있지 않고 서로 겹치지 않는다", () => {
  assert.deepEqual(Object.keys(LABELS).sort(), [...rules.REFERRAL_SOURCE_VALUES].sort());
  const names = Object.values(LABELS);
  for (const [value, name] of Object.entries(LABELS)) {
    assert.equal(typeof name, "string", value);
    assert.ok(name.trim().length > 0, `${value} 의 이름이 비었다`);
    assert.equal(name, name.trim(), `${value} 의 이름 앞뒤에 공백이 있다`);
  }
  // 두 값이 같은 이름이면 통계·선택 상자에서 구분할 수 없다
  assert.equal(new Set(names).size, names.length, "같은 이름이 두 번 있다");
});

test("이름 함수 — 아는 값은 이름, 모르는 값은 받은 글자 그대로, 빈 값은 빈 글자", () => {
  const label = rules.referralSourceLabel;
  for (const value of rules.REFERRAL_SOURCE_VALUES) assert.equal(label(value), LABELS[value]);
  // 운영에서 코드 글자로 보이던 값들(이번 수정의 이유)
  assert.equal(label("NAVER_AD"), "네이버 검색광고");
  assert.equal(label("YOUTUBE"), "유튜브");
  assert.equal(label("DANGGEUN"), "당근마켓");
  assert.equal(label("SMS_PROMOTION"), "문자 홍보");
  // 모르는 값은 지어내지 않는다(예전 화면들의 `표[x] || x` 와 같다)
  for (const value of ["NEW_CODE", "naver_ad", "지인소개", " NAVER_AD "]) assert.equal(label(value), value);
  // 객체에 원래 있는 이름이 함수·객체로 새어 나오면 화면이 깨진다
  for (const value of ["constructor", "__proto__", "toString"]) assert.equal(label(value), value);
  for (const value of [null, undefined, ""]) assert.equal(label(value), "");
});

test("공개 신청서 선택지의 글자 = 이름 표의 글자 — 한쪽만 고치면 깨진다", () => {
  // 학부모가 고른 글자와 관리자·통계 화면에 보이는 글자가 같아야 한다(이름 표의 기준이 공개 신청서다)
  for (const [where, source, count] of [["체험 신청서", trialForm, 11], ["수강 신청서", enrollForm, 10]]) {
    const pairs = optionPairs(source);
    assert.equal(pairs.length, count, `${where}: 선택지의 값·글자 쌍을 다 뽑지 못했다(소스 모양이 바뀌었나)`);
    // 두 신청서끼리 글자가 다른 값은 지금 없다 — 생기면 여기 예외로 적고(기준은 체험 신청서) 원장에게 알린다
    for (const [value, text] of pairs) assert.equal(text, LABELS[value], `${where} ${value}`);
  }
});

test("통계·신청 화면이 같이 쓰는 라벨 표(sourceLabels) = 이름 표 16개 + UNKNOWN — UNKNOWN 은 허용 목록 밖", () => {
  const labels = statsLabels.SOURCE_LABELS;
  const keys = Object.keys(labels);
  // UNKNOWN 은 저장하는 값이 아니다 — 통계 조회가 «빈 값»을 묶을 때만 만드는 이름(«미입력»)이다.
  // 허용 목록에 넣으면 누가 UNKNOWN 을 보내 «미입력» 칸을 부풀릴 수 있다.
  assert.ok(keys.includes("UNKNOWN"));
  assert.equal(labels.UNKNOWN, "미입력");
  assert.equal(ALLOWED.has("UNKNOWN"), false);
  assert.equal(normalize("UNKNOWN"), "OTHER");
  assert.equal("UNKNOWN" in LABELS, false);
  assertAllAllowed(keys.filter((key) => key !== "UNKNOWN"), "sourceLabels SOURCE_LABELS");
  // 16개 전부가 같은 글자로 들어 있다(빠지면 통계에 코드 글자가 그대로 보인다)
  assert.deepEqual(keys.filter((key) => key !== "UNKNOWN").sort(), [...rules.REFERRAL_SOURCE_VALUES].sort());
  for (const value of rules.REFERRAL_SOURCE_VALUES) {
    assert.equal(labels[value], LABELS[value], value);
    assert.equal(statsLabels.sourceLabel(value), LABELS[value], value);
  }
  // 통계 쪽의 빈 값·모르는 값 처리는 그대로
  assert.equal(statsLabels.sourceLabel(""), "미입력");
  assert.equal(statsLabels.sourceLabel(null), "미입력");
  assert.equal(statsLabels.sourceLabel("UNKNOWN"), "미입력");
  assert.equal(statsLabels.sourceLabel("NEW_CODE"), "NEW_CODE");
});

test("관리자·통계 화면에 유입 경로의 한글 이름이 손으로 따로 적혀 있지 않다(이름 표에서 온다)", () => {
  const codes = rules.REFERRAL_SOURCE_VALUES.join("|");
  const files = {
    "ApplyAdminModals.tsx": applyModals,
    "TrialCrmClient.tsx": trialClient,
    "TrialCrmModals.tsx": trialModals,
    "ApplyAdminClient.tsx": read("src/app/admin/apply/ApplyAdminClient.tsx"),
    "StatsClient.tsx": read("src/app/admin/stats/StatsClient.tsx"),
    "sourceLabels.ts": read("src/lib/stats/sourceLabels.ts"),
  };
  for (const [where, source] of Object.entries(files)) {
    // 코드값을 키로 한 이름 줄(`NAVER_AD: "…"`)과 손으로 적은 선택지(`<option value="NAVER_AD">…`)가 없어야 한다
    assert.doesNotMatch(source, new RegExp(`^\\s*(?:${codes}):\\s*["'\`]`, "m"), `${where} 에 이름 표 사본이 있다`);
    assert.doesNotMatch(source, new RegExp(`<option value="(?:${codes})"`), `${where} 에 손으로 적은 선택지가 있다`);
    // 통계 표(sourceLabels.ts)만 SOURCE_LABELS 를 만든다 — 아래에서 «이름 표를 펼친 것»인지 따로 본다
    if (where !== "sourceLabels.ts") assert.doesNotMatch(source, /const SOURCE_LABELS\b/, `${where} 에 따로 만든 SOURCE_LABELS 가 있다`);
  }
  // 통계 표는 이름 표를 펼쳐서 만든다 — 손으로 적는 것은 UNKNOWN 하나
  assert.match(files["sourceLabels.ts"], /export const SOURCE_LABELS: Record<string, string> = \{\s*\.\.\.REFERRAL_SOURCE_LABELS,[\s\S]*?UNKNOWN: "미입력",\s*\};/);
  // 표시하는 곳은 이름 함수를 거친다(체험 관리 검색·상세, 수강 신청 상세)
  assert.equal(trialClient.split("referralSourceLabel(lead.source)").length - 1, 2, "체험 관리의 유입 경로 표시는 검색·상세 두 곳");
  assert.match(applyModals, /<InfoRow label="유입경로" value=\{app\.referralSource \? referralSourceLabel\(app\.referralSource\) : null\} \/>/);
  // 수강 신청 목록·유입 통계와 통계 화면은 통계 표(= 이름 표 + UNKNOWN)를 쓴다
  assert.match(files["ApplyAdminClient.tsx"], /import \{ SOURCE_LABELS \} from "@\/lib\/stats\/sourceLabels";/);
  assert.match(files["StatsClient.tsx"], /import \{ sourceLabel \} from "@\/lib\/stats\/sourceLabels";/);
});

// ── ③ 저장 함수를 실제로 돌린다 ───────────────────────────────────────

/** SQL 글자에서 그 칸에 묶인 `$n` 을 찾아 실제 인자 값을 돌려준다(인자 순서를 테스트가 따로 외우지 않는다) */
function savedValue({ sql, args }, column) {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^\s*UPDATE /.test(sql)) {
    const hit = sql.match(new RegExp(`(?:^|[\\s,])${escaped} = \\$(\\d+)`));
    assert.ok(hit, `UPDATE 에 ${column} 칸이 없다`);
    return args[Number(hit[1]) - 1];
  }
  const parts = sql.match(/INSERT INTO "\w+" \(([\s\S]*?)\) VALUES \(([\s\S]*?)\) RETURNING/);
  assert.ok(parts, "INSERT 모양을 읽지 못했다");
  const columns = parts[1].split(",").map((item) => item.trim());
  const values = parts[2].split(",").map((item) => item.trim());
  assert.equal(columns.length, values.length, "INSERT 의 칸 수와 값 수가 다르다");
  const index = columns.indexOf(column);
  assert.notEqual(index, -1, `INSERT 에 ${column} 칸이 없다`);
  const placeholder = values[index].match(/^\$(\d+)/);
  assert.ok(placeholder, `${column} 칸이 인자가 아니다: ${values[index]}`);
  return args[Number(placeholder[1]) - 1];
}

/** 가짜 DB — existing=true 면 «같은 아이의 진행 중 신청»이 있어 UPDATE 갈래로 간다 */
function fakeDb({ existing }) {
  const writes = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      if (/INSERT INTO "(TrialLead|EnrollmentApplication)"/.test(sql)) {
        writes.push({ kind: "INSERT", table: sql.match(/INSERT INTO "(\w+)"/)[1], sql, args });
        return [{ id: "new-id" }];
      }
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      if (sql.includes('FROM "EnrollmentApplication"')) return existing ? [{ id: "app-old", status: "PENDING", trialLeadId: null }] : [];
      if (sql.includes('FROM "TrialLead"')) return existing ? [{ id: "lead-old" }] : [];
      return []; // 학원 전화번호·짧은 링크 조회 등
    },
    async $executeRawUnsafe(sql, ...args) {
      const hit = sql.match(/^\s*UPDATE "(TrialLead|EnrollmentApplication)" SET\n/);
      // 수강 신청 뒤 체험 문의에 «신청서 받음»을 찍는 UPDATE 는 유입 경로와 무관 → 칸이 있는 것만 모은다
      if (hit && /(?:^|[\s,])(?:source|"referralSource") = \$\d+/.test(sql)) writes.push({ kind: "UPDATE", table: hit[1], sql, args });
      return 1;
    },
  };
  return { prisma, writes };
}

function loadPublicActions(prisma, mutate = null) {
  const sent = [];
  const actions = load("src/app/actions/public.ts", {
    "@/lib/prisma": { prisma },
    // 유입 경로 규칙과 날짜 모듈은 진짜를 쓴다
    "@/lib/enrollment/referralSources": rules,
    "@/lib/datetime/kst": load("src/lib/datetime/kst.ts"),
    // 개시일 검사는 이 테스트의 관심사가 아니다(오늘 날짜에 따라 결과가 달라지지 않게 대역)
    "@/lib/enrollment/commencement": { requireCommencement: (value) => value, commencementYmd: (value) => value ?? null },
    "@/app/actions/admin": { ensureTrialLeadTable: async () => {} },
    "@/lib/enrollment/trialLeadLinkService": { decideTrialLeadForNewApplication: async () => ({ decision: "NONE" }) },
    "@/lib/notification": { notifyAdmins: async (...args) => { sent.push(args[0]); }, sendParentSms: async () => {} },
    "@/lib/contactSaveName": { buildContactSaveName: () => "저장용 이름" },
    "@/lib/trial-fee/trialFeePaymentService": { issueTrialPaymentToken: async () => null },
    "@/lib/enrollment-account-handoff": { issueEnrollmentAccountHandoff: async () => null },
    "@/lib/seasonal/contracts": { SHUTTLE_LOCATION_CONSENT_VERSION: "test" },
    "@/lib/enrollment/shuttle-place-name": { shuttlePlaceNameError: () => null },
    "@/lib/seats/seatLevel": { seatLevelFromCounts: () => "OPEN" },
    // 기존 신청 불러오기 시도 제한(2026-11-18) — 저장 함수는 쓰지 않는다
    "@/lib/seasonal/public-rate-limit": { takePublicRateLimit: () => ({ allowed: true }), hashSensitiveRateLimitKey: (value) => value },
    "next/cache": { revalidatePath() {}, revalidateTag() {} },
  }, mutate);
  return { actions, sent };
}

const trialInput = (source) => ({
  trialDate: "2026-12-01", trialDay: "화", trialPeriod: "5",
  childName: "김하늘", childGrade: "초3", childGender: "남", childSchool: "다산초",
  parentName: "김보호", parentPhone: "010-1234-5678",
  source, trialFeeNoticeAgreed: true, agreedTerms: true, agreedPrivacy: true,
});
const enrollInput = (referralSource) => ({
  childName: "김하늘", childBirthDate: "2017-03-02", childPhone: "010-2222-3333", childSchool: "다산초", childGrade: "초3",
  parentName: "김보호", parentPhone: "010-1234-5678",
  requestedStartOn: "2026-12-01", preferredSlotKeys: "Tue-5",
  shuttleNeeded: false, referralSource,
  agreedTerms: true, agreedPrivacy: true, applicationNoticeConfirmed: true,
});

async function submitTrial(source, { existing = false, mutate = null } = {}) {
  const { prisma, writes } = fakeDb({ existing });
  const { actions } = loadPublicActions(prisma, mutate);
  const result = await actions.submitTrialApplication(trialInput(source));
  const saved = writes.filter((write) => write.table === "TrialLead");
  assert.equal(saved.length, 1, "체험 문의 저장은 한 번");
  assert.equal(saved[0].kind, existing ? "UPDATE" : "INSERT");
  return { result, value: savedValue(saved[0], "source") };
}
async function submitEnroll(referralSource, { existing = false, mutate = null } = {}) {
  const { prisma, writes } = fakeDb({ existing });
  const { actions } = loadPublicActions(prisma, mutate);
  const result = await actions.submitEnrollApplication(enrollInput(referralSource));
  const saved = writes.filter((write) => write.table === "EnrollmentApplication");
  assert.equal(saved.length, 1, "수강 신청 저장은 한 번");
  assert.equal(saved[0].kind, existing ? "UPDATE" : "INSERT");
  return { result, value: savedValue(saved[0], '"referralSource"') };
}

// [보낸 값, 저장돼야 하는 값]
const CASES = [
  ["NAVER_AD", "NAVER_AD"],          // 허용 값 그대로
  ["WEBSITE", "WEBSITE"],            // 예전 값(기존 신청서를 불러와 다시 낸 경우) 그대로
  ["  REFERRAL ", "REFERRAL"],       // 앞뒤 공백 제거
  ["아무 글자나 <b>", "OTHER"],       // 목록 밖 → 기타
  ["naver_ad", "OTHER"],             // 대소문자 다름 → 기타
  ["X".repeat(20000), "OTHER"],      // 아주 긴 글자 → 기타
  [{ $ne: null }, "OTHER"],          // 문자열이 아닌 값 → 기타
  [["NAVER_AD"], "OTHER"],
  [12345, "OTHER"],
];

for (const existing of [false, true]) {
  const branch = existing ? "UPDATE(기존 신청 덮어쓰기)" : "INSERT(새 신청)";

  test(`체험 신청 ${branch} — 목록 밖 유입 경로는 «기타»로 저장되고 신청은 거절되지 않는다`, { timeout: 20000 }, async () => {
    for (const [sent, expected] of CASES) {
      const { result, value } = await submitTrial(sent, { existing });
      assert.equal(result.success, true, `신청이 거절됐다: ${String(sent).slice(0, 30)}`);
      assert.equal(result.mode, existing ? "updated" : "created");
      assert.equal(value, expected, `보낸 값 ${String(sent).slice(0, 30)}`);
    }
  });

  test(`수강 신청 ${branch} — 목록 밖 가입 경로는 «기타»로 저장되고 신청은 거절되지 않는다`, { timeout: 20000 }, async () => {
    for (const [sent, expected] of CASES) {
      const { result, value } = await submitEnroll(sent, { existing });
      assert.equal(result.success, true, `신청이 거절됐다: ${String(sent).slice(0, 30)}`);
      assert.equal(result.mode, existing ? "updated" : "created");
      assert.equal(value, expected, `보낸 값 ${String(sent).slice(0, 30)}`);
    }
  });
}

test("«필수» 검사와 문구는 그대로 — 빈 값은 저장 전에 거절한다", async () => {
  for (const empty of ["", undefined, null]) {
    const trial = fakeDb({ existing: false });
    await assert.rejects(loadPublicActions(trial.prisma).actions.submitTrialApplication(trialInput(empty)), { message: "신청경로를 선택해주세요." });
    assert.equal(trial.writes.length, 0);
    const enroll = fakeDb({ existing: false });
    await assert.rejects(loadPublicActions(enroll.prisma).actions.submitEnrollApplication(enrollInput(empty)), { message: "가입경로를 선택해주세요." });
    assert.equal(enroll.writes.length, 0);
  }
});

test("공백만 보낸 값은 «필수» 검사를 지나가지만 공백 그대로 저장되지 않는다 — 기존 기본값(체험 WEBSITE·수강 빈 값)", async () => {
  // 화면에서는 나올 수 없는 값이다(선택 상자). 화면 밖 요청일 때의 동작을 못박아 둔다.
  for (const existing of [false, true]) {
    assert.equal((await submitTrial("   ", { existing })).value, "WEBSITE");
    assert.equal((await submitEnroll("   ", { existing })).value, null);
  }
});

test("대조 — 정규화 호출을 뺀 사본은 같은 요청에서 보낸 글자가 그대로 저장된다(위 테스트가 그 줄을 지킨다는 증거)", { timeout: 20000 }, async () => {
  const source = read("src/app/actions/public.ts");
  const TRIAL_LINE = 'const trialSource = normalizeReferralSource(data.source) || "WEBSITE";';
  const ENROLL_LINE = "const referralSource = normalizeReferralSource(data.referralSource) || null;";
  assert.equal(source.split(TRIAL_LINE).length, 2, "체험 정규화 줄은 소스에 정확히 한 번");
  assert.equal(source.split(ENROLL_LINE).length, 2, "수강 정규화 줄은 소스에 정확히 한 번");
  // 저장 인자가 요청값을 직접 쓰는 곳이 남아 있으면 안 된다(한 갈래만 고쳐지는 사고 방지)
  assert.doesNotMatch(source, /data\.source \|\| "WEBSITE"/);
  assert.doesNotMatch(source, /data\.referralSource \|\| null/);

  const withoutTrial = (text) => text.replace(TRIAL_LINE, 'const trialSource = data.source || "WEBSITE";');
  const withoutEnroll = (text) => text.replace(ENROLL_LINE, "const referralSource = data.referralSource || null;");
  for (const existing of [false, true]) {
    assert.equal((await submitTrial("HACKED", { existing, mutate: withoutTrial })).value, "HACKED");
    assert.equal((await submitEnroll("HACKED", { existing, mutate: withoutEnroll })).value, "HACKED");
  }
});
