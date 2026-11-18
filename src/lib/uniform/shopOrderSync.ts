// 본사 쇼핑몰(stiz.kr·카페24) 유니폼 주문 → 우리 DB 동기화(2026-11-16 원장 «쇼핑몰 주문도 학부모 화면에 보이게»).
//
// 흐름: cron(/api/cron/uniform-shop-sync) → fetchClubOrders(서명 GET) → parseClubOrdersResponse(모양 검증)
//       → planShopOrderUpsert(저장할 행) → upsertShopOrders(한 SQL 문으로 upsert)
//
// ★ 지키는 것
//   1) 필수 칸이 빠졌거나 형식이 다르면 «통째로» 거부한다 — 일부만 저장하지 않는다.
//      본사가 새로 붙인 «모르는 추가 칸»은 거부하지 않고 무시한다(읽지도 저장하지도 않는다, 2026-11-17) —
//      본사가 칸 하나를 더했다고 동기화 전체가 멈추지 않게.
//   2) upsert 만 한다. 본사 응답에 없는 주문을 지우지 않는다(기간 밖일 뿐일 수 있다).
//      다만 «응답에 들어온 주문»에서 빠진 품목은 status 를 'CANCELED' 로 표시한다(삭제 아님, 2026-11-17) —
//      주문에서 품목이 빠졌는데 옛 상태(배송 중 등)가 학부모 화면에 계속 남지 않게.
//   3) 실패하면 아무것도 저장·삭제하지 않는다(저장은 검증이 끝난 뒤 한 SQL 문으로만).
//   4) 비밀키·전화번호·이름은 로그·오류 글·응답에 넣지 않는다. 전화번호를 주소(쿼리)에 넣지 않는다.
//   5) 이름·주소·금액은 저장하지 않는다(본사도 주지 않는다). 학생 이름은 «품목의 학생 이름» 하나뿐.
// 날짜: 주문일은 본사가 KST 달력 날짜("YYYY-MM-DD")로 준다 → date 칸에 그대로. 오늘·N일 전은 kst.ts 로만.
import { createHmac } from "node:crypto";
import { canonicalJson, STIZ_PARTNER_ID } from "@/lib/uniform-partner";
import { addDaysKst, diffDaysKst, isKstYmd, todayKst } from "@/lib/datetime/kst";

export const CLUB_ORDERS_PATH = "/api/partner/club-orders";
export const CLUB_ORDERS_DEFAULT_URL = `https://custom.stiz.kr${CLUB_ORDERS_PATH}`;
/** 본사 창구 한 번에 받을 수 있는 최대 기간(오늘 포함 일수) */
export const CLUB_ORDERS_MAX_DAYS = 80;
/**
 * cron 기본 — 오늘 포함 최근 80일(본사 창구 최대치, 2026-11-17 원장 승인).
 * 왜 14일이 아닌가: 14일이면 주문 뒤 15일째부터 그 주문을 다시 받지 않아 상태가 «준비 중»·«배송 중»에서 멈춘다
 *   (맞춤 유니폼은 제작·배송이 2주를 넘기는 일이 흔하다).
 * 매시 17분마다 80일 창을 받아도 되는 이유:
 *   · 기간 검증 — resolveSyncRange 가 만드는 from(오늘-79일)~to(오늘)는 «오늘 포함 80일» 상한과 같은 값이라 그대로 통과한다.
 *   · 저장 — 한 SQL 문 upsert 라 같은 주문을 다시 받아도 행이 늘지 않는다(멱등).
 *   · 크기 — 한 지점(다산)의 유니폼 주문만 오고 주문당 칸이 적어, 80일치도 수백 건·수십~수백 KB 수준이다.
 *   · 시간 — 받기 20초 × 최대 2번 + 저장 1문장 < 함수 제한 60초(vercel.json 기본).
 * ⚠️ 본사 쪽 80일 응답이 20초를 넘기 시작하면 «본사 응답 시간 초과»로 실패한다(저장 없음·슬랙 알림) —
 *    그때는 이 값을 줄이거나 시간 제한을 늘린다.
 */
export const CLUB_ORDERS_DEFAULT_DAYS = CLUB_ORDERS_MAX_DAYS;
const FETCH_TIMEOUT_MS = 20_000;

export const SHOP_ITEM_STATUSES = ["UNPAID", "PAID", "PREPARING", "SHIPPING", "DELIVERED", "CANCELED", "RETURNED", "UNKNOWN"] as const;
export type ShopItemStatus = (typeof SHOP_ITEM_STATUSES)[number];

