/**
 * 프로필 사진(학생·학부모)의 «순수 규칙» 모음 — 외부 의존성 0.
 *
 * 왜 따로 두나?
 * - 경로 규칙·형식·크기 상한은 서버(API)·화면(올리기 전 검사)·테스트가 똑같이 써야 한다.
 * - 서버 전용 코드(서비스 롤 키·sharp)가 브라우저 묶음으로 끌려가지 않게, 여기에는 계산만 둔다.
 *
 * 핵심 원칙: **경로는 서버가 만든다.** 화면이 보낸 값으로 경로를 받지 않는다.
 *           DB 에서 읽은 경로도 «그 주인의 폴더인지» 다시 확인한 뒤에만 쓴다.
 */

/** 비공개 버킷 이름 — migration 20261115010000_profile_photo 가 만든다(public = false) */
export const PROFILE_PHOTO_BUCKET = "profile-private";

/** 올릴 수 있는 형식 — JPEG·PNG·WebP (움직이는 GIF·SVG·HEIC 는 받지 않는다) */
export const PROFILE_PHOTO_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** sharp 가 읽어 낸 «실제» 형식 이름(요청이 적어 보낸 file.type 은 믿지 않는다) */
export const PROFILE_PHOTO_ALLOWED_FORMATS = ["jpeg", "png", "webp"] as const;

/** 업로드 상한 3MB — 화면이 먼저 줄여서 보내므로 보통 1MB 를 넘지 않는다 */
export const PROFILE_PHOTO_MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** 저장하는 두 크기(정사각형, px) — 큰 것 512, 작은 것 128 */
export const PROFILE_PHOTO_LARGE_PX = 512;
export const PROFILE_PHOTO_SMALL_PX = 128;

/** 화면 안내 한 줄(누가 볼 수 있는지) — 화면과 테스트가 같은 문장을 쓴다 */
export const PROFILE_PHOTO_NOTICE = "사진은 학부모님과 담당 선생님·학원 관리자에게만 보입니다.";

export type ProfilePhotoOwnerKind = "student" | "user";
export type ProfilePhotoOwner = { kind: ProfilePhotoOwnerKind; id: string };

/** 주인 종류 → 버킷 안 폴더 이름 */
const FOLDER: Record<ProfilePhotoOwnerKind, string> = { student: "students", user: "users" };

/** 주인 id 로 쓸 수 있는 글자 — 영문·숫자·`_`·`-` 만(`/`·`.`·`..` 이 들어갈 수 없다) */
const OWNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 파일 이름 = 서버가 만든 UUID(소문자) */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProfilePhotoOwnerId(id: unknown): id is string {
  return typeof id === "string" && OWNER_ID.test(id);
}

/**
 * 큰 사진(512px) 경로를 만든다 — `students/{학생 id}/{uuid}.jpg` · `users/{사용자 id}/{uuid}.jpg`.
 * id·uuid 가 규칙에 맞지 않으면 오류(그럴듯한 경로를 추측해 만들지 않는다).
 */
export function buildProfilePhotoPath(owner: ProfilePhotoOwner, uuid: string): string {
  if (!FOLDER[owner.kind] || !isProfilePhotoOwnerId(owner.id) || !UUID.test(uuid)) {
    throw new Error("INVALID_PROFILE_PHOTO_PATH");
  }
  return `${FOLDER[owner.kind]}/${owner.id}/${uuid}.jpg`;
}

/** 큰 사진 경로 → 작은 사진(128px) 경로 — 같은 이름 뒤에 `-s` */
export function smallProfilePhotoPath(path: string): string {
  return path.replace(/\.jpg$/, "-s.jpg");
}

/**
 * 저장된 경로가 «이 주인의 큰 사진 경로»가 맞는지 확인한다.
 * - 남의 폴더(`students/다른아이/…`)·`..`·대소문자가 다른 폴더·작은 사진 경로·다른 확장자는 전부 거부.
 * - 내려받기·지우기 직전에 항상 부른다(DB 값이 잘못돼도 남의 파일을 건드리지 않게).
 */
