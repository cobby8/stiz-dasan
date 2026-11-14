// 학부모 «아이 정보 수정» DB 연결부 (2026-11-14 원장 결정 b4·b5) — 규칙은 childEditRules(순수).
// 실행 테스트: tests/child-edit.test.mjs
//
// ★ 보안(IDOR): 화면이 보낸 학생 id 를 믿지 않는다. 모든 UPDATE·INSERT 가 «이 학생이 로그인 보호자의 아이인가»
//   (childAccessSql — 대표 보호자 또는 연결된 가족)를 «같은 SQL 문» 안에서 다시 확인한다. 남의 아이 id 면 0행.
// ★ 바로 반영하는 칸은 childEditRules.DIRECT_FIELDS 뿐. 이름·생년월일은 여기서 Student 를 직접 고치지 않고
//   StudentProfileChangeRequest 에 신청만 남긴다(반영은 원장·부원장 승인 = decideProfileChange).
// ★ 새 칸(healthNote)·새 표가 아직 없는 환경에서도 죽지 않는다 — 그 부분만 «준비 중»으로 돌려준다.
// ★ 건강 특이사항 내용은 로그에 남기지 않는다.
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  checkChangeRequest,
  cleanBirthYmd,
  cleanChildDirect,
  cleanChildName,
  isRequestField,
  type ChangeRequestStatus,
  type RequestField,
} from "@/lib/parent/childEditRules";

