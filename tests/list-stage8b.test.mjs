// 목록 개편 8단계 B — 학부모 마이페이지 목록(휴대폰 390px · 앱 웹뷰).
// 지키는 약속: ① 한 줄 행(44~56px)·«·»로 이어 붙인 글을 요소로 나눔·말줄임 금지
//             ② 숫자·날짜 오른쪽 + tabular-nums ③ 상태 칩(목록과 같은 판정) ④ 날짜 중요한 목록은 날짜 묶음(KST 모듈만)
//             ⑤ 터치 44px ⑥ 제출 동작(신청·취소·신고·예약)과 확인 단계는 그대로
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8");

// TSX 를 실제로 렌더해 본다(날짜 묶음은 눈으로 읽어서는 하루 밀림을 못 잡는다)
function compileModule(path, imports = {}) {
  const compiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Intl, Date, Number, Math, require: (name) => name in imports ? imports[name] : require(name) });
  return module.exports;
}
const Link = ({ children, ...props }) => React.createElement("a", props, children);
const kst = compileModule("src/lib/datetime/kst.ts");
const chips = compileModule("src/components/admin/list/StatusCountChips.tsx");

test("출결 히스토리는 KST 날짜로 달별 묶음·오른쪽 날짜·상태 칩을 보이고 수납 탭은 손대지 않는다", () => {
  const History = compileModule("src/app/mypage/history/HistoryClient.tsx", {
    "next/link": { default: Link },
    "@/components/admin/list/StatusCountChips": chips,
    "@/lib/datetime/kst": kst,
  }).default;
  const html = renderToStaticMarkup(React.createElement(History, { children: [{
    id: "c1", name: "합성 학생",
    attendance: { total: 3, present: 2, absent: 1, late: 0, rate: 67, records: [
      // KST 10/1 00:00 = UTC 9/30 15:00 — toISOString 이면 9/30 으로 하루 밀린다
      { status: "PRESENT", date: "2026-09-30T15:00:00.000Z", className: "초등 저학년반" },
      { status: "ABSENT", date: "2026-09-29T15:00:00.000Z", className: "초등 저학년반" },
      { status: "PRESENT", date: "2026-08-31T15:00:00.000Z", className: null },
    ] },
    payments: [],
  }] }));
  assert.match(html, /2026년 10월/);
  assert.match(html, /2026년 9월/);
  assert.match(html, /10\/1\(목\)/);
  assert.match(html, /9\/30\(수\)/);
  assert.match(html, /9\/1\(화\)/);
  assert.doesNotMatch(html, /2026-09-30/, "옛 UTC 날짜 문자열이 남으면 안 된다");
  assert.match(html, /출석률 <span class="tabular-nums">67%/);
  assert.match(html, /aria-label="출결 상태별 건수"/);
  assert.match(html, /aria-pressed="false"[^>]*>출석<span class="tabular-nums[^"]*">2<\/span>/);

  const source = read("src/app/mypage/history/HistoryClient.tsx");
  assert.match(source, /min-h-11 items-center gap-2 px-3 py-2/);
  assert.match(source, /shrink-0 text-right text-sm tabular-nums/);
  // 수납(결제 심사 중) 부분은 그대로 — 납부·청구서·영수증 링크와 판정식 보존
  assert.match(source, /const canPay = p\.canCheckout !== false && Boolean\(p\.invoiceId\) && \(p\.status === "PENDING" \|\| p\.status === "OVERDUE"\);/);
  assert.match(source, /href=\{`\/payments\/\$\{p\.invoiceId\}`\}/);
  assert.match(source, /<p className="text-xs text-gray-400">기한: \{toDateStr\(p\.dueDate\)\}<\/p>/);
});
