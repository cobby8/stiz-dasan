// 「신규 셔틀 신청」 탭을 정규 배차 화면으로 합침 — 2026-11-05 원장 지시
//   「신규셔틀 신청을 따로 분리하지 말고 정규셔틀 배차화면에서 신규 배차 학생을 쉽게 확인하고 배정할 수 있도록」
// 결정: ① 탭 없애고 정규배차로 합치기 ② 관리자가 「순서에 넣기」 누르면 바로 운행표 반영(기사님 화면과 같은 API).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = (file) => readFileSync(file, "utf8");
const TABS = read("src/app/admin/shuttle/ShuttleSectionTabs.tsx");
// 2026-11-09: 정규 배차 화면 = 기사님과 같은 운행표(RegularRunEditor). 옛 RouteSection 배차 화면은 없앴다.
const DISPATCH = read("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx");
const PANEL = read("src/components/shuttle/assign/NewStudentDispatchPanel.tsx");
const LEG = read("src/components/shuttle/assign/AssignLegView.tsx");
const DRIVER = read("src/app/staff/shuttle/assign/DriverAssignClient.tsx");

test("셔틀 탭: 「신규 셔틀 신청」 탭이 없고, 옛 주소는 어느 탭도 잘못 켜지 않는다", () => {
  assert.doesNotMatch(TABS, /key: "intake"/);
  assert.doesNotMatch(TABS, /label: "신규 셔틀 신청"/);
  assert.doesNotMatch(TABS, /href: "\/admin\/shuttle\/intake"/);
  assert.match(TABS, /href: "\/admin\/shuttle\/regular-dispatch"/);
});

