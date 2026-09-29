"use client";

import { useFormStatus } from "react-dom";

/**
 * "지금 대조하기" 버튼.
 *
 * 왜 따로 떼어냈나: 토스 조회 + 대조는 수십 초가 걸린다. 그동안 버튼이 그대로 눌리면
 * 원장은 "안 눌렸나?" 하고 여러 번 누르고, 기록표에 같은 실행이 여러 줄 쌓인다.
 * `useFormStatus` 의 pending 으로 전송 중에는 버튼을 잠그고 진행 중임을 글자로 알린다.
 */
export default function ReconcileNowButton() {
    const { pending } = useFormStatus();

    return (
        <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
            {pending ? "대조하는 중… (최대 1분)" : "지금 대조하기"}
        </button>
    );
}
