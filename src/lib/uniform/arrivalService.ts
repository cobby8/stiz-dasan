// 유니폼 신청 현황 조회 + «학원 도착»·«수령 완료» 처리(2026-11-21 원장 지시). 규칙은 arrivalRules.ts.
//
// ★ 지키는 것
//   1) 멱등 — 도착 기록은 (출처, 품목 id) 하나에 한 줄(UNIQUE). INSERT … ON CONFLICT DO NOTHING RETURNING 으로
//      «이번에 새로 잡은 줄»만 문자를 보낸다. 두 번 눌러도, 두 사람이 같이 눌러도 문자는 한 번.
//      문자 장부(NotificationDelivery)의 중복 방지 키도 도착 기록 id 로 정해져 이중으로 막힌다.
//   2) 문자는 기존 자동 문자 규칙(MessageAutomationRule·SmsTemplate, 트리거 UNIFORM_ARRIVED_PARENT)으로만 —
//      /admin/sms 에서 끄면 보내지 않는다(도착 기록은 남고 «자동 문자 꺼짐»으로 보인다).
//   3) 학생을 확실히 이은 줄만 보낸다(무료 증정 링크 또는 «주문 전화번호 + 이름» 후보 정확히 1명). 이름만으로는 잇지 않는다.
//   4) 전화번호는 화면·로그·결과로 내보내지 않는다. 조회 SQL 도 매칭 조건 안에서만 쓰고 고르지 않는다.
//   5) 쇼핑몰 품목 상태는 동기화가 덮어쓰므로 주문 표를 고치지 않는다 — 도착·수령은 UniformArrival 에만.
// 시간대: UniformOrder.createdAt 은 timestamptz → AT TIME ZONE 'Asia/Seoul' 한 번. UniformShopOrder.orderDate 는 date 그대로.
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  buildUniformBoard,
  noticeChildName,
  parseUniformItemKey,
  planUniformArrivalNotices,
  UNIFORM_ARRIVAL_BATCH_LIMIT,
  UNIFORM_ARRIVED_EVENT,
  UNIFORM_ARRIVED_TRIGGER,
  uniformItemKey,
  uniformNoticeStatusFromSms,
  type ClassmateNumber,
  type StudentClassInfo,
  type UniformBoardItem,
  type UniformBoardRow,
  type UniformNoticeStatus,
  type UniformSource,
} from "@/lib/uniform/arrivalRules";

export type UniformDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

export type UniformSmsSender = (
  phone: string,
  trigger: string,
  variables: Record<string, string>,
  options: { eventType: string; eventId: string },
) => Promise<{ ok: boolean; reason?: string }>;

const BOARD_LIMIT = 400;

/** 이름 비교 열쇠(SQL) — 띄어쓰기를 지우고 끝의 영문·숫자 구분 글자를 뗀다. 다 떼면 띄어쓰기만 지운 값 */
function nameKeySql(expr: string): string {
  const compact = `regexp_replace(COALESCE(${expr}, ''), '\\s', '', 'g')`;
  return `COALESCE(NULLIF(regexp_replace(${compact}, '[A-Za-z0-9]+$', ''), ''), ${compact})`;
}

/** 열쇠로 쓸 수 있는 번호만(9~11자리) — 그 밖은 NULL 이라 어떤 번호와도 같지 않다 */
function usablePhoneSql(expr: string): string {
  return `(CASE WHEN ${expr} ~ '^[0-9]{9,11}$' AND ${expr} !~ '^(\\d)\\1+$' THEN ${expr} END)`;
}

function phoneDigitsSql(expr: string): string {
  return `regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g')`;
}

/**
 * 두 출처를 한 목록으로 — 전화번호는 매칭 조건 안에서만 쓰고 고르지 않는다.
 * 도착 기록에 학생이 이미 적혀 있으면 그 학생이 정본(도착 뒤 이름·번호가 바뀌어도 흔들리지 않게).
 */
