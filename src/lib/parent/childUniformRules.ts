// 학부모 «아이 정보»의 유니폼 번호·유니폼 신청 내역 규칙(순수 함수 — 테스트에서 바로 부른다). 2026-11-16 원장 지시.
//
// ★ 주문 표(UniformOrder·UniformOrderItem)에는 학생 id·학부모 계정 id 가 없다 — «보호자 전화번호 + 학생 이름»뿐이다.
//   그래서 «이 아이의 주문»은 아래 두 조건을 «모두» 만족하는 품목만으로 정한다(이름만으로는 절대 찾지 않는다 — 동명이인):
//     1) 주문의 parentPhoneDigits = 로그인한 학부모 본인 계정 전화번호(숫자만, 열쇠로 쓸 수 있는 번호일 때만)
//     2) 품목의 학생 이름(띄어쓰기 제거) = 아이 이름(띄어쓰기 제거 + 끝의 영문·숫자 구분 글자 A/B 제거)
//   SQL(childUniformQuery)이 같은 조건으로 고르고, 여기서 한 번 더 거른다(이중 확인).
// ★ 화면으로 내보내는 값은 ChildUniformOrderView 칸뿐 — 전화번호·보호자 이름·메모·본사 연동 값·오류 글은 넣지 않는다.
import { isUsablePhoneKey, parentPhoneDigits } from "@/lib/enrollment/parentIdentity";
import type { StatusTone } from "@/lib/ui/statusTones";

/** 주문 품목의 학생 이름 비교 열쇠 — 띄어쓰기만 지운다(SQL: regexp_replace(name, '\s', '', 'g')) */
export function orderItemNameKey(name: unknown): string {
  return String(name ?? "").replace(/\s+/g, "");
}

/**
 * 아이 이름 비교 열쇠 — 띄어쓰기를 지우고 끝의 영문·숫자 구분 글자(동명이인 구분용 A/B 등)를 뗀다.
 * 다 떼면 빈 글자가 되는 이름(영문 이름 등)은 띄어쓰기만 지운 값을 쓴다.
 */
export function childUniformNameKey(name: unknown): string {
  const compact = orderItemNameKey(name);
  const stripped = compact.replace(/[A-Za-z0-9]+$/, "");
  return stripped.length > 0 ? stripped : compact;
}

/** 로그인 학부모 전화번호 → 주문 비교 열쇠. 쓸 수 없는 번호(비었음·자리채움)면 null = 주문을 찾지 않는다 */
export function parentOrderPhoneKey(phone: unknown): string | null {
  const digits = parentPhoneDigits(phone);
  return isUsablePhoneKey(digits) ? digits : null;
}

/** 업체(본사)에 주문이 실제로 들어간 연동 상태 — student-register-rules 의 판정과 같은 값 */
const ORDERED_SYNC = new Set(["SENT", "DUPLICATE"]);

/**
 * 진행 상태 한 단어(학부모용).
 *  취소(CANCELED) → «취소» · 본사 주문 들어감(주문번호 있음·전송 완료·업체 중복) → «주문 완료» · 그 밖(접수만) → «접수»
 */
export function parentUniformOrderStatus(input: { orderStatus: unknown; stizSyncStatus: unknown; hasOrderNumber: unknown }): { label: string; tone: StatusTone } {
  if (String(input.orderStatus ?? "") === "CANCELED") return { label: "취소", tone: "neutral" };
  if (input.hasOrderNumber === true || ORDERED_SYNC.has(String(input.stizSyncStatus ?? ""))) return { label: "주문 완료", tone: "success" };
  return { label: "접수", tone: "info" };
}

/** SQL 이 돌려준 한 행(조건 확인용 칸 포함 — 화면으로는 나가지 않는다) */
export type ChildUniformOrderRow = {
  itemId: unknown;
  appliedYmd: unknown;
  design: unknown;
  backNumber: unknown;
  topSize: unknown;
  bottomSize: unknown;
  quantity: unknown;
  orderStatus: unknown;
  stizSyncStatus: unknown;
  hasOrderNumber: unknown;
  /** 확인용 — 화면으로 내보내지 않는다 */
  parentPhoneDigits: unknown;
  /** 확인용 — 화면으로 내보내지 않는다 */
  studentName: unknown;
};

