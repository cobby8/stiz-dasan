import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-guard";
import { GEMINI_CHAT_MODEL } from "@/lib/gemini-client";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg"]);

/**
 * 실패 기록에 남길 것만 고른다: 오류 이름 + (있으면) 오류 번호.
 * 음성 내용·변환된 글·오류 본문은 남기지 않는다 — 본문에는 요청 내용이 섞일 수 있다.
 * 번호는 @google/generative-ai 의 GoogleGenerativeAIFetchError(status?: number, statusText?: string)에서 온다.
 */
function failureLog(error: unknown) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const source = error && typeof error === "object" ? (error as { status?: unknown; statusText?: unknown }) : {};
  return {
    name,
    ...(typeof source.status === "number" ? { status: source.status } : {}),
    ...(typeof source.statusText === "string" ? { statusText: source.statusText.slice(0, 80) } : {}),
  };
}

// 로그인 안 했거나 직원이 아니면 null — «음성 인식 실패»(500)로 섞이지 않게 문지기를 따로 둔다(/api/staff/shuttle 과 같은 관례).
async function staffOrNull() {
  try {
    return await requireStaff();
  } catch (error) {
    // 로그인 풀림·직원 아님은 평범한 401. 그 밖(DB 조회 실패 등)은 장애라 이름만 기록한다.
    const reason = error instanceof Error ? error.message : "";
    const expected = reason.includes("인증이 필요") || reason.includes("Staff permission");
    if (!expected) console.error("[staff-transcribe] staff check failed", failureLog(error));
    return null;
  }
}

export async function POST(req: Request) {
  const staff = await staffOrNull();
  if (!staff) return NextResponse.json({ error: "로그인이 풀렸어요. 다시 로그인해 주세요.", code: "UNAUTHORIZED" }, { status: 401 });
  try {
    const form = await req.formData();
    const audio = form.get("audio");
    const durationMs = Number(form.get("durationMs"));
    if (!(audio instanceof File)) return NextResponse.json({ error: "음성 파일이 없습니다." }, { status: 400 });
    if (!ALLOWED_MIME.has(audio.type)) return NextResponse.json({ error: "지원하지 않는 음성 형식입니다." }, { status: 400 });
    if (audio.size > MAX_BYTES) return NextResponse.json({ error: "음성은 10MB 이하여야 합니다." }, { status: 400 });
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_500) {
      return NextResponse.json({ error: "한 번에 최대 60초까지 녹음할 수 있습니다." }, { status: 400 });
    }
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) return NextResponse.json({ error: "음성 인식 설정(GEMINI_API_KEY)이 필요합니다." }, { status: 503 });

    // 모델은 사이트의 다른 Gemini 기능과 같은 것을 쓴다(따로 적어 두면 옛 모델이 종료될 때 여기만 멈춘다).
    // 음성 전용 모델을 쓰고 싶을 때만 설정값 GEMINI_TRANSCRIBE_MODEL 로 바꾼다.
    const modelName = process.env.GEMINI_TRANSCRIBE_MODEL?.trim() || GEMINI_CHAT_MODEL;
    // 원본은 메모리에서 API로 한 번 전달할 뿐 저장소나 DB에 기록하지 않습니다.
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
    const result = await model.generateContent([
      { text: "다음 한국어 음성을 정확히 받아쓰기 하세요. 설명이나 요약 없이 인식된 문장만 출력하세요." },
      { inlineData: { mimeType: audio.type, data: Buffer.from(await audio.arrayBuffer()).toString("base64") } },
    ]);
    const text = result.response.text().trim();
    if (!text) return NextResponse.json({ error: "음성을 인식하지 못했습니다. 다시 녹음해 주세요." }, { status: 422 });
    return NextResponse.json({ text });
  } catch (error) {
    // 음성 내용과 전사 본문은 로그에 남기지 않습니다(오류 이름·번호만).
    console.error("[staff-transcribe] request failed", failureLog(error));
    return NextResponse.json({ error: "음성 인식에 실패했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
