/**
 * 학부모 문의 «대화» — DB 연결부 (2026-11-14 원장 결정표 c3·c11). 규칙은 순수 모듈 inquiryThreadRules.
 *
 * ★ 권한: 학부모 쪽 함수는 모두 «SQL 문 안»에서 r."userId" = 로그인 사용자 로 묶는다 — 남의 문의 id 를 넣으면 0행이다.
 *   환불 문의는 청구의 학생이 내 아이인지(childAccessSql)를 같은 SQL 에서 확인한다.
 *   관리자 쪽 함수는 호출하는 서버 동작(actions/parent-inquiry.ts)이 requireAdmin() 을 먼저 통과한다.
 * ★ 새 표(ParentRequestMessage)·새 칸(paymentId)이 아직 없는 DB 에서도 죽지 않는다:
 *   읽기 = 첫 글 + 옛 답변만 · 학원 답 = 예전처럼 adminNote 에 저장 · 학부모 이어 쓰기 = 안내 문구로 거절.
 * ★ 모든 조회는 $queryRawUnsafe + 바인딩(PgBouncer 트랜잭션 모드).
 */
import type { PrismaClient } from "@prisma/client";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { billItemLabel } from "@/lib/payments/monthBills";
import {
  buildInquiryThread,
  canAskRefund,
  cleanInquiryBody,
  INQUIRY_PARENT_STREAK_MAX,
  INQUIRY_WAITING_LIMIT_MESSAGE,
  shouldNotifyAdminsOfFollowUp,
  inquiryFirstLine,
  inquiryParentStatus,
  refundInquiryContent,
  refundInquiryTitle,
  statusAfterAdminReply,
  statusAfterParentMessage,
  type InquiryAuthor,
  type InquiryBubble,
  type InquiryMessageRow,
  type InquiryParentStatus,
} from "./inquiryThreadRules";

export type InquiryDb = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();

/** Postgres «표 없음»(42P01)·«칸 없음»(42703) — 마이그레이션 적용 전 환경. Prisma raw 오류는 meta.code 또는 메시지에 담긴다 */
export function isMissingInquirySchema(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  const code = e?.meta?.code ?? e?.code ?? "";
  return code === "42P01" || code === "42703" || /42P01|42703|does not exist/.test(e?.message ?? "");
}

/** 문의 여러 건의 이어 붙인 글. 표가 없으면 available=false + 빈 목록(화면은 첫 글·옛 답변만 보인다) */
export async function readInquiryMessages(db: InquiryDb, requestIds: readonly string[]): Promise<{ available: boolean; byRequest: Map<string, InquiryMessageRow[]> }> {
  const byRequest = new Map<string, InquiryMessageRow[]>();
  if (requestIds.length === 0) return { available: true, byRequest };
  try {
    const rows = await db.$queryRawUnsafe<{ id: string; requestId: string; authorRole: string; body: string; createdAt: Date | string }[]>(
      `SELECT m.id, m."requestId", m."authorRole", m.body, m."createdAt"
         FROM "ParentRequestMessage" m
        WHERE m."requestId" = ANY($1::text[])
        ORDER BY m."createdAt", m.id`,
      [...requestIds],
    );
    for (const row of rows) {
      const list = byRequest.get(row.requestId) ?? [];
      list.push({ id: row.id, authorRole: row.authorRole, body: row.body, createdAt: iso(row.createdAt) });
      byRequest.set(row.requestId, list);
    }
    return { available: true, byRequest };
  } catch (error) {
    if (!isMissingInquirySchema(error)) console.error("[inquiry-thread] 글 조회 실패:", error);
    return { available: false, byRequest };
  }
}

// ── 학부모: 보낸 문의 목록·한 건 ─────────────────────────────────────────────

export type MyInquiryRow = {
  id: string;
  title: string;
  firstLine: string;
  studentName: string | null;
  createdAt: string;
  status: InquiryParentStatus;
};

type HeadRow = { id: string; userId: string; title: string; content: string; status: string; adminNote: string | null; createdAt: Date | string; studentName: string | null };

const lastAuthorOf = (messages: readonly InquiryMessageRow[] | undefined): InquiryAuthor | null => {
  const last = messages?.[messages.length - 1];
  return last ? (last.authorRole === "ADMIN" ? "ADMIN" : "PARENT") : null;
};

