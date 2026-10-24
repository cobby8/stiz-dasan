import { revalidatePath, revalidateTag } from "next/cache";

// 수강 상태가 바뀌었을 때 비울 관리자 캐시.
// 관리자 즉시 변경(admin.ts updateEnrollmentStatus)이 쓰는
// revalidateStudentAdminCaches + revalidateClassAdminCaches + revalidateFinanceCaches 와 같은 범위다.
// (그 함수들은 admin.ts 안의 비공개 함수라 가져올 수 없어 태그 문자열을 맞춰 둔다. 한쪽을 바꾸면 같이 바꾼다.)
export const ENROLLMENT_STATUS_CACHE_TAGS = [
  "admin-students", "admin-student-options", "admin-waitlist", "admin-makeup",
  "admin-dashboard", "admin-finance", "admin-stats", "admin-classes", "admin-apply",
] as const;

/** 크론·승인 액션이 휴원·퇴원을 사이트에 적용했을 때 호출한다. */
export function revalidateEnrollmentStatusCaches() {
  for (const tag of ENROLLMENT_STATUS_CACHE_TAGS) revalidateTag(tag, { expire: 0 });
  revalidatePath("/admin/students");
  revalidatePath("/admin/classes");
  revalidatePath("/admin/finance");
  revalidatePath("/admin/stats");
  revalidatePath("/admin/enrollment-changes");
}
