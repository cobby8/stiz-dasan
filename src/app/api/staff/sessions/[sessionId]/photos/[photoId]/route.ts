import { userFacingError } from "@/lib/user-facing-error";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffClassAccess } from "@/lib/staff-class-access";
import { isValidPrivateSessionPhotoRef, parseSessionPhotoEntries, parseStoredSessionPhotos } from "@/lib/sessionPhotoStorage";
import { requireAuth } from "@/lib/auth-guard";
import {
  findManagedSessionPhoto,
  isEmptyMediaJSON,
  removePhotoFromMediaJSON,
  type SessionPhotoDraftRow,
} from "@/lib/sessionPhotoManagement";
import { normalizeSubjectStudentIds } from "@/lib/studentMediaConsentPolicy";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  enqueueSessionPhotoDeletion,
  ensureSessionPhotoDeletionQueue,
  processSessionPhotoDeletionQueue,
} from "@/lib/sessionPhotoDeletionQueue";
import { isSinglePhotoDraft } from "@/lib/sessionPhotoManagementPolicy";

type PhotoViewer = { kind: "STAFF" } | { kind: "PARENT"; studentIds: string[] };

async function requirePhotoViewer(classId: string, sessionStatus: string): Promise<PhotoViewer> {
  try {
    await requireStaffClassAccess(classId);
    return { kind: "STAFF" };
  } catch {
    const user = await requireAuth();
    if (sessionStatus !== "COMPLETED" || !user.email) throw new Error("사진 접근 권한이 없습니다.");
    const rows = await prisma.$queryRawUnsafe<Array<{ studentId: string }>>(
      `SELECT DISTINCT s.id AS "studentId"
       FROM "User" u
       JOIN "Student" s ON s."parentId" = u.id AND ${notMergedStudent("s")}
       JOIN "Enrollment" e ON e."studentId" = s.id
       WHERE LOWER(u.email) = LOWER($1) AND e."classId" = $2 AND e.status = 'ACTIVE'`,
      user.email,
      classId,
    );
    if (!rows[0]) throw new Error("사진 접근 권한이 없습니다.");
    return { kind: "PARENT", studentIds: rows.map((row) => row.studentId) };
  }
}

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string; photoId: string }> }) {
  try {
    const { sessionId, photoId } = await context.params;
    const rows = await prisma.$queryRawUnsafe<Array<{ classId: string; status: string }>>(
      `SELECT "classId", status FROM "Session" WHERE id = $1 LIMIT 1`,
      sessionId,
    );
    const session = rows[0];
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    const viewer = await requirePhotoViewer(session.classId, session.status);
    const drafts = await prisma.$queryRawUnsafe<Array<{ mediaJSON: string; subjectStudentIdsJSON: string }>>(
      `SELECT "mediaJSON", "subjectStudentIdsJSON" FROM "SocialPostDraft" WHERE "sessionId" = $1 ORDER BY "createdAt" DESC`,
      sessionId,
    );
    const matchedDraft = drafts.find((draft) => parseStoredSessionPhotos(draft.mediaJSON).some((item) => item.id === photoId));
    const photo = matchedDraft && parseStoredSessionPhotos(matchedDraft.mediaJSON).find((item) => item.id === photoId);
    if (!photo) return NextResponse.json({ error: "사진을 찾을 수 없습니다." }, { status: 404 });
    if (viewer.kind === "PARENT") {
      let subjectStudentIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(matchedDraft?.subjectStudentIdsJSON || "[]");
        if (Array.isArray(parsed)) {
          subjectStudentIds = [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0))];
        }
      } catch {
        subjectStudentIds = [];
      }
      if (subjectStudentIds.length === 0 || !subjectStudentIds.some((id) => viewer.studentIds.includes(id))) {
        throw new Error("사진 열람 동의를 확인할 수 없습니다.");
      }
      const consentRows = await prisma.$queryRawUnsafe<Array<{ studentId: string; internalAllowed: boolean; revokedAt: Date | null }>>(
        `SELECT subjects.id AS "studentId", latest."internalAllowed", latest."revokedAt"
           FROM unnest($1::text[]) subjects(id)
           LEFT JOIN LATERAL (
             SELECT c."internalAllowed", c."revokedAt"
               FROM "StudentMediaConsent" c
              WHERE c."studentId" = subjects.id
              ORDER BY c."recordedAt" DESC, c.id DESC
              LIMIT 1
           ) latest ON true`,
        subjectStudentIds,
      );
      if (consentRows.length !== subjectStudentIds.length
        || consentRows.some((row) => !row.internalAllowed || row.revokedAt !== null)) {
        throw new Error("사진 열람 동의를 확인할 수 없습니다.");
      }
    }
    if (!isValidPrivateSessionPhotoRef(photo as unknown as Record<string, unknown>, { classId: session.classId, sessionId })) {
      return NextResponse.json({ error: "사진 경로가 올바르지 않습니다." }, { status: 400 });
    }

    const { data, error } = await createAdminClient().storage.from(photo.storageBucket).download(photo.storagePath);
    if (error || !data) return NextResponse.json({ error: "사진을 불러오지 못했습니다." }, { status: 404 });
    return new Response(await data.arrayBuffer(), {
      headers: {
        "Content-Type": data.type || "image/jpeg",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "사진 접근 권한이 없습니다." }, { status: 403 });
  }
}

