/**
 * 토스POS 결제 → 사이트 미납 청구 «자동 매칭» — 순수 판정 모듈 (DB·네트워크·환경변수 없음)
 *
 * ■ 왜 있나 (2026-11-12 사용자 확인 규칙)
 *   번호(STIZ:S-xxxx) 없는 POS 결제는 지금까지 «메모 이름 1명 정확 일치 + 그 달 미납 1건 금액 일치»만
 *   자동 반영됐다(payment-notice.mjs AUTO_CANDIDATE). 실제로는 한 결제에 여러 반(목6+화6)·형제(«루나루희»)·
 *   이름만(«도경»)·메모 없음(반·금액만)이 흔해서 매번 슬랙 보류로 남았다. 이 모듈이 그 결제를
 *   «배정이 딱 한 가지로만 가능할 때» 청구 묶음으로 맞춘다. 하나라도 어긋나면 HOLD(지금처럼 슬랙 확인).
 *
 * ■ 규칙 (하나라도 어긋나면 HOLD)
 *   1. 결제: 주문 안 결제가 승인 1건뿐(취소·부분취소·분할 없음), 카드·바코드, 1건 200만원 이하.
 *   2. 적용월: 메모 «N월» 정확히 하나 → 그 달. 메모에 달이 없으면 승인일(KST)의 달만. 둘 이상이면 HOLD.
 *   3. 학생: 메모 조각이 모두 해석돼야 한다(해석 안 되는 조각 하나라도 있으면 HOLD).
 *        a. 전체 이름 정확히 일치 1명
 *        b. 이름만(성 없음, 2~3자) — 성 뺀 이름이 같은 학생이 명단 전체에서 1명뿐
 *        c. 형제 이어 쓰기(«루나루희», «김루나루희») — 두 글자씩 끊은 이름이 각각 1명, 모두 같은 보호자
 *      명단 = 미병합 전체 학생(지점 무관 — 유일성은 보수적으로). 정해진 학생은 2호점(또는 지점 미기재)이어야.
 *   4. 메모에 이름이 없으면: 품목 반·적용월·금액으로 맞는 배정이 학원 전체에서 정확히 한 가지이고 학생 1명일 때만.
 *   5. 배정: 품목을 수량만큼 펼친 반 목록 ↔ 그 학생들의 적용월 MONTHLY 미납 청구(반 이름 정확 일치) 1:1.
 *      이름 적힌 학생마다 최소 1건, 합계 = 결제액, 가능한 청구 묶음이 정확히 한 가지.
 *   6. 고른 청구는 모두 «쓸 수 있는» 청구여야 한다(chargeBlockReason — 청구서 ISSUED/SENT·금액 같음,
 *      직원 확인 대기·열린 현장결제 요청·랠리즈 사본·다른 알림 반영 없음). 막힌 청구도 후보에는 넣는다
 *      (빼면 남은 하나가 «유일»해 보이는 착시가 생긴다) — 고른 묶음에 들어 있으면 HOLD.
 *
 * 테스트: tests/pos-auto-match.test.mjs (실제 11월 사례 전부)
 */

import { parseMemoNames, resolveTargetBillingMonth, formatWon } from "./tossplace-match.mjs";
import { CANCELLED_PAYMENT_STATES } from "./charge-request.mjs";

// ───────────────────────────── 상수 ─────────────────────────────

export const AUTO_MATCH = { MATCH: "MATCH", HOLD: "HOLD" };

/** 자동 매칭 1건 상한(원). AGENTS.md «1회 실행 상한 10건·200만원»과 같은 값. */
export const MAX_AUTO_MATCH_AMOUNT = 2_000_000;
/** 크론 1회 상한 */
export const SWEEP_MAX_PAID = 10;
export const SWEEP_MAX_TOTAL = 2_000_000;

/** 품목 칸 상한 — 넘으면 사람이 본다(경우의 수 폭발 방지) */
export const MAX_SLOTS = 8;
/** 배정 탐색 상한(가지 수) */
const MAX_SEARCH_STEPS = 20_000;