type Db = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** 시간대 없는 칸(Student.birthDate) → KST 달력 날짜 — «두 번» 바꾼다(한 번만 걸면 9시간 밀린다) */
const BIRTH_YMD_SQL = `to_char((s."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;

export type ChildChangeRequest = {
  id: string;
  field: RequestField;
  oldValue: string | null;
  newValue: string;
  status: ChangeRequestStatus;
  note: string | null;
  /** 신청일·처리일(KST 달력 날짜) */
  createdYmd: string;
  decidedYmd: string | null;
  /** 관리자 화면에만 채운다(학부모 화면에는 신청자 이름을 내리지 않는다) */
  requesterName?: string | null;
};

export type ChildEditInfo = {
  /** 건강 특이사항 칸이 있는 환경인가(없으면 입력칸을 숨긴다) */
  healthAvailable: boolean;
  healthNote: string | null;
  phone: string | null;
  address: string | null;
  /** 변경 신청 표가 있는 환경인가(없으면 «변경 신청» 버튼을 숨긴다) */
  requestsAvailable: boolean;
  /** 확인 중 + 최근 14일 안에 처리된 신청 */
  requests: ChildChangeRequest[];
};

function mapRequest(row: Record<string, unknown>): ChildChangeRequest {
  return {
    id: String(row.id),
    field: (isRequestField(row.field) ? row.field : "name") as RequestField,
    oldValue: row.oldValue == null ? null : String(row.oldValue),
    newValue: String(row.newValue ?? ""),
    status: String(row.status) as ChangeRequestStatus,
    note: row.note == null ? null : String(row.note),
    createdYmd: String(row.createdYmd ?? ""),
    decidedYmd: row.decidedYmd == null ? null : String(row.decidedYmd),
    ...(row.requesterName !== undefined ? { requesterName: row.requesterName == null ? null : String(row.requesterName) } : {}),
  };
}

const REQUEST_COLUMNS = `r.id, r.field, r."oldValue", r."newValue", r.status, r.note,
  to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "createdYmd",
  to_char(r."decidedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "decidedYmd"`;

/**
 * 학부모 화면용 — 수정 시트에 채울 값(학생 전화·주소·건강 특이사항)과 변경 신청 목록.
 * 내 아이가 아니면 null. 새 칸·새 표가 없으면 그 부분만 available=false.
 */
export async function loadChildEditInfo(db: Pick<Db, "$queryRawUnsafe">, userId: string, studentId: string): Promise<ChildEditInfo | null> {
  if (!userId || !studentId) return null;
  const access = await childAccessSql("s", "$1");
  const base = await db.$queryRawUnsafe<Array<{ phone: string | null; address: string | null }>>(
    `SELECT s.phone, s.address FROM "Student" s WHERE s.id = $2 AND ${access} AND ${notMergedStudent("s")} LIMIT 1`,
    userId,
    studentId,
  );
  if (!base[0]) return null;

  let healthAvailable = true;
  let healthNote: string | null = null;
  try {
    const rows = await db.$queryRawUnsafe<Array<{ healthNote: string | null }>>(
      `SELECT s."healthNote" FROM "Student" s WHERE s.id = $2 AND ${access} AND ${notMergedStudent("s")} LIMIT 1`,
      userId,
      studentId,
    );
    healthNote = rows[0]?.healthNote ?? null;
  } catch {
    healthAvailable = false;
  }

  let requestsAvailable = true;
  let requests: ChildChangeRequest[] = [];
  try {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${REQUEST_COLUMNS}
         FROM "StudentProfileChangeRequest" r
         JOIN "Student" s ON s.id = r."studentId"
        WHERE r."studentId" = $2 AND ${access} AND ${notMergedStudent("s")}
          AND (r.status = 'PENDING' OR (r.status IN ('APPROVED', 'REJECTED') AND r."decidedAt" > NOW() - INTERVAL '14 days'))
        ORDER BY r."createdAt" DESC
        LIMIT 10`,
      userId,
      studentId,
    );
    requests = rows.map(mapRequest);
  } catch {
    requestsAvailable = false;
  }
  return { healthAvailable, healthNote, phone: base[0].phone ?? null, address: base[0].address ?? null, requestsAvailable, requests };
}

export type SaveDirectResult =
  | { ok: true; healthSaved: boolean }
  | { ok: false; error: string };

/**
 * «바로 반영» — 학교·학생 전화·주소(+건강 특이사항). 권한 조건이 UPDATE 문 안에 있다.
 * 건강 특이사항은 칸이 없는 환경에서 나머지 저장까지 막지 않게 따로 저장한다(healthSaved=false).
 */
export async function saveChildDirect(db: Db, userId: string, studentId: string, input: unknown): Promise<SaveDirectResult> {
  if (!userId || !studentId) return { ok: false, error: "아이 정보를 찾지 못했어요." };
  const clean = cleanChildDirect(input);
  if (!clean.ok) return clean;
  const access = await childAccessSql("s", "$1");
  const where = `s.id = $2 AND ${access} AND ${notMergedStudent("s")}`;
  const updated = await db.$executeRawUnsafe(
    `UPDATE "Student" AS s SET school = $3, phone = $4, address = $5, "updatedAt" = NOW() WHERE ${where}`,
    userId,
    studentId,
    clean.value.school,
    clean.value.phone,
    clean.value.address,
  );
  if (updated !== 1) return { ok: false, error: "아이 정보를 찾지 못했어요." };
  let healthSaved = true;
  try {
    const count = await db.$executeRawUnsafe(
      `UPDATE "Student" AS s SET "healthNote" = $3, "updatedAt" = NOW() WHERE ${where}`,
      userId,
      studentId,
      clean.value.healthNote,
    );
    healthSaved = count === 1;
  } catch {
    healthSaved = false; // 칸이 아직 없는 환경 — 내용은 로그에 남기지 않는다
  }
  return { ok: true, healthSaved };
}

export type CreateRequestResult =
  | { ok: true; requestId: string; studentName: string; field: RequestField }
  | { ok: false; error: string };

/** 이름·생년월일 «변경 신청» — Student 는 건드리지 않는다. 같은 항목에 확인 중 신청이 있으면 거절 */
export async function createChangeRequest(
  db: Db,
  userId: string,
  studentId: string,
  field: unknown,
  newValue: unknown,
  todayYmd: string,
): Promise<CreateRequestResult> {
  if (!userId || !studentId) return { ok: false, error: "아이 정보를 찾지 못했어요." };
  const access = await childAccessSql("s", "$1");
  const rows = await db.$queryRawUnsafe<Array<{ name: string; birthYmd: string | null }>>(
    `SELECT s.name, ${BIRTH_YMD_SQL} AS "birthYmd" FROM "Student" s
      WHERE s.id = $2 AND ${access} AND ${notMergedStudent("s")} LIMIT 1`,
    userId,
    studentId,
  );
  const current = rows[0];
  if (!current) return { ok: false, error: "아이 정보를 찾지 못했어요." };
  const checked = checkChangeRequest(field, newValue, { name: String(current.name ?? ""), birthYmd: current.birthYmd ?? null }, todayYmd);
  if (!checked.ok) return checked;
  try {
    // 권한 조건을 INSERT 문 안에서도 다시 건다(조회와 저장 사이에 연결이 끊긴 경우) · «확인 중은 항목당 하나»는 부분 유니크 인덱스가 지킨다
    const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "StudentProfileChangeRequest" (id, "studentId", "requestedByUserId", field, "oldValue", "newValue", status)
       SELECT gen_random_uuid()::text, s.id, $1, $3, $4, $5, 'PENDING'
         FROM "Student" s
        WHERE s.id = $2 AND ${access} AND ${notMergedStudent("s")}
          AND NOT EXISTS (SELECT 1 FROM "StudentProfileChangeRequest" p
                           WHERE p."studentId" = s.id AND p.field = $3 AND p.status = 'PENDING')
       RETURNING id`,
      userId,
      studentId,
      checked.field,
      checked.oldValue,
      checked.newValue,
    );
    if (!inserted[0]) return { ok: false, error: "이미 확인 중인 신청이 있어요. 취소한 뒤 다시 신청해 주세요." };
    return { ok: true, requestId: String(inserted[0].id), studentName: String(current.name ?? ""), field: checked.field };
  } catch (error) {
    // 동시에 두 번 눌러 유니크 인덱스에 걸린 경우
    if (/unique|duplicate|23505/i.test(String((error as { message?: unknown; code?: unknown })?.message ?? "") + String((error as { code?: unknown })?.code ?? ""))) {
      return { ok: false, error: "이미 확인 중인 신청이 있어요. 취소한 뒤 다시 신청해 주세요." };
    }
    return { ok: false, error: "지금은 신청할 수 없어요. 잠시 후 다시 시도해 주세요." };
  }
}