/** 내가 보낸 문의 — 최신순 100건. 조회 실패는 빈 목록(화면이 오류로 바뀌지 않게) */
export async function listMyInquiries(db: InquiryDb, parentUserId: string): Promise<MyInquiryRow[]> {
  let heads: HeadRow[] = [];
  try {
    heads = await db.$queryRawUnsafe<HeadRow[]>(
      `SELECT r.id, r."userId", r.title, r.content, r.status, r."adminNote", r."createdAt", s.name AS "studentName"
         FROM "ParentRequest" r
         LEFT JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
        WHERE r."userId" = $1
        ORDER BY r."createdAt" DESC
        LIMIT 100`,
      parentUserId,
    );
  } catch (error) {
    console.error("[inquiry-thread] 보낸 문의 조회 실패:", error);
    return [];
  }
  const { byRequest } = await readInquiryMessages(db, heads.map((head) => head.id));
  return heads.map((head) => ({
    id: head.id,
    title: head.title,
    firstLine: inquiryFirstLine(head.content),
    studentName: head.studentName ?? null,
    createdAt: iso(head.createdAt),
    status: inquiryParentStatus(head, lastAuthorOf(byRequest.get(head.id))),
  }));
}

export type MyInquiryDetail = {
  id: string;
  title: string;
  studentName: string | null;
  status: InquiryParentStatus;
  bubbles: InquiryBubble[];
  /** 이어 쓸 수 있는가 — 새 표가 아직 없는 환경이면 false(화면은 «새 문의» 길을 보인다) */
  canReply: boolean;
};

/** 내 문의 한 건 + 대화. 남의 문의·없는 문의는 null */
export async function getMyInquiry(db: InquiryDb, parentUserId: string, requestId: string): Promise<MyInquiryDetail | null> {
  const heads = await db.$queryRawUnsafe<HeadRow[]>(
    `SELECT r.id, r."userId", r.title, r.content, r.status, r."adminNote", r."createdAt", s.name AS "studentName"
       FROM "ParentRequest" r
       LEFT JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
      WHERE r.id = $1 AND r."userId" = $2
      LIMIT 1`,
    requestId, parentUserId,
  );
  const head = heads[0];
  if (!head) return null;
  const { available, byRequest } = await readInquiryMessages(db, [head.id]);
  const messages = byRequest.get(head.id) ?? [];
  return {
    id: head.id,
    title: head.title,
    studentName: head.studentName ?? null,
    status: inquiryParentStatus(head, lastAuthorOf(messages)),
    bubbles: buildInquiryThread({ ...head, createdAt: iso(head.createdAt) }, messages),
    canReply: available,
  };
}

export type InquiryWriteResult =
  | { ok: true; requestId: string; title: string; studentName: string | null; /** 원장 앱 알림을 만들 것인가(바로 앞 글이 학원 글일 때만) */ notifyAdmins: boolean }
  | { ok: false; error: string; /** 연속 글 한도에 걸렸는가(화면이 전화 버튼을 보인다) */ waitingLimit?: boolean };

/** Postgres 유일 제약 위반(23505) */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  return e?.meta?.code === "23505" || e?.code === "23505" || /23505|duplicate key value/.test(e?.message ?? "");
}

export const INQUIRY_NOT_FOUND = "문의를 찾을 수 없어요. 목록에서 다시 열어 주세요.";
export const INQUIRY_REPLY_UNAVAILABLE = "지금은 이어 쓸 수 없어요. 새 문의로 보내 주세요.";

/**
 * 학부모가 문의에 글을 이어 쓴다.
 * 소유 확인은 INSERT 문 안에서(r."userId" = 로그인 사용자) — 남의 문의면 0행이라 아무것도 쓰이지 않는다.
 * 횟수 제한도 같은 INSERT 문 안에서: 마지막 학원 답 뒤로 학부모 글이 이미 5개면 0행(«세고 나서 따로 넣기»가 아니라 한 문장).
 * 완전히 같은 순간에 들어온 요청끼리는 서로의 글을 못 봐 그 수만큼만 넘을 수 있다 — 그 뒤 요청은 모두 막힌다.
 * 쓴 뒤 문의 상태를 «대기중»으로 되돌려 관리자 요청함에 다시 뜨게 한다.
 */