const MATCH_SOURCE_TYPES = new Set(["CARD", "BARCODE"]);
const UNPAID = new Set(["PENDING", "OVERDUE"]);
const OPEN_INVOICE = new Set(["ISSUED", "SENT"]);

const norm = (v) => String(v ?? "").replace(/\s+/g, "");
const hold = (reason, extra = {}) => ({ decision: AUTO_MATCH.HOLD, reason, ...extra });

/** 감사 기록 멱등키 — scripts/build-pos-site-sync.mjs 와 같은 모양 */
export function autoMatchIdempotencyKey(tossPaymentId, paymentId) {
  return `toss-pos:${tossPaymentId}:${paymentId}`;
}

/** 다산2호점(또는 지점 미기재) 학생인가 — build-pos-site-sync.mjs 의 s.branch LIKE '2호점%' 과 같은 판정 */
export function isDasan2Branch(branch) {
  if (branch == null) return true;
  const text = String(branch).trim();
  return text === "" || text.startsWith("2호점");
}

// ───────────────────────── 1. 결제 관문 ─────────────────────────

/**
 * 주문 안 결제가 «승인 1건뿐»이고 그게 이 결제인지. 취소·부분취소·분할결제가 섞이면 HOLD.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkPaymentGate(order, tossPaymentId) {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  if (payments.length !== 1) {
    return { ok: false, reason: payments.length === 0 ? "주문에 결제가 없습니다" : `한 주문에 결제가 ${payments.length}건(분할·추가 결제)입니다` };
  }
  const p = payments[0];
  const id = p?.id == null ? "" : String(p.id).trim();
  const state = String(p?.state ?? "").toUpperCase();
  const sourceType = String(p?.sourceType ?? "").toUpperCase();
  if (id !== String(tossPaymentId)) return { ok: false, reason: "결제 ID 가 주문과 다릅니다" };
  if (CANCELLED_PAYMENT_STATES.includes(state) || state.includes("CANCEL")) return { ok: false, reason: `취소된 결제입니다(${state})` };
  if (state !== "APPROVED") return { ok: false, reason: `승인 결제가 아닙니다(${state || "상태 없음"})` };
  if (!MATCH_SOURCE_TYPES.has(sourceType)) return { ok: false, reason: `카드·간편결제가 아닙니다(${sourceType || "방식 없음"})` };
  const amount = Math.round(Number(p?.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "결제 금액이 올바르지 않습니다" };
  if (amount > MAX_AUTO_MATCH_AMOUNT) return { ok: false, reason: `1건 자동 상한(${formatWon(MAX_AUTO_MATCH_AMOUNT)}) 초과` };
  return { ok: true };
}

// ───────────────────────── 2. 품목 → 반 칸 ─────────────────────────

/**
 * 품목을 수량만큼 펼친 반 이름 목록. 예: [{title:"목요일 3교시", quantity:2}] → ["목요일 3교시","목요일 3교시"]
 * 수량이 정수가 아니면(0·음수·소수) null — 사람이 본다.
 */
export function orderSlots(order) {
  const items = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const slots = [];
  for (const li of items) {
    const title = String(li?.item?.title ?? li?.title ?? li?.name ?? "").trim();
    if (!title) continue;
    const qty = li?.quantity == null ? 1 : Number(li.quantity);
    if (!Number.isInteger(qty) || qty < 1) return null;
    for (let i = 0; i < qty; i += 1) slots.push(title);
  }
  return slots;
}

// ───────────────────────── 3. 메모 이름 → 학생 ─────────────────────────

/**
 * 메모 이름 하나 → 학생(들). 규칙 a → b → c 순서.
 * @param {string} token
 * @param {{id:string,name:string,parentId?:string|null}[]} students 미병합 전체 학생
 * @returns {{ ok: true, students: object[], how: "FULL"|"GIVEN"|"SIBLINGS" } | { ok: false, reason: string }}
 */
