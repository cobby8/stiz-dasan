// 학부모 «한 번에 결제»(묶음 결제) 화면 갈래 C (2026-11-09 원장 결정 D2·D3·D4·D5) — 실제로 그려서 확인한다.
//  ① 묶음 결제 화면: 결제 가능한 청구 기본 전부 체크, 막힌 청구는 체크 불가 + 이유, 합계·건수, 상한 초과 안내
//  ② 토스 결제창 호출: 서버가 준 금액·면세 금액·돌아올 주소를 그대로(면세 빠지면 결제 안 함), 열린 계좌 충돌 확인
//  ③ 완료 화면 상태 판정(성공·입금 대기·확인 중·실패) + 납부 내역 확인이 필요한 막힘 코드
//  ④ 홈·청구 탭 진입, 단건 화면 KST 날짜·묶음 계좌 안내, 공지 대상 반 공용 파서, 옛 홈 해시
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : require(name);
  module._compile(compiled, absolute);
  return module.exports;
}
const link = { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
const kst = load("src/lib/datetime/kst.ts");
const statusTones = load("src/lib/ui/statusTones.ts"); // 상태색 공용 지도(청구 탭 상태 글자)
const taxFree = load("src/lib/payments/taxFree.ts");
const virtualAccount = load("src/lib/payments/virtualAccount.ts", { "@/lib/payments/taxFree": taxFree, "@/lib/datetime/kst": kst });
const preferredMethod = load("src/lib/payments/preferredMethod.ts");
const picker = load("src/components/parent/PaymentMethodPicker.tsx", { "@/lib/payments/preferredMethod": preferredMethod });
const vaNotice = { __esModule: true, default: ({ account }) => React.createElement("p", null, `계좌 ${account.accountNumber} ${account.amount}`) };

const Checkout = load("src/app/mypage/payments/checkout/BundleCheckoutClient.tsx", {
  "next/link": link,
  "next/navigation": { useRouter: () => ({ refresh() {} }) },
  "@/components/parent/VirtualAccountNotice": vaNotice,
  "@/lib/datetime/kst": kst,
  "@/lib/payments/virtualAccount": virtualAccount,
  "@/components/parent/PaymentMethodPicker": picker,
  "@/lib/payments/preferredMethod": preferredMethod,
}).default;
const item = (id, extra = {}) => ({ paymentId: id, invoiceId: `i-${id}`, studentId: "s1", studentName: "합성 첫째", title: `${id} 수강료`, amount: 100000, paymentStatus: "PENDING", selectable: true, blockCode: null, blockReason: null, pendingDeposit: false, ...extra });
const render = (props) => renderToStaticMarkup(React.createElement(Checkout, { maxItems: 10, maxTotal: 1_000_000, onlineReady: true, bankAccount: "합성은행 000111", ...props }));

test("① 결제 가능한 청구는 기본 전부 체크, 막힌 청구(대표 보호자 아님·랠리즈)는 체크 불가 + 이유", () => {
  const html = render({ items: [
    item("p1"),
    item("p2", { studentName: "합성 둘째", amount: 50000 }),
    item("p3", { selectable: false, blockCode: "RALLYZ_MIRROR", blockReason: "랠리즈로 안내된 청구는 랠리즈 앱에서 결제해 주세요." }),
  ] });
  // 체크박스 3개 중 2개만 체크, 막힌 1개는 disabled
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.equal((html.match(/checked=""/g) || []).length, 2, "D3 기본 전부 체크(결제 가능한 것만)");
  assert.equal((html.match(/disabled=""[^>]*type="checkbox"|type="checkbox"[^>]*disabled=""/g) || []).length, 1);
  assert.match(html, /랠리즈 앱에서 결제해 주세요/, "D4 막힌 이유를 그 줄에");
  assert.match(html, /합성 둘째<\/span>p2 수강료/, "D2 형제 청구도 한 목록");
  assert.match(html, /선택 <span class="tabular-nums">2<\/span>건/);
  // 결제 방법 바로가기(2026-11-13): 지난번 방법이 없으면 큰 버튼 없이 버튼 줄 + 합계
  assert.match(html, /결제 방법을 눌러 주세요 · 150,000원/);
  assert.match(html, /role="group" aria-label="결제 방식"/);
  for (const label of ["토스페이", "카카오페이", "네이버페이", "카드", "계좌이체", "무통장입금"]) assert.ok(html.includes(label), label);
  assert.match(html, /이미 계좌로 입금했어요 \(2건\)/, "입금 알림도 고른 청구 묶음으로");
  assert.match(html, /합성은행 000111/);
  assert.doesNotMatch(html, /한 번에 10건/, "상한 안이면 안내 없음");
});

test("① 상한(D5 10건·100만 원)을 넘으면 결제 버튼을 막고 나눠 내라고 안내", () => {
  const over = render({ items: [item("p1", { amount: 600000 }), item("p2", { amount: 500000 })] });
  assert.match(over, /한 번에 10건·1,000,000원까지 결제할 수 있어요/);
  assert.match(over, /결제 방법을 눌러 주세요 · 1,100,000원/);
  assert.equal((over.match(/<button[^>]*disabled=""[^>]*><span class="material-symbols-outlined/g) || []).length, 6, "결제 방법 버튼 6개 모두 막힘");
  const many = render({ items: Array.from({ length: 11 }, (_, i) => item(`p${i}`, { amount: 1000 })) });
  assert.match(many, /한 번에 10건/);
});

test("① 고를 수 있는 청구가 없거나 온라인 결제가 꺼져 있으면 그에 맞게 안내", () => {
  const none = render({ items: [item("p1", { selectable: false, blockCode: "NOT_PAYER", blockReason: "결제는 대표 보호자 계정에서만 할 수 있어요." })] });
  assert.match(none, /결제할 수 있는 청구가 없어요/);
  assert.doesNotMatch(none, /aria-label="결제 방식"/);
  const offline = render({ items: [item("p1")], onlineReady: false });
  assert.match(offline, /지금은 온라인 결제를 쓸 수 없어요/);
  assert.doesNotMatch(offline, /aria-label="결제 방식"/);
  assert.match(offline, /class="academy-button-primary[^"]*"[^>]*>이미 계좌로 입금했어요/, "온라인이 꺼지면 입금 알림이 주 버튼");
  const failed = render({ items: [item("p1")], failed: true, failMessage: "결제를 취소했어요." });
  assert.match(failed, /결제를 취소했어요\. 돈은 빠져나가지 않았어요\./);
  assert.match(render({ items: [] }), /납부할 청구가 없어요/);
});

test("② 토스 결제창: 단건과 같은 SDK·서버가 준 금액·면세 금액·돌아올 주소, 충돌은 확인 후 closeOpenVirtualAccount", () => {
  const src = read("src/app/mypage/payments/checkout/BundleCheckoutClient.tsx");
  assert.match(src, /https:\/\/js\.tosspayments\.com\/v2\/standard/);
  assert.match(src, /script\[data-toss-payments\]/, "단건 화면이 넣은 스크립트를 다시 넣지 않는다");
  const call = src.slice(src.indexOf("requestPayment({"));
  assert.match(call, /value: data\.amount\b/);
  assert.match(call, /taxFreeAmount: data\.taxFreeAmount\b/, "면세 = 서버가 항목별로 더한 값(복합과세 상점)");
  assert.match(call, /successUrl: data\.successUrl/);
  assert.match(call, /failUrl: data\.failUrl/);
  assert.match(src, /typeof data\.taxFreeAmount !== "number"/, "면세 금액이 없으면 결제창을 열지 않는다");
  assert.match(src, /fetch\("\/api\/mypage\/payments\/checkout"/);
  assert.match(src, /JSON\.stringify\(\{ paymentIds: picked\.map\(\(item\) => item\.paymentId\), method: serverMethodFor\(chosen\), closeOpenVirtualAccount \}\)/);
  assert.match(src, /if \(data\.openVirtualAccountConflict\)/);
  assert.match(src, /Array\.isArray\(data\.openVirtualAccounts\) \? data\.openVirtualAccounts : \[\]/, "빈 계좌 목록(OPEN_DEPOSIT_EXISTS)도 깨지지 않게");
  assert.match(src, /role="alertdialog"/);
  assert.match(src, /onClick=\{\(\) => void startPayment\(true\)\}/, "계좌 닫기는 확인 창의 버튼에서만");
  assert.match(src, /action: "submit-bundle"/);
  // 서버 계약: 돌아올 주소는 설치 앱 범위(/mypage) 안
  const ledger = read("src/lib/payment-ledger.ts");
  assert.match(ledger, /new URL\("\/mypage\/payments\/done", cleanOrigin\)/);
  assert.match(ledger, /new URL\("\/mypage\/payments\/checkout\?result=fail", cleanOrigin\)/);
});

test("③ 완료 화면 상태: 장부가 정본(DONE=성공), 입금 대기 계좌, 확인 중, 실패", () => {
  const { decideDoneState } = load("src/app/mypage/payments/done/BundleDoneClient.tsx", {
    "next/link": link, "@/components/parent/VirtualAccountNotice": vaNotice,
    "@/lib/payments/checkoutBundle": load("src/lib/payments/checkoutBundle.ts", { "./taxFree": taxFree, "@/lib/pos/charge-request.mjs": require(resolve("src/lib/pos/charge-request.mjs")) }),
  });
  const order = (status, extra = {}) => ({ orderId: "o", status, amount: 1, receiptUrl: null, virtualAccount: null, items: [{ paymentStatus: "PENDING" }], ...extra });
  assert.equal(decideDoneState({ ok: false, retryable: false, order: order("DONE") }), "success", "승인 응답이 실패여도 주문이 끝났으면 성공");
  assert.equal(decideDoneState({ ok: true, retryable: false, order: order("WAITING_FOR_DEPOSIT", { virtualAccount: { expired: false } }) }), "deposit");
  assert.equal(decideDoneState({ ok: false, retryable: true, order: order("IN_PROGRESS") }), "pending");
  assert.equal(decideDoneState({ ok: false, retryable: false, order: order("FAILED") }), "error");
  assert.equal(decideDoneState({ ok: true, retryable: false, order: order("READY", { items: [{ paymentStatus: "PAID" }] }) }), "success", "묶인 청구가 전부 납부면 성공");
  const src = read("src/app/mypage/payments/done/BundleDoneClient.tsx");
  assert.match(src, /new Set\(\["CONFIRM_IN_PROGRESS", "OPEN_DEPOSIT_EXISTS", "NOT_UNPAID"\]\)/, "다른 결제 진행 중 등은 새 결제 대신 납부 내역 확인");
  assert.match(src, /BUNDLE_BLOCK_MESSAGE\[code as BundleBlockCode\]/);
  assert.match(src, /fetch\("\/api\/mypage\/payments\/confirm"/);
  assert.match(src, /confirm\?orderId=\$\{encodeURIComponent\(orderId\)\}/, "새로고침은 조회만");
  assert.match(src, /order\.receiptUrl/);
});

test("④ 청구 탭: 대표 보호자 미납이 있으면 «한 번에 결제» 진입, 묶음 계좌면 합계 안내", () => {
  const Client = load("src/app/mypage/payments/PaymentRequestClient.tsx", {
    "@/lib/ui/statusTones": statusTones,
    "next/link": link, "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/payments/parentRequestRules": load("src/lib/payments/parentRequestRules.ts"),
    "@/components/parent/VirtualAccountNotice": vaNotice,
  }).default;
  const row = (id, extra = {}) => ({ paymentId: id, studentId: "s", studentName: "합성", description: "11월 수강료", amount: 100000, status: "PENDING", dueDate: null, paidDate: null, invoiceNo: null, invoiceId: `i-${id}`, canCheckout: true, receiptUrl: null, virtualAccount: null, pending: [], resolved: [], ...extra });
  const va = { bankName: "합성은행", accountNumber: "777", customerName: null, amount: 250000, dueDate: "2026-11-20", dueLabel: "", expired: false };
  const html = renderToStaticMarkup(React.createElement(Client, { payReady: true, rows: [row("a", { virtualAccount: va }), row("b", { amount: 150000, virtualAccount: va }), row("c", { status: "PAID" })] }));
  assert.match(html, /미납 <span class="tabular-nums">2<\/span>건/);
  assert.match(html, /합계 250,000원/);
  assert.match(html, /href="\/mypage\/payments\/checkout"[^>]*>한 번에 결제/);
  assert.match(html, /여러 청구를 묶은 계좌 · 합계 250,000원/);
  assert.match(html, /href="\/payments\/i-a"/, "기존 단건 결제 버튼도 그대로");
  const family = renderToStaticMarkup(React.createElement(Client, { payReady: true, rows: [row("a", { canCheckout: false })] }));
  assert.doesNotMatch(family, /한 번에 결제/, "연결 가족은 진입 없음");
});

test("④ 홈 합계는 청구 탭과 같은 목록, 단건 결제 화면은 KST 날짜 + 묶음 계좌 안내", () => {
  const page = read("src/app/mypage/page.tsx");
  assert.match(page, /getParentPaymentRequests\(parentAuth\.appUserId\)\.catch\(\(\) => null\)/);
  assert.match(page, /pendingPayments=\{pendingPayments\}/);
  const rows = read("src/lib/payments/parent-payment-request.ts");
  assert.match(rows, /\$\{txCoversPaymentSql\("t", "p\.id"\)\}/, "묶음 계좌도 본다");
  assert.match(rows, /virtualAccount: row\.canCheckout === true \? parentVirtualAccountView/, "계좌는 대표 보호자에게만");
  assert.doesNotMatch(rows.slice(rows.indexOf("const PARENT_VA_LATERAL"), rows.indexOf(") va ON true")), /depositSecretHash/);
  const single = read("src/app/payments/[invoiceId]/page.tsx");
  assert.match(single, /return formatKstDate\(value, undefined, "-"\)/);
  assert.doesNotMatch(single, /\.toLocaleDateString\(/);
  assert.match(single, /virtualAccount\.amount !== Number\(invoice\.amount\)/);
  assert.match(single, /여러 청구를 묶은 계좌 · 합계/);
  assert.match(single, /<PaymentCheckoutClient/, "단건 결제 흐름은 그대로");
});

test("④ 공지 대상 반: 쉼표 문자열·JSON 배열 둘 다 읽는 공용 파서를 학부모·관리자가 같이 쓴다", () => {
  const { parseNoticeTargetClassIds } = load("src/lib/noticeTargets.ts");
  assert.deepEqual(parseNoticeTargetClassIds("k1, k2"), ["k1", "k2"]);
  assert.deepEqual(parseNoticeTargetClassIds('["k1","k2"]'), ["k1", "k2"], "선생님 반 공지(staff-notices.ts)");
  assert.deepEqual(parseNoticeTargetClassIds('["k1"'), ["k1"], "깨진 JSON 도 쉼표 규칙으로");
  assert.deepEqual(parseNoticeTargetClassIds(null), []);
  assert.deepEqual(parseNoticeTargetClassIds(""), []);
  for (const file of ["src/lib/queries.ts", "src/app/mypage/news/[id]/page.tsx", "src/app/admin/notices/NoticesAdminClient.tsx"]) {
    assert.match(read(file), /parseNoticeTargetClassIds\(/, file);
  }
  assert.match(read("src/app/actions/staff-notices.ts"), /JSON\.stringify\(\[classId\]\)/, "쓰는 쪽 모양은 그대로");
});

test("④ 옛 홈 해시는 옮겨 간 탭으로", () => {
  const { legacyHomeHashTarget } = load("src/lib/mypage/summary.ts");
  assert.equal(legacyHomeHashTarget("#mypage-shuttle"), "/mypage/history#mypage-shuttle");
  assert.equal(legacyHomeHashTarget("mypage-enrollments"), "/mypage/history#mypage-enrollments");
  // 옛 «결석·보강» 칸 주소는 결석 신고 화면으로(일정 탭에서 신청 줄을 뺐다, 2026-11-09)
  assert.equal(legacyHomeHashTarget("parent-absence-hub"), "/mypage/regular-absence");
  assert.equal(legacyHomeHashTarget("mypage-feedback"), "/mypage/reports#news-feedback");
  assert.equal(legacyHomeHashTarget("mypage-notifications"), null, "알림은 홈에 그대로");
  assert.equal(legacyHomeHashTarget("constructor"), null);
  assert.match(read("src/app/mypage/MyPageClient.tsx"), /const moved = legacyHomeHashTarget\(id\);\s*if \(moved\) \{\s*window\.location\.replace\(moved\);/);
});

test("④ 학부모 «납부 신청» 승인은 MANUAL 로 표시 — 옛 토스 묶음 주문의 전액 취소가 이 청구를 환불하지 않게", () => {
  const src = read("src/lib/payments/admin-payment-request.ts");
  const call = src.slice(src.indexOf("await markPaymentPaid({"), src.indexOf("});", src.indexOf("await markPaymentPaid({")));
  assert.match(call, /provider: "MANUAL"/);
  // 묶음 전액 취소는 TOSS + 그 주문 번호로 낸 청구만 환불한다 — MANUAL 이면 조건에서 빠진다
  assert.match(read("src/lib/payments/bundleLedger.ts"), /status = 'PAID' AND "paidProvider" = 'TOSS' AND "providerOrderId" = \$2/);
  // markPaymentPaid 는 provider 를 paidProvider 에 그대로 쓴다(COALESCE 라 넘기지 않으면 옛 TOSS 가 남는다)
  assert.match(read("src/lib/payment-ledger.ts"), /"paidProvider" = COALESCE\(\$3, "paidProvider"\)/);
});

// ── 2026-11-09 리뷰 권장 반영 ──
test("⑤ 결제창 전 금액 재확인·상한이면 입금 알림도 막음·뒤로 복귀 시 로딩 해제·확인 창 닫기·말투 «~요»", () => {
  const src = read("src/app/mypage/payments/checkout/BundleCheckoutClient.tsx");
  const start = src.slice(src.indexOf("async function startPayment"), src.indexOf("async function submitClaim"));
  assert.match(start, /if \(data\.amount !== total\) \{\s*setError\(AMOUNT_CHANGED_MESSAGE\);\s*router\.refresh\(\);\s*return;/);
  assert.ok(start.indexOf("data.amount !== total") < start.indexOf("requestPayment("), "금액 확인은 결제창보다 먼저");
  assert.ok(start.lastIndexOf("setConflict(null);") < start.indexOf("requestPayment("), "결제창 열기 전에 확인 창을 닫는다");
  assert.match(src, /const AMOUNT_CHANGED_MESSAGE = "금액이 바뀌었어요\. 다시 확인해 주세요\.";/);
  assert.match(src, /결제 금액을 확인하지 못했어요\. 학원으로 문의해 주세요\./);
  assert.match(src, /if \(sending\.current \|\| picked\.length === 0 \|\| !paidOn \|\| overLimit\) return;/);
  assert.match(src, /addEventListener\("pageshow", onPageShow\)/);
  assert.match(src, /if \(!event\.persisted\) return;\s*sending\.current = false;\s*setLoading\(false\);/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /습니다/, "학부모 화면 말투는 «~해요»");
  // 상한을 넘으면 «이미 계좌로 입금했어요»도 눌리지 않는다
  const over = render({ items: [item("p1", { amount: 600000 }), item("p2", { amount: 500000 })] });
  assert.match(over, /<button[^>]*disabled=""[^>]*>이미 계좌로 입금했어요/);
});

test("⑤ 토스 실패 안내는 코드별 정해진 문장만(주소 글은 그대로 비추지 않는다)", () => {
  const { tossFailMessage, TOSS_FAIL_DEFAULT_MESSAGE } = load("src/lib/payments/tossFailMessage.ts");
  assert.equal(tossFailMessage("PAY_PROCESS_CANCELED"), "결제를 취소했어요.");
  assert.match(tossFailMessage("REJECT_CARD_COMPANY"), /카드사에서 결제를 거절했어요/);
  assert.equal(tossFailMessage("<script>"), TOSS_FAIL_DEFAULT_MESSAGE);
  assert.equal(tossFailMessage(""), TOSS_FAIL_DEFAULT_MESSAGE);
  assert.equal(tossFailMessage("constructor"), TOSS_FAIL_DEFAULT_MESSAGE);
  const page = read("src/app/mypage/payments/checkout/page.tsx");
  assert.match(page, /tossFailMessage\(pick\("code"\)\)/);
  assert.doesNotMatch(page, /pick\("message"\)/, "주소의 message 는 쓰지 않는다");
});

test("⑤ 홈 버튼 이름은 대표 보호자로 결제할 수 있는 건 수 기준(합계는 전체)", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /const payableCount = summarizePendingPayments\(\[\{ payments: payList\.filter\(\(p\) => p\.canCheckout !== false\) \}\]\)\.count;/);
  assert.match(home, /payableCount > 1 \? "한 번에 결제" : "결제하기"/);
});

test("⑤ 선생님 공지 재발송 확인은 대상 반 두 모양(JSON 배열·쉼표 한 반)을 모두 찾는다", () => {
  const src = read("src/app/actions/staff-notices.ts");
  const fn = src.slice(src.indexOf("async function findOwnedNotice"), src.indexOf("async function readNoticeDeliveryStatus"));
  assert.match(fn, /"targetClassIds" IN \(\$3,\$4\)/);
  assert.match(fn, /JSON\.stringify\(\[classId\]\), classId,/);
});