/** 비밀값·개인정보 없는 실패(글자는 그대로 응답·로그에 써도 된다) */
export class ShopOrderSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopOrderSyncError";
  }
}

// ── 서명 ────────────────────────────────────────────────────────────────────

/** 서명할 글자 — `${ts}.dasan.${canonicalJson({ method, path, query })}` (본사와 같은 규칙) */
export function clubOrdersSigningString(input: { timestamp: number; club: string; from: string; to: string }): string {
  return `${input.timestamp}.${STIZ_PARTNER_ID}.${canonicalJson({
    method: "GET",
    path: CLUB_ORDERS_PATH,
    query: { club: input.club, from: input.from, to: input.to },
  })}`;
}

/** 소문자 hex HMAC-SHA256 */
export function signClubOrdersRequest(input: { secret: string; timestamp: number; club: string; from: string; to: string }): string {
  return createHmac("sha256", input.secret).update(clubOrdersSigningString(input), "utf8").digest("hex");
}

// ── 기간 ────────────────────────────────────────────────────────────────────

export type SyncRange = { from: string; to: string };

/**
 * cron 쿼리 → 받을 기간. 아무것도 없으면 «오늘 포함 최근 80일»(CLUB_ORDERS_DEFAULT_DAYS).
 *  ?days=N (1~80, 오늘 포함 N일) 또는 ?from=YYYY-MM-DD&to=YYYY-MM-DD (from ≤ to, 오늘 포함 80일 이내 길이)
 * 잘못된 값이면 { error } — 조용히 기본값으로 바꾸지 않는다(처음 채우기 때 잘못 받은 줄 모르게 된다).
 */
export function resolveSyncRange(input: { nowMs: number; days?: string | null; from?: string | null; to?: string | null }): SyncRange | { error: string } {
  const today = todayKst(input.nowMs);
  const hasFrom = input.from !== null && input.from !== undefined && input.from !== "";
  const hasTo = input.to !== null && input.to !== undefined && input.to !== "";
  const hasDays = input.days !== null && input.days !== undefined && input.days !== "";
  if (hasFrom || hasTo) {
    if (hasDays) return { error: "days 와 from·to 는 함께 쓸 수 없습니다" };
    if (!hasFrom || !hasTo || !isKstYmd(input.from) || !isKstYmd(input.to)) return { error: "from·to 는 YYYY-MM-DD 로 둘 다 필요합니다" };
    const span = diffDaysKst(input.from as string, input.to as string);
    if (!(span >= 0)) return { error: "from 이 to 보다 늦습니다" };
    // 오늘 포함 일수(span+1)가 80일을 넘지 않게
    if (span + 1 > CLUB_ORDERS_MAX_DAYS) return { error: `기간은 최대 ${CLUB_ORDERS_MAX_DAYS}일입니다` };
    return { from: input.from as string, to: input.to as string };
  }
  let days = CLUB_ORDERS_DEFAULT_DAYS;
  if (hasDays) {
    if (!/^\d{1,3}$/.test(String(input.days))) return { error: "days 는 1~80 사이 숫자입니다" };
    days = Number(input.days);
    if (days < 1 || days > CLUB_ORDERS_MAX_DAYS) return { error: "days 는 1~80 사이 숫자입니다" };
  }
  return { from: addDaysKst(today, -(days - 1)), to: today };
}

// ── 응답 검증 ───────────────────────────────────────────────────────────────

export type ShopOrderItemInput = {
  itemCode: string;
  productNo: number;
  design: string | null;
  studentName: string | null;
  printName: string | null;
  number: string | null;
  topSize: string | null;
  bottomSize: string | null;
  quantity: number;
  status: ShopItemStatus;
  trackingNo: string | null;
};

export type ShopOrderInput = {
  cafe24OrderId: string;
  orderDate: string;
  paid: boolean;
  canceled: boolean;
  buyerPhoneDigits: string | null;
  receiverPhoneDigits: string | null;
  items: ShopOrderItemInput[];
};

