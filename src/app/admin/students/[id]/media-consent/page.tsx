import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { getStudentMediaConsentAdminView } from "@/lib/studentMediaConsentAdmin";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import MediaConsentClient from "./MediaConsentClient";

export const dynamic = "force-dynamic";

export default async function StudentMediaConsentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const data = await getStudentMediaConsentAdminView(id);
  if (!data) notFound();

  return <div className="mx-auto max-w-5xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      {/* 페이지 제목은 공용 머리말 부품(모양 한 가지) */}
      <div className="min-w-0"><Link href={`/admin/students/${id}`} className="academy-button-text academy-button-sm -ml-2">← 학생 상세로</Link><AdminPageHeader className="mt-1" title={`${data.student.name} 사진 사용 동의`} description={<>보호자 {data.student.guardianName ?? "이름 미등록"}{data.student.guardianPhone ? ` · ${data.student.guardianPhone}` : ""}</>} /></div>
    </header>
    <MediaConsentClient data={data} />
  </div>;
}

