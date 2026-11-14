import { canViewStudentPhoto } from "@/lib/profilePhoto/access";
import { serveProfilePhoto } from "@/lib/profilePhoto/serve";

// 아이 프로필 사진 보기 — GET ?s=1(작은 것) &v=(캐시 버전)
// 볼 수 있는 사람: 그 아이의 보호자 · 그 아이를 맡은 선생님 · 관리자. 그 밖은 404.
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return serveProfilePhoto(request, "student", id, canViewStudentPhoto);
}
