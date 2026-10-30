// 목록 개편 8단계 A(선생님 앱) — 휴대폰(390px) 기준으로 관리자 목록 규칙을 적용한다.
// 지키는 약속: ① 한 줄 행·말줄임 금지 ② 숫자·시간 오른쪽 tabular-nums ③ 행 탭 → 하단 시트(ListDetailPanel)
//             ④ 행 키보드는 안쪽 버튼을 가로채지 않고, 행 안 버튼은 전파 차단 ⑤ 입력·진행 동작은 그대로
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const studentsClient = read("../src/app/staff/students/StaffStudentsClient.tsx");

test("선생님 학생 연락: 한 줄 행 + 시트, 학부모 전화는 행에서 바로(전파 차단), 연락 버튼은 시트에 그대로", () => {
  assert.match(studentsClient, /<ListDetailPanel onClose=\{\(\) => setDetailId\(null\)\} titleId="staff-student-detail-title"/);
  assert.match(studentsClient, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(studentsClient, /href=\{`tel:\$\{student\.parentPhone\}`\}[\s\S]*?onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  // 기존 연락 기능(학생·학부모 전화·문자)은 시트에서 그대로
  assert.match(studentsClient, /<ContactActions label="학생" name=\{detail\.name\} phone=\{detail\.studentPhone\} \/>/);
  assert.match(studentsClient, /<ContactActions label="학부모" name=\{detail\.parentName\} phone=\{detail\.parentPhone\} accent \/>/);
  assert.match(studentsClient, /href=\{`sms:\$\{phone\}`\}/);
  // 검색 범위는 그대로(학생·학부모·학교·학년·전화·반)
  assert.match(studentsClient, /\[student\.name, student\.parentName, student\.school, student\.grade, student\.studentPhone, student\.parentPhone, \.\.\.student\.classNames\]/);
  assert.doesNotMatch(studentsClient, /\btruncate\b|text-ellipsis|line-clamp/);
});

const billingClient = read("../src/app/staff/billing/StaffBillingClient.tsx");

test("선생님 청구: 상태 칩이 기존 filter 를 공유(기본 미납)·한 줄 행·시트, 납부 확인 요청 흐름은 그대로", () => {
  assert.match(billingClient, /<StatusCountChips items=\{chipItems\} selected=\{filter\} onSelect=\{\(value\) => setFilter\(value as BillFilter\)\} allValue="OPEN"/);
  assert.match(billingClient, /useState<BillFilter>\("OPEN"\)/);
  assert.match(billingClient, /const OPEN_STATUSES = \["PENDING", "OVERDUE"\]/);
  assert.match(billingClient, /<ListDetailPanel onClose=\{\(\) => setDetailId\(null\)\} titleId="staff-bill-detail-title"/);
  assert.match(billingClient, /function handleRowKeyDown[\s\S]*?if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(billingClient, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); openRequest\(bill\); \}\}/);
  // 금액은 오른쪽·tabular-nums, 납부 기한은 KST 모듈로
  assert.match(billingClient, /text-right font-black tabular-nums/);
  assert.match(billingClient, /formatKstDate\(detail\.dueDate/);
  // 요청 버튼 조건·대기·막힌 사유·서버 호출은 기존 그대로
  assert.match(billingClient, /bill\.confirmationStatus !== "PENDING" && OPEN_STATUSES\.includes\(bill\.status\) && bill\.confirmable/);
  assert.match(billingClient, /관리자 확인 대기 중/);
  assert.match(billingClient, /\{detail\.blockReason\}/);
  assert.match(billingClient, /requestStaffPaymentConfirmation\(\{\s*paymentId: target\.id,\s*method,/);
  assert.match(billingClient, /청구서에는 \{detail\.invoiceAmount\.toLocaleString\("ko-KR"\)\}원으로 되어 있습니다/);
  assert.doesNotMatch(billingClient, /\btruncate\b|text-ellipsis|line-clamp/);
});
