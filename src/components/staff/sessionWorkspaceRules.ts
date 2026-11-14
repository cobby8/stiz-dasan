/**
 * 선생님 «수업 한 화면»(2026-11-15 원장 지시) 순수 규칙 — DB·화면 없이 «입력 → 결과»만 계산한다.
 * tests/staff-session-workspace.test.mjs 가 실제로 실행한다(다른 모듈을 import 하지 않는다).
 */

/** 수업 단계 — 기록이 없거나 시작 전이면 PLANNED */
export type WorkspacePhase = "PLANNED" | "IN_PROGRESS" | "COMPLETED";

export function workspacePhase(status: string | null | undefined): WorkspacePhase {
  if (status === "IN_PROGRESS") return "IN_PROGRESS";
  if (status === "COMPLETED") return "COMPLETED";
  return "PLANNED";
}

/** 통합 글칸의 저장 대상 — 수업 전 = 미리 쓴 내용(선생님만 봄), 수업 중·후 = 수업 내용(종료·발행 뒤 학부모가 봄) */
export type LessonTextTarget = "plannedContent" | "content";

export type LessonTextState = {
  /** 글칸에 보여 줄 값 */
  value: string;
  /** 저장 버튼이 쓰는 곳 */
  saveTarget: LessonTextTarget;
  /** 미리 쓴 내용을 «불러와 채운» 상태인가(아직 저장 전 — 자동 저장하지 않는다) */
  prefilledFromPlan: boolean;
};

const text = (value: string | null | undefined) => (typeof value === "string" ? value.trim() : "");

/**
 * 수업 내용 = 피드 통합 글칸의 채움 규칙.
 * - 수업 전: 미리 쓴 내용을 보여 주고 미리 쓴 내용으로 저장한다(예전 «수업 피드»로 먼저 써 둔 한 줄만 있으면 그것을 보여 준다).
 * - 수업 중·후: 저장된 수업 내용이 있으면 그것. 없고 미리 쓴 내용이 있으면 «채워서» 보여 주되 저장은 선생님이 누를 때만.
 */
export function resolveLessonText(input: {
  status: string | null | undefined;
  content: string | null | undefined;
  plannedContent: string | null | undefined;
}): LessonTextState {
  const content = text(input.content);
  const planned = text(input.plannedContent);
  if (workspacePhase(input.status) === "PLANNED") {
    return { value: planned || content, saveTarget: "plannedContent", prefilledFromPlan: false };
  }
  if (content) return { value: content, saveTarget: "content", prefilledFromPlan: false };
  if (planned) return { value: planned, saveTarget: "content", prefilledFromPlan: true };
  return { value: "", saveTarget: "content", prefilledFromPlan: false };
}

/** 미리 쓴 내용을 불러와 채웠을 때 글칸 아래에 보이는 한 줄 */
export const PLAN_PREFILL_NOTICE = "미리 쓴 내용을 불러왔어요. 저장하면 수업 종료 뒤 학부모에게 보입니다";

export type AttendanceCounts = { PRESENT: number; LATE: number; ABSENT: number; UNCHECKED: number };

/** 출석부 칸을 접었을 때의 요약 한 줄 */
export function attendanceSummaryLine(counts: AttendanceCounts): string {
  return `출석 ${counts.PRESENT} · 지각 ${counts.LATE} · 결석 ${counts.ABSENT} · 미확인 ${counts.UNCHECKED}`;
}

/** 줄 안내 중 «저장 실패»(error)만 센다 — 건너뜀·참고 안내(notice)는 실패가 아니다 */
export function countRowErrors(rowNotices: Record<string, { tone: string }>): number {
  return Object.values(rowNotices).filter((notice) => notice.tone === "error").length;
}

/**
 * 접힌 출석부 머리줄에 보일 저장 상태 — 칸을 접어도 «저장 중»·«저장 실패 n»이 사라지지 않게.
 * 둘 다 없으면 빈 문자열(표시 없음).
 */
export function attendanceSaveBadge(input: { savingCount: number; errorCount: number; bulkBusy?: boolean }): {
  saving: boolean;
  failed: number;
  text: string;
} {
  const saving = input.savingCount > 0 || input.bulkBusy === true;
  const failed = Math.max(0, input.errorCount);
  const parts: string[] = [];
  if (saving) parts.push("저장 중");
  if (failed > 0) parts.push(`저장 실패 ${failed}`);
  return { saving, failed, text: parts.join(" · ") };
}

type PickedFile = { type: string; name: string };

const VIDEO_EXTENSION = /\.(mp4|mov|webm|m4v)$/i;
const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;

