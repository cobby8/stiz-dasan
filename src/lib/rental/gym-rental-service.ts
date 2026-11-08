/**
 * 체육관 대관 — DB 연결부.
 *
 * 왜 DB 를 인자(db)로 받나: 이 파일은 prisma 를 직접 import 하지 않는다. 그래서 테스트가
 * 가짜 DB 를 끼워 «실제로 실행»해 검증할 수 있다(conventions 2026-09-29).
 * SQL 은 $queryRawUnsafe/$executeRawUnsafe 만 쓴다(PgBouncer 트랜잭션 모드).
 *
 * 이중 확정 방지 두 겹:
 *  1) 승인 시 트랜잭션 안에서 그날 대관을 advisory lock 으로 줄 세운 뒤 겹침을 다시 본다.
 *  2) 그래도 새는 경우는 DB EXCLUDE 제약(GymRentalRequest_no_overlap)이 막는다 → 23P01 오류.
 */
import { addDaysKst, isKstYmd, kstAt, todayKst } from "@/lib/datetime/kst";
import {
  RENTAL_HOLDING_STATUSES,
  RENTAL_START_STEP_MINUTES,
  RENTAL_TRANSITIONS,
  buildRentalDay,
  calculateRentalFee,
  cleanRentalText,
  isBookableDate,
  isRentalAction,
  isRentalRangeAvailable,
  isValidRentalDuration,
  normalizeRentalPhone,
  parseCancelRefund,
  rentalHourColumns,
  rentalInstantMs,
  type RentalAction,
  type RentalBusyRange,
  type RentalClassRow,
  type RentalDay,
  type RentalStatus,
} from "@/lib/rental/gym-rental-rules";

export type RawSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

const HOLDING_SQL = RENTAL_HOLDING_STATUSES.map((s) => `'${s}'`).join(",");

// ── 가능 시간 ─────────────────────────────────────────────────────────────
type InstantRow = { startsAt: Date | string; endsAt: Date | string };

/** 절대 시각 구간 → 그날(KST) 0시 기준 분 구간 */
function toDayMinutes(rows: InstantRow[], dayStartMs: number): RentalBusyRange[] {
  return rows
    .map((row) => ({
      startMinute: Math.max(0, Math.floor((new Date(row.startsAt).getTime() - dayStartMs) / 60_000)),
      endMinute: Math.min(24 * 60, Math.ceil((new Date(row.endsAt).getTime() - dayStartMs) / 60_000)),
    }))
    .filter((row) => Number.isFinite(row.startMinute) && Number.isFinite(row.endMinute) && row.endMinute > row.startMinute);
}

/** 그날의 시작 후보(10분 간격) — 정규 수업·특강 회차·승인된 대관을 빼고 계산 */
export async function loadRentalDay(db: RawSqlClient, date: string, nowMs: number): Promise<RentalDay | null> {
  if (!isKstYmd(date)) return null;
  const dayStartMs = kstAt(date);
  const dayEndMs = kstAt(addDaysKst(date, 1));
  const dayStart = new Date(dayStartMs).toISOString();
  const dayEnd = new Date(dayEndMs).toISOString();

  // 승인 트랜잭션(tx) 안에서도 부르므로 동시에 쏘지 않고 차례로 조회한다.
  // 정규 반(요일 반)만. Archived·Seasonal 은 요일 시간표가 아니고,
  // «[종료]» 처럼 이름이 '[' 로 시작하는 끝난 반과 ACTIVE 수강생이 없는 반은 실제 수업이 없어 뺀다.
  const classes = await db.$queryRawUnsafe<RentalClassRow[]>(
    `SELECT c."dayOfWeek", c."startTime", c."endTime" FROM "Class" c
      WHERE c."dayOfWeek" IN ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')
        AND c.name NOT LIKE '[%'
        AND EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."classId" = c.id AND e.status = 'ACTIVE')`,
  );
  // 방학특강 회차(취소된 상품 제외)
  const sessions = await db.$queryRawUnsafe<InstantRow[]>(
    `SELECT d."startsAt", d."endsAt"
       FROM "SpecialProgramSessionDate" d
       JOIN "SpecialProgramOffering" o ON o.id = d."offeringId"
      WHERE o.status <> 'CANCELLED'
        AND d."startsAt" < $2::timestamptz AND d."endsAt" > $1::timestamptz`,
    dayStart,
    dayEnd,
  );
  // 이미 승인된(시간을 차지한) 대관
  const rentals = await db.$queryRawUnsafe<InstantRow[]>(
    `SELECT "startAt" AS "startsAt", "endAt" AS "endsAt"
       FROM "GymRentalRequest"
      WHERE status IN (${HOLDING_SQL})
        AND "startAt" < $2::timestamptz AND "endAt" > $1::timestamptz`,
    dayStart,
    dayEnd,
  );

  const booked = toDayMinutes(rentals, dayStartMs);
  return buildRentalDay({
    date,
    classes,
    busy: toDayMinutes(sessions, dayStartMs),
    bookedBusy: booked,
    nowMs,
  });
}

