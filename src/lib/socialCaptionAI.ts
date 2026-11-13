import { GoogleGenerativeAI } from "@google/generative-ai";

export type SocialMediaItem = {
  url: string;
  type: "image" | "video";
};

export type SocialCaptionDraft = {
  title: string;
  caption: string;
  hashtags: string;
  /**
   * 문구가 어디서 왔는가(2026-11-14 사진·인스타 점검).
   * "AI" = AI 가 사진을 보고 쓴 초안 · "FALLBACK" = AI 연결이 안 됐거나 실패해 준비된 기본 문구.
   * 예전에는 구분이 없어 기본 문구도 화면에 «AI 초안»으로 보였다.
   */
  source: "AI" | "FALLBACK";
};

const DEFAULT_HASHTAGS = [
  "#스티즈농구교실",
  "#스티즈농구교실다산점",
  "#다산농구",
  "#남양주농구",
  "#유소년농구",
  "#농구수업",
];

const EXTRA_HASHTAGS = [
  "#농구기본기",
  "#성장기록",
  "#팀워크수업",
  "#운동습관",
  "#자신감성장",
  "#슛연습",
  "#드리블연습",
  "#농구클래스",
  "#초등농구",
  "#중등농구",
  "#다산신도시",
  "#별내농구",
];

const CAPTION_VARIATIONS = [
  {
    angle: "아이들이 수업 안에서 집중력을 키워가는 장면",
    opening: "조용히 관찰한 듯한 따뜻한 첫 문장",
    structure: "수업 분위기 -> 오늘의 성장 포인트 -> 다음 수업 기대감",
  },
  {
    angle: "기본기를 반복하며 작은 성공 경험을 만드는 과정",
    opening: "훈련의 리듬감이 느껴지는 첫 문장",
    structure: "반복 훈련 -> 성공 경험 -> 자신감",
  },
  {
    angle: "친구들과 호흡을 맞추며 팀워크를 배우는 분위기",
    opening: "함께 움직이는 느낌을 살린 첫 문장",
    structure: "팀 분위기 -> 협동 장면 -> 학부모가 안심할 메시지",
  },
  {
    angle: "도전적인 플레이를 시도하는 아이들의 에너지",
    opening: "활기차지만 과장 없는 첫 문장",
    structure: "도전 장면 -> 코치의 지도 방향 -> 긍정적인 마무리",
  },
  {
    angle: "수업 후반까지 이어지는 꾸준한 태도와 성실함",
    opening: "성실함을 칭찬하는 차분한 첫 문장",
    structure: "태도 -> 연습 내용 -> 성장 기록",
  },
  {
    angle: "학부모가 사진을 보며 수업 분위기를 바로 느낄 수 있는 설명",
    opening: "사진 속 현장감이 드러나는 첫 문장",
    structure: "사진 속 분위기 -> 수업 포인트 -> 스티즈의 지도 철학",
  },
];

const FALLBACK_CAPTIONS = [
  {
    title: "수업 성장 기록",
    caption: "사진 속 집중하는 눈빛에서 오늘 수업의 분위기가 그대로 느껴집니다.",
    closing: "한 번의 좋은 움직임이 다음 도전을 더 가볍게 만들어줍니다.",
  },
  {
    title: "코트 위 순간들",
    caption: "공을 잡는 자세부터 움직임 하나하나까지, 아이들이 수업에 몰입한 시간이었습니다.",
    closing: "스티즈는 기본기와 즐거움이 함께 남는 수업을 만들어갑니다.",
  },
  {
    title: "오늘의 수업 포인트",
    caption: "반복되는 연습 속에서도 아이들은 매번 조금씩 다른 감각을 익혀갑니다.",
    closing: "작은 변화가 쌓이면 코트 위 자신감도 함께 자랍니다.",
  },
  {
    title: "팀워크 수업 기록",
    caption: "혼자 잘하는 농구를 넘어, 친구들과 호흡을 맞추는 장면이 인상적이었습니다.",
    closing: "함께 뛰며 배우는 경험이 아이들에게 오래 남기를 바랍니다.",
  },
  {
    title: "활기찬 수업 스케치",
    caption: "몸을 움직이고, 다시 시도하고, 서로 응원하는 에너지가 가득한 시간이었습니다.",
    closing: "즐겁게 몰입하는 경험이 꾸준한 운동 습관으로 이어집니다.",
  },
  {
    title: "기본기 훈련 기록",
    caption: "기본 동작을 차분히 다듬으며 아이들이 스스로 해내는 감각을 만들어갔습니다.",
    closing: "스티즈는 결과보다 성장의 과정을 더 세심하게 바라봅니다.",
  },
  {
    title: "도전의 순간",
    caption: "처음엔 어려워 보여도 한 번 더 시도하는 모습이 오늘 수업의 가장 좋은 장면이었습니다.",
    closing: "코트 위에서 배운 도전은 수업 밖에서도 힘이 됩니다.",
  },
  {
    title: "수업 분위기 기록",
    caption: "아이들이 서로의 움직임을 보고 반응하며 수업 흐름에 자연스럽게 들어왔습니다.",
    closing: "농구를 즐기는 마음 위에 실력도 함께 쌓아가겠습니다.",
  },
];