/**
 * [갤러리]에서 고른 파일을 사진·영상 올리기로 나눈다.
 * - 사진은 여러 장(장수 제한은 사진 올리기 쪽 기존 규칙), 영상은 한 번에 1개(나머지는 extraVideos 로 알린다).
 * - 종류를 알 수 없는 파일은 unsupported 로 센다.
 */
export function splitGalleryFiles<T extends PickedFile>(files: readonly T[]): {
  images: T[];
  video: T | null;
  extraVideos: number;
  unsupported: number;
} {
  const images: T[] = [];
  const videos: T[] = [];
  let unsupported = 0;
  for (const file of files) {
    const type = (file.type || "").toLowerCase();
    if (type.startsWith("video/") || (!type && VIDEO_EXTENSION.test(file.name))) videos.push(file);
    else if (type.startsWith("image/") || (!type && IMAGE_EXTENSION.test(file.name))) images.push(file);
    else unsupported += 1;
  }
  return { images, video: videos[0] ?? null, extraVideos: Math.max(0, videos.length - 1), unsupported };
}

/** 갤러리에서 고른 결과 중 «올리지 않은 것» 안내 — 없으면 빈 문자열 */
export function galleryLeftoverNotice(input: { extraVideos: number; unsupported: number }): string {
  const parts: string[] = [];
  if (input.extraVideos > 0) parts.push(`영상은 한 번에 1개만 올립니다(${input.extraVideos}개는 빠졌어요).`);
  if (input.unsupported > 0) parts.push(`올릴 수 없는 파일 ${input.unsupported}개는 빠졌어요.`);
  return parts.join(" ");
}

type RosterKey = { id: string; studentId: string | null; name: string };
type PersonKey = { id: string; name: string };

/**
 * 출석부 줄에 맞는 학생 정보를 찾는다.
 * - 정규: 줄의 학생 id = 학생 정보 id
 * - 특강: 줄 id 는 좌석이라 전환된 학생 id(studentId)로 찾고, 미전환 신청자는 이름이 «하나뿐일 때만» 이름으로 찾는다(동명이인은 잇지 않는다).
 */
export function findRosterPerson<P extends PersonKey>(row: RosterKey, people: readonly P[]): P | null {
  const byId = people.find((person) => person.id === row.studentId || person.id === row.id);
  if (byId) return byId;
  const sameName = people.filter((person) => person.name === row.name);
  return sameName.length === 1 ? sameName[0] : null;
}

/** 수업 종료 확인 창에 보이는 경고 — 미리 쓴 내용이 채워진 채(고치거나 저장한 적 없이) 종료하려 할 때 */
export const PLAN_PREFILL_END_NOTICE = "미리 쓴 내용을 불러왔어요. 이대로 종료하면 학부모에게 보입니다 — 고치거나 지울 수 있어요";

/**
 * 글칸의 값이 아직 «미리 쓴 내용을 채운 그대로»인가.
 * prefillSource = 채울 때 넣은 글(채운 적이 없거나 이미 저장했으면 null). 한 글자라도 고치거나 지우면 false.
 */
export function isUntouchedPrefill(prefillSource: string | null, value: string): boolean {
  return prefillSource !== null && value === prefillSource;
}

/**
 * 수업 종료 때 보낼 한 줄 — 글칸에 보이는 값 그대로다(선생님이 지웠으면 빈 값 = 학부모에게 아무 글도 안 나간다).
 * 미리 쓴 내용은 «글칸에 남아 있을 때만» 나간다.
 */
export function reportForFinish(value: string): string {
  return value.trim();
}

/**
 * 수업 줄을 접어도 줄 머리에 보일 저장 상태(홈) — «저장 중»(중립색)과 «저장 실패»(위험색)를 따로 돌려준다.
 * 출석뿐 아니라 메모·수업 내용 저장 실패도 넣는다.
 */
export function workspaceSaveStatus(input: {
  attendance: { saving: boolean; failed: number };
  memoStatus: string;
  lessonSaveFailed: boolean;
}): { saving: string; failed: string } {
  const failed: string[] = [];
  if (input.attendance.failed > 0) failed.push(`출석 저장 실패 ${input.attendance.failed}`);
  if (input.memoStatus === "error") failed.push("메모 저장 실패");
  if (input.lessonSaveFailed) failed.push("수업 내용 저장 실패");
  return {
    saving: input.attendance.saving || input.memoStatus === "saving" ? "저장 중" : "",
    failed: failed.join(" · "),
  };
}

type RetainLesson = { scheduleKey: string; sessionId: string | null; sessionStatus: string | null };