/** 화면으로 나가는 주문 품목 한 줄 — 이 칸 말고는 내보내지 않는다 */
export type ChildUniformOrderView = {
  id: string;
  /** 신청일(KST) "YYYY-MM-DD" */
  appliedYmd: string | null;
  design: string | null;
  /** 등번호 — 숫자 글자 그대로("0" 도 번호) */
  backNumber: string | null;
  topSize: string | null;
  bottomSize: string | null;
  quantity: number;
  statusLabel: string;
  statusTone: StatusTone;
  /** 어디서 낸 주문인가 — 화면에 «사이트»/«쇼핑몰» 글자로 보인다(옛 데이터엔 없을 수 있다) */
  source?: "site" | "shop";
};

const text = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
  return s.length > 0 ? s : null;
};

/**
 * SQL 결과 → 화면 줄. 전화번호 열쇠·아이 이름 열쇠와 다시 맞춰 보고(이중 확인) 맞는 것만 남긴다.
 * 열쇠가 하나라도 없으면 빈 목록.
 */
export function toChildUniformOrders(rows: ChildUniformOrderRow[], keys: { phoneKey: string | null; childNameKey: string }): ChildUniformOrderView[] {
  if (!keys.phoneKey || !keys.childNameKey) return [];
  return rows
    .filter((r) => String(r.parentPhoneDigits ?? "") === keys.phoneKey && orderItemNameKey(r.studentName) === keys.childNameKey)
    .map((r) => {
      const status = parentUniformOrderStatus(r);
      const qty = Number(r.quantity ?? 1);
      const ymd = text(r.appliedYmd);
      return {
        id: String(r.itemId),
        appliedYmd: ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : null,
        design: text(r.design),
        backNumber: text(r.backNumber),
        topSize: text(r.topSize),
        bottomSize: text(r.bottomSize),
        quantity: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1,
        statusLabel: status.label,
        statusTone: status.tone,
        source: "site" as const,
      };
    });
}

// ── 본사 쇼핑몰(stiz.kr) 주문(2026-11-16 원장 «쇼핑몰 주문도 학부모 화면에 보이게») ──────────────
//
// ★ 쇼핑몰 주문의 «이 아이의 주문» 조건(둘 다):
//   1) 주문의 구매자 번호 또는 수령인 번호 = 로그인한 학부모 본인 계정 전화번호(열쇠로 쓸 수 있는 번호일 때만)
//   2) 품목의 학생 이름(띄어쓰기 제거) = 아이 이름 열쇠 — 학생 이름이 빈 품목은 보이지 않는다(전화번호만으로는 형제 구분이 안 된다)
// ★ 송장번호·전화번호·학생 이름·인쇄 이름은 화면으로 내보내지 않는다.

/** 쇼핑몰 품목 상태 → 학부모용 한 단어 + 상태색(완료 초록·주의 노랑·안내 파랑·취소 회색) */
const SHOP_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  UNPAID: { label: "입금 전", tone: "warning" },
  PAID: { label: "결제 완료", tone: "info" },
  PREPARING: { label: "준비 중", tone: "info" },
  SHIPPING: { label: "배송 중", tone: "info" },
  DELIVERED: { label: "배송 완료", tone: "success" },
  CANCELED: { label: "취소", tone: "neutral" },
  RETURNED: { label: "반품", tone: "neutral" },
  UNKNOWN: { label: "확인 중", tone: "info" },
};

/** 쇼핑몰 주문 상태 — 주문 전체가 취소면 품목 상태와 상관없이 «취소», 모르는 값은 «확인 중» */
export function shopUniformOrderStatus(input: { itemStatus: unknown; canceled: unknown }): { label: string; tone: StatusTone } {
  if (input.canceled === true) return SHOP_STATUS.CANCELED;
  return SHOP_STATUS[String(input.itemStatus ?? "")] ?? SHOP_STATUS.UNKNOWN;
}

/** SQL 이 돌려준 쇼핑몰 한 행(조건 확인용 칸 포함 — 화면으로는 나가지 않는다) */
export type ChildShopUniformOrderRow = {
  itemId: unknown;
  orderYmd: unknown;
  design: unknown;
  backNumber: unknown;
  topSize: unknown;
  bottomSize: unknown;
  quantity: unknown;
  itemStatus: unknown;
  canceled: unknown;
  /** 확인용 — 화면으로 내보내지 않는다 */
  buyerPhoneDigits: unknown;
  /** 확인용 — 화면으로 내보내지 않는다 */
  receiverPhoneDigits: unknown;
  /** 확인용 — 화면으로 내보내지 않는다 */
  studentName: unknown;
};