function pickOne<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] ?? items[0];
}

function pickSome<T>(items: readonly T[], count: number): T[] {
  return [...items].sort(() => Math.random() - 0.5).slice(0, count);
}

function compactText(value: unknown, fallback = "") {
  return String(value || fallback)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHashtags(value: unknown) {
  const raw = Array.isArray(value) ? value.join(" ") : String(value || "");
  const tags = raw
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));

  const merged = [...tags, ...pickSome(EXTRA_HASHTAGS, 4), ...DEFAULT_HASHTAGS];
  return Array.from(new Set(merged)).slice(0, 18).join(" ");
}

function fallbackDraft(lessonType?: string | null, memo?: string | null): SocialCaptionDraft {
  const selected = pickOne(FALLBACK_CAPTIONS);
  const title = lessonType ? `${lessonType} ${selected.title}` : `STIZ ${selected.title}`;
  const memoLine = memo?.trim() ? `\n\n오늘 포인트: ${memo.trim()}` : "";

  return {
    title,
    caption: `${selected.caption}${memoLine}\n\n${selected.closing}`,
    hashtags: normalizeHashtags(""),
    source: "FALLBACK",
  };
}

function parseJson(text: string) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function imagePartFromUrl(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;

  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  if (!mimeType.startsWith("image/")) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType,
    },
  };
}

export async function generateSocialCaptionDraft({
  mediaItems,
  lessonType,
  memo,
}: {
  mediaItems: SocialMediaItem[];
  lessonType?: string | null;
  memo?: string | null;
}): Promise<SocialCaptionDraft> {
  const fallback = fallbackDraft(lessonType, memo);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return fallback;

  const imageUrls = mediaItems
    .filter((item) => item.type === "image")
    .map((item) => item.url)
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 3);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 1,
        topP: 0.95,
        topK: 40,
      },
    });
    const imageParts = (await Promise.all(imageUrls.map(imagePartFromUrl))).filter(
      (part): part is NonNullable<Awaited<ReturnType<typeof imagePartFromUrl>>> => part !== null,
    );
    const variation = pickOne(CAPTION_VARIATIONS);
    const variationSeed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const prompt = `
You write Korean Instagram captions for STIZ Basketball Academy Dasan.
Create a natural feed post based on the uploaded class photos and teacher memo.

Rules:
- Do not guess or mention children's names, school names, exact ages, phone numbers, or private details.
- Keep the tone warm, professional, energetic, and not exaggerated.
- Make the caption suitable for parents who want to see class atmosphere.
- Return only JSON with keys: title, caption, hashtags.
- hashtags can be a string or array. Include local/basketball/STIZ tags.
- Avoid repeating generic phrases such as "오늘도 코트 위에서", "차근차근 쌓았습니다", "작은 성공 경험".
- Use 2 to 4 short paragraphs. Do not write like an advertisement slogan only.
- If the photos have clear visual cues, mention one safe observable detail. If not, describe the class atmosphere generally.

Lesson type: ${lessonType || "수업"}
Teacher memo: ${memo || "없음"}
Writing angle: ${variation.angle}
Opening style: ${variation.opening}
Suggested structure: ${variation.structure}
Variation seed: ${variationSeed}
`;

    const result = await model.generateContent([{ text: prompt }, ...imageParts]);
    const parsed = parseJson(result.response.text());

    if (!parsed) return fallback;

    return {
      title: compactText(parsed.title, fallback.title).slice(0, 80),
      caption: compactText(parsed.caption, fallback.caption).slice(0, 1800),
      hashtags: normalizeHashtags(parsed.hashtags || fallback.hashtags),
      source: "AI",
    };
  } catch (error) {
    console.warn("[social-caption-ai] fallback used:", error);
    return fallback;
  }
}
