import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { loadParentAbsenceScreen } from "@/lib/regular/parent-absence-period";
import { getAcademySettings } from "@/lib/queries";
import { getUsableAcademyPhone } from "@/lib/academyPhone";
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
  // 수업일·이월 검토·진행 중인 «여러 날 결석»은 API(GET)와 같은 함수 한 곳에서 읽는다.
  const [screen, makeups, settings, phone] = await Promise.all([
    loadParentAbsenceScreen(parent.appUserId),
    getRegularMakeupsForParent(parent.appUserId),
    // 마감 뒤 «카카오 채널로 문의» 버튼에 쓰는 주소(설정값). 못 읽어도 화면은 뜬다
    getAcademySettings().catch(() => null) as Promise<any>,
    // «전화» 버튼 번호 — 걸 수 없는 값(자리채움 번호·이상한 길이)이면 null(버튼 숨김). 판정은 공용 한 곳(같은 요청 안에서 설정은 한 번만 읽힌다)
    getUsableAcademyPhone(),
  ]);
  const contact = {
    phone,
    kakaoChannelUrl: typeof settings?.kakaoChannelUrl === "string" && settings.kakaoChannelUrl.trim() ? settings.kakaoChannelUrl.trim() : null,
  };
  // Date/BigInt 등 직렬화 안전화(서버 컴포넌트 → 클라이언트 전달)
  const initial = JSON.parse(JSON.stringify(screen.children));
  const initialMakeups = JSON.parse(JSON.stringify(makeups));
  const preset = parseRequestPreset(searchParams ? await searchParams : null);
  return (
    <RegularAbsenceClient
      initial={initial}
      initialReviews={JSON.parse(JSON.stringify(screen.reviews))}
      initialPeriods={JSON.parse(JSON.stringify(screen.periods))}
      periodAvailable={screen.periodAvailable}
      makeups={initialMakeups}
      presetStudentId={preset.studentId}
      contact={contact}
    />
  );
}
