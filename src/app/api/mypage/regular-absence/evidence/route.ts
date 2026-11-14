import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { canEditEvidence, EVIDENCE_BUCKET, evidenceStoragePath } from "@/lib/regular/illnessCarryRules";
import { evidenceAddRefusal, findEvidenceForParent, findEvidenceTargetForParent } from "@/lib/regular/illness-evidence-access";
import {
  downloadEvidencePhoto,
  encodeEvidencePhoto,
  ensureEvidenceBucket,
  EVIDENCE_ALLOWED_TYPES,
  EVIDENCE_FORMAT_REJECTED,
  EVIDENCE_MAX_INPUT_BYTES,
  EVIDENCE_MAX_STORED_BYTES,
  EVIDENCE_RESPONSE_HEADERS,
  removeEvidencePhoto,
  uploadEvidencePhoto,
} from "@/lib/regular/illness-evidence-storage";

// 질병·부상 결석 증빙 사진(학부모) — 올리기·내가 올린 사진 열기·지우기(2026-11-14 원장 결정 a1·a6).
//
// · 비공개 버킷에만 저장한다. 사진은 이 API 가 권한을 확인한 뒤 대신 내려 준다(공개 주소 없음).
// · 서버에서 JPEG 로 다시 인코딩해 위치·기기 정보(EXIF)를 지운다.
// · 건강 정보라 오류 로그에는 오류 이름만 남긴다(파일 이름·사유 글 금지).

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

async function parentOrNull() {
  try { return await requireVerifiedParent(); } catch { return null; }
}

// 내가 올린 사진 한 장 열기(?id=)
export async function GET(request: NextRequest) {
  const parent = await parentOrNull();
  if (!parent) return json({ error: "로그인이 필요합니다." }, 401);
  const id = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return json({ error: "사진을 찾을 수 없습니다." }, 404);
  try {
    const photo = await findEvidenceForParent(prisma, await childAccessSql("s", "$1"), parent.appUserId, id);
    // 남의 사진·없는 사진은 똑같이 «없음» — 있는지조차 알려 주지 않는다
    if (!photo) return json({ error: "사진을 찾을 수 없습니다." }, 404);
    const bytes = await downloadEvidencePhoto(photo.storagePath);
    if (!bytes) return json({ error: "사진을 불러오지 못했습니다." }, 404);
    return new NextResponse(bytes, { status: 200, headers: EVIDENCE_RESPONSE_HEADERS });
  } catch (error) {
    console.error("[api/mypage/regular-absence/evidence] GET failed:", error instanceof Error ? error.name : "");
    return json({ error: "사진을 불러오지 못했습니다." }, 500);
  }
}