export function resolveMemoToken(token, students) {
  const t = norm(token);
  const list = Array.isArray(students) ? students : [];
  if (!t) return { ok: false, reason: "빈 이름" };

  // a. 전체 이름 정확히 일치
  const full = list.filter((s) => norm(s.name) === t);
  if (full.length === 1) return { ok: true, students: full, how: "FULL" };
  if (full.length > 1) return { ok: false, reason: `«${token}» 동명이인 ${full.length}명` };

  // b. 이름만(성 없음)
  const given = givenNameMatches(t, list);
  if (given.length === 1) return { ok: true, students: given, how: "GIVEN" };
  if (given.length > 1) return { ok: false, reason: `«${token}» 이름이 같은 학생 ${given.length}명` };

  // c. 형제 이어 쓰기 — «루나루희»(이름만 2자씩) 또는 «김루나루희»(성 + 2자씩)
  const siblings = resolveSiblings(t, list);
  if (siblings.ok) return { ok: true, students: siblings.students, how: "SIBLINGS" };

  return { ok: false, reason: `«${token}» 명단에서 한 명으로 정해지지 않음` };
}

/** 성 뺀 이름이 같은 학생(성은 한 글자로 본다) */
function givenNameMatches(t, list) {
  if (t.length < 2 || t.length > 3) return [];
  return list.filter((s) => {
    const n = norm(s.name);
    return n.length === t.length + 1 && n.slice(1) === t;
  });
}

function chunks2(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 2) out.push(text.slice(i, i + 2));
  return out;
}

function sameGuardian(students) {
  const parents = new Set(students.map((s) => s.parentId ?? null));
  return parents.size === 1 && !parents.has(null) && new Set(students.map((s) => s.id)).size === students.length;
}

function resolveSiblings(t, list) {
  const tries = [];
  // 이름만 이어 쓰기: 4·6자
  if (t.length >= 4 && t.length % 2 === 0) {
    tries.push(chunks2(t).map((g) => givenNameMatches(g, list)));
  }
  // 성 + 이름 이어 쓰기: 5·7자
  if (t.length >= 5 && (t.length - 1) % 2 === 0) {
    const surname = t[0];
    tries.push(chunks2(t.slice(1)).map((g) => list.filter((s) => norm(s.name) === surname + g)));
  }
  const ok = [];
  for (const groups of tries) {
    if (!groups.every((g) => g.length === 1)) continue;
    const picked = groups.map((g) => g[0]);
    if (sameGuardian(picked)) ok.push(picked);
  }
  // 두 해석이 모두 되면(드묾) 고르지 않는다
  if (ok.length !== 1) return { ok: false };
  return { ok: true, students: ok[0] };
}

// ───────────────────────── 4. 청구 «쓸 수 있나» ─────────────────────────

/**
 * 청구 1건을 자동으로 닫아도 되는가. 막히면 사유, 괜찮으면 null.
 * @param {{amount:number,invoiceStatus?:string|null,invoiceAmount?:number|null,staffPending?:boolean,
 *          chargeRequestOpen?:boolean,rallyzMirror?:boolean,otherNotice?:boolean}} row
 */
export function chargeBlockReason(row) {
  if (!row.invoiceStatus) return "청구서가 없습니다";
  if (!OPEN_INVOICE.has(String(row.invoiceStatus).toUpperCase())) return `청구서 상태 ${row.invoiceStatus}`;
  if (Number(row.invoiceAmount) !== Number(row.amount)) return "청구서 금액이 청구와 다릅니다";
  if (row.staffPending) return "직원 현금·계좌 확인 대기 중";
  if (row.chargeRequestOpen) return "진행 중·보류된 현장 결제 요청이 있음";
  if (row.rallyzMirror) return "랠리즈 사본 청구";
  if (row.otherNotice) return "다른 POS 알림이 이미 반영";
  return null;
}

// ───────────────────────── 5. 배정 탐색 ─────────────────────────

/**
 * 반 칸 ↔ 청구 1:1 배정 중 «합계 = 결제액 + 필수 학생 모두 포함»인 청구 묶음을 모두 찾는다(중복 묶음은 하나로).
 * 2개를 찾으면 바로 멈춘다(이미 «한 가지가 아님»).
 * @returns {{ sets: object[][], exhausted: boolean }}
 */
