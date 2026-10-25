import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getMyRoleRequests } from "@/app/actions/role-requests";
import { isGrantableRole } from "@/lib/account/roles";
import RolesClient from "./RolesClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "역할 추가 신청 | 스티즈 농구교실",
};

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string | string[] }>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  const params = await searchParams;
  const raw = Array.isArray(params.request) ? params.request[0] : params.request;
  // 가입 첫 화면에서 고르고 온 역할 — 미리 체크만 해 두고, 신청은 여기서 학부모가 직접 누른다.
  // 주소창 값이라 아는 역할만 받는다.
  const preselected = String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(isGrantableRole);

  const roles = await getMyRoleRequests();
  return <RolesClient initial={roles} preselected={preselected} />;
}
