// 학부모 «아이 정보»의 유니폼 신청 내역 조회(2026-11-16 원장 «학부모 화면에서 아이 유니폼 신청내역 확인»).
//
// ★ 보안 가드(반드시 유지)
//   1) IDOR — 첫 SQL 에서 «이 학생이 로그인 보호자의 아이인가»(childAccessSql)·«병합된 옛 학생이 아닌가»를 다시 확인한다.
//      0행이면 빈 목록 — 주문 표는 아예 읽지 않는다(남의 아이 id 를 주소에 넣어도 아무것도 안 읽힌다).
//   2) 전화번호는 «로그인한 본인 계정(User.phone)» 것만 쓴다 — 대표 보호자·다른 가족의 번호로 넓히지 않는다.
//      쓸 수 없는 번호(비었음·자리채움)면 빈 목록.
//   3) 이름만으로 찾지 않는다 — 전화번호 열쇠 + 이름 열쇠를 SQL 과 규칙(toChildUniformOrders)에서 두 번 맞춘다.
//   4) 주문의 보호자 이름·전화·메모(customerMemo)·본사 연동 값(stiz*)·오류(lastError)는 화면으로 내보내지 않는다.
//      (조건 확인용으로 고른 parentPhoneDigits·studentName 도 규칙 함수가 화면 줄에서 뺀다)
//   5) 본사 쇼핑몰 주문(UniformShopOrder, 2026-11-16)도 같은 권한 확인 뒤에만, 같은 열쇠(본인 번호 = 구매자 또는 수령인 번호
//      + 아이 이름 열쇠)로 SQL·규칙 두 번 거른다. 학생 이름이 빈 품목은 보이지 않는다. 송장번호는 고르지 않는다.
// 시간대: UniformOrder.createdAt 은 timestamptz → AT TIME ZONE 'Asia/Seoul' «한 번»만. UniformShopOrder.orderDate 는 date — 변환 없음.
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  childUniformNameKey,
  mergeChildUniformOrders,
  parentOrderPhoneKey,
  toChildShopUniformOrders,
  toChildUniformOrders,
  type ChildShopUniformOrderRow,
  type ChildUniformOrderRow,
  type ChildUniformOrderView,
} from "@/lib/parent/childUniformRules";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

/** 한 아이의 유니폼 신청 내역(사이트 + 본사 쇼핑몰, 신청일 최신순). 권한이 없거나 열쇠가 없으면 빈 목록 */
export async function loadChildUniformOrders(db: Reader, parentUserId: string, studentId: string): Promise<ChildUniformOrderView[]> {
  if (!parentUserId || !studentId) return [];

  // ① 권한 재확인 + 아이 이름 + 로그인한 본인 전화번호(같은 SQL — 다른 사람의 전화는 고르지 않는다)
  const owned = await db.$queryRawUnsafe<{ name: string | null; mePhone: string | null }[]>(
    `SELECT s.name, me.phone AS "mePhone"
       FROM "Student" s
       JOIN "User" me ON me.id = $2
      WHERE s.id = $1 AND ${await childAccessSql("s", "$2")} AND ${notMergedStudent("s")}
      LIMIT 1`,
    studentId,
    parentUserId,
  );
  const row = owned[0];
  if (!row) return [];
  const phoneKey = parentOrderPhoneKey(row.mePhone);
  const childNameKey = childUniformNameKey(row.name);
  if (!phoneKey || !childNameKey) return [];

  // ② 내 번호로 낸 주문 중 이 아이 이름의 품목만 — 화면에 필요한 칸 + 조건 확인용 두 칸만 고른다
  const rows = await db.$queryRawUnsafe<ChildUniformOrderRow[]>(
    `SELECT i.id AS "itemId",
            to_char(o."createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "appliedYmd",
            i.design, i."backNumber", i."topSize", i."bottomSize", i.quantity,
            o."orderStatus", o."stizSyncStatus",
            (COALESCE(o."stizOrderNumber", '') <> '') AS "hasOrderNumber",
            o."parentPhoneDigits", i."studentName"
       FROM "UniformOrder" o
       JOIN "UniformOrderItem" i ON i."uniformOrderId" = o.id
      WHERE o."parentPhoneDigits" = $1
        AND regexp_replace(i."studentName", '\\s', '', 'g') = $2
      ORDER BY o."createdAt" DESC, i."createdAt" ASC
      LIMIT 50`,
    phoneKey,
    childNameKey,
  );
  const site = toChildUniformOrders(rows, { phoneKey, childNameKey });

  // ③ 본사 쇼핑몰 주문(2026-11-16) — 같은 열쇠로, 구매자 번호 또는 수령인 번호가 본인 번호인 주문의 이 아이 이름 품목만
  const shopRows = await loadShopRows(db, phoneKey, childNameKey);
  const shop = toChildShopUniformOrders(shopRows, { phoneKey, childNameKey });
  return mergeChildUniformOrders(site, shop);
}

/**
 * 쇼핑몰 주문 행. 표가 아직 없는 DB(마이그레이션 전)면 빈 목록 — 화면이 깨지지 않게.
 * orderDate 는 date(달력 날짜) — 시간대 변환 없이 그대로 글자로. 송장번호·인쇄 이름은 고르지 않는다.
 */
async function loadShopRows(db: Reader, phoneKey: string, childNameKey: string): Promise<ChildShopUniformOrderRow[]> {
  const ready = await db.$queryRawUnsafe<{ ready: boolean }[]>(
    `SELECT (to_regclass('public."UniformShopOrder"') IS NOT NULL
             AND to_regclass('public."UniformShopOrderItem"') IS NOT NULL) AS ready`,
  );
  if (ready[0]?.ready !== true) return [];
  return db.$queryRawUnsafe<ChildShopUniformOrderRow[]>(
    `SELECT i.id AS "itemId",
            to_char(o."orderDate", 'YYYY-MM-DD') AS "orderYmd",
            i.design, i."backNumber", i."topSize", i."bottomSize", i.quantity,
            i.status AS "itemStatus", o.canceled,
            o."buyerPhoneDigits", o."receiverPhoneDigits", i."studentName"
       FROM "UniformShopOrder" o
       JOIN "UniformShopOrderItem" i ON i."shopOrderId" = o.id
      WHERE (o."buyerPhoneDigits" = $1 OR o."receiverPhoneDigits" = $1)
        AND i."studentName" IS NOT NULL
        AND regexp_replace(i."studentName", '\\s', '', 'g') = $2
      ORDER BY o."orderDate" DESC, i.id ASC
      LIMIT 50`,
    phoneKey,
    childNameKey,
  );
}
