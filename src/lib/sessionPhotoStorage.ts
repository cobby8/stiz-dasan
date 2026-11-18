import { createAdminClient } from "@/lib/supabase/admin";
// 파싱/상수는 의존성 없는 sessionPhotoEntries.ts 로 옮겼습니다(클라이언트·테스트에서도 쓰기 위함).
// 기존 import 경로를 깨지 않도록 여기서 그대로 다시 내보냅니다.
import { PRIVATE_SESSION_PHOTO_BUCKET, PUBLIC_GALLERY_BUCKET } from "@/lib/sessionPhotoEntries";

export {
  PRIVATE_SESSION_PHOTO_BUCKET,
  PUBLIC_GALLERY_BUCKET,
  parseSessionPhotoEntries,
  parseStoredSessionPhotos,
} from "@/lib/sessionPhotoEntries";
export type { StoredSessionPhoto, SessionPhotoEntry } from "@/lib/sessionPhotoEntries";

// 보관함(버킷) 확인은 서버가 켜져 있는 동안 한 번만(2026-11-18 속도 개선).
// 왜: 사진 한 장 올릴 때마다 저장소에 «만들기 시도 + 설정 맞추기» 두 번을 물어, 깨어 있는 서버에서도 올리기가 1초를 넘었다.
// 실패한 확인은 기억하지 않는다(다음 올리기가 다시 확인). 올리기가 실패하면 부르는 쪽이 forget 을 불러 다음에 다시 확인하게 한다.
let bucketEnsured: Promise<void> | null = null;

export function ensurePrivateSessionPhotoBucket(): Promise<void> {
  if (bucketEnsured) return bucketEnsured;
  const mine: Promise<void> = configurePrivateSessionPhotoBucket().catch((error) => {
    // 내 확인이 실패했을 때만 지운다 — 그 사이 새로 시작된 다른 확인의 기억은 건드리지 않는다
    if (bucketEnsured === mine) bucketEnsured = null;
    throw error;
  });
  bucketEnsured = mine;
  return mine;
}

/** 보관함 확인 기억을 지운다 — 올리기가 실패했을 때(보관함이 없어졌을 수 있다) 다음 올리기가 다시 확인하도록 */
export function forgetPrivateSessionPhotoBucketCheck() {
  bucketEnsured = null;
}

async function configurePrivateSessionPhotoBucket() {
  const supabase = createAdminClient();
  const { error } = await supabase.storage.createBucket(PRIVATE_SESSION_PHOTO_BUCKET, {
    public: false,
    fileSizeLimit: 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
  const { error: updateError } = await supabase.storage.updateBucket(PRIVATE_SESSION_PHOTO_BUCKET, {
    public: false,
    fileSizeLimit: 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (updateError) throw updateError;
}

export function isValidPrivateSessionPhotoRef(
  media: Record<string, unknown>,
  input: { classId: string; sessionId: string },
) {
  if (media.storageBucket !== PRIVATE_SESSION_PHOTO_BUCKET || typeof media.storagePath !== "string" || typeof media.id !== "string") return false;
  const escapedClass = input.classId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSession = input.sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedPhoto = media.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^staff-sessions/${escapedClass}/${escapedSession}/${escapedPhoto}\\.(jpg|png|webp)$`).test(media.storagePath);
}

export async function materializePrivateMediaJSON(
  draftId: string,
  mediaJSON: string,
  input: { classId: string | null; sessionId: string | null },
) {
  const raw: unknown = JSON.parse(mediaJSON);
  if (!Array.isArray(raw)) return mediaJSON;
  const supabase = createAdminClient();
  const converted = await Promise.all(raw.map(async (item, index) => {
    if (!item || typeof item !== "object") return item;
    const media = item as Record<string, unknown>;
    if (media.visibility !== "PRIVATE" || typeof media.storagePath !== "string") return item;
    if (!input.classId || !input.sessionId || !isValidPrivateSessionPhotoRef(media, { classId: input.classId, sessionId: input.sessionId })) {
      throw new Error("검증되지 않은 비공개 사진 경로입니다.");
    }
    const sourceBucket = PRIVATE_SESSION_PHOTO_BUCKET;
    const extension = media.storagePath.split(".").pop()?.toLowerCase() || "jpg";
    const publicPath = `published/social-drafts/${draftId}/${index}.${extension}`;
    const { data, error: downloadError } = await supabase.storage.from(sourceBucket).download(media.storagePath);
    if (downloadError || !data) throw new Error("비공개 수업 사진을 불러오지 못했습니다.");
    const { error: uploadError } = await supabase.storage.from(PUBLIC_GALLERY_BUCKET).upload(
      publicPath,
      Buffer.from(await data.arrayBuffer()),
      { contentType: data.type || `image/${extension === "jpg" ? "jpeg" : extension}`, cacheControl: "31536000", upsert: true },
    );
    if (uploadError) throw new Error("게시용 사진 사본을 만들지 못했습니다.");
    const publicUrl = supabase.storage.from(PUBLIC_GALLERY_BUCKET).getPublicUrl(publicPath).data.publicUrl;
    return { ...media, url: publicUrl, visibility: "PUBLIC", publishedStorageBucket: PUBLIC_GALLERY_BUCKET, publishedStoragePath: publicPath };
  }));
  return JSON.stringify(converted);
}

export async function removePublishedMediaCopies(draftId: string, mediaJSON: string) {
  const paths = collectPublishedMediaCopyPaths(draftId, mediaJSON);
  if (paths.length === 0) return;
  await removePublishedStoragePaths(paths);
}

export function collectPublishedMediaCopyPaths(draftId: string, mediaJSON: string) {
  let raw: unknown;
  try { raw = JSON.parse(mediaJSON); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const paths = raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const media = item as Record<string, unknown>;
    if (media.publishedStorageBucket !== PUBLIC_GALLERY_BUCKET || typeof media.publishedStoragePath !== "string") return [];
    const prefix = `published/social-drafts/${draftId}/`;
    return media.publishedStoragePath.startsWith(prefix) && !media.publishedStoragePath.includes("..")
      ? [media.publishedStoragePath]
      : [];
  });
  return [...new Set(paths)];
}

export function plannedPublishedMediaCopyPaths(draftId: string, mediaJSON: string) {
  let raw: unknown;
  try { raw = JSON.parse(mediaJSON); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const media = item as Record<string, unknown>;
    if (media.visibility !== "PRIVATE" || typeof media.storagePath !== "string") return [];
    const extension = media.storagePath.split(".").pop()?.toLowerCase();
    return extension && /^(jpg|png|webp)$/.test(extension) ? [`published/social-drafts/${draftId}/${index}.${extension}`] : [];
  });
}

export async function removePublishedStoragePaths(paths: string[]) {
  const safePaths = paths.filter((path) => path.startsWith("published/social-drafts/") && !path.includes(".."));
  if (safePaths.length === 0) return;
  const { error } = await createAdminClient().storage.from(PUBLIC_GALLERY_BUCKET).remove(safePaths);
  if (error) throw new Error("반려된 게시용 사진 사본을 삭제하지 못했습니다.");
}
