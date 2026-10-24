import { userFacingError } from "@/lib/user-facing-error";
/**
 * 수강생 이관 API — 스프레드시트 CSV를 파싱하여 DB에 삽입
 *
 * POST /api/admin/import-students
 * - mode=preview: CSV 파싱 + 미리보기 (DB 변경 없음)
 * - mode=execute: CSV 파싱 + DB 삽입 (실제 이관)
 *
 * 요청 형식: { mode: "preview" | "execute", csvText: string }
 * 응답 형식:
 *   preview → { preview: ImportPreviewResult }
 *   execute → { result: { created, skipped, failed, details } }
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { fetchStudentOperationSheets } from "@/lib/googleSheetsCsv";
import {
  parseAndTransformCsv,
  parseRegistrationSheetCsv,
  parseStudentAuxiliarySheetsCsv,
  type StudentChangeSheetRow,
  type StudentRegistrationSheetRow,
  type StudentShuttleSheetRow,
  type StudentTeamRosterSheetRow,
  type TransformedStudent,
} from "@/lib/importStudents";
import { findStudentIdentityMatch } from "@/lib/studentSheetMatching";
import { notMergedStudent } from "@/lib/studentVisibility";
import { monthlyBillingDueDate } from "@/lib/billing-due-date";

export async function POST(request: NextRequest) {
  // 관리자 인증 확인
  let adminUser: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    adminUser = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { mode, csvText, csvSheets, source, sheetUrl } = body as {
      mode: "preview" | "execute" | "refreshLedger";
      csvText?: string;
      csvSheets?: Record<string, string>;
      source?: "csv" | "googleSheet";
      sheetUrl?: string;
    };

    let sheetMap =
      csvSheets && typeof csvSheets === "object" && !Array.isArray(csvSheets)
        ? csvSheets
        : {};
    let sourceUrl: string | null = null;
    let spreadsheetId: string | null = null;
    let fetchedSheets: string[] = [];
    let skippedSheets: { sheetName: string; reason: string }[] = [];

    if (source === "googleSheet") {
      const targetSheetUrl = sheetUrl?.trim() || await getDefaultStudentSheetUrl();
      if (!targetSheetUrl) {
        return NextResponse.json(
          { error: "구글시트 URL이 없습니다. URL을 입력하거나 설정에 저장해주세요." },
          { status: 400 }
        );
      }

      const fetched = await fetchStudentOperationSheets(targetSheetUrl);
      sheetMap = { ...fetched.csvSheets, ...sheetMap };
      sourceUrl = fetched.sourceUrl;
      spreadsheetId = fetched.spreadsheetId;
      fetchedSheets = fetched.fetchedSheets;
      skippedSheets = fetched.skippedSheets;
    }

    const registrationCsvText =
      typeof csvText === "string" && csvText.trim()
        ? csvText
        : getRegistrationCsvText(sheetMap);

    if (!registrationCsvText && Object.keys(sheetMap).length === 0) {
      return NextResponse.json(
        { error: "CSV 데이터가 없습니다." },
        { status: 400 }
      );
    }

    // CSV 파싱 및 변환
    const preview = registrationCsvText
      ? parseAndTransformCsv(registrationCsvText)
      : emptyImportPreview();
    const registrationSheet = registrationCsvText
      ? parseRegistrationSheetCsv(registrationCsvText)
      : emptyRegistrationSheet();
    const auxiliarySheets = parseStudentAuxiliarySheetsCsv(sheetMap);

    // 미리보기 모드: 파싱 결과만 반환
    if (mode === "preview") {
      return NextResponse.json({
        preview,
        registrationSheet: {
          summary: registrationSheet.summary,
          headers: registrationSheet.headers,
          errors: registrationSheet.errors,
        },
        auxiliarySheets: {
          summary: auxiliarySheets.summary,
          errors: auxiliarySheets.errors,
        },
        source: {
          type: source === "googleSheet" ? "googleSheet" : "csv",
          spreadsheetId,
          sourceUrl,
          fetchedSheets,
          skippedSheets,
        },
      });
    }

    // 장부 최신화 모드: 기존 원생/결제 생성 단계는 건너뛰고 시트 원본과 월별 장부만 저장
    if (mode === "refreshLedger") {
      await ensureStudentSheetImportTablesAvailable();
      const sheetImport = await storeStudentSheetImport(
        {
          registrationRows: registrationSheet.rows,
          shuttleRows: auxiliarySheets.shuttleRows,
          changeRows: auxiliarySheets.changeRows,
          teamRows: auxiliarySheets.teamRows,
        },
        {
          importedBy: adminUser.appUserId,
          sourceUrl,
          spreadsheetId,
          spreadsheetTitle: source === "googleSheet" ? "수강생 운영 구글시트" : "수강생 등록 CSV",
          summary: {
            registration: registrationSheet.summary,
            auxiliary: auxiliarySheets.summary,
            source: { fetchedSheets, skippedSheets },
          },
          parseErrorCount: registrationSheet.errors.length + auxiliarySheets.errors.length,
        },
        { recordAuxiliaryUnmatchedIssues: false, updateStudents: false }
      );

      revalidateStudentImportCaches();

      return NextResponse.json({
        result: {
          created: { users: 0, students: 0, enrollments: 0, payments: 0 },
          skipped: { users: 0, students: 0, enrollments: 0, payments: 0 },
          failed: [],
        },
        sheetImport,
        ledgerOnly: true,
      });
    }

    // 실행 모드: DB에 삽입
    if (mode !== "execute") {
      return NextResponse.json(
        { error: "mode는 'preview', 'execute', 'refreshLedger' 중 하나여야 합니다." },
        { status: 400 }
      );
    }

    await ensureStudentSheetImportTablesAvailable();
    const result = await executeImport(preview.students);
    const sheetImport = await storeStudentSheetImport(
      {
        registrationRows: registrationSheet.rows,
        shuttleRows: auxiliarySheets.shuttleRows,
        changeRows: auxiliarySheets.changeRows,
        teamRows: auxiliarySheets.teamRows,
      },
      {
        importedBy: adminUser.appUserId,
        sourceUrl,
        spreadsheetId,
        spreadsheetTitle: source === "googleSheet" ? "수강생 운영 구글시트" : "수강생 등록 CSV",
        summary: {
          registration: registrationSheet.summary,
          auxiliary: auxiliarySheets.summary,
        },
        parseErrorCount: registrationSheet.errors.length + auxiliarySheets.errors.length,
      }
    );
    revalidateStudentImportCaches();

    return NextResponse.json({
      result: { ...result, sheetImport },
      preview: { summary: preview.summary },
      registrationSheet: { summary: registrationSheet.summary },
      auxiliarySheets: { summary: auxiliarySheets.summary },
      source: {
        type: source === "googleSheet" ? "googleSheet" : "csv",
        spreadsheetId,
        sourceUrl,
        fetchedSheets,
        skippedSheets,
      },
    });
  } catch (err) {
    console.error("[import-students] 오류:", err);
    return NextResponse.json(
      {
        error:
          userFacingError(err, "이관 처리 중 오류가 발생했습니다."),
      },
      { status: 500 }
    );
  }
}

function revalidateStudentImportCaches() {
  for (const tag of [
    "admin-students",
    "admin-student-imports",
    "admin-classes",
    "admin-schedule",
    "admin-dashboard",
  ]) {
    revalidateTag(tag, { expire: 0 });
  }

  revalidatePath("/admin/students");
  revalidatePath("/admin/classes");
  revalidatePath("/admin/schedule");
}

function getRegistrationCsvText(sheetMap: Record<string, string>) {
  return (
    sheetMap["등록"] ||
    Object.entries(sheetMap).find(([name]) => name.trim() === "등록" || name.includes("등록"))?.[1] ||
    sheetMap.registration ||
    ""
  );
}

// ──────────────────────────────────────────────
// DB 삽입 로직
// ──────────────────────────────────────────────

interface ImportResult {
  created: { users: number; students: number; enrollments: number; payments: number };
  skipped: { users: number; students: number; enrollments: number; payments: number };
  failed: { rowNumber: number; name: string; reason: string }[];
}

interface RegistrationSheetImportMeta {
  importedBy: string;
  sourceUrl: string | null;
  spreadsheetId: string | null;
  spreadsheetTitle: string | null;
  summary: unknown;
  parseErrorCount: number;
}

interface StudentSheetImportRows {
  registrationRows: StudentRegistrationSheetRow[];
  shuttleRows: StudentShuttleSheetRow[];
  changeRows: StudentChangeSheetRow[];
  teamRows: StudentTeamRosterSheetRow[];
}

const IMPORT_BULK_CHUNK_SIZE = 250;

type StudentSheetRawRowBulkInput = {
  id: string;
  batchId: string;
  sheetName: string;
  rowNumber: number;
  rowHash: string | null;
  studentKey: string | null;
  studentId: string | null;
  rawJSON: string;
  normalizedJSON: string | null;
};

type StudentRegistrationLedgerBulkInput = {
  id: string;
  batchId: string;
  rawRowId: string;
  studentId: string | null;
  rowNumber: number;
  studentKey: string | null;
  branch: string | null;
  applicationAt: Date | null;
  paymentDate: Date | null;
  registrationMonth: string | null;
  studentName: string;
  studentGender: string | null;
  grade: string | null;
  uniformStatus: string | null;
  paymentMethod: string | null;
  paymentAmount: number | null;
  tuitionAmount: number | null;
  shuttleFee: number | null;
  carryOverAmount: number | null;
  shuttleNeeded: boolean;
  shuttlePickup: string | null;
  shuttlePreferredTime: string | null;
  shuttleDropoff: string | null;
  selectedSlotKeysJSON: string;
  birthDate: Date | null;
  parentName: string | null;
  studentPhone: string | null;
  parentPhone: string | null;
  address: string | null;
  school: string | null;
  basketballExp: string | null;
  hopeNote: string | null;
  referralSource: string | null;
  agreedPrivacy: boolean;
  agreedTerms: boolean;
  agreementJSON: string;
  enrollmentPeriod: string | null;
  status: string;
  rawJSON: string;
};

type StudentShuttleRideBulkInput = {
  id: string;
  batchId: string;
  rawRowId: string;
  studentId: string | null;
  monthLabel: string;
  rowNumber: number;
  studentName: string | null;
  studentPhone: string | null;
  parentPhone: string | null;
  dayLabel: string | null;
  classTime: string | null;
  arrivalTime: string | null;
  destination: string | null;
  note: string | null;
  memo: string | null;
  rawJSON: string;
};

type StudentChangeLogBulkInput = {
  id: string;
  batchId: string;
  rawRowId: string;
  rowNumber: number;
  occurredAt: Date | null;
  changeSummary: string | null;
  registrationReflected: boolean;
  rallyzReflected: boolean;
  vehicleReflected: boolean;
  alarmStatus: string | null;
  note: string | null;
  rawJSON: string;
};

type StudentTeamRosterEntryBulkInput = {
  id: string;
  batchId: string;
  rawRowId: string;
  studentId: string | null;
  rowNumber: number;
  studentName: string;
  birthDate: Date | null;
  jerseyNumber: string | null;
  phone: string | null;
  grade: string | null;
  branch: string | null;
  eventColumnsJSON: string;
  rawJSON: string;
};

type StudentSheetImportIssueBulkInput = {
  id: string;
  batchId: string;
  sheetName: string;
  rowNumber: number;
  severity: "WARNING" | "ERROR";
  message: string;
  rawJSON: string;
};

function emptyImportPreview() {
  return {
    students: [],
    summary: {
      totalRows: 0,
      uniqueStudents: 0,
      activeCount: 0,
      pausedCount: 0,
      withdrawnCount: 0,
      branch1Count: 0,
      branch2Count: 0,
    },
    errors: [],
  };
}

function emptyRegistrationSheet() {
  return {
    headers: [],
    rows: [],
    summary: {
      totalRows: 0,
      uniqueStudentKeys: 0,
      missingStudentKeyRows: 0,
      activeCount: 0,
      pausedCount: 0,
      withdrawnCount: 0,
    },
    errors: [],
  };
}

/**
 * 변환된 학생 데이터를 DB에 삽입
 *
 * 순서: User(학부모) → Student → Enrollment → Payment
 * 각 단계에서 중복 체크 후 INSERT
 * 개별 학생 실패해도 나머지 계속 진행
 */