// 사진 한 장 올리기(multipart: absenceId, file)
export async function POST(request: NextRequest) {
  const parent = await parentOrNull();
  if (!parent) return json({ error: "로그인이 필요합니다." }, 401);
  try {
    const form = await request.formData();
    const absenceId = String(form.get("absenceId") ?? "").trim();
    const file = form.get("file");
    if (!absenceId) return json({ error: "결석을 찾을 수 없습니다." }, 404);
    if (!(file instanceof File)) return json({ error: "사진을 선택해 주세요." }, 400);
    if (!EVIDENCE_ALLOWED_TYPES.has(file.type)) return json({ error: "사진은 JPG, PNG, WebP 만 올릴 수 있어요." }, 400);
    if (file.size > EVIDENCE_MAX_INPUT_BYTES) return json({ error: "사진이 너무 커요. 다시 찍거나 다른 사진을 골라 주세요." }, 400);

    // 권한·기간·장수 — 내 아이의 검토 중인 질병·부상 결석인지 서버가 다시 본다(화면 값 불신)
    const access = await childAccessSql("s", "$1");
    const target = await findEvidenceTargetForParent(prisma, access, parent.appUserId, absenceId);
    if (!target) return json({ error: "사진을 올릴 수 있는 결석이 아니에요." }, 404);
    const refusal = evidenceAddRefusal(target);
    if (refusal) return json({ error: refusal }, 409);

    let encoded: Buffer;
    try {
      encoded = await encodeEvidencePhoto(Buffer.from(await file.arrayBuffer()));
    } catch (error) {
      // 실제 형식이 JPG·PNG·WebP 가 아니거나(형식 이름만 속인 파일) 깨진 사진 — 저장하지 않는다
      const badFormat = error instanceof Error && error.message === EVIDENCE_FORMAT_REJECTED;
      return json({ error: badFormat ? "사진은 JPG, PNG, WebP 만 올릴 수 있어요." : "사진을 읽지 못했어요. 다른 사진으로 다시 올려 주세요." }, 400);
    }
    if (encoded.byteLength > EVIDENCE_MAX_STORED_BYTES) return json({ error: "사진이 너무 커요. 다시 찍거나 다른 사진을 골라 주세요." }, 400);

    await ensureEvidenceBucket();
    const photoId = randomUUID();
    const storagePath = evidenceStoragePath(absenceId, photoId);
    // 파일보다 «먼저» 행을 만든다(화면에서 뺀 상태 removedAt 으로) — 올리다 멈춰도 cron 이 파일을 치울 수 있게
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RegularAbsenceEvidence" (id, "absenceId", "storageBucket", "storagePath", "sizeBytes", "uploadedByUserId", "removedAt")
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      photoId, absenceId, EVIDENCE_BUCKET, storagePath, encoded.byteLength, parent.appUserId,
    );
    await uploadEvidencePhoto(storagePath, encoded);

    // 확정 — 검토 줄을 잠그고 기간·장수를 한 번 더 본 뒤 «살아 있는 사진»으로 바꾼다(동시에 4장이 올라가는 일 방지)
    const confirmed = await prisma.$transaction(async (tx) => {
      const locked = await findEvidenceTargetForParent(tx, access, parent.appUserId, absenceId, true);
      if (!locked || evidenceAddRefusal(locked)) return false;
      const n = await tx.$executeRawUnsafe(
        `UPDATE "RegularAbsenceEvidence" SET "removedAt" = NULL WHERE id = $1 AND "purgedAt" IS NULL`, photoId,
      );
      return Number(n) === 1;
    });
    if (!confirmed) {
      // 그 사이 기간이 끝났거나 3장이 찼다 — 방금 올린 파일을 바로 치운다(실패해도 cron 이 치운다)
      if (await removeEvidencePhoto(EVIDENCE_BUCKET, storagePath)) {
        await prisma.$executeRawUnsafe(`UPDATE "RegularAbsenceEvidence" SET "purgedAt" = now() WHERE id = $1`, photoId).catch(() => undefined);
      }
      return json({ error: "사진을 올릴 수 없는 상태예요. 화면을 새로 열어 다시 확인해 주세요." }, 409);
    }
    return json({ ok: true, id: photoId });
  } catch (error) {
    console.error("[api/mypage/regular-absence/evidence] POST failed:", error instanceof Error ? error.name : "");
    return json({ error: "사진을 올리지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}

// 내가 올린 사진 한 장 지우기(?id=) — 검토 중이고 7일 안일 때만
export async function DELETE(request: NextRequest) {
  const parent = await parentOrNull();
  if (!parent) return json({ error: "로그인이 필요합니다." }, 401);
  const id = request.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return json({ error: "사진을 찾을 수 없습니다." }, 404);
  try {
    const photo = await findEvidenceForParent(prisma, await childAccessSql("s", "$1"), parent.appUserId, id);
    if (!photo) return json({ error: "사진을 찾을 수 없습니다." }, 404);
    if (!canEditEvidence(photo)) return json({ error: "지금은 사진을 지울 수 없어요." }, 409);
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "RegularAbsenceEvidence" SET "removedAt" = now() WHERE id = $1 AND "uploadedByUserId" = $2 AND "removedAt" IS NULL`,
      id, parent.appUserId,
    );
    if (Number(n) === 1 && await removeEvidencePhoto(photo.storageBucket, photo.storagePath)) {
      await prisma.$executeRawUnsafe(`UPDATE "RegularAbsenceEvidence" SET "purgedAt" = now() WHERE id = $1`, id).catch(() => undefined);
    }
    return json({ ok: true });
  } catch (error) {
    console.error("[api/mypage/regular-absence/evidence] DELETE failed:", error instanceof Error ? error.name : "");
    return json({ error: "사진을 지우지 못했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }
}