// ── 신청 접수 ─────────────────────────────────────────────────────────────
export type RentalApplyInput = {
  rentalDate: unknown;
  startMinute?: unknown; // 그날 KST 0시부터 분(10분 단위)
  durationMinutes?: unknown; // 이용 분(30분 단위, 60~360)
  // 옛 화면(정시 칸)이 보내던 값 — 배포 직후 열려 있던 화면에서 와도 받아 준다
  startHour?: unknown;
  hours?: unknown;
  headcount: unknown;
  useAircon: unknown;
  applicantName: unknown;
  applicantPhone: unknown;
  purpose: unknown;
  agreedRules: unknown;
};

export type RentalRecord = {
  id: string;
  rentalDate: string;
  startHour: number;
  endHour: number;
  startMinute: number;
  endMinute: number;
  headcount: number;
  useAircon: boolean;
  applicantName: string;
  applicantPhone: string;
  purpose: string | null;
  usageFee: number;
  deposit: number;
  totalAmount: number;
  depositRefunded: number | null;
  cancelRefundAmount: number | null;
  status: RentalStatus;
  adminMemo: string | null;
  createdAt: Date | string;
  approvedAt: Date | string | null;
  paidAt: Date | string | null;
  completedAt: Date | string | null;
  refundedAt: Date | string | null;
  closedAt: Date | string | null;
};

export type RentalApplyResult =
  | { ok: true; duplicate: boolean; request: RentalRecord }
  | { ok: false; message: string };

// 분 컬럼이 빈 옛 행(배포 전환 틈에 옛 코드가 저장한 행)은 정시 값으로 채워 읽는다
const RECORD_COLUMNS = `id, "rentalDate", "startHour", "endHour",
  COALESCE("startMinute", "startHour" * 60)::int AS "startMinute", COALESCE("endMinute", "endHour" * 60)::int AS "endMinute", headcount, "useAircon", "applicantName", "applicantPhone",
  purpose, "usageFee", deposit, "totalAmount", "depositRefunded", "cancelRefundAmount", status, "adminMemo", "createdAt",
  "approvedAt", "paidAt", "completedAt", "refundedAt", "closedAt"`;

/** 같은 연락처 반복 신청 제한(기존 공개 폼과 같은 방식 — 짧은 시간 횟수 제한) */
export const RENTAL_RATE_LIMIT = { perPhone10Min: 3, perPhoneDay: 6, perIp10Min: 5, perIpDay: 15, global10Min: 30 } as const;

/**
 * 공개 신청 1건. 금액은 여기서 **다시 계산**한다(화면이 보낸 금액은 받지도 않는다).
 * ⚠️ 반드시 트랜잭션의 tx 로 부른다 — 한도 확인과 저장 사이에 다른 신청이 끼지 않게
 *    신청 전체를 advisory lock 하나로 줄 세운다(동시에 여러 건을 쏴서 한도를 넘기는 것 방지).
 * clientIpHash: 접속 주소의 sha256(원문 IP 는 저장하지 않는다). 모르면 null.
 */
