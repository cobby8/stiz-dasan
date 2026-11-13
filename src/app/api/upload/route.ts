import { NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { requireStaff } from "@/lib/auth-guard";
import { canUseSharedUpload, resolveUploadFolder } from "@/lib/uploadFolders";

// 허용 파일 타입 화이트리스트 — 이미지만 허용
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const EXTENSION_BY_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
// 최대 파일 크기 5MB (바이트 단위)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

async function trySupabaseUpload(buffer: Buffer, folder: string, filename: string, contentType: string): Promise<string | null> {
    try {
        const { createAdminClient } = await import("@/lib/supabase/admin");
        const supabase = createAdminClient();
        const BUCKET = "uploads";

        // Auto-create bucket if it doesn't exist
        await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});

        const path = `${folder}/${filename}`;
        const { data, error } = await supabase.storage
            .from(BUCKET)
            .upload(path, buffer, { contentType, upsert: false, cacheControl: "31536000" });

        if (error) {
            console.warn("[upload] Supabase error:", error.message);
            return null;
        }
        const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
        return urlData.publicUrl;
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[upload] Supabase unavailable:", message);
        return null;
    }
}

export async function POST(req: Request) {
    try {
        const staff = await requireStaff();
        // 2026-11-14 사진·인스타 점검: 기사님 전용 계정은 사진을 올리는 화면이 없다 — 거절한다.
        // (선생님 역할을 함께 승인받은 기사님은 roles.teacher 가 켜져 있어 그대로 쓸 수 있다)
        if (!canUseSharedUpload(staff.roles)) {
            return NextResponse.json({ error: "사진 업로드는 선생님·관리자 계정에서만 할 수 있습니다." }, { status: 403 });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "업로드 권한이 필요합니다.";
        const status = message.includes("인증") ? 401 : 403;
        return NextResponse.json({ error: message }, { status });
    }

    try {
        const formData = await req.formData();
        const file = formData.get("file") as File;
        if (!file) return NextResponse.json({ error: "No file received." }, { status: 400 });

        // 파일 타입 검증 — 허용된 이미지 타입만 통과
        if (!ALLOWED_TYPES.includes(file.type)) {
            return NextResponse.json(
                { error: `허용되지 않은 파일 형식입니다. (허용: JPEG, PNG, WebP, GIF)` },
                { status: 400 }
            );
        }

        // 파일 크기 검증 — 5MB 초과 시 거부
        if (file.size > MAX_FILE_SIZE) {
            return NextResponse.json(
                { error: `파일 크기가 5MB를 초과합니다.` },
                { status: 400 }
            );
        }

        // folder 는 허용 목록(src/lib/uploadFolders.ts)에 있는 값만 받는다. 안 보내면 기존처럼 "coaches".
        // 예전에는 보낸 값을 그대로 경로에 붙여 "../" 같은 값으로 다른 위치에 쓸 수 있었다.
        const folder = resolveUploadFolder(formData.get("folder"));
        if (!folder) {
            return NextResponse.json({ error: "사진을 저장할 위치가 올바르지 않습니다." }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        // 확장자는 파일 이름이 아니라 검사를 통과한 형식에서 정한다 — 이름에 "/../" 같은 글자를 넣어 저장 위치를 바꾸지 못하게(2026-11-14 보안 검수)
        const ext = EXTENSION_BY_TYPE[file.type] ?? "jpg";
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        // Try Supabase Storage first
        const supabaseUrl = await trySupabaseUpload(buffer, folder, filename, file.type || "image/jpeg");
        if (supabaseUrl) {
            return NextResponse.json({ url: supabaseUrl });
        }

        // Fallback: local filesystem
        const uploadDir = join(process.cwd(), "public", "uploads", folder);
        await mkdir(uploadDir, { recursive: true });
        await writeFile(join(uploadDir, filename), buffer);
        return NextResponse.json({ url: `/uploads/${folder}/${filename}` });
    } catch (e: unknown) {
        console.error("[upload] Fatal error:", e);
        return NextResponse.json({ error: "서버 오류가 발생했습니다." }, { status: 500 });
    }
}
