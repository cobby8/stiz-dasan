import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { getStudentMediaConsentAdminView } from "@/lib/studentMediaConsentAdmin";
import MediaConsentClient from "./MediaConsentClient";

export const dynamic = "force-dynamic";

export default async function StudentMediaConsentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const data = await getStudentMediaConsentAdminView(id);
  if (!data) notFound();

  return <div className="mx-auto max-w-5xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><Link href={`/admin/students/${id}`} className="text-sm font-bold text-[var(--color-academy-ink)]">← 학생 상세로</Link><h1 className="mt-2 text-2xl font-black text-[var(--color-academy-ink)]">{data.student.name} 사진 사용 동의</h1><p className="mt-1 text-sm text-[var(--color-academy-muted)]">보호자 {data.student.guardianName ?? "이름 미등록"}{data.student.guardianPhone ? ` · ${data.student.guardianPhone}` : ""}</p></div>
    </header>
    <MediaConsentClient data={data} />
  </div>;
}

