"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { syncCreditForRegularSession } from "@/lib/makeup/credit-service";
import { ensureOperationsSyncInfrastructure } from "@/lib/operationsSyncInfrastructure";
import { decideAttendanceWrite, parseRallyzAttendanceJson } from "@/lib/rallyzAttendanceSync";

export type RallyzAttendanceSyncItemRow = {
  id: string; studentName: string; sourceClassName: string; sourceStatus: string;
  siteStatus: string | null; status: string; holdReason: string | null;
};
export type RallyzAttendanceSyncRunRow = {
  id: string; sourceDate: string; status: string; createdAt: string;
  items: RallyzAttendanceSyncItemRow[];
};

async function resolveRow(row: ReturnType<typeof parseRallyzAttendanceJson>[number]) {
  if (!row.slotKey) return { holdReason: "반 이름에서 요일·교시를 읽지 못했습니다." };
  if (!row.siteStatus) return { holdReason: `${row.status} 상태는 자동 변환하지 않습니다.` };
  const classes = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "Class" WHERE "slotKey"=$1 ORDER BY "createdAt" DESC LIMIT 2`, row.slotKey,
  );
  if (classes.length !== 1) return { holdReason: classes.length ? "같은 요일·교시의 반이 여러 개입니다." : "홈페이지에서 해당 반을 찾지 못했습니다." };
  const identityNames = [...new Set([row.studentName, row.managementName].filter((name): name is string => Boolean(name)))];
  const students = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT DISTINCT s.id FROM "Student" s JOIN "Enrollment" e ON e."studentId"=s.id
      WHERE s.name=ANY($1::text[]) AND s."mergedIntoStudentId" IS NULL AND e."classId"=$2 AND e.status='ACTIVE' LIMIT 2`,
    identityNames, classes[0].id,
  );
  if (students.length !== 1) return { classId: classes[0].id, holdReason: students.length ? "같은 반에 동명이인이 있습니다." : "해당 반의 활성 수강생을 찾지 못했습니다." };
  const sessions = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "Session" WHERE "classId"=$1 AND date=$2::date ORDER BY "createdAt" DESC LIMIT 1`, classes[0].id, row.date,
  );
  const existing = sessions[0] ? await prisma.$queryRawUnsafe<Array<{ id: string; status: string; note: string | null }>>(
    `SELECT id,status,note FROM "Attendance" WHERE "sessionId"=$1 AND "studentId"=$2 LIMIT 1`, sessions[0].id, students[0].id,
  ) : [];
  const decision = decideAttendanceWrite(existing[0] || null, row.siteStatus);
  return {
    classId: classes[0].id, studentId: students[0].id, sessionId: sessions[0]?.id,
    attendanceId: existing[0]?.id, decision,
    holdReason: decision === "HOLD" ? `홈페이지에 ${existing[0].status}로 수동 기록되어 있어 덮어쓰지 않았습니다.` : null,
  };
}

export async function previewRallyzAttendanceSync(sourceText: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const rows = parseRallyzAttendanceJson(sourceText);
  const dates = [...new Set(rows.map((row) => row.date))];
  if (dates.length !== 1) throw new Error("한 번에는 같은 날짜의 출석만 가져와 주세요.");
  const runId = crypto.randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RallyzAttendanceSyncRun" (id,"sourceDate","sourceJson","requestedByUserId") VALUES ($1,$2::date,$3::jsonb,$4)`,
    runId, dates[0], JSON.stringify(rows), admin.appUserId,
  );
  for (const row of rows) {
    const resolved = await resolveRow(row);
    const alreadyImported = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "RallyzAttendanceSyncItem" WHERE "idempotencyKey"=$1 AND status IN ('APPLIED','SKIPPED') LIMIT 1`, row.idempotencyKey,
    );
    const status = alreadyImported.length ? "SKIPPED" : resolved.holdReason ? "HELD" : resolved.decision === "SKIP" ? "SKIPPED" : "PENDING";
    const holdReason = alreadyImported.length ? "이미 가져온 동일 출석입니다." : resolved.holdReason || null;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RallyzAttendanceSyncItem"
       (id,"runId","idempotencyKey","sourceDate","rallyzClassId","sourceClassName","slotKey","studentName","managementName","sourceStatus","siteStatus","studentId","classId","sessionId","attendanceId",status,"holdReason")
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT ("runId","idempotencyKey") DO NOTHING`,
      crypto.randomUUID(), runId, row.idempotencyKey, row.date, row.rallyzClassId || null, row.className, row.slotKey,
      row.studentName, row.managementName || null, row.status, row.siteStatus, resolved.studentId || null,
      resolved.classId || null, resolved.sessionId || null, resolved.attendanceId || null, status, holdReason,
    );
  }
  await prisma.$executeRawUnsafe(
    `UPDATE "RallyzAttendanceSyncRun" SET status=CASE WHEN EXISTS(SELECT 1 FROM "RallyzAttendanceSyncItem" WHERE "runId"=$1 AND status='HELD') THEN 'HELD' ELSE 'PREVIEW' END WHERE id=$1`, runId,
  );
  revalidatePath("/admin/operations-sync");
  return { ok: true as const, runId };
}

