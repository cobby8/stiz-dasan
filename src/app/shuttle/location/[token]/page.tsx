import RegularShuttleLocationClient from "./RegularShuttleLocationClient";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "셔틀 위치 확인 | STIZ 농구교실",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function RegularShuttleLocationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <RegularShuttleLocationClient token={token} />;
}