/** 학부모가 «확인 중» 신청을 취소 — 그 아이에 접근할 수 있는 보호자면 누구나 */
export async function cancelChangeRequest(db: Db, userId: string, requestId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!userId || !requestId) return { ok: false, error: "취소할 신청이 없어요." };
  try {
    const count = await db.$executeRawUnsafe(
      `UPDATE "StudentProfileChangeRequest" AS r
          SET status = 'CANCELED', "decidedAt" = NOW(), "decidedByUserId" = $1
        WHERE r.id = $2 AND r.status = 'PENDING'
          AND EXISTS (SELECT 1 FROM "Student" s
                       WHERE s.id = r."studentId" AND ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")})`,
      userId,
      requestId,
    );
    return count === 1 ? { ok: true } : { ok: false, error: "취소할 신청이 없어요. 이미 처리됐을 수 있어요." };
  } catch {
    return { ok: false, error: "취소하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
}

// ── 관리자(원장·부원장) — 권한은 부르는 쪽(requireAdmin)이 확인한다 ─────────────────────────

/** 학생 상세 «정보 변경 요청» 칸 — 이 학생의 신청(최신 20건)과 신청자 이름. 표가 없으면 available=false */
export async function listProfileChangesForAdmin(db: Pick<Db, "$queryRawUnsafe">, studentId: string): Promise<{ available: boolean; requests: ChildChangeRequest[] }> {
  try {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${REQUEST_COLUMNS}, u.name AS "requesterName"
         FROM "StudentProfileChangeRequest" r
         LEFT JOIN "User" u ON u.id = r."requestedByUserId"
        WHERE r."studentId" = $1
        ORDER BY (r.status = 'PENDING') DESC, r."createdAt" DESC
        LIMIT 20`,
      studentId,
    );
    return { available: true, requests: rows.map(mapRequest) };
  } catch {
    return { available: false, requests: [] };
  }
}

export type DecideResult =
  | { ok: true; studentId: string; studentName: string; requestedByUserId: string; field: RequestField; approved: boolean }
  | { ok: false; error: string };

/**
 * 승인·반려 — 반드시 트랜잭션 안에서 부른다(tx). 신청 행을 잠근 뒤 처리한다(두 사람이 동시에 눌러도 한 번만).
 * 승인하면 신청할 때와 같은 검증을 다시 하고(childEditRules) Student 의 그 칸 하나만 바꾼다.
 */
export async function decideProfileChange(
  tx: Db,
  adminUserId: string,
  studentId: string,
  requestId: string,
  decision: unknown,
  noteRaw: unknown,
  todayYmd: string,
): Promise<DecideResult> {
  if (decision !== "APPROVE" && decision !== "REJECT") return { ok: false, error: "처리 방법을 확인해 주세요." };
  const note = String(noteRaw ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
  // 학생 id 까지 같이 맞춘다 — 다른 학생 화면에서 남의 신청 id 를 넣어도 0행
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; requestedByUserId: string; field: string; newValue: string; status: string }>>(
    `SELECT id, "studentId", "requestedByUserId", field, "newValue", status
       FROM "StudentProfileChangeRequest" WHERE id = $1 AND "studentId" = $2 FOR UPDATE`,
    requestId,
    studentId,
  );
  const request = rows[0];
  if (!request || request.status !== "PENDING") return { ok: false, error: "이미 처리됐거나 취소된 신청이에요. 새로고침해 주세요." };
  if (!isRequestField(request.field)) return { ok: false, error: "처리할 수 없는 신청이에요." };
  const students = await tx.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT s.name FROM "Student" s WHERE s.id = $1 AND ${notMergedStudent("s")} LIMIT 1 FOR UPDATE`,
    studentId,
  );
  if (!students[0]) return { ok: false, error: "학생을 찾을 수 없습니다." };

  const approved = decision === "APPROVE";
  if (approved) {
    if (request.field === "name") {
      const name = cleanChildName(request.newValue);
      if (!name.ok) return name;
      await tx.$executeRawUnsafe(`UPDATE "Student" SET name = $1, "updatedAt" = NOW() WHERE id = $2`, name.value, studentId);
    } else {
      const birth = cleanBirthYmd(request.newValue, todayYmd);
      if (!birth.ok) return birth;
      // 관리자 «수정»(updateStudent)과 같은 저장 형식 — 날짜 글자를 그대로 timestamp 로
      await tx.$executeRawUnsafe(`UPDATE "Student" SET "birthDate" = $1::timestamp, "updatedAt" = NOW() WHERE id = $2`, birth.value, studentId);
    }
  }
  await tx.$executeRawUnsafe(
    `UPDATE "StudentProfileChangeRequest"
        SET status = $1, "decidedAt" = NOW(), "decidedByUserId" = $2, note = $3
      WHERE id = $4 AND status = 'PENDING'`,
    approved ? "APPROVED" : "REJECTED",
    adminUserId,
    note,
    requestId,
  );
  return { ok: true, studentId, studentName: String(students[0].name ?? ""), requestedByUserId: request.requestedByUserId, field: request.field, approved };
}
