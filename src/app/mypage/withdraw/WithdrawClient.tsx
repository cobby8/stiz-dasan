"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { customerMessage } from "@/components/parent/customerMessage";
import {
  cancelAccountWithdrawalRequest,
  getAccountWithdrawalStatus,
  requestAccountWithdrawal,
} from "@/app/actions/parent-account";

type Props = {
  initial: {
    state: "ACTIVE" | "PENDING" | "WITHDRAWN";
    activeEnrollmentCount: number;
    immediate: boolean;
    reviewMessage?: string | null;
    reviewReason?: string | null;
    activeWorkCount?: number;
  };
  parentName: string;
  backHref?: string;
};

// 지워지는 것과 남는 것을 **화면에 분명히 적는다.**
// 구글플레이 심사 요건이기도 하지만, 그보다 학부모가 "출결 기록도 사라지나요"를 묻지 않아도
// 되게 하려는 것이다. 문구를 줄이면 그 질문이 전화로 온다.
const REMOVED = [
  "로그인 계정(이메일·비밀번호, 간편로그인 연결)",
  "이름·전화번호 등 연락처",
  "카카오톡 상담 연결",
  "앱 알림(푸시) 설정",
  "셔틀 승·하차 위치",
];

const RETAINED = ["자녀의 출결·수업 기록", "수강료 납부·청구 내역"];