async function executeImport(
  students: TransformedStudent[]
): Promise<ImportResult> {
  const result: ImportResult = {
    created: { users: 0, students: 0, enrollments: 0, payments: 0 },
    skipped: { users: 0, students: 0, enrollments: 0, payments: 0 },
    failed: [],
  };

  for (const s of students) {
    try {
      // ──── 1. User(학부모) 생성 또는 조회 ────
      const userId = await findOrCreateParent(
        s.parentName,
        s.parentPhone,
        result
      );

      // ──── 2. Student 생성 또는 조회 ────
      const studentId = await findOrCreateStudent(userId, s, result);

      // ──── 3. Enrollment 생성 (slotKey → Class 매핑) ────
      for (const slotKey of s.slotKeys) {
        await createEnrollmentIfNeeded(studentId, slotKey, s.status, result);
      }

      // ──── 4. Payment 생성 (연/월 중복 체크) ────
      // `s.amount`는 이제 그 학생의 월 총액(수강료 합계 + 셔틀비 - 이월)이다.
      // 0원이면 청구서를 만들지 않는다 — 휴원·퇴원만 있거나, 우지율처럼
      // 전 행이 `추가수강`+수강료 공란인 경우(원장 확답: 0원이 맞다).
      if (s.amount && s.year && s.month && s.paymentMethod) {
        await createPaymentIfNeeded(studentId, s, result);
      }
    } catch (err) {
      // 개별 학생 실패 — 기록하고 계속 진행
      result.failed.push({
        rowNumber: s.rowNumber,
        name: s.name,
        reason: userFacingError(err, "학생 자료를 처리하지 못했습니다. 다시 시도해 주세요."),
      });
    }
  }

  return result;
}

