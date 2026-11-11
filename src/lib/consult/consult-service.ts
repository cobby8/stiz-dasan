/**
 * 상담 신청 — DB 연결부 (db 인자로 받는다 · 체육관 대관 서비스와 같은 방식)
 *
 * 왜 db 를 인자로 받나: prisma 를 직접 import 하면 node 테스트가 이 파일을 못 돌린다.
 * 서버 액션(src/app/actions/consult.ts)과 신청함(src/lib/requests/consult-inbox.ts)이 prisma 를 넘겨 부른다.
 *
 * SQL 은 $queryRawUnsafe/$executeRawUnsafe 만 쓴다(PgBouncer 트랜잭션 모드 — ORM 기본 메서드 금지).
 */
import type { InboxFact, InboxRow } from "@/lib/requests/admin-inbox";
import { isKstYmd, toKstYmd } from "@/lib/datetime/kst";
import {
  CONSULT_SOURCE_LABEL,
  CONSULT_STATUS_MAP,
  CONSULT_TRANSITIONS,
  CONSULT_LIMITS,
  cleanConsultText,
  consultActionsFor,
  formatConsultPhone,
  isConsultAction,
  isConsultRateLimited,
  validateConsultInput,
  type CleanConsultInput,
  type ConsultInput,
  type ConsultRateCounts,
  type ConsultSource,
  type ConsultStatus,
} from "@/lib/consult/consult-rules";

export type ConsultSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

export type ConsultRecord = {
  id: string;
  studentName: string;
  grade: string;
  guardianName: string | null;
  guardianPhone: string;
  preferredDays: string | null;
  preferredTimes: string | null;
  message: string | null;
  source: ConsultSource;
  requestedByUserId: string | null;
  status: ConsultStatus;
  adminNote: string | null;
  contactedAt: Date | string | null;
  closedAt: Date | string | null;
  handledByUserId: string | null;
  handledByName: string | null;
  createdAt: Date | string;
};

const COLUMNS = `x.id, x."studentName", x.grade, x."guardianName", x."guardianPhone", x."preferredDays", x."preferredTimes",
  x.message, x.source, x."requestedByUserId", x.status, x."adminNote", x."contactedAt", x."closedAt",
  x."handledByUserId", hu.name AS "handledByName", x."createdAt"`;
const FROM = `"ConsultRequest" x LEFT JOIN "User" hu ON hu.id = x."handledByUserId"`;

export type CreateConsultOptions = {
  source: ConsultSource;
  /** 학부모 앱에서 보낸 경우만 — 서버가 로그인으로 확인한 값(화면 값 아님) */
  requestedByUserId?: string | null;
  /** 접속 주소의 sha256(원문 IP 는 저장하지 않는다). 모르면 null */
  clientIpHash?: string | null;
};

export type CreateConsultResult =
  | { ok: true; duplicate: boolean; id: string; value: CleanConsultInput }
  | { ok: false; message: string };

/**
 * 상담 신청 1건 저장.
 * ⚠️ 트랜잭션의 tx 로 부른다 — 한도 확인과 저장 사이에 다른 신청이 끼지 않게 advisory lock 으로 줄 세운다.
 * 순서: 잠금 → 한도 확인 → 중복 확인 → 저장. 하루 안에 같은 내용으로 접수한 «새 상담»을 재사용한다.
 * 한도를 넘으면 중복이어도 한도 거절이 먼저다.
 */