export async function createRentalRequest(
  db: RawSqlClient,
  input: RentalApplyInput,
  nowMs: number,
  clientIpHash: string | null = null,
): Promise<RentalApplyResult> {
  const rentalDate = String(input.rentalDate ?? "");
  // 새 화면은 분으로 보낸다. 옛 화면(정시·시간)이 보낸 값은 분으로 바꿔 같은 검사를 거친다.
  const startMinute = input.startMinute !== undefined && input.startMinute !== null
    ? Number(input.startMinute)
    : Number(input.startHour) * 60;
  const durationMinutes = input.durationMinutes !== undefined && input.durationMinutes !== null
    ? Number(input.durationMinutes)
    : Number(input.hours) * 60;
  const headcount = Number(input.headcount);
  const useAircon = input.useAircon === true;
  const applicantName = cleanRentalText(input.applicantName, 40).replace(/\s+/g, " ");
  const applicantPhone = normalizeRentalPhone(String(input.applicantPhone ?? ""));
  const purpose = cleanRentalText(input.purpose, 300) || null;

  if (!isBookableDate(rentalDate, todayKst(nowMs))) return { ok: false, message: "신청할 수 없는 날짜입니다. 날짜를 다시 골라 주세요." };
  // 화면 값을 믿지 않는다 — 시작은 10분 단위, 이용은 30분 단위(1~6시간)
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute % RENTAL_START_STEP_MINUTES !== 0
    || !isValidRentalDuration(durationMinutes)) {
    return { ok: false, message: "이용 시간을 다시 골라 주세요." };
  }
  const endMinute = startMinute + durationMinutes;
  if (!applicantName) return { ok: false, message: "신청자 이름을 입력해 주세요." };
  if (!applicantPhone) return { ok: false, message: "휴대폰 번호를 정확히 입력해 주세요. 예: 010-1234-5678" };
  if (!purpose) return { ok: false, message: "사용 목적을 입력해 주세요. 예: 동호회 농구 연습" };
  if (input.agreedRules !== true) return { ok: false, message: "이용 규칙에 동의해 주세요." };

  let fee;
  try {
    fee = calculateRentalFee({ durationMinutes, headcount, useAircon });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }

  // 여기부터 저장까지 공개 신청은 한 줄로 선다(트랜잭션이 끝나면 자동으로 풀린다)
  await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "gym-rental:apply");
  const ipHash = clientIpHash && /^[0-9a-f]{64}$/.test(clientIpHash) ? clientIpHash : null;

  // 같은 연락처·같은 시간 신청이 이미 살아 있으면 새로 만들지 않고 그 건을 보여 준다(두 번 누름 방지)
  const existing = await db.$queryRawUnsafe<RentalRecord[]>(
    `SELECT ${RECORD_COLUMNS} FROM "GymRentalRequest"
      WHERE "applicantPhone" = $1 AND "rentalDate" = $2
        AND COALESCE("startMinute", "startHour" * 60) = $3 AND COALESCE("endMinute", "endHour" * 60) = $4
        AND status IN ('REQUESTED','APPROVED','PAID')
      ORDER BY "createdAt" DESC LIMIT 1`,
    applicantPhone, rentalDate, startMinute, endMinute,
  );
  if (existing[0]) return { ok: true, duplicate: true, request: existing[0] };

  const counts = await db.$queryRawUnsafe<Array<{ phone10: number; phoneDay: number; ip10: number; ipDay: number; all10: number }>>(
    `SELECT
       COUNT(*) FILTER (WHERE "applicantPhone" = $1 AND "createdAt" > now() - interval '10 minutes')::int AS phone10,
       COUNT(*) FILTER (WHERE "applicantPhone" = $1)::int AS "phoneDay",
       COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND "clientIpHash" = $2::text AND "createdAt" > now() - interval '10 minutes')::int AS ip10,
       COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND "clientIpHash" = $2::text)::int AS "ipDay",
       COUNT(*) FILTER (WHERE "createdAt" > now() - interval '10 minutes')::int AS all10
     FROM "GymRentalRequest" WHERE "createdAt" > now() - interval '1 day'`,
    applicantPhone,
    ipHash,
  );
  const c = counts[0] ?? { phone10: 0, phoneDay: 0, ip10: 0, ipDay: 0, all10: 0 };
  if (Number(c.phone10) >= RENTAL_RATE_LIMIT.perPhone10Min
    || Number(c.phoneDay) >= RENTAL_RATE_LIMIT.perPhoneDay
    || Number(c.ip10) >= RENTAL_RATE_LIMIT.perIp10Min
    || Number(c.ipDay) >= RENTAL_RATE_LIMIT.perIpDay
    || Number(c.all10) >= RENTAL_RATE_LIMIT.global10Min) {
    return { ok: false, message: "신청이 너무 많이 접수되었습니다. 잠시 후 다시 시도해주세요." };
  }

  // 화면을 연 뒤 시간이 지났거나 다른 대관이 승인됐을 수 있다 — 서버가 다시 본다
  // 영업 시간(평일 09시·주말 10시 ~ 22시)·수업·특강·승인 대관 겹침을 서버가 다시 본다
  const day = await loadRentalDay(db, rentalDate, nowMs);
  if (!isRentalRangeAvailable(day, startMinute, durationMinutes)) {
    return { ok: false, message: "선택한 시간에 수업이나 다른 대관이 있거나 이용 가능 시간이 아닙니다. 다른 시간을 골라 주세요." };
  }

  // 기존 정시 컬럼(NOT NULL·CHECK)은 내림/올림으로 계속 채운다. 겹침 판정은 분 단위 startAt/endAt 이 기준.
  const { startHour, endHour } = rentalHourColumns(startMinute, endMinute);
  const rows = await db.$queryRawUnsafe<RentalRecord[]>(
    `INSERT INTO "GymRentalRequest" (
       "rentalDate", "startHour", "endHour", "startAt", "endAt", headcount, "useAircon",
       "applicantName", "applicantPhone", purpose, "usageFee", deposit, "totalAmount",
       "clientIpHash", status, "rulesAgreedAt", "createdAt", "updatedAt", "startMinute", "endMinute"
     ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, 'REQUESTED', now(), now(), now(), $15, $16)
     RETURNING ${RECORD_COLUMNS}`,
    rentalDate, startHour, endHour,
    new Date(rentalInstantMs(rentalDate, startMinute)).toISOString(),
    new Date(rentalInstantMs(rentalDate, endMinute)).toISOString(),
    fee.headcount, useAircon, applicantName, applicantPhone, purpose,
    fee.usageFee, fee.deposit, fee.total, ipHash, startMinute, endMinute,
  );
  if (!rows[0]) return { ok: false, message: "신청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  return { ok: true, duplicate: false, request: rows[0] };
}

