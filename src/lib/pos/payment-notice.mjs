/**
 * 토스POS 결제 → 슬랙 DM 알림 — 순수 로직 모듈 (DB·네트워크·환경변수 없음)
 *
 * ■ 무엇을 하나
 *   POS 결제 1건마다 원장에게 "랠리즈에서 현장결제 처리하셨나요?" 를 묻는다.
 *   청구서의 원본은 **랠리즈**다. 사이트 청구서(Payment)는 랠리즈를 뒤따라 복사되는 사본이라
 *   사이트가 랠리즈를 앞서면 안 된다 → 사이트 납부 반영은 **원장이 버튼으로 확인했을 때만** 한다.
 *
 * ■ 여기 있는 것
 *   - 웹훅 본문에서 주문 ID 뽑기(본문 모양이 아직 확인되지 않아 방어적으로)
 *   - 토스 주문 → 카드·승인 결제만 골라내기
 *   - 메모 이름 → 원생 판정(**정확히 일치하는 1명**만 확정. 성을 뺀 표기는 절대 확정하지 않음)
 *   - 사이트 청구서와 맞춰 분류(AUTO_CANDIDATE 등 7종)
 *   - 슬랙 메시지(Block Kit) 만들기
 *
 * 테스트(tests/pos-payment-notice.test.mjs)가 이 파일을 실제로 실행해서 규칙을 검증한다.
 * 메모 해석·청구월 판정은 tossplace-match.mjs 한 벌을 그대로 쓴다(사본 금지).
 */

import {
  formatKstDateTime,
  formatWon,
  parseMemoNames,
  resolveStudentName,
  resolveTargetBillingMonth,
  toKst,
} from "./tossplace-match.mjs";

// ───────────────────────────── 상수 ─────────────────────────────

/** 알림 분류. DB CHECK 제약과 같은 목록이다. */
export const NOTICE_KIND = {
  AUTO_CANDIDATE: "AUTO_CANDIDATE",
  NO_MEMO: "NO_MEMO",
  AMBIGUOUS: "AMBIGUOUS",
  NOT_IN_ROSTER: "NOT_IN_ROSTER",
  NO_SITE_INVOICE: "NO_SITE_INVOICE",
  ALREADY_PAID: "ALREADY_PAID",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
};

/** 원생을 버튼으로 골라야 하는 분류 */
export const PICK_KINDS = new Set([NOTICE_KIND.NO_MEMO, NOTICE_KIND.AMBIGUOUS, NOTICE_KIND.NOT_IN_ROSTER]);

/** 슬랙 버튼 action_id. 원생 고르기는 `pos_notice_pick:<원생ID>` 형식이다. */
export const ACTION = {
  CONFIRM_PAY: "pos_notice_confirm_pay", // [랠리즈 처리함 · 사이트 납부 반영] — 유일한 돈 쓰기 버튼
  ACK: "pos_notice_ack", // [랠리즈 처리함] / [확인함] — 기록만
  IGNORE: "pos_notice_ignore", // [학원 외 결제]
  PICK_PREFIX: "pos_notice_pick:",
};

/** 슬랙 한 줄 버튼 수 상한(슬랙 규격 25개 안쪽) */
export const MAX_CANDIDATE_BUTTONS = 20;

const UNPAID = new Set(["PENDING", "OVERDUE"]);
const CANCELED = new Set(["CANCELED", "CANCELLED", "REFUNDED"]);

// ───────────────────────── 웹훅 본문 → 주문 ID ─────────────────────────

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function asId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && ORDER_ID_RE.test(value.trim())) return value.trim();
  return "";
}

/**
 * 웹훅 본문에서 주문 ID 를 뽑는다. 실제 알림을 아직 한 번도 받아보지 못해서(0건)
 * 알려진 후보 위치를 차례로 본다. 못 찾으면 빈 문자열 + 사유.
 * 본문의 금액·상태는 **믿지 않는다** — 주문 ID 로 토스에 다시 물어본 값만 쓴다.
 */
export function extractOrderIdFromWebhook(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const type = typeof body.type === "string" ? body.type : "";
  const data = body.data && typeof body.data === "object" ? body.data : {};
  const candidates = [
    data.orderId,
    data.order?.id,
    data.payment?.orderId,
    type.startsWith("order.") ? data.id : undefined,
  ];
  for (const value of candidates) {
    const id = asId(value);
    if (id) return { orderId: id, reason: "" };
  }
  return { orderId: "", reason: `주문 ID 를 찾지 못했습니다(type=${type || "없음"})` };
}

// ───────────────────────── 토스 주문 → 알릴 결제 ─────────────────────────

