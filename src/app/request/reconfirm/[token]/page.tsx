import { confirmKakaoParentReconfirmation, getKakaoParentReconfirmationPreview } from "@/app/actions/kakao-parent-reconfirmation";
import KakaoParentReconfirmationClient, { type KakaoReconfirmationPreview } from "./KakaoParentReconfirmationClient";

export const dynamic = "force-dynamic";

export default async function KakaoParentReconfirmationPage({ params }: { params:Promise<{ token:string }> }) {
  const { token } = await params;
  const result = await getKakaoParentReconfirmationPreview(token);
  const preview: KakaoReconfirmationPreview = result.status === "ACTIVE"
    ? { ...result, expiresAt:new Date(result.expiresAt).toISOString() }
    : result;

  async function confirm() {
    "use server";
    return confirmKakaoParentReconfirmation(token);
  }

  return <KakaoParentReconfirmationClient preview={preview} confirm={confirm} />;
}
