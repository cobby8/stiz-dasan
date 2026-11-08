"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { isShuttleRosterTask, shuttleRosterTaskNextStatus } from "@/lib/kakaoShuttleRosterTask";

// 원장 할 일 «셔틀 명단에 넣어 주세요» — «처리 완료» 표시.
// 명단(RegularShuttleStop)은 여기서 바꾸지 않는다. 원장이 명단 화면에서 학생을 넣은 뒤, 끝났다는 표시만 남긴다.
// 표시 위치: 기존 KakaoParentIntake.structuredJson.rosterTask(새 표·새 칸 없음) + 상태(결정 전이면 APPLIED=접수 종결)
// + 검토 이력(KakaoParentIntakeAudit). 학부모에게는 아무것도 보내지 않는다.

export async function completeKakaoShuttleRosterTask(input: { intakeId: string }) {
  const admin = await requireAdmin();
  const intakeId = typeof input?.intakeId === "string" ? input.intakeId.trim() : "";
  if (!intakeId || intakeId.length > 64) return { ok: false as const, message: "접수를 찾지 못했습니다." };

  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; kind: string; status: string; studentId: string | null; structuredJson: unknown }>>(
    `SELECT id, kind, status, "studentId", "structuredJson" FROM "KakaoParentIntake" WHERE id=$1 LIMIT 1`,
    intakeId,
  );
  const row = rows[0];
  if (!row || !isShuttleRosterTask(row)) {
    return { ok: false as const, message: "이미 처리됐거나 셔틀 명단 할 일이 아닌 접수입니다. 새로고침해 주세요." };
  }
  const next = shuttleRosterTaskNextStatus(row.status);
  if (!next) return { ok: false as const, message: "접수를 분류하는 중입니다. 잠시 뒤 다시 눌러 주세요." };

  const doneAt = new Date().toISOString(); // 기록용 시각(달력 날짜로 쓰지 않는다)
  const done = await prisma.$transaction(async (tx) => {
    // 읽은 상태 그대로일 때만 바꾼다 — 그사이 다른 관리자가 결정했으면 아무것도 하지 않는다(선점 UPDATE 한 문장).
    const changed = await tx.$executeRawUnsafe(
      `UPDATE "KakaoParentIntake"
          SET status=$2,
              "structuredJson"=jsonb_set(COALESCE("structuredJson",'{}'::jsonb),'{rosterTask}',
                                         jsonb_build_object('doneAt',$4::text,'doneByUserId',$3::text)),
              "appliedAt"=CASE WHEN $2='APPLIED' THEN now() ELSE "appliedAt" END,
              "decidedByUserId"=CASE WHEN $2='APPLIED' THEN $3 ELSE "decidedByUserId" END,
              "decidedAt"=CASE WHEN $2='APPLIED' THEN now() ELSE "decidedAt" END,
              "decisionNote"=CASE WHEN $2='APPLIED' THEN '셔틀 명단 반영' ELSE "decisionNote" END,
              "updatedAt"=GREATEST(clock_timestamp(),"updatedAt"+interval '1 microsecond')
        WHERE id=$1 AND status=$5 AND ("structuredJson"->'rosterTask'->>'doneAt') IS NULL`,
      row.id, next, admin.appUserId, doneAt, row.status,
    );
    if (Number(changed) !== 1) return false;
    await tx.$executeRawUnsafe(
      `INSERT INTO "KakaoParentIntakeAudit"
        (id,"intakeId",action,"actorUserId","fromStatus","toStatus",note,"detailsJson")
       VALUES ($1,$2,'SHUTTLE_ROSTER_DONE',$3,$4,$5,'셔틀 명단 반영',$6::jsonb)`,
      crypto.randomUUID(), row.id, admin.appUserId, row.status, next,
      JSON.stringify({ externalMessageSent: false, rosterChangedByThisAction: false }),
    );
    return true;
  });
  if (!done) return { ok: false as const, message: "다른 관리자가 먼저 처리했습니다. 새로고침해 주세요." };

  revalidatePath("/admin/kakao-requests");
  revalidatePath("/admin/shuttle/regular");
  return { ok: true as const, status: next };
}