/** 품목 이름(반 이름) 목록. 예: ["금요일 3교시"] */
export function lineItemTitles(order) {
  const items = Array.isArray(order?.lineItems) ? order.lineItems : [];
  return items
    .map((li) => String(li?.item?.title ?? li?.title ?? li?.name ?? "").trim())
    .filter(Boolean);
}

/**
 * 주문에서 **카드 · 승인** 결제만 골라 알림 1건씩으로 만든다.
 * 현금·취소 결제는 대상이 아니다(현장 카드 결제만 랠리즈 처리가 필요하다).
 */
export function extractNoticePayments(order) {
  const orderId = asId(order?.id ?? order?.orderId);
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  const titles = lineItemTitles(order);
  const memo = parseMemoNames(order);
  const out = [];
  for (const payment of payments) {
    const sourceType = String(payment?.sourceType ?? "").toUpperCase();
    const state = String(payment?.state ?? "").toUpperCase();
    if (sourceType !== "CARD" || state !== "APPROVED") continue;
    const paymentId = payment?.id == null ? "" : String(payment.id).trim();
    const amount = Math.round(Number(payment?.amount));
    if (!orderId || !paymentId || !Number.isFinite(amount)) continue;
    const kst = toKst(payment?.approvedAt ?? payment?.createdAt ?? order?.completedAt ?? order?.createdAt);
    out.push({
      tossPaymentId: paymentId,
      tossOrderId: orderId,
      amount,
      // DB(timestamptz)에 넣을 값. KST 로 해석한 시각에 +09:00 을 붙여 절대 시각으로 만든다.
      approvedAtIso: kst ? `${kst.kstDateTime.replace(" ", "T")}+09:00` : null,
      kstDate: kst ? kst.kstDate : "",
      kstDateTime: kst ? kst.kstDateTime.slice(0, 16) : "",
      lineItemTitles: titles,
      lineItems: titles.join(", "),
      memoRaw: memo.memoRaw,
      memoNames: memo.names,
    });
  }
  return out;
}

// ───────────────────────── 메모 이름 → 원생 ─────────────────────────

const normName = (value) => String(value ?? "").replace(/\s+/g, "").toLowerCase();

/**
 * 원장 지시: "정확히 일치" 하는 1명만 확정한다.
 *  - 메모 없음 → NO_MEMO
 *  - 이름 전체가 정확히 같은 원생이 딱 1명 → RESOLVED
 *  - 성을 뺀 표기("대건" ← 김대건)·동명이인 표기(이현준A/B)·여러 명 → AMBIGUOUS (후보만 제시, **절대 확정 안 함**)
 *  - 명단에 없음 → NOT_IN_ROSTER
 * @param {{memoRaw:string, memoNames:string[], students:{id:string,name:string}[]}} input
 */
export function resolveNoticeStudent({ memoRaw, memoNames, students }) {
  const list = Array.isArray(students) ? students : [];
  if (!String(memoRaw ?? "").trim()) return { status: NOTICE_KIND.NO_MEMO, student: null, nameCandidates: [] };
  const names = Array.isArray(memoNames) ? memoNames : [];
  if (names.length === 0) return { status: NOTICE_KIND.NOT_IN_ROSTER, student: null, nameCandidates: [] };

  const exactIds = new Set();
  const looseIds = new Set();
  for (const name of names) {
    const target = normName(name);
    for (const s of list) if (normName(s.name) === target) exactIds.add(s.id);
    // 성을 뺀 표기·동명이인 꼬리표까지 넓게 본 후보(버튼으로만 제시)
    for (const s of resolveStudentName(name, list).students) looseIds.add(s.id);
  }
  const byId = new Map(list.map((s) => [s.id, s]));
  const exact = [...exactIds].map((id) => byId.get(id)).filter(Boolean);

  // 이름 하나 + 정확히 일치 1명일 때만 확정한다. 이름이 여럿이면(형제 한 번에 결제 등) 고르게 한다.
  if (names.length === 1 && exact.length === 1) {
    return { status: "RESOLVED", student: exact[0], nameCandidates: exact };
  }
  const candidates = [...new Set([...exactIds, ...looseIds])].map((id) => byId.get(id)).filter(Boolean);
  if (candidates.length > 0) return { status: NOTICE_KIND.AMBIGUOUS, student: null, nameCandidates: candidates };
  return { status: NOTICE_KIND.NOT_IN_ROSTER, student: null, nameCandidates: [] };
}

// ───────────────────────── 사이트 청구서와 맞추기 ─────────────────────────

