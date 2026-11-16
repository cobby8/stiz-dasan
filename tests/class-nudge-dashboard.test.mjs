import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 수업 미처리 장치 1단계(2026-11-17) — 대시보드 칸·권한·«표 없음» 방어·«이 표를 읽는 곳» 못박기.
// 로그인된 화면은 여기서 실행하지 못한다 — 화면 규칙(아이콘 없음·토큰 색·굵기)과 배선을 소스로 고정한다.

const read = (path) => readFileSync(path, "utf8");
/** 주석을 뺀 코드(주석 속 글자에 단정이 걸리지 않게) */
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CARD = "src/components/admin/ClassDayBoardCard.tsx";
const DASHBOARD = "src/app/admin/AdminDashboardClient.tsx";
const ACTION = "src/app/actions/class-day-cancel.ts";
const ROUTE = "src/app/api/admin/class-day-board/route.ts";
const SERVER = "src/lib/class-nudge/boardServer.ts";
const MIGRATION = "prisma/migrations/20261117120000_add_class_day_cancel/migration.sql";

const rules = await loadTsModule("src/lib/class-nudge/rules.ts");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}
const SRC_FILES = walk("src");

// ── 대시보드 칸 ───────────────────────────────────────────────────────────────

test("대시보드: «오늘의 수업» 카드 자리에 새 칸 하나만 들어갔다", () => {
  const dash = read(DASHBOARD);
  assert.match(dash, /import ClassDayBoardCard from "@\/components\/admin\/ClassDayBoardCard";/);
  assert.equal((dash.match(/<ClassDayBoardCard\b/g) ?? []).length, 1);
  assert.doesNotMatch(dash, /TodayClassesCard/);
  assert.doesNotMatch(code(DASHBOARD), /오늘의 수업/);
  // 대시보드의 다른 약속은 그대로 — 처리할 신청·관리 도구·맨 위 카드
  assert.match(dash, /처리할 신청/);
  assert.match(dash, /<SiteOpsBotCard /);
  assert.match(dash, /\{summary && <DashboardSummaryCards/);
});

test("칸은 자료를 props 로 받지 않고 스스로 읽는다(대시보드 첫 화면 조회에 얹지 않는다)", () => {
  const card = read(CARD);
  assert.match(card, /^"use client";/);
  assert.match(card, /export default function ClassDayBoardCard\(\)/);
  assert.match(card, /const BOARD_URL = "\/api\/admin\/class-day-board";/);
  assert.match(card, /fetch\(BOARD_URL, \{ cache: "no-store" \}\)/);
  // 대시보드 페이지·읽기 묶음은 이 칸 때문에 바뀌지 않는다
  assert.doesNotMatch(read("src/app/admin/page.tsx"), /class-nudge|ClassDayBoard/);
  assert.doesNotMatch(read("src/lib/adminReadPayloads.ts"), /class-nudge|ClassDayBoard/);
});

test("자동 새로고침: 탭이 보일 때만 60초마다, 돌아오면 바로, 늦은 응답은 버린다", () => {
  const card = read(CARD);
  assert.match(card, /const REFRESH_MS = 60_000;/);
  assert.match(card, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible"\) void load\(\);/);
  assert.match(card, /addEventListener\("visibilitychange", onVisible\)/);
  assert.match(card, /removeEventListener\("visibilitychange", onVisible\)/);
  assert.match(card, /clearInterval\(timer\)/);
  assert.match(card, /if \(request !== requestRef\.current\) return;/);
});

test("화면 규칙: 아이콘·이모지·색 코드·굵은 글자·브라우저 경고창이 없다", () => {
  const card = read(CARD);
  assert.doesNotMatch(card, /material-symbols|FontFreeIcon|lucide|<svg/i);
  assert.doesNotMatch(card, /\p{Extended_Pictographic}/u, "이모지");
  assert.doesNotMatch(code(CARD), /#[0-9a-fA-F]{3,8}\b/, "색 코드 직접 쓰기");
  assert.doesNotMatch(card, /\b(bg|text|border)-(red|green|blue|yellow|amber|gray|slate|sky|emerald|rose|orange|zinc|neutral)-\d/, "Tailwind 기본 색");
  assert.doesNotMatch(card, /font-(extrabold|black|bold)\b/);
  assert.doesNotMatch(code(CARD), /(?<![A-Za-z.])(alert|confirm|prompt)\(/);
  assert.doesNotMatch(card, /text-\[(?:[0-9]|1[01])px\]/, "12px 미만 글자");
  // 색은 전부 학원 토큰
  for (const m of card.matchAll(/var\((--[a-z-]+)\)/g)) assert.match(m[1], /^--color-academy-/);
  // 버튼 크기는 테마의 기존 변형으로(같은 속성 Tailwind 유틸을 덧붙이면 무시된다)
  for (const m of card.matchAll(/className="([^"]*academy-button-[^"]*)"/g)) {
    assert.match(m[1], /^academy-button-secondary academy-button-sm( shrink-0)?$/, `버튼 클래스: ${m[1]}`);
  }
});

test("상태는 글자 배지 — 색만으로 뜻을 전하지 않고, 영문 상태 이름을 화면에 내보내지 않는다", () => {
  const card = code(CARD);
  // 상태 글자는 규칙 모듈의 한글 문장으로만 만든다
  assert.match(card, /classDayStatusText\(row\.status, row\.rosterCount\)/);
  assert.match(card, /TONE_CLASS\[classDayTone\(row\.status\)\]/);
  // JSX 글자 자리(>…<)에 영문 상태 이름이 없다
  for (const m of card.matchAll(/>\s*([A-Z_]{4,})\s*</g)) assert.fail(`화면에 영문 상태 이름: ${m[1]}`);
  for (const tone of ["danger", "warning", "success", "neutral"]) {
    assert.match(card, new RegExp(`${tone}: "bg-\\[var\\(--color-academy-${tone}-soft\\)\\] text-\\[var\\(--color-academy-${tone}\\)\\]"`));
  }
  // 진행 중 = 보조 색(«지금 있는 곳»). 밝은 하늘색은 글자로 쓰지 않는다
  assert.match(card, /progress: "bg-\[var\(--color-academy-secondary-soft\)\] text-\[var\(--color-academy-secondary-ink\)\]"/);
  assert.doesNotMatch(card, /text-\[var\(--color-academy-secondary\)\]/);
  // 보라색 안내 토큰은 «보강·입금 확인 중» 전용이라 쓰지 않는다
  assert.doesNotMatch(card, /--color-academy-info/);
});

test("한 줄 행: 줄 전체가 출결 화면 링크, «휴강» 버튼은 링크 밖", () => {
  const card = read(CARD);
  assert.match(card, /<li key=\{row\.key\} className="flex min-h-12 /); // 48px
  assert.match(card, /<Link\s+href=\{row\.href\}\s+prefetch=\{false\}\s+className="flex min-h-11 /); // 터치 44px
  const link = card.slice(card.indexOf("<Link"), card.indexOf("</Link>"));
  assert.doesNotMatch(link, /<button/, "링크 안에 버튼");
  // 글자를 자르지 않는다
  assert.doesNotMatch(card, /\btruncate\b|line-clamp/);
  // 기존 카드가 보이던 수강/정원 숫자는 남긴다
  assert.match(card, /\$\{row\.rosterCount\}\/\$\{row\.capacity\}명/);
});

test("빈 상태·실패 문구", () => {
  const card = read(CARD);
  for (const text of ["오늘은 수업이 없습니다.", "오늘은 휴무입니다(", "수업 현황을 불러오지 못했습니다.", "다시 불러오기", "연간일정을 읽지 못해 휴무 판정 없이 표시합니다.", "방금 새로고침 실패", "담당 미지정", "(앱 미연결)", "시간 미정"]) {
    assert.ok(card.includes(text), `문구 없음: ${text}`);
  }
});

// ── 휴강 표시: 문구·버튼 ──────────────────────────────────────────────────────

test("확인 단계 문구: 하는 일(독촉 멈춤)과 하지 않는 일(학부모 안내·보강권·셔틀)을 같이 적는다", () => {
  const message = rules.cancelConfirmMessage("화4 초등 저학년");
  assert.ok(message.startsWith("화4 초등 저학년 오늘 수업을 휴강으로 표시할까요?"));
  assert.ok(message.includes("학부모 안내·보강권·셔틀은 바뀌지 않아요"));
  assert.match(message, /독촉만 멈춰요/);
  const card = read(CARD);
  assert.match(card, /cancelConfirmMessage\(row\.name\)/);
  assert.match(card, /await askConfirm\(question, \{ tone: "primary" \}\)/);
  assert.match(card, /from "@\/components\/ui\/feedback"/);
});

test("«휴강» 버튼은 아직 출결이 없는 시작 전·미시작·시간 미정 줄에만, 휴강 줄에는 «휴강 취소»", () => {
  const card = read(CARD);
  assert.match(card, /state !== "UPCOMING" && state !== "NOT_STARTED" && state !== "TIME_UNKNOWN"\) return false;/);
  assert.match(card, /return row\.status\.unmarkedCount >= row\.rosterCount;/);
  assert.match(card, /row\.status\.state === "CANCELLED" \?/);
  assert.ok(card.includes('"휴강 취소"') && card.includes('"휴강"'));
  // 누른 뒤에는 결과와 상관없이 바로 다시 읽는다
  assert.match(card, /finally \{\s*setBusyKey\(null\);\s*void load\(\);/);
});

// ── 권한 ─────────────────────────────────────────────────────────────────────

test("읽기 API: 원장·부원장 확인이 조회보다 먼저, 실패는 401, 브라우저 캐시 금지", () => {
  const route = read(ROUTE);
  const body = route.slice(route.indexOf("export async function GET()"));
  assert.ok(body.indexOf("await requireAdmin();") > 0);
  assert.ok(body.indexOf("await requireAdmin();") < body.indexOf("getClassDayBoard("), "조회가 권한 확인보다 먼저다");
  assert.match(body, /status: 401/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
  // 날짜 인자를 받지 않는다(1단계는 오늘만) — 오늘은 KST 로
  assert.doesNotMatch(route, /searchParams|request\.url/);
  assert.match(body, /const nowMs = Date\.now\(\);\s*const board = await getClassDayBoard\(todayKst\(nowMs\), nowMs\);/);
});

test("휴강 액션: 두 액션 모두 DB 를 건드리기 전에 원장·부원장 확인, 실패는 던지지 않고 결과로", () => {
  const action = read(ACTION);
  assert.match(action, /^"use server";/);
  assert.match(action, /const admin = await requireAdmin\(\);\s*return \{ ok: true, adminUserId: admin\.appUserId \};/);
  assert.match(action, /catch \{\s*return \{ ok: false, message: "원장·부원장만 휴강을 표시할 수 있습니다\." \};/);
  for (const name of ["setClassDayCancel", "clearClassDayCancel"]) {
    const start = action.indexOf(`export async function ${name}(`);
    assert.ok(start > 0, `${name} 없음`);
    const body = action.slice(start, action.indexOf("\n}\n", start));
    const gate = body.indexOf("const gate = await adminGate();");
    const bail = body.indexOf("if (!gate.ok) return gate;");
    const db = body.search(/prisma|InDb\(/);
    assert.ok(gate > 0 && bail > gate && db > bail, `${name}: 권한 확인이 DB 보다 먼저가 아니다`);
    // 감사 기록의 행위자는 요청 값이 아니라 확인된 관리자
    assert.match(body, /actorUserId: gate\.adminUserId/);
    // «오늘»은 서버가 KST 로 정한다(요청 값을 믿지 않는다)
    assert.match(body, /today: todayKst\(\)/);
    // 표시 + 감사 기록은 한 트랜잭션
    assert.match(body, /prisma\.\$transaction\(\(tx\) => run\(tx\)\)/);
  }
  // "use server" 파일은 async 함수만 내보낸다
  for (const m of action.matchAll(/^export\s+(?!async function)(.*)$/gm)) assert.fail(`액션 파일의 다른 export: ${m[1]}`);
});

test("캐시: 사실만 30초 캐시하고 휴강 표시·취소가 그 태그를 비운다. 문지기는 캐시 밖", () => {
  const server = read(SERVER);
  assert.match(server, /export const CLASS_DAY_CACHE_TAG = "admin-class-day";/);
  assert.match(server, /\["class-day-facts-v1"\],\s*\{ revalidate: 30, tags: \[CLASS_DAY_CACHE_TAG, "admin-classes"\] \}/);
  assert.doesNotMatch(code(SERVER), /requireAdmin|cookies\(|headers\(/);
  // 판정(지금 시각)은 캐시 밖에서 매번
  assert.match(server, /return buildClassDayBoard\(await getCachedClassDayFacts\(dateYmd\), nowMs\);/);
  const action = read(ACTION);
  assert.match(action, /if \(result\.changed\) revalidateTag\(CLASS_DAY_CACHE_TAG, \{ expire: 0 \}\);/);
});

test("DB 접근: raw SQL 만(ORM 기본 메서드 금지), 조회 4번을 한꺼번에 쏘지 않는다", () => {
  for (const file of SRC_FILES.filter((f) => f.startsWith("src/lib/class-nudge/")).concat(ACTION, ROUTE)) {
    const text = code(file);
    assert.doesNotMatch(text, /\.(findMany|findFirst|findUnique|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate)\(/, `${file}: ORM 기본 메서드`);
  }
  assert.doesNotMatch(code("src/lib/class-nudge/boardQuery.ts"), /Promise\.all/);
  assert.doesNotMatch(code(SERVER), /Promise\.all/);
});

// ── 범위 못박기: 휴강 표시는 독촉만 멈춘다 ────────────────────────────────────

test("표 ClassDayCancel 을 읽고 쓰는 곳은 src/lib/class-nudge 뿐이다", () => {
  const users = SRC_FILES.filter((file) => /"ClassDayCancel"/.test(read(file))).sort();
  assert.deepEqual(users, ["src/lib/class-nudge/boardQuery.ts", "src/lib/class-nudge/cancelStore.ts"]);
});

test("class-nudge 모듈을 끌어 쓰는 곳은 관리자 대시보드 칸·읽기 API·휴강 액션뿐이다", () => {
  // 학부모 화면·청구·보강권·셔틀·출결 코드가 휴강 표시를 읽기 시작하면 여기서 깨진다(2단계에서 넓힐 때 이 목록을 고친다)
  const allowed = new Set([ACTION, ROUTE, CARD]);
  const outside = SRC_FILES.filter((file) => !file.startsWith("src/lib/class-nudge/")
    && /from\s+["'](?:@\/lib\/class-nudge\/|@\/app\/actions\/class-day-cancel|@\/components\/admin\/ClassDayBoardCard)/.test(read(file)));
  for (const file of outside) {
    assert.ok(allowed.has(file) || file === DASHBOARD, `${file} 가 수업 미처리 장치를 끌어 쓴다`);
    for (const blocked of ["src/app/mypage/", "src/app/staff/", "src/lib/billing/", "src/lib/makeup/", "src/lib/shuttle/", "src/app/admin/attendance/"]) {
      assert.ok(!file.startsWith(blocked), `${file}: 휴강 표시가 미치면 안 되는 영역`);
    }
  }
  // 대시보드는 칸 부품만 끌어 쓴다
  assert.doesNotMatch(read(DASHBOARD), /class-nudge|class-day-cancel/);
});

test("건드리지 않기로 한 화면·액션은 이 장치를 모른다", () => {
  for (const file of ["src/app/actions/staff-sessions.ts", "src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", "src/app/admin/page.tsx"]) {
    assert.doesNotMatch(read(file), /class-nudge|ClassDayCancel|class-day-cancel/, file);
  }
});

// ── 마이그레이션·스키마 ───────────────────────────────────────────────────────

test("마이그레이션: 새 표만 만든다(기존 표를 바꾸지 않는다), RLS 켜고 권한 회수", () => {
  assert.ok(existsSync(MIGRATION));
  const sql = read(MIGRATION).replace(/^\s*--.*$/gm, "");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."ClassDayCancel"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "ClassDayCancel_date_classId_kind_startTime_key"\s+ON public\."ClassDayCancel" \(date, "classId", kind, "startTime"\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."ClassDayCancel" FROM anon, authenticated/);
  assert.match(sql, /CHECK \(kind IN \('REGULAR', 'SEASONAL'\)\)/);
  assert.match(sql, /REFERENCES public\."Class" \(id\) ON DELETE CASCADE/);
  // 다른 표를 고치거나 지우는 문장이 없다
  // (외래 키의 ON DELETE/ON UPDATE CASCADE 구절은 문장이 아니라서 빼고 본다)
  assert.doesNotMatch(sql.replace(/ON (DELETE|UPDATE) CASCADE/g, ""), /\b(DROP|TRUNCATE|UPDATE|DELETE|INSERT INTO)\b/);
  for (const m of sql.matchAll(/ALTER TABLE\s+(\S+)/g)) assert.equal(m[1], 'public."ClassDayCancel"');
  // 폴더 이름은 기존 형식(숫자 14자리)이고 실제로 있다.
  // «가장 최근 폴더»인지는 보지 않는다 — 다른 작업이 더 늦은 마이그레이션을 추가하면 이 테스트가 깨져 배포가 막힌다(검수 반영).
  const folders = readdirSync("prisma/migrations").filter((name) => /^\d{14}_/.test(name));
  assert.ok(folders.includes("20261117120000_add_class_day_cancel"));
});

test("마이그레이션의 CHECK 와 코드의 입력 확인이 같은 값을 받는다", () => {
  const today = "2026-11-17";
  // kind 목록
  assert.equal(rules.validateCancelInput({ date: today, today, kind: "REGULAR", classDayOfWeek: "Tue" }).ok, true);
  assert.equal(rules.validateCancelInput({ date: today, today, kind: "SEASONAL", startTime: "09:00" }).ok, true);
  // 정규는 startTime '' · 특강은 HH:MM — CHECK ClassDayCancel_startTime_check 와 같은 모양
  assert.equal(rules.validateCancelInput({ date: today, today, kind: "REGULAR", classDayOfWeek: "Tue", startTime: "16:00" }).startTime, "");
  assert.match(rules.validateCancelInput({ date: today, today, kind: "SEASONAL", startTime: "09:00" }).startTime, /^[0-9]{2}:[0-9]{2}$/);
  // 사유 길이 = CHECK 의 200
  assert.equal(rules.CANCEL_REASON_MAX, 200);
  assert.match(read(MIGRATION), /char_length\(reason\) <= 200/);
});

test("schema.prisma: 모델과 되받는 줄이 있고 유일 키가 마이그레이션과 같다", () => {
  const schema = read("prisma/schema.prisma");
  const start = schema.indexOf("model ClassDayCancel {");
  assert.ok(start > 0);
  const model = schema.slice(start, schema.indexOf("\n}", start));
  assert.match(model, /@@unique\(\[date, classId, kind, startTime\], map: "ClassDayCancel_date_classId_kind_startTime_key"\)/);
  assert.match(model, /class\s+Class\s+@relation\(fields: \[classId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /dayCancels\s+ClassDayCancel\[\]/);
});
