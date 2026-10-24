import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { createRegularLocationLink, listRegularLocationLinks, RegularLocationLinkError, revokeRegularLocationLink } from "@/lib/shuttle/regularLocationLink";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof RegularLocationLinkError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  const message = error instanceof Error ? error.message : "좌표 요청 링크를 처리하지 못했습니다.";
  const status = /권한|로그인|인증|Unauthorized|Forbidden/i.test(message) ? 403 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const studentId = new URL(request.url).searchParams.get("studentId")?.trim() || undefined;
    return NextResponse.json({ links: await listRegularLocationLinks(studentId) });
  } catch (error) { return errorResponse(error); }
}

/** 관리자만 학생·보호자가 고정된 좌표 요청 링크를 만들 수 있다. */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await request.json().catch(() => null) as { studentId?: unknown; expiresInDays?: unknown } | null;
    const studentId = typeof body?.studentId === "string" ? body.studentId.trim() : "";
    const expiresInDays = body?.expiresInDays == null ? 7 : Number(body.expiresInDays);
    const link = await createRegularLocationLink(studentId, admin.appUserId, expiresInDays);
    return NextResponse.json({ ok: true, ...link, path: `/shuttle/location/${link.token}` }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json().catch(() => null) as { linkId?: unknown } | null;
    const linkId = typeof body?.linkId === "string" ? body.linkId.trim() : "";
    if (!linkId) throw new RegularLocationLinkError("취소할 링크를 선택해 주세요.", 400, "LINK_REQUIRED");
    await revokeRegularLocationLink(linkId);
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
