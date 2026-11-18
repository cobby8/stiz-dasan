type GalleryMediaItem = {
  url: string;
  type: "image" | "video";
};

type InstagramApiError = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
  };
};

export type InstagramPublishResult =
  | {
      attempted: false;
      ok: false;
      skippedReason: string;
    }
  | {
      attempted: true;
      ok: false;
      error: string;
    }
  | {
      attempted: true;
      ok: true;
      instagramMediaId: string;
      permalink: string | null;
    };

function graphBaseUrl(accessToken = getAccessToken()) {
  const version = process.env.META_GRAPH_API_VERSION?.trim();
  const host = accessToken.startsWith("IG") ? "https://graph.instagram.com" : "https://graph.facebook.com";
  return version ? `${host}/${version}` : host;
}

function getAccessToken() {
  return process.env.INSTAGRAM_ACCESS_TOKEN?.trim() || process.env.META_ACCESS_TOKEN?.trim() || "";
}

function getBusinessAccountId(override?: string | null) {
  return override?.trim() || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID?.trim() || "";
}

function getPublicSiteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
  );
}

function apiErrorMessage(body: InstagramApiError, fallback: string) {
  return body.error?.message || fallback;
}

const MEDIA_CONTAINER_STATUS_ATTEMPTS = 8;
const MEDIA_CONTAINER_STATUS_DELAY_MS = 1500;
const MEDIA_PUBLISH_ATTEMPTS = 4;
const MEDIA_PUBLISH_RETRY_DELAY_MS = 2500;

type InstagramContainerStatus = InstagramApiError & {
  status_code?: string;
};

type InstagramPublishBody = InstagramApiError & {
  id?: string;
};

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isContainerReady(statusCode?: string) {
  return statusCode === "FINISHED" || statusCode === "PUBLISHED";
}

function isContainerFailed(statusCode?: string) {
  return statusCode === "ERROR" || statusCode === "EXPIRED";
}

function isRetryablePublishError(body: InstagramPublishBody) {
  const message = body.error?.message?.toLowerCase() || "";
  return message.includes("media id is not available");
}

async function fetchMediaContainerStatus({
  accessToken,
  containerId,
}: {
  accessToken: string;
  containerId: string;
}) {
  const params = new URLSearchParams({
    fields: "status_code",
    access_token: accessToken,
  });

  const res = await fetch(`${graphBaseUrl(accessToken)}/${containerId}?${params.toString()}`, {
    cache: "no-store",
  });
  const body = (await res.json()) as InstagramContainerStatus;

  if (!res.ok) {
    return {
      ok: false as const,
      error: apiErrorMessage(body, "인스타그램 미디어 처리 상태를 확인하지 못했습니다."),
    };
  }

  return {
    ok: true as const,
    statusCode: body.status_code,
  };
}

async function waitForMediaContainersReady({
  accessToken,
  containerIds,
  label,
}: {
  accessToken: string;
  containerIds: string[];
  label: string;
}) {
  const pendingIds = new Set(containerIds);

  for (let attempt = 1; attempt <= MEDIA_CONTAINER_STATUS_ATTEMPTS; attempt++) {
    for (const containerId of Array.from(pendingIds)) {
      const status = await fetchMediaContainerStatus({ accessToken, containerId });

      if (!status.ok) {
        return status;
      }

      if (isContainerReady(status.statusCode)) {
        pendingIds.delete(containerId);
        continue;
      }

      if (isContainerFailed(status.statusCode)) {
        return {
          ok: false as const,
          error: `인스타그램 ${label} 처리에 실패했습니다. 사진 URL 또는 계정 권한을 확인해주세요.`,
        };
      }
    }

    if (pendingIds.size === 0) {
      return { ok: true as const };
    }

    if (attempt < MEDIA_CONTAINER_STATUS_ATTEMPTS) {
      await wait(MEDIA_CONTAINER_STATUS_DELAY_MS);
    }
  }

  return {
    ok: false as const,
    error: `인스타그램에서 ${label} 처리가 아직 끝나지 않았습니다. 잠시 후 다시 게시해주세요.`,
  };
}

function toAbsoluteMediaUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  const siteUrl = getPublicSiteUrl();
  if (url.startsWith("/") && siteUrl) {
    return new URL(url, siteUrl).toString();
  }
  return "";
}

