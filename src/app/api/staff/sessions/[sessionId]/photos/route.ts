import { userFacingError } from "@/lib/user-facing-error";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffClassAccess } from "@/lib/staff-class-access";
import { ensureSocialPostDraftTable } from "@/lib/socialDrafts";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  ensurePrivateSessionPhotoBucket,
  parseSessionPhotoEntries,
  PRIVATE_SESSION_PHOTO_BUCKET,
  type StoredSessionPhoto,
} from "@/lib/sessionPhotoStorage";
import { createSessionPhotoDraftInTransaction, listManagedSessionPhotos, type SessionPhotoDraftRow } from "@/lib/sessionPhotoManagement";
import {
  cancelSessionPhotoCleanup,
  ensureSessionPhotoDeletionQueue,
  processSessionPhotoDeletionQueue,
  releaseSessionPhotoCleanup,
  reserveSessionPhotoCleanup,
} from "@/lib/sessionPhotoDeletionQueue";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 1024 * 1024;
const MAX_SUBJECTS = 100;

function parseSubjectStudentIds(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(
      parsed
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean),
    )].slice(0, MAX_SUBJECTS);
  } catch {
    return [];
  }
}

export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    await processSessionPhotoDeletionQueue(3).catch(() => undefined);
    const { sessionId } = await context.params;
    const sessions = await prisma.$queryRawUnsafe<Array<{ classId: string; status: string }>>(
      `SELECT "classId", status FROM "Session" WHERE id = $1 LIMIT 1`,
      sessionId,
    );
    const session = sessions[0];
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    await requireStaffClassAccess(session.classId);
    if (session.status !== "IN_PROGRESS") {
      return NextResponse.json({ error: "진행 중인 수업의 사진만 관리할 수 있습니다." }, { status: 409 });
    }
    const drafts = await prisma.$queryRawUnsafe<SessionPhotoDraftRow[]>(
      `SELECT id, status, "mediaJSON", "subjectStudentIdsJSON", "galleryPostId", "instagramMediaId"
         FROM "SocialPostDraft"
        WHERE "sessionId" = $1 AND source = 'SESSION_PHOTO'
        ORDER BY "createdAt" ASC`,
      sessionId,
    );
    return NextResponse.json({ photos: listManagedSessionPhotos(drafts) });
  } catch (error) {
    const message = userFacingError(error, "사진 목록을 불러오지 못했습니다.");
    return NextResponse.json({ error: message }, { status: 403 });
  }
}