export async function addParentInquiryMessage(db: InquiryDb, parentUserId: string, requestId: string, rawBody: unknown): Promise<InquiryWriteResult> {
  const cleaned = cleanInquiryBody(rawBody);
  if (!cleaned.ok) return cleaned;
  let inserted: { id: string }[];
  try {
    inserted = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "ParentRequestMessage" (id, "requestId", "authorRole", "authorUserId", body, "createdAt")
       SELECT gen_random_uuid()::text, r.id, 'PARENT', $2, $3, NOW()
         FROM "ParentRequest" r
        WHERE r.id = $1 AND r."userId" = $2
          AND (SELECT COUNT(*) FROM "ParentRequestMessage" m
                WHERE m."requestId" = r.id AND m."authorRole" = 'PARENT'
                  AND m."createdAt" > COALESCE((SELECT MAX(a."createdAt") FROM "ParentRequestMessage" a
                                                 WHERE a."requestId" = r.id AND a."authorRole" = 'ADMIN'), '-infinity'::timestamptz)) < $4
       RETURNING "requestId" AS id`,
      requestId, parentUserId, cleaned.body, INQUIRY_PARENT_STREAK_MAX,
    );
  } catch (error) {
    if (isMissingInquirySchema(error)) return { ok: false, error: INQUIRY_REPLY_UNAVAILABLE };
    console.error("[inquiry-thread] 학부모 글 저장 실패:", error);
    return { ok: false, error: "보내지 못했어요. 다시 시도해 주세요." };
  }
  if (inserted.length === 0) {
    // 0행 = 내 문의가 아니거나(없음) 연속 글 한도 — 어느 쪽인지 내 문의인지만 다시 본다
    const mine = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT r.id FROM "ParentRequest" r WHERE r.id = $1 AND r."userId" = $2 LIMIT 1`,
      requestId, parentUserId,
    ).catch(() => [] as { id: string }[]);
    return mine.length ? { ok: false, error: INQUIRY_WAITING_LIMIT_MESSAGE, waitingLimit: true } : { ok: false, error: INQUIRY_NOT_FOUND };
  }
  // 글은 이미 저장됐다 — 상태 되돌리기가 실패해도 학부모에게 실패로 돌려주지 않는다(다시 보내면 글이 두 번 쌓인다)
  const heads = await db.$queryRawUnsafe<{ title: string; studentName: string | null; adminNote: string | null }[]>(
    `UPDATE "ParentRequest" r SET status = $3, "updatedAt" = NOW()
       FROM (SELECT x.id, s.name AS "studentName" FROM "ParentRequest" x LEFT JOIN "Student" s ON s.id = x."studentId" AND ${notMergedStudent("s")} WHERE x.id = $1 AND x."userId" = $2) src
      WHERE r.id = src.id
      RETURNING r.title, src."studentName", r."adminNote"`,
    requestId, parentUserId, statusAfterParentMessage(),
  ).catch((error) => {
    console.error("[inquiry-thread] 문의 상태 되돌리기 실패:", error);
    return [] as { title: string; studentName: string | null; adminNote: string | null }[];
  });
  // 원장 알림 = 바로 앞 글이 학원 글일 때만(연달아 쓰는 글마다 알림을 만들지 않는다). 앞 글을 못 읽으면 알림을 만드는 쪽으로
  const { available, byRequest } = await readInquiryMessages(db, [requestId]);
  const messages = byRequest.get(requestId) ?? [];
  const previous = messages.length >= 2 ? messages[messages.length - 2] : null;
  const notifyAdmins = !available || heads.length === 0
    ? true
    : shouldNotifyAdminsOfFollowUp(previous ? (previous.authorRole === "ADMIN" ? "ADMIN" : "PARENT") : null, heads[0].adminNote);
  return { ok: true, requestId, title: heads[0]?.title ?? "문의", studentName: heads[0]?.studentName ?? null, notifyAdmins };
}

// ── 관리자: 대화 보기·답하기 ─────────────────────────────────────────────────

/** 관리자 요청함 상세의 대화(호출 전에 requireAdmin 통과). 없는 문의는 null */
export async function getInquiryThreadForAdmin(db: InquiryDb, requestId: string): Promise<{ bubbles: InquiryBubble[]; canReply: boolean } | null> {
  const heads = await db.$queryRawUnsafe<{ id: string; content: string; status: string; adminNote: string | null; createdAt: Date | string }[]>(
    `SELECT id, content, status, "adminNote", "createdAt" FROM "ParentRequest" WHERE id = $1 LIMIT 1`,
    requestId,
  );
  const head = heads[0];
  if (!head) return null;
  const { available, byRequest } = await readInquiryMessages(db, [head.id]);
  return { bubbles: buildInquiryThread({ ...head, createdAt: iso(head.createdAt) }, byRequest.get(head.id) ?? []), canReply: available };
}

export type AdminReplyResult =
  | { ok: true; parentUserId: string; title: string; status: string; /** 새 표가 없어 예전 칸(adminNote)에 저장했는가 */ legacy: boolean }
  | { ok: false; error: string };