/** 쇼핑몰 SQL 결과 → 화면 줄. 전화번호(구매자·수령인 중 하나)·이름 열쇠를 다시 맞춘다(이중 확인) */
export function toChildShopUniformOrders(rows: ChildShopUniformOrderRow[], keys: { phoneKey: string | null; childNameKey: string }): ChildUniformOrderView[] {
  if (!keys.phoneKey || !keys.childNameKey) return [];
  return rows
    .filter((r) => {
      const phoneMatch = String(r.buyerPhoneDigits ?? "") === keys.phoneKey || String(r.receiverPhoneDigits ?? "") === keys.phoneKey;
      const name = orderItemNameKey(r.studentName);
      // 학생 이름이 빈 품목은 형제 구분이 안 되므로 버린다
      return phoneMatch && name.length > 0 && name === keys.childNameKey;
    })
    .map((r) => {
      const status = shopUniformOrderStatus(r);
      const qty = Number(r.quantity ?? 1);
      const ymd = text(r.orderYmd);
      return {
        // 사이트 주문 id(uuid)와 섞여도 겹치지 않게 앞에 표시
        id: `shop:${String(r.itemId)}`,
        appliedYmd: ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : null,
        design: text(r.design),
        backNumber: text(r.backNumber),
        topSize: text(r.topSize),
        bottomSize: text(r.bottomSize),
        quantity: Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1,
        statusLabel: status.label,
        statusTone: status.tone,
        source: "shop" as const,
      };
    });
}

/** 사이트 주문 + 쇼핑몰 주문 → 신청일 최신순(같은 날은 원래 순서 — 사이트 먼저). 날짜 없는 줄은 맨 뒤 */
export function mergeChildUniformOrders(site: ChildUniformOrderView[], shop: ChildUniformOrderView[]): ChildUniformOrderView[] {
  return [...site, ...shop]
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const ay = a.o.appliedYmd ?? "";
      const by = b.o.appliedYmd ?? "";
      if (ay !== by) return ay < by ? 1 : -1;
      return a.i - b.i;
    })
    .map(({ o }) => o);
}

/** 출처 글자 — 색이 아니라 글자로 구분한다. 옛 데이터(칸 없음)는 글자 없음 */
export function uniformOrderSourceLabel(source: ChildUniformOrderView["source"]): string | null {
  if (source === "shop") return "쇼핑몰";
  if (source === "site") return "사이트";
  return null;
}

/** 주문 한 줄의 내용 글자 — «기본형 · 23번 · 상의 130 · 하의 130 · 1벌» (값이 있는 것만) */
export function uniformOrderLine(o: Pick<ChildUniformOrderView, "design" | "backNumber" | "topSize" | "bottomSize" | "quantity">): string {
  return [
    o.design ?? "유니폼",
    // 길이로 본다 — "0" 도 등번호다
    o.backNumber !== null && o.backNumber.length > 0 ? `${o.backNumber}번` : null,
    o.topSize ? `상의 ${o.topSize}` : null,
    o.bottomSize ? `하의 ${o.bottomSize}` : null,
    `${o.quantity}벌`,
  ]
    .filter((v) => v !== null)
    .join(" · ");
}

/**
 * «아이 정보»의 유니폼 한 줄 — 보유 상태(있으면) + 유니폼 번호 + 대표팀 번호(값이 있는 것만).
 * 번호가 둘 다 없으면 «번호 없음». ⚠️ "0" 은 번호다 — 참/거짓이 아니라 길이로 판정한다.
 */
export function uniformProfileLine(input: { status?: string | null; number?: string | null; teamNumber?: string | null }): string {
  const status = (input.status ?? "").trim();
  const hobby = (input.number ?? "").trim();
  const team = (input.teamNumber ?? "").trim();
  const numbers = [hobby.length > 0 ? `유니폼 번호 ${hobby}번` : null, team.length > 0 ? `대표팀 번호 ${team}번` : null].filter((v) => v !== null);
  return [status.length > 0 ? status : null, ...(numbers.length > 0 ? numbers : ["번호 없음"])].filter((v) => v !== null).join(" · ");
}