// ── 관리자: 목록 ──────────────────────────────────────────────────────────
export async function listRentalRequests(db: RawSqlClient): Promise<RentalRecord[]> {
  // 처리할 것(승인 대기 → 입금 대기 → 확정 → 환불 대기) 먼저, 같은 상태 안에서는 이용일 가까운 순
  return db.$queryRawUnsafe<RentalRecord[]>(
    `SELECT ${RECORD_COLUMNS} FROM "GymRentalRequest"
      ORDER BY CASE status WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'PAID' THEN 2
                           WHEN 'COMPLETED' THEN 3 ELSE 4 END,
               CASE WHEN status IN ('REFUNDED','REJECTED','CANCELLED') THEN NULL ELSE "startAt" END ASC NULLS LAST,
               "createdAt" DESC
      LIMIT 300`,
  );
}

// ── 관리자: 상태 바꾸기 ───────────────────────────────────────────────────
export type RentalTransitionOptions = { memo?: unknown; depositRefunded?: unknown; cancelRefund?: unknown; nowMs?: number };
export type RentalTransitionResult =
  | { ok: true; request: RentalRecord; previousStatus: RentalStatus }
  | { ok: false; message: string };

/**
 * 버튼 하나 = 상태 하나. 반드시 트랜잭션의 tx 로 부른다.
 * 1) 그 행을 FOR UPDATE 로 잠근다 → 두 번 눌러도 두 번째는 바뀐 상태를 보고 거절된다.
 * 2) 승인은 그날 대관 전체를 advisory lock 으로 줄 세우고, 이미 승인된 대관과 겹치면 거절한다.
 */