export default function WithdrawClient({
  initial,
  parentName,
  backHref = "/mypage",
}: Props) {
  const router = useRouter();
  const [state, setState] = useState(initial.state);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<"WITHDRAWN" | "REQUESTED" | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError("");
    startTransition(async () => {
      try {
        const result = await requestAccountWithdrawal();
        if (result && "error" in result && result.error) {
          setError(customerMessage(result.error, "처리 결과를 확인하지 못했습니다. 다시 조회해 주세요."));
          return;
        }
        if (!result || !("ok" in result) || result.ok !== true) {
          setError("처리 결과를 확인하지 못했습니다. 다시 조회해 주세요.");
          return;
        }
        if ("withdrawn" in result && result.withdrawn) {
          setDone("WITHDRAWN");
          setState("WITHDRAWN");
          return;
        }
        const confirmed = await getAccountWithdrawalStatus();
        if (confirmed.state !== "PENDING") {
          setError("신청 상태를 확인하지 못했습니다. 다시 조회해 주세요.");
          return;
        }
        setDone("REQUESTED");
        setState("PENDING");
        router.refresh();
      } catch {
        setError("처리 결과를 확인하지 못했습니다. 다시 조회해 주세요.");
      }
    });
  }
  function cancel() {
    setError("");
    startTransition(async () => {
      try {
        const result = await cancelAccountWithdrawalRequest();
        if (result && "error" in result && result.error) {
          setError(customerMessage(result.error, "처리 결과를 확인하지 못했습니다. 다시 조회해 주세요."));
          return;
        }
        if (!result || !("ok" in result) || result.ok !== true) {
          setError("처리 결과를 확인하지 못했습니다. 다시 조회해 주세요.");
          return;
        }
        const confirmed = await getAccountWithdrawalStatus();
        if (confirmed.state !== "ACTIVE") {
          setError("취소 상태를 확인하지 못했습니다. 다시 조회해 주세요.");
          return;
        }
        setState("ACTIVE");
        setDone(null);
        setAgreed(false);
        router.refresh();
      } catch {
        setError("취소 결과를 확인하지 못했습니다. 다시 조회해 주세요.");
      }
    });
  }

  // 탈퇴가 끝났으면 더 보여줄 것이 없다. 로그인 수단이 이미 사라져 되돌릴 수도 없다.
  if (state === "WITHDRAWN") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-2 flex items-center gap-2 text-lg font-black text-brand-navy-900 dark:text-white">
          <span className="material-symbols-outlined text-gray-400">
            check_circle
          </span>
          탈퇴가 완료되었습니다
        </h1>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
          로그인 계정과 연락처가 삭제되었습니다. 그동안 이용해 주셔서
          감사합니다.
        </p>
        <p className="mb-5 text-xs text-gray-500 dark:text-gray-400">
          다시 등록하실 때는 새로 가입하시면 됩니다. 수강료 납부 내역은 법령에
          따라 보관됩니다.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-xl bg-gray-100 px-4 py-2.5 text-sm font-bold text-gray-700 dark:bg-gray-800 dark:text-gray-200"
        >
          <span className="material-symbols-outlined text-base">home</span>
          홈으로
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* 헤더 — 컴팩트하게 제목 1줄 + 설명 1줄 */}
      <div className="mb-2 flex items-center gap-2">
        {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
        <Link href={backHref} aria-label="이전 화면으로" className="academy-back-link">
          <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-black text-brand-navy-900 dark:text-white">
          <span className="material-symbols-outlined text-gray-500">
            person_remove
          </span>
          회원 탈퇴
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        {parentName} 회원님의 계정 탈퇴를 요청합니다. 삭제한 계정은 되돌릴 수
        없습니다.
      </p>

      {error && (
        <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {/* 신청 접수 상태 — 재학 중이라 원장님 확인을 기다리는 경우 */}
      {state === "PENDING" && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900 dark:bg-amber-950/30">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-black text-amber-900 dark:text-amber-200">
            <span className="material-symbols-outlined text-base">
              hourglass_top
            </span>
            탈퇴 신청이 접수되었습니다
          </h2>
          <p className="text-xs text-amber-800 dark:text-amber-200/90">
            {done === "REQUESTED"
              ? "탈퇴 요청을 접수했습니다. 담당 업무와 연락 관계를 확인한 뒤 처리합니다."
              : "관리자 확인이 필요한 상태입니다. 담당 업무와 연락 관계가 정리되기 전에는 계정을 삭제하지 않습니다."}
          </p>
          <button
            type="button"
            onClick={cancel}
            disabled={pending}
            // 탈퇴 신청을 거두는 «안전한» 쪽이라 보조 버튼(44px)
            className="academy-button-secondary mt-3"
          >
            {pending ? "처리 중..." : "신청 취소하기"}
          </button>
        </div>
      )}

      {state === "ACTIVE" && (
        <>
          {/* 재학 중이면 즉시 처리되지 않는다 — 누르기 전에 알려야 한다 */}
          {!initial.immediate && (
            <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 dark:border-blue-950 dark:bg-blue-950/30">
              <h2 className="mb-1 flex items-center gap-1.5 text-sm font-black text-blue-800 dark:text-blue-300">
                <span className="material-symbols-outlined text-base">
                  info
                </span>
                {initial.reviewReason === "ADMIN_HANDOFF"
                  ? "관리 역할을 다른 분께 넘겨야 합니다"
                  : initial.reviewReason === "STAFF_REVIEW"
                    ? "담당 업무 확인이 필요합니다"
                    : `수강 중인 반이 ${initial.activeEnrollmentCount}개 있습니다`}
              </h2>
              <p className="text-xs text-blue-800/90 dark:text-blue-200/90">
                바로 삭제되지 않고 <b>탈퇴 신청으로 접수</b>됩니다.{" "}
                {initial.reviewMessage ||
                  "수업과 연락 관계를 관리자가 먼저 확인합니다."}
              </p>
            </div>
          )}

          {/* 지워지는 것 / 남는 것 — 두 칸을 나란히 두어 한눈에 비교되게 한다 */}
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-red-100 bg-red-50/50 p-4 dark:border-red-950 dark:bg-red-950/20">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-black text-red-800 dark:text-red-300">
                <span className="material-symbols-outlined text-base">
                  delete
                </span>
                삭제되는 정보
              </h2>
              <ul className="space-y-1 text-xs text-red-900/90 dark:text-red-200/90">
                {REMOVED.map((item) => (
                  <li key={item} className="flex gap-1.5">
                    <span aria-hidden>·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 dark:border-gray-800 dark:bg-gray-900/40">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-black text-gray-700 dark:text-gray-200">
                <span className="material-symbols-outlined text-base">
                  inventory_2
                </span>
                보관되는 정보
              </h2>
              <ul className="space-y-1 text-xs text-gray-600 dark:text-gray-300">
                {RETAINED.map((item) => (
                  <li key={item} className="flex gap-1.5">
                    <span aria-hidden>·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                전자상거래법에 따라 거래 기록은 5년간 보관해야 합니다. 보관
                기간이 지나면 파기합니다.
              </p>
            </div>
          </div>

          {/* 되돌릴 수 없는 작업이라 한 번 더 확인받는다 */}
          <label className="mb-4 flex cursor-pointer items-start gap-2.5 rounded-2xl border border-gray-200 p-3.5 dark:border-gray-800">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500 dark:text-brand-neon-lime"
            />
            <span className="text-xs text-gray-700 dark:text-gray-200">
              위 내용을 확인했고, 계정 삭제는 되돌릴 수 없음을 이해합니다.
            </span>
          </label>



          {/* 근접성(M-05): 안전한 «돌아가기»를 먼저, 되돌릴 수 없는 삭제는 24px 떨어진 아래 전체 폭 위험색 */}
          <div className="flex flex-col">
            <Link href={backHref} className="academy-button-secondary self-start">
              돌아가기
            </Link>
            <button
              type="button"
              onClick={submit}
              disabled={!agreed || pending}
              className="academy-button-danger-solid mt-6 w-full"
            >
              {pending
                ? "처리 중..."
                : initial.immediate
                  ? "계정 삭제하기"
                  : "탈퇴 신청하기"}
            </button>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-gray-400 dark:text-gray-500">
            문의는 학원으로 연락해 주세요. 탈퇴하지 않고 알림만 끄고 싶으시면
            이용 화면에서 알림 설정을 변경하실 수 있습니다.
          </p>
        </>
      )}
    </div>
  );
}