export function uniformBoardSql(): string {
  return `
    WITH items AS (
      SELECT 'SITE'::text AS source, i.id AS "itemId", o.id AS "orderId",
             to_char(o."createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "appliedYmd",
             i."studentName", i.design, i.initials AS "printName", i."backNumber", i."topSize", i."bottomSize", i.quantity,
             o."orderStatus", o."stizSyncStatus", (COALESCE(o."stizOrderNumber", '') <> '') AS "hasOrderNumber", o."customerMemo",
             NULL::text AS "shopItemStatus", NULL::boolean AS "shopCanceled",
             ${usablePhoneSql(`o."parentPhoneDigits"`)} AS p1, NULL::text AS p2, o.id AS "grantOrderId"
        FROM "UniformOrder" o
        JOIN "UniformOrderItem" i ON i."uniformOrderId" = o.id
      UNION ALL
      SELECT 'SHOP'::text, i.id, o.id,
             to_char(o."orderDate", 'YYYY-MM-DD'),
             i."studentName", i.design, i."printName", i."backNumber", i."topSize", i."bottomSize", i.quantity,
             NULL::text, NULL::text, NULL::boolean, NULL::text,
             i.status, o.canceled,
             ${usablePhoneSql(`o."buyerPhoneDigits"`)}, ${usablePhoneSql(`o."receiverPhoneDigits"`)}, NULL::text
        FROM "UniformShopOrder" o
        JOIN "UniformShopOrderItem" i ON i."shopOrderId" = o.id
    )
    SELECT it.source, it."itemId", it."orderId", it."appliedYmd", it."studentName", it.design, it."printName",
           it."backNumber", it."topSize", it."bottomSize", it.quantity,
           it."orderStatus", it."stizSyncStatus", it."hasOrderNumber", it."customerMemo",
           it."shopItemStatus", it."shopCanceled",
           COALESCE(a."studentId", gr."studentId", CASE WHEN cardinality(c.ids) = 1 THEN c.ids[1] END) AS "studentId",
           COALESCE(cardinality(c.ids), 0)::int AS "candidateCount",
           (gr."studentId" IS NOT NULL) AS "linkedByGrant",
           a."arrivedAt", a."receivedAt", a."noticeStatus"
      FROM items it
      LEFT JOIN "UniformArrival" a ON a."sourceType" = it.source AND a."sourceItemId" = it."itemId"
      -- 무료 증정 링크로 들어온 신청 — 링크 학생과 품목 이름이 같을 때만(형제 품목에 잘못 붙지 않게)
      LEFT JOIN LATERAL (
        SELECT g."studentId" FROM "UniformFreeGrant" g
          JOIN "Student" gs ON gs.id = g."studentId" AND ${notMergedStudent("gs")}
         WHERE it."grantOrderId" IS NOT NULL AND g."uniformOrderId" = it."grantOrderId"
           AND ${nameKeySql(`gs.name`)} = ${nameKeySql(`it."studentName"`)}
         ORDER BY g."createdAt" ASC LIMIT 1
      ) gr ON true
      -- 주문 전화번호(본인 계정 또는 보호자 번호) + 이름 열쇠가 같은 원생 후보
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT s.id) AS ids FROM "Student" s
         WHERE ${notMergedStudent("s")}
           AND COALESCE(it."studentName", '') <> ''
           AND ${nameKeySql(`s.name`)} = ${nameKeySql(`it."studentName"`)}
           AND (EXISTS (SELECT 1 FROM "User" u WHERE u.id = s."parentId" AND ${phoneDigitsSql(`u.phone`)} IN (it.p1, it.p2))
                OR EXISTS (SELECT 1 FROM "Guardian" gd WHERE gd."studentId" = s.id AND ${phoneDigitsSql(`gd.phone`)} IN (it.p1, it.p2)))
      ) c ON true
     ORDER BY it."appliedYmd" DESC, it.source ASC, it."itemId" ASC
     LIMIT ${BOARD_LIMIT}`;
}