const TOP_KEYS = ["success", "club", "from", "to", "count", "fetchedAt", "orders"];
const ORDER_KEYS = ["cafe24OrderId", "orderDate", "paid", "canceled", "buyerPhoneDigits", "receiverPhoneDigits", "items"];
const ITEM_KEYS = ["itemCode", "productNo", "design", "studentName", "printName", "number", "topSize", "bottomSize", "quantity", "status", "trackingNo"];
/** 품목 글자 칸 — 글자 또는 null */
const ITEM_TEXT_KEYS = ["design", "studentName", "printName", "number", "topSize", "bottomSize", "trackingNo"] as const;
const MAX_TEXT = 200;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/**
 * 필수 칸이 «모두» 있는가 — 빠진 칸은 거부, 모르는 추가 칸은 통과(무시).
 * 추가 칸은 아래에서 이름을 짚어 꺼내는 칸에 들지 않으므로 저장·화면 어디에도 쓰이지 않는다.
 */
const hasRequiredKeys = (v: Record<string, unknown>, keys: string[]) => keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
const isTextOrNull = (v: unknown) => v === null || (typeof v === "string" && v.length <= MAX_TEXT);
/** 전화번호 — 숫자만 1~20자리, null, 또는 빈 글자(""= 번호 없음, 저장할 때 null 로 바꾼다) */
const isPhoneDigitsOrNull = (v: unknown) => v === null || (typeof v === "string" && /^\d{0,20}$/.test(v));
/** 빈 글자 전화번호는 null — 빈 글자끼리 «같은 번호»로 맞춰지는 일을 막는다 */
const phoneOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
/** 주문번호·품목 코드 — 주소·id 에 쓰이므로 안전한 글자만 */
const isCode = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
/** 앞뒤 공백 정리, 빈 글자는 null */
const clean = (v: string | null): string | null => {
  if (v === null) return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
};

export type ParseResult = { ok: true; orders: ShopOrderInput[] } | { ok: false, reason: string };

/**
 * 본사 응답 → 검증된 주문 목록. 필수 칸이 빠졌거나 형식이 다르면 { ok:false } — 통째로 거부한다(모르는 추가 칸은 무시).
 * 실패 사유 글자에는 값(전화번호·이름)을 넣지 않는다 — 몇 번째 주문의 어느 칸인지만.
 */
export function parseClubOrdersResponse(body: unknown, expected: { club: string; from: string; to: string }): ParseResult {
  const fail = (reason: string): ParseResult => ({ ok: false, reason: `응답 모양이 다릅니다: ${reason}` });
  if (!isPlainObject(body) || !hasRequiredKeys(body, TOP_KEYS)) return fail("최상위 칸");
  if (body.success !== true) return fail("success");
  if (body.club !== expected.club || body.from !== expected.from || body.to !== expected.to) return fail("club·기간 불일치");
  if (typeof body.fetchedAt !== "string" || body.fetchedAt.length === 0) return fail("fetchedAt");
  if (!Array.isArray(body.orders)) return fail("orders");
  if (!Number.isInteger(body.count) || body.count !== body.orders.length) return fail("count");

  const seenOrders = new Set<string>();
  const out: ShopOrderInput[] = [];
  for (let i = 0; i < body.orders.length; i++) {
    const o = body.orders[i] as unknown;
    const at = `orders[${i}]`;
    if (!isPlainObject(o) || !hasRequiredKeys(o, ORDER_KEYS)) return fail(`${at} 칸`);
    if (!isCode(o.cafe24OrderId)) return fail(`${at}.cafe24OrderId`);
    if (seenOrders.has(o.cafe24OrderId)) return fail(`${at} 주문 중복`);
    seenOrders.add(o.cafe24OrderId);
    if (!isKstYmd(o.orderDate)) return fail(`${at}.orderDate`);
    // 요청한 기간 밖 주문이면 다른 응답이 섞인 것 — 거부
    if ((o.orderDate as string) < expected.from || (o.orderDate as string) > expected.to) return fail(`${at}.orderDate 기간 밖`);
    if (typeof o.paid !== "boolean" || typeof o.canceled !== "boolean") return fail(`${at} paid·canceled`);
    if (!isPhoneDigitsOrNull(o.buyerPhoneDigits) || !isPhoneDigitsOrNull(o.receiverPhoneDigits)) return fail(`${at} 전화번호 칸`);
    if (!Array.isArray(o.items)) return fail(`${at}.items`);

    const seenItems = new Set<string>();
    const items: ShopOrderItemInput[] = [];
    for (let j = 0; j < o.items.length; j++) {
      const it = o.items[j] as unknown;
      const iat = `${at}.items[${j}]`;
      if (!isPlainObject(it) || !hasRequiredKeys(it, ITEM_KEYS)) return fail(`${iat} 칸`);
      if (!isCode(it.itemCode)) return fail(`${iat}.itemCode`);
      if (seenItems.has(it.itemCode)) return fail(`${iat} 품목 중복`);
      seenItems.add(it.itemCode);
      if (!Number.isInteger(it.productNo) || (it.productNo as number) < 0) return fail(`${iat}.productNo`);
      if (!Number.isInteger(it.quantity) || (it.quantity as number) < 1 || (it.quantity as number) > 999) return fail(`${iat}.quantity`);
      if (typeof it.status !== "string" || !(SHOP_ITEM_STATUSES as readonly string[]).includes(it.status)) return fail(`${iat}.status`);
      for (const k of ITEM_TEXT_KEYS) if (!isTextOrNull(it[k])) return fail(`${iat}.${k}`);
      items.push({
        itemCode: it.itemCode,
        productNo: it.productNo as number,
        design: clean(it.design as string | null),
        studentName: clean(it.studentName as string | null),
        printName: clean(it.printName as string | null),
        number: clean(it.number as string | null),
        topSize: clean(it.topSize as string | null),
        bottomSize: clean(it.bottomSize as string | null),
        quantity: it.quantity as number,
        status: it.status as ShopItemStatus,
        trackingNo: clean(it.trackingNo as string | null),
      });
    }
    out.push({
      cafe24OrderId: o.cafe24OrderId,
      orderDate: o.orderDate as string,
      paid: o.paid,
      canceled: o.canceled,
      buyerPhoneDigits: phoneOrNull(o.buyerPhoneDigits),
      receiverPhoneDigits: phoneOrNull(o.receiverPhoneDigits),
      items,
    });
  }
  return { ok: true, orders: out };
}

