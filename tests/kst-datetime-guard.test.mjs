import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// 시간대 사고를 **코드로** 막는 층. 규칙 문서만으로는 안 지켜진다는 걸 이 프로젝트가 이미 겪었다.
//
// 이 유형의 버그는 배포된 서버(UTC)와 개발 PC(KST)의 시간대가 달라서 생긴다.
// 로컬에서는 멀쩡하고 배포하면 틀리며, 빌드도 타입검사도 통과한다. 그래서 사람이 못 잡는다.
//
// ⚠️ 아래 ALLOW 목록은 "괜찮다"는 뜻이 아니라 **아직 정리하지 못한 빚**이다.
//    새 파일을 여기에 추가하지 말 것. 정리하면 목록에서 지운다.

const SRC = "src";

/** 문자열·주석 안의 코드 조각을 규칙으로 오인하지 않도록 주석을 걷어낸다. */
function stripComments(code) {
  let out = "", i = 0, quote = null;
  while (i < code.length) {
    const c = code[i], n = code[i + 1];
    if (quote) {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < code.length && code[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") {
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) { out += code[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

const files = [];
for (const f of await walk(SRC)) {
  const raw = await readFile(f, "utf8");
  files.push({ file: f, raw, code: stripComments(raw), isClient: /^\s*["']use client["']/m.test(raw) });
}

function scan(re, pick = () => true) {
  const hits = [];
  for (const f of files) {
    if (!pick(f)) continue;
    f.code.split("\n").forEach((line, i) => { if (re.test(line)) hits.push(`${f.file}:${i + 1}`); });
  }
  return hits;
}
const fileOf = (hit) => hit.slice(0, hit.lastIndexOf(":"));
const violations = (hits, allow) => hits.filter((h) => !allow.includes(fileOf(h)));
const report = (label, list) => `${label}\n  ${list.join("\n  ")}\n→ @/lib/datetime/kst 를 쓰세요.`;

// ── 규칙 1. "오늘"을 UTC 로 구하지 않는다 ─────────────────────────────────
// new Date().toISOString().slice(0,10) 은 UTC 날짜다. KST 00:00~09:00 에는 **어제**가 나온다.
// 새벽에 출석부를 열면 전날 출석부가 열린다.
const R1 = /\.toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|split\(\s*["']T["']\s*\)\s*\[\s*0\s*\])/;
const R1_ALLOW = [
  "src/app/actions/public.ts",
  "src/app/admin/annual/AnnualAdminClient.tsx",
  "src/app/admin/apply/ApplyAdminModals.tsx",
  "src/app/admin/classes/[id]/ClassDetailClient.tsx",
  "src/app/admin/classes/[id]/SessionLogModal.tsx",
  "src/app/admin/finance/FinanceClient.tsx",
  "src/app/admin/seasonal/SeasonalAdminClient.tsx",
  "src/app/admin/seasonal/shuttle/ShuttleRosterClient.tsx",
  "src/app/admin/students/ExcelUploadModal.tsx",
  "src/app/admin/students/StudentManagementClient.tsx",
  "src/app/admin/students/[id]/StudentDetailClient.tsx",
  "src/app/api/admin/backup/route.ts",
  "src/app/api/admin/session-detail/route.ts",
  "src/app/mypage/MyPageClient.tsx",
  "src/app/mypage/history/HistoryClient.tsx",
  "src/app/mypage/makeup/MakeupClient.tsx",
  "src/app/staff/shuttle/StaffShuttleDashboardClient.tsx",
  "src/lib/billing-due-date.ts",
  "src/lib/googleCalendarWrite.ts",
  "src/lib/payment-ledger.ts",
  "src/lib/regular/regularAbsenceRules.ts",
  "src/lib/seasonal/service.ts",
  "src/lib/shuttle/parent.ts",
  "src/lib/shuttle/service.ts",
];

test("규칙 1 — '오늘'을 UTC 로 구하지 않는다", () => {
  const bad = violations(scan(R1), R1_ALLOW);
  assert.deepEqual(bad, [], report("UTC 날짜를 '오늘'로 쓰고 있습니다(새벽에 어제가 나옵니다):", bad));
});

// ── 규칙 2. T00:00+09:00 에 getUTC* 를 쓰지 않는다 ────────────────────────
// 2026-08-12 실측: 금요일 반의 보강 추천 날짜가 토요일로 나갔다.
// T12:00 은 우연히 맞아서 옆 파일을 보고 따라 쓰면 그대로 터진다. 예외 없이 금지.
const R2 = /T00:00(?::00)?\+09:00[^\n]*\.getUTC/;

test("규칙 2 — T00:00+09:00 에 getUTC* 를 붙이지 않는다(하루 밀린다)", () => {
  const bad = scan(R2);
  assert.deepEqual(bad, [], report("요일·날짜가 하루 밀립니다:", bad));
});

// ── 규칙 3. 서버 코드는 서버 시간대를 믿지 않는다 ─────────────────────────
// Vercel 은 UTC 로 돈다. getDay()/getHours() 는 서버 시간대를 따르므로 9시간 어긋난다.
// 화면(use client)은 사용자 브라우저(=KST)에서 돌아 실사용상 맞으므로 대상에서 뺀다.
const R3 = /new Date\([^)]*\)\s*\.\s*get(?:Day|Hours|Minutes)\(\)/;
const R3_ALLOW = [
  // T12:00 을 기준점으로 잡아 현재는 맞지만 위태롭다 — kst.kstDow 로 옮길 것.
  "src/lib/staff-session-queries.ts",
];
// 2026-10-06 정리: src/lib/queries.ts (출석 반 목록의 요일 attendanceDayOfWeek) → kstDow(date) 로 교체.
// 2026-08-16 정리: src/lib/adminReadPayloads.ts (대시보드 오늘 요일·오늘 수업 3곳) → kstDow(todayKst()) 로 교체.

test("규칙 3 — 서버 코드가 서버 시간대에 기대지 않는다", () => {
  const bad = violations(scan(R3, (f) => !f.isClient), R3_ALLOW);
  assert.deepEqual(bad, [], report("서버(UTC)에서 9시간 어긋납니다:", bad));
});

// ── 규칙 4. KST 헬퍼를 파일마다 새로 만들지 않는다 ───────────────────────
// 같은 함수가 파일마다 복사되면 한쪽만 고쳐지는 사고가 난다(실제로 그렇게 됐다).
const R4 = /function\s+(?:kstYmd|seoulYmd|todayStr|kstDow|seoulDow|toKstDate)\s*\(/;
const R4_ALLOW = [
  "src/lib/datetime/kst.ts", // 여기가 원본이다
  "src/app/admin/classes/[id]/SessionLogModal.tsx",
  "src/lib/makeup/credit-service.ts",
  "src/lib/makeup/parent-makeup.ts",
];

test("규칙 4 — KST 헬퍼는 한 곳에만 둔다", () => {
  const bad = violations(scan(R4), R4_ALLOW);
  assert.deepEqual(bad, [], report("날짜 헬퍼를 새로 만들었습니다:", bad));
});

// ── 공용 모듈이 실제로 존재하고 필요한 것을 내보내는지 ────────────────────
test("공용 모듈이 규칙에서 가리키는 것들을 제공한다", async () => {
  const kst = await readFile("src/lib/datetime/kst.ts", "utf8");
  for (const fn of ["todayKst", "toKstYmd", "kstDow", "kstAt", "addDaysKst", "diffDaysKst", "isKstYmd"]) {
    assert.match(kst, new RegExp(`export function ${fn}\\b`), `${fn} 가 없으면 규칙을 지킬 방법이 없다`);
  }
});

test("빚 목록은 줄어들기만 한다", () => {
  // 이 숫자를 올리려면 위반을 새로 들이는 것이다. 정리해서 내리는 것만 허용한다.
  assert.ok(R1_ALLOW.length <= 25, `R1 미정리 ${R1_ALLOW.length}개 — 새로 추가하지 말 것`);
  // 2026-10-06: queries.ts 정리로 2 → 1 로 내림.
  assert.ok(R3_ALLOW.length <= 1, `R3 미정리 ${R3_ALLOW.length}개 — 새로 추가하지 말 것`);
  assert.ok(R4_ALLOW.length <= 5, `R4 미정리 ${R4_ALLOW.length}개 — 새로 추가하지 말 것`);
});