function parseGalleryMedia(mediaJSON: string): GalleryMediaItem[] {
  try {
    const parsed = JSON.parse(mediaJSON);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is GalleryMediaItem => {
      return typeof item?.url === "string" && (item.type === "image" || item.type === "video");
    });
  } catch {
    return [];
  }
}

function normalizeMediaItems(mediaItems: GalleryMediaItem[]) {
  return mediaItems
    .filter((item) => item.type === "image")
    .map((item) => toAbsoluteMediaUrl(item.url))
    .filter(Boolean)
    .slice(0, 10);
}

async function createMediaContainer({
  accessToken,
  businessAccountId,
  params,
  fallback,
}: {
  accessToken: string;
  businessAccountId: string;
  params: URLSearchParams;
  fallback: string;
}) {
  const res = await fetch(`${graphBaseUrl(accessToken)}/${businessAccountId}/media`, {
    method: "POST",
    body: params,
  });
  const body = (await res.json()) as InstagramApiError & { id?: string };
  if (!res.ok || !body.id) {
    return {
      ok: false as const,
      error: apiErrorMessage(body, fallback),
    };
  }
  return { ok: true as const, id: body.id };
}

async function publishMediaContainer({
  accessToken,
  businessAccountId,
  creationId,
}: {
  accessToken: string;
  businessAccountId: string;
  creationId: string;
}) {
  let lastError = "인스타그램 게시물 발행에 실패했습니다.";

  for (let attempt = 1; attempt <= MEDIA_PUBLISH_ATTEMPTS; attempt++) {
    const publishParams = new URLSearchParams({
      creation_id: creationId,
      access_token: accessToken,
    });

    const publishRes = await fetch(`${graphBaseUrl(accessToken)}/${businessAccountId}/media_publish`, {
      method: "POST",
      body: publishParams,
    });
    const publishBody = (await publishRes.json()) as InstagramPublishBody;

    if (publishRes.ok && publishBody.id) {
      return { ok: true as const, id: publishBody.id };
    }

    lastError = apiErrorMessage(publishBody, lastError);

    // Meta가 FINISHED 상태를 준 뒤에도 media_publish 인덱싱이 늦을 때가 있어 한 번 더 흡수한다.
    if (!isRetryablePublishError(publishBody) || attempt >= MEDIA_PUBLISH_ATTEMPTS) {
      return { ok: false as const, error: lastError };
    }

    await wait(MEDIA_PUBLISH_RETRY_DELAY_MS * attempt);
  }

  return { ok: false as const, error: lastError };
}

export function getInstagramRuntimeStatus(businessAccountId?: string | null) {
  const accessToken = getAccessToken();
  const resolvedBusinessAccountId = getBusinessAccountId(businessAccountId);
  return {
    hasAccessToken: Boolean(accessToken),
    hasBusinessAccountId: Boolean(resolvedBusinessAccountId),
  };
}

export async function publishGalleryPostToInstagram({
  businessAccountId,
  caption,
  mediaJSON,
}: {
  businessAccountId?: string | null;
  caption?: string | null;
  mediaJSON: string;
}): Promise<InstagramPublishResult> {
  return publishMediaItemsToInstagram({
    businessAccountId,
    caption,
    mediaItems: parseGalleryMedia(mediaJSON),
    placement: "FEED",
  });
}

