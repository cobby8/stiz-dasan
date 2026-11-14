import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { findEvidenceForAdmin } from "@/lib/regular/illness-evidence-access";
import { downloadEvidencePhoto, EVIDENCE_RESPONSE_HEADERS } from "@/lib/regular/illness-evidence-storage";

// 질병·부상 결석 증빙 사진 — 관리자(원장·부원장)만 연다(2026-11-14 원장 결정 a6).
// 비공개 버킷의 파일을 권한 확인 뒤 대신 내려 준다. 선생님·기사님 계정은 requireAdmin 에서 막힌다.

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 403, headers: noStore });
  }
  try {
    const { id } = await context.params;
    const photo = await findEvidenceForAdmin(prisma, id);
    if (!photo) return NextResponse.json({ error: "사진을 찾을 수 없습니다." }, { status: 404, headers: noStore });
    const bytes = await downloadEvidencePhoto(photo.storagePath);
    if (!bytes) return NextResponse.json({ error: "사진을 불러오지 못했습니다." }, { status: 404, headers: noStore });
    return new NextResponse(bytes, { status: 200, headers: EVIDENCE_RESPONSE_HEADERS });
  } catch (error) {
    // 건강 정보 — 오류 이름만 남긴다
    console.error("[api/admin/absence-evidence] GET failed:", error instanceof Error ? error.name : "");
    return NextResponse.json({ error: "사진을 불러오지 못했습니다." }, { status: 500, headers: noStore });
  }
}
