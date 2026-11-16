// 학부모 화면 «불러오는 중» 뼈대(2026-11-16 속도 개선).
// 아래 탭을 누르면 서버 응답을 기다리는 동안 화면이 멈춰 보였다 — 누르자마자 이 뼈대가 먼저 보인다.
// 머리줄·아래 탭은 레이아웃이 그리므로 여기는 본문 뼈대만 그린다.
// 높이는 실제 홈(제목 줄 + 오늘 카드 + 처리할 일 + 바로가기 + 소식)과 비슷하게 맞춰 화면이 덜 튀게 한다.

// 회색 덩어리 하나 — 움직임 줄이기 설정이면 깜빡이지 않는다
function Bone({ className = "" }: { className?: string }) {
    return <div className={`animate-pulse rounded-lg bg-[var(--color-academy-soft)] motion-reduce:animate-none ${className}`} />;
}

export default function MyPageLoading() {
    return (
        <div role="status" aria-busy="true" className="space-y-3">
            {/* 화면 낭독기용 글자 — 눈에는 보이지 않는다 */}
            <p className="sr-only">불러오는 중</p>
            {/* 뼈대 모양은 낭독기에서 감춘다(뜻 없는 도형) */}
            <div aria-hidden="true" className="space-y-3">
                {/* 제목 줄 */}
                <Bone className="h-7 w-40" />
                {/* 오늘 카드 */}
                <div className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 shadow-sm">
                    <Bone className="h-5 w-32" />
                    <div className="mt-3 space-y-1.5">
                        <Bone className="h-11 w-full rounded-xl" />
                        <Bone className="h-11 w-full rounded-xl" />
                    </div>
                </div>
                {/* 처리할 일 */}
                <div className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 shadow-sm">
                    <Bone className="h-5 w-24" />
                    <div className="mt-3 space-y-2">
                        <Bone className="h-11 w-full rounded-xl" />
                        <Bone className="h-11 w-full rounded-xl" />
                    </div>
                </div>
                {/* 바로가기 줄 */}
                <div className="grid grid-cols-4 gap-2">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <Bone key={index} className="h-12 rounded-md" />
                    ))}
                </div>
                {/* 소식 카드 */}
                <div className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 shadow-sm">
                    <Bone className="h-5 w-28" />
                    <Bone className="mt-3 h-24 w-full rounded-xl" />
                </div>
            </div>
        </div>
    );
}
