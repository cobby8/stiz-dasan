import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizePublicPreviewUrl } from './real-preview-snapshot.mjs';

/** 이미 공개된 사진만 시험 앱 안에 복사합니다. 인증·쿠키·리다이렉트는 사용하지 않습니다. */
export async function cachePublicPreviewImages(snapshot, { directory, fetchImpl = fetch } = {}) {
  if (!directory || path.basename(directory) !== '__public_media') throw new Error('공개 사진 시험 경로를 확인해 주세요.');
  await mkdir(directory, { recursive: true });
  const cache = new Map(); let copied = 0, skipped = 0, bytes = 0;
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  async function image(value) {
    const safe = sanitizePublicPreviewUrl(value);
    if (!safe || safe.startsWith('/')) return safe;
    const url = new URL(safe);
    const allowed = url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/storage/v1/object/public/')
      || ['stiz-dasan.kr', 'www.stiz-dasan.kr', 'images.unsplash.com'].includes(url.hostname);
    if (!allowed) return null;
    if (cache.has(safe)) return cache.get(safe);
    if (copied >= 40 || bytes >= 64 * 1024 * 1024) { skipped++; return null; }
    try {
      const response = await fetchImpl(safe, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(15000) });
      const extension = extensions[response.headers.get('content-type')?.split(';')[0]];
      if (!response.ok || !extension || Number(response.headers.get('content-length') ?? 0) > 5 * 1024 * 1024) throw new Error('이미지 응답 확인');
      const reader = response.body?.getReader(); if (!reader) throw new Error('이미지 없음');
      const parts = []; let size = 0;
      try { while (true) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.length; if (size > 5 * 1024 * 1024 || bytes + size > 64 * 1024 * 1024) { await reader.cancel(); throw new Error('용량 제한'); } parts.push(chunk); } } finally { reader.releaseLock(); }
      const name = createHash('sha256').update(safe).digest('hex').slice(0,24) + '.' + extension;
      await writeFile(path.join(directory, name), Buffer.concat(parts));
      const local = '/__public_media/' + name; cache.set(safe, local); copied++; bytes += size; return local;
    } catch { cache.set(safe, null); skipped++; return null; }
  }
  for (const table of snapshot.tables.filter(t => ['GalleryPost','Program','Coach','AcademySettings'].includes(t.name))) for (const row of table.rows) {
    if (typeof row.imageUrl === 'string') row.imageUrl = await image(row.imageUrl);
    for (const field of ['mediaJSON','facilitiesImagesJSON','galleryImagesJSON']) {
      if (typeof row[field] !== 'string') continue;
      try {
        const values = JSON.parse(row[field]); const output = [];
        if (Array.isArray(values)) for (const item of values) {
          const candidate = typeof item === 'string' ? item : item?.url;
          if (typeof item === 'object' && item?.type === 'video') continue;
          const local = await image(candidate);
          if (local) output.push(typeof item === 'string' ? local : { url: local, type: 'image', ...(item.alt ? { alt: item.alt } : {}) });
        }
        row[field] = JSON.stringify(output);
      } catch { row[field] = '[]'; }
    }
  }
  return { copied, skipped, bytes };
}