export function findAllocations({ slots, charges, amount, requiredStudentIds }) {
  const required = new Set(requiredStudentIds ?? []);
  const order = [...slots].sort();
  const byClass = new Map();
  for (const c of charges) {
    const key = norm(c.className);
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(c);
  }
  const found = new Map();
  const used = new Set();
  const picked = [];
  let steps = 0;
  let exhausted = false;

  const walk = (i, sum) => {
    if (found.size > 1 || exhausted) return;
    steps += 1;
    if (steps > MAX_SEARCH_STEPS) {
      exhausted = true;
      return;
    }
    if (sum > amount) return;
    if (i === order.length) {
      if (sum !== amount) return;
      const covered = new Set(picked.map((c) => c.studentId));
      for (const id of required) if (!covered.has(id)) return;
      const key = picked.map((c) => c.id).sort().join("|");
      if (!found.has(key)) found.set(key, [...picked]);
      return;
    }
    // 같은 반 칸이 연달아 오면 앞 칸보다 «뒤» 청구만 고른다(같은 묶음의 순열을 다시 세지 않게)
    const options = byClass.get(norm(order[i])) ?? [];
    const sameAsPrev = i > 0 && norm(order[i]) === norm(order[i - 1]);
    const minIndex = sameAsPrev ? options.indexOf(picked[picked.length - 1]) + 1 : 0;
    for (let k = minIndex; k < options.length; k += 1) {
      const c = options[k];
      if (used.has(c.id)) continue;
      used.add(c.id);
      picked.push(c);
      walk(i + 1, sum + Number(c.amount));
      picked.pop();
      used.delete(c.id);
    }
  };
  walk(0, 0);
  return { sets: [...found.values()], exhausted };
}

// ───────────────────────── 6. 전체 판정 ─────────────────────────

/** 적용월 — 메모 달 하나 또는 승인일의 달. */
export function resolveAutoMatchMonth(memoRaw, kstDate) {
  const target = resolveTargetBillingMonth(memoRaw, kstDate);
  if (target.months.length !== 1) {
    return { ok: false, reason: target.months.length === 0 ? "적용월을 알 수 없습니다" : `메모에 달이 여럿입니다(${target.months.join(", ")})` };
  }
  const [y, m] = target.months[0].split("-").map(Number);
  return { ok: true, year: y, month: m, source: target.source };
}

/**
 * 결제 1건 판정.
 * @param {{
 *   order: object,                 // 토스 재조회 주문 원문(lineItems·memo·payments)
 *   tossPaymentId: string,
 *   amount: number,                // 결제 금액
 *   kstDate: string,               // 승인일 KST "YYYY-MM-DD"
 *   students: {id:string,name:string,parentId?:string|null,branch?:string|null}[], // 미병합 전체 학생
 *   charges: {id:string,studentId:string,className:string|null,amount:number,status:string,type?:string,
 *             year:number,month:number,invoiceStatus?:string|null,invoiceAmount?:number|null,
 *             staffPending?:boolean,chargeRequestOpen?:boolean,rallyzMirror?:boolean,otherNotice?:boolean}[],
 * }} input
 * @returns {{decision:"MATCH", year:number, month:number, rule:"NAMED"|"ANONYMOUS",
 *            allocations:{paymentId:string,studentId:string,studentName:string,className:string,amount:number}[]}
 *          | {decision:"HOLD", reason:string}}
 */
