import { randomUUID } from "crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeProfilePhotoFiles, removeStoredProfilePhotoFiles, takeProfilePhotoPath } from "./cleanup";
import {
  PROFILE_PHOTO_BUCKET,
  PROFILE_PHOTO_LARGE_PX,
  PROFILE_PHOTO_SMALL_PX,
  buildProfilePhotoPath,
  isAllowedProfilePhotoFormat,
  isValidProfilePhotoPath,
  profilePhotoVersion,
  smallProfilePhotoPath,
  type ProfilePhotoOwner,
  type ProfilePhotoOwnerKind,
} from "./rules";

/**
 * 프로필 사진의 서버 작업(다시 만들기 · 저장 · 지우기 · 읽기).
 *
 * ⚠️ 이 파일은 **권한을 보지 않는다.** 부르는 쪽(API)이 «이 사람이 이 주인의 사진을 다뤄도 되는가»를
 *    먼저 확인한 뒤에만 부른다(권한 판정은 ./access.ts 한 곳).
 *
 * 저장소는 수업 사진과 같은 방식 — 서비스 롤 클라이언트로 비공개 버킷에만 넣고, 공개 주소를 만들지 않는다.
 */

/** 사진 파일을 읽지 못했을 때(깨진 파일·허용하지 않는 형식) — API 가 400 으로 바꿔 답한다 */
export class ProfilePhotoUnreadableError extends Error {
  constructor() {
    super("PROFILE_PHOTO_UNREADABLE");
    this.name = "ProfilePhotoUnreadableError";
  }
}

/** 표 이름은 코드에 적힌 두 값뿐이다(사용자 입력이 SQL 식별자 자리에 들어가지 않는다) */
const TABLE: Record<ProfilePhotoOwnerKind, string> = { student: `"Student"`, user: `"User"` };

/**
 * 올라온 파일을 512px·128px 정사각형 JPEG 두 장으로 다시 만든다.
 * - rotate(): 휴대폰 사진의 «눕혀 찍힘» 정보를 실제 방향으로 돌려 준다.
 * - 다시 인코딩하면서 EXIF(촬영 위치·기기 정보)가 빠진다 — API 를 직접 불러도 위치 정보가 남지 않는다.
 * - 형식 판정은 요청이 적어 보낸 file.type 이 아니라 **sharp 가 실제로 읽어 낸 형식**으로 한다.
 */
