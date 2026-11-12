import { requireAdmin } from "@/lib/auth-guard";
import ClassDetailClient from "./ClassDetailClient";
import { getClassWithStudents, getCoaches, getSessionsByClass } from "@/lib/queries";
import { notFound } from "next/navigation";

// 30초 캐시: Server Action 호출 시 즉시 무효화됨
export const revalidate = 30;

export default async function ClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    // Next.js 16에서 params는 Promise — await 필요
    const { id } = await params;
    const [classData, sessions, coaches] = await Promise.all([
        getClassWithStudents(id),
        getSessionsByClass(id),
        getCoaches(),
    ]);

    if (!classData) notFound();

    return (
        <ClassDetailClient
            classId={id}
            classData={classData}
            sessions={sessions}
            coaches={coaches}
        />
    );
}
