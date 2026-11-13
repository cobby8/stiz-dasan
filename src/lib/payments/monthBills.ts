// 학부모 청구 «월 카드 + 세부 시트» 규칙 — 순수 함수(DB·시계·React 의존 0)
//
// 2026-11-14 원장 지시: «청구 카드에 할인 표시가 안 된다 · 카드에 세부 내역을 다 넣으니 복잡하다 ·
// 청구월·금액만 보여 주고 누르면 세부 내역을 모달로 · 청구서를 월별로 하나로 · 청구 관련 모든 화면에 똑같이».
//
// 왜 한 파일인가: 청구 탭(/mypage/payments)과 아이 기록(/mypage/record)이 같은 월 묶음·같은 할인 해석을 써야
// 한쪽만 고쳐지는 사고가 안 난다. 화면 부품(MonthBillCard·BillDetailSheet)도 이 파일만 본다.
// 실행 테스트: tests/parent-month-bills.test.mjs
//
// 할인이 어디 있는가(2026-11-14 운영 DB 확인): Payment 에는 할인 칸이 없다. 금액(amount)은 «할인 뒤 낼 금액»이고,
// 할인은 description 글 안에만 남아 있다(청구 작업대 발행분 «· 수강료 N · 할인 N · …», 옛 장부 이관분 «(할인 N, …)» 등).
// 그래서 글을 해석하되, 해석한 숫자로 다시 계산한 값이 실제 청구 금액과 «정확히 같을 때만» 보여 준다(틀린 숫자는 안 보인다).
import { PAYMENT_KIND_LABEL, paymentKind } from "@/lib/parent/childRecordRules";

/** 화면 두 곳이 공통으로 넘기는 청구 한 건 */
export type BillItemBase = {
  id: string;
  studentId: string;
  studentName: string;
  /** DB type(MONTHLY·SHUTTLE·SPECIAL·UNIFORM·OTHER…) */
  type: string | null;
  status: string;
  /** 낼 금액. 결제 권한이 없으면 null(금액·할인을 보이지 않는다) */
  amount: number | null;
  /** 청구 대상 연·월 — 비면 납기일의 달 */
  year: number | null;
  month: number | null;
  /** KST 달력 "YYYY-MM-DD" */
  dueYmd: string | null;
  paidYmd: string | null;
  description: string | null;
  receiptUrl: string | null;
  method?: string | null;
  paidProvider?: string | null;
};

// ── 상태 ────────────────────────────────────────────────────────────────────

export const BILL_ITEM_STATUS_LABEL: Record<string, string> = {
  PENDING: "미납",
  OVERDUE: "연체",
  PAID: "납부 완료",
  REFUNDED: "환불",
};
/** 영어 코드를 그대로 보이지 않는다 */
export function billItemStatusLabel(status: string): string {
  return BILL_ITEM_STATUS_LABEL[status] ?? "확인 중";
}
export function isBillUnpaid(status: string): boolean {
  return status === "PENDING" || status === "OVERDUE";
}

/** 한 달 카드의 상태 한 단어 */
export type MonthBillStatus = "UNPAID" | "OVERDUE" | "PARTIAL" | "PAID" | "REFUNDED";
export const MONTH_BILL_STATUS_LABEL: Record<MonthBillStatus, string> = {
  UNPAID: "미납",
  OVERDUE: "연체",
  PARTIAL: "일부 납부",
  PAID: "납부 완료",
  REFUNDED: "환불",
};
/** 색 — statusTones 의 갈래 이름(미납·일부 = 주의, 연체 = 위험, 완료 = 정상, 환불 = 중립) */
export const MONTH_BILL_STATUS_TONE: Record<MonthBillStatus, "warning" | "danger" | "success" | "neutral"> = {
  UNPAID: "warning",
  OVERDUE: "danger",
  PARTIAL: "warning",
  PAID: "success",
  REFUNDED: "neutral",
};

