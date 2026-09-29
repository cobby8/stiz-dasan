import assert from "node:assert/strict";
import test from "node:test";

// 이 테스트는 순수 모듈을 **실제로 실행**한다(문자열 검사로 흉내내지 않는다).
// 돈을 맞추는 규칙이라 "애매하면 보류(HELD)" 가 지켜지는지가 핵심 검증 대상이다.
import {
  CATEGORY,
  addDays,
  assertReadOnlyTossRequest,
  attachStudentResolution,
  buildReconciliation,
  classifyBranch,
  cleanMemoFragment,
  dayDiff,
  flattenTossOrders,
  formatWon,
  isValidMonth,
  matchSets,
  monthRange,
  normalizeSiteRow,
  parseMemoNames,
  redactSecrets,
  resolveStudentName,
  renderCsv,
  renderMarkdown,
  summarize,
  toKst,
} from "../src/lib/pos/tossplace-match.mjs";

// ───────────── 테스트용 행 만들기 ─────────────

let siteSeq = 0;
function siteRow({ date, amount, id, status = "PAID", providerOrderId = "", time = "14:00:00", name = "홍길동", branch = "2호점 : 다산" }) {
  siteSeq += 1;
  return normalizeSiteRow({
    id: id ?? `site-${String(siteSeq).padStart(3, "0")}`,
    amount,
    status,
    method: "CARD",
    paidProvider: "TOSS_TERMINAL",
    providerOrderId,
    providerPaymentKey: "",
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    description: "월 수강료",
    studentName: name,
    branch,
    mergedIntoStudentId: null,
    kstDateTimeRaw: `${date} ${time}.000`,
  });
}

let tossSeq = 0;
function tossOrder({ date, amount, orderId, state = "APPROVED", sourceType = "CARD", time = "05:00:00", memo = "", orderMemo = "" }) {
  tossSeq += 1;
  const id = orderId ?? `order-${String(tossSeq).padStart(3, "0")}`;
  // 토스는 UTC(Z) 로 준다 → date/time 은 UTC 기준으로 넣는다.
  return {
    id,
    orderState: state === "CANCELLED" ? "CANCELLED" : "COMPLETED",
    source: "POS",
    createdAt: `${date}T${time}Z`,
    memo: orderMemo,
    lineItems: [{ item: { title: "수강료" }, quantity: 1, memo }],
    chargePrice: { totalAmount: amount },
    payments: [
      {
        id: `pay-${id}`,
        orderId: id,
        state,
        sourceType,
        amount,
        approvedNo: "09201410",
        van: "DAOU",
        approvedAt: `${date}T${time}Z`,
        cancelledAt: state === "CANCELLED" ? `${date}T${time}Z` : null,
        cardDetails: { cardType: "CREDIT", cardNo: "94104****1234", installmentMonth: 0, approvalNo: "09201410" },
        settlement: { status: "PENDING" },
        bundle: null,
      },
    ],
  };
}

function tossRows(orders) {
  const { rows } = flattenTossOrders(orders, { naiveTz: "KST" });
  return rows;
}

// ───────────── 날짜·시간대 ─────────────

test("월 형식 검증", () => {
  assert.equal(isValidMonth("2026-09"), true);
  assert.equal(isValidMonth("2026-13"), false);
  assert.equal(isValidMonth("2026-9"), false);
  assert.equal(isValidMonth("202609"), false);
});

test("월 범위와 날짜 계산은 시간대 영향을 받지 않는다", () => {
  const r = monthRange("2026-09");
  assert.equal(r.first, "2026-09-01");
  assert.equal(r.last, "2026-09-30");
  assert.equal(r.bufferFrom, "2026-08-29");
  assert.equal(r.bufferTo, "2026-10-03");
  assert.equal(r.fetchFromIso, "2026-08-29T00:00:00+09:00");
  assert.equal(r.fetchToIso, "2026-10-04T00:00:00+09:00");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01"); // 2026년은 평년
  assert.equal(addDays("2024-02-28", 1), "2024-02-29"); // 윤년
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(dayDiff("2026-09-03", "2026-09-01"), 2);
  assert.equal(monthRange("2026-02").last, "2026-02-28");
});

