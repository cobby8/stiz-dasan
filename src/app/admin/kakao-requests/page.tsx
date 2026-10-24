import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import KakaoRequestsClient, { type KakaoClassOption, type KakaoRequestAdminRow } from "./KakaoRequestsClient";

export const dynamic = "force-dynamic";

type DbRow = Omit<KakaoRequestAdminRow, "createdAt" | "decidedAt" | "commands"> & {
  createdAt: Date;
  decidedAt: Date | null;
  parentUserId: string | null;
  rawParentName: string | null;
};

const FILTER_VALUES = ["ACTION", "SUBMITTED", "HELD", "FAILED", "FOLLOWUP", "DONE", "ALL"] as const;

function isKakaoSchemaNotReady(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return ["42P01", "42703"].includes(code)
    || /KakaoParent(?:Identity|Intake|IntakeAudit).*(?:does not exist|존재하지)/i.test(message);
}

function maskName(value: string | null) {
  const name = value?.trim() ?? "";
  if (!name) return null;
  if (name.length === 1) return "*";
  if (name.length === 2) return `${name[0]}*`;
  return `${name[0]}${"*".repeat(name.length - 2)}${name.at(-1)}`;
}

export default async function KakaoRequestsPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>;
}) {
  await requireAdmin();
  const requested = (await searchParams)?.status ?? "ACTION";
  const status = FILTER_VALUES.includes(requested as (typeof FILTER_VALUES)[number]) ? requested : "ACTION";
  let rows: DbRow[] = [];
  let classes: KakaoClassOption[] = [];
  let schemaReady = true;
  let commandsByRequest = new Map<string, KakaoRequestAdminRow["commands"]>();

  try {
    rows = await prisma.$queryRawUnsafe<DbRow[]>(
      `SELECT r.id,r."updatedAt"::text AS revision,r.kind,r."sourceText",r."structuredJson",r.status,r."createdAt",
              r."decidedAt",r."decisionNote",r."operationsRequestId",(r."errorCode" IS NOT NULL) AS "hasProcessingError",
              r."studentId",s.name AS "studentName",s.grade AS "studentGrade",
              i."parentUserId",u.name AS "rawParentName",i.status AS "identityStatus",
              reviewer.name AS "decidedByName"
         FROM "KakaoParentIntake" r
         JOIN "KakaoParentIdentity" i ON i.id=r."identityId"
         LEFT JOIN "Student" s ON s.id=r."studentId"
         LEFT JOIN "User" u ON u.id=i."parentUserId"
         LEFT JOIN "User" reviewer ON reviewer.id=r."decidedByUserId"
        WHERE ($1='ALL')
           OR ($1='ACTION' AND r.status IN ('SUBMITTED','HELD','FAILED','NEEDS_DETAILS','APPROVED','CONSULTATION','PROCESSING'))
           OR ($1='FOLLOWUP' AND r.status IN ('APPROVED','CONSULTATION','NEEDS_DETAILS','PROCESSING'))
           OR ($1='DONE' AND r.status IN ('REJECTED','APPLIED','CANCELED','CONSULTATION_CLOSED'))
           OR r.status=$1
        ORDER BY CASE WHEN r.status IN ('SUBMITTED','HELD','FAILED','NEEDS_DETAILS','PROCESSING') THEN 0 ELSE 1 END,
                 r."createdAt" DESC
        LIMIT 200`,
      status,
    );
    const requestIds = rows.flatMap(row => row.operationsRequestId ? [row.operationsRequestId] : []);
    if (requestIds.length) {
      const commands = await prisma.$queryRawUnsafe<Array<KakaoRequestAdminRow["commands"][number] & { requestId: string }>>(
        `SELECT "requestId",status,"holdReason",
                COALESCE("afterJson"->'parentConfirmed' = 'true'::jsonb,false) AS "parentConfirmed",
                COALESCE("afterJson"->'parentReconfirmationRequired' = 'true'::jsonb,false) AS "parentReconfirmationRequired"
           FROM "OperationsCommand" WHERE "requestId" = ANY($1::text[])`, requestIds,
      );
      commandsByRequest = new Map(requestIds.map(id => [id, commands.filter(command => command.requestId === id)]));
    }
    const studentIds = rows.flatMap((row) => row.studentId ? [row.studentId] : []);
    const parentUserIds = [...new Set(rows.flatMap((row) => row.parentUserId ? [row.parentUserId] : []))];
    const [classRows, enrollmentRows, linkedStudentRows] = await Promise.all([
      prisma.class.findMany({
        where: { dayOfWeek: { not: "Seasonal" }, program:{ deletedAt:null } },
        select: { id:true, name:true, dayOfWeek:true, startTime:true, endTime:true, program:{ select:{ name:true } } },
        orderBy: [{ dayOfWeek:"asc" }, { startTime:"asc" }],
      }),
      studentIds.length === 0 ? Promise.resolve([]) : prisma.enrollment.findMany({
        where: { studentId:{ in:studentIds }, status:{ in:["ACTIVE","PAUSED"] } },
        select: { studentId:true, classId:true },
      }),
      parentUserIds.length === 0 ? Promise.resolve([]) : prisma.student.findMany({
        where: { parentId:{ in:parentUserIds }, mergedIntoStudentId:null },
        select: { id:true, name:true, grade:true, parentId:true },
        orderBy: [{ name:"asc" }],
      }),
    ]);
    const dayLabel: Record<string,string> = { Monday:"월", Tuesday:"화", Wednesday:"수", Thursday:"목", Friday:"금", Saturday:"토", Sunday:"일" };
    classes = classRows.map((item) => ({ id:item.id, label:`${dayLabel[item.dayOfWeek] ?? item.dayOfWeek} ${item.startTime}~${item.endTime} · ${item.name} · ${item.program.name}` }));
    const enrolledByStudent = new Map<string,string[]>();
    for (const enrollment of enrollmentRows) enrolledByStudent.set(enrollment.studentId, [...(enrolledByStudent.get(enrollment.studentId) ?? []), enrollment.classId]);
    rows = rows.map((row) => ({
      ...row,
      parentName:maskName(row.rawParentName),
      linkedStudents:row.parentUserId ? linkedStudentRows.filter((student) => student.parentId === row.parentUserId).map(({ id,name,grade }) => ({ id,name,grade })) : [],
      currentClassIds:row.studentId ? enrolledByStudent.get(row.studentId) ?? [] : [],
    }));
  } catch (error) {
    if (!isKakaoSchemaNotReady(error)) throw error;
    schemaReady = false;
  }

  // 기존 배포 사전검사와 운영자 안내가 찾는 안전 문구: 카카오 접수함 DB 준비가 필요합니다.
  return (
    <KakaoRequestsClient
      rows={rows.map((row) => ({
        id:row.id, revision:row.revision, kind:row.kind, sourceText:row.sourceText, structuredJson:row.structuredJson, status:row.status,
        studentId:row.studentId, studentName:row.studentName, studentGrade:row.studentGrade,
        parentName:row.parentName, linkedStudents:row.linkedStudents, identityStatus:row.identityStatus,
        operationsRequestId:row.operationsRequestId, decisionNote:row.decisionNote, decidedByName:row.decidedByName,
        currentClassIds:row.currentClassIds,
        hasProcessingError:row.hasProcessingError,
        commands:row.operationsRequestId ? commandsByRequest.get(row.operationsRequestId) ?? [] : [],
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
      }))}
      classes={classes}
      status={status}
      schemaReady={schemaReady}
    />
  );
}
