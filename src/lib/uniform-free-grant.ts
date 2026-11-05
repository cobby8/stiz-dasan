// 3년 이상 재원생 유니폼 무료 증정 — 발급·조회·신청 처리
//
// 왜 DB 를 인자(db)로 받나: 이 파일은 prisma 를 직접 import 하지 않는다. 그래서 테스트가
// 가짜 DB 를 넣어 «한 번만 접수되는지», «본사 발송을 부르지 않는지» 를 실제로 돌려 확인할 수 있다.
// 실제 연결은 서버 액션(app/actions/uniform-free.ts)·페이지가 prisma 를 넘겨서 한다.
//
// 🚫 이 파일은 uniform-order-service(본사 발송 dispatch)를 import 하지 않는다 — 무료 주문은
//    원장 확인 전까지 본사로 나가면 안 된다(테스트가 import 여부와 fetch 호출을 같이 본다).
import { randomBytes, randomUUID } from "node:crypto";
import {
  FREE_UNIFORM_STIZ_MESSAGE,
  FREE_UNIFORM_SYNC_STATUS,
  UNIFORM_FREE_GRANT_REASON,
  buildFreeUniformMemo,
  evaluateFreeGrant,
  grantUnusableMessage,
  isWellFormedGrantToken,
  type GrantUnusableReason,
} from "@/lib/uniform-free-grant-rules";
import { validateUniformItemFields, validateUniformParentFields } from "@/lib/uniform-options";
import { normalizeUniformOrderInput } from "@/lib/uniform-partner";

// prisma 와 트랜잭션 클라이언트(tx) 둘 다 이 모양을 만족한다(PgBouncer 때문에 Raw 만 쓴다)
export type RawSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

// ─── 발급 ─────────────────────────────────────────────────────────────────

/** 추측할 수 없는 링크 토큰(24바이트 난수 → base64url 32글자) */
export function generateUniformFreeToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 무료 증정 링크 발급(PM 운영 스크립트용). 같은 트랜잭션 안에서 부를 수 있게 tx 를 받는다.
 * 학생당 사유(TENURE_3Y)별로 취소되지 않은 링크는 하나뿐 — DB 부분 유니크 인덱스가 막는다.
 */
export async function createUniformFreeGrant(
  tx: RawSqlClient,
  input: { studentId: string; tenureMonths: number; expiresAt: Date },
): Promise<{ id: string; token: string }> {
  if (!input.studentId) throw new Error("studentId 가 필요합니다.");
  // 대상 기준: 실제 수강 36개월 이상(원장 결정 2026-11-05) — 스크립트 실수로 1년차에게 나가지 않게
  if (!Number.isInteger(input.tenureMonths) || input.tenureMonths < 36) {
    throw new Error("tenureMonths 는 36 이상의 정수여야 합니다(3년 이상 재원생만).");
  }
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) {
    throw new Error("expiresAt 이 올바른 시각이 아닙니다.");
  }
  const token = generateUniformFreeToken();
  const rows = await tx.$queryRawUnsafe<{ id: string; token: string }[]>(
    `INSERT INTO "UniformFreeGrant" ("studentId", token, reason, "tenureMonths", "expiresAt")
     VALUES ($1, $2, $3, $4, $5::timestamptz)
     RETURNING id, token`,
    input.studentId,
    token,
    UNIFORM_FREE_GRANT_REASON,
    input.tenureMonths,
    input.expiresAt.toISOString(), // 정확한 시각(timestamptz) 전달용 — 달력 날짜로 쓰지 않는다
  );
  return rows[0];
}

// ─── 화면 조회 ──────────────────────────────────────────────────────────────

export type FreeGrantView =
  | {
      state: "USABLE";
      studentName: string;
      tenureMonths: number;
      parentName: string;
      // 링크가 남에게 넘어가도 전체 번호가 보이지 않게 가린 번호만 내려보낸다(보안 검토 2026-11-05).
      // 학부모가 칸을 비워 두고 내면 서버가 저장된 번호를 쓴다.
      parentPhoneMask: string;
    }
  | { state: GrantUnusableReason; message: string };

/** 010-1234-5678 → 010-****-5678 (숫자가 모자라면 빈 문자열) */
export function maskParentPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) return "";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

