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
  assert.match(quickMenu, /h-9 w-9[^"]*before:-inset-1/);
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

test("A-01 환불은 위험색 + 대상·금액 확인 창 뒤에 같은 handleStatusChange", () => {
  const finance = read("../src/app/admin/finance/FinanceClient.tsx");
  const block = finance.slice(finance.indexOf('key: "refund"'), finance.indexOf('key: "delete"'));
  assert.match(block, /tone: "danger" as const/);
  assert.match(block, /원생 \$\{formatAmount\(p\.amount\)\}원을 환불 처리할까요\?/);
  assert.ok(block.indexOf("await askConfirm(") < block.indexOf('void handleStatusChange(p.id, "REFUNDED")'));
  // 확인 모달 버튼 44px·학원 변수색
  assert.match(finance, /className="academy-button-danger-solid ml-auto">\{busy \? "처리 중…" : "청구 취소"\}/);
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
  const badge = read("../src/components/admin/StatusBadge.tsx");
  for (const tone of ["warning", "success", "danger"]) {
    assert.ok(badge.includes(`bg-[var(--color-academy-${tone}-soft)] text-[var(--color-academy-${tone})]`), tone);
  }
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
  const requests = shell.slice(shell.indexOf('label: "요청·신청함"'), shell.indexOf('label: "수업 운영"'));
  const classes = shell.slice(shell.indexOf('label: "수업 운영"'), shell.indexOf('label: "돈·수납"'));
  const money = shell.slice(shell.indexOf('label: "돈·수납"'), shell.indexOf('label: "홈페이지·소식"'));
  for (const href of ["/admin/requests", "/admin/enrollment-changes", "/admin/withdrawals", "/admin/role-requests", "/admin/kakao-requests"]) assert.ok(requests.includes(`"${href}"`), href);
  for (const href of ["/admin/absence", "/admin/makeup", "/admin/schedule", "/admin/attendance/report", "/staff/quick-post", "/admin/seasonal"]) assert.ok(classes.includes(`"${href}"`), href);
  for (const href of ["/admin/payment-requests", "/admin/payment-confirmations", "/admin/pos-reconcile", "/admin/uniform"]) assert.ok(money.includes(`"${href}"`), href);
  // 같은 기호가 두 메뉴에 붙지 않는다(카카오/문자, 사진 회수/개인정보, 홈페이지 보기/학원 소개)
  assert.match(shell, /\["\/admin\/kakao-requests", "카카오 접수함", "🗨️"\]/);
  assert.match(shell, /\["\/admin\/media-revocations", "사진 공개 회수", "🚫"\]/);
  assert.match(shell, /label="홈페이지 보기" icon="🌐"/);
  assert.match(shell, /"🗨️": "forum", "🚫": "hide_image", "🌐": "public"/);
  assert.match(shell, /title="로그아웃"\s*aria-label="로그아웃"\s*className="inline-flex h-11 w-11/);
});

test("A-14 대시보드: 카드 두 줄에 소제목, 아이콘 색 muted 통일", () => {
  const dash = read("../src/app/admin/AdminDashboardClient.tsx");
  assert.match(dash, />운영 규모<\/h3>/);
  assert.match(dash, />이번 달 매출·출석·미납<\/h3>/);
  for (const name of ["groups", "menu_book", "person_check", "layers"]) {
    assert.ok(dash.includes(`<SymbolIcon name="${name}" size={20} className="text-[var(--color-academy-muted)]" />`), name);
  }
  // 운영 현황 카드 구역만(백업 상태 아이콘의 의미색은 그대로 둔다)
  const cards = dash.slice(dash.indexOf(">운영 규모</h3>"), dash.indexOf(">이번 달 매출·출석·미납</h3>"));
  assert.doesNotMatch(cards, /text-blue-500|text-emerald-500|text-purple-500/);
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