export async function createConsultRequest(db: ConsultSqlClient, input: ConsultInput, options: CreateConsultOptions): Promise<CreateConsultResult> {
  const checked = validateConsultInput(input);
  if (!checked.ok) return checked;
  const v = checked.value;
  // 앱 신청은 계정이 반드시 있어야 한다(DB CHECK 와 같은 규칙 — 여기서 먼저 막아 쉬운 말로 돌려준다)
  const requestedByUserId = options.requestedByUserId?.trim() || null;
  if (options.source === "PARENT_APP" && !requestedByUserId) return { ok: false, message: "로그인한 학부모 계정에서만 보낼 수 있어요." };
  const ipHash = options.clientIpHash && /^[0-9a-f]{64}$/.test(options.clientIpHash) ? options.clientIpHash : null;

  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "consult:apply");

  const counts = await db.$queryRawUnsafe<ConsultRateCounts[]>(
    `SELECT
       COUNT(*) FILTER (WHERE "guardianPhone" = $1 AND "createdAt" > now() - interval '10 minutes')::int AS phone10,
       COUNT(*) FILTER (WHERE "guardianPhone" = $1)::int AS "phoneDay",
       COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND "clientIpHash" = $2::text AND "createdAt" > now() - interval '10 minutes')::int AS ip10,
       COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND "clientIpHash" = $2::text)::int AS "ipDay",
       COUNT(*) FILTER (WHERE "createdAt" > now() - interval '10 minutes')::int AS all10
     FROM "ConsultRequest" WHERE "createdAt" > now() - interval '1 day'`,
    v.guardianPhone, ipHash,
  );
  if (isConsultRateLimited(counts[0])) return { ok: false, message: "신청이 너무 많이 접수되었습니다. 잠시 후 다시 시도해 주세요." };

  // 학생·연락처가 같아도 희망 수업이나 요청사항이 바뀌었으면 새 요청으로 접수한다.
  const existing = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "ConsultRequest"
      WHERE "guardianPhone" = $1 AND LOWER("studentName") = LOWER($2) AND status = 'NEW'
        AND grade = $3
        AND "guardianName" IS NOT DISTINCT FROM $4::text
        AND "preferredDays" IS NOT DISTINCT FROM $5::text
        AND "preferredTimes" IS NOT DISTINCT FROM $6::text
        AND message IS NOT DISTINCT FROM $7::text
        AND "requestedByUserId" IS NOT DISTINCT FROM $8::text
        AND "createdAt" > now() - interval '1 day'
      ORDER BY "createdAt" DESC LIMIT 1`,
    v.guardianPhone, v.studentName, v.grade, v.guardianName, v.preferredDays, v.preferredTimes, v.message, requestedByUserId,
  );
  if (existing[0]) return { ok: true, duplicate: true, id: existing[0].id, value: v };

  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "ConsultRequest" (
       "studentName", grade, "guardianName", "guardianPhone", "preferredDays", "preferredTimes", message,
       source, "requestedByUserId", "clientIpHash", "privacyConsentAt", status, "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), 'NEW', now(), now())
     RETURNING id`,
    v.studentName, v.grade, v.guardianName, v.guardianPhone, v.preferredDays, v.preferredTimes, v.message,
    options.source, requestedByUserId, ipHash,
  );
  const id = rows[0]?.id;
  if (!id) return { ok: false, message: "신청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  return { ok: true, duplicate: false, id, value: v };
}

export type ConsultTransitionResult =
  | { ok: true; status: ConsultStatus }
  | { ok: false; message: string };

/**
 * 관리자 처리 — 연락함·완료·취소·메모.
 * 조건부 UPDATE(WHERE status = ANY(from))로 동시에 두 사람이 눌러도 상태가 꼬이지 않게 한다.
 * note: undefined 면 메모를 건드리지 않는다. 빈 글자면 메모를 지운다.
 */
export async function transitionConsultRequest(
  db: ConsultSqlClient,
  id: string,
  action: unknown,
  note: string | null | undefined,
  adminUserId: string,
): Promise<ConsultTransitionResult> {
  if (!id || typeof id !== "string") return { ok: false, message: "신청을 찾을 수 없습니다." };
  if (!isConsultAction(action)) return { ok: false, message: "알 수 없는 처리입니다." };
  const rule = CONSULT_TRANSITIONS[action];
  const noteGiven = note !== undefined;
  const cleanNote = noteGiven ? cleanConsultText(note, CONSULT_LIMITS.adminNote, true) || null : null;
  if (action === "NOTE" && !noteGiven) return { ok: false, message: "메모를 입력해 주세요." };

  const rows = await db.$queryRawUnsafe<Array<{ status: ConsultStatus }>>(
    `UPDATE "ConsultRequest" SET
        status = COALESCE($2::text, status),
        "adminNote" = CASE WHEN $3::boolean THEN $4::text ELSE "adminNote" END,
        "contactedAt" = CASE WHEN $2::text = 'CONTACTED' THEN COALESCE("contactedAt", now()) ELSE "contactedAt" END,
        "closedAt" = CASE WHEN $2::text IN ('DONE','CANCELED') THEN now() ELSE "closedAt" END,
        "handledByUserId" = $5,
        "updatedAt" = now()
      WHERE id = $1 AND status = ANY($6::text[])
      RETURNING status`,
    id, rule.to, noteGiven, cleanNote, adminUserId, [...rule.from],
  );
  if (!rows[0]) return { ok: false, message: "이미 처리됐거나 지금 상태에서는 할 수 없는 처리입니다. 새로고침해 주세요." };
  return { ok: true, status: rows[0].status };
}