// 보호자 연락처: 연락처가 있는 주 보호자 우선 → 없으면 학생 계정의 학부모(User)
const STORED_PARENT_SQL = `
     LEFT JOIN "User" u ON u.id = s."parentId"
     LEFT JOIN LATERAL (
       SELECT x.name, x.phone FROM "Guardian" x
       WHERE x."studentId" = s.id AND x.phone IS NOT NULL AND btrim(x.phone) <> ''
       ORDER BY x."isPrimary" DESC, x."createdAt" ASC
       LIMIT 1
     ) gd ON TRUE`;

type GrantViewRow = {
  status: string;
  expiresAt: Date | string | null;
  tenureMonths: number;
  student_name: string;
  guardian_name: string | null;
  guardian_phone: string | null;
  parent_name: string | null;
  parent_phone: string | null;
};

/** 공개 페이지용: 링크 상태 + 미리 채울 학생·보호자 정보 */
export async function getFreeGrantView(db: RawSqlClient, token: string, nowMs: number): Promise<FreeGrantView> {
  if (!isWellFormedGrantToken(token)) {
    return { state: "NOT_FOUND", message: grantUnusableMessage("NOT_FOUND") };
  }
  const rows = await db.$queryRawUnsafe<GrantViewRow[]>(
    `SELECT g.status, g."expiresAt", g."tenureMonths", s.name AS student_name,
            gd.name AS guardian_name, gd.phone AS guardian_phone,
            u.name AS parent_name, u.phone AS parent_phone
     FROM "UniformFreeGrant" g
     JOIN "Student" s ON s.id = g."studentId"${STORED_PARENT_SQL}
     WHERE g.token = $1
     LIMIT 1`,
    token,
  );
  const row = rows[0];
  const evaluation = evaluateFreeGrant(row ?? null, nowMs);
  if (!evaluation.usable) return { state: evaluation.reason, message: grantUnusableMessage(evaluation.reason) };
  return {
    state: "USABLE",
    studentName: row.student_name,
    tenureMonths: Number(row.tenureMonths),
    parentName: row.guardian_name || row.parent_name || "",
    parentPhoneMask: maskParentPhone(row.guardian_phone || row.parent_phone),
  };
}

// ─── 신청 처리 ──────────────────────────────────────────────────────────────

export type FreeUniformOrderInput = {
  parentName: string;
  parentPhone: string;
  design: string;
  initials: string;
  backNumber: string;
  topSize: string;
  bottomSize: string;
  memo?: string;
  agreedPrivacy: boolean;
};

export type FreeUniformSubmitResult =
  | { ok: true; orderId: string; studentName: string }
  | { ok: false; reason: GrantUnusableReason | "INVALID"; message: string };

type LockedGrantRow = {
  id: string;
  status: string;
  expiresAt: Date | string | null;
  student_name: string;
};

/**
 * 무료 유니폼 신청 — 반드시 트랜잭션 안의 tx 로 부른다.
 * 1) 링크 행을 FOR UPDATE 로 잠근다 → 동시에 두 번 눌러도 두 번째는 첫 번째가 끝날 때까지 기다렸다가
 *    USED 를 보고 거절된다(한 건만 접수).
 * 2) 주문 저장 시 본사 상태를 NEEDS_REVIEW 로 둬서 자동 발송(크론)·즉시 발송 모두 일어나지 않는다.
 */
