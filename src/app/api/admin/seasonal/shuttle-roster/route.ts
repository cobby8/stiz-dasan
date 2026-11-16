import { NextResponse } from "next/server";
import { getSeasonalShuttleRoster, updateShuttleRosterRow } from "@/lib/seasonal/shuttle-roster";
import {
  confirmSeasonalShuttleRoster,
  updateConfirmedShuttleRosterRow,
  removeConfirmedShuttleRosterRow,
  restoreConfirmedShuttleRosterRow,
  removedShuttleRosterRows,
  shuttleRosterConfirmationInfo,
  isShuttleRequestConfirmed,
  setConfirmedShuttleRideByRequestId,
  placeStudentAtFreeHub,
  type ConfirmedRosterPatch,
  type ConfirmedRosterPin,
} from "@/lib/seasonal/shuttleRoster";

export const dynamic = "force-dynamic";

// 방학특강 셔틀 통합 명단 API.
//   GET    목록 조회 + 확정 여부(배너용)
//   POST   확정 실행(원장 전용)
//   PATCH  인라인 편집 저장 / 확정본 행 제외·되돌리기
//   DELETE 확정본 행 제외(soft remove)
// 권한 검사(requireAdmin / 원장 검사)는 전부 라이브러리에서 강제한다.

// 사용자에게 그대로 보여줘도 되는(그리고 보여줘야 하는) 실패는 500 대신 이유와 함께 내린다.
// 화면이 "저장 실패"만 띄우면 원장은 무엇을 고쳐야 하는지 알 수 없다.
function knownFailure(e: unknown): { status: number; message: string } | null {
  const msg = String((e as { message?: string })?.message ?? "");
  if (/원장|권한|로그인|인증|Unauthorized|Forbidden/i.test(msg)) return { status: 403, message: msg };
  if (/좌표/.test(msg)) return { status: 400, message: msg };
  // 수강이 취소된 학생은 되돌릴 수 없다(게이트웨이가 거부) — 지금 상태와 맞지 않는 요청이라 409.
  if (/수강이 취소된/.test(msg)) return { status: 409, message: msg };
  return null;
}