/**
 * 홈이 들고 있는 «펼친 수업 본문» 중 계속 둘 것만 남긴다.
 * - 진행 중 수업: 줄을 접어도 둔다(출석 저장 중·실패 표시, 쓰던 메모를 잃지 않게).
 * - 그 밖(끝난 수업): 펼쳐져 있을 때만 둔다 — 접으면 버리고 다시 펼칠 때 새로 읽는다
 *   (접기 전에 저장한 수업 내용·사진이 옛 값으로 되돌아가 보이지 않게).
 * 바뀐 것이 없으면 받은 객체를 그대로 돌려준다(다시 그리지 않게).
 */
export function retainSessionData<T>(data: Record<string, T>, lessons: readonly RetainLesson[], expandedKey: string | null): Record<string, T> {
  const keep = new Set<string>();
  for (const lesson of lessons) {
    if (!lesson.sessionId) continue;
    if (lesson.sessionStatus === "IN_PROGRESS" || lesson.scheduleKey === expandedKey) keep.add(lesson.sessionId);
  }
  const ids = Object.keys(data);
  if (ids.every((id) => keep.has(id))) return data;
  const next: Record<string, T> = {};
  for (const id of ids) if (keep.has(id)) next[id] = data[id];
  return next;
}

/**
 * [갤러리]에서 고른 것 중 «지금 올릴 수 있는 것»만 보낸다 — 막힌 쪽(시간 밖·이미 올리는 중 등)은 보내지 않고 이유를 알린다.
 */
export function planGalleryUpload<T>(input: {
  images: T[];
  video: T | null;
  photoAvailable: boolean;
  videoAvailable: boolean;
  photoReason?: string | null;
  videoReason?: string | null;
}): { images: T[]; video: T | null; blocked: string } {
  const blocked: string[] = [];
  if (input.images.length > 0 && !input.photoAvailable) blocked.push(input.photoReason || "사진은 지금 올릴 수 없어요.");
  if (input.video && !input.videoAvailable) blocked.push(input.videoReason || "영상은 지금 올릴 수 없어요.");
  return {
    images: input.photoAvailable ? input.images : [],
    video: input.videoAvailable ? input.video : null,
    blocked: blocked.join(" "),
  };
}

type MediaSideState = {
  busy: boolean;
  canUpload: boolean;
  windowMessage: string | null;
  /** 목록(올릴 수 있는지 포함)을 한 번이라도 다 읽었는가 */
  loaded: boolean;
  /** 목록을 읽지 못했을 때의 문구(없으면 빈 문자열) */
  loadError: string;
} | null;

/**
 * 아래 막대의 [사진]·[동영상]이 «눌리지 않는 이유» 한 줄(2026-11-15 원장 점검 — 회색 버튼인데 이유가 안 보였다).
 * - 아직 읽는 중 → «준비 중…» · 읽기 실패 → 안내 + 다시 시도 · 올릴 수 없는 기간 등 → 서버가 준 이유(없으면 기본 문구)
 * - 올릴 수 있거나 올리는 중이면 null(올리는 중 표시는 진행 줄이 따로 한다)
 */
export function mediaBlockReason(kind: "photo" | "video", state: MediaSideState): { text: string; retry: boolean } | null {
  const label = kind === "photo" ? "사진" : "영상";
  if (state?.loadError) {
    // 서버가 준 이유(로그인 만료·권한 없음·잠시 뒤 다시 등)가 있으면 그대로 보인다. 없을 때만 고정 문구.
    const text = state.loadError.trim() || `${label} 정보를 불러오지 못했어요.`;
    // 다시 로그인해야 풀리는 문제·권한 문제는 «다시 시도»가 헛돈다 → 버튼을 붙이지 않는다
    return { text, retry: !/로그인|권한/.test(text) };
  }
  if (!state || !state.loaded) return { text: `${label} 올리기 준비 중…`, retry: false };
  if (state.busy || state.canUpload) return null;
  return { text: state.windowMessage?.trim() || `${label}은 지금 올릴 수 없어요.`, retry: false };
}

/** 본문의 기존 아래 여백이 감당하는 막대 높이(버튼 한 줄 + 안내 한 줄쯤) */
export const MEDIA_BAR_BASE_HEIGHT_PX = 100;

/**
 * 아래 고정 막대가 안내 줄(옛 앱 업데이트·조회 실패 등)로 높아졌을 때 본문 끝에 «더» 띄울 높이(px).
 * 기본 높이까지는 기존 여백이 감당하고, 넘는 만큼만 더한다. 아직 재지 못했으면(0) 더하지 않는다.
 */
export function mediaBarExtraSpace(barHeightPx: number): number {
  if (!Number.isFinite(barHeightPx) || barHeightPx <= 0) return 0;
  return Math.max(0, Math.ceil(barHeightPx) - MEDIA_BAR_BASE_HEIGHT_PX);
}