export async function transitionRentalInTx(
  tx: RawSqlClient,
  id: string,
  action: RentalAction,
  actorUserId: string,
  options: RentalTransitionOptions = {},
): Promise<RentalTransitionResult> {
  if (!isRentalAction(action)) return { ok: false, message: "알 수 없는 작업입니다." };
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, message: "대관 신청을 찾을 수 없습니다." };
  const rule = RENTAL_TRANSITIONS[action];

  const locked = await tx.$queryRawUnsafe<Array<{
    id: string; status: RentalStatus; rentalDate: string; deposit: number; startMinute: number; endMinute: number; totalAmount: number;
  }>>(
    `SELECT id, status, "rentalDate", deposit,
            COALESCE("startMinute", "startHour" * 60)::int AS "startMinute",
            COALESCE("endMinute", "endHour" * 60)::int AS "endMinute", "totalAmount"
       FROM "GymRentalRequest" WHERE id = $1 FOR UPDATE`,
    id,
  );
  const row = locked[0];
  if (!row) return { ok: false, message: "대관 신청을 찾을 수 없습니다." };
  if (!(rule.from as readonly string[]).includes(row.status)) {
    return { ok: false, message: "이미 다른 상태로 바뀐 신청입니다. 새로고침 후 다시 확인해 주세요." };
  }

  if (action === "approve") {
    // 같은 날 승인끼리 줄 세우기(트랜잭션이 끝나면 자동으로 풀린다)
    // 날짜를 넘나드는 대관은 없으므로(최대 22시 종료) 날짜 하나로 줄 세우면 충분하다
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `gym-rental:${row.rentalDate}`);
    const clash = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT o.id FROM "GymRentalRequest" o, "GymRentalRequest" me
        WHERE me.id = $1 AND o.id <> me.id AND o.status IN (${HOLDING_SQL})
          AND o."startAt" < me."endAt" AND me."startAt" < o."endAt"
        LIMIT 1`,
      id,
    );
    if (clash[0]) return { ok: false, message: "이미 승인된 다른 대관과 시간이 겹칩니다. 거절하거나 시간을 조정해 주세요." };
    // 신청한 뒤에 생긴 정규 수업·특강 회차와 겹치거나 이미 시작한 시간이면 승인하지 않는다
    const day = await loadRentalDay(tx, row.rentalDate, options.nowMs ?? Date.now());
    if (!isRentalRangeAvailable(day, Number(row.startMinute), Number(row.endMinute) - Number(row.startMinute))) {
      return { ok: false, message: "그 시간에 수업·특강이 생겼거나 이미 지난 시간입니다. 거절하거나 시간을 조정해 주세요." };
    }
  }

  // 입금 확인(확정) 뒤 취소 = 돈이 이미 들어왔다 → 돌려준 금액을 꼭 적는다
  let cancelRefund: number | null = null;
  if (action === "cancel" && row.status === "PAID") {
    cancelRefund = parseCancelRefund(options.cancelRefund, row.totalAmount);
    if (cancelRefund === null) {
      return { ok: false, message: `돌려준 금액을 0원 ~ ${row.totalAmount.toLocaleString("ko-KR")}원 사이로 입력해 주세요.` };
    }
  }

  let depositRefunded: number | null = null;
  if (action === "refund") {
    const raw = options.depositRefunded;
    depositRefunded = raw === undefined || raw === null || raw === "" ? row.deposit : Number(raw);
    if (!Number.isInteger(depositRefunded) || depositRefunded < 0 || depositRefunded > row.deposit) {
      return { ok: false, message: `환불 금액은 0원 ~ ${row.deposit.toLocaleString("ko-KR")}원 사이로 입력해 주세요.` };
    }
  }

  const typedMemo = cleanRentalText(options.memo, 200);
  // 확정 뒤 취소는 돌려준 금액을 메모에도 남긴다(누가 얼마를 돌려줬는지 기록)
  const memo = cancelRefund !== null
    ? `환불 ${cancelRefund.toLocaleString("ko-KR")}원${typedMemo ? ` · ${typedMemo}` : ""}`
    : typedMemo;
  const stampColumn: Record<RentalAction, string> = {
    approve: `"approvedAt"`,
    reject: `"closedAt"`,
    confirmPayment: `"paidAt"`,
    complete: `"completedAt"`,
    refund: `"refundedAt"`,
    cancel: `"closedAt"`,
  };

  const updated = await tx.$queryRawUnsafe<RentalRecord[]>(
    `UPDATE "GymRentalRequest"
        SET status = $2,
            ${stampColumn[action]} = now(),
            "decidedByUserId" = $3,
            "depositRefunded" = COALESCE($4::int, "depositRefunded"),
            "cancelRefundAmount" = COALESCE($8::int, "cancelRefundAmount"),
            -- 메모는 덮어쓰지 않고 한 줄씩 덧붙인다(누가 언제 왜 바꿨는지 남게)
            "adminMemo" = CASE WHEN $5::text = '' THEN "adminMemo"
                               ELSE left(concat_ws(E'\n', "adminMemo", $6::text || ': ' || $5::text), 500) END,
            "updatedAt" = now()
      WHERE id = $1 AND status = $7
      RETURNING ${RECORD_COLUMNS}`,
    id, rule.to, actorUserId, depositRefunded, memo, rule.label, row.status, cancelRefund,
  );
  if (!updated[0]) return { ok: false, message: "이미 다른 상태로 바뀐 신청입니다. 새로고침 후 다시 확인해 주세요." };
  return { ok: true, request: updated[0], previousStatus: row.status };
}

/** DB 겹침 제약(EXCLUDE) 위반인가 — 동시에 두 건을 승인했을 때 마지막 방어선 */
export function isRentalOverlapViolation(error: unknown): boolean {
  const text = `${(error as { code?: string })?.code ?? ""} ${(error as Error)?.message ?? ""}`;
  return /23P01|GymRentalRequest_no_overlap|exclusion constraint/i.test(text);
}
