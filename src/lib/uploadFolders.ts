/**
 * 공용 업로드 API(/api/upload)가 받는 저장 폴더 목록 — 순수 파일(테스트가 그대로 불러 쓴다).
 *
 * 2026-11-14 사진·인스타 점검: 예전에는 요청이 보낸 folder 값을 그대로 경로에 붙였다.
 * "../" 같은 값으로 다른 위치에 쓰거나, 아무 이름의 폴더를 만들 수 있었다. 이제 아래 목록에 있는 값만 받는다.
 *
 * ⚠️ 화면에서 새 folder 값을 쓰려면 여기에 먼저 추가한다. 빠지면 그 화면의 업로드가 400 으로 거절된다.
 *    tests/upload-folder-allowlist.test.mjs 가 «화면이 쓰는 값 ⊆ 이 목록»을 검사한다.
 */
export const UPLOAD_FOLDERS = [
  "coaches", // 코치 사진(관리자 코치 화면·페이지 빌더 이미지 — folder 를 안 보내면 이 값)
  "gallery", // 관리자 갤러리 새 게시물
  "notices", // 공지 첨부·공지 본문 이미지
  "class-logs", // 수업 일지 사진
  "quick-post", // 사진 빠른 업로드
  "editor", // 글 편집기(RichTextEditor) 기본값
] as const;

export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

/** folder 를 보내지 않은 옛 호출부(코치 사진·페이지 빌더)를 위한 기본값. */
export const DEFAULT_UPLOAD_FOLDER: UploadFolder = "coaches";

/**
 * 요청의 folder 값을 허용 목록으로 거른다.
 * - 비어 있으면 기본값(coaches) — 기존 동작 그대로
 * - 목록에 없으면 null(호출한 쪽이 400 으로 거절한다). 비슷한 이름으로 고쳐 주지 않는다.
 */
export function resolveUploadFolder(value: unknown): UploadFolder | null {
  if (value === null || value === undefined || value === "") return DEFAULT_UPLOAD_FOLDER;
  if (typeof value !== "string") return null;
  return (UPLOAD_FOLDERS as readonly string[]).includes(value) ? (value as UploadFolder) : null;
}

/**
 * 이 계정이 공용 업로드를 쓸 수 있는가 — 관리자 화면이나 선생님 화면이 열린 사람만.
 * 기사님 전용 계정(운행 화면만 열림)은 사진을 올리는 화면이 없으므로 거절한다.
 */
export function canUseSharedUpload(roles: { admin: boolean; teacher: boolean }): boolean {
  return roles.admin || roles.teacher;
}
