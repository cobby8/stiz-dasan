import KakaoRequestsClient from "./KakaoRequestsClient";
import { loadKakaoRequests } from "./kakaoRequestData";

export const dynamic = "force-dynamic";

export default async function KakaoRequestsPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>;
}) {
  const data = await loadKakaoRequests((await searchParams)?.status);
  // 카카오 접수함 DB 준비가 필요합니다.
  return <KakaoRequestsClient {...data} />;
}