/**
 * 학부모 User를 찾거나 새로 생성
 * - 학부모이름+전화번호로 기존 User 검색
 * - 없으면 새 User INSERT (role=PARENT, email=phone@import.local)
 */
async function findOrCreateParent(
  name: string,
  phone: string,
  result: ImportResult
): Promise<string> {
  // 전화번호로 기존 User 검색 (같은 학부모가 여러 자녀를 가질 수 있음)
  // 숫자만 남겨 비교한다 — 신청 승인이 만든 계정은 '010-1234-5678' 형식이라
  // 글자 그대로 비교하면 같은 학부모를 못 찾고 계정·학생이 갈라진다.
  // ⚠️ 번호 없는 학부모를 한데 묶는 '00000000000' 자리채움 동작은 그대로 유지된다
  //    (숫자만 남겨도 값이 같으므로). 이 경로는 빈 번호가 오지 않는다.
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "User"
      WHERE role = 'PARENT'
        AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
      ORDER BY ("authUserId" IS NOT NULL) DESC, "createdAt" ASC
      LIMIT 1`,
    phone.replace(/[^0-9]/g, "")
  );

  if (existing.length > 0) {
    result.skipped.users++;
    return existing[0].id;
  }

  // 새 User 생성 — 이메일은 전화번호 기반 임시 이메일 (Supabase Auth와 무관)
  const id = crypto.randomUUID();
  const email = `${phone}@import.local`;

  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'PARENT', NOW(), NOW())
     ON CONFLICT (email) DO NOTHING`,
    id,
    email,
    name,
    phone
  );

  result.created.users++;
  return id;
}

/**
 * 학생을 찾거나 새로 생성
 * - 이름+parentId로 기존 Student 검색
 * - 없으면 INSERT (모든 필드 포함)
 */
async function findOrCreateStudent(
  parentId: string,
  s: TransformedStudent,
  result: ImportResult
): Promise<string> {
  // 같은 학부모의 같은 이름 학생이 이미 있는지 확인
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Student" s
     WHERE ${notMergedStudent("s")} AND s.name = $1 AND s."parentId" = $2 LIMIT 1`,
    s.name,
    parentId
  );

  if (existing.length > 0) {
    result.skipped.students++;
    return existing[0].id;
  }

  // 새 Student 생성
  const id = crypto.randomUUID();
  // birthDate가 null이면 기본값으로 2000-01-01 사용 (NOT NULL 제약 때문)
  const birthDate = s.birthDate || new Date(2000, 0, 1);

  await prisma.$executeRawUnsafe(
    `INSERT INTO "Student" (
      id, name, "birthDate", "parentId", phone, school, grade, address,
      "enrollDate", "referralSource", "uniformStatus", gender, "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
    id,
    s.name,
    birthDate,
    parentId,
    s.phone || null,
    s.school || null,
    s.grade || null,
    s.address || null,
    s.enrollDate || null,
    s.referralSource || null,
    s.uniformStatus || null,
    s.gender || null
  );

  result.created.students++;
  return id;
}

/**
 * 수강(Enrollment) 생성 — slotKey로 Class를 찾아 연결
 * - slotKey로 Class.id 조회
 * - studentId+classId 중복이면 건너뛰기
 */
async function createEnrollmentIfNeeded(
  studentId: string,
  slotKey: string,
  status: string,
  result: ImportResult
): Promise<void> {
  // slotKey로 Class 조회
  const classes = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Class" WHERE "slotKey" = $1 LIMIT 1`,
    slotKey
  );

  if (classes.length === 0) {
    // 해당 slotKey에 매칭되는 Class가 없음 — 건너뛰기
    return;
  }

  const classId = classes[0].id;

  // 중복 체크
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Enrollment" WHERE "studentId" = $1 AND "classId" = $2 LIMIT 1`,
    studentId,
    classId
  );

  if (existing.length > 0) {
    result.skipped.enrollments++;
    return;
  }

  // INSERT
  const id = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    id,
    studentId,
    classId,
    status
  );

  result.created.enrollments++;
}

