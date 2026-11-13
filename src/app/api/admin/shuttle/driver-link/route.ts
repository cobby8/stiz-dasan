import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { isDriverRunLinkEnabled, rotateDriverRunLinks, setDriverRunLinkEnabled } from "@/lib/shuttle/driverLinkAccess";

export const dynamic = "force-dynamic";

// 기사님 운행 링크(문자 주소) 관리 — 원장 전용.
// GET   → { enabled }                    지금 스위치 상태
// PATCH { enabled: boolean }             스위치 켜기/끄기
// POST  { action: "rotate" }             링크 새로 만들기(이전 주소 즉시 무효)
// ⚠️ 토큰 값은 응답·로그 어디에도 담지 않는다(새 주소는 기존 «링크 복사» 버튼으로 받는다).

const NO_STORE = { "Cache-Control": "no-store" };

// 인증 실패는 403, 그 밖은 500(내부 오류 원문은 숨긴다).
function fail(error: unknown, where: string) {
  const msg = String((error as { message?: string })?.message ?? "");
  const forbidden = /원장|권한|로그인|인증|Unauthorized|Forbidden/i.test(msg);
  if (!forbidden) console.error(`[driver-link ${where}] 처리 실패`);
  return NextResponse.json(
    { error: forbidden ? "관리자 권한이 필요합니다." : "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요." },
    { status: forbidden ? 403 : 500, headers: NO_STORE },
  );
}

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ enabled: await isDriverRunLinkEnabled() }, { headers: NO_STORE });
  } catch (error) { return fail(error, "GET"); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json().catch(() => null) as { enabled?: unknown } | null;
    // 참/거짓만 받는다 — 문자열 "false" 같은 값이 켜짐으로 해석되는 사고를 막는다.
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, ...(await setDriverRunLinkEnabled(body.enabled)) }, { headers: NO_STORE });
  } catch (error) { return fail(error, "PATCH"); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json().catch(() => null) as { action?: unknown } | null;
    if (body?.action !== "rotate") {
      return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, ...(await rotateDriverRunLinks()) }, { headers: NO_STORE });
  } catch (error) { return fail(error, "POST"); }
}
