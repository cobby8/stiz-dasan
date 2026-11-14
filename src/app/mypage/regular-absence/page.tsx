import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentIllnessReviews, getUpcomingRegularClassDates } from "@/lib/regular/parent-regular-absence";
import { getAcademySettings } from "@/lib/queries";
import { getRegularMakeupsForParent } from "@/lib/regular/parent-regular-makeup";
import { parseRequestPreset } from "@/lib/mypage/requestPreset";
import RegularAbsenceClient from "./RegularAbsenceClient";

export const dynamic = "force-dynamic";

export default async function RegularAbsencePage({
  searchParams,
}: {
  // 수업 탭 반 카드가 ?studentId= 를 붙여 연다 — 그 아이를 먼저 보인다(힌트일 뿐, 목록은 서버가 거른 내 자녀 것)
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다. 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
  // /mypage/continue 로 가야 설치된 학부모 앱이 제 영역을 벗어나지 않는다.
  if (!parent) redirect("/mypage/continue?bounced=1");

  // 다가오는 수업일(결석 신고용) + 예정 보강(읽기 전용) 병렬 조회.
  // 질병·부상 이월 검토(상태·사진)는 수업일 목록의 줄 상태에도 쓰여 먼저 읽는다.
  const reviews = await getParentIllnessReviews(parent.appUserId);
  const [children, makeups, settings] = await Promise.all([
    getUpcomingRegularClassDates(parent.appUserId, undefined, reviews),
    getRegularMakeupsForParent(parent.appUserId),
    // 마감 뒤 «전화»·«카카오 채널로 문의» 버튼에 쓰는 학원 연락처(설정값). 못 읽어도 화면은 뜬다
    getAcademySettings().catch(() => null) as Promise<any>,
  ]);
  // 설정을 안 채운 기본값(010-0000-0000)이면 전화 버튼을 보이지 않는다(청구 탭과 같은 기준)
  const phone = typeof settings?.contactPhone === "string" ? settings.contactPhone.trim() : "";
  const contact = {
    phone: phone && phone !== "010-0000-0000" ? phone : null,
    kakaoChannelUrl: typeof settings?.kakaoChannelUrl === "string" && settings.kakaoChannelUrl.trim() ? settings.kakaoChannelUrl.trim() : null,
  };
  // Date/BigInt 등 직렬화 안전화(서버 컴포넌트 → 클라이언트 전달)
  const initial = JSON.parse(JSON.stringify(children));
  const initialMakeups = JSON.parse(JSON.stringify(makeups));
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  return (
    <RegularAbsenceClient
      initial={initial}
      initialReviews={JSON.parse(JSON.stringify(reviews))}
      makeups={initialMakeups}
      presetStudentId={preset.studentId}
      contact={contact}
    />
  );
}