/**
 * slotKey로 Class.id를 찾는다. 없으면 null.
 * Payment.classId는 FK가 아니라 "어느 반 청구였는지" 남기는 역사 스냅샷이다.
 */
async function findClassIdBySlotKey(slotKey: string | null): Promise<string | null> {
  if (!slotKey) return null;
  const classes = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Class" WHERE "slotKey" = $1 LIMIT 1`,
    slotKey
  );
  return classes[0]?.id ?? null;
}

/**
 * 결제(Payment) 생성 — 연/월 중복 체크
 * - studentId+year+month로 기존 Payment 검색
 * - 없으면 INSERT
 *
 * ⚠️ classId 정책 (2026-07-26 추가)
 * Payment는 학생당 월 1건이고 PaymentInvoice와 1:1이라 반별로 쪼갤 수 없다.
 * 그래서 여러 반을 듣는 학생은 **대표 반 1개**(수강료가 가장 큰 행의 반)만 기록한다.
 * 금액은 언제나 그 학생의 월 총액이며 반별로 나누지 않는다.
 * classId가 NULL이면 교사 앱에서 청구·현금수납 확인이 아예 동작하지 않는다.
 */
async function createPaymentIfNeeded(
  studentId: string,
  s: TransformedStudent,
  result: ImportResult
): Promise<void> {
  // 중복 체크 (같은 학생의 같은 연/월 결제)
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Payment" WHERE "studentId" = $1 AND year = $2 AND month = $3 LIMIT 1`,
    studentId,
    s.year,
    s.month
  );

  if (existing.length > 0) {
    result.skipped.payments++;
    return;
  }

  // 결제 상태 결정: 결제수단이 UNPAID면 PENDING, 나머지는 PAID
  const paymentStatus = s.paymentMethod === "UNPAID" ? "PENDING" : "PAID";

  // 납부기한: 약관 기준 "수강일 전까지" → 수강 개시일(그 달 1일) 전날 = 전월 말일
  // 문자열로 넘기고 SQL에서 ::timestamp로 캐스팅한다.
  // (예전처럼 JS Date를 그대로 넣으면 KST 자정이 UTC 전날 15시로 저장되어 기한이 하루 앞당겨졌다)
  const dueDate = monthlyBillingDueDate(s.year!, s.month!);

  // 대표 반. 시간표에 없는 slotKey면 null로 두고 기존처럼 진행한다(청구는 살린다).
  const classId = await findClassIdBySlotKey(s.billingSlotKey);
  if (!classId && s.billingSlotKey) {
    console.warn(
      `[import-students] ${s.name}: slotKey ${s.billingSlotKey}에 맞는 반이 없어 classId를 비웠습니다.`
    );
  }

  const id = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Payment" (
      id, "studentId", "classId", amount, status, method, "dueDate", year, month,
      type, description, "autoGenerated", "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, $8, $9, 'MONTHLY', $10, false, NOW(), NOW())`,
    id,
    studentId,
    classId,
    s.amount || 0,
    paymentStatus,
    s.paymentMethod,
    dueDate,
    s.year,
    s.month,
    `${s.year}년 ${s.month}월 수강료 (이관)`
  );

  result.created.payments++;
}