export async function publishMediaItemsToInstagram({
  businessAccountId,
  caption,
  mediaItems,
  placement = "FEED",
}: {
  businessAccountId?: string | null;
  caption?: string | null;
  mediaItems: GalleryMediaItem[];
  placement?: "FEED" | "STORY";
}): Promise<InstagramPublishResult> {
  const accessToken = getAccessToken();
  const resolvedBusinessAccountId = getBusinessAccountId(businessAccountId);
  if (!accessToken || !resolvedBusinessAccountId) {
    return {
      attempted: false,
      ok: false,
      skippedReason: "인스타그램 API 토큰 또는 계정 ID가 설정되지 않았습니다.",
    };
  }

  const imageUrls = normalizeMediaItems(mediaItems);

  if (imageUrls.length === 0) {
    return {
      attempted: false,
      ok: false,
      skippedReason: "인스타그램은 외부에서 접근 가능한 이미지 URL이 필요합니다.",
    };
  }

  const captionText = caption?.trim() || "";
  let creationId: string;

  if (placement === "STORY") {
    const createResult = await createMediaContainer({
      accessToken,
      businessAccountId: resolvedBusinessAccountId,
      params: new URLSearchParams({
        image_url: imageUrls[0],
        media_type: "STORIES",
        access_token: accessToken,
      }),
      fallback: "인스타그램 스토리 미디어 생성에 실패했습니다.",
    });

    if (!createResult.ok) {
      return { attempted: true, ok: false, error: createResult.error };
    }
    creationId = createResult.id;

    const readyResult = await waitForMediaContainersReady({
      accessToken,
      containerIds: [creationId],
      label: "스토리 미디어",
    });

    if (!readyResult.ok) {
      return { attempted: true, ok: false, error: readyResult.error };
    }
  } else if (imageUrls.length === 1) {
    const createResult = await createMediaContainer({
      accessToken,
      businessAccountId: resolvedBusinessAccountId,
      params: new URLSearchParams({
        image_url: imageUrls[0],
        caption: captionText,
        access_token: accessToken,
      }),
      fallback: "인스타그램 미디어 컨테이너 생성에 실패했습니다.",
    });

    if (!createResult.ok) {
      return { attempted: true, ok: false, error: createResult.error };
    }
    creationId = createResult.id;

    const readyResult = await waitForMediaContainersReady({
      accessToken,
      containerIds: [creationId],
      label: "피드 이미지",
    });

    if (!readyResult.ok) {
      return { attempted: true, ok: false, error: readyResult.error };
    }
  } else {
    const childIds: string[] = [];

    for (const imageUrl of imageUrls) {
      const childResult = await createMediaContainer({
        accessToken,
        businessAccountId: resolvedBusinessAccountId,
        params: new URLSearchParams({
          image_url: imageUrl,
          is_carousel_item: "true",
          access_token: accessToken,
        }),
        fallback: "인스타그램 캐러셀 이미지 준비에 실패했습니다.",
      });

      if (!childResult.ok) {
        return { attempted: true, ok: false, error: childResult.error };
      }

      childIds.push(childResult.id);
    }

    const childReadyResult = await waitForMediaContainersReady({
      accessToken,
      containerIds: childIds,
      label: "캐러셀 이미지",
    });

    if (!childReadyResult.ok) {
      return { attempted: true, ok: false, error: childReadyResult.error };
    }

    const carouselResult = await createMediaContainer({
      accessToken,
      businessAccountId: resolvedBusinessAccountId,
      params: new URLSearchParams({
        media_type: "CAROUSEL",
        children: childIds.join(","),
        caption: captionText,
        access_token: accessToken,
      }),
      fallback: "인스타그램 캐러셀 게시물 생성에 실패했습니다.",
    });

    if (!carouselResult.ok) {
      return { attempted: true, ok: false, error: carouselResult.error };
    }
    creationId = carouselResult.id;

    const carouselReadyResult = await waitForMediaContainersReady({
      accessToken,
      containerIds: [creationId],
      label: "캐러셀 게시물",
    });

    if (!carouselReadyResult.ok) {
      return { attempted: true, ok: false, error: carouselReadyResult.error };
    }
  }

  const publishResult = await publishMediaContainer({
    accessToken,
    businessAccountId: resolvedBusinessAccountId,
    creationId,
  });
  if (!publishResult.ok) {
    return {
      attempted: true,
      ok: false,
      error: publishResult.error,
    };
  }

  let permalink: string | null = null;
  try {
    const permalinkParams = new URLSearchParams({
      fields: "permalink",
      access_token: accessToken,
    });
    const permalinkRes = await fetch(`${graphBaseUrl(accessToken)}/${publishResult.id}?${permalinkParams.toString()}`, {
      cache: "no-store",
    });
    const permalinkBody = (await permalinkRes.json()) as { permalink?: string };
    permalink = permalinkBody.permalink || null;
  } catch {
    permalink = null;
  }

  return {
    attempted: true,
    ok: true,
    instagramMediaId: publishResult.id,
    permalink,
  };
}