// ── 저장 계획 ───────────────────────────────────────────────────────────────

export type ShopOrderRow = {
  id: string;
  orderDate: string;
  paid: boolean;
  canceled: boolean;
  buyerPhoneDigits: string | null;
  receiverPhoneDigits: string | null;
};

export type ShopOrderItemRow = {
  id: string;
  shopOrderId: string;
  productNo: number;
  design: string | null;
  studentName: string | null;
  printName: string | null;
  backNumber: string | null;
  topSize: string | null;
  bottomSize: string | null;
  quantity: number;
  status: ShopItemStatus;
  trackingNo: string | null;
};

/** 검증된 주문 → 표 두 개에 넣을 행. 품목 id = `${주문번호}:${품목코드}` */
export function planShopOrderUpsert(orders: ShopOrderInput[]): { orders: ShopOrderRow[]; items: ShopOrderItemRow[] } {
  const orderRows: ShopOrderRow[] = [];
  const itemRows: ShopOrderItemRow[] = [];
  for (const o of orders) {
    orderRows.push({
      id: o.cafe24OrderId,
      orderDate: o.orderDate,
      paid: o.paid,
      canceled: o.canceled,
      buyerPhoneDigits: o.buyerPhoneDigits,
      receiverPhoneDigits: o.receiverPhoneDigits,
    });
    for (const it of o.items) {
      itemRows.push({
        id: `${o.cafe24OrderId}:${it.itemCode}`,
        shopOrderId: o.cafe24OrderId,
        productNo: it.productNo,
        design: it.design,
        studentName: it.studentName,
        printName: it.printName,
        backNumber: it.number,
        topSize: it.topSize,
        bottomSize: it.bottomSize,
        quantity: it.quantity,
        status: it.status,
        trackingNo: it.trackingNo,
      });
    }
  }
  return { orders: orderRows, items: itemRows };
}

// ── DB ──────────────────────────────────────────────────────────────────────

type Writer = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

/**
 * 주문·품목을 «한 SQL 문»으로 upsert — 하나라도 실패하면 문장 전체가 되돌려진다(반쪽 저장 없음).
 * 지우는 문장은 없다. 값은 jsonb 매개변수로만 넘긴다(SQL 에 글자를 이어 붙이지 않는다).
 *
 * gone(2026-11-17): 같은 주문을 다시 받았는데 «응답에 없는 그 주문의 품목»은 status 를 'CANCELED' 로 표시한다(행은 남긴다).
 *   · 대상은 «이번 응답에 품목이 하나라도 들어온 주문»뿐 — 기간 밖이라 응답에 없는 주문은 건드리지 않는다.
 *   · 품목이 0개로 온 주문은 건드리지 않는다(본사 쪽 일시 오류로 품목이 비어 온 경우 전부 «취소»로 보이는 일을 막는다.
 *     주문 전체 취소는 주문의 canceled 칸이 따로 알려 준다).
 *   · up_i(응답에 있는 품목)와 gone(응답에 없는 품목)은 서로 다른 행이라 한 문장에서 같은 행을 두 번 고치지 않는다.
 *   · 품목이 다음 응답에 다시 들어오면 up_i 가 본사 상태로 되돌린다(되돌릴 수 있는 표시).
 */
