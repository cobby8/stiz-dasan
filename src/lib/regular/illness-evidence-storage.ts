// 질병·부상 결석 증빙 사진 저장소 — 비공개 버킷 «absence-evidence»(원장 결정 a6).
//
// 건강 정보라 공개 버킷(uploads)에 올리지 않는다. 파일은 서버(서비스 키)만 읽고,
// 화면에는 권한을 확인한 API(학부모 본인·관리자)가 대신 내려 준다 — 서명 URL·공개 주소를 만들지 않는다.
import sharp from "sharp";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVIDENCE_BUCKET, isAllowedEvidenceFormat, isValidEvidencePath } from "@/lib/regular/illnessCarryRules";

/** 올릴 수 있는 원본 형식(수업 사진과 같은 집합 — gif 제외) */
export const EVIDENCE_ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** 화면이 압축해 보낸 파일 상한(서류 글자가 읽혀야 해서 수업 사진보다 넉넉히) */
export const EVIDENCE_MAX_INPUT_BYTES = 4 * 1024 * 1024;
/** 서버가 다시 인코딩한 결과 상한 = 버킷 파일 크기 제한 */
export const EVIDENCE_MAX_STORED_BYTES = 2 * 1024 * 1024;

/** 실제 형식이 JPG·PNG·WebP 가 아니다 — 라우트가 400 으로 답한다 */
export const EVIDENCE_FORMAT_REJECTED = "EVIDENCE_FORMAT_REJECTED";

let bucketEnsured = false;

/** 버킷이 없으면 비공개로 만든다(있으면 비공개·크기·형식 설정만 다시 맞춘다) */
export async function ensureEvidenceBucket() {
  if (bucketEnsured) return;
  const supabase = createAdminClient();
  const options = { public: false, fileSizeLimit: EVIDENCE_MAX_STORED_BYTES, allowedMimeTypes: ["image/jpeg"] };
  const { error } = await supabase.storage.createBucket(EVIDENCE_BUCKET, options);
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error("증빙 사진 저장소를 준비하지 못했습니다.");
  const { error: updateError } = await supabase.storage.updateBucket(EVIDENCE_BUCKET, options);
  if (updateError) throw new Error("증빙 사진 저장소를 준비하지 못했습니다.");
  bucketEnsured = true;
}

/**
 * 서버에서 JPEG 로 다시 인코딩한다 — API 를 직접 불러도 위치(GPS)·기기 정보(EXIF)가 남지 않게.
 * 서류 사진이라 긴 변 2000px 까지 남긴다.
 */
export async function encodeEvidencePhoto(input: Buffer): Promise<Buffer> {
  // 인코딩 «전»에 실제 형식을 본다(보안 검수 2026-11-14) — 형식 이름만 jpeg 로 속인 SVG·GIF·TIFF 등은 받지 않는다
  const meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  if (!isAllowedEvidenceFormat(meta.format)) throw new Error(EVIDENCE_FORMAT_REJECTED);
  return sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
}

export async function uploadEvidencePhoto(path: string, body: Buffer) {
  if (!isValidEvidencePath(path)) throw new Error("증빙 사진 경로가 올바르지 않습니다.");
  const { error } = await createAdminClient().storage.from(EVIDENCE_BUCKET).upload(path, body, {
    contentType: "image/jpeg", cacheControl: "0", upsert: false,
  });
  if (error) throw new Error("증빙 사진을 저장하지 못했습니다.");
}

export async function downloadEvidencePhoto(path: string): Promise<ArrayBuffer | null> {
  if (!isValidEvidencePath(path)) return null;
  const { data, error } = await createAdminClient().storage.from(EVIDENCE_BUCKET).download(path);
  if (error || !data) return null;
  return data.arrayBuffer();
}

/** 파일 지우기 — 성공(또는 이미 없음)이면 true */
export async function removeEvidencePhoto(bucket: string, path: string): Promise<boolean> {
  if (bucket !== EVIDENCE_BUCKET || !isValidEvidencePath(path)) return false;
  const { error } = await createAdminClient().storage.from(EVIDENCE_BUCKET).remove([path]);
  return !error;
}

/** 사진 응답 머리말 — 브라우저·중간 서버가 건강 정보 사진을 저장해 두지 않게 */
export const EVIDENCE_RESPONSE_HEADERS = {
  "Content-Type": "image/jpeg",
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": "inline",
} as const;
