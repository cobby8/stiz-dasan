import { readProfilePhoto } from "./server";
import { isProfilePhotoOwnerId, type ProfilePhotoOwnerKind } from "./rules";

/**
 * 프로필 사진 조회 API 두 개(학생·사용자)가 같이 쓰는 응답 만들기.
 *
 * - 권한 없음·사진 없음·없는 id·오류는 **전부 같은 404** 다(그 사람·사진이 있는지 알려 주지 않는다).
 * - 통과하면 서버가 비공개 버킷에서 내려받아 그대로 전달한다(저장소 주소를 화면에 주지 않는다).
 * - 캐시는 그 사람 브라우저에만 10분(private — 권한이 사라진 뒤 오래 남지 않게). 사진을 바꾸면 주소의 ?v= 가 달라져 새로 받는다.
 */
function notFound(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

export async function serveProfilePhoto(
  request: Request,
  kind: ProfilePhotoOwnerKind,
  id: string,
  canView: (id: string) => Promise<boolean>,
): Promise<Response> {
  try {
    if (!isProfilePhotoOwnerId(id)) return notFound();
    if (!(await canView(id))) return notFound();
    // ?s=1 이면 작은 사진(128px)
    const small = new URL(request.url).searchParams.get("s") === "1";
    const body = await readProfilePhoto({ kind, id }, small);
    if (!body) return notFound();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return notFound();
  }
}
