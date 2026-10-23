import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { getSavedDispatchRoute, saveDispatchRoute, deleteDispatchRoute } from "@/lib/seasonal/dispatchRoute";
import { getSettings } from "@/lib/seasonal/shuttle-optimize";

export const dynamic = "force-dynamic";

// 저장된 배차 노선 — GET(조회) / POST(저장·덮어쓰기). 저장은 라이브러리에서 requireAdmin을 강제한다.

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const date = url.searchParams.get("date");
    const direction = url.searchParams.get("direction") ?? "PICKUP";
    const saved = await getSavedDispatchRoute(date, direction, { strict: true, raw: url.searchParams.get("verify") === "1" });
    if (url.searchParams.get("verify") !== "1" && saved && saved.vehicles.length) {
      const { hub, hubDropoff } = await getSettings();
      const effectiveHub = direction === "DROPOFF" ? (hubDropoff ?? hub) : hub;
      if (effectiveHub?.name) {
        const hubName = effectiveHub.name;
        saved.vehicles = (saved.vehicles as Record<string, unknown>[]).map((v) => ({
          ...v,
          stops: (Array.isArray(v.stops) ? v.stops : []).map((s: Record<string, unknown>) =>
            s.isHub === true ? { ...s, label: hubName } : s,
          ),
        }));
      }
    }
    return NextResponse.json({ saved }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[dispatch/saved GET]", e);
    const message = e instanceof Error ? e.message : "";
    const status = message === "인증이 필요합니다. 로그인해주세요." ? 401
      : message === "관리자 권한이 필요합니다." ? 403 : 500;
    return NextResponse.json({ error: status === 401 ? "로그인해 주세요." : status === 403 ? "관리자만 이용할 수 있습니다." : "저장된 노선을 불러오지 못했습니다." }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      date?: string; direction?: string; vehicles?: unknown[]; expectedSavedAt?: string | null; classStart?: string | null; classEnd?: string | null;
    } | null;
    if (!body?.date || !body.direction || !Array.isArray(body.vehicles)) {
      return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
    }
    if (body.expectedSavedAt !== undefined && body.expectedSavedAt !== null && (typeof body.expectedSavedAt !== "string" || !Number.isFinite(Date.parse(body.expectedSavedAt)))) {
      return NextResponse.json({ error: "저장 상태를 다시 불러와 주세요." }, { status: 400 });
    }
    const { savedAt } = await saveDispatchRoute({
      date: body.date, direction: body.direction, vehicles: body.vehicles,
      classStart: body.classStart ?? null, classEnd: body.classEnd ?? null,
      expectedSavedAt: body.expectedSavedAt,
    });
    return NextResponse.json({ ok: true, savedAt });
  } catch (e) {
    console.error("[dispatch/saved POST]", e);
    const msg = String((e as { message?: string })?.message ?? "");
    const status = /원장|권한|로그인|인증|Unauthorized|Forbidden/i.test(msg) ? 403 : msg.startsWith("다른 창에서") ? 409 : 500;
    return NextResponse.json({ error: status === 403 || status === 409 ? msg : "노선을 저장하지 못했습니다." }, { status });
  }
}

// 저장 노선 삭제 — 그 날짜·방향의 저장본을 지운다. 이후엔 자동 제안이 기준이 된다.
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date");
    const direction = url.searchParams.get("direction") ?? "PICKUP";
    if (!date) return NextResponse.json({ error: "날짜가 필요합니다." }, { status: 400 });
    const { deleted } = await deleteDispatchRoute(date, direction, url.searchParams.has("expectedSavedAt") ? url.searchParams.get("expectedSavedAt") : undefined);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    console.error("[dispatch/saved DELETE]", e);
    const msg = String((e as { message?: string })?.message ?? "");
    const status = /원장|권한|로그인|인증|Unauthorized|Forbidden/i.test(msg) ? 403 : msg.startsWith("다른 창에서") ? 409 : 500;
    return NextResponse.json({ error: status === 403 || status === 409 ? msg : "노선을 삭제하지 못했습니다." }, { status });
  }
}
