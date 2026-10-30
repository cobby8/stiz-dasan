"use client";

import { publicErrorText } from "@/components/ui/public-error-text";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SetupPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [alreadySetup, setAlreadySetup] = useState(false);

  // 이미 관리자가 있는지 확인
  useEffect(() => {
    async function checkExistingAdmin() {
      try {
        const res = await fetch("/api/auth/check-setup");
        const data = await res.json();
        if (data.hasAdmin) {
          setAlreadySetup(true);
        }
      } catch {
        // API 실패 시 셋업 허용
      } finally {
        setChecking(false);
      }
    }
    checkExistingAdmin();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const confirmPassword = formData.get("confirmPassword") as string;
    const name = formData.get("name") as string;

    if (password !== confirmPassword) {
      setError("비밀번호가 일치하지 않습니다.");
      setLoading(false);
      return;
    }

    if (password.length < 6) {
      setError("비밀번호는 6자 이상이어야 합니다.");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/check-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      const data = await res.json();

      if (!res.ok) {
        // 인증 서비스 영어 원문이 섞여 올 수 있어 한국어 안내만 보여 준다
        setError(publicErrorText(data.error, "관리자 생성 중 오류가 발생했습니다."));
        setLoading(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => router.push(data.redirectTo || "/admin"), 1200);
    } catch {
      setError("관리자 생성 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500 dark:text-gray-400">확인 중...</p>
      </div>
    );
  }

  if (alreadySetup) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
            <span className="text-green-600 text-2xl">&#10003;</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
            이미 설정이 완료되었습니다
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            관리자 계정이 이미 존재합니다.
          </p>
          <a
            href="/login"
            className="inline-block px-6 py-2.5 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors"
          >
            로그인하러 가기
          </a>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
            <span className="text-green-600 text-2xl">&#10003;</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
            관리자 계정 생성 완료!
          </h1>
          <p className="text-gray-500 dark:text-gray-400">
            잠시 후 다음 화면으로 이동합니다...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* 헤더 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-orange-500 rounded-2xl mb-4">
            <span className="text-white text-2xl font-bold">S</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">초기 설정</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            최초 관리자 계정을 생성합니다
          </p>
        </div>

        {/* 폼 카드 */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1"
              >
                이름 (원장님 성함)
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                placeholder="홍길동"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1"
              >
                이메일
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder="admin@stiz.kr"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1"
              >
                비밀번호
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={6}
                placeholder="6자 이상"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1"
              >
                비밀번호 확인
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                required
                minLength={6}
                placeholder="비밀번호 재입력"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "생성 중..." : "관리자 계정 생성"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          이 페이지는 최초 1회만 사용 가능합니다.
        </p>
      </div>
    </div>
  );
}