export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const sessions = await prisma.$queryRawUnsafe<Array<{ id: string; classId: string; status: string; photosJSON: string | null }>>(
      `SELECT id, "classId", status, "photosJSON" FROM "Session" WHERE id = $1 LIMIT 1`, sessionId,
    );
    const session = sessions[0];
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    const access = await requireStaffClassAccess(session.classId);
    if (session.status !== "IN_PROGRESS") {
      return NextResponse.json({ error: "진행 중인 수업에만 사진을 등록할 수 있습니다." }, { status: 409 });
    }

    await ensureSocialPostDraftTable();
    await ensureSessionPhotoDeletionQueue();
    const form = await req.formData();
    const file = form.get("file");
    const subjectStudentIds = parseSubjectStudentIds(form.get("subjectStudentIds"));
    if (!(file instanceof File)) return NextResponse.json({ error: "사진을 선택해 주세요." }, { status: 400 });
    if (subjectStudentIds.length === 0) {
      return NextResponse.json({ error: "사진에 나온 학생을 한 명 이상 선택해 주세요." }, { status: 400 });
    }

    const eligibleSubjects = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT DISTINCT st.id
       FROM "Student" st
       JOIN "Enrollment" e ON e."studentId" = st.id
       WHERE e."classId" = $1 AND e.status = 'ACTIVE' AND st.id = ANY($2::text[])
         AND ${notMergedStudent("st")}`,
      session.classId,
      subjectStudentIds,
    );
    if (eligibleSubjects.length !== subjectStudentIds.length) {
      return NextResponse.json({ error: "현재 수업 학생만 사진 대상으로 선택할 수 있습니다." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type) || file.type === "image/gif") {
      return NextResponse.json({ error: "수업 사진은 JPEG, PNG, WebP만 사용할 수 있습니다." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "압축된 사진은 1MB 이하여야 합니다." }, { status: 400 });

    // API 직접 호출도 GPS/기기 EXIF를 남기지 못하도록 서버에서 다시 인코딩합니다.
    const encoded = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    if (encoded.byteLength > MAX_BYTES) return NextResponse.json({ error: "사진 압축 결과가 1MB를 초과했습니다." }, { status: 400 });
    const ext = "jpg";
    const photoId = randomUUID();
    const storagePath = `staff-sessions/${session.classId}/${sessionId}/${photoId}.${ext}`;
    const supabase = createAdminClient();
    const bucket = PRIVATE_SESSION_PHOTO_BUCKET;
    await ensurePrivateSessionPhotoBucket();
    // 파일 생성보다 먼저 cleanup 예약을 영구 기록합니다.
    await reserveSessionPhotoCleanup({ photoId, storageBucket: bucket, storagePath });
    const { error: uploadError } = await supabase.storage.from(bucket).upload(
      storagePath, encoded,
      { contentType: "image/jpeg", cacheControl: "31536000", upsert: false },
    );
    if (uploadError) throw new Error("사진 저장소 업로드에 실패했습니다.");
    const url = `/api/staff/sessions/${sessionId}/photos/${photoId}`;
    const storedPhoto: StoredSessionPhoto = {
      id: photoId,
      type: "image",
      url,
      storageBucket: bucket,
      storagePath,
      visibility: "PRIVATE",
    };

    try {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRawUnsafe<Array<{ classId: string; status: string; photosJSON: string | null }>>(
          `SELECT "classId", status, "photosJSON" FROM "Session" WHERE id = $1 FOR UPDATE`, sessionId,
        );
        if (locked[0]?.status !== "IN_PROGRESS" || locked[0]?.classId !== session.classId) {
          throw new Error("진행 중인 수업의 사진만 등록할 수 있습니다.");
        }
        const lockedEligibleSubjects = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT DISTINCT st.id FROM "Student" st
             JOIN "Enrollment" e ON e."studentId" = st.id
            WHERE e."classId" = $1 AND e.status = 'ACTIVE' AND st.id = ANY($2::text[])
              AND ${notMergedStudent("st")}`,
          session.classId,
          subjectStudentIds,
        );
        if (lockedEligibleSubjects.length !== subjectStudentIds.length) {
          throw new Error("현재 수업의 재원 학생만 사진 대상으로 선택할 수 있습니다.");
        }
        const photos = parseSessionPhotoEntries(locked[0]?.photosJSON);
        if (!photos.some((photo) => photo === url)) photos.push(url);
        await tx.$executeRawUnsafe(
          `UPDATE "Session" SET "photosJSON" = $1, "updatedAt" = NOW() WHERE id = $2`,
          JSON.stringify(photos), sessionId,
        );
        await createSessionPhotoDraftInTransaction(tx, {
          authorUserId: access.staff.appUserId,
          authorName: access.staff.appUserName,
          authorRole: access.staff.appUserRole,
          sessionId,
          classId: session.classId,
          subjectStudentIds,
          photo: storedPhoto,
        });
        await cancelSessionPhotoCleanup(tx, photoId);
      });
    } catch (error) {
      // 외부 저장소와 DB는 한 번에 묶을 수 없으므로 실패 시 방금 URL을 되돌립니다.
      await releaseSessionPhotoCleanup(photoId).catch(() => undefined);
      // 예약은 DB에 남아 있으며 삭제 실패도 lastError와 다음 재시도 시각으로 기록됩니다.
      await processSessionPhotoDeletionQueue(3).catch(() => undefined);
      throw error;
    }

    return NextResponse.json({ url, type: "image", reviewStatus: "READY" });
  } catch (error) {
    const message = userFacingError(error, "사진 등록에 실패했습니다.");
    return NextResponse.json({ error: message }, { status: error instanceof Error && error.message.includes("권한") ? 403 : 500 });
  }
}