export const UPSERT_SHOP_ORDERS_SQL = `
WITH src_o AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
    id text, "orderDate" date, paid boolean, canceled boolean, "buyerPhoneDigits" text, "receiverPhoneDigits" text)
), up_o AS (
  INSERT INTO "UniformShopOrder" (id, "orderDate", paid, canceled, "buyerPhoneDigits", "receiverPhoneDigits", "syncedAt", "createdAt", "updatedAt")
  SELECT id, "orderDate", paid, canceled, "buyerPhoneDigits", "receiverPhoneDigits", NOW(), NOW(), NOW() FROM src_o
  ON CONFLICT (id) DO UPDATE SET
    "orderDate" = EXCLUDED."orderDate", paid = EXCLUDED.paid, canceled = EXCLUDED.canceled,
    "buyerPhoneDigits" = EXCLUDED."buyerPhoneDigits", "receiverPhoneDigits" = EXCLUDED."receiverPhoneDigits",
    "syncedAt" = NOW(), "updatedAt" = NOW()
  RETURNING 1
), src_i AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS y(
    id text, "shopOrderId" text, "productNo" integer, design text, "studentName" text, "printName" text,
    "backNumber" text, "topSize" text, "bottomSize" text, quantity integer, status text, "trackingNo" text)
), up_i AS (
  INSERT INTO "UniformShopOrderItem" (id, "shopOrderId", "productNo", design, "studentName", "printName", "backNumber", "topSize", "bottomSize", quantity, status, "trackingNo", "updatedAt")
  SELECT id, "shopOrderId", "productNo", design, "studentName", "printName", "backNumber", "topSize", "bottomSize", quantity, status, "trackingNo", NOW() FROM src_i
  ON CONFLICT (id) DO UPDATE SET
    "shopOrderId" = EXCLUDED."shopOrderId", "productNo" = EXCLUDED."productNo", design = EXCLUDED.design,
    "studentName" = EXCLUDED."studentName", "printName" = EXCLUDED."printName", "backNumber" = EXCLUDED."backNumber",
    "topSize" = EXCLUDED."topSize", "bottomSize" = EXCLUDED."bottomSize", quantity = EXCLUDED.quantity,
    status = EXCLUDED.status, "trackingNo" = EXCLUDED."trackingNo", "updatedAt" = NOW()
  RETURNING 1
), gone AS (
  UPDATE "UniformShopOrderItem" t SET status = 'CANCELED', "updatedAt" = NOW()
   WHERE t."shopOrderId" IN (SELECT DISTINCT "shopOrderId" FROM src_i)
     AND NOT EXISTS (SELECT 1 FROM src_i s WHERE s.id = t.id)
     AND t.status NOT IN ('CANCELED', 'RETURNED')
  RETURNING 1
)
SELECT (SELECT count(*) FROM up_o)::int AS "orders", (SELECT count(*) FROM up_i)::int AS "items",
       (SELECT count(*) FROM gone)::int AS "canceledMissingItems"`;

export async function upsertShopOrders(
  db: Writer,
  plan: { orders: ShopOrderRow[]; items: ShopOrderItemRow[] },
): Promise<{ orders: number; items: number; canceledMissingItems: number }> {
  // 받은 주문이 0건이면 DB 를 건드리지 않는다
  if (plan.orders.length === 0) return { orders: 0, items: 0, canceledMissingItems: 0 };
  const rows = await db.$queryRawUnsafe<{ orders: number; items: number; canceledMissingItems?: number }[]>(
    UPSERT_SHOP_ORDERS_SQL,
    JSON.stringify(plan.orders),
    JSON.stringify(plan.items),
  );
  return {
    orders: Number(rows[0]?.orders ?? 0),
    items: Number(rows[0]?.items ?? 0),
    canceledMissingItems: Number(rows[0]?.canceledMissingItems ?? 0),
  };
}

// ── 네트워크 ────────────────────────────────────────────────────────────────

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect: "error" }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type SyncDeps = {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  nowMs?: () => number;
  timeoutMs?: number;
};