export async function encodeProfilePhoto(input: Buffer): Promise<{ large: Buffer; small: Buffer }> {
  try {
    const source = sharp(input, { limitInputPixels: 40_000_000 });
    const meta = await source.metadata();
    if (!isAllowedProfilePhotoFormat(meta.format)) throw new ProfilePhotoUnreadableError();
    const large = await source
      .rotate()
      // 투명 배경(PNG·WebP)은 흰색으로 채운다 — JPEG 는 투명이 없어 그냥 바꾸면 검게 나온다
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(PROFILE_PHOTO_LARGE_PX, PROFILE_PHOTO_LARGE_PX, { fit: "cover" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    // 작은 것은 이미 돌려 놓은 큰 사진에서 줄인다(방향 정보가 이미 반영된 상태)
    const small = await sharp(large)
      .resize(PROFILE_PHOTO_SMALL_PX, PROFILE_PHOTO_SMALL_PX, { fit: "cover" })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return { large, small };
  } catch {
    // sharp 가 못 읽는 파일(이름만 .jpg 인 다른 파일 등)은 전부 같은 오류로
    throw new ProfilePhotoUnreadableError();
  }
}

/**
 * 새 사진을 저장한다. 순서: ① 다시 만들기 → ② 새 파일 2개 올리기 → ③ DB 경로 갱신 → ④ 옛 파일 2개 지우기.
 * - ②·③이 실패하면 방금 올린 파일을 치우고 오류(DB 는 옛 사진 그대로).
 * - ④가 실패해도 응답은 성공이다(남은 파일의 버킷 경로를 기록 — 옛 파일이 남을 뿐 화면은 새 사진을 본다).
 * 돌려주는 값 = 캐시 버전(사진 주소 뒤 ?v=).
 */
export async function saveProfilePhoto(owner: ProfilePhotoOwner, input: Buffer): Promise<{ version: string | null }> {
  const { large, small } = await encodeProfilePhoto(input);
  // 경로는 서버가 만든다 — 주인 id 는 권한 확인을 통과한 값, 파일 이름은 새 UUID
  const path = buildProfilePhotoPath(owner, randomUUID());
  const smallPath = smallProfilePhotoPath(path);
  const storage = createAdminClient().storage.from(PROFILE_PHOTO_BUCKET);
  const options = { contentType: "image/jpeg", cacheControl: "31536000", upsert: false };

  const first = await storage.upload(path, large, options);
  if (first.error) throw new Error("사진 저장소 업로드에 실패했습니다.");
  const second = await storage.upload(smallPath, small, options);
  if (second.error) {
    await removeStoredProfilePhotoFiles([path], "upload-rollback");
    throw new Error("사진 저장소 업로드에 실패했습니다.");
  }

  let rows: Array<{ oldPath: string | null; photoUpdatedAt: Date | string | null }>;
  try {
    // 옛 경로를 읽으면서 같은 문장에서 바꾼다(동시에 두 번 올려도 옛 경로를 놓치지 않게 행을 잠근다)
    rows = await prisma.$queryRawUnsafe<Array<{ oldPath: string | null; photoUpdatedAt: Date | string | null }>>(
      `WITH old AS (SELECT id, "photoPath" FROM ${TABLE[owner.kind]} WHERE id = $2 FOR UPDATE)
       UPDATE ${TABLE[owner.kind]} t SET "photoPath" = $1, "photoUpdatedAt" = NOW()
         FROM old WHERE t.id = old.id
       RETURNING old."photoPath" AS "oldPath", t."photoUpdatedAt" AS "photoUpdatedAt"`,
      path,
      owner.id,
    );
  } catch (error) {
    await removeStoredProfilePhotoFiles([path, smallPath], "db-rollback");
    throw error;
  }
  if (!rows[0]) {
    // 그 사이 행이 사라졌다 — 주인 없는 파일을 남기지 않는다
    await removeStoredProfilePhotoFiles([path, smallPath], "db-rollback");
    throw new Error("사진을 저장하지 못했습니다.");
  }

  await removeProfilePhotoFiles(owner, rows[0].oldPath, "replace-old");
  return { version: profilePhotoVersion(rows[0].photoUpdatedAt) };
}

/**
 * 사진을 지운다 — DB 경로를 먼저 비우고(화면에서 바로 사라진다) 파일 2개를 지운다.
 * 파일 삭제 실패는 기록만 한다. 사진이 원래 없었으면 false.
 */
export async function deleteProfilePhoto(owner: ProfilePhotoOwner): Promise<boolean> {
  const oldPath = await takeProfilePhotoPath(owner);
  await removeProfilePhotoFiles(owner, oldPath, "delete");
  return Boolean(oldPath);
}

/**
 * 사진 파일을 읽는다(조회 API 용). 사진이 없거나 경로가 이 주인의 것이 아니면 null.
 * 학생은 병합돼 사라진 옛 학생이면 읽지 않는다.
 */
export async function readProfilePhoto(owner: ProfilePhotoOwner, small: boolean): Promise<ArrayBuffer | null> {
  const merged = owner.kind === "student" ? ` AND "mergedIntoStudentId" IS NULL` : "";
  const rows = await prisma.$queryRawUnsafe<Array<{ photoPath: string | null }>>(
    `SELECT "photoPath" FROM ${TABLE[owner.kind]} WHERE id = $1${merged} LIMIT 1`,
    owner.id,
  );
  const path = rows[0]?.photoPath;
  if (!isValidProfilePhotoPath(path, owner)) return null;
  const { data, error } = await createAdminClient()
    .storage.from(PROFILE_PHOTO_BUCKET)
    .download(small ? smallProfilePhotoPath(path) : path);
  if (error || !data) return null;
  return data.arrayBuffer();
}
