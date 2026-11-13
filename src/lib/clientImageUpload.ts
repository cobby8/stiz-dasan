import { compressImageForUpload } from "@/lib/clientImageCompression";

export type UploadedImageItem = { url: string; type: "image" };

type UploadImagesOptions = {
  folder: string;
  endpoint?: string;
  fields?: Record<string, string>;
  compression?: Parameters<typeof compressImageForUpload>[1];
  limit?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
};

async function uploadCompressedImage(file: File, folder: string, options: Pick<UploadImagesOptions, "endpoint" | "fields" | "compression">): Promise<UploadedImageItem> {
  const compressed = await compressImageForUpload(file, options.compression);
  const fd = new FormData();
  fd.append("file", compressed);
  fd.append("folder", folder);
  for (const [key, value] of Object.entries(options.fields ?? {})) fd.append(key, value);

  const res = await fetch(options.endpoint ?? "/api/upload", { method: "POST", body: fd });
  const data = await res.json();

  if (!res.ok || !data.url) {
    throw new Error(data.error || "사진 업로드에 실패했습니다.");
  }

  return { url: data.url, type: "image" };
}

export async function uploadImagesWithProgress(
  files: FileList | File[],
  {
    folder,
    limit,
    concurrency = 3,
    onProgress, endpoint, fields, compression,
  }: UploadImagesOptions,
) {
  const allFiles = Array.from(files);
  const selected = typeof limit === "number" ? allFiles.slice(0, limit) : allFiles;
  const skippedCount = allFiles.length - selected.length;
  const items: UploadedImageItem[] = [];
  const failedNames: string[] = [];
  // 실패한 파일 자체 — «실패한 사진만 다시 올리기»에 쓴다(2026-11-14 수업 피드). 성공한 사진은 다시 올리지 않는다.
  const failedFiles: File[] = [];
  let done = 0;

  for (let start = 0; start < selected.length; start += concurrency) {
    const batch = selected.slice(start, start + concurrency);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const item = await uploadCompressedImage(file, folder, { endpoint, fields, compression });
          return { item, name: file.name, file };
        } catch {
          return { item: null, name: file.name, file };
        } finally {
          done += 1;
          onProgress?.(done, selected.length);
        }
      }),
    );

    for (const result of results) {
      if (result.item) items.push(result.item);
      else { failedNames.push(result.name); failedFiles.push(result.file); }
    }
  }

  return { items, failedNames, failedFiles, skippedCount, total: selected.length };
}