/** 환불을 뺀 «살아 있는» 청구로 판정: 전부 환불 → 환불 · 미납 없음 → 납부 완료 · 전부 미납 → 미납(연체 있으면 연체) · 섞임 → 일부 납부 */
export function monthBillStatus(items: readonly Pick<BillItemBase, "status">[]): MonthBillStatus {
  const live = items.filter((item) => item.status !== "REFUNDED");
  if (live.length === 0) return "REFUNDED";
  const unpaid = live.filter((item) => isBillUnpaid(item.status));
  if (unpaid.length === 0) return "PAID";
  if (unpaid.length === live.length) return unpaid.some((item) => item.status === "OVERDUE") ? "OVERDUE" : "UNPAID";
  return "PARTIAL";
}

// ── 청구 달 ──────────────────────────────────────────────────────────────────

/** 청구 달 "YYYY-MM": 청구 대상 연·월이 맞으면 그것, 아니면 납기일(KST)의 달, 둘 다 없으면 "" */
export function billMonth(item: Pick<BillItemBase, "year" | "month" | "dueYmd">): string {
  const y = Number(item.year);
  const m = Number(item.month);
  if (item.year !== null && item.month !== null && Number.isInteger(y) && y >= 2000 && y <= 2100 && Number.isInteger(m) && m >= 1 && m <= 12) {
    return `${y}-${String(m).padStart(2, "0")}`;
  }
  return typeof item.dueYmd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dueYmd) ? item.dueYmd.slice(0, 7) : "";
}

/** «12월»(올해) · «2025년 12월»(다른 해) · «날짜 미정» */
export function billMonthLabel(ym: string, thisYear: string): string {
  if (!/^\d{4}-\d{2}$/.test(ym)) return "날짜 미정";
  const month = `${Number(ym.slice(5, 7))}월`;
  return ym.startsWith(thisYear) ? month : `${ym.slice(0, 4)}년 ${month}`;
}

// ── 할인 해석 ────────────────────────────────────────────────────────────────

export type BillBreakdown = {
  /** 원래 금액(할인 전 — 수강료 + 셔틀 등) */
  original: number;
  /** 뺀 금액들(양수) — 할인(사유)·기간 조정·이월 차감 */
  deductions: { label: string; amount: number }[];
  /** 낼 금액 = 청구 금액 */
  payable: number;
};

const num = (text: string | undefined): number => Number(String(text ?? "").replace(/,/g, ""));

/**
 * 청구 글에서 «원래 금액 − 할인 = 낼 금액»을 읽는다. 뺀 금액이 없으면 null(보여 줄 것이 없다).
 * 해석한 숫자로 계산한 낼 금액이 실제 금액과 다르면 null — 틀린 할인을 보이느니 안 보인다.
 */