async function ensureStudentSheetImportTablesAvailable() {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('"StudentSheetImportBatch"') IS NOT NULL
        AND to_regclass('"StudentSheetRawRow"') IS NOT NULL
        AND to_regclass('"StudentRegistrationLedger"') IS NOT NULL
        AND to_regclass('"StudentShuttleRide"') IS NOT NULL
        AND to_regclass('"StudentChangeLog"') IS NOT NULL
        AND to_regclass('"StudentTeamRosterEntry"') IS NOT NULL
        AND to_regclass('"StudentSheetImportIssue"') IS NOT NULL
      AS exists`
  );

  if (!rows[0]?.exists) {
    throw new Error("수강생 시트 이관 DB 테이블이 아직 적용되지 않았습니다. prisma/sql/add_student_sheet_import.sql을 먼저 적용해주세요.");
  }
}

async function getDefaultStudentSheetUrl() {
  const rows = await prisma.$queryRawUnsafe<{ googleSheetsScheduleUrl?: string | null; googlesheetsscheduleurl?: string | null }[]>(
    `SELECT "googleSheetsScheduleUrl" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`
  );
  return rows[0]?.googleSheetsScheduleUrl ?? rows[0]?.googlesheetsscheduleurl ?? null;
}

async function storeStudentSheetImport(
  rows: StudentSheetImportRows,
  meta: RegistrationSheetImportMeta,
  options: { recordAuxiliaryUnmatchedIssues?: boolean; updateStudents?: boolean } = {}
) {
  const totalRows =
    rows.registrationRows.length +
    rows.shuttleRows.length +
    rows.changeRows.length +
    rows.teamRows.length;

  const batchRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "StudentSheetImportBatch" (
       id, source, "spreadsheetId", "spreadsheetTitle", "sourceUrl", "importedBy",
       status, "totalRows", "registrationRows", "vehicleRows", "changeRows", "teamRows",
       "errorRows", "rawSummaryJSON",
       message, "createdAt"
     )
     VALUES (
       gen_random_uuid()::text, 'GOOGLE_SHEETS_CSV', $1, $2, $3, $4,
       'RUNNING', $5, $6, $7, $8, $9, $10, $11, '수강생 시트 CSV 이관 진행', NOW()
     )
     RETURNING id`,
    meta.spreadsheetId,
    meta.spreadsheetTitle,
    meta.sourceUrl,
    meta.importedBy,
    totalRows,
    rows.registrationRows.length,
    rows.shuttleRows.length,
    rows.changeRows.length,
    rows.teamRows.length,
    meta.parseErrorCount,
    JSON.stringify(meta.summary)
  );

  const batchId = batchRows[0]?.id;
  if (!batchId) {
    throw new Error("수강생 시트 이관 배치를 생성하지 못했습니다.");
  }

  try {
  let rawRows = 0;
  let ledgerRows = 0;
  let shuttleRows = 0;
  let changeRows = 0;
  let teamRows = 0;
  let issues = meta.parseErrorCount;

  const rawRowInputs: StudentSheetRawRowBulkInput[] = [];
  const issueInputs: StudentSheetImportIssueBulkInput[] = [];
  const registrationMatchCache = new Map<string, string | null>();
  const auxiliaryMatchCache = new Map<string, string | null>();
  const latestRegistrationUpdates = new Map<string, { rawRowId: string; row: StudentRegistrationSheetRow }>();
  const shouldRecordAuxiliaryUnmatchedIssues = options.recordAuxiliaryUnmatchedIssues ?? true;
  const shouldUpdateStudents = options.updateStudents ?? true;
  const getRegistrationMatch = async (row: StudentRegistrationSheetRow) => {
    const key = [
      row.studentName,
      row.parentPhone,
      row.studentPhone,
      row.parentName,
      row.birthDate?.toISOString() ?? "",
      row.grade,
      row.school,
    ].join("\u001f");

    if (!registrationMatchCache.has(key)) {
      registrationMatchCache.set(key, await findStudentIdForRegistration(row));
    }

    return registrationMatchCache.get(key) ?? null;
  };
  const getAuxiliaryMatch = async (
    studentName: string | null,
    parentPhone: string | null,
    studentPhone: string | null
  ) => {
    const key = [studentName, parentPhone, studentPhone].join("\u001f");

    if (!auxiliaryMatchCache.has(key)) {
      auxiliaryMatchCache.set(key, await findStudentIdByNameAndPhones(studentName, parentPhone, studentPhone));
    }

    return auxiliaryMatchCache.get(key) ?? null;
  };

  const registrationLedgerInputs: StudentRegistrationLedgerBulkInput[] = [];
  for (const row of rows.registrationRows) {
    const studentId = await getRegistrationMatch(row);
    const rawJSON = JSON.stringify(row.raw);
    const normalizedJSON = JSON.stringify({
      studentKey: row.studentKey,
      branch: row.branch,
      registrationMonth: row.registrationMonth,
      selectedSlotKeys: row.selectedSlotKeys,
      paymentAmount: row.paymentAmount,
      tuitionAmount: row.tuitionAmount,
      shuttleFee: row.shuttleFee,
      carryOverAmount: row.carryOverAmount,
      shuttleNeeded: row.shuttleNeeded,
      status: row.status,
    });
    const rawRowId = crypto.randomUUID();

    rawRowInputs.push({
      id: rawRowId,
      batchId,
      sheetName: "등록",
      rowNumber: row.rowNumber,
      rowHash: row.rowHash,
      studentKey: row.studentKey,
      studentId,
      rawJSON,
      normalizedJSON,
    });
    rawRows++;

    registrationLedgerInputs.push({
      id: crypto.randomUUID(),
      batchId,
      rawRowId,
      studentId,
      rowNumber: row.rowNumber,
      studentKey: row.studentKey,
      branch: row.branch,
      applicationAt: toImportDate(row.applicationAt),
      paymentDate: toImportDate(row.paymentDate),
      registrationMonth: row.registrationMonth,
      studentName: row.studentName,
      studentGender: row.studentGender,
      grade: row.grade,
      uniformStatus: row.uniformStatus,
      paymentMethod: row.paymentMethod,
      paymentAmount: row.paymentAmount,
      tuitionAmount: row.tuitionAmount,
      shuttleFee: row.shuttleFee,
      carryOverAmount: row.carryOverAmount,
      shuttleNeeded: row.shuttleNeeded,
      shuttlePickup: row.shuttlePickup,
      shuttlePreferredTime: row.shuttlePreferredTime,
      shuttleDropoff: row.shuttleDropoff,
      selectedSlotKeysJSON: JSON.stringify(row.selectedSlotKeys),
      birthDate: toImportDate(row.birthDate),
      parentName: row.parentName,
      studentPhone: row.studentPhone,
      parentPhone: row.parentPhone,
      address: row.address,
      school: row.school,
      basketballExp: row.basketballExp,
      hopeNote: row.hopeNote,
      referralSource: row.referralSource,
      agreedPrivacy: row.agreedPrivacy,
      agreedTerms: row.agreedTerms,
      agreementJSON: JSON.stringify(row.agreementJSON),
      enrollmentPeriod: row.enrollmentPeriod,
      status: row.status,
      rawJSON,
    });
    ledgerRows++;

    if (studentId) {
      const previous = latestRegistrationUpdates.get(studentId);
      if (!previous || row.rowNumber > previous.row.rowNumber) {
        latestRegistrationUpdates.set(studentId, { rawRowId, row });
      }
    } else {
      issueInputs.push({
        id: crypto.randomUUID(),
        batchId,
        sheetName: "등록",
        rowNumber: row.rowNumber,
        severity: "WARNING",
        message: row.studentKey
          ? "원본 등록 행은 저장했지만 기존/신규 Student와 연결하지 못했습니다."
          : "원본 등록 행은 저장했지만 학생 이름 또는 학부모 전화번호가 부족해 Student 연결키를 만들지 못했습니다.",
        rawJSON,
      });
      issues++;
    }
  }

  await insertStudentSheetRawRowsBulk(rawRowInputs);
  await insertStudentRegistrationLedgersBulk(registrationLedgerInputs);
  if (shouldUpdateStudents) {
    for (const { rawRowId, row } of latestRegistrationUpdates.values()) {
      const studentId = await getRegistrationMatch(row);
      if (studentId) {
        await updateStudentFromRegistrationRow(studentId, rawRowId, row);
      }
    }
  }

  rawRowInputs.length = 0;
  const shuttleRideInputs: StudentShuttleRideBulkInput[] = [];
  for (const row of rows.shuttleRows) {
    const studentId = await getAuxiliaryMatch(row.studentName, row.parentPhone, row.studentPhone);
    const rawJSON = JSON.stringify(row.raw);
    const normalizedJSON = JSON.stringify({
      studentKey: row.studentKey,
      monthLabel: row.monthLabel,
      dayLabel: row.dayLabel,
      classTime: row.classTime,
      arrivalTime: row.arrivalTime,
      destination: row.destination,
    });
    const rawRowId = crypto.randomUUID();
    rawRowInputs.push({
      id: rawRowId,
      batchId,
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      rowHash: row.rowHash,
      studentKey: row.studentKey,
      studentId,
      rawJSON,
      normalizedJSON,
    });
    rawRows++;

    shuttleRideInputs.push({
      id: crypto.randomUUID(),
      batchId,
      rawRowId,
      studentId,
      monthLabel: row.monthLabel,
      rowNumber: row.rowNumber,
      studentName: row.studentName,
      studentPhone: row.studentPhone,
      parentPhone: row.parentPhone,
      dayLabel: row.dayLabel,
      classTime: row.classTime,
      arrivalTime: row.arrivalTime,
      destination: row.destination,
      note: row.note,
      memo: row.memo,
      rawJSON,
    });
    shuttleRows++;

    if (!studentId && shouldRecordAuxiliaryUnmatchedIssues) {
      issueInputs.push({
        id: crypto.randomUUID(),
        batchId,
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        severity: "WARNING",
        message: "차량 행은 저장했지만 Student와 연결하지 못했습니다.",
        rawJSON,
      });
      issues++;
    }
  }

  await insertStudentSheetRawRowsBulk(rawRowInputs);
  await insertStudentShuttleRidesBulk(shuttleRideInputs);

  rawRowInputs.length = 0;
  const changeLogInputs: StudentChangeLogBulkInput[] = [];
  for (const row of rows.changeRows) {
    const rawJSON = JSON.stringify(row.raw);
    const normalizedJSON = JSON.stringify({
      occurredAt: toImportDate(row.occurredAt),
      changeSummary: row.changeSummary,
      registrationReflected: row.registrationReflected,
      rallyzReflected: row.rallyzReflected,
      vehicleReflected: row.vehicleReflected,
    });
    const rawRowId = crypto.randomUUID();
    rawRowInputs.push({
      id: rawRowId,
      batchId,
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      rowHash: row.rowHash,
      studentKey: null,
      studentId: null,
      rawJSON,
      normalizedJSON,
    });
    rawRows++;

    changeLogInputs.push({
      id: crypto.randomUUID(),
      batchId,
      rawRowId,
      rowNumber: row.rowNumber,
      occurredAt: row.occurredAt,
      changeSummary: row.changeSummary,
      registrationReflected: row.registrationReflected,
      rallyzReflected: row.rallyzReflected,
      vehicleReflected: row.vehicleReflected,
      alarmStatus: row.alarmStatus,
      note: row.note,
      rawJSON,
    });
    changeRows++;
  }

  await insertStudentSheetRawRowsBulk(rawRowInputs);
  await insertStudentChangeLogsBulk(changeLogInputs);

  rawRowInputs.length = 0;
  const teamRosterInputs: StudentTeamRosterEntryBulkInput[] = [];
  for (const row of rows.teamRows) {
    const teamMatch = await findStudentIdentityMatch(prisma, {
      studentName: row.studentName,
      parentPhone: row.phone,
      studentPhone: row.phone,
      birthDate: toImportDate(row.birthDate),
      grade: row.grade,
    });
    const studentId = teamMatch?.studentId ?? null;
    const rawJSON = JSON.stringify(row.raw);
    const normalizedJSON = JSON.stringify({
      studentKey: row.studentKey,
      jerseyNumber: row.jerseyNumber,
      grade: row.grade,
      branch: row.branch,
      eventColumnsJSON: row.eventColumnsJSON,
    });
    const rawRowId = crypto.randomUUID();
    rawRowInputs.push({
      id: rawRowId,
      batchId,
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      rowHash: row.rowHash,
      studentKey: row.studentKey,
      studentId,
      rawJSON,
      normalizedJSON,
    });
    rawRows++;

    teamRosterInputs.push({
      id: crypto.randomUUID(),
      batchId,
      rawRowId,
      studentId,
      rowNumber: row.rowNumber,
      studentName: row.studentName,
      birthDate: toImportDate(row.birthDate),
      jerseyNumber: row.jerseyNumber,
      phone: row.phone,
      grade: row.grade,
      branch: row.branch,
      eventColumnsJSON: JSON.stringify(row.eventColumnsJSON),
      rawJSON,
    });
    teamRows++;

    if (!studentId && shouldRecordAuxiliaryUnmatchedIssues) {
      issueInputs.push({
        id: crypto.randomUUID(),
        batchId,
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        severity: "WARNING",
        message: "대표팀 명단 행은 저장했지만 Student와 연결하지 못했습니다.",
        rawJSON,
      });
      issues++;
    }
  }

  await insertStudentSheetRawRowsBulk(rawRowInputs);
  await insertStudentTeamRosterEntriesBulk(teamRosterInputs);
  await insertStudentSheetImportIssuesBulk(issueInputs);

  await prisma.$executeRawUnsafe(
    `UPDATE "StudentSheetImportBatch"
     SET status = 'COMPLETED',
         "totalRows" = $2,
         "registrationRows" = $3,
         "vehicleRows" = $4,
         "changeRows" = $5,
         "teamRows" = $6,
         "errorRows" = $7,
         message = $8,
         "completedAt" = NOW()
     WHERE id = $1`,
    batchId,
    totalRows,
    ledgerRows,
    shuttleRows,
    changeRows,
    teamRows,
    issues,
    `원본 ${rawRows}행, 등록 ${ledgerRows}행, 차량 ${shuttleRows}행, 변동 ${changeRows}행, 대표팀 ${teamRows}행 저장 완료`
  );

  return {
    batchId,
    rawRows,
    registrationRows: ledgerRows,
    shuttleRows,
    changeRows,
    teamRows,
    issues,
  };
  } catch (error) {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "StudentSheetImportBatch"
         SET status = 'FAILED',
             message = $2,
             "completedAt" = NOW()
         WHERE id = $1`,
        batchId,
        error instanceof Error ? error.message : "수강생 시트 이관 중 오류가 발생했습니다."
      );
    } catch (markFailedError) {
      console.error("[import-students] failed to mark batch as failed:", markFailedError);
    }

    throw error;
  }
}

async function findStudentIdForRegistration(row: StudentRegistrationSheetRow) {
  const match = await findStudentIdentityMatch(prisma, {
    studentName: row.studentName,
    parentPhone: row.parentPhone,
    studentPhone: row.studentPhone,
    parentName: row.parentName,
    birthDate: row.birthDate,
    grade: row.grade,
    school: row.school,
  });
  return match?.studentId ?? null;
}

async function findStudentIdByNameAndPhones(
  studentName: string | null,
  parentPhone: string | null,
  studentPhone: string | null
) {
  const match = await findStudentIdentityMatch(prisma, {
    studentName,
    parentPhone,
    studentPhone,
  });
  return match?.studentId ?? null;
}

async function insertStudentSheetRawRow(input: {
  batchId: string;
  sheetName: string;
  rowNumber: number;
  rowHash: string | null;
  studentKey: string | null;
  studentId: string | null;
  rawJSON: string;
  normalizedJSON: string | null;
}) {
  const rawRow = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "StudentSheetRawRow" (
       id, "batchId", "sheetName", "rowNumber", "rowHash", "studentKey",
       "studentId", "rawJSON", "normalizedJSON", "createdAt"
     )
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING id`,
    input.batchId,
    input.sheetName,
    input.rowNumber,
    input.rowHash,
    input.studentKey,
    input.studentId,
    input.rawJSON,
    input.normalizedJSON
  );
  return rawRow[0]?.id ?? null;
}