export type ConsultListQuery = {
  statuses: readonly ConsultStatus[];
  /** 신청일(KST) 범위 «YYYY-MM-DD» */
  from?: string | null;
  to?: string | null;
  limit?: number;
  /** true 면 최신부터(완료 칸), 아니면 오래된 것부터(밀린 일 먼저) */
  newestFirst?: boolean;
};

/** 목록 — 상태·신청일(KST) 범위로 거른다 */
export async function listConsultRequests(db: ConsultSqlClient, query: ConsultListQuery): Promise<ConsultRecord[]> {
  if (!query.statuses.length) return [];
  const requestedLimit = query.limit ?? 150;
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : 150;
  const from = isKstYmd(query.from) ? query.from : null;
  const to = isKstYmd(query.to) ? query.to : null;
  return db.$queryRawUnsafe<ConsultRecord[]>(
    `SELECT ${COLUMNS} FROM ${FROM}
      WHERE x.status = ANY($1::text[])
        AND ($2::date IS NULL OR (x."createdAt" AT TIME ZONE 'Asia/Seoul')::date >= $2::date)
        AND ($3::date IS NULL OR (x."createdAt" AT TIME ZONE 'Asia/Seoul')::date <= $3::date)
      ORDER BY x."createdAt" ${query.newestFirst ? "DESC" : "ASC"}
      LIMIT ${limit}`,
    [...query.statuses], from, to,
  );
}

// ── 신청함 공통 행으로 바꾸기 ─────────────────────────────────────────────

/**
 * 신청함 «상담» 한 줄. 모양은 admin-inbox 의 InboxRow 와 같고 kind 만 "CONSULT".
 * catalog 의 RequestKind 에 "CONSULT" 가 들어가면 그대로 InboxRow 에 넣을 수 있다(타입이 저절로 맞는다).
 */
export type ConsultInboxRow = Omit<InboxRow, "kind"> & { kind: "CONSULT" };

/** 신청함에서 «기존 화면에서 열기» 자리 — 상담은 따로 화면이 없어 신청함 상담 탭 자체를 가리킨다 */
export const CONSULT_INBOX_HREF = "/admin/inbox?kind=CONSULT";

const dateText = (value: Date | string | null): string => (value ? toKstYmd(value) : "");

export function toConsultInboxRow(r: ConsultRecord): ConsultInboxRow {
  const status = (CONSULT_STATUS_MAP[r.status as ConsultStatus] ? r.status : "NEW") as ConsultStatus;
  const wish = [r.preferredDays, r.preferredTimes].filter(Boolean).join(" ");
  const phone = formatConsultPhone(r.guardianPhone);
  const fact = (label: string, value: string | null | undefined): InboxFact[] => (value && value.trim() ? [[label, value.trim()]] : []);
  return {
    kind: "CONSULT",
    id: r.id,
    studentName: r.studentName,
    title: `상담 신청 · ${r.grade}`,
    summary: [wish ? `희망 ${wish}` : "", (r.message ?? "").replace(/\s+/g, " ").slice(0, 60)].filter(Boolean).join(" · "),
    rawStatus: r.status,
    bucket: CONSULT_STATUS_MAP[status].bucket,
    statusLabel: CONSULT_STATUS_MAP[status].label,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    targetDate: null,
    detailHref: CONSULT_INBOX_HREF,
    facts: [
      ["학생", `${r.studentName} (${r.grade})`],
      ...fact("보호자", r.guardianName),
      ["연락처", phone],
      ...fact("희망 요일", r.preferredDays),
      ...fact("희망 시간", r.preferredTimes),
      ...fact("요청사항", r.message),
      ["접수 경로", CONSULT_SOURCE_LABEL[r.source] ?? r.source],
      ...fact("연락한 날", dateText(r.contactedAt)),
      ...fact("처리한 사람", r.handledByName),
      ...fact("원장 메모", r.adminNote),
    ],
    // 상세 칸 버튼이 쓰는 값 — 전화 걸기(tel:)·메모 칸 초기값·누를 수 있는 버튼 목록(쉼표)
    ref: {
      phone: r.guardianPhone,
      adminNote: r.adminNote ?? null,
      actions: consultActionsFor(status).join(","),
    },
  };
}

/** «새 상담»(NEW) 건수 — 메뉴 배지·«오늘 업무» 숫자 */
export async function countNewConsultRequests(db: ConsultSqlClient): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM "ConsultRequest" WHERE status = 'NEW'`);
  return Number(rows[0]?.n ?? 0) || 0;
}