/** "2026-10" → { year: 2026, month: 10 } (형식이 아니면 null) */
export function splitYearMonth(ym) {
  if (typeof ym !== "string" || !/^\d{4}-\d{2}$/.test(ym)) return null;
  return { year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)) };
}

/** 청구월 판정 — 메모의 달(예: "10월")이 결제일의 달보다 우선한다(tossplace-match 한 벌). */
export function resolveNoticeTarget(memoRaw, kstDate) {
  const target = resolveTargetBillingMonth(memoRaw, kstDate);
  const ym = splitYearMonth(target.month);
  return {
    year: ym ? ym.year : null,
    month: ym ? ym.month : null,
    months: target.months,
    source: target.source,
  };
}

/**
 * 한 원생의 청구월 MONTHLY 청구서들과 결제 금액을 맞춘다.
 *  - 같은 금액 PAID 가 있으면 → ALREADY_PAID (이중결제 의심 또는 이미 옮겨짐) — 가장 먼저 본다
 *  - 미납(PENDING/OVERDUE)이 **딱 1건**이고 금액이 같으면 → AUTO_CANDIDATE
 *  - (취소 제외) 청구서가 없으면 → NO_SITE_INVOICE
 *  - 그 밖 → AMOUNT_MISMATCH
 * 메모에 달이 여럿이면(예: "9월, 10월") 한 청구서로 묶을 수 없으므로 AUTO 로 가지 않는다.
 * @param {{rows:{id:string,amount:number,status:string}[], amount:number, multiMonth?:boolean, hasTarget?:boolean}} input
 */
export function classifyInvoiceRows({ rows, amount, multiMonth = false, hasTarget = true }) {
  if (!hasTarget) {
    return { kind: NOTICE_KIND.NO_SITE_INVOICE, sitePaymentId: null, siteAmounts: [], reason: "청구월을 알 수 없습니다" };
  }
  const live = (Array.isArray(rows) ? rows : []).filter((r) => !CANCELED.has(String(r.status).toUpperCase()));
  const siteAmounts = live.map((r) => Number(r.amount));
  const same = (r) => Number(r.amount) === Number(amount);
  const status = (r) => String(r.status).toUpperCase();

  if (live.some((r) => status(r) === "PAID" && same(r))) {
    return { kind: NOTICE_KIND.ALREADY_PAID, sitePaymentId: null, siteAmounts, reason: "" };
  }
  const unpaid = live.filter((r) => UNPAID.has(status(r)));
  if (unpaid.length === 1 && same(unpaid[0])) {
    if (multiMonth) {
      return {
        kind: NOTICE_KIND.AMOUNT_MISMATCH,
        sitePaymentId: null,
        siteAmounts,
        reason: "메모에 여러 달이 적혀 있어 청구서 하나로 묶지 않았습니다",
      };
    }
    return { kind: NOTICE_KIND.AUTO_CANDIDATE, sitePaymentId: unpaid[0].id, siteAmounts, reason: "" };
  }
  if (live.length === 0) return { kind: NOTICE_KIND.NO_SITE_INVOICE, sitePaymentId: null, siteAmounts, reason: "" };
  return {
    kind: NOTICE_KIND.AMOUNT_MISMATCH,
    sitePaymentId: null,
    siteAmounts,
    reason: unpaid.length > 1 ? "같은 달 미납 청구서가 여러 건입니다" : "",
  };
}

/**
 * 결제 1건 전체 분류(메모 → 원생 → 청구월 → 사이트 청구서).
 * siteRows 는 청구월의 MONTHLY 청구서들(여러 원생 섞여도 된다 — 여기서 원생·연월로 거른다).
 * @returns {{kind:string, resolvedStudentId:string|null, targetYear:number|null, targetMonth:number|null,
 *            sitePaymentId:string|null, nameCandidates:object[], siteAmounts:number[], reason:string}}
 */
export function classifyNotice({ memoRaw, memoNames, students, amount, kstDate, siteRows }) {
  const target = resolveNoticeTarget(memoRaw, kstDate);
  const who = resolveNoticeStudent({ memoRaw, memoNames, students });
  const base = { targetYear: target.year, targetMonth: target.month, nameCandidates: who.nameCandidates };
  if (who.status !== "RESOLVED") {
    return { ...base, kind: who.status, resolvedStudentId: null, sitePaymentId: null, siteAmounts: [], reason: "" };
  }
  const rows = rowsForStudentMonth(siteRows, who.student.id, target.year, target.month);
  const invoice = classifyInvoiceRows({
    rows,
    amount,
    multiMonth: target.months.length > 1,
    hasTarget: target.year != null,
  });
  return { ...base, resolvedStudentId: who.student.id, ...invoice };
}