function chunkArray<T>(items: T[], size = IMPORT_BULK_CHUNK_SIZE) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toImportDate(value: Date | null) {
  if (!value || Number.isNaN(value.getTime())) return null;
  const year = value.getUTCFullYear();
  return year >= 1900 && year <= 2100 ? value : null;
}

async function insertStudentSheetRawRowsBulk(rows: StudentSheetRawRowBulkInput[]) {
  for (const chunk of chunkArray(rows)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StudentSheetRawRow" (
         id, "batchId", "sheetName", "rowNumber", "rowHash", "studentKey",
         "studentId", "rawJSON", "normalizedJSON", "createdAt"
       )
       SELECT
         x.id, x."batchId", x."sheetName", x."rowNumber", x."rowHash", x."studentKey",
         x."studentId", x."rawJSON", x."normalizedJSON", NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, "batchId" text, "sheetName" text, "rowNumber" int, "rowHash" text,
         "studentKey" text, "studentId" text, "rawJSON" text, "normalizedJSON" text
       )`,
      JSON.stringify(chunk)
    );
  }
}

async function insertStudentRegistrationLedgersBulk(rows: StudentRegistrationLedgerBulkInput[]) {
  for (const chunk of chunkArray(rows)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StudentRegistrationLedger" (
         id, "batchId", "rawRowId", "studentId", "rowNumber", "studentKey",
         branch, "applicationAt", "paymentDate", "registrationMonth",
         "studentName", "studentGender", grade, "uniformStatus", "paymentMethod",
         "paymentAmount", "tuitionAmount", "shuttleFee", "carryOverAmount",
         "shuttleNeeded", "shuttlePickup", "shuttlePreferredTime", "shuttleDropoff",
         "selectedSlotKeysJSON", "birthDate", "parentName", "studentPhone", "parentPhone",
         address, school, "basketballExp", "hopeNote", "referralSource",
         "agreedPrivacy", "agreedTerms", "agreementJSON", "enrollmentPeriod",
         status, "rawJSON", "createdAt", "updatedAt"
       )
       SELECT
         x.id, x."batchId", x."rawRowId", x."studentId", x."rowNumber", x."studentKey",
         x.branch, x."applicationAt", x."paymentDate", x."registrationMonth",
         x."studentName", x."studentGender", x.grade, x."uniformStatus", x."paymentMethod",
         x."paymentAmount", x."tuitionAmount", x."shuttleFee", x."carryOverAmount",
         COALESCE(x."shuttleNeeded", false), x."shuttlePickup", x."shuttlePreferredTime", x."shuttleDropoff",
         COALESCE(x."selectedSlotKeysJSON", '[]'), x."birthDate", x."parentName", x."studentPhone", x."parentPhone",
         x.address, x.school, x."basketballExp", x."hopeNote", x."referralSource",
         COALESCE(x."agreedPrivacy", false), COALESCE(x."agreedTerms", false), COALESCE(x."agreementJSON", '{}'), x."enrollmentPeriod",
         COALESCE(x.status, 'ACTIVE'), x."rawJSON", NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, "batchId" text, "rawRowId" text, "studentId" text, "rowNumber" int, "studentKey" text,
         branch text, "applicationAt" timestamptz, "paymentDate" timestamptz, "registrationMonth" text,
         "studentName" text, "studentGender" text, grade text, "uniformStatus" text, "paymentMethod" text,
         "paymentAmount" int, "tuitionAmount" int, "shuttleFee" int, "carryOverAmount" int,
         "shuttleNeeded" boolean, "shuttlePickup" text, "shuttlePreferredTime" text, "shuttleDropoff" text,
         "selectedSlotKeysJSON" text, "birthDate" timestamptz, "parentName" text, "studentPhone" text, "parentPhone" text,
         address text, school text, "basketballExp" text, "hopeNote" text, "referralSource" text,
         "agreedPrivacy" boolean, "agreedTerms" boolean, "agreementJSON" text, "enrollmentPeriod" text,
         status text, "rawJSON" text
       )`,
      JSON.stringify(chunk)
    );
  }
}