/**
 * 본사 창구 GET(서명) — 네트워크 실패·시간 초과·5xx 면 1번만 다시 시도(매번 새 시각·새 서명).
 * 401·400 은 다시 해도 같으니 바로 실패. 오류 글자에는 상태 번호만(본사 오류 글·비밀값 없음).
 * 다른 주소로 넘기는 응답(3xx)은 따라가지 않는다(redirect: "error") — 서명 헤더가 엉뚱한 주소로 넘어가지 않게.
 *   이때 fetch 가 던지는 오류는 «본사 연결 실패»로 기록된다.
 */
export async function fetchClubOrders(range: SyncRange, deps: SyncDeps = {}): Promise<unknown> {
  const env = deps.env ?? process.env;
  const secret = env.STIZ_PARTNER_SECRET?.trim();
  if (!secret) throw new ShopOrderSyncError("STIZ_PARTNER_SECRET 설정이 없습니다");
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new ShopOrderSyncError("STIZ_PARTNER_SECRET 형식이 올바르지 않습니다");
  const base = env.STIZ_CLUB_ORDERS_API_URL?.trim() || CLUB_ORDERS_DEFAULT_URL;
  // 전화번호가 오가는 통로라 암호화된 주소만 쓴다(환경값을 잘못 넣어 http 로 나가는 실수 방지)
  if (!base.startsWith("https://")) throw new ShopOrderSyncError("본사 창구 주소는 https 여야 합니다");
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const now = deps.nowMs ?? Date.now;
  const club = STIZ_PARTNER_ID;
  // 쿼리에는 club·기간만 — 전화번호·이름은 절대 넣지 않는다
  const url = `${base}?${new URLSearchParams({ club, from: range.from, to: range.to }).toString()}`;

  let lastError = "본사 응답 없음";
  for (let attempt = 0; attempt < 2; attempt++) {
    const timestamp = Math.floor(now() / 1000);
    const signature = signClubOrdersRequest({ secret, timestamp, club, from: range.from, to: range.to });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-STIZ-Partner": club,
          "X-STIZ-Timestamp": String(timestamp),
          "X-STIZ-Signature": signature,
        },
        signal: controller.signal,
        // 넘겨 보내기(3xx)를 따라가지 않는다 — 서명 헤더(X-STIZ-*)가 다른 주소로 새지 않게
        redirect: "error",
      });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          // 본문을 읽다가 시간 제한에 걸린 것이면 «JSON 아님»이 아니다 — 바깥 catch 가 «시간 초과»로 적고 한 번 더 시도한다
          if (controller.signal.aborted) throw new Error("body read timeout");
          throw new ShopOrderSyncError("본사 응답이 JSON 이 아닙니다");
        }
      }
      lastError = `본사 응답 ${res.status}`;
      // 서명·기간 오류는 다시 해도 같다
      if (res.status < 500) throw new ShopOrderSyncError(lastError);
    } catch (error) {
      if (error instanceof ShopOrderSyncError) throw error;
      lastError = controller.signal.aborted ? "본사 응답 시간 초과" : "본사 연결 실패";
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ShopOrderSyncError(lastError);
}

export type SyncResult = {
  from: string;
  to: string;
  receivedOrders: number;
  receivedItems: number;
  savedOrders: number;
  savedItems: number;
  /** 응답에 들어온 주문에서 빠져 «취소»로 표시한 품목 수(이미 취소였던 것은 세지 않는다) */
  canceledMissingItems: number;
};

/** 받기 → 검증 → 저장. 검증에 실패하면 DB 를 건드리지 않고 ShopOrderSyncError */
export async function runShopOrderSync(db: Writer, range: SyncRange, deps: SyncDeps = {}): Promise<SyncResult> {
  const body = await fetchClubOrders(range, deps);
  const parsed = parseClubOrdersResponse(body, { club: STIZ_PARTNER_ID, from: range.from, to: range.to });
  if (!parsed.ok) throw new ShopOrderSyncError(parsed.reason);
  const plan = planShopOrderUpsert(parsed.orders);
  const saved = await upsertShopOrders(db, plan);
  return {
    from: range.from,
    to: range.to,
    receivedOrders: plan.orders.length,
    receivedItems: plan.items.length,
    savedOrders: saved.orders,
    savedItems: saved.items,
    canceledMissingItems: saved.canceledMissingItems,
  };
}