type RawBoardRow = Omit<UniformBoardRow, "arrivedAt" | "receivedAt" | "quantity" | "candidateCount"> & {
  arrivedAt: Date | string | null;
  receivedAt: Date | string | null;
  quantity: number | string | null;
  candidateCount: number | string | null;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function loadUniformBoard(db: UniformDb): Promise<UniformBoardItem[]> {
  const raw = await db.$queryRawUnsafe<RawBoardRow[]>(uniformBoardSql());
  const rows: UniformBoardRow[] = raw.map((row) => ({
    ...row,
    quantity: Number(row.quantity ?? 1) || 1,
    candidateCount: Number(row.candidateCount ?? 0) || 0,
    linkedByGrant: row.linkedByGrant === true,
    hasOrderNumber: row.hasOrderNumber === true,
    shopCanceled: row.shopCanceled === true,
    arrivedAt: iso(row.arrivedAt),
    receivedAt: iso(row.receivedAt),
  }));

  const studentIds = [...new Set(rows.map((row) => row.studentId).filter((id): id is string => Boolean(id)))];
  const classesByStudent = new Map<string, StudentClassInfo[]>();
  let classmates: ClassmateNumber[] = [];
  if (studentIds.length > 0) {
    const enrollments = await db.$queryRawUnsafe<Array<{ studentId: string; classId: string; className: string }>>(
      `SELECT e."studentId", c.id AS "classId", c.name AS "className"
         FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId"
        WHERE e.status = 'ACTIVE' AND e."studentId" = ANY($1::text[])
        ORDER BY c.name ASC`,
      studentIds,
    );
    for (const row of enrollments) {
      const list = classesByStudent.get(row.studentId) ?? [];
      list.push({ classId: row.classId, className: row.className });
      classesByStudent.set(row.studentId, list);
    }
    const classIds = [...new Set(enrollments.map((row) => row.classId))];
    if (classIds.length > 0) {
      classmates = await db.$queryRawUnsafe<ClassmateNumber[]>(
        `SELECT e."classId", s.id AS "studentId", s.name AS "studentName", s."uniformNumber"
           FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
          WHERE e.status = 'ACTIVE' AND e."classId" = ANY($1::text[]) AND COALESCE(s."uniformNumber", '') <> ''`,
        classIds,
      );
    }
  }
  return buildUniformBoard(rows, classesByStudent, classmates);
}

function parseKeys(keys: unknown): Array<{ source: UniformSource; itemId: string; key: string }> {
  if (!Array.isArray(keys)) return [];
  const seen = new Set<string>();
  const parsed: Array<{ source: UniformSource; itemId: string; key: string }> = [];
  for (const raw of keys) {
    const key = parseUniformItemKey(raw);
    if (!key) continue;
    const id = uniformItemKey(key.source, key.itemId);
    if (seen.has(id)) continue;
    seen.add(id);
    parsed.push({ ...key, key: id });
  }
  return parsed;
}

export type UniformArrivalResult = {
  /** 이번에 새로 도착 처리한 줄 */
  arrived: number;
  /** 이미 도착(또는 수령) 처리돼 있던 줄 — 문자를 다시 보내지 않았다 */
  already: number;
  /** 취소·목록에 없는 줄 등 처리하지 않은 줄 */
  rejected: number;
  notices: Record<UniformNoticeStatus, number>;
};

function emptyNoticeCounts(): Record<UniformNoticeStatus, number> {
  return { SENT: 0, FAILED: 0, SKIPPED_NO_STUDENT: 0, SKIPPED_NO_PHONE: 0, DISABLED: 0 };
}

/** 학생의 보호자 번호 — 본인 계정(Student.parentId 의 User.phone), 없으면 대표 보호자 번호 */
async function loadParentPhone(db: UniformDb, studentId: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ phone: string | null }>>(
    `SELECT COALESCE(NULLIF(u.phone, ''),
                     (SELECT gd.phone FROM "Guardian" gd WHERE gd."studentId" = s.id AND COALESCE(gd.phone, '') <> ''
                       ORDER BY gd."isPrimary" DESC, gd."createdAt" ASC LIMIT 1)) AS phone
       FROM "Student" s LEFT JOIN "User" u ON u.id = s."parentId"
      WHERE s.id = $1 AND ${notMergedStudent("s")}
      LIMIT 1`,
    studentId,
  );
  const phone = rows[0]?.phone ?? null;
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  return /^01[016789][0-9]{7,8}$/.test(digits) ? digits : null;
}

/**
 * «학원 도착» — 고른 줄을 도착으로 적고, 학생 유니폼 상태를 맞추고, 학생마다 도착 문자 한 통.
 * 이미 도착한 줄은 건드리지 않는다(문자도 다시 안 보낸다).
 */
