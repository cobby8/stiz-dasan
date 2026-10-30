/**
 * 스태프 초대 수락 페이지 — 서버 컴포넌트
 *
 * URL: /invite/{token}
 * 토큰으로 초대 정보를 조회하여 클라이언트 폼에 전달
 * 유효하지 않은 토큰이면 에러 메시지 표시
 */

import { getInvitationByToken } from "@/lib/queries";
import InviteAcceptForm from "./InviteAcceptForm";

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
                    <span className="material-symbols-outlined text-[48px] text-red-400">error</span>
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white mt-4">유효하지 않은 초대</h1>
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
                    <span className="material-symbols-outlined text-[48px] text-green-400">check_circle</span>
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white mt-4">이미 수락된 초대</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                        {invitation.role === "INSTRUCTOR" || invitation.role === "DRIVER"
                            ? "이 초대는 이미 수락되었습니다. 스태프 앱을 설치하거나 열어주세요."
                            : "이 초대는 이미 수락되었습니다. 로그인 페이지에서 로그인해주세요."}
                    </p>
                    <a
                        href={invitation.role === "INSTRUCTOR" || invitation.role === "DRIVER" ? "/staff/install" : "/login"}
                        className="inline-block mt-4 px-6 py-2.5 bg-brand-navy-900 text-white rounded-lg text-sm font-medium hover:bg-brand-navy-800 transition-colors"
                    >
                        {invitation.role === "INSTRUCTOR" || invitation.role === "DRIVER" ? "스태프 앱 설치하기" : "로그인하기"}
                    </a>
                </div>
            </div>
        );
    }

    // 취소된 초대
    if (invitation.status === "CANCELLED") {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
                    <span className="material-symbols-outlined text-[48px] text-gray-400">block</span>
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white mt-4">취소된 초대</h1>
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
                    <span className="material-symbols-outlined text-[48px] text-orange-400">schedule</span>
                    <h1 className="text-xl font-bold text-gray-900 dark:text-white mt-4">만료된 초대</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                        초대 링크가 만료되었습니다. 원장에게 재발송을 요청해주세요.
                    </p>
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
                    daysLeft={Math.max(0, Math.ceil((expiresAt.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)))}
                />
            </div>
        </div>
    );
}
