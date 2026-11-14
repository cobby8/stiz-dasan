import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PROFILE_PHOTO_BUCKET,
  isValidProfilePhotoPath,
  smallProfilePhotoPath,
  type ProfilePhotoOwner,
  type ProfilePhotoOwnerKind,
} from "./rules";

/**
 * 프로필 사진 «치우기» — 학생 삭제·계정 탈퇴·학생 병합·사진 교체가 같이 쓴다.
 *
 * 왜 server.ts 와 나눴나: 삭제·탈퇴 코드가 사진 다시 만들기(sharp)까지 끌고 오지 않게 가벼운 파일로 뒀다.
 *
 * 쓰는 순서(개인정보 — 사진이 주인 없이 남지 않게):
 *   ① DB 작업 **전에(또는 같은 트랜잭션 안에서)** 경로를 읽어 둔다 — readProfilePhotoPath / takeProfilePhotoPath
 *   ② DB 작업이 **성공한 뒤에** 파일을 지운다 — removeProfilePhotoFiles
 *   파일 삭제는 실패해도 오류를 던지지 않는다(삭제·탈퇴·병합 자체를 실패시키지 않는다).
 *   대신 «어느 파일이 남았는지» 버킷 경로를 기록해 나중에 찾아 지울 수 있게 한다.
 */

/** 표 이름은 코드에 적힌 두 값뿐이다(사용자 입력이 SQL 식별자 자리에 들어가지 않는다) */
const TABLE: Record<ProfilePhotoOwnerKind, string> = { student: `"Student"`, user: `"User"` };

/** prisma 또는 트랜잭션(tx) — 조회 한 가지만 쓴다 */
type Db = { $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T> };

/**
 * 저장소 파일을 지운다. 실패는 기록만 한다.
 * 기록에는 **버킷 경로**(주인 종류·id 가 들어 있다)를 남긴다 — 남은 파일을 나중에 찾아 지우기 위한 유일한 단서다.
 */
export async function removeStoredProfilePhotoFiles(paths: string[], label: string): Promise<void> {
  if (paths.length === 0) return;
  const leftover = () => console.error("[profile-photo] 파일 삭제 실패 — 남은 파일", label, paths.map((path) => `${PROFILE_PHOTO_BUCKET}/${path}`).join(", "));
  try {
    const { error } = await createAdminClient().storage.from(PROFILE_PHOTO_BUCKET).remove(paths);
    if (error) leftover();
  } catch {
    leftover();
  }
}

/** 큰 사진 경로 → 지울 파일 2개(큰 것·작은 것). 이 주인의 경로가 아니면 아무것도 지우지 않는다 */
export function profilePhotoFilesOf(path: unknown, owner: ProfilePhotoOwner): string[] {
  return isValidProfilePhotoPath(path, owner) ? [path, smallProfilePhotoPath(path)] : [];
}

/**
 * 주인의 사진 파일(큰 것·작은 것)을 지운다 — DB 작업이 성공한 **뒤에** 부른다.
 * path 는 DB 에서 읽어 둔 값. 이 주인의 폴더가 아니면 건드리지 않는다. 절대 오류를 던지지 않는다.
 */
export async function removeProfilePhotoFiles(owner: ProfilePhotoOwner, path: string | null | undefined, label: string): Promise<void> {
  if (!path) return;
  const files = profilePhotoFilesOf(path, owner);
  if (files.length === 0) {
    // 경로가 이 주인의 것이 아니다 — 남의 파일일 수 있어 지우지 않고 기록만
    console.error("[profile-photo] 지우지 않은 경로(주인과 맞지 않음)", label, `${owner.kind}:${owner.id}`, `${PROFILE_PHOTO_BUCKET}/${path}`);
    return;
  }
  await removeStoredProfilePhotoFiles(files, label);
}

/** 지금 저장된 사진 경로를 읽는다(행을 지우기 **전에** 부른다). 사진이 없으면 null */
export async function readProfilePhotoPath(owner: ProfilePhotoOwner, db: Db = prisma): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ photoPath: string | null }>>(
    `SELECT "photoPath" FROM ${TABLE[owner.kind]} WHERE id = $1 LIMIT 1`,
    owner.id,
  );
  return rows[0]?.photoPath ?? null;
}

/**
 * 사진 경로를 DB 에서 비우고 옛 경로를 돌려준다 — 행이 남는 경우(계정 탈퇴 = 익명화)에 **트랜잭션 안에서** 부른다.
 * 돌려받은 경로는 트랜잭션이 확정된 뒤 removeProfilePhotoFiles 로 지운다.
 */
export async function takeProfilePhotoPath(owner: ProfilePhotoOwner, db: Db = prisma): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ oldPath: string | null }>>(
    `WITH old AS (SELECT id, "photoPath" FROM ${TABLE[owner.kind]} WHERE id = $1 FOR UPDATE)
     UPDATE ${TABLE[owner.kind]} t SET "photoPath" = NULL, "photoUpdatedAt" = NOW()
       FROM old WHERE t.id = old.id
     RETURNING old."photoPath" AS "oldPath"`,
    owner.id,
  );
  return rows[0]?.oldPath ?? null;
}