async function requireManageablePhoto(sessionId: string, photoId: string) {
  const sessions = await prisma.$queryRawUnsafe<Array<{ classId: string; status: string }>>(
    `SELECT "classId", status FROM "Session" WHERE id = $1 LIMIT 1`,
    sessionId,
  );
  const session = sessions[0];
  if (!session) return { response: NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 }) };
  await requireStaffClassAccess(session.classId);
  if (session.status !== "IN_PROGRESS") {
    return { response: NextResponse.json({ error: "진행 중인 수업의 사진만 관리할 수 있습니다." }, { status: 409 }) };
  }
  const drafts = await prisma.$queryRawUnsafe<SessionPhotoDraftRow[]>(
    `SELECT id, status, "mediaJSON", "subjectStudentIdsJSON", "galleryPostId", "instagramMediaId"
       FROM "SocialPostDraft"
      WHERE "sessionId" = $1 AND source = 'SESSION_PHOTO'`,
    sessionId,
  );
  const photo = findManagedSessionPhoto(drafts, photoId);
  if (!photo) return { response: NextResponse.json({ error: "사진을 찾을 수 없습니다." }, { status: 404 }) };
  const owningDraft = drafts.find((draft) => draft.id === photo.draftId);
  if (!owningDraft || !isSinglePhotoDraft(parseStoredSessionPhotos(owningDraft.mediaJSON).length)) {
    return { response: NextResponse.json({ error: "여러 사진이 묶인 이전 초안은 관리자가 분리한 뒤 수정할 수 있습니다." }, { status: 409 }) };
  }
  if (!photo.canManage) {
    return {
      response: NextResponse.json(
        { error: "이미 공개 처리된 사진은 삭제 대기열을 통해 회수해야 합니다.", requiresDeletionQueue: true },
        { status: 409 },
      ),
    };
  }
  return { session, photo };
}

