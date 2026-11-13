import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { koreaServiceMonth } from "@/lib/regular/serviceMonth";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export default async function StudentShuttleAssignment({ studentId }: { studentId: string }) {
    const month = koreaServiceMonth();
    const stops = await prisma.regularShuttleStop.findMany({
        where: { studentId, serviceMonth: month, direction: { in: ["BOARD", "ALIGHT"] } },
        select: { id: true, weekday: true, direction: true, stopName: true, classTime: true, arriveTime: true },
        orderBy: [{ weekday: "asc" }, { classTime: "asc" }, { direction: "desc" }],
    }).catch(() => null);

    return (
        <section className="academy-panel space-y-3 p-5" aria-label="셔틀 배차">
            <h3 className="academy-section-title">셔틀 배차 · {month}</h3>
            {stops === null ? <p className="text-sm">배차 정보를 불러오지 못했습니다.</p> : stops.length === 0 ? (
                <div className="flex items-center justify-between gap-2 text-sm">
                    <span>이번 달 배차 없음</span>
                    <Link className="font-medium underline" href={`/admin/shuttle/regular?month=${month}&studentId=${encodeURIComponent(studentId)}`}>셔틀 명단 열기</Link>
                </div>
            ) : (
                <ul className="space-y-2">
                    {stops.map((stop) => {
                        const label = `${WEEKDAYS[stop.weekday]}요일 ${stop.direction === "BOARD" ? "등원" : "하원"}`;
                        const href = `/admin/shuttle/regular-dispatch?${new URLSearchParams({ month, studentId, stopId: stop.id })}`;
                        return (
                            <li key={stop.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <div>
                                    <p className="font-medium">{label} · {stop.arriveTime || "시각 미입력"}</p>
                                    <p className="text-xs text-[var(--color-academy-muted)]">{stop.stopName}{stop.classTime ? ` · ${stop.classTime} 수업` : ""}</p>
                                </div>
                                <Link className="font-medium underline" href={href} aria-label={`${label} 배차 바로가기`}>배차 바로가기</Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