/** 원생·연월이 맞는 MONTHLY 청구서만 남긴다. */
export function rowsForStudentMonth(siteRows, studentId, year, month) {
  return (Array.isArray(siteRows) ? siteRows : []).filter(
    (r) =>
      r.studentId === studentId &&
      Number(r.year) === Number(year) &&
      Number(r.month) === Number(month) &&
      String(r.type ?? "MONTHLY").toUpperCase() === "MONTHLY",
  );
}

// ───────────────────────── 버튼 후보(원생 고르기) ─────────────────────────

/**
 * 원생 고르기 버튼 후보.
 *  - 기본: POS 품목(반 이름)과 **정확히 같은 반**에 다니는 원생
 *  - AMBIGUOUS/NOT_IN_ROSTER: 메모 이름 후보(성 뺀 표기 등)를 맨 앞에
 * 최대 20명. 넘치면 넘친 수를 함께 돌려준다(메시지에 "외 N명" 으로 알린다).
 * @param {{kind:string, students:{id:string,name:string,classes:string[]}[], classTitles:string[], nameCandidates?:object[]}} input
 */
export function buildCandidateList({ kind, students, classTitles, nameCandidates = [] }) {
  const titles = new Set((classTitles ?? []).map((t) => String(t).trim()).filter(Boolean));
  const list = Array.isArray(students) ? students : [];
  const byClass = list.filter((s) => (s.classes ?? []).some((c) => titles.has(String(c).trim())));
  const first = kind === NOTICE_KIND.NO_MEMO ? [] : nameCandidates;
  const seen = new Set();
  const merged = [];
  for (const s of [...first, ...byClass.sort((a, b) => a.name.localeCompare(b.name, "ko"))]) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    merged.push(s);
  }
  return {
    candidates: merged.slice(0, MAX_CANDIDATE_BUTTONS),
    overflow: Math.max(0, merged.length - MAX_CANDIDATE_BUTTONS),
  };
}

// ───────────────────────── 슬랙 메시지 만들기 ─────────────────────────

