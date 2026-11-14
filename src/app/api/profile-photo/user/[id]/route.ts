import { canViewUserPhoto } from "@/lib/profilePhoto/access";
import { serveProfilePhoto } from "@/lib/profilePhoto/serve";

// 학부모(사용자) 프로필 사진 보기 — GET ?s=1(작은 것) &v=(캐시 버전)
// 볼 수 있는 사람: 본인 · 관리자 · 그 학부모의 아이를 맡은 선생님. 그 밖은 404.
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return serveProfilePhoto(request, "user", id, canViewUserPhoto);
}
