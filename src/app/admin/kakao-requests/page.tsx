import { requireAdmin } from "@/lib/auth-guard";
import KakaoRequestsClient from "./KakaoRequestsClient";
import { loadKakaoRequests } from "./kakaoRequestData";

export const dynamic = "force-dynamic";

export default async function KakaoRequestsPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>;
}) {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  const data = await loadKakaoRequests((await searchParams)?.status);
  // 카카오 접수함 DB 준비가 필요합니다.
  return <KakaoRequestsClient {...data} />;
}