export function parseBillBreakdown(description: string | null, amount: number | null): BillBreakdown | null {
  if (!description || amount === null || !Number.isFinite(amount)) return null;
  const text = description.replace(/\s+/g, " ");
  let result: BillBreakdown | null = null;

  // ① 청구 작업대 발행분: «… · 수강료 80000 · 할인 8000 · 기간조정 0 · 이월 0 · 셔틀 0»
  const bench = text.match(/· 수강료 (\d+) · 할인 (\d+) · 기간조정 (-?\d+) · 이월 (\d+) · 셔틀 (\d+)/);
  if (bench) {
    const [base, discount, proration, carry, shuttle] = bench.slice(1, 6).map(num);
    result = {
      original: base + shuttle,
      deductions: [
        { label: "할인", amount: discount },
        { label: "기간 조정", amount: proration },
        { label: "이월 차감", amount: carry },
      ].filter((item) => item.amount !== 0),
      payable: amount,
    };
  }

  // ② 옛 장부 이관분: «금액 60000원(할인 60000, 셔틀·기타 0)» — 금액은 할인 뒤 금액
  const ledger = !result && text.match(/금액 ([\d,]+)원\(할인 ([\d,]+), 셔틀·기타 ([\d,]+)\)/);
  if (ledger) {
    const [net, discount] = [num(ledger[1]), num(ledger[2])];
    if (net === amount) result = { original: net + discount, deductions: discount > 0 ? [{ label: "할인", amount: discount }] : [], payable: amount };
  }

  // ③ 11월 사본: «교습비 120,000 - 개시 할인 30,000(4회 중 3회) + 셔틀비 10,000» · «정가 100,000 - 주3회 할인 30,000»
  //    («정가 − 형제할인 10%» 처럼 % 로 끝나는 것은 ④ 몫 — 숫자 뒤에 % 가 오면 여기서 잡지 않는다)
  const copy = !result && text.match(/(?:교습비|정가) ([\d,]+)원? [-−] ([가-힣0-9 ]*?할인) ([\d,]+)(?![\d,%])원?(\([^)]*\))?(?: \+ 셔틀비 ([\d,]+))?/);
  if (copy) {
    const reason = `${copy[2].trim()}${copy[4] ? ` ${copy[4]}` : ""}`;
    result = { original: num(copy[1]) + num(copy[5]), deductions: [{ label: reason, amount: num(copy[3]) }], payable: amount };
  }

  // ④ 비율 할인 사본: «교습비 108,000(정가 120,000 − 형제할인 10%) + 셔틀비 10,000» — 할인 = 정가 − 교습비
  const percent = !result && text.match(/교습비 ([\d,]+)\(정가 ([\d,]+) [-−] ([가-힣0-9 ]*?할인) ?(\d+%)\)(?: \+ 셔틀비 ([\d,]+))?/);
  if (percent) {
    const [net, list, shuttle] = [num(percent[1]), num(percent[2]), num(percent[5])];
    result = { original: list + shuttle, deductions: [{ label: `${percent[3].trim()} ${percent[4]}`, amount: list - net }], payable: amount };
  }

  // ⑤ 손으로 적은 사본: «수강료100000-주2회할인20000» · «수강료120000-주2회할인30000+셔틀15000»
  const manual = !result && text.match(/수강료 ?([\d,]+) ?- ?([가-힣0-9]*할인) ?([\d,]+)(?: ?\+ ?셔틀 ?([\d,]+))?/);
  if (manual) {
    result = { original: num(manual[1]) + num(manual[4]), deductions: [{ label: manual[2], amount: num(manual[3]) }], payable: amount };
  }

  if (!result || result.deductions.length === 0) return null;
  const computed = result.original - result.deductions.reduce((sum, item) => sum + item.amount, 0);
  return computed === amount && result.deductions.every((item) => item.amount > 0) ? result : null;
}

/** 할인(뺀 금액) 합계 — 해석이 안 되면 0 */
export function billDiscountTotal(item: Pick<BillItemBase, "description" | "amount">): number {
  return parseBillBreakdown(item.description, item.amount)?.deductions.reduce((sum, d) => sum + d.amount, 0) ?? 0;
}

// ── 항목 이름 · 결제수단 · 날짜 ──────────────────────────────────────────────

// 관리자 장부용 글(이관·사본 메모)은 학부모에게 보이지 않는다 — 이런 말이 들어 있으면 종류 이름으로 대신한다
const LEDGER_WORDS = /사본|이관|장부|동기화|imported|랠리즈|시트|POS|대조|발송|원장|청구 제외|·|\d{4}-\d{2}-\d{2}/i;

/** 세부 시트의 항목 이름 — «수강료 · 월요일 6교시» / 짧고 깨끗한 청구 글 / 종류 이름 */
export function billItemLabel(item: Pick<BillItemBase, "type" | "description">): string {
  const kind = PAYMENT_KIND_LABEL[paymentKind(item.type)];
  const text = (item.description ?? "").replace(/\s+/g, " ").trim();
  // 청구 작업대 제목 «2026-12 {반 이름} 수강료 · …» 에서 반 이름
  const benchClass = text.match(/^\d{4}-\d{2} (.+?) 수강료 ·/);
  if (benchClass) return `${kind} · ${benchClass[1]}`;
  const weekday = text.match(/([월화수목금토일])요일 ?(\d+) ?교시/);
  if (weekday) return `${kind} · ${weekday[1]}요일 ${weekday[2]}교시`;
  if (text && text.length <= 24 && !LEDGER_WORDS.test(text)) return text;
  return kind;
}

