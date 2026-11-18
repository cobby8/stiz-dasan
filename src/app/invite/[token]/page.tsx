/**
 * 스태프 초대 수락 페이지 — 서버 컴포넌트
 *
 * URL: /invite/{token}
 * 토큰으로 초대 정보를 조회하여 클라이언트 폼에 전달
 * 유효하지 않은 토큰이면 에러 메시지 표시
 */

import { getInvitationByToken } from "@/lib/queries";
import InviteAcceptForm from "./InviteAcceptForm";
import { ROLE_PRESET_EXISTING_ACCOUNT_NOTICE } from "@/lib/staff/rolePreset";

// 초대 페이지는 항상 최신 데이터가 필요 (캐시 안 함)
export const dynamic = "force-dynamic";

// 역할별 한국어 라벨
const ROLE_LABELS: Record<string, string> = {
    ADMIN: "원장",
    VICE_ADMIN: "부원장",
    INSTRUCTOR: "코치/강사",
    DRIVER: "셔틀 기사",
    PARENT: "학부모",
};

export default async function InvitePage({
    params,
}: {
    params: Promise<{ token: string }>;
}) {
    const { token } = await params;
    const invitation = await getInvitationByToken(token);

    // 초대가 존재하지 않는 경우
    if (!invitation) {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white">유효하지 않은 초대</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                        존재하지 않는 초대 링크입니다. 원장에게 문의해주세요.
                    </p>
                </div>
            </div>
        );
    }

    // 이미 수락된 초대
    if (invitation.status === "ACCEPTED") {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white">{invitation.purpose === "PASSWORD_RESET" ? "이미 사용한 재설정 링크" : "이미 수락된 초대"}</h1>
                    {/* 2026-11-17: 예전에는 선생님·기사님을 «스태프 앱 설치하기»(옛 홈 화면 바로가기 안내)로 보냈다.
                        지금은 스토어 앱 하나라 누구나 로그인이 먼저다 — 가입 완료 화면(InviteAcceptForm)과 같은 순서:
                        주 버튼 «로그인하러 가기», 앱이 없는 분께만 설치 주소를 작게. */}
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                        이 초대는 이미 수락되었습니다. 로그인 화면에서 로그인해 주세요.
                    </p>
                    <a href="/login" className="academy-button-primary mt-4 w-full">
                        로그인하러 가기
                    </a>
                    {(invitation.role === "INSTRUCTOR" || invitation.role === "DRIVER") && invitation.purpose !== "PASSWORD_RESET" && (
                        <a href="/install" className="academy-button-text mt-2 w-full">
                            스티즈농구교실 앱 설치하기
                        </a>
                    )}
                </div>
            </div>
        );
    }

    // 취소된 초대
    if (invitation.status === "CANCELLED") {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white">취소된 초대</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                        이 초대는 취소되었습니다. 원장에게 문의해주세요.
                    </p>
                </div>
            </div>
        );
    }

    // 만료된 초대
    const expiresAt = new Date(invitation.expiresAt);
    if (expiresAt < new Date()) {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white">만료된 초대</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                        초대 링크가 만료되었습니다. 원장에게 재발송을 요청해주세요.
                    </p>
                </div>
            </div>
        );
    }

    // 2026-11-18 원장 결정 «가입·본인인증 통일» 5단계: 새 선생님·기사님 초대는 «번호에 역할 미리 붙이기»(ROLE_PRESET)다.
    // 이 링크에서 직원 전용 계정(휴대폰 번호 로그인)을 만들지 않고, 학부모와 같은 가입 화면으로 안내한다.
    // 가입(아이디 또는 간편로그인 + 본인인증)이 끝나는 순간 이 번호에 붙여 둔 역할이 적용된다(src/lib/staff/rolePreset.ts).
    if (invitation.purpose === "ROLE_PRESET") {
        const roleLabel = invitation.role === "DRIVER" ? "기사님" : "선생님";
        const signupHref = `/signup/parent?staffRole=${invitation.role === "DRIVER" ? "DRIVER" : "INSTRUCTOR"}`;
        return (
            <div className="min-h-screen bg-[var(--color-academy-soft)] flex items-center justify-center p-4">
                <div className="w-full max-w-md rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-6 shadow-sm">
                    <h1 className="text-xl font-bold text-[var(--color-academy-ink)]">{invitation.name}님, {roleLabel} 역할이 준비돼 있어요</h1>
                    <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-[var(--color-academy-ink)]">
                        <li>아래 «가입하러 가기»를 눌러 학부모와 같은 가입 화면으로 가요.</li>
                        <li>아이디 또는 카카오·구글·Apple 간편로그인으로 가입하고, 본인인증을 해 주세요.</li>
                        <li>본인인증 이름이 초대할 때 적은 이름(«{invitation.name}»)과 같으면 가입을 마치는 즉시 {roleLabel} 화면이 열려요.
                            문자 인증으로 가입하거나 이름이 다르면 원장님 확인 후 열려요.</li>
                    </ol>
                    <p className="mt-3 text-xs leading-5 text-[var(--color-academy-muted)]">
                        로그인은 휴대폰 번호가 아니라 가입할 때 정한 아이디나 간편로그인으로 해요. 비밀번호를 잊으면 로그인 화면의 «아이디·비밀번호 찾기»를 쓰면 돼요.
                        {" "}이 안내는 {new Date(invitation.expiresAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}까지 유효해요.
                    </p>
                    <a href={signupHref} className="academy-button-primary mt-5 w-full">
                        가입하러 가기
                    </a>
                    {/* 이미 계정이 있는 분 — 가입 화면은 «이미 가입된 번호»로 막힌다. 로그인 뒤 내 정보 본인인증에서 역할이 붙는다(검수 R-3) */}
                    <p className="mt-4 text-xs leading-5 text-[var(--color-academy-muted)]">{ROLE_PRESET_EXISTING_ACCOUNT_NOTICE}</p>
                    <a href="/login" className="academy-button-text mt-2 w-full">
                        이미 가입했어요 · 로그인
                    </a>
                </div>
            </div>
        );
    }

    // 전화번호 마스킹 (010-****-5678)
    const phone = invitation.phone || "";
    const maskedPhone = phone.length >= 7
        ? phone.slice(0, 3) + "-****-" + phone.slice(-4)
        : "***";

    // 유효한 PENDING 초대 → 수락 폼 표시
    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                <InviteAcceptForm
                    token={token}
                    name={invitation.name}
                    maskedPhone={maskedPhone}
                    role={invitation.role}
                    roleLabel={ROLE_LABELS[invitation.role] || /* 모르는 역할값은 영어 원문 대신 일반 표현 */ "학원 구성원"}
                    purpose={invitation.purpose}
                    daysLeft={Math.max(0, Math.ceil((expiresAt.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)))}
                />
            </div>
        </div>
    );
}