async function insertStudentShuttleRidesBulk(rows: StudentShuttleRideBulkInput[]) {
  for (const chunk of chunkArray(rows)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StudentShuttleRide" (
         id, "batchId", "rawRowId", "studentId", "monthLabel", "rowNumber",
         "studentName", "studentPhone", "parentPhone", "dayLabel", "classTime",
         "arrivalTime", destination, note, memo, "rawJSON", "createdAt", "updatedAt"
       )
       SELECT
         x.id, x."batchId", x."rawRowId", x."studentId", x."monthLabel", x."rowNumber",
         x."studentName", x."studentPhone", x."parentPhone", x."dayLabel", x."classTime",
         x."arrivalTime", x.destination, x.note, x.memo, x."rawJSON", NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, "batchId" text, "rawRowId" text, "studentId" text, "monthLabel" text, "rowNumber" int,
         "studentName" text, "studentPhone" text, "parentPhone" text, "dayLabel" text, "classTime" text,
         "arrivalTime" text, destination text, note text, memo text, "rawJSON" text
       )`,
      JSON.stringify(chunk)
    );
  }
}

async function insertStudentChangeLogsBulk(rows: StudentChangeLogBulkInput[]) {
  for (const chunk of chunkArray(rows)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StudentChangeLog" (
         id, "batchId", "rawRowId", "rowNumber", "occurredAt", "changeSummary",
         "registrationReflected", "rallyzReflected", "vehicleReflected",
         "alarmStatus", note, "rawJSON", "createdAt"
       )
       SELECT
         x.id, x."batchId", x."rawRowId", x."rowNumber", x."occurredAt", x."changeSummary",
         COALESCE(x."registrationReflected", false), COALESCE(x."rallyzReflected", false), COALESCE(x."vehicleReflected", false),
         x."alarmStatus", x.note, x."rawJSON", NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, "batchId" text, "rawRowId" text, "rowNumber" int, "occurredAt" timestamptz, "changeSummary" text,
         "registrationReflected" boolean, "rallyzReflected" boolean, "vehicleReflected" boolean,
         "alarmStatus" text, note text, "rawJSON" text
       )`,
      JSON.stringify(chunk)
    );
  }
}