export async function GET() {
  try {
    const roster = await getSeasonalShuttleRoster();
    const info = await shuttleRosterConfirmationInfo();
    // 확정 여부는 게이트웨이가 명단을 고를 때 쓴 것과 **같은 기준**(info.confirmed)으로 판정한다.
    // 행에서만 읽으면 전원 제외 상태에서 목록이 비어 "확정 전"으로 되돌아가 보인다.
    // 둘 중 하나라도 확정이라고 하면 확정으로 본다(어긋날 때 안전한 쪽).
    const confirmed = info.confirmed || roster.some((r) => r.origin === "CONFIRMED");
    // roster 키는 기존 형태 그대로 유지한다(화면이 이미 쓰고 있다).
    const base = { roster, confirmed, confirmedCount: info.count, confirmedAt: info.confirmedAt };
    // 확정 명단에서 뺀 학생 목록 — 새 키로만 덧붙인다(기존 키의 모양·값은 그대로).
    // 확정 모드가 꺼져 있거나 표가 없으면 빈 배열이다.
    const removed = await removedShuttleRosterRows();
    return NextResponse.json(
      { ...base, removed },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[shuttle-roster GET]", e);
    return NextResponse.json({ error: "명단을 불러오지 못했습니다." }, { status: 401 });
  }
}

// 확정하기 — 원장이 화면에서 버튼을 눌렀을 때만 실행된다(자동 호출 금지).
export async function POST() {
  try {
    const { inserted } = await confirmSeasonalShuttleRoster();
    return NextResponse.json({ ok: true, inserted });
  } catch (e) {
    console.error("[shuttle-roster POST]", e);
    const known = knownFailure(e);
    return NextResponse.json(
      { error: known?.message ?? "명단을 확정하지 못했습니다." },
      { status: known?.status ?? 500 },
    );
  }
}

// 지도 핀은 객체 모양만 여기서 확인하고, 좌표 유효성 판정은 게이트웨이 한 곳에서만 한다(기준이 갈리면 안 된다).
function pickPin(v: unknown): ConfirmedRosterPin | undefined {
  if (!v || typeof v !== "object") return undefined;
  return v as ConfirmedRosterPin;
}

// 확정본 수정에 허용하는 값만 골라 담는다. 화면이 다른 키를 보내도 조용히 무시한다.
function pickConfirmedPatch(patch: Record<string, unknown>): ConfirmedRosterPatch {
  const out: ConfirmedRosterPatch = {};
  if (patch.ride !== undefined) out.ride = patch.ride === true;
  if (patch.pickupLocation !== undefined) out.pickupLocation = patch.pickupLocation as string | null;
  if (patch.pickupTime !== undefined) out.pickupTime = patch.pickupTime as string | null;
  if (patch.dropoffLocation !== undefined) out.dropoffLocation = patch.dropoffLocation as string | null;
  if (patch.dropoffSameAsPickup !== undefined) out.dropoffSameAsPickup = patch.dropoffSameAsPickup === true;
  if (patch.note !== undefined) out.note = patch.note as string | null;
  // 확정 후에도 원장이 정밀 좌표를 직접 찍어야 노선 편성이 굴러간다. 핀은 확정본에만 쓴다.
  if (patch.pickupPin !== undefined) out.pickupPin = pickPin(patch.pickupPin);
  if (patch.dropoffPin !== undefined) out.dropoffPin = pickPin(patch.dropoffPin);
  return out;
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      rosterId?: string; requestId?: string; patch?: Record<string, unknown>;
      action?: string; reason?: string;
    } | null;

    // 무료 거점 직접 배치 — rosterId/requestId 어느 쪽이든 받는다. 서버가 거점 설정을 읽어 처리한다.
    if (body?.action === "placeAtHub") {
      await placeStudentAtFreeHub({ rosterId: body.rosterId ?? null, requestId: body.requestId ?? null });
      return NextResponse.json({ ok: true });
    }

    // ── 확정 후: 확정본 행만 손댄다. 원본 신청서(SpecialProgramShuttleRequest)는 절대 건드리지 않는다. ──
    if (body?.rosterId) {
      if (body.action === "remove") {
        await removeConfirmedShuttleRosterRow(body.rosterId, body.reason ?? null);
        return NextResponse.json({ ok: true });
      }
      if (body.action === "restore") {
        await restoreConfirmedShuttleRosterRow(body.rosterId);
        return NextResponse.json({ ok: true });
      }
      if (!body.patch) {
        return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
      }
      // 지도 핀도 여기로 들어온다. 좌표가 이상하면 게이트웨이가 던지고 400 + 이유로 내려간다.
      await updateConfirmedShuttleRosterRow(body.rosterId, pickConfirmedPatch(body.patch));
      return NextResponse.json({ ok: true });
    }

    // ── 확정 전: 기존 동작 그대로(원본 신청서 인라인 편집). ──
    if (!body?.requestId || !body.patch) {
      return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
    }
    // ★ 여기서 클라이언트 말을 믿으면 안 된다(R-5).
    //   확정 전에 열어 둔 탭은 rosterId를 모른 채 저장 요청을 보낸다. 그대로 통과시키면
    //   원본 신청서가 수정되고 화면엔 "저장됨"이 뜨지만 기사님 명단(확정본)은 그대로다.
    //   = 아이가 옛 주소에서 기다린다. 그래서 원본을 고치기 직전에 서버가 직접 확인한다.
    if (await isShuttleRequestConfirmed(body.requestId)) {
      // 확정본 학생: ride 토글(취소/복구)은 확정본 행을 직접 손대 처리한다.
      //   그 외 필드 수정은 확정 후엔 확정본 편집기(rosterId)로만 허용 → 409로 안내.
      if (body.patch.ride !== undefined) {
        await setConfirmedShuttleRideByRequestId(body.requestId, body.patch.ride === true);
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json(
        { error: "명단이 확정되었습니다. 새로고침 후 다시 시도해주세요.", confirmed: true },
        { status: 409 },
      );
    }
    await updateShuttleRosterRow(body.requestId, body.patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[shuttle-roster PATCH]", e);
    const known = knownFailure(e);
    return NextResponse.json({ error: known?.message ?? "저장하지 못했습니다." }, { status: known?.status ?? 500 });
  }
}

// 확정본에서 빼기(soft remove). 하드 DELETE가 아니라 removedAt 기록이다.
export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { rosterId?: string; reason?: string } | null;
    if (!body?.rosterId) {
      return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
    }
    await removeConfirmedShuttleRosterRow(body.rosterId, body.reason ?? null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[shuttle-roster DELETE]", e);
    const known = knownFailure(e);
    return NextResponse.json({ error: known?.message ?? "제외하지 못했습니다." }, { status: known?.status ?? 500 });
  }
}
