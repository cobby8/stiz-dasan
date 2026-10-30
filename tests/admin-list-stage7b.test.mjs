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
