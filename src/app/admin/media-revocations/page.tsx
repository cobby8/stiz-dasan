import { adminMessageText } from "@/components/admin/adminDisplayText";
import { confirmInstagramMediaRemoved, runMediaRevocationQueue } from "@/app/actions/media-revocations";
import { requireAdmin } from "@/lib/auth-guard";
import { listMediaRevocationJobs } from "@/lib/mediaRevocationQueue";

export const dynamic = "force-dynamic";

const statusLabel: Record<string, string> = {
  PENDING: "회수 대기", PROCESSING: "처리 중", REMOVED: "회수 완료",
  FAILED: "재시도 대기", MANUAL_REQUIRED: "인스타그램 수동 삭제 필요",
};
// 회수 대상 채널(영문 코드) → 화면 이름
const channelLabel: Record<string, string> = { GALLERY: "갤러리", INSTAGRAM: "인스타그램" };

export default async function MediaRevocationsPage() {
  await requireAdmin();
  const jobs = await listMediaRevocationJobs();
  return (
    <main className="space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-gray-900 dark:text-white">사진 공개 회수 관리</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">동의가 철회된 학생의 갤러리는 자동 비공개되고, 인스타그램은 관리자 확인 후 완료 처리합니다.</p>
        </div>
        <form action={async () => { "use server"; await runMediaRevocationQueue(); }}><button className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white">대기 작업 처리</button></form>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-300"><tr>
            <th className="p-3">상태</th><th className="p-3">채널</th><th className="p-3">학생</th><th className="p-3">게시 초안</th><th className="p-3">시도</th><th className="p-3">안내</th><th className="p-3">처리</th>
          </tr></thead>
          <tbody>{jobs.map((job) => <tr key={job.id} className="border-t border-gray-100 dark:border-gray-800">
            <td className="p-3 font-bold">{statusLabel[job.status] ?? "상태 확인 필요"}</td><td className="p-3">{channelLabel[job.channel] ?? "채널 확인 필요"}</td>
            {/* 원장이 "어느 학생인지" 바로 알아볼 수 있게 이름/반을 표시하고, UUID는 화면에서 뺀다 */}
            <td className="p-3">
              <span className="block font-bold text-gray-900 dark:text-white">{job.studentName ?? "학생 정보 없음"}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">{job.className ?? (job.studentName ? "반 미배정" : "삭제된 학생")}</span>
            </td>
            <td className="p-3 text-xs text-gray-700 dark:text-gray-200">{job.draftTitle?.trim() || "제목 없는 게시 초안"}</td>
            <td className="p-3">{job.attempts}</td><td className="max-w-xs p-3 text-xs text-gray-600 dark:text-gray-300">
              <span className="block">{job.lastError ? adminMessageText(job.lastError, "처리하지 못했습니다. «대기 작업 처리»로 다시 시도해 주세요.") : "-"}</span>
            </td>
            <td className="p-3">{job.status === "MANUAL_REQUIRED" ? <form action={confirmInstagramMediaRemoved} className="space-y-2">
              <input type="hidden" name="jobId" value={job.id} />
              {job.resourceUrl && /^https:\/\//.test(job.resourceUrl) && <a href={job.resourceUrl} target="_blank" rel="noreferrer" className="block text-xs font-bold text-orange-700 underline">인스타그램 게시물 확인</a>}
              <input name="evidence" required minLength={5} placeholder="삭제 확인 근거" className="w-44 rounded-md border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800" />
              <button className="block rounded-md border border-gray-300 px-3 py-1.5 font-bold dark:border-gray-600">외부 삭제 확인</button>
            </form> : "-"}</td>
          </tr>)}</tbody>
        </table>
        {jobs.length === 0 && <p className="p-8 text-center text-sm text-gray-500">회수 작업이 없습니다.</p>}
      </div>
    </main>
  );
}