const METHOD_CODE_LABEL: Record<string, string> = { CARD: "카드", CASH: "현금", TRANSFER: "계좌이체", RALLYZ: "랠리즈" };

/** 결제수단 글자 — 이미 한국어면 그대로, 토스 온라인 = «온라인 결제», 토스 단말기 = «현장 카드». 모르면 null(안 보인다) */
export function billMethodLabel(method: string | null | undefined, paidProvider: string | null | undefined): string | null {
  const m = (method ?? "").trim();
  if (/[가-힣]/.test(m)) return m;
  if (paidProvider === "TOSS") return "온라인 결제";
  if (paidProvider === "TOSS_POS" || paidProvider === "TOSS_TERMINAL") return "현장 카드";
  return METHOD_CODE_LABEL[m] ?? (paidProvider === "RALLYZ" ? METHOD_CODE_LABEL.RALLYZ : null);
}

/** "2026-11-03" → "26.11.03" */
export function shortYmd(ymd: string | null | undefined): string {
  return ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(2, 4)}.${ymd.slice(5, 7)}.${ymd.slice(8, 10)}` : "";
}

/** "255,000원" */
export function wonText(n: number): string {
  return `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
}

// ── 월 묶음 ──────────────────────────────────────────────────────────────────

export type MonthBill<T extends BillItemBase> = {
  /** "YYYY-MM" (청구 달이 없으면 "") */
  ym: string;
  label: string;
  items: T[];
  /** 환불 제외 합계. 금액을 볼 수 없는 화면(결제 권한 없음)이면 null */
  total: number | null;
  /** 미납·연체 합계 */
  unpaidTotal: number | null;
  unpaidCount: number;
  /** 해석된 할인 합계(환불 제외) */
  discountTotal: number;
  status: MonthBillStatus;
  /** 이 달에 청구가 있는 아이 수 — 형제면 시트에서 아이별로 나눠 보인다 */
  studentCount: number;
};

/**
 * 청구를 «청구 달» 하나에 카드 하나로 묶는다(최신 달부터, 날짜 미정은 맨 뒤).
 * 형제·종류(수강료·셔틀·특강·유니폼)가 섞여도 한 카드 — 합계는 환불을 뺀다.
 * 한 달 안에서는 미납 먼저 → 아이 이름 → 납기일 최신순.
 */
export function groupBillsByMonth<T extends BillItemBase>(items: readonly T[], thisYear: string): MonthBill<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (item.status === "CANCELED" || item.status === "CANCELLED") continue; // 취소 청구는 보이지 않는다
    const ym = billMonth(item);
    map.set(ym, [...(map.get(ym) ?? []), item]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === "" ? 1 : b === "" ? -1 : a < b ? 1 : -1))
    .map(([ym, list]) => {
      const sorted = [...list].sort((x, y) => {
        const ux = isBillUnpaid(x.status) ? 0 : 1, uy = isBillUnpaid(y.status) ? 0 : 1;
        if (ux !== uy) return ux - uy;
        if (x.studentName !== y.studentName) return x.studentName.localeCompare(y.studentName, "ko");
        return (y.dueYmd ?? "").localeCompare(x.dueYmd ?? "");
      });
      const live = sorted.filter((item) => item.status !== "REFUNDED");
      const hidden = sorted.some((item) => item.amount === null);
      const sum = (rows: T[]) => rows.reduce((acc, item) => acc + (Number(item.amount) || 0), 0);
      const unpaid = live.filter((item) => isBillUnpaid(item.status));
      return {
        ym,
        label: billMonthLabel(ym, thisYear),
        items: sorted,
        total: hidden ? null : sum(live),
        unpaidTotal: hidden ? null : sum(unpaid),
        unpaidCount: unpaid.length,
        discountTotal: hidden ? 0 : live.reduce((acc, item) => acc + billDiscountTotal(item), 0),
        status: monthBillStatus(sorted),
        studentCount: new Set(sorted.map((item) => item.studentId)).size,
      };
    });
}
