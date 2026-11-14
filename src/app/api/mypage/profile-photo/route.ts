import { NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { parentOwnsStudent } from "@/lib/profilePhoto/access";
import { ProfilePhotoUnreadableError, deleteProfilePhoto, saveProfilePhoto } from "@/lib/profilePhoto/server";
import { profilePhotoUploadProblem, profilePhotoUrl, type ProfilePhotoOwner } from "@/lib/profilePhoto/rules";

// 학부모가 프로필 사진을 올리고 지우는 API (2026-11-15).
//  POST   폼: target=student|me · studentId(아이 사진일 때) · file
//  DELETE 주소: ?target=student|me&studentId=…
// 권한: 휴대폰 인증을 마친 학부모만. 아이 사진은 «내 아이»일 때만(가족 연결 포함, 병합된 옛 학생 제외).
// 경로는 서버가 만든다 — 화면이 보낸 값 중 쓰는 것은 «누구 사진인지»뿐이고, 그것도 SQL 로 소유를 확인한다.
export const dynamic = "force-dynamic";

type Resolved = { owner: ProfilePhotoOwner } | { response: NextResponse };

/** 로그인·소유 확인 뒤 «누구 사진인지»를 정한다. 통과하지 못하면 돌려줄 응답을 준다 */
async function resolveOwner(target: unknown, studentId: unknown): Promise<Resolved> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { response: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };

  // 내 사진 — 주인은 항상 서버가 확인한 로그인 사용자(화면이 남의 id 를 보내도 쓰지 않는다)
  if (target === "me") return { owner: { kind: "user", id: parent.appUserId } };

  if (target === "student") {
    // 남의 아이·병합된 옛 학생·없는 id 는 전부 같은 404(있는지 없는지 알려 주지 않는다)
    if (typeof studentId !== "string" || !(await parentOwnsStudent(parent.appUserId, studentId))) {
      return { response: NextResponse.json({ error: "학생을 찾을 수 없습니다." }, { status: 404 }) };
    }
    return { owner: { kind: "student", id: studentId } };
  }
  return { response: NextResponse.json({ error: "요청을 다시 확인해 주세요." }, { status: 400 }) };
}

export async function POST(request: Request) {
  try {
    const form = await request.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "요청을 다시 확인해 주세요." }, { status: 400 });

    const resolved = await resolveOwner(form.get("target"), form.get("studentId"));
    if ("response" in resolved) return resolved.response;

    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "사진을 선택해 주세요." }, { status: 400 });
    // 1차 검사(적어 보낸 형식·크기) — 진짜 형식은 아래 saveProfilePhoto 안에서 sharp 가 읽어 판정한다
    const problem = profilePhotoUploadProblem({ type: file.type, size: file.size });
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const { version } = await saveProfilePhoto(resolved.owner, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ ok: true, version, url: profilePhotoUrl(resolved.owner, version) });
  } catch (error) {
    if (error instanceof ProfilePhotoUnreadableError) {
      return NextResponse.json({ error: "사진 파일을 읽지 못했어요. 다른 사진을 골라 주세요." }, { status: 400 });
    }
    // 내부 오류 원문(SQL·저장소 응답)은 화면으로 내보내지 않는다
    console.error("[profile-photo] 올리기 실패", error instanceof Error ? error.name : "");
    return NextResponse.json({ error: "사진을 올리지 못했어요. 잠시 뒤 다시 시도해 주세요." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveOwner(params.get("target"), params.get("studentId"));
    if ("response" in resolved) return resolved.response;

    await deleteProfilePhoto(resolved.owner);
    return NextResponse.json({ ok: true, version: null });
  } catch (error) {
    console.error("[profile-photo] 지우기 실패", error instanceof Error ? error.name : "");
    return NextResponse.json({ error: "사진을 지우지 못했어요. 잠시 뒤 다시 시도해 주세요." }, { status: 500 });
  }
}