async function insertStudentTeamRosterEntriesBulk(rows: StudentTeamRosterEntryBulkInput[]) {
  for (const chunk of chunkArray(rows)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StudentTeamRosterEntry" (
         id, "batchId", "rawRowId", "studentId", "rowNumber", "studentName",
         "birthDate", "jerseyNumber", phone, grade, branch, "eventColumnsJSON",
         "rawJSON", "createdAt", "updatedAt"
       )
       SELECT
         x.id, x."batchId", x."rawRowId", x."studentId", x."rowNumber", x."studentName",
         x."birthDate", x."jerseyNumber", x.phone, x.grade, x.branch, COALESCE(x."eventColumnsJSON", '{}'),
         x."rawJSON", NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, "batchId" text, "rawRowId" text, "studentId" text, "rowNumber" int, "studentName" text,
         "birthDate" timestamptz, "jerseyNumber" text, phone text, grade text, branch text, "eventColumnsJSON" text,
         "rawJSON" text
       )`,
      JSON.stringify(chunk)
    );
  }
}

async function insertStudentSheetImportIssuesBulk(rows: StudentSheetImportIssueBulkInput[]) {
  for (const chunk of chunkArray(rows)) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StudentSheetImportIssue" (
         id, "batchId", "sheetName", "rowNumber", severity, message, "rawJSON", "createdAt"
       )
       SELECT
         x.id, x."batchId", x."sheetName", x."rowNumber", x.severity, x.message, x."rawJSON", NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, "batchId" text, "sheetName" text, "rowNumber" int, severity text, message text, "rawJSON" text
       )`,
      JSON.stringify(chunk)
    );
  }
}

async function updateStudentFromRegistrationRow(
  studentId: string,
  rawRowId: string | null,
  row: StudentRegistrationSheetRow
) {
  await prisma.$executeRawUnsafe(
    `UPDATE "Student"
     SET branch = COALESCE($2, branch),
         gender = COALESCE($3, gender),
         phone = COALESCE($4, phone),
         school = COALESCE($5, school),
         grade = COALESCE($6, grade),
         address = COALESCE($7, address),
         "birthDate" = COALESCE($8::timestamp, "birthDate"),
         "referralSource" = COALESCE($9, "referralSource"),
         "uniformStatus" = COALESCE($10, "uniformStatus"),
         "basketballExp" = COALESCE($11, "basketballExp"),
         "hopeNote" = COALESCE($12, "hopeNote"),
         "agreementsJSON" = $13,
         "sourceImportRowId" = COALESCE($14, "sourceImportRowId"),
         "updatedAt" = NOW()
     WHERE id = $1`,
    studentId,
    row.branch,
    row.studentGender,
    row.studentPhone,
    row.school,
    row.grade,
    row.address,
    row.birthDate,
    row.referralSource,
    row.uniformStatus,
    row.basketballExp,
    row.hopeNote,
    JSON.stringify(row.agreementJSON),
    rawRowId
  );
}

async function createImportIssue(
  batchId: string,
  sheetName: string,
  rowNumber: number,
  severity: "WARNING" | "ERROR",
  message: string,
  rawJSON: string
) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "StudentSheetImportIssue" (
       id, "batchId", "sheetName", "rowNumber", severity, message, "rawJSON", "createdAt"
     )
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW())`,
    batchId,
    sheetName,
    rowNumber,
    severity,
    message,
    rawJSON
  );
}