export async function PATCH(request: Request, context: { params: Promise<{ sessionId: string; photoId: string }> }) {
  try {
    const { sessionId, photoId } = await context.params;
    const manageable = await requireManageablePhoto(sessionId, photoId);
    if ("response" in manageable) return manageable.response;
    const body = await request.json().catch(() => null) as { subjectStudentIds?: unknown } | null;
    const subjectStudentIds = normalizeSubjectStudentIds(body?.subjectStudentIds);
    if (subjectStudentIds.length === 0) {
      return NextResponse.json({ error: "사진에 나온 학생을 한 명 이상 선택해 주세요." }, { status: 400 });
    }
    const result = await prisma.$transaction(async (tx) => {
      const sessionRows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM "Session" WHERE id = $1 FOR UPDATE`, sessionId,
      );
      if (sessionRows[0]?.status !== "IN_PROGRESS") return "SESSION_CHANGED" as const;
      const draftRows = await tx.$queryRawUnsafe<SessionPhotoDraftRow[]>(
        `SELECT id, status, "mediaJSON", "subjectStudentIdsJSON", "galleryPostId", "instagramMediaId"
           FROM "SocialPostDraft" WHERE id = $1 AND "sessionId" = $2 FOR UPDATE`,
        manageable.photo.draftId,
        sessionId,
      );
      const lockedPhoto = findManagedSessionPhoto(draftRows, photoId);
      if (!lockedPhoto?.canManage || !isSinglePhotoDraft(parseStoredSessionPhotos(draftRows[0]?.mediaJSON).length)) {
        return "DRAFT_CHANGED" as const;
      }
      const eligible = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT DISTINCT st.id FROM "Student" st
          JOIN "Enrollment" e ON e."studentId" = st.id
         WHERE e."classId" = $1 AND e.status = 'ACTIVE' AND st.id = ANY($2::text[])
           AND ${notMergedStudent("st")}`,
        manageable.session.classId,
        subjectStudentIds,
      );
      if (eligible.length !== subjectStudentIds.length) return "INVALID_STUDENT" as const;
      await tx.$executeRawUnsafe(
        `UPDATE "SocialPostDraft" SET "subjectStudentIdsJSON" = $1, "updatedAt" = NOW() WHERE id = $2`,
        JSON.stringify(subjectStudentIds),
        manageable.photo.draftId,
      );
      return "UPDATED" as const;
    });
    if (result === "INVALID_STUDENT") return NextResponse.json({ error: "현재 수업의 재원 학생만 선택할 수 있습니다." }, { status: 400 });
    if (result !== "UPDATED") return NextResponse.json({ error: "사진 상태가 변경되어 다시 불러와야 합니다." }, { status: 409 });
    return NextResponse.json({ ok: true, subjectStudentIds });
  } catch (error) {
    const message = userFacingError(error, "사진의 학생 정보를 수정하지 못했습니다.");
    return NextResponse.json({ error: message }, { status: 403 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ sessionId: string; photoId: string }> }) {
  try {
    const { sessionId, photoId } = await context.params;
    const manageable = await requireManageablePhoto(sessionId, photoId);
    if ("response" in manageable) return manageable.response;

    if (!isValidPrivateSessionPhotoRef(manageable.photo as unknown as Record<string, unknown>, {
      classId: manageable.session.classId,
      sessionId,
    })) {
      return NextResponse.json({ error: "검증되지 않은 사진 저장 경로입니다." }, { status: 400 });
    }
    await ensureSessionPhotoDeletionQueue();

    await prisma.$transaction(async (tx) => {
      const sessionRows = await tx.$queryRawUnsafe<Array<{ status: string; photosJSON: string | null }>>(
        `SELECT status, "photosJSON" FROM "Session" WHERE id = $1 FOR UPDATE`,
        sessionId,
      );
      if (sessionRows[0]?.status !== "IN_PROGRESS") throw new Error("진행 중인 수업의 사진만 삭제할 수 있습니다.");
      const draftRows = await tx.$queryRawUnsafe<SessionPhotoDraftRow[]>(
        `SELECT id, status, "mediaJSON", "subjectStudentIdsJSON", "galleryPostId", "instagramMediaId"
           FROM "SocialPostDraft" WHERE id = $1 AND "sessionId" = $2 FOR UPDATE`,
        manageable.photo.draftId,
        sessionId,
      );
      const lockedPhoto = findManagedSessionPhoto(draftRows, photoId);
      if (!lockedPhoto?.canManage || !isSinglePhotoDraft(parseStoredSessionPhotos(draftRows[0]?.mediaJSON).length)) {
        throw new Error("사진 상태가 변경되어 삭제 대기열 확인이 필요합니다.");
      }
      if (!isValidPrivateSessionPhotoRef(lockedPhoto as unknown as Record<string, unknown>, {
        classId: manageable.session.classId,
        sessionId,
      })) throw new Error("검증되지 않은 사진 저장 경로입니다.");

      const nextPhotos = parseStoredSessionPhotos(sessionRows[0]?.photosJSON)
        .filter((photo) => photo.id !== photoId)
        .map((photo) => photo.url);
      // 구버전 수업 기록에는 URL 문자열만 있으므로 해당 URL도 함께 제거합니다.
      const rawPhotos = parseSessionPhotoEntries(sessionRows[0]?.photosJSON)
        .filter((entry) => typeof entry === "string" ? entry !== lockedPhoto.url : entry.id !== photoId)
        .map((entry) => typeof entry === "string" ? entry : entry.url);
      await tx.$executeRawUnsafe(
        `UPDATE "Session" SET "photosJSON" = $1, "updatedAt" = NOW() WHERE id = $2`,
        JSON.stringify(rawPhotos.length ? rawPhotos : nextPhotos),
        sessionId,
      );
      const nextMediaJSON = removePhotoFromMediaJSON(draftRows[0].mediaJSON, photoId);
      if (isEmptyMediaJSON(nextMediaJSON)) {
        await tx.$executeRawUnsafe(`DELETE FROM "SocialPostDraft" WHERE id = $1`, manageable.photo.draftId);
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE "SocialPostDraft" SET "mediaJSON" = $1, "updatedAt" = NOW() WHERE id = $2`,
          nextMediaJSON,
          manageable.photo.draftId,
        );
      }
      await enqueueSessionPhotoDeletion(tx, {
        photoId,
        storageBucket: lockedPhoto.storageBucket,
        storagePath: lockedPhoto.storagePath,
      });
    });
    // DB 참조 제거가 먼저 확정됩니다. 저장소 오류는 outbox에 남아 다음 요청에서 재시도됩니다.
    await processSessionPhotoDeletionQueue(3).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = userFacingError(error, "사진을 삭제하지 못했습니다.");
    return NextResponse.json({ error: message }, { status: error instanceof Error && error.message.includes("대기열") ? 409 : 403 });
  }
}