/** intake/page.tsx 를 실제로 실행해 redirect 주소를 받는다(next/navigation 은 가짜). */
async function intakeRedirect(month) {
  const js = ts.transpileModule(read("src/app/admin/shuttle/intake/page.tsx"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  let to = null;
  const mocks = {
    "next/navigation": { redirect: (url) => { to = url; throw new Error("NEXT_REDIRECT"); } },
    // 화면마다 관리자 확인(d3) — 여기서는 통과로 둔다
    "@/lib/auth-guard": { requireAdmin: async () => ({}) },
    "@/lib/regular/serviceMonth": { isServiceMonth: (v) => /^20\d{2}-(0[1-9]|1[0-2])$/.test(v) },
  };
  vm.runInNewContext(js, { module, exports: module.exports, require: (n) => { if (n in mocks) return mocks[n]; throw new Error(`unexpected import ${n}`); }, Promise, Error, encodeURIComponent });
  await module.exports.default({ searchParams: Promise.resolve(month == null ? {} : { month }) }).catch((e) => { if (e.message !== "NEXT_REDIRECT") throw e; });
  return to;
}

test("옛 주소 /admin/shuttle/intake → 정규 배차로(고른 월 유지, 이상한 월은 버림)", async () => {
  assert.equal(await intakeRedirect("2026-12"), "/admin/shuttle/regular-dispatch?month=2026-12");
  assert.equal(await intakeRedirect(undefined), "/admin/shuttle/regular-dispatch");
  assert.equal(await intakeRedirect("2026-13"), "/admin/shuttle/regular-dispatch");
  assert.equal(await intakeRedirect("x&studentId=1"), "/admin/shuttle/regular-dispatch");
  // 옛 관리자 신청 화면을 더는 그리지 않는다(기사님 검토 화면 /staff/shuttle/intake 는 그대로)
  assert.doesNotMatch(read("src/app/admin/shuttle/intake/page.tsx"), /ShuttleIntakeClient/);
  assert.match(read("src/app/staff/shuttle/intake/page.tsx"), /<ShuttleIntakeClient mode="driver"|ShuttleIntakeClient/);
});

test("관리자 화면 어디에도 /admin/shuttle/intake 로 가는 링크가 남지 않는다", async () => {
  const { execSync } = await import("node:child_process");
  let out = "";
  try { out = execSync('git grep -n "/admin/shuttle/intake" -- src', { encoding: "utf8" }); } catch { out = ""; }
  // API 경로(/api/admin/shuttle/intake)는 기사 검토 요청에 그대로 쓴다 — 화면 링크만 없어야 한다.
  const links = out.split("\n").filter((l) => l && !l.includes("/api/admin/shuttle/intake"));
  assert.deepEqual(links, []);
});

test("정규 운행표 화면: «배정 필요» 패널을 요일 탭 아래·운행표 위에 두고, 월이 바뀌면 새로 그린다", () => {
  assert.match(DISPATCH, /import NewStudentDispatchPanel from "@\/components\/shuttle\/assign\/NewStudentDispatchPanel"/);
  assert.match(DISPATCH, /<NewStudentDispatchPanel key=\{serviceMonth\} month=\{serviceMonth\} selectedWeekday=\{weekday\}/);
  // 요일 탭(dayCounts.map) 다음, 운행표 카드(RunBoard) 앞
  const tabs = DISPATCH.indexOf("dayCounts.map((d)");
  const panel = DISPATCH.indexOf("<NewStudentDispatchPanel");
  const board = DISPATCH.indexOf("<RunBoard");
  assert.ok(tabs > 0 && tabs < panel && panel < board, "요일 탭 → 배정 필요 → 운행표 순서");
});

test("넣은 뒤: 운행표(명단)를 서버에서 다시 읽는다 · 반 이동 표시는 같은 배정 목록으로", () => {
  assert.match(DISPATCH, /onAssigned=\{\(\) => \{ setMessage\(null\); router\.refresh\(\); \}\}/);
  assert.match(DISPATCH, /onBoard=\{setBoard\} openRequest=\{openRequest\}/);
  assert.match(PANEL, /onAssigned\(\);\s*const next = await load\(\);/);
  // 자동 제안·저장 노선 화면 부품을 다시 쓰지 않는다
  assert.doesNotMatch(DISPATCH, /RouteSection|\/api\/admin\/regular\/dispatch|refreshKey/);
});

test("패널: 기준은 기사님과 같은 배정 목록(getDriverAssignBoard API) · 넣기는 공용 AssignLegView + 같은 API", () => {
  assert.match(PANEL, /const ASSIGN_API = "\/api\/staff\/shuttle\/assign";/);
  assert.match(PANEL, /fetch\(`\$\{ASSIGN_API\}\?month=/);
  assert.match(PANEL, /import AssignLegView from "\.\/AssignLegView"/);
  assert.match(PANEL, /<AssignLegView [^>]*variant="modal" backLabel="닫기" source="ADMIN_DISPATCH"/);
  // 기사 검토 요청은 기존 관리자 intake API 그대로(새 쓰기 경로 없음)
  assert.match(PANEL, /const INTAKE_API = "\/api\/admin\/shuttle\/intake";/);
  assert.match(PANEL, /applicationId: item\.applicationId, serviceMonth: month, driverUserId: chosen, expectedFingerprint: item\.fingerprint/);
  assert.doesNotMatch(PANEL, /\/api\/admin\/regular|regular-roster|\$queryRaw/);
  // 모순 표시 방지: intake 의 진행 문구(배차 완료 등)를 이 줄에 쓰지 않는다 — 상태 배지만
  assert.doesNotMatch(PANEL, /progress\.(label|detail)/);
  // 모달 = 하단 시트(모바일) · 대화상자 표시 · Esc 닫기
  assert.match(PANEL, /role="dialog" aria-modal="true" aria-labelledby="new-student-assign-title"/);
  assert.match(PANEL, /items-end justify-center[^"]*sm:items-center/);
  assert.match(PANEL, /e\.key === "Escape"/);
  // 요약 문구 · 0명이면 작은 한 줄
  assert.match(PANEL, /배정 필요 \{students\.length\}명/);
  // 2026-11-13 UI 통일: 숫자 강조를 <b>(700) 대신 font-semibold(600) span 으로 그린다 — 문구는 그대로.
  assert.match(PANEL, /· 신규 <span className="font-semibold/);
  assert.match(PANEL, /· 반 이동 <span className="font-semibold/);
  assert.match(PANEL, /text-xs text-\[var\(--color-academy-muted\)\]">배정 필요 학생 없음/);
});

test("공용 한 칸 배정: 기사님 화면과 관리자 모달이 같은 파일 · 관리자 표시만 덧붙이고 기사 요청 모양은 그대로", () => {
  assert.match(DRIVER, /<AssignLegView key=/);
  assert.match(LEG, /export default function AssignLegView\(/);
  assert.match(LEG, /fetch\("\/api\/staff\/shuttle\/assign"/);
  assert.match(LEG, /\.\.\.\(source \? \{ source \} : \{\}\)/);
  assert.match(LEG, /const Root = variant === "modal" \? "div" : "main";/);
  // 기사님 화면은 source·variant 를 넘기지 않는다(기존 요청·모양 그대로)
  assert.doesNotMatch(DRIVER, /source=|variant=/);
});

test("디자인: 학원 토큰 색만 · 글자 12px 이상 · 터치 44px · 말줄임 없음 · Material Symbols", () => {
  for (const [name, src] of [["panel", PANEL], ["leg", LEG]]) {
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,6}\b|(bg|text|border)-(red|green|blue|gray|amber|orange|black|white)-?\d*\b/, `${name}: 하드코딩 색`);
    assert.doesNotMatch(src, /text-\[(1[01]|[0-9])(\.\d+)?px\]/, `${name}: 12px 미만 글자`);
    assert.doesNotMatch(src, /\btruncate\b|text-ellipsis|line-clamp/, `${name}: 말줄임`);
  }
  // 2026-11-13 UI 통일(원장 «아이콘 빼고 글자로»): 장식 아이콘을 뺐다 — 남은 아이콘은 펼침/접힘 화살표(패널)뿐이고 Material Symbols 다.
  // 2026-11-14 아이콘 완전 제거: 펼침 화살표 아이콘 → 글자 «접기»/«펼치기»(aria-expanded 는 그대로). 패널에도 아이콘 글꼴이 없다.
  assert.match(PANEL, /aria-expanded=\{expanded\}/);
  // 2026-11-15 아이콘 예외(화살표·종·톱니): 글자 «접기»/«펼치기» → 펼침 화살표(공용 부품). 버튼 이름은 안의 «배정 필요 N명» 글자가 준다
  assert.match(PANEL, /<UiIcon name=\{expanded \? "expand_less" : "expand_more"\} \/>/);
  assert.match(PANEL, /aria-expanded=\{expanded\} aria-controls="new-student-dispatch-list"[\s\S]{0,400}?<span className="font-semibold">배정 필요 \{students\.length\}명<\/span>/);
  assert.doesNotMatch(PANEL, /material-symbols-outlined/);
  assert.doesNotMatch(LEG, /material-symbols-outlined/);
  assert.match(PANEL, /const CHIP = "inline-flex min-h-11/);
  // 2026-11-13 UI 통일: 직접 그린 버튼 → 테마 보조 버튼(academy-button-secondary 는 높이 44px)
  assert.match(PANEL, /const BUTTON = "academy-button-secondary";/);
  assert.doesNotMatch(PANEL, /lucide-react/);
});

test("RouteSection: 사람 편집(userEdited)은 markDirty 만 켜고 자동 초안·저장본 읽기·저장 성공 때 끈다 · 방학특강은 이 prop 을 안 쓴다", () => {
  const rs = read("src/components/seasonal/RouteSection.tsx");
  assert.match(rs, /function markDirty\(\) \{ editSeq\.current \+= 1; setDirty\(true\); setUserEdited\(true\); \}/);
  assert.equal((rs.match(/setUserEdited\(true\)/g) ?? []).length, 1);
  assert.match(rs, /setDirty\(true\); setUserEdited\(false\); setRouteReady\(true\);/); // 자동 초안(generate)
  assert.match(rs, /setDirty\(relocated > 0\);[^\n]*\n\s*setUserEdited\(false\);/); // 저장본 읽기
  assert.match(rs, /if \(editSeq\.current === seqAtStart\) \{ setDirty\(false\); setUserEdited\(false\); \}/); // 저장 성공
  assert.match(rs, /useEffect\(\(\) => \{ onUserEditChange\?\.\(userEdited\); \}, \[userEdited, onUserEditChange\]\);/);
  // 「저장 안 됨」 표시·onDirtyChange 는 dirty 그대로
  assert.match(rs, /useEffect\(\(\) => \{ onDirtyChange\?\.\(dirty\); \}, \[dirty, onDirtyChange\]\);/);
  assert.doesNotMatch(read("src/app/admin/seasonal/dispatch/DispatchClient.tsx"), /onUserEditChange/);
});

test("패널: 저장이 끝났을 때 「지금 열린 모달 = 저장한 학생」일 때만 다음 칸으로 옮기거나 닫는다", () => {
  const fn = PANEL.slice(PANEL.indexOf("async function afterSaved"), PANEL.indexOf("function openLeg"));
  assert.match(fn, /const stillHere = targetRef\.current\?\.studentId === studentId;/);
  assert.match(fn, /if \(stillHere\) setTarget\(\{ studentId, legKey: s\.legs\[0\]\.key \}\);/);
  assert.match(fn, /if \(stillHere\) setTarget\(null\);/);
  assert.equal((fn.match(/setTarget\(/g) ?? []).length, 2);
  assert.match(PANEL, /useEffect\(\(\) => \{ targetRef\.current = target; \}, \[target\]\);/);
});
