import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { ChildConnectionError, childIdentityHash, type ChildActor } from "@/lib/account/child-links";
import { confirmPhoneChange, phoneChangeAvailable, startPhoneChange } from "@/lib/account/phone-change";
import { looksLikeLegalName } from "@/lib/account/phone-change-rules";
import { notifyAdmins } from "@/lib/notification";

// 보호자 «연락처 바꾸기» API (2026-11-14 원장 결정 b6) — 자녀 연결 API(/api/account/child-links)와 같은 틀.
//  POST {action:"start"}                       → 1회용 인증 건 번호 + 이 기기 쿠키
//  POST {action:"confirm", identityVerificationId} → 포트원 재조회 후 통과하면 계정 번호 변경
// 새 번호를 화면에서 받는 칸은 없다 — 인증 없이 번호를 바꾸는 길을 만들지 않는다.

export const dynamic = "force-dynamic";
const COOKIE = "stiz-phone-device";

async function actor(): Promise<ChildActor & { name: string }> {
  // 학부모 설정 화면과 같은 문(門) — 서버가 확인한 로그인 보호자 본인만. 누구의 번호를 바꿀지는 화면이 정하지 않는다
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) throw new ChildConnectionError("로그인이 필요합니다.", 401);
  return { id: parent.appUserId, authUserId: parent.id, name: parent.appUserName };
}
// 자녀 연결 기기 해시(child-device:)와 종류를 달리해 두 흐름의 인증 건이 서로 통하지 않게 한다
function deviceHash(user: ChildActor, token: string) { return childIdentityHash(`phone-device:${user.authUserId}:${token}`); }
function response(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
function failure(error: unknown) {
  if (error instanceof ChildConnectionError) return response({ error: error.message }, error.status);
  // 내부 오류·명의 정보·번호는 화면이나 로그로 전달하지 않는다
  return response({ error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 503);
}

export async function GET() {
  try {
    const current = await actor();
    // nameOk=false 면 화면이 인증 «전에» «본인인증 이름과 같아야 해요»를 미리 알린다(예: «민준맘»)
    return response({ enabled: await phoneChangeAvailable(), nameOk: looksLikeLegalName(current.name) });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== request.nextUrl.origin) throw new ChildConnectionError("요청 출처를 확인하지 못했습니다.", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ChildConnectionError("요청 형식을 확인해 주세요.");
    const text = await request.text();
    if (text.length > 1024) throw new ChildConnectionError("요청 내용이 너무 깁니다.", 413);
    let body;
    try { body = JSON.parse(text); } catch { throw new ChildConnectionError("요청 형식을 확인해 주세요."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChildConnectionError("요청 형식을 확인해 주세요.");
    const current = await actor();
    if (body.action === "start") {
      const token = randomBytes(32).toString("base64url");
      const result = await startPhoneChange(current, deviceHash(current, token));
      const res = response(result);
      res.cookies.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/account/phone-change", maxAge: 900 });
      return res;
    }
    if (body.action === "confirm" && typeof body.identityVerificationId === "string" && body.identityVerificationId.length < 100) {
      const token = request.cookies.get(COOKIE)?.value || "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ChildConnectionError("본인인증을 다시 진행해 주세요.");
      const result = await confirmPhoneChange(current, deviceHash(current, token), body.identityVerificationId);
      // 설정·아이 기록·방학특강 화면이 새 번호를 바로 읽게 한다
      revalidatePath("/mypage", "layout");
      // 관리자에게 «앱 안 알림» 1건(문자 없음) — 학원이 모르는 사이에 연락처가 바뀌지 않게. 번호는 끝 4자리만
      if (result.notify) {
        await notifyAdmins(
          "PARENT_PHONE_CHANGED",
          "보호자 연락처 변경",
          `${result.notify.accountName} 보호자 연락처 변경 · 끝 ${result.notify.newLast4}`,
          result.notify.studentId ? `/admin/students/${result.notify.studentId}` : "/admin/students",
          { notifyCoaches: false },
        ).catch(() => undefined);
      }
      // 화면에는 결과만(알림용 자료는 싣지 않는다)
      const res = response({ ok: true, changed: result.changed });
      res.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/account/phone-change", maxAge: 0 });
      return res;
    }
    throw new ChildConnectionError("요청 방법을 확인해 주세요.");
  } catch (error) { return failure(error); }
}
