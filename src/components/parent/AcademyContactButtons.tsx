import Link from "next/link";
import { academyTel } from "@/lib/academyPhoneRules";

/**
 * «학원에 문의» 글 옆에 붙이는 연락 버튼 묶음(2026-11-17 원장 결정 g3).
 * 왜: «학원에 문의해 주세요» 글만 있으면 학부모가 번호를 따로 찾아야 한다 — 그 자리에서 바로 걸 수 있게 한다.
 * 본보기 = 결석 알리기 화면의 «전화·카카오 문의» 묶음(RegularAbsenceClient 의 ContactActions)과 같은 규칙:
 *  - 전화: 걸 수 있는 번호(설정값)일 때만. 판정은 academyPhoneRules 한 곳
 *  - 카카오 문의: 채널 주소(설정값)가 있을 때만
 *  - 전화 번호가 없으면 홈의 «학원에 메시지 보내기» 폼으로 가는 링크(막다른 곳을 만들지 않는다).
 *    자녀가 0명이면 그 폼이 없으니 자녀 연결 화면으로(CHILD_CONNECT_ASK)
 * 번호·주소는 코드에 박지 않는다 — 서버 page 가 설정에서 읽어 넘긴다(getAcademyContact).
 */
export type AcademyContact = { phone: string | null; kakaoChannelUrl: string | null };

// 홈의 문의 폼을 바로 여는 주소(MyPageClient 가 이 #주소를 받아 폼을 편다)
export const ACADEMY_ASK_HREF = "/mypage#parent-request-form";

/**
 * 자녀가 0명인 계정의 «문의» 자리(2026-11-17 검수 반영).
 * 왜: 홈 문의 폼은 자녀가 연결된 계정에만 있다 — 자녀가 없으면 /mypage 가 «자녀 없음» 안내(EmptyParentState)를 그려
 *     #parent-request-form 이 없는 화면에 닿는다. 그래서 자녀 연결 화면으로 보낸다(설정 화면 연락처 칸과 같은 길).
 * 부르는 쪽: <AcademyContactButtons contact={…} {...(hasChildren ? {} : CHILD_CONNECT_ASK)} />
 */
export const CHILD_CONNECT_ASK = { askHref: "/mypage/children", askLabel: "자녀 연결하기" } as const;

/**
 * 그 글이 «학원으로 문의/연락해 주세요»라고 말하는가 — 서버가 준 오류 글에 이 말이 있으면 화면이 버튼을 같이 보인다.
 * 오류 코드·응답 모양을 바꾸지 않고, 화면에 뜬 글만 보고 판단한다.
 */
export function asksAcademy(text: string | null | undefined): boolean {
  return /학원(으로|에) (문의|연락)/.test(String(text ?? ""));
}

export default function AcademyContactButtons({
  contact,
  className = "flex flex-wrap items-center gap-2",
  buttonClassName = "academy-button-secondary whitespace-nowrap",
  alwaysAsk = false,
  askHref = ACADEMY_ASK_HREF,
  askLabel = "학원에 문의",
}: {
  /** 학원 연락처(없으면 문의 폼 링크만 보인다) */
  contact?: AcademyContact | null;
  /** 묶음 칸의 배치(행 안에서는 오른쪽 정렬 등) */
  className?: string;
  /** 버튼 등급 — 기본은 보조(secondary) */
  buttonClassName?: string;
  /** 전화 번호가 있어도 문의 폼 링크를 같이 보일 때 */
  alwaysAsk?: boolean;
  /** 문의 링크 주소 — 기본은 홈 문의 폼. 자녀가 0명인 계정은 CHILD_CONNECT_ASK 로 자녀 연결 화면에 보낸다 */
  askHref?: string;
  /** 문의 링크 글자 — 주소에 맞춰 같이 바꾼다(예: «자녀 연결하기») */
  askLabel?: string;
}) {
  const tel = academyTel(contact?.phone);
  const kakao = contact?.kakaoChannelUrl || null;
  return (
    <span className={className}>
      {tel && (
        <a href={`tel:${tel}`} className={buttonClassName}>
          학원에 전화하기
        </a>
      )}
      {kakao && (
        <a href={kakao} data-outside-link target="_blank" rel="noopener noreferrer" className={buttonClassName}>
          카카오 문의
        </a>
      )}
      {(alwaysAsk || !tel) && (
        <Link href={askHref} className={buttonClassName}>
          {askLabel}
        </Link>
      )}
    </span>
  );
}
