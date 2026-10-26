import type { Metadata } from "next";
import { requireVerifiedParent } from "@/lib/auth-guard";
import ChildConnectionsClient from "./ChildConnectionsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "자녀·가족 연결 | 스티즈 농구교실" };

export default async function ChildConnectionsPage() {
  await requireVerifiedParent();
  return <ChildConnectionsClient />;
}