test("UTC(Z) 시각을 KST 로 바꾼다 — 실제 응답 형식", () => {
  // 2026-09-18 실측: 토스 응답은 UTC(Z) 표기
  const morning = toKst("2026-09-01T06:11:52Z");
  assert.equal(morning.kstDate, "2026-09-01");
  assert.equal(morning.kstDateTime, "2026-09-01 15:11:52");
  assert.equal(morning.assumed, false);

  // 자정 경계: UTC 늦은 저녁 = KST 다음 날
  const late = toKst("2026-09-01T15:30:00Z");
  assert.equal(late.kstDate, "2026-09-02");
  assert.equal(late.kstDateTime, "2026-09-02 00:30:00");

  // 오프셋이 명시된 경우도 그대로 해석
  assert.equal(toKst("2026-09-01T00:00:00+09:00").kstDateTime, "2026-09-01 00:00:00");
});

test("시간대 표시가 없는 시각은 옵션(KST/UTC)에 따라 다르게 해석되고 '가정'으로 표시된다", () => {
  const asKst = toKst("2026-09-01T20:00:00", "KST");
  assert.deepEqual([asKst.kstDate, asKst.kstDateTime, asKst.assumed], ["2026-09-01", "2026-09-01 20:00:00", true]);

  const asUtc = toKst("2026-09-01T20:00:00", "UTC");
  assert.deepEqual([asUtc.kstDate, asUtc.kstDateTime, asUtc.assumed], ["2026-09-02", "2026-09-02 05:00:00", true]);

  assert.equal(toKst(""), null);
  assert.equal(toKst("어제"), null);
  assert.throws(() => toKst("2026-09-01T20:00:00", "JST"), /KST 또는 UTC/);
});

// ───────────── 토스 응답 펴기 ─────────────

