// 게슈탈트 디자인 점검(관리자 영역) 적용 약속을 소스 수준에서 못박는다.
// 근접성(위험은 멀리) · 유사성(주인공 하나·위험은 빨강) · 전경과 배경(확인 창) — 되돌아가면 깨진다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const quickMenu = read("../src/components/admin/AdminQuickActionMenu.tsx");

test("C-A1 ⚡ 메뉴: 위험 항목은 구분선 아래로 모이고 학원 위험색을 쓴다", () => {
  assert.match(quickMenu, /export function splitQuickActions/);
  assert.match(quickMenu, /action\.tone !== "danger"/);
  assert.match(quickMenu, /role="separator"/);
  assert.match(quickMenu, /\{danger\.map\(renderAction\)\}/);
  // 일반 항목이 위험 항목보다 먼저 그려진다
  assert.ok(quickMenu.indexOf("{safe.map(renderAction)}") < quickMenu.indexOf("{danger.map(renderAction)}"));
  assert.match(quickMenu, /text-\[var\(--color-academy-danger\)\]/);
  assert.doesNotMatch(quickMenu, /text-red-700|bg-red-50(?!0)/);
});

test("C-A1 ⚡ 메뉴: primary 는 흰 글씨, 항목 44px, 대상 이름 줄, 누르는 영역 44px", () => {
  assert.match(quickMenu, /text-\[var\(--color-academy-on-primary\)\]/);
  assert.doesNotMatch(quickMenu, /bg-brand-neon-lime text-brand-navy-900 shadow-sm hover:brightness-95"/);
  assert.match(quickMenu, /min-h-11/);
  assert.doesNotMatch(quickMenu, /flex h-9 w-full/);
  assert.match(quickMenu, /title=\{label\}>\{label\}<\/p>/);
  // 2026-11-14 원장 점검표 «빠른 작업 버튼은 그대로 아이콘으로 쓰자» — 사이트에서 아이콘을 쓰는 유일한 버튼
  // (36px 원, 누르는 영역은 before 로 사방 4px 넓혀 44px, 색은 중립 — 11-09 원장 «퀵버튼 빨강 보기 싫다» 유지)
  assert.match(quickMenu, /className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-\[var\(--color-academy-line-input\)\][^"]*before:-inset-1/);
  const trigger = quickMenu.slice(quickMenu.indexOf("ref={buttonRef}"), quickMenu.indexOf("{open && ("));
  assert.match(trigger, /<span className="material-symbols-outlined text-xl" aria-hidden="true">\{icon\}<\/span>/);
  assert.doesNotMatch(trigger, /color-academy-danger/, "빠른작업 버튼에 위험색을 쓰지 않는다(11-09)");
  // 메뉴 항목은 글자만 — 아이콘은 트리거 한 곳뿐
  assert.equal((quickMenu.match(/material-symbols-outlined/g) ?? []).length, 1);
  // 위치 계산이 44px 항목·머리줄·구분선을 반영한다
  assert.match(quickMenu, /ACTION_HEIGHT = 48/);
  assert.match(quickMenu, /HEADER_HEIGHT \+ actionCount \* ACTION_HEIGHT/);
  // 열린 동안 그 행 옅은 강조, 닫히면 복원
  assert.match(quickMenu, /row\.style\.backgroundColor = "var\(--color-academy-primary-soft\)"/);
  assert.match(quickMenu, /row\.style\.backgroundColor = previousRowBackground/);
});

const confirmDialog = read("../src/components/admin/AdminConfirmDialog.tsx");
const panelActions = read("../src/components/admin/AdminPanelActions.tsx");

test("C-A2 공용 확인 창: 왼쪽 그만 · 오른쪽 끝 위험색 확정 · 처리 중 닫힘 방지", () => {
  assert.match(confirmDialog, /cancelLabel = "그만"/);
  assert.match(confirmDialog, /className="academy-button-text"/);
  assert.match(confirmDialog, /ml-auto \$\{tone === "danger" \? "academy-button-danger-solid" : "academy-button-primary"\}/);
  assert.match(confirmDialog, /onClose=\{\(\) => \{ if \(!pending\) onCancel\(\); \}\}/);
  assert.match(confirmDialog, /closeOnBackdrop=\{false\}/);
  assert.match(confirmDialog, /export function useAdminConfirm/);
});

test("C-A2 공용 패널 버튼 줄: ⚡ 와 같은 분리 규칙, 위험은 오른쪽 끝", () => {
  assert.match(panelActions, /splitQuickActions\(actions\)/);
  assert.match(panelActions, /tone === "danger"\) return "academy-button-danger"/);
  assert.match(panelActions, /tone === "primary"\) return "academy-button-primary"/);
  assert.match(panelActions, /ml-auto flex flex-wrap gap-2/);
  assert.match(panelActions, /onBeforeSelect\?\.\(\);\s*void action\.onSelect\(\);/);
});

// A-07: window.confirm 삭제 확인 → 공용 확인 창. 확인을 거친 뒤에만 같은 handleDelete(같은 인자)
const deleteConfirmClients = [
  ["../src/app/admin/students/StudentManagementClient.tsx", "s.name", "s.id"],
  ["../src/app/admin/classes/ClassManagementClient.tsx", "cls.name", "cls.id"],
  ["../src/app/admin/finance/FinanceClient.tsx", "p.studentName", "p.id"],
  ["../src/app/admin/coaches/CoachesAdminClient.tsx", "coach.name", "coach.id"],
  ["../src/app/admin/annual/AnnualAdminClient.tsx", "ev.title", "ev.id"],
  ["../src/app/admin/finance/billing/BillingTemplateClient.tsx", "tpl.name", "tpl.id"],
];

test("A-07 삭제 확인은 공용 확인 창으로, 확인 뒤에만 같은 handleDelete", () => {
  for (const [path, nameExpr, idExpr] of deleteConfirmClients) {
    const source = read(path);
    assert.match(source, /const \{ confirm: askConfirm, confirmDialog \} = useAdminConfirm\(\);/, path);
    assert.match(source, /\{confirmDialog\}/, path);
    assert.doesNotMatch(source, /window\.confirm\(`"\$\{[a-z.A-Z]+\}" [^`]*삭제할까요\?`\)/, path);
    const callAt = source.indexOf("askConfirm({ title: `\"${" + nameExpr + "}\"");
    assert.ok(callAt > 0, `${path}: 대상 이름이 들어간 확인 창`);
    const deleteAt = source.indexOf(`void handleDelete(${idExpr});`, callAt);
    assert.ok(deleteAt > callAt && deleteAt - callAt < 300, `${path}: 확인 뒤 같은 handleDelete(${idExpr})`);
  }
});

// A-10: 패널 버튼 줄 복사본 → 공용 AdminPanelActions(같은 작업 목록·같은 패널 닫기)
const panelClients = [
  ["../src/app/admin/withdrawals/WithdrawalsClient.tsx", "buildActions(detail)", "setDetailId(null)"],
  ["../src/app/admin/finance/FinanceClient.tsx", "detailActions", "setDetailPaymentId(null)"],
  ["../src/app/admin/absence/RegularAbsenceAdminClient.tsx", "buildAbsenceActions(d)", "setDetailId(\"\")"],
  ["../src/app/admin/coaches/CoachesAdminClient.tsx", "buildCoachActions(detail)", "setDetailId(null)"],
  ["../src/app/admin/feedback/FeedbackManagementClient.tsx", "buildFeedbackActions(fb)", "setDetailId(null)"],
  ["../src/app/admin/staff/StaffClient.tsx", "buildInvitationActions(detailInvite)", "setDetail(null)"],
  ["../src/app/admin/shuttle/regular/RegularShuttleClient.tsx", "buildRosterActions(d, detail.classTime)", "setDetail(null)"],
  ["../src/app/admin/shuttle/VehicleManagerClient.tsx", "buildVehicleActions(d)", "setDetailId(null)"],
  ["../src/app/admin/makeup/MakeupClient.tsx", "detailActions", "setDetailId(null)"],
];

test("A-10 패널 버튼 줄은 공용 부품 하나로", () => {
  for (const [path, expr, close] of panelClients) {
    const source = read(path);
    assert.ok(source.includes(`<AdminPanelActions actions={${expr}} onBeforeSelect={() => ${close}} />`), path);
    assert.doesNotMatch(source, /\.map\(\(action\) => \(\s*<button/, `${path}: 버튼 줄 복사본이 남았다`);
  }
});

test("A-01 환불은 위험색 + 대상·금액 확인 창 뒤에 «선택 항목 환불»과 같은 runRefund(2026-11-09 PM 결정)", () => {
  const finance = read("../src/app/admin/finance/FinanceClient.tsx");
  const block = finance.slice(finance.indexOf('key: "refund"'), finance.indexOf('key: "delete"'));
  assert.match(block, /tone: "danger" as const/);
  assert.match(block, /원생 \$\{formatAmount\(p\.amount\)\}을 환불 처리할까요\?/);
  // 확인 창이 먼저, 실행은 결제 길별 서버 액션(refundSelectedPayments)을 부르는 runRefund 하나
  assert.ok(block.indexOf("await askConfirm(") >= 0);
  assert.ok(block.indexOf("await askConfirm(") < block.indexOf("void runRefund([p.id])"));
  // 상태 변경으로 환불하던 옛 길(장부만 바뀜)은 다시 쓰지 않는다
  assert.doesNotMatch(finance, /handleStatusChange\([^)]*"REFUNDED"\)/);
  // 확인 모달 버튼 44px·학원 변수색
  assert.match(finance, /className="academy-button-danger-solid ml-auto">\{busy \? "처리 중…" : "청구서 삭제"\}/);
  assert.match(finance, /className="academy-button-primary ml-auto">\{busy \? "처리 중…" : "청구 생성"\}/);
});

test("A-03 탈퇴: 신청 반려가 먼저, 탈퇴 처리는 위험 칸(뒤)", () => {
  const source = read("../src/app/admin/withdrawals/WithdrawalsClient.tsx");
  assert.ok(source.indexOf('key: "reject"') < source.indexOf('key: "approve"'));
  assert.match(source, /<AdminConfirmDialog/);
});

test("A-05 카카오 접수함: 접수 반려는 2x2 칸 밖 아래 줄 위험색", () => {
  const source = read("../src/app/admin/kakao-requests/KakaoRequestsClient.tsx");
  assert.doesNotMatch(source, /\["REJECT","접수 반려"\]/);
  assert.match(source, /onClick=\{\(\) => decide\(row\.id, "REJECT"\)\} className="academy-button-danger">접수 반려<\/button>/);
  assert.match(source, /decide\(row\.id,"TRANSFER"\)/);
});

test("A-06 신청·체험: 따로 만든 메뉴 대신 공용 ⚡ 메뉴, 형광 연두 승인 제거", () => {
  for (const path of ["../src/app/admin/apply/ApplyAdminClient.tsx", "../src/app/admin/trial/TrialCrmClient.tsx"]) {
    const source = read(path);
    assert.match(source, /<AdminQuickActionMenu label=/, path);
    assert.doesNotMatch(source, /LIST_ACTION_PRIMARY_CLASS|bg-lime-500|more_horiz/, path);
  }
});

test("C-A3 상태 배지: 공용 색(학원 변수)으로 통일, 안전한 «다시 불러오기»는 빨강 아님", () => {
  // 2026-11-09 색상 정리: 상태색 지도는 src/lib/ui/statusTones.ts 한 곳, StatusBadge 는 그걸 쓴다(info 추가·모서리 4px)
  const tones = read("../src/lib/ui/statusTones.ts");
  for (const tone of ["warning", "success", "danger", "info", "neutral"]) {
    assert.ok(tones.includes(`bg-[var(--color-academy-${tone}-soft)] text-[var(--color-academy-${tone})]`), tone);
  }
  const badge = read("../src/components/admin/StatusBadge.tsx");
  assert.match(badge, /TONE_BADGE_CLASS\[tone\]/);
  assert.match(badge, /inline-flex items-center gap-1 rounded px-2/, "상태 표시는 모서리 4px(누르는 칩 알약과 구분)");
  const finance = read("../src/app/admin/finance/FinanceClient.tsx");
  assert.match(finance, /PENDING: \{ label: "미납", color: statusToneClass\("warning"\) \}/);
  assert.match(finance, /OVERDUE: \{ label: "연체", color: statusToneClass\("danger"\) \}/);
  const apply = read("../src/app/admin/apply/ApplyAdminClient.tsx");
  assert.match(apply, /REJECTED: \{ label: "반려", color: statusToneClass\("danger"\)/);
  const detail = read("../src/app/admin/students/[id]/StudentDetailClient.tsx");
  assert.match(detail, /PAID: \{ label: "납부완료", color: statusToneClass\("success"\) \}/);
  assert.match(detail, /ABSENT: \{ label: "결석", color: statusToneClass\("danger"\) \}/);
  const requests = read("../src/app/admin/requests/RequestsAdminClient.tsx");
  assert.match(requests, /className="academy-button-secondary mt-4"\s*>\s*다시 불러오기/);
});

test("A-11·A-12 사이드바: 상세 메뉴 3묶음, 아이콘 겹침 해소, 로그아웃 44px", () => {
  const shell = read("../src/app/admin/AdminShellClient.tsx");
  assert.doesNotMatch(shell, /업무별 상세 메뉴/);
  // 2026-11-10 신청함 통합(d2): 옛 «요청·신청함» 묶음은 최상위 «신청함»(/admin/inbox) 하나로
  assert.ok(!shell.includes('label: "요청·신청함"'));
  assert.match(shell, /href="\/admin\/inbox"[^\n]*label="신청함"/);
  const requests = shell.slice(shell.indexOf("const INBOX_LEGACY_PATHS"), shell.indexOf("const EXTRA_GROUPS"));
  for (const href of ["/admin/requests", "/admin/enrollment-changes", "/admin/withdrawals", "/admin/role-requests", "/admin/kakao-requests"]) assert.ok(requests.includes(`"${href}"`), href);
  // 2026-11-13 메뉴 정리: 묶음 3개(수업/홈페이지/설정). 결석·보강·리포트·돈·홈페이지 하위 화면은 탭 줄로
  //   (묶음 내용·탭 연결은 tests/admin-menu-sections.test.mjs)
  const classes = shell.slice(shell.indexOf('label: "수업"'), shell.indexOf('label: "홈페이지"'));
  for (const href of ["/admin/schedule", "/admin/seasonal"]) assert.ok(classes.includes(`"${href}"`), href);
  assert.ok(!shell.includes('label: "돈·수납"'));
  // 같은 기호가 두 메뉴에 붙지 않는다(카카오/문자, 사진 회수/개인정보, 홈페이지 보기/학원 소개)
  // 2026-11-13 원장 «아이콘 빼고 글자 깔끔하게» — 이모지→아이콘 표(NAV_SYMBOLS)를 없애고 메뉴는 글자만 그린다
  assert.doesNotMatch(shell, /NAV_SYMBOLS|material-symbols-outlined/);
  assert.match(shell, /홈페이지 보기/);
  // 2026-11-14 아이콘 완전 제거: 로그아웃은 아이콘 칸(44×44) 대신 글자 버튼 «로그아웃» — 높이 44px(min-h-11)은 그대로
  assert.match(shell, /aria-label="로그아웃" className="academy-button-text academy-button-sm min-h-11!/);
  assert.match(shell, />\s*로그아웃\s*<\/button>/);
  assert.doesNotMatch(shell, /FontFreeIcon/);
});

// 2026-11-13 대시보드·통계 개편: 접힌 «운영 현황»(운영 규모·매출·출석·미납)은 통계 탭으로 옮겼다.
//   대시보드는 맨 위 카드 6개(큰 숫자는 재원생 하나), 통계는 칸마다 제목 + «기준 한 줄».
test("A-14 대시보드·통계: 카드는 묶음마다 제목, 큰 숫자는 주인공 하나, 장식 색 없음", () => {
  const dash = read("../src/app/admin/AdminDashboardClient.tsx");
  const cards = read("../src/components/admin/DashboardSummaryCards.tsx");
  const stats = read("../src/app/admin/stats/StatsClient.tsx");
  assert.doesNotMatch(dash, /운영 현황|상세 데이터 불러오기/);
  assert.match(dash, /<DashboardSummaryCards summary=\{summary\} \/>/);
  for (const title of ["재원생", "이번 달 수강료 수납률", "이번 달 출석률", "이번 달 신규·퇴원", "체험 → 등록 (30일)", "유니폼 보유율"]) {
    assert.ok(cards.includes(`title="${title}"`), title);
  }
  assert.equal((cards.match(/text-3xl/g) ?? []).length, 1, "큰 숫자는 재원생 하나");
  // 옛 운영 현황 내용(운영 규모·매출·미납·프로그램별·최근 7일 신규)은 통계 탭에 있다
  for (const title of ["운영 규모", "매출 추이", "미납 상위", "프로그램별 원생", "최근 7일 신규 원생", "출석률 추이"]) {
    assert.ok(stats.includes(`title="${title}"`) || stats.includes(`title={`), title);
    assert.ok(stats.includes(title), title);
  }
  for (const src of [cards, stats]) assert.doesNotMatch(src, /text-blue-500|text-emerald-500|text-purple-500|#[0-9a-fA-F]{6}/);
});

test("A-15 12px 미만 글자 제거(우선 화면) + 특강 셔틀 취소 44px·위험색", () => {
  for (const path of [
    "../src/app/admin/students/[id]/StudentDetailClient.tsx",
    "../src/app/admin/students/[id]/GuardianPanel.tsx",
    "../src/app/admin/seasonal/shuttle/ShuttleRosterClient.tsx",
    "../src/app/admin/seasonal/SeasonalAdminClient.tsx",
    "../src/app/admin/AdminShellClient.tsx",
    "../src/app/admin/AdminDashboardClient.tsx",
    "../src/app/admin/finance/FinanceClient.tsx",
    "../src/app/admin/trial/TrialCrmClient.tsx",
  ]) {
    assert.doesNotMatch(read(path), /text-\[(9|10|11)px\]/, path);
  }
  const seasonal = read("../src/app/admin/seasonal/SeasonalAdminClient.tsx");
  assert.match(seasonal, /onClick=\{\(\) => toggleRide\(false\)\} className="academy-button-danger">/);
  assert.match(seasonal, /window\.confirm\("이 학생의 셔틀 신청을 취소\(미이용\)할까요\?/);
});