export function decideAutoMatch(input) {
  const { order, tossPaymentId, amount, kstDate } = input;
  const students = Array.isArray(input.students) ? input.students : [];
  const gate = checkPaymentGate(order, tossPaymentId);
  if (!gate.ok) return hold(gate.reason);

  const slots = orderSlots(order);
  if (slots == null) return hold("품목 수량이 올바르지 않습니다");
  if (slots.length === 0) return hold("품목이 없습니다");
  if (slots.length > MAX_SLOTS) return hold(`품목이 ${slots.length}칸으로 많습니다`);

  const memo = parseMemoNames(order);
  if (memo.unparsed.length > 0) return hold(`메모를 이름으로 읽지 못함: ${memo.unparsed.join(", ")}`);

  const month = resolveAutoMatchMonth(memo.memoRaw, kstDate);
  if (!month.ok) return hold(month.reason);

  const charges = (Array.isArray(input.charges) ? input.charges : []).filter(
    (c) =>
      Number(c.year) === month.year &&
      Number(c.month) === month.month &&
      String(c.type ?? "MONTHLY").toUpperCase() === "MONTHLY" &&
      UNPAID.has(String(c.status).toUpperCase()) &&
      c.className,
  );
  const studentById = new Map(students.map((s) => [s.id, s]));

  let sets;
  let rule;
  if (memo.names.length > 0) {
    // 이름 있는 결제 — 이름마다 학생을 정하고, 그 학생들 청구 안에서만 배정
    rule = "NAMED";
    const picked = new Map();
    for (const name of memo.names) {
      const r = resolveMemoToken(name, students);
      if (!r.ok) return hold(r.reason);
      for (const s of r.students) picked.set(s.id, s);
    }
    for (const s of picked.values()) {
      if (!isDasan2Branch(s.branch)) return hold(`${s.name}: 다산2호점 학생이 아닙니다`);
    }
    const ids = [...picked.keys()];
    const mine = charges.filter((c) => picked.has(c.studentId));
    const found = findAllocations({ slots, charges: mine, amount, requiredStudentIds: ids });
    if (found.exhausted) return hold("경우의 수가 너무 많습니다");
    sets = found.sets;
  } else {
    // 이름 없는 결제 — 학생 한 명의 청구로만 배정, 학원 전체에서 딱 한 가지일 때만
    rule = "ANONYMOUS";
    const byStudent = new Map();
    for (const c of charges) {
      if (!byStudent.has(c.studentId)) byStudent.set(c.studentId, []);
      byStudent.get(c.studentId).push(c);
    }
    sets = [];
    for (const [studentId, list] of byStudent) {
      const found = findAllocations({ slots, charges: list, amount, requiredStudentIds: [studentId] });
      if (found.exhausted) return hold("경우의 수가 너무 많습니다");
      sets.push(...found.sets);
      if (sets.length > 1) break;
    }
  }

  const monthText = `${month.year}년 ${month.month}월`;
  if (sets.length === 0) return hold(`${monthText} 미납 청구 중 반·금액(${formatWon(amount)})이 맞는 묶음이 없습니다`);
  if (sets.length > 1) return hold(`${monthText} 맞는 청구 묶음이 둘 이상입니다`);

  const chosen = sets[0];
  for (const c of chosen) {
    const blocked = chargeBlockReason(c);
    if (blocked) return hold(`${studentById.get(c.studentId)?.name ?? "학생"} ${c.className}: ${blocked}`);
    const s = studentById.get(c.studentId);
    if (!s) return hold("청구 학생이 명단(미병합)에 없습니다");
    if (!isDasan2Branch(s.branch)) return hold(`${s.name}: 다산2호점 학생이 아닙니다`);
  }
  return {
    decision: AUTO_MATCH.MATCH,
    year: month.year,
    month: month.month,
    rule,
    allocations: chosen
      .map((c) => ({
        paymentId: c.id,
        studentId: c.studentId,
        studentName: studentById.get(c.studentId)?.name ?? "",
        className: c.className,
        amount: Number(c.amount),
      }))
      .sort((a, b) => a.studentName.localeCompare(b.studentName, "ko") || a.className.localeCompare(b.className, "ko")),
  };
}

/** 슬랙 결과 줄 — «✅ POS 결제 확인 — 자동 매칭 납부 반영(11월): 김루나 목요일 3교시 90,000원 · …» */
export function buildAutoMatchResultLine(match, stamp) {
  const parts = match.allocations.map((a) => `${a.studentName} ${a.className} ${formatWon(a.amount)}`);
  return `✅ POS 결제 확인 — 사이트 ${match.month}월 청구 자동 매칭 납부 반영: ${parts.join(" · ")} (${stamp})`;
}