test("주문을 결제 단위로 펴고 카드번호는 마스킹된 값만 남긴다", () => {
  const rows = tossRows([tossOrder({ date: "2026-09-03", amount: 100000, time: "05:11:52" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kstDate, "2026-09-03");
  assert.equal(rows[0].kstDateTime, "2026-09-03 14:11:52");
  assert.equal(rows[0].amount, 100000);
  assert.equal(rows[0].sourceType, "CARD");
  assert.equal(rows[0].cardMasked, "94104****1234");
  assert.equal(rows[0].items, "수강료");
  assert.equal(rows[0].timeAssumed, false);
});

test("settlement·bundle 같은 모르는 필드가 있어도 죽지 않는다", () => {
  const order = tossOrder({ date: "2026-09-03", amount: 50000 });
  order.payments[0].settlement = { status: "DONE", extra: { deep: true } };
  order.payments[0].bundle = { id: "b1" };
  order.discounts = [];
  order.accruals = [];
  assert.doesNotThrow(() => tossRows([order]));
});

test("금액이나 시각을 해석할 수 없으면 대사에 넣지 않고 따로 보고한다", () => {
  const broken = tossOrder({ date: "2026-09-03", amount: 10000 });
  broken.payments[0].amount = "금액없음";
  const { rows, invalid } = flattenTossOrders([broken], { naiveTz: "KST" });
  assert.equal(rows.length, 0);
  assert.equal(invalid.length, 1);
});

// ───────────── 매칭 규칙 ─────────────

test("① 주문번호가 같고 금액도 같으면 정상 매칭", () => {
  const site = [siteRow({ date: "2026-09-03", amount: 100000, providerOrderId: "order-ID1" })];
  const toss = tossRows([tossOrder({ date: "2026-09-03", amount: 100000, orderId: "order-ID1" })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.MATCHED_BY_ID);
  assert.equal(r.tossResults[0].category, CATEGORY.MATCHED_BY_ID);
  assert.equal(r.groups.length, 1);
});

test("① 주문번호가 같아도 금액이 다르면 보류(자동 매칭 금지)", () => {
  const site = [siteRow({ date: "2026-09-03", amount: 90000, providerOrderId: "order-ID2" })];
  const toss = tossRows([tossOrder({ date: "2026-09-03", amount: 100000, orderId: "order-ID2" })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.HELD_AMOUNT_MISMATCH);
  assert.equal(r.tossResults[0].category, CATEGORY.HELD_AMOUNT_MISMATCH);
  assert.match(r.siteResults[0].reason, /금액이 다릅니다/);
  assert.equal(r.groups.length, 0);
});

test("① 한 주문번호에 여러 건이 얽히면 전부 보류", () => {
  const site = [
    siteRow({ date: "2026-09-03", amount: 50000, providerOrderId: "order-ID3" }),
    siteRow({ date: "2026-09-03", amount: 50000, providerOrderId: "order-ID3" }),
  ];
  const order = tossOrder({ date: "2026-09-03", amount: 100000, orderId: "order-ID3" });
  const r = matchSets(site, tossRows([order]));
  assert.deepEqual(r.siteResults.map((e) => e.category), [CATEGORY.HELD_ID_MULTIPLE, CATEGORY.HELD_ID_MULTIPLE]);
  assert.equal(r.tossResults[0].category, CATEGORY.HELD_ID_MULTIPLE);
  assert.equal(r.tossResults[0].candidates.length, 2);
});

test("② 같은 날·같은 금액 1건씩이면 정상 매칭", () => {
  const site = [siteRow({ date: "2026-09-05", amount: 80000 })];
  const toss = tossRows([tossOrder({ date: "2026-09-05", amount: 80000 })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.MATCHED_BY_DATE_AMOUNT);
  assert.equal(r.tossResults[0].category, CATEGORY.MATCHED_BY_DATE_AMOUNT);
});

test("② 같은 날·같은 금액 3:3 이면 묶음 매칭(개별 짝은 짓지 않는다)", () => {
  const site = [1, 2, 3].map(() => siteRow({ date: "2026-09-07", amount: 80000 }));
  const toss = tossRows([1, 2, 3].map(() => tossOrder({ date: "2026-09-07", amount: 80000 })));
  const r = matchSets(site, toss);
  assert.deepEqual(new Set(r.siteResults.map((e) => e.category)), new Set([CATEGORY.MATCHED_AS_GROUP]));
  assert.deepEqual(new Set(r.tossResults.map((e) => e.category)), new Set([CATEGORY.MATCHED_AS_GROUP]));
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].kind, "GROUP");
  assert.equal(r.groups[0].siteRows.length, 3);
});

test("② 3:2 로 개수가 어긋나면 2건만 묶고 남는 1건은 보류 + '특정 불가' 명시", () => {
  const site = [1, 2, 3].map(() => siteRow({ date: "2026-09-08", amount: 80000 }));
  const toss = tossRows([1, 2].map(() => tossOrder({ date: "2026-09-08", amount: 80000 })));
  const r = matchSets(site, toss);
  const categories = r.siteResults.map((e) => e.category);
  assert.equal(categories.filter((c) => c === CATEGORY.MATCHED_AS_GROUP).length, 2);
  assert.equal(categories.filter((c) => c === CATEGORY.HELD_DUPLICATE_SURPLUS).length, 1);
  const surplus = r.siteResults.find((e) => e.category === CATEGORY.HELD_DUPLICATE_SURPLUS);
  assert.match(surplus.reason, /특정할 수 없습니다/);
  assert.equal(surplus.candidates.length, 2);
  assert.deepEqual(new Set(r.tossResults.map((e) => e.category)), new Set([CATEGORY.MATCHED_AS_GROUP]));
});

test("③ 금액이 같고 날짜가 ±3일 차이면 절대 자동 매칭하지 않고 보류로 남긴다", () => {
  const site = [siteRow({ date: "2026-09-10", amount: 120000 })];
  const toss = tossRows([tossOrder({ date: "2026-09-12", amount: 120000 })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.HELD_NEAR_DATE);
  assert.equal(r.tossResults[0].category, CATEGORY.HELD_NEAR_DATE);
  assert.equal(r.siteResults[0].candidates[0].dayDiff, 2);
  assert.equal(r.groups.length, 0);
});

test("③ 4일 차이면 후보로도 보지 않고 한쪽에만 있는 건이 된다", () => {
  const site = [siteRow({ date: "2026-09-10", amount: 120000 })];
  const toss = tossRows([tossOrder({ date: "2026-09-15", amount: 120000 })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.SITE_ONLY);
  assert.equal(r.tossResults[0].category, CATEGORY.POS_ONLY);
});

test("③ 같은 날인데 금액이 다르면 보류하고 후보를 보여준다", () => {
  const site = [siteRow({ date: "2026-09-11", amount: 100000 })];
  const toss = tossRows([tossOrder({ date: "2026-09-11", amount: 95000 })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.HELD_AMOUNT_DIFF_SAME_DATE);
  assert.equal(r.tossResults[0].category, CATEGORY.HELD_AMOUNT_DIFF_SAME_DATE);
  assert.equal(r.siteResults[0].candidates[0].row.amount, 95000);
});

test("④ 짝이 아예 없으면 사이트에만 있음 / 토스POS에만 있음", () => {
  const site = [siteRow({ date: "2026-09-02", amount: 70000 })];
  const toss = tossRows([tossOrder({ date: "2026-09-20", amount: 300000 })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.SITE_ONLY);
  assert.equal(r.tossResults[0].category, CATEGORY.POS_ONLY);
});

// ───────────── 전체 대사(분리·집계) ─────────────

test("취소 건은 별도로 분리되어 서로끼리만 매칭된다", () => {
  const siteRows = [
    siteRow({ date: "2026-09-04", amount: 100000 }),
    siteRow({ date: "2026-09-04", amount: 60000, status: "CANCELED" }),
  ];
  const payments = tossRows([
    tossOrder({ date: "2026-09-04", amount: 100000 }),
    tossOrder({ date: "2026-09-04", amount: 60000, state: "CANCELLED" }),
  ]);
  const result = buildReconciliation({ month: "2026-09", siteRows, tossPayments: payments });
  assert.equal(result.main.siteResults.length, 1);
  assert.equal(result.main.siteResults[0].category, CATEGORY.MATCHED_BY_DATE_AMOUNT);
  assert.equal(result.cancel.siteResults.length, 1);
  assert.equal(result.cancel.tossResults.length, 1);
  assert.equal(result.cancel.siteResults[0].category, CATEGORY.MATCHED_BY_DATE_AMOUNT);
});

test("카드가 아닌 토스 결제는 카드 대사에서 빠지고 참고 목록으로만 남는다", () => {
  const payments = tossRows([
    tossOrder({ date: "2026-09-06", amount: 30000, sourceType: "CASH" }),
    tossOrder({ date: "2026-09-06", amount: 30000, sourceType: "CARD" }),
  ]);
  const result = buildReconciliation({ month: "2026-09", siteRows: [], tossPayments: payments });
  assert.equal(result.toss.nonCard.length, 1);
  assert.equal(result.toss.approved.length, 1);
  assert.equal(result.main.tossResults.length, 1);
  assert.equal(result.main.tossResults[0].category, CATEGORY.POS_ONLY);
});

test("다른 지점 원생은 대사에서 빠지고 건수만 보고된다 / 지점 미상은 포함하되 표시", () => {
  const siteRows = [
    siteRow({ date: "2026-09-09", amount: 100000, branch: "1호점 : 본점" }),
    siteRow({ date: "2026-09-09", amount: 100000, branch: null, name: "김철수" }),
  ];
  const result = buildReconciliation({ month: "2026-09", siteRows, tossPayments: [] });
  assert.equal(result.site.otherBranch.length, 1);
  assert.equal(result.main.siteResults.length, 1);
  assert.equal(result.quality.unknownBranch.length, 1);
  assert.equal(classifyBranch("2호점 : 행정복지센터"), "IN");
  assert.equal(classifyBranch(""), "UNKNOWN");
});

test("이번 달 밖(±3일 버퍼) 건은 후보로만 보이고 분류를 받지 않는다", () => {
  const siteRows = [siteRow({ date: "2026-08-31", amount: 150000 })];
  const payments = tossRows([tossOrder({ date: "2026-09-01", amount: 150000 })]);
  const result = buildReconciliation({ month: "2026-09", siteRows, tossPayments: payments });
  assert.equal(result.main.siteResults.length, 0); // 8/31 건은 9월 대사 대상이 아니다
  assert.equal(result.main.tossResults[0].category, CATEGORY.HELD_NEAR_DATE);
  assert.equal(result.main.tossResults[0].candidates[0].outOfMonth, true);
});

test("데이터 품질 경고: 09:00(날짜만 기록)·새벽 시각", () => {
  const siteRows = [
    siteRow({ date: "2026-09-12", amount: 10000, time: "09:00:00" }),
    siteRow({ date: "2026-09-13", amount: 10000, time: "03:20:00" }),
  ];
  const result = buildReconciliation({ month: "2026-09", siteRows, tossPayments: [] });
  assert.equal(result.quality.dateOnly.length, 1);
  assert.equal(result.quality.dawn.length, 1);
});

test("합계 검증: 전체 차이 = 항목별 차이의 합", () => {
  const siteRows = [
    siteRow({ date: "2026-09-02", amount: 100000 }), // 매칭
    siteRow({ date: "2026-09-03", amount: 90000 }), // 사이트에만
  ];
  const payments = tossRows([
    tossOrder({ date: "2026-09-02", amount: 100000 }), // 매칭
    tossOrder({ date: "2026-09-20", amount: 250000 }), // 토스에만
    tossOrder({ date: "2026-09-21", amount: 150000 }), // 토스에만
  ]);
  const result = buildReconciliation({ month: "2026-09", siteRows, tossPayments: payments });
  const s = result.mainSummary;
  assert.equal(s.siteTotal, 190000);
  assert.equal(s.tossTotal, 500000);
  assert.equal(s.difference, 310000);
  assert.equal(s.itemLevelDifference, 400000 - 90000);
  assert.equal(s.reconciles, true);
  const direct = summarize(result.main);
  assert.equal(direct.difference, s.difference);
});

// ───────────── 리포트·안전장치 ─────────────

test("리포트는 한국어 섹션과 원화 표기를 포함하고 CSV 는 엑셀용 BOM 으로 시작한다", () => {
  const siteRows = [siteRow({ date: "2026-09-02", amount: 100000, name: "김민수" })];
  const payments = tossRows([tossOrder({ date: "2026-09-02", amount: 100000 })]);
  const result = buildReconciliation({ month: "2026-09", siteRows, tossPayments: payments });
  const md = renderMarkdown(result, {
    generatedAtKst: "2026-09-18 10:00:00",
    merchantId: "324744",
    merchantLabel: "스티즈농구교실 다산2호점",
    tossSource: "테스트",
    naiveTz: "KST",
    noWriteProof: "동일",
    assumedCount: 0,
  });
  for (const heading of ["토스POS에만 있음", "사이트에만 있음", "확인 필요", "정상 매칭", "취소 건", "지점 제외 건수", "데이터 품질 경고"]) {
    assert.ok(md.includes(heading), `리포트에 '${heading}' 섹션이 있어야 합니다`);
  }
  assert.ok(md.includes("₩100,000"));
  assert.ok(md.includes("UTC(Z) 표기"));
  const csv = renderCsv(result);
  assert.ok(csv.startsWith("﻿"));
  assert.ok(csv.includes("category,side,kstDateTime,amount"));
  assert.ok(csv.includes("김민수"));
  assert.equal(formatWon(1425000), "₩1,425,000");
});

test("GET 이외의 요청과 허용되지 않은 경로는 보내기 전에 막힌다", () => {
  assert.equal(assertReadOnlyTossRequest("GET", "/merchants/324744/order/orders"), true);
  assert.throws(() => assertReadOnlyTossRequest("POST", "/merchants/324744/order/orders"), /조회 전용/);
  assert.throws(() => assertReadOnlyTossRequest("DELETE", "/merchants/324744/order/orders"), /조회 전용/);
  assert.throws(() => assertReadOnlyTossRequest("GET", "/merchants/324744/order/orders/123"), /허용되지 않은 경로/);
});

test("비밀값은 어떤 문구에도 남지 않게 가려진다", () => {
  const secret = "live_sk_super_secret_value_123";
  const masked = redactSecrets(`요청 실패: key=${secret}`, [secret]);
  assert.ok(!masked.includes(secret));
  assert.ok(masked.includes("[숨김]"));
  const url = redactSecrets("postgresql://user:p4ssw0rd@db.example.com:6543/postgres", []);
  assert.ok(!url.includes("p4ssw0rd"));
});

// ───────────── POS 메모 이름 매칭 ─────────────

const ROSTER = [
  { id: "stu-1", name: "박찬민", classes: "화요일 8교시" },
  { id: "stu-2", name: "이시윤", classes: "토요일 4교시" },
  { id: "stu-3", name: "김대건", classes: "목요일 3교시" },
  { id: "stu-4", name: "강시우", classes: "금요일 5교시" },
  { id: "stu-5", name: "김시우", classes: "월요일 2교시" },
  { id: "stu-6", name: "양시우", classes: "금요일 5교시" },
  { id: "stu-7", name: "정우준", classes: "월요일 6교시" },
  { id: "stu-8", name: "정지유", classes: "수요일 6교시" },
];

function memoRows(orders) {
  return attachStudentResolution(tossRows(orders), ROSTER);
}

test("메모에서 반 토큰·청구월·주차를 걷어내고 이름만 남긴다", () => {
  assert.equal(cleanMemoFragment("토4 이시윤 9월"), "이시윤");
  assert.equal(cleanMemoFragment("박찬민 9월"), "박찬민");
  assert.equal(cleanMemoFragment("목3 김대건 2주"), "김대건");
  assert.equal(cleanMemoFragment("이시윤 2026-09"), "이시윤");
  assert.equal(cleanMemoFragment("토요일 4교시 이시윤 9월"), "이시윤");
  assert.equal(cleanMemoFragment("   "), "");
});

test("한 메모에 여러 줄·쉼표로 여러 원생이 적힌 경우를 모두 읽는다", () => {
  const parsed = parseMemoNames({ lineItems: [{ memo: "정우준 9월\n정지유 9월" }] });
  assert.deepEqual(parsed.names, ["정우준", "정지유"]);
  const commas = parseMemoNames({ lineItems: [{ memo: "박찬민 9월, 이시윤 9월" }] });
  assert.deepEqual(commas.names, ["박찬민", "이시윤"]);
});

test("줄바꿈으로 끝나는 메모와 주문 단위 메모도 읽는다", () => {
  const trailing = parseMemoNames({ memo: "토4 이시윤 9월\n" });
  assert.deepEqual(trailing.names, ["이시윤"]);
  assert.equal(trailing.memoRaw, "토4 이시윤 9월");

  // 품목 메모가 없으면 주문 메모를 쓴다
  const rows = memoRows([tossOrder({ date: "2026-09-05", amount: 110000, orderMemo: "토4 이시윤 9월\n" })]);
  assert.deepEqual(rows[0].memoNames, ["이시윤"]);
  assert.equal(rows[0].resolvedStudents[0].name, "이시윤");
});

test("이름 해석: 정확히 일치 / 성 생략(1명) / 성 생략(여러 명) / 명단에 없음", () => {
  assert.equal(resolveStudentName("박찬민", ROSTER).status, "EXACT");
  const suffix = resolveStudentName("대건", ROSTER);
  assert.equal(suffix.status, "SUFFIX");
  assert.equal(suffix.students[0].name, "김대건");
  const many = resolveStudentName("시우", ROSTER);
  assert.equal(many.status, "AMBIGUOUS");
  assert.equal(many.students.length, 3);
  assert.equal(resolveStudentName("박상원", ROSTER).status, "NONE");
});

test("메모 이름 + 금액이 맞으면 날짜가 달라도 정상 매칭된다", () => {
  const site = [siteRow({ date: "2026-09-10", amount: 120000, name: "박찬민" })];
  const toss = memoRows([tossOrder({ date: "2026-09-25", amount: 120000, memo: "박찬민 9월" })]);
  const r = matchSets(site, toss);
  assert.equal(r.siteResults[0].category, CATEGORY.MATCHED_BY_MEMO_NAME);
  assert.equal(r.tossResults[0].category, CATEGORY.MATCHED_BY_MEMO_NAME);
});

test("성을 생략한 메모도 원생이 한 명뿐이면 매칭된다", () => {
  const site = [siteRow({ date: "2026-09-10", amount: 110000, name: "김대건" })];
  const toss = memoRows([tossOrder({ date: "2026-09-10", amount: 110000, memo: "대건" })]);
  const r = matchSets(site, toss);
  assert.equal(r.tossResults[0].category, CATEGORY.MATCHED_BY_MEMO_NAME);
});

test("메모 이름이 여러 원생과 겹치면 절대 자동 매칭하지 않는다", () => {
  const site = [siteRow({ date: "2026-09-10", amount: 100000, name: "양시우" })];
  const toss = memoRows([tossOrder({ date: "2026-09-18", amount: 100000, memo: "시우" })]);
  const r = matchSets(site, toss);
  assert.equal(r.tossResults[0].category, CATEGORY.HELD_MEMO_NAME_AMBIGUOUS);
  assert.match(r.tossResults[0].reason, /3명/);
  assert.notEqual(r.siteResults[0].category, CATEGORY.MATCHED_BY_MEMO_NAME);
});

test("메모 이름은 맞는데 금액이 다르면 보류(합계 일치 여부를 알려준다)", () => {
  const site = [
    siteRow({ date: "2026-09-09", amount: 80000, name: "박찬민" }),
    siteRow({ date: "2026-09-09", amount: 80000, name: "박찬민" }),
  ];
  const toss = memoRows([tossOrder({ date: "2026-09-09", amount: 160000, memo: "박찬민 9월" })]);
  const r = matchSets(site, toss);
  assert.equal(r.tossResults[0].category, CATEGORY.HELD_MEMO_NAME_AMOUNT_MISMATCH);
  assert.match(r.tossResults[0].reason, /합계는 일치합니다/);
  assert.deepEqual(new Set(r.siteResults.map((e) => e.category)), new Set([CATEGORY.HELD_MEMO_NAME_AMOUNT_MISMATCH]));

  const single = matchSets(
    [siteRow({ date: "2026-09-09", amount: 90000, name: "박찬민" })],
    memoRows([tossOrder({ date: "2026-09-09", amount: 120000, memo: "박찬민 9월" })]),
  );
  assert.equal(single.tossResults[0].category, CATEGORY.HELD_MEMO_NAME_AMOUNT_MISMATCH);
  assert.match(single.tossResults[0].reason, /차이/);
});

test("한 결제에 원생이 둘이면(형제 합산) 절대 자동 매칭하지 않는다", () => {
  const site = [
    siteRow({ date: "2026-09-02", amount: 216000, name: "정우준" }),
    siteRow({ date: "2026-09-02", amount: 216000, name: "정지유" }),
  ];
  const toss = memoRows([tossOrder({ date: "2026-09-02", amount: 432000, memo: "정우준 9월\n정지유 9월" })]);
  const r = matchSets(site, toss);
  assert.equal(r.tossResults[0].category, CATEGORY.HELD_MULTI_STUDENT_ORDER);
  assert.equal(r.tossResults[0].candidates.length, 2);
  assert.deepEqual(new Set(r.siteResults.map((e) => e.category)), new Set([CATEGORY.HELD_MULTI_STUDENT_ORDER]));
});

test("명단에 없는 메모 이름은 리포트에 따로 드러난다", () => {
  const payments = memoRows([tossOrder({ date: "2026-09-16", amount: 100000, memo: "박상원 9월" })]);
  const result = buildReconciliation({ month: "2026-09", siteRows: [], tossPayments: payments, students: ROSTER });
  assert.equal(result.unknownMemoNamePayments.length, 1);
  assert.equal(result.main.tossResults[0].category, CATEGORY.POS_ONLY);
  const md = renderMarkdown(result, { naiveTz: "KST", assumedCount: 0 });
  assert.ok(md.includes("메모 이름이 원생 명단에 없음"));
  assert.ok(md.includes("박상원"));
});

test("토스POS에만 있는 건에는 원생 이름과 수강 반이 함께 보인다", () => {
  const payments = memoRows([tossOrder({ date: "2026-09-16", amount: 100000, memo: "박찬민 9월" })]);
  const result = buildReconciliation({ month: "2026-09", siteRows: [], tossPayments: payments, students: ROSTER });
  const md = renderMarkdown(result, { naiveTz: "KST", assumedCount: 0 });
  assert.ok(md.includes("원생: **박찬민**"));
  assert.ok(md.includes("화요일 8교시"));
  const csv = renderCsv(result);
  assert.ok(csv.includes("memo,resolved_student"));
  assert.ok(csv.includes("박찬민 9월"));
});

test("메모 매칭은 주문번호 매칭 다음, 날짜·금액 매칭보다 먼저 적용된다", () => {
  // 같은 날 같은 금액이 2:2 라 날짜·금액만으로는 묶음 처리되지만, 메모 이름이 있으면 1:1 로 정확히 갈린다.
  const site = [
    siteRow({ date: "2026-09-14", amount: 110000, name: "박찬민" }),
    siteRow({ date: "2026-09-14", amount: 110000, name: "이시윤" }),
  ];
  const toss = memoRows([
    tossOrder({ date: "2026-09-14", amount: 110000, memo: "이시윤 9월" }),
    tossOrder({ date: "2026-09-14", amount: 110000, memo: "박찬민 9월" }),
  ]);
  const r = matchSets(site, toss);
  assert.deepEqual(new Set(r.siteResults.map((e) => e.category)), new Set([CATEGORY.MATCHED_BY_MEMO_NAME]));
  assert.equal(r.groups.length, 2);
  for (const g of r.groups) {
    assert.equal(g.siteRows[0].studentName, g.tossRows[0].resolvedStudents[0].name);
  }
});
