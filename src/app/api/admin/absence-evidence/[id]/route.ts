import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { findEvidenceForAdmin } from "@/lib/regular/illness-evidence-access";
import { downloadEvidencePhoto, EVIDENCE_RESPONSE_HEADERS } from "@/lib/regular/illness-evidence-storage";

// 질병·부상 결석 증빙 사진 — 관리자(원장·부원장)만 연다(2026-11-14 원장 결정 a6).
// 비공개 버킷의 파일을 권한 확인 뒤 대신 내려 준다. 선생님·기사님 계정은 requireAdmin 에서 막힌다.
// 열 때마다 RegularAbsenceEvidenceView 에 한 줄 남긴다(건강 정보 열람 추적).

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 403, headers: noStore });
  }
  try {
    const { id } = await context.params;
    const photo = await findEvidenceForAdmin(prisma, id);
    if (!photo) return NextResponse.json({ error: "사진을 찾을 수 없습니다." }, { status: 404, headers: noStore });
    const bytes = await downloadEvidencePhoto(photo.storagePath);
    if (!bytes) return NextResponse.json({ error: "사진을 불러오지 못했습니다." }, { status: 404, headers: noStore });
    // 열람 기록(보안 검수 2026-11-14) — 누가·어느 사진을·언제. 사유 글·파일 내용은 남기지 않는다.
    // 기록이 실패해도(표가 아직 없는 경우 포함) 열람은 막지 않는다.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RegularAbsenceEvidenceView" ("evidenceId", "viewerUserId") VALUES ($1, $2)`,
      photo.id, admin.appUserId,
    ).catch((error) => console.error("[api/admin/absence-evidence] 열람 기록 실패:", error instanceof Error ? error.name : ""));
    return new NextResponse(bytes, { status: 200, headers: EVIDENCE_RESPONSE_HEADERS });
  } catch (error) {
    // 건강 정보 — 오류 이름만 남긴다
    console.error("[api/admin/absence-evidence] GET failed:", error instanceof Error ? error.name : "");
    return NextResponse.json({ error: "사진을 불러오지 못했습니다." }, { status: 500, headers: noStore });
  }
}
