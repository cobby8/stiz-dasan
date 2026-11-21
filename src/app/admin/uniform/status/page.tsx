import { adminErrorText } from "@/components/admin/adminDisplayText";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { isFreeUniformOrderMemo } from "@/lib/uniform-free-grant-rules";
import type { UniformBoardItem } from "@/lib/uniform/arrivalRules";
import { loadUniformBoard } from "@/lib/uniform/arrivalService";
import UniformStatusClient from "./UniformStatusClient";

export const dynamic = "force-dynamic";

/** 화면으로 보내는 한 줄 — 주문 메모(학부모가 쓴 글)·전화번호는 보내지 않는다. 무료 증정 여부만 */
export type UniformStatusView = Omit<UniformBoardItem, "customerMemo" | "orderStatus" | "hasOrderNumber" | "studentId"> & {
  isFree: boolean;
  linked: boolean;
};

function toView(item: UniformBoardItem): UniformStatusView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { customerMemo, orderStatus, hasOrderNumber, studentId, ...rest } = item;
  return { ...rest, isFree: item.source === "SITE" && isFreeUniformOrderMemo(customerMemo), linked: Boolean(studentId) };
}

export default async function UniformStatusPage() {
  await requireAdmin();
  let rows: UniformStatusView[] = [];
  let loadError = "";
  try {
    rows = (await loadUniformBoard(prisma)).map(toView);
  } catch (error) {
    loadError = adminErrorText(error, "유니폼 신청 현황을 불러오지 못했습니다.");
  }
  return <UniformStatusClient initialItems={rows} loadError={loadError} />;
}