/**
 * 학원이 문의에 답을 이어 쓴다(+ 상태를 같이 고르면 그 상태로).
 * 새 표가 아직 없으면 예전처럼 adminNote 한 줄에 저장한다(답변 기능이 마이그레이션 적용을 기다리며 멈추지 않게).
 */
export async function addAdminInquiryReply(db: InquiryDb, adminUserId: string, requestId: string, rawBody: unknown, chosenStatus?: string | null): Promise<AdminReplyResult> {
  const cleaned = cleanInquiryBody(rawBody);
  if (!cleaned.ok) return cleaned;
  const heads = await db.$queryRawUnsafe<{ id: string; userId: string; title: string; status: string }[]>(
    `SELECT id, "userId", title, status FROM "ParentRequest" WHERE id = $1 LIMIT 1`,
    requestId,
  );
  const head = heads[0];
  if (!head) return { ok: false, error: "요청을 찾을 수 없습니다. 목록을 다시 확인해 주세요." };
  const nextStatus = statusAfterAdminReply(head.status, chosenStatus);

  let legacy = false;
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "ParentRequestMessage" (id, "requestId", "authorRole", "authorUserId", body, "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'ADMIN', $2, $3, NOW())`,
      head.id, adminUserId, cleaned.body,
    );
  } catch (error) {
    if (!isMissingInquirySchema(error)) {
      console.error("[inquiry-thread] 학원 답 저장 실패:", error);
      return { ok: false, error: "답변을 저장하지 못했습니다. 다시 시도해 주세요." };
    }
    legacy = true;
  }
  try {
    if (legacy) {
      await db.$executeRawUnsafe(
        `UPDATE "ParentRequest" SET "adminNote" = $2, status = $3, "updatedAt" = NOW() WHERE id = $1`,
        head.id, cleaned.body, nextStatus,
      );
    } else {
      await db.$executeRawUnsafe(
        `UPDATE "ParentRequest" SET status = $2, "updatedAt" = NOW() WHERE id = $1`,
        head.id, nextStatus,
      );
    }
  } catch (error) {
    console.error("[inquiry-thread] 문의 상태 저장 실패:", error);
    // 옛 칸에 저장하는 길이 실패했으면 답이 저장되지 않은 것이다
    if (legacy) return { ok: false, error: "답변을 저장하지 못했습니다. 다시 시도해 주세요." };
    // 새 표에 답은 저장됐다 — 상태만 예전 값으로 남는다
    return { ok: true, parentUserId: head.userId, title: head.title, status: head.status, legacy };
  }
  return { ok: true, parentUserId: head.userId, title: head.title, status: nextStatus, legacy };
}

/** 신청함(inbox) 줄에 붙일 «이어 쓴 글» — [라벨, 글] 목록. 표가 없으면 빈 지도 */
export async function inquiryFollowUpFacts(db: InquiryDb, requestIds: readonly string[]): Promise<Map<string, [string, string][]>> {
  const out = new Map<string, [string, string][]>();
  const { byRequest } = await readInquiryMessages(db, requestIds);
  for (const [requestId, messages] of byRequest) {
    out.set(requestId, messages.map((message) => [message.authorRole === "ADMIN" ? "학원 답" : "학부모 추가 글", message.body]));
  }
  return out;
}

// ── 환불 문의(c11) ───────────────────────────────────────────────────────────

export const REFUND_PAYMENT_NOT_FOUND = "청구를 찾을 수 없어요. 청구 화면을 새로 열어 주세요.";
export const REFUND_NOT_PAID = "납부 완료된 청구만 환불을 문의할 수 있어요.";

export type RefundInquiryResult =
  | { ok: true; requestId: string; title: string; studentName: string; /** 이미 열려 있던 문의로 안내했는가(새로 만들지 않음) */ existing: boolean }
  | { ok: false; error: string };

/**
 * 납부 완료 청구에 대한 환불 문의를 만든다 — «문의 접수»까지만(실제 환불은 관리자 기존 기능).
 * - 내 아이의 청구인지 같은 SQL 에서 확인(childAccessSql) — 남의 청구 id 면 0행.
 * - 같은 청구에 아직 끝나지 않은 내 환불 문의가 있으면 새로 만들지 않고 그 문의를 돌려준다.
 * - 청구 연결(paymentId·paymentAmount) 칸이 없는 환경이면 연결 없이 접수한다(제목에 청구 내용이 적힌다).
 */