export async function applyRallyzAttendanceSync(runId: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const items = await prisma.$queryRawUnsafe<Array<RallyzAttendanceSyncItemRow & { studentId: string | null; classId: string | null; sourceDate: string }>>(
    `SELECT id,"studentName","sourceClassName","sourceStatus","siteStatus",status,"holdReason","studentId","classId","sourceDate"::text
       FROM "RallyzAttendanceSyncItem" WHERE "runId"=$1 AND status='PENDING' ORDER BY "createdAt"`, runId,
  );
  let applied = 0;
  // 실제로 적용된 출결 — 트랜잭션이 커밋된 뒤 보강권을 맞추기 위해 모은다.
  const creditTargets: Array<{ sessionId: string; studentId: string; status: string }> = [];
  for (const item of items) {
    if (!item.studentId || !item.classId || !item.siteStatus) continue;
    // 트랜잭션 콜백 안에서는 위 null 검사가 타입에 이어지지 않아 값을 미리 붙잡아 둔다(보강권 대상 기록용).
    const creditStudentId = item.studentId;
    const creditStatus = item.siteStatus;
    await prisma.$transaction(async (tx) => {
      const sessionKey = `${item.classId}:${item.sourceDate}`;
      const sessions = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "Session" (id,"classId",date,"sessionKey",status,"createdAt","updatedAt")
         VALUES (gen_random_uuid()::text,$1,$2::date,$3,'PLANNED',now(),now())
         ON CONFLICT ("sessionKey") DO UPDATE SET "updatedAt"=now() RETURNING id`, item.classId, item.sourceDate, sessionKey,
      );
      const existing = await tx.$queryRawUnsafe<Array<{ id: string; status: string; note: string | null }>>(
        `SELECT id,status,note FROM "Attendance" WHERE "sessionId"=$1 AND "studentId"=$2 LIMIT 1`, sessions[0].id, item.studentId,
      );
      const decision = decideAttendanceWrite(existing[0] || null, item.siteStatus as "PRESENT" | "LATE" | "ABSENT");
      if (decision === "HOLD") {
        await tx.$executeRawUnsafe(`UPDATE "RallyzAttendanceSyncItem" SET status='HELD',"holdReason"='적용 직전 홈페이지 수동 기록과 충돌했습니다.',"updatedAt"=now() WHERE id=$1`, item.id);
        return;
      }
      if (decision === "SKIP") {
        await tx.$executeRawUnsafe(`UPDATE "RallyzAttendanceSyncItem" SET status='SKIPPED',"sessionId"=$2,"attendanceId"=$3,"updatedAt"=now() WHERE id=$1`, item.id, sessions[0].id, existing[0].id);
        return;
      }
      const saved = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "Attendance" (id,"sessionId","studentId",status,note,"checkedAt","arrivedAt","checkedByUserId","createdAt","updatedAt")
         VALUES (gen_random_uuid()::text,$1,$2,$3,$4,now(),CASE WHEN $3='LATE' THEN now() ELSE NULL END,$5,now(),now())
         ON CONFLICT ("sessionId","studentId") DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,"checkedAt"=now(),"arrivedAt"=EXCLUDED."arrivedAt","checkedByUserId"=EXCLUDED."checkedByUserId","updatedAt"=now()
         RETURNING id`, sessions[0].id, item.studentId, item.siteStatus, `[RALLYZ_SYNC] ${item.sourceClassName} · ${item.sourceStatus}`, admin.appUserId,
      );
      await tx.$executeRawUnsafe(`UPDATE "RallyzAttendanceSyncItem" SET status='APPLIED',"sessionId"=$2,"attendanceId"=$3,"updatedAt"=now() WHERE id=$1`, item.id, sessions[0].id, saved[0].id);
      applied += 1;
      creditTargets.push({ sessionId: sessions[0].id, studentId: creditStudentId, status: creditStatus });
    });
  }
  // 보강권 — 결석이면 발급, 출석·지각으로 정정되면 회수(관리자·코치 화면과 같은 함수).
  // ★ 출결은 이미 저장됐다. 보강권이 실패해도 적용 결과를 되돌리지 않는다.
  for (const target of creditTargets) {
    try {
      await syncCreditForRegularSession(target);
    } catch (error) {
      console.error("[applyRallyzAttendanceSync] 보강권 처리 실패(출결은 저장됨)", { ...target, error });
    }
  }
  await prisma.$executeRawUnsafe(
    `UPDATE "RallyzAttendanceSyncRun" SET status=CASE WHEN EXISTS(SELECT 1 FROM "RallyzAttendanceSyncItem" WHERE "runId"=$1 AND status='HELD') THEN 'PARTIAL' ELSE 'APPLIED' END,"appliedByUserId"=$2,"appliedAt"=now(),"updatedAt"=now() WHERE id=$1`, runId, admin.appUserId,
  );
  revalidatePath("/admin/operations-sync");
  return { ok: true as const, applied };
}

export async function getRallyzAttendanceSyncRuns(): Promise<RallyzAttendanceSyncRunRow[]> {
  await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; sourceDate: string; status: string; createdAt: Date | string; items: RallyzAttendanceSyncItemRow[] }>>(
    `SELECT r.id,r."sourceDate"::text,r.status,r."createdAt",
      COALESCE(json_agg(json_build_object('id',i.id,'studentName',i."studentName",'sourceClassName',i."sourceClassName",'sourceStatus',i."sourceStatus",'siteStatus',i."siteStatus",'status',i.status,'holdReason',i."holdReason") ORDER BY i."createdAt") FILTER(WHERE i.id IS NOT NULL),'[]'::json) items
     FROM "RallyzAttendanceSyncRun" r LEFT JOIN "RallyzAttendanceSyncItem" i ON i."runId"=r.id GROUP BY r.id ORDER BY r."createdAt" DESC LIMIT 20`,
  );
  return rows.map((row) => ({ ...row, createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt }));
}