export async function markUniformArrived(
  deps: { db: UniformDb; sendSms: UniformSmsSender },
  input: { keys: unknown; actorName: string | null },
): Promise<UniformArrivalResult> {
  const { db, sendSms } = deps;
  const requested = parseKeys(input.keys);
  if (requested.length === 0) throw new Error("도착 처리할 유니폼을 골라 주세요.");
  if (requested.length > UNIFORM_ARRIVAL_BATCH_LIMIT) {
    throw new Error(`한 번에 ${UNIFORM_ARRIVAL_BATCH_LIMIT}건까지 도착 처리할 수 있어요.`);
  }

  // 지금 상태를 서버에서 다시 읽는다(화면 값은 믿지 않는다)
  const board = await loadUniformBoard(db);
  const byKey = new Map(board.map((item) => [item.key, item]));
  const result: UniformArrivalResult = { arrived: 0, already: 0, rejected: 0, notices: emptyNoticeCounts() };
  const eligible: UniformBoardItem[] = [];
  for (const key of requested) {
    const item = byKey.get(key.key);
    if (!item || item.stage === "CANCELED") result.rejected += 1;
    else if (!item.canArrive) result.already += 1;
    else eligible.push(item);
  }
  if (eligible.length === 0) return result;

  // ① 도착 기록 잡기 — 새로 잡힌 줄만 돌아온다(동시에 누른 쪽은 빈손)
  const claimed = await db.$queryRawUnsafe<Array<{ arrivalId: string; source: UniformSource; itemId: string; studentId: string | null }>>(
    `INSERT INTO "UniformArrival" (id, "sourceType", "sourceItemId", "studentId", "arrivedAt", "arrivedByName", "createdAt", "updatedAt")
     SELECT gen_random_uuid()::text, x.src, x.item, NULLIF(x.sid, ''), NOW(), $4, NOW(), NOW()
       FROM unnest($1::text[], $2::text[], $3::text[]) AS x(src, item, sid)
     ON CONFLICT ("sourceType", "sourceItemId") DO NOTHING
     RETURNING id AS "arrivalId", "sourceType" AS source, "sourceItemId" AS "itemId", "studentId"`,
    eligible.map((item) => item.source),
    eligible.map((item) => item.itemId),
    eligible.map((item) => item.studentId ?? ""),
    input.actorName,
  );
  result.arrived = claimed.length;
  result.already += eligible.length - claimed.length;
  if (claimed.length === 0) return result;

  const claimedItems = claimed.map((row) => {
    const item = byKey.get(uniformItemKey(row.source, row.itemId));
    return { row, item };
  });

  // ② 학생 유니폼 상태 — 학원 수령일 = 오늘, 상태 «미수령»(이미 «보유·수령완료»면 그대로),
  //    비어 있는 칸(신청일·취미반 번호)만 채운다. 원장이 손으로 적은 값은 덮지 않는다.
  const studentRows = claimedItems.filter(({ row }) => row.studentId);
  if (studentRows.length > 0) {
    await db.$executeRawUnsafe(
      `UPDATE "Student" s
          SET "uniformReceivedAt" = NOW(),
              "uniformStatus" = CASE WHEN s."uniformStatus" IN ('보유', '수령완료') THEN s."uniformStatus" ELSE '미수령' END,
              "uniformAppliedAt" = COALESCE(s."uniformAppliedAt", (x.ymd || ' 00:00:00+09')::timestamptz),
              "uniformNumber" = CASE WHEN COALESCE(s."uniformNumber", '') = '' AND x.num ~ '^[0-9]{1,3}$' THEN x.num ELSE s."uniformNumber" END,
              "updatedAt" = NOW()
         FROM (SELECT DISTINCT ON (u.sid) u.sid, u.num, u.ymd
                 FROM unnest($1::text[], $2::text[], $3::text[]) AS u(sid, num, ymd)
                ORDER BY u.sid, u.ymd ASC) x
        WHERE s.id = x.sid AND ${notMergedStudent("s")}`,
      studentRows.map(({ row }) => row.studentId as string),
      studentRows.map(({ item }) => String(item?.backNumber ?? "").replace(/^#+/, "").trim()),
      studentRows.map(({ item }) => item?.appliedYmd ?? ""),
    );
  }

  // ③ 학생마다 문자 한 통
  const plan = planUniformArrivalNotices(claimedItems.map(({ row, item }) => ({
    arrivalId: row.arrivalId,
    key: uniformItemKey(row.source, row.itemId),
    studentId: row.studentId,
    studentName: String(item?.studentName ?? ""),
  })));
  const updates: Array<{ ids: string[]; status: UniformNoticeStatus; reason: string | null }> = [];
  if (plan.skipped.length > 0) {
    updates.push({ ids: plan.skipped.map((row) => row.arrivalId), status: "SKIPPED_NO_STUDENT", reason: null });
  }
  for (const notice of plan.notices) {
    let status: UniformNoticeStatus;
    let reason: string | null = null;
    try {
      const phone = await loadParentPhone(db, notice.studentId);
      if (!phone) {
        status = "SKIPPED_NO_PHONE";
      } else {
        const sms = await sendSms(phone, UNIFORM_ARRIVED_TRIGGER, { childName: noticeChildName(notice.studentName) }, {
          eventType: UNIFORM_ARRIVED_EVENT,
          eventId: notice.eventId,
        });
        status = uniformNoticeStatusFromSms(sms);
        reason = sms.ok ? null : String(sms.reason ?? "").slice(0, 200) || null;
      }
    } catch (error) {
      // 한 명 실패가 나머지를 막지 않는다 — 값(번호)은 남기지 않는다
      status = "FAILED";
      reason = error instanceof Error ? error.name : "ERROR";
      console.error("[uniform-arrival] 도착 문자 실패", { eventId: notice.eventId, reason });
    }
    updates.push({ ids: notice.arrivalIds, status, reason });
  }
  for (const update of updates) {
    result.notices[update.status] += update.ids.length;
    await db.$executeRawUnsafe(
      `UPDATE "UniformArrival"
          SET "noticeStatus" = $2, "noticeReason" = $3,
              "noticeSentAt" = CASE WHEN $2 = 'SENT' THEN NOW() ELSE "noticeSentAt" END,
              "updatedAt" = NOW()
        WHERE id = ANY($1::text[])`,
      update.ids,
      update.status,
      update.reason,
    );
  }
  return result;
}

export type UniformReceiptResult = { received: number; skipped: number };

/** «수령 완료» — 도착한 줄만. 학생 상태 «수령완료»(이미 «보유»면 그대로). 문자는 보내지 않는다 */
export async function markUniformReceived(db: UniformDb, input: { keys: unknown; actorName: string | null }): Promise<UniformReceiptResult> {
  const requested = parseKeys(input.keys);
  if (requested.length === 0) throw new Error("수령 처리할 유니폼을 골라 주세요.");
  if (requested.length > UNIFORM_ARRIVAL_BATCH_LIMIT) {
    throw new Error(`한 번에 ${UNIFORM_ARRIVAL_BATCH_LIMIT}건까지 수령 처리할 수 있어요.`);
  }
  const updated = await db.$queryRawUnsafe<Array<{ studentId: string | null }>>(
    `UPDATE "UniformArrival" a
        SET "receivedAt" = NOW(), "receivedByName" = $3, "updatedAt" = NOW()
       FROM unnest($1::text[], $2::text[]) AS x(src, item)
      WHERE a."sourceType" = x.src AND a."sourceItemId" = x.item AND a."receivedAt" IS NULL
     RETURNING a."studentId"`,
    requested.map((key) => key.source),
    requested.map((key) => key.itemId),
    input.actorName,
  );
  const studentIds = [...new Set(updated.map((row) => row.studentId).filter((id): id is string => Boolean(id)))];
  if (studentIds.length > 0) {
    await db.$executeRawUnsafe(
      `UPDATE "Student" s
          SET "uniformStatus" = CASE WHEN s."uniformStatus" = '보유' THEN s."uniformStatus" ELSE '수령완료' END,
              "updatedAt" = NOW()
        WHERE s.id = ANY($1::text[]) AND ${notMergedStudent("s")}`,
      studentIds,
    );
  }
  return { received: updated.length, skipped: requested.length - updated.length };
}