export function isValidProfilePhotoPath(path: unknown, owner: ProfilePhotoOwner): path is string {
  if (typeof path !== "string" || !FOLDER[owner.kind] || !isProfilePhotoOwnerId(owner.id)) return false;
  const parts = path.split("/");
  if (parts.length !== 3) return false;
  const [folder, ownerId, file] = parts;
  if (folder !== FOLDER[owner.kind] || ownerId !== owner.id) return false;
  if (!file.endsWith(".jpg")) return false;
  return UUID.test(file.slice(0, -".jpg".length));
}

/** 올리기 전 검사 결과 — 통과면 null, 아니면 학부모에게 보일 안내 문장 */
export function profilePhotoUploadProblem(file: { type: string; size: number }): string | null {
  if (!(PROFILE_PHOTO_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    return "사진은 JPG, PNG, WebP 만 올릴 수 있어요.";
  }
  if (!Number.isFinite(file.size) || file.size <= 0) return "사진 파일이 비어 있어요.";
  if (file.size > PROFILE_PHOTO_MAX_UPLOAD_BYTES) return "사진이 너무 커요. 3MB 이하 사진을 올려 주세요.";
  return null;
}

/** sharp 가 읽어 낸 형식이 허용 형식인가 */
export function isAllowedProfilePhotoFormat(format: unknown): boolean {
  return typeof format === "string" && (PROFILE_PHOTO_ALLOWED_FORMATS as readonly string[]).includes(format);
}

/**
 * 캐시 버전 문자열 — 사진을 바꾼 시각을 짧은 글자로.
 * 사진 주소 뒤 `?v=` 에 붙여, 사진을 바꾸면 주소가 달라져 브라우저가 새 사진을 받는다.
 * 사진이 없으면(시각 없음·잘못된 값) null → 화면은 이름 첫 글자를 그린다.
 */
export function profilePhotoVersion(updatedAt: Date | string | number | null | undefined): string | null {
  if (updatedAt === null || updatedAt === undefined || updatedAt === "") return null;
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.floor(ms).toString(36);
}

/**
 * 조회 SQL 조각 — «사진이 있을 때만» 바꾼 시각을 고른다(사진을 지우면 시각만 남으므로 경로도 함께 본다).
 * alias 는 코드에 적힌 표 별칭만 받는다(사용자 입력 금지).
 */
export function profilePhotoUpdatedAtSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("INVALID_PROFILE_PHOTO_ALIAS");
  return `CASE WHEN ${alias}."photoPath" IS NOT NULL THEN ${alias}."photoUpdatedAt" END`;
}

/** 버전 문자열로 쓸 수 있는 값만(주소에 그대로 붙으므로 영문 소문자·숫자만) */
function cleanVersion(version: string | null | undefined): string | null {
  return typeof version === "string" && /^[0-9a-z]{1,16}$/.test(version) ? version : null;
}

/**
 * 사진 주소 — 권한을 확인하는 조회 API 주소다(저장소 주소가 아니다).
 * 버전이 없으면(= 사진 없음) null.
 */
export function profilePhotoUrl(owner: ProfilePhotoOwner, version: string | null | undefined, small = false): string | null {
  const v = cleanVersion(version);
  if (!v || !isProfilePhotoOwnerId(owner.id)) return null;
  const base = owner.kind === "student" ? "/api/profile-photo/student/" : "/api/profile-photo/user/";
  return `${base}${owner.id}?v=${v}${small ? "&s=1" : ""}`;
}

/** 화면 크기(px) → 작은 사진으로 충분한가(64px 까지는 128px 사진이면 2배 화면에서도 선명하다) */
export function smallProfilePhotoIsEnough(sizePx: number): boolean {
  return sizePx * 2 <= PROFILE_PHOTO_SMALL_PX;
}
