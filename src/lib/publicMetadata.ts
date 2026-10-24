import type { Metadata } from "next";

export const PUBLIC_SITE_URL = "https://www.stiz-dasan.kr";
export const PUBLIC_SITE_NAME = "STIZ 농구교실 다산2호점";
export const DEFAULT_OG_IMAGE = "/opengraph-image";
export const DEFAULT_OG_IMAGE_ALT = "STIZ 농구교실 다산2호점 대표 미리보기";

type PublicMetadataInput = {
  title: string;
  description: string;
  path?: string;
  imageAlt?: string;
};

function normalizePath(path: string | undefined) {
  if (!path || path === "/") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function absolutePublicUrl(path?: string) {
  const normalizedPath = normalizePath(path);
  return new URL(normalizedPath, PUBLIC_SITE_URL).toString();
}

export function buildPublicMetadata({
  title,
  description,
  path,
  imageAlt = DEFAULT_OG_IMAGE_ALT,
}: PublicMetadataInput): Metadata {
  const canonical = absolutePublicUrl(path);
  const image = {
    url: DEFAULT_OG_IMAGE,
    width: 1200,
    height: 630,
    alt: imageAlt,
  };

  return {
    metadataBase: new URL(PUBLIC_SITE_URL),
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: PUBLIC_SITE_NAME,
      locale: "ko_KR",
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [DEFAULT_OG_IMAGE],
    },
  };
}