export async function createRefundInquiry(db: InquiryDb, parentUserId: string, paymentId: string, rawReason: unknown): Promise<RefundInquiryResult> {
  // 사유는 «선택» 칸 — 길이·줄바꿈 정리는 문의 글과 같은 함수 한 곳(빈 글만 허용)
  const cleaned = cleanInquiryBody(rawReason, { allowEmpty: true });
  if (!cleaned.ok) return cleaned;
  const reason = cleaned.body;
  const payments = await db.$queryRawUnsafe<{ id: string; amount: number; status: string; type: string | null; description: string | null; year: number | null; month: number | null; studentId: string; studentName: string }[]>(
    `SELECT p.id, p.amount, p.status, p.type, p.description, p.year, p.month, s.id AS "studentId", s.name AS "studentName"
       FROM "Payment" p
       JOIN "Student" s ON s.id = p."studentId"
      WHERE p.id = $2 AND ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      LIMIT 1`,
    parentUserId, paymentId,
  );
  const payment = payments[0];
  if (!payment) return { ok: false, error: REFUND_PAYMENT_NOT_FOUND };
  if (!canAskRefund(payment.status)) return { ok: false, error: REFUND_NOT_PAID };

  const amount = Number(payment.amount ?? 0);
  const title = refundInquiryTitle({
    year: payment.year === null ? null : Number(payment.year),
    month: payment.month === null ? null : Number(payment.month),
    label: billItemLabel({ type: payment.type, description: payment.description }),
    amount,
  });

  const content = refundInquiryContent(reason, title);
  const failed: RefundInquiryResult = { ok: false, error: "보내지 못했어요. 다시 시도해 주세요." };
  // 같은 청구에 아직 끝나지 않은 내 환불 문의(열린 상태 = PENDING·CONFIRMED — 마이그레이션의 부분 유일 색인과 같은 집합)
  const findOpen = () => db.$queryRawUnsafe<{ id: string; title: string }[]>(
    `SELECT id, title FROM "ParentRequest"
      WHERE "userId" = $1 AND "paymentId" = $2 AND status IN ('PENDING', 'CONFIRMED')
      ORDER BY "createdAt" DESC LIMIT 1`,
    parentUserId, payment.id,
  );
  const existingResult = async (): Promise<RefundInquiryResult> => {
    try {
      const open = await findOpen();
      return open[0] ? { ok: true, requestId: open[0].id, title: open[0].title, studentName: payment.studentName, existing: true } : failed;
    } catch (error) {
      console.error("[inquiry-thread] 열린 환불 문의 조회 실패:", error);
      return failed;
    }
  };

  // 문의 만들기 + 청구 연결 + 중복 확인을 «한 문장»으로 — 열린 문의가 이미 있으면 0행(동시에 두 번 눌러도 부분 유일 색인이 막는다)
  let created: { id: string }[];
  try {
    created = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "ParentRequest" (id, "userId", "studentId", type, title, content, date, status, "createdAt", "updatedAt", "paymentId", "paymentAmount")
       SELECT gen_random_uuid()::text, $1, $2, 'OTHER', $3, $4, NULL, 'PENDING', NOW(), NOW(), $5::text, $6::int
        WHERE NOT EXISTS (SELECT 1 FROM "ParentRequest" x
                           WHERE x."userId" = $1 AND x."paymentId" = $5::text AND x.status IN ('PENDING', 'CONFIRMED'))
       RETURNING id`,
      parentUserId, payment.studentId, title, content, payment.id, amount,
    );
  } catch (error) {
    // 유일 색인 위반 = 방금 다른 요청이 먼저 만들었다 → 그 문의로 안내
    if (isUniqueViolation(error)) return existingResult();
    if (!isMissingInquirySchema(error)) {
      console.error("[inquiry-thread] 환불 문의 저장 실패:", error);
      return failed;
    }
    // 청구 연결 칸이 아직 없는 환경(마이그레이션 적용 전)에서만: 연결 없이 접수한다(제목에 청구 내용이 적힌다. 중복 확인은 할 수 없다)
    try {
      created = await db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "ParentRequest" (id, "userId", "studentId", type, title, content, date, status, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'OTHER', $3, $4, NULL, 'PENDING', NOW(), NOW())
         RETURNING id`,
        parentUserId, payment.studentId, title, content,
      );
    } catch (fallbackError) {
      console.error("[inquiry-thread] 환불 문의 저장 실패:", fallbackError);
      return failed;
    }
  }
  const requestId = created[0]?.id;
  // 0행 = 열린 문의가 이미 있다 → 새로 만들지 않고 그 문의로 안내
  if (!requestId) return existingResult();
  return { ok: true, requestId, title, studentName: payment.studentName, existing: false };
}
