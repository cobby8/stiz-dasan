// 관리자 목록 개편 7단계 B묶음(공지·FAQ·후기·프로그램·체육복·갤러리·특강) — 1~6단계와 같은 부품·규칙.
// 지키는 약속: ① 한 줄 행·말줄임 금지 ② 글자 왼쪽/숫자·날짜 오른쪽 ③ 행 클릭 → 상세 패널
//             ④ 행 키보드는 안쪽 버튼을 가로채지 않고, 행 안 버튼 칸은 전파 차단 ⑤ 수정·삭제 등 기존 함수 그대로
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// 목록 표(<table className="admin-list-table ...>) 부분만 잘라 본다(입력 폼의 말줄임에 걸리지 않게)
function listTable(source) {
  const start = source.indexOf('<table className="admin-list-table');
  assert.ok(start >= 0, "공통 목록 표(admin-list-table)가 있어야 합니다");
  const end = source.indexOf("</table>", start);
  return source.slice(start, end);
}

// ── 공지사항 ──
const notices = read("../src/app/admin/notices/NoticesAdminClient.tsx");

test("공지: 한 줄 표(작성일 오른쪽·KST 달력), 말줄임 없음, 본문 미리보기는 표에서 빼고 패널로", () => {
  const table = listTable(notices);
  assert.doesNotMatch(table, /truncate|line-clamp|text-ellipsis/);
  assert.match(table, /admin-cell-num[^"]*">\{toKstYmd\(n\.createdAt\)\}/);
  assert.doesNotMatch(table, /stripHtmlForPreview/);
  assert.match(notices, /from "@\/lib\/datetime\/kst"/);
  assert.doesNotMatch(notices, /toLocaleDateString/);
});

test("공지: 행 클릭 = 상세 패널, 행 키보드 가드, 관리 칸 전파 차단, 수정·삭제·소셜 발행 함수 그대로", () => {
  assert.match(notices, /<ListDetailPanel onClose=\{\(\) => setDetailNoticeId\(null\)\} titleId="notice-detail-panel-title"/);
  assert.match(notices, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(notices, /admin-cell-center px-2 py-1\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(notices, /onClick=\{\(\) => startEdit\(n\)\}/);
  assert.match(notices, /onClick=\{\(\) => handleDelete\(n\.id\)\}/);
  assert.match(notices, /onClick=\{\(\) => setSocialNotice\(n\)\}/);
  // 삭제 확인창 문구·서버 액션 그대로
  assert.match(notices, /confirm\("이 공지사항을 삭제하시겠습니까\?"\)/);
  assert.match(notices, /await deleteNotice\(id\)/);
  // 패널에서도 수정·삭제·소셜 발행 가능
  assert.match(notices, /setDetailNoticeId\(null\); startEdit\(d\);/);
  assert.match(notices, /onClick=\{\(\) => handleDelete\(d\.id\)\}/);
  // 관리 버튼 터치 44px
  assert.match(listTable(notices), /min-h-11 min-w-11/);
});

// ── FAQ ──
const faq = read("../src/app/admin/faq/FaqAdminClient.tsx");

test("FAQ: 한 줄 표(순서·작성일 오른쪽), 답변 미리보기는 표에서 빼고 패널에서 전부", () => {
  const table = listTable(faq);
  assert.doesNotMatch(table, /truncate|line-clamp|text-ellipsis/);
  assert.doesNotMatch(table, /faq\.answer/);
  assert.match(table, /admin-cell-num[^"]*">\{faq\.order\}/);
  assert.match(table, /admin-cell-num[^"]*">\{toKstYmd\(faq\.createdAt\)\}/);
  assert.doesNotMatch(faq, /toLocaleDateString/);
  assert.match(faq, /whitespace-pre-wrap[^"]*">\s*\{detailFaq\.answer\}/);
});

test("FAQ: 공개 칩은 같은 필터 값을 쓰고 바꾸면 패널을 닫는다, 행 클릭 패널·키보드 가드·전파 차단, 수정·삭제 그대로", () => {
  assert.match(faq, /<StatusCountChips[\s\S]*?selected=\{visibilityFilter\}[\s\S]*?setVisibilityFilter\(value\); setDetailFaqId\(null\);[\s\S]*?allValue=\{FAQ_VISIBILITY_ALL\}/);
  assert.match(faq, /<ListDetailPanel onClose=\{\(\) => setDetailFaqId\(null\)\} titleId="faq-detail-panel-title"/);
  assert.match(faq, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(faq, /admin-cell-center px-2 py-1\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(faq, /onClick=\{\(\) => startEdit\(faq\)\}/);
  assert.match(faq, /onClick=\{\(\) => handleDelete\(faq\.id\)\}/);
  assert.match(faq, /confirm\("이 FAQ를 삭제하시겠습니까\?"\)/);
  assert.match(faq, /await deleteFaq\(id\)/);
  assert.match(faq, /const payload = \{ question, answer, order, isPublic \};/);
});

// ── 학부모 후기 ──
const testimonials = read("../src/app/admin/testimonials/TestimonialsAdminClient.tsx");

test("후기: 한 줄 표(순서·별점·작성일 오른쪽), 후기 내용은 표에서 빼고 패널에서 전부", () => {
  const table = listTable(testimonials);
  assert.doesNotMatch(table, /truncate|line-clamp|text-ellipsis/);
  assert.doesNotMatch(table, /t\.text/);
  assert.match(table, /admin-cell-num[^"]*">\{t\.order\}/);
  assert.match(table, /admin-cell-num[^"]*">\{toKstYmd\(t\.createdAt\)\}/);
  assert.doesNotMatch(testimonials, /toLocaleDateString/);
});

test("후기: 순서 변경(위/아래)은 전체 목록 번호로 그대로 — 거르지 않고, 막힘 조건·함수 동일", () => {
  // 목록을 거르면 숨은 후기와 순서가 바뀌므로 표는 전체 testimonials 를 그린다
  assert.match(listTable(testimonials), /\{testimonials\.map\(\(t, idx\) =>/);
  assert.match(testimonials, /onClick=\{\(\) => handleReorder\(idx, "up"\)\}\s*disabled=\{idx === 0 \|\| isPending\}/);
  assert.match(testimonials, /onClick=\{\(\) => handleReorder\(idx, "down"\)\}\s*disabled=\{idx === testimonials\.length - 1 \|\| isPending\}/);
  assert.match(testimonials, /rating: current\.rating, order: target\.order, isPublic: current\.isPublic,/);
  assert.match(testimonials, /rating: target\.rating, order: current\.order, isPublic: target\.isPublic,/);
});

test("후기: 행 클릭 패널·키보드 가드·관리 칸 전파 차단, 수정·삭제·네이버 링크 저장 그대로", () => {
  assert.match(testimonials, /<ListDetailPanel onClose=\{\(\) => setDetailTestimonialId\(null\)\} titleId="testimonial-detail-panel-title"/);
  assert.match(testimonials, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(testimonials, /admin-cell-center px-2 py-1\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(testimonials, /onClick=\{\(\) => startEdit\(t\)\}/);
  assert.match(testimonials, /onClick=\{\(\) => handleDelete\(t\.id\)\}/);
  assert.match(testimonials, /confirm\("이 후기를 삭제하시겠습니까\?"\)/);
  assert.match(testimonials, /await updateNaverPlaceUrl\(naverUrl\)/);
});

// ── 프로그램(관리자 목록만 — 공개 상품 화면·저장 값은 손대지 않는다: 카드사 심사 중) ──
const programs = read("../src/app/admin/programs/ProgramsAdminClient.tsx");

test("프로그램: 드래그 순서 변경은 같은 li·같은 처리기로 그대로, 순서 저장 서버 액션 동일", () => {
  assert.match(programs, /draggable=\{editId !== program\.id\}/);
  assert.match(programs, /onDragStart=\{\(e\) => handleDragStart\(e, program\.id\)\}/);
  assert.match(programs, /onDragOver=\{\(e\) => handleDragOver\(e, program\.id\)\}/);
  assert.match(programs, /onDrop=\{\(e\) => handleDrop\(e, program\.id\)\}/);
  assert.match(programs, /onDragEnd=\{handleDragEnd\}/);
  assert.match(programs, /await reorderPrograms\(next\.map\(\(p\) => p\.id\)\)/);
  // 제자리 수정 폼·삭제 두 단계(확인/취소) 그대로
  assert.match(programs, /<ProgramFormPanel\s+mode="edit"/);
  assert.match(programs, /onSetDeleting=\{\(\) => setDeletingId\(program\.id\)\}/);
  assert.match(programs, /onDelete=\{\(\) => handleDelete\(program\.id\)\}/);
  assert.match(programs, /await deleteProgram\(id\)/);
});

test("프로그램: 한 줄 행(머리줄과 같은 칸 폭), 수강료 오른쪽·tabular, 행 클릭 패널·키보드 가드·관리 칸 전파 차단", () => {
  assert.match(programs, /const PROGRAM_ROW_GRID =/);
  assert.match(programs, /\$\{PROGRAM_ROW_GRID\} items-center bg-\[var\(--color-academy-soft\)\]/);
  assert.match(programs, /text-right font-bold tabular-nums[^"]*">\{priceShortLabel\(program\)\}/);
  assert.match(programs, /<ListDetailPanel onClose=\{\(\) => setDetailProgramId\(null\)\} titleId="program-detail-panel-title"/);
  assert.match(programs, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(programs, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.doesNotMatch(programs, /\btruncate\b|line-clamp|text-ellipsis/);
  // 상세 패널은 기존 카드의 횟수별 가격·셔틀 요금 계산(displayShuttleFee)을 그대로 쓴다
  assert.match(programs, /const fee = displayShuttleFee\(program\.shuttleFeeOverride, t\.key, weekend\)/);
});

// ── 유니폼 주문 ──
const uniform = read("../src/app/admin/uniform/UniformOrdersClient.tsx");

test("유니폼: 상태 칩은 기존 filter 값을 공유(다시 누르면 ALL)하고 바꾸면 패널을 닫는다, 거르는 규칙 그대로", () => {
  assert.match(uniform, /<StatusCountChips[\s\S]*?selected=\{filter\}[\s\S]*?setFilter\(value\); setDetailOrderId\(null\);[\s\S]*?allValue="ALL"/);
  assert.match(uniform, /if \(filter === "SENT"\)[\s\S]*?"SENT" \|\| order\.stizSyncStatus === "DUPLICATE"/);
  assert.match(uniform, /if \(filter === "ACTION"\)[\s\S]*?"NEEDS_REVIEW" \|\| order\.stizSyncStatus === "SETUP_REQUIRED"/);
});

test("유니폼: 한 줄 표(«·» 묶음·두 줄 칸 없음), 접수일 오른쪽·KST, 행 클릭 패널·키보드 가드·전파 차단, 재전송 그대로", () => {
  const table = listTable(uniform);
  assert.doesNotMatch(table, /summarizeItems|truncate|line-clamp/);
  assert.doesNotMatch(table, /<p /);
  assert.match(table, /admin-cell-num[^"]*">\{formatDateTime\(order\.createdAt\)\}/);
  assert.match(uniform, /return formatKstDate\(value,/);
  assert.match(uniform, /<ListDetailPanel onClose=\{\(\) => setDetailOrderId\(null\)\} titleId="uniform-detail-panel-title"/);
  assert.match(uniform, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(uniform, /admin-cell-center px-2 py-1\.5" onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(uniform, /onClick=\{\(\) => handleRetry\(order\)\}\s*disabled=\{isPending \|\| busyId === order\.id\}/);
  assert.match(uniform, /await retryUniformOrderDispatch\(order\.id\)/);
  assert.match(uniform, /STIZ 본사로 다시 전송할까요\?/);
});
