import type { Metadata } from "next";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getUsableAcademyPhone } from "@/lib/academyPhone";
import ChildConnectionsClient from "./ChildConnectionsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "자녀·가족 연결 | 스티즈 농구교실" };

export default async function ChildConnectionsPage() {
  await requireVerifiedParent();
  // 학원 번호(설정값) — «학원에 전화하기»용. 못 읽으면 null(글자만 보인다)
  return <ChildConnectionsClient academyPhone={await getUsableAcademyPhone()} />;
}
