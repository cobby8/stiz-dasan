import { removeProfilePhotoFiles } from "@/lib/profilePhoto/cleanup";

/**
 * 학생 병합이 **실제로 적용(COMMIT)된 뒤** 흡수된 학생들의 프로필 사진 파일을 지운다(2026-11-15, 개인정보).
 *
 * 왜 엔진(mergePair) 밖에 있나:
 *  - 엔진은 DRY-RUN(전부 실행 → ROLLBACK)에서도 같은 코드가 돈다. 엔진 안에서 파일을 지우면
 *    «미리보기만 했는데 사진이 사라지는» 사고가 난다. 저장소 삭제는 되돌릴 수 없다.
 *  - 그래서 엔진은 DB 경로만 비우고 옛 경로를 결과(loserPhotoPath)와 StudentMergeLog 에 남긴다.
 *
 * 쓰는 법: 병합 실행 스크립트가 COMMIT 직후 `await removeMergedStudentPhotos(pairResults)` 를 부른다.
 *          DRY-RUN·ROLLBACK 에서는 부르지 않는다.
 * 실패해도 오류를 던지지 않는다(병합은 이미 확정됐다) — 남은 파일의 버킷 경로가 기록된다.
 * 돌려주는 값 = 지우기를 시도한 학생 수.
 */
export async function removeMergedStudentPhotos(
  results: ReadonlyArray<{ loser: { id: string }; loserPhotoPath: string | null }>,
): Promise<number> {
  let tried = 0;
  for (const result of results) {
    if (!result.loserPhotoPath) continue;
    tried += 1;
    await removeProfilePhotoFiles({ kind: "student", id: result.loser.id }, result.loserPhotoPath, "student-merge");
  }
  return tried;
}