export async function submitFreeUniformOrderInTx(
  tx: RawSqlClient,
  token: string,
  input: FreeUniformOrderInput,
): Promise<FreeUniformSubmitResult> {
  if (!isWellFormedGrantToken(token)) {
    return { ok: false, reason: "NOT_FOUND", message: grantUnusableMessage("NOT_FOUND") };
  }

  // 입력 검증은 잠그기 전에(잘못된 입력으로 잠금을 오래 쥐지 않게)
  // 휴대폰 칸을 비워 두면(가린 번호 그대로) 잠근 뒤 저장된 번호로 채운다 — 이름만 먼저 검사
  const typedPhone = String(input.parentPhone ?? "");
  const useStoredPhone = typedPhone.replace(/\D/g, "") === "";
  const invalid =
    validateUniformParentFields(String(input.parentName ?? ""), useStoredPhone ? "01000000000" : typedPhone) ||
    validateUniformItemFields({
      design: String(input.design ?? ""),
      initials: String(input.initials ?? ""),
      backNumber: String(input.backNumber ?? ""),
      topSize: String(input.topSize ?? ""),
      bottomSize: String(input.bottomSize ?? ""),
    }) ||
    (input.agreedPrivacy === true ? "" : "개인정보 수집 및 이용에 동의해주세요.");
  if (invalid) return { ok: false, reason: "INVALID", message: invalid };

  const locked = await tx.$queryRawUnsafe<LockedGrantRow[]>(
    `SELECT g.id, g.status, g."expiresAt", s.name AS student_name
     FROM "UniformFreeGrant" g
     JOIN "Student" s ON s.id = g."studentId"
     WHERE g.token = $1
     FOR UPDATE OF g`,
    token,
  );
  const grant = locked[0];
  // 잠금을 얻은 «뒤» 의 시각으로 판정한다(기다리는 동안 만료됐을 수 있다)
  const evaluation = evaluateFreeGrant(grant ?? null, Date.now());
  if (!evaluation.usable) {
    return { ok: false, reason: evaluation.reason, message: grantUnusableMessage(evaluation.reason) };
  }

  let parentPhone = typedPhone;
  if (useStoredPhone) {
    const stored = await tx.$queryRawUnsafe<{ guardian_phone: string | null; parent_phone: string | null }[]>(
      `SELECT gd.phone AS guardian_phone, u.phone AS parent_phone
       FROM "UniformFreeGrant" g
       JOIN "Student" s ON s.id = g."studentId"${STORED_PARENT_SQL}
       WHERE g.id = $1`,
      grant.id,
    );
    parentPhone = stored[0]?.guardian_phone || stored[0]?.parent_phone || "";
    if (!maskParentPhone(parentPhone)) {
      return { ok: false, reason: "INVALID", message: "학부모 휴대폰 번호를 입력해주세요." };
    }
  }

  // 학생 이름은 링크의 학생으로 고정(학부모 입력을 받지 않는다). 정규화·서명은 기존 주문 규칙 재사용
  const normalized = normalizeUniformOrderInput({
    parentName: input.parentName,
    parentPhone,
    memo: buildFreeUniformMemo(input.memo),
    agreedPrivacy: true,
    students: [{
      studentName: grant.student_name,
      design: input.design,
      initials: input.initials,
      backNumber: input.backNumber,
      topSize: input.topSize,
      bottomSize: input.bottomSize,
    }],
  });
  const item = normalized.students[0];

  const orderId = randomUUID();
  await tx.$executeRawUnsafe(
    `INSERT INTO "UniformOrder"
       (id, "partnerRequestId", "parentName", "parentPhone", "parentPhoneDigits", "customerMemo",
        "itemSignature", "stizSyncStatus", "stizMessage", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    orderId,
    `dasan-uniform-${orderId}`, // 기존 규칙(uniform-order-service.buildPartnerRequestId)과 같은 꼴
    normalized.parentName,
    normalized.parentPhone,
    normalized.parentPhoneDigits,
    normalized.memo,
    normalized.itemSignature,
    FREE_UNIFORM_SYNC_STATUS,
    FREE_UNIFORM_STIZ_MESSAGE,
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "UniformOrderItem"
       (id, "uniformOrderId", "studentName", design, initials, "backNumber", "topSize", "bottomSize", quantity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    randomUUID(),
    orderId,
    item.studentName,
    item.design,
    item.initials,
    item.backNumber,
    item.topSize,
    item.bottomSize,
    item.quantity, // 일반 주문과 같은 규칙(상의 1 + 하의 1) — 본사가 세트를 같은 방식으로 받는다
  );

  // ISSUED 일 때만 USED 로 — 잠금 덕에 항상 1건이지만, 0건이면 롤백해 주문이 남지 않게 한다
  const updated = await tx.$executeRawUnsafe(
    `UPDATE "UniformFreeGrant"
     SET status = 'USED', "usedAt" = now(), "uniformOrderId" = $2
     WHERE id = $1 AND status = 'ISSUED'`,
    grant.id,
    orderId,
  );
  if (updated !== 1) throw new Error("무료 증정 링크 상태가 바뀌어 신청을 완료하지 못했습니다.");

  return { ok: true, orderId, studentName: grant.student_name };
}

