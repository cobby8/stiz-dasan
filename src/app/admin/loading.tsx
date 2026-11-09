function SkeletonBlock({ className = "" }: { className?: string }) {
    return (
        <div
            className={`animate-pulse rounded-lg bg-[var(--color-academy-soft)] ${className}`}
        />
    );
}

export default function AdminLoading() {
    return (
        <div className="mx-auto max-w-7xl space-y-6">
            <div className="space-y-2">
                <SkeletonBlock className="h-8 w-40" />
                <SkeletonBlock className="h-4 w-72 max-w-full bg-[var(--color-academy-soft)]" />
            </div>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="space-y-3">
                                <SkeletonBlock className="h-3 w-16 bg-[var(--color-academy-soft)]" />
                                <SkeletonBlock className="h-7 w-20" />
                            </div>
                            <SkeletonBlock className="h-10 w-10 rounded-xl bg-[var(--color-academy-soft)]" />
                        </div>
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {Array.from({ length: 2 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-6 shadow-sm"
                    >
                        <SkeletonBlock className="mb-5 h-5 w-36" />
                        <div className="space-y-3">
                            {Array.from({ length: 5 }).map((__, rowIndex) => (
                                <SkeletonBlock
                                    key={rowIndex}
                                    className="h-10 w-full bg-[var(--color-academy-soft)]"
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
