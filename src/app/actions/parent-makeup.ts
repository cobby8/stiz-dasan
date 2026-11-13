"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  getMakeupOptionsForCredit,
  bookMakeup,
  cancelMakeupBooking,
  type MakeupOption,
} from "@/lib/makeup/parent-makeup";
import type { MakeupEmptyReason } from "@/lib/makeup/credit-rules";

// 학부모 보강 예약 서버 액션.
//
// ★ 세 액션 모두 requireVerifiedParent() 로 **서버에서 다시** 부모를 확인하고,
//   그 appUserId 를 조회 함수에 넘긴다. 클라이언트가 보낸 값으로 소유권을 판단하지 않는다.

export async function fetchMakeupOptions(
  creditId: string,
): Promise<{ ok: boolean; message?: string; options?: MakeupOption[]; emptyReason?: MakeupEmptyReason | null }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, message: "로그인이 필요합니다." };

  const r = await getMakeupOptionsForCredit(parent.appUserId, creditId);
  if (!r.ok) return { ok: false, message: r.message };
  // emptyReason: 후보가 0건일 때 화면이 이유(학년 정보 없음 / 맞는 반 없음 / 자리 없음)를 나눠 보인다
  return { ok: true, options: r.options, emptyReason: r.emptyReason };
}

export async function bookMakeupAction(input: {
  creditId: string;
  classId: string;
  dateYmd: string;
}): Promise<{ ok: boolean; message: string }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, message: "로그인이 필요합니다." };

  const r = await bookMakeup(parent.appUserId, input);
  if (r.ok) revalidatePath("/mypage/makeup");
  return r;
}

export async function cancelMakeupAction(
  creditId: string,
): Promise<{ ok: boolean; message: string }> {
  const parent = await requireVerifiedParent().catch(() => null);
  if (!parent) return { ok: false, message: "로그인이 필요합니다." };

  const r = await cancelMakeupBooking(parent.appUserId, creditId);
  if (r.ok) revalidatePath("/mypage/makeup");
  return r;
}
