import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { expireOverdueCredits, isMakeupCreditIssuableYmd } from "@/lib/makeup/credit-service";
import { withCronAlert } from "@/lib/cron/withCronAlert";
import { autoConvertOverdueIllnessReviews, purgeIllnessEvidence } from "@/lib/regular/illness-carry-cron";
import { removeEvidencePhoto } from "@/lib/regular/illness-evidence-storage";
import { notifyParentsOfStudents } from "@/lib/notification";

export const dynamic = "force-dynamic";

/**
 * 보강권 하루 정리(매일 KST 00:30).
 *
 * ① 기간이 지난 보강권 소멸 — 약관: "결석이 발생한 날로부터 2개월 이내 사용, 지나면 자동 소멸".
 *    화면은 크론과 무관하게 시각 기준으로 만료를 보여 주므로(summarize),
 *    이 크론이 하루 늦게 돌아도 학부모가 만료된 보강권을 쓸 수는 없다.
 *    여기서 하는 일은 상태를 실제 데이터에 확정 짓는 것이다.
 * ② 질병·부상 결석 «이월 검토»(2026-11-14 원장 결정 a2·a6) — 같은 시각에 함께 돈다(새 cron 을 늘리지 않는다).
 *    · 알린 지 7일이 지났는데 사진이 없는 검토 → 보강권 1장으로 전환 + 학부모 앱 알림
 *    · 증빙 사진 파일 지우기(처리 끝나고 90일 지난 것·화면에서 뺀 것)
 *    날짜 판정은 DB 시계의 KST 날짜 — KST 00:30 에 돌므로 «마지막 날 자정»이 지난 직후 전환된다.
 */
async function handleGet(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV !== "development" &&
    (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { expired } = await expireOverdueCredits();
  if (expired > 0) console.log(`[cron/makeup-credits] 보강권 ${expired}장 소멸`);

  // ② 는 ① 과 따로 실패한다 — 한쪽이 실패해도 다른 쪽은 끝까지 돌리고, 마지막에 오류를 던져 원장 슬랙 알림(withCronAlert)이 가게 한다
  const errors: unknown[] = [];
  let illness: { converted: number; failed: number } = { converted: 0, failed: 0 };
  let evidence: { purged: number; failed: number } = { purged: 0, failed: 0 };
  try {
    const result = await autoConvertOverdueIllnessReviews(prisma, isMakeupCreditIssuableYmd);
    illness = { converted: result.converted.length, failed: result.failed };
    for (const item of result.converted) {
      // 앱 안 알림만(문자·알림톡 없음). 건강 정보(사유 글)는 본문에 싣지 않는다
      await notifyParentsOfStudents(
        [item.studentId], "ABSENCE", "결석 보강권 안내",
        item.creditIssued
          ? `${item.absenceYmd} 결석은 증빙 사진이 없어 보강권 1장으로 바꿨어요.`
          : `${item.absenceYmd} 결석은 증빙 사진이 없어 이월 검토를 마쳤어요.`,
        "/mypage/regular-absence",
      );
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    evidence = await purgeIllnessEvidence(prisma, removeEvidencePhoto);
  } catch (error) {
    errors.push(error);
  }
  if (illness.converted > 0 || evidence.purged > 0) {
    console.log(`[cron/makeup-credits] 질병·부상 결석 보강권 전환 ${illness.converted}건 · 증빙 사진 삭제 ${evidence.purged}장`);
  }
  if (errors.length > 0) throw errors[0];
  return NextResponse.json({ ok: true, expired, illness, evidence });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("makeup-credits", handleGet);
