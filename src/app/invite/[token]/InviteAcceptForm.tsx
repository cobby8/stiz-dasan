"use client";

/**
 * 초대 수락 3단계 폼 — 클라이언트 컴포넌트
 *
 * Step 1: 정보 확인 (이름/역할/전화번호 표시)
 * Step 2: 전화번호 인증 (초대에 등록된 번호로 SMS 인증)
 * Step 3: 비밀번호 설정 → 가입 완료
 */

import { useState, useTransition } from "react";
import {
    sendInviteVerification,
    verifyInviteCode,
    acceptInvitation,
} from "@/app/actions/invite";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

interface Props {
    token: string;
    name: string;
    maskedPhone: string;    // "010-****-5678"
    role: string;
    roleLabel: string;      // "코치/강사"
    daysLeft: number;
}

// 역할별 색상
const ROLE_COLORS: Record<string, string> = {
    ADMIN: "bg-red-100 text-red-800",
    VICE_ADMIN: "bg-orange-100 text-orange-800",
    INSTRUCTOR: "bg-blue-100 text-blue-800",
    DRIVER: "bg-emerald-100 text-emerald-800",
};

export default function InviteAcceptForm({
    token,
    name,
    maskedPhone,
    role,
    roleLabel,
    daysLeft,
}: Props) {
    // 현재 단계: 1=정보확인, 2=폰인증, 3=비밀번호설정, 4=완료
    const [step, setStep] = useState(1);

    // 인증 관련 상태
    const [verifyCode, setVerifyCode] = useState("");
    const [verifyMsg, setVerifyMsg] = useState<{ text: string; ok: boolean } | null>(null);

    // 비밀번호 관련 상태
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [passwordError, setPasswordError] = useState("");

    // 완료 후 표시할 이메일
    const [resultEmail, setResultEmail] = useState("");

    // 로딩 상태
    const [isPending, startTransition] = useTransition();

    // ── Step 1 → Step 2: 인증번호 발송 ────────────────────────────
    function handleStartVerify() {
        startTransition(async () => {
            setVerifyMsg(null);
            const result = await sendInviteVerification(token);
            if (result.error) {
                setVerifyMsg({ text: userErrorMessage(result.error, "인증을 진행하지 못했습니다. 잠시 후 다시 시도해 주세요."), ok: false });
            } else {
                setStep(2);
                setVerifyMsg({ text: "인증번호가 발송되었습니다. (5분 내 입력)", ok: true });
            }
        });
    }

    // ── Step 2: 인증번호 검증 ────────────────────────────────────
    function handleVerify() {
        if (!verifyCode.trim()) return;
        startTransition(async () => {
            setVerifyMsg(null);
            const result = await verifyInviteCode(token, verifyCode.trim());
            if (result.error) {
                setVerifyMsg({ text: userErrorMessage(result.error, "인증을 진행하지 못했습니다. 잠시 후 다시 시도해 주세요."), ok: false });
            } else {
                setStep(3);
                setVerifyMsg(null);
            }
        });
    }

    // ── Step 2: 인증번호 재발송 ────────────────────────────────────
    function handleResendCode() {
        startTransition(async () => {
            setVerifyMsg(null);
            setVerifyCode("");
            const result = await sendInviteVerification(token);
            if (result.error) {
                setVerifyMsg({ text: userErrorMessage(result.error, "인증을 진행하지 못했습니다. 잠시 후 다시 시도해 주세요."), ok: false });
            } else {
                setVerifyMsg({ text: "인증번호가 재발송되었습니다.", ok: true });
            }
        });
    }

    // ── Step 3: 비밀번호 설정 + 가입 완료 ────────────────────────
    function handleAccept() {
        setPasswordError("");

        if (password.length < 10) {
            setPasswordError("비밀번호는 10자 이상이어야 합니다.");
            return;
        }
        if (password !== confirmPassword) {
            setPasswordError("비밀번호가 일치하지 않습니다.");
            return;
        }

        startTransition(async () => {
            const result = await acceptInvitation(token, password);
            if (result.error) {
                setPasswordError(userErrorMessage(result.error, "가입을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."));
            } else {
                setResultEmail(result.email || "");
                setStep(4);
            }
        });
    }

    return (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg overflow-hidden">
            {/* 상단 브랜드 영역 */}
            <div className="bg-brand-navy-900 px-6 py-6 text-center">
                <h1 className="text-white text-xl font-bold">STIZ 농구교실</h1>
                <p className="text-brand-navy-300 text-sm mt-1">스태프 초대</p>
            </div>

            {/* 진행 상태 바 */}
            <div className="px-6 pt-5">
                <div className="flex items-center gap-1">
                    {[1, 2, 3].map((s) => (
                        <div
                            key={s}
                            className={`flex-1 h-1.5 rounded-full transition-colors ${
                                step >= s ? "bg-brand-navy-900" : "bg-gray-200"
                            }`}
                        />
                    ))}
                </div>
                <div className="flex justify-between mt-2 text-xs text-gray-400">
                    <span className={step >= 1 ? "text-brand-navy-900 font-medium" : ""}>정보 확인</span>
                    <span className={step >= 2 ? "text-brand-navy-900 font-medium" : ""}>본인 인증</span>
                    <span className={step >= 3 ? "text-brand-navy-900 font-medium" : ""}>비밀번호</span>
                </div>
            </div>

            {/* Step 1: 정보 확인 */}
            {step === 1 && (
                <div className="p-6 space-y-5">
                    <div className="text-center">
                        <h2 className="text-lg font-bold text-gray-900 dark:text-white">{name}님, 환영합니다!</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            스태프로 초대되었습니다. 아래 정보를 확인해주세요.
                        </p>
                    </div>

                    {/* 초대 정보 카드 */}
                    <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-5 space-y-3">
                        <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500 dark:text-gray-400">이름</span>
                            <span className="text-sm font-medium text-gray-900 dark:text-white">{name}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500 dark:text-gray-400">전화번호</span>
                            <span className="text-sm font-medium text-gray-900 dark:text-white">{maskedPhone}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500 dark:text-gray-400">부여 역할</span>
                            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${ROLE_COLORS[role] || "bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100"}`}>
                                {roleLabel}
                            </span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500 dark:text-gray-400">유효 기간</span>
                            <span className="text-sm text-gray-700 dark:text-gray-200">{daysLeft}일 남음</span>
                        </div>
                    </div>

                    {/* 에러 메시지 */}
                    {verifyMsg && !verifyMsg.ok && (
                        <div className="px-3 py-2 rounded-lg text-xs font-medium bg-red-50 text-red-700 border border-red-200">
                            {verifyMsg.text}
                        </div>
                    )}

                    {/* 다음 단계 버튼 */}
                    <button
                        onClick={handleStartVerify}
                        disabled={isPending}
                        className="w-full py-3 bg-brand-navy-900 text-white rounded-lg font-medium text-sm hover:bg-brand-navy-800 transition-colors disabled:opacity-50"
                    >
                        {isPending ? "인증번호 발송 중..." : "본인 인증 시작"}
                    </button>
                </div>
            )}

            {/* Step 2: 전화번호 인증 */}
            {step === 2 && (
                <div className="p-6 space-y-5">
                    <div className="text-center">
                        <h2 className="text-lg font-bold text-gray-900 dark:text-white">본인 인증</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            {maskedPhone}(으)로 발송된 6자리 인증번호를 입력해주세요.
                        </p>
                    </div>

                    {/* 인증번호 입력 */}
                    <div>
                        <input
                            type="text"
                            value={verifyCode}
                            onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                            placeholder="000000"
                            maxLength={6}
                            className="w-full px-4 py-4 border border-gray-300 rounded-xl text-center text-2xl tracking-[0.5em] font-mono focus:ring-2 focus:ring-brand-navy-500 focus:border-brand-navy-500"
                            autoFocus
                        />
                    </div>

                    {/* 상태 메시지 */}
                    {verifyMsg && (
                        <div className={`px-3 py-2 rounded-lg text-xs font-medium ${
                            verifyMsg.ok
                                ? "bg-green-50 text-green-700 border border-green-200"
                                : "bg-red-50 text-red-700 border border-red-200"
                        }`}>
                            {verifyMsg.text}
                        </div>
                    )}

                    {/* 확인 버튼 */}
                    <button
                        onClick={handleVerify}
                        disabled={isPending || verifyCode.length < 6}
                        className="w-full py-3 bg-brand-navy-900 text-white rounded-lg font-medium text-sm hover:bg-brand-navy-800 transition-colors disabled:opacity-50"
                    >
                        {isPending ? "확인 중..." : "인증번호 확인"}
                    </button>

                    {/* 재발송 링크 */}
                    <div className="text-center">
                        <button
                            onClick={handleResendCode}
                            disabled={isPending}
                            className="text-xs text-gray-500 dark:text-gray-400 hover:text-brand-navy-700 underline disabled:opacity-50"
                        >
                            인증번호가 안 왔나요? 재발송
                        </button>
                    </div>
                </div>
            )}

            {/* Step 3: 비밀번호 설정 */}
            {step === 3 && (
                <div className="p-6 space-y-5">
                    <div className="text-center">
                        <span className="material-symbols-outlined text-[36px] text-green-500">verified</span>
                        <h2 className="text-lg font-bold text-gray-900 dark:text-white mt-2">인증 완료</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            마지막으로 로그인에 사용할 비밀번호를 설정해주세요.
                        </p>
                    </div>

                    {/* 비밀번호 입력 */}
                    <div className="space-y-3">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">비밀번호</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="10자 이상"
                                minLength={10}
                                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-navy-500 focus:border-brand-navy-500"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">비밀번호 확인</label>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="비밀번호 재입력"
                                minLength={10}
                                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-navy-500 focus:border-brand-navy-500"
                            />
                        </div>
                    </div>

                    {/* 에러 메시지 */}
                    {passwordError && (
                        <div className="px-3 py-2 rounded-lg text-xs font-medium bg-red-50 text-red-700 border border-red-200">
                            {passwordError}
                        </div>
                    )}

                    {/* 가입 완료 버튼 */}
                    <button
                        onClick={handleAccept}
                        disabled={isPending || !password || !confirmPassword}
                        className="w-full py-3 bg-brand-navy-900 text-white rounded-lg font-medium text-sm hover:bg-brand-navy-800 transition-colors disabled:opacity-50"
                    >
                        {isPending ? "가입 처리 중..." : "가입 완료"}
                    </button>
                </div>
            )}

            {/* Step 4: 완료 */}
            {step === 4 && (
                <div className="p-6 space-y-5 text-center">
                    <span className="material-symbols-outlined text-[48px] text-green-500">celebration</span>
                    <div>
                        <h2 className="text-lg font-bold text-gray-900 dark:text-white">가입이 완료되었습니다!</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                            {name}님, {roleLabel} 역할로 등록되었습니다.
                        </p>
                    </div>

                    {/* 로그인 정보 안내 */}
                    <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-5 space-y-2 text-left">
                        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase">로그인 정보</p>
                        <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500 dark:text-gray-400">이메일 (아이디)</span>
                            <span className="text-sm font-mono font-medium text-gray-900 dark:text-white">{resultEmail}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-sm text-gray-500 dark:text-gray-400">비밀번호</span>
                            <span className="text-sm text-gray-700 dark:text-gray-200">방금 설정한 비밀번호</span>
                        </div>
                    </div>

                    <a
                        href={role === "INSTRUCTOR" || role === "DRIVER" ? "/staff/install" : "/login"}
                        className="inline-block w-full py-3 bg-brand-navy-900 text-white rounded-lg font-medium text-sm hover:bg-brand-navy-800 transition-colors text-center"
                    >
                        {role === "INSTRUCTOR" || role === "DRIVER" ? "스태프 앱 설치하기" : "로그인하러 가기"}
                    </a>
                </div>
            )}
        </div>
    );
}