/** 슬랙 mrkdwn 특수문자 무력화(메모에 <, >, & 가 있어도 링크·멘션으로 바뀌지 않게) */
export function escapeSlack(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const button = (text, actionId, value, style) => ({
  type: "button",
  text: { type: "plain_text", text: clip(text, 75), emoji: true },
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
});

/** 지금 이 순간의 KST "MM-DD HH:MM" (처리 결과 줄에 붙인다) */
export function kstStamp(nowMs = Date.now()) {
  return formatKstDateTime(new Date(nowMs)).slice(5, 16);
}

/**
 * 알림 메시지(텍스트 + 블록).
 * @param {{
 *   notice: {id:string, amount:number, kstDateTime:string, lineItems:string|null, memo:string|null,
 *            targetYear:number|null, targetMonth:number|null},
 *   kind: string,              // 지금 기준 분류(원생을 골랐으면 pickedKind)
 *   picked?: boolean,          // 원장이 원생을 고른 뒤인가
 *   studentName?: string|null,
 *   siteAmounts?: number[],
 *   reason?: string,
 *   candidates?: {id:string,name:string,classes?:string[]}[],
 *   overflow?: number,
 *   resultLine?: string|null,  // 있으면 버튼을 빼고 결과 줄을 붙인다(처리 끝)
 *   warningLine?: string|null, // 버튼은 남기고 경고 줄만 붙인다
 * }} input
 */
export function buildNoticeMessage(input) {
  const { notice, kind } = input;
  const amountText = formatWon(notice.amount);
  const monthText = notice.targetMonth ? `${notice.targetMonth}월` : "청구월 미상";
  const who = input.studentName ? `${escapeSlack(input.studentName)} · ` : "";
  const blocks = [];

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*토스POS 카드결제* · ${escapeSlack(notice.kstDateTime || "시각 미상")} · *${amountText}*`,
    },
  });
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*품목*\n${escapeSlack(notice.lineItems || "(없음)")}` },
      { type: "mrkdwn", text: `*메모*\n${escapeSlack(notice.memo || "(없음)")}` },
    ],
  });

  // 분류별 안내 문구
  let detail = "";
  if (kind === NOTICE_KIND.AUTO_CANDIDATE) {
    detail = `${who}사이트 청구서 ${monthText} ${amountText} 미납 → 함께 납부 처리합니다`;
  } else if (kind === NOTICE_KIND.NO_SITE_INVOICE) {
    detail = `${who}사이트에 ${monthText} 청구서가 아직 없습니다(랠리즈→사이트 미반영)`;
  } else if (kind === NOTICE_KIND.ALREADY_PAID) {
    detail = `⚠️ ${who}사이트에 이미 ${monthText} 납부 기록이 있습니다 — 이중결제인지 확인해 주세요`;
  } else if (kind === NOTICE_KIND.AMOUNT_MISMATCH) {
    const site = (input.siteAmounts ?? []).map(formatWon).join(", ") || "없음";
    detail = `${who}금액이 다릅니다 — POS ${amountText} / 사이트 ${monthText} 청구 ${site}`;
  } else if (kind === NOTICE_KIND.NO_MEMO) {
    detail = "메모가 없어 원생을 알 수 없습니다 — 원생을 골라 주세요";
  } else if (kind === NOTICE_KIND.AMBIGUOUS) {
    detail = "메모 이름과 정확히 일치하는 원생이 1명이 아닙니다 — 원생을 골라 주세요";
  } else if (kind === NOTICE_KIND.NOT_IN_ROSTER) {
    detail = "메모 이름을 원생 명단에서 찾지 못했습니다 — 원생을 골라 주세요";
  }
  if (input.reason) detail += `\n(${escapeSlack(input.reason)})`;
  if (detail) blocks.push({ type: "section", text: { type: "mrkdwn", text: detail } });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: "*랠리즈에서 현장결제 처리하셨나요?*" } });
  if (input.warningLine) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeSlack(input.warningLine) }] });
  }

  if (input.resultLine) {
    // 처리 끝 — 버튼을 없애고 결과만 남긴다(두 번 누를 수 없게).
    blocks.push({ type: "section", text: { type: "mrkdwn", text: escapeSlack(input.resultLine) } });
  } else {
    const v = notice.id;
    const ignore = button("학원 외 결제", ACTION.IGNORE, v);
    if (kind === NOTICE_KIND.AUTO_CANDIDATE) {
      blocks.push({
        type: "actions",
        elements: [button("랠리즈 처리함 · 사이트 납부 반영", ACTION.CONFIRM_PAY, v, "primary"), ignore],
      });
    } else if (PICK_KINDS.has(kind)) {
      const candidates = input.candidates ?? [];
      if (candidates.length > 0) {
        blocks.push({
          type: "actions",
          elements: candidates.map((s) => {
            const classes = (s.classes ?? []).join(", ");
            return button(classes ? `${s.name} (${classes})` : s.name, `${ACTION.PICK_PREFIX}${s.id}`, `${v}|${s.id}`);
          }),
        });
      } else {
        blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "고를 수 있는 원생 후보가 없습니다." }] });
      }
      if (input.overflow > 0) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `후보가 많아 앞의 ${candidates.length}명만 보여 드립니다(외 ${input.overflow}명).` }],
        });
      }
      blocks.push({ type: "actions", elements: [button("랠리즈 처리함", ACTION.ACK, v), ignore] });
    } else if (kind === NOTICE_KIND.ALREADY_PAID) {
      blocks.push({ type: "actions", elements: [button("확인함", ACTION.ACK, v), ignore] });
    } else {
      // NO_SITE_INVOICE · AMOUNT_MISMATCH — 확인 기록만 남긴다(돈은 건드리지 않음)
      blocks.push({ type: "actions", elements: [button("랠리즈 처리함", ACTION.ACK, v), ignore] });
    }
  }

  const text = `토스POS 결제 ${amountText} (${notice.kstDateTime || "시각 미상"}) — 랠리즈에서 현장결제 처리하셨나요?`;
  return { text, blocks };
}

/**
 * 슬랙 버튼 값 해석. 원생 고르기는 "알림ID|원생ID", 나머지는 "알림ID".
 * 모양이 틀리면 null(아무것도 하지 않는다).
 */
export function parseActionValue(actionId, value) {
  const id = String(actionId ?? "");
  const raw = String(value ?? "");
  const okId = (s) => /^[A-Za-z0-9_-]{1,100}$/.test(s);
  if (id.startsWith(ACTION.PICK_PREFIX)) {
    const [noticeId, studentId] = raw.split("|");
    if (!okId(noticeId ?? "") || !okId(studentId ?? "")) return null;
    if (id !== `${ACTION.PICK_PREFIX}${studentId}`) return null; // 버튼 ID 와 값이 어긋나면 무시
    return { type: "PICK", noticeId, studentId };
  }
  if (!okId(raw)) return null;
  if (id === ACTION.CONFIRM_PAY) return { type: "CONFIRM_PAY", noticeId: raw };
  if (id === ACTION.ACK) return { type: "ACK", noticeId: raw };
  if (id === ACTION.IGNORE) return { type: "IGNORE", noticeId: raw };
  return null;
}
