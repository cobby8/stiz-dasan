"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { isAcademyPath } from "@/lib/academyTheme";
import { readPublicDesign, type PublicDesign } from "@/lib/public-design";

function DesignQuery({ onDesign }: { onDesign: (design: PublicDesign) => void }) {
  const params = useSearchParams();
  useEffect(() => { const selected = readPublicDesign(params.toString()); if (selected) onDesign(selected); }, [params, onDesign]);
  return null;
}

export default function PublicDesignProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [design, setDesign] = useState<PublicDesign>("lavender");
  const academy = isAcademyPath(pathname);

  if (academy) return children;
  return <div className="public-site" data-public-theme={design}><Suspense fallback={null}><DesignQuery onDesign={setDesign} /></Suspense>{children}</div>;
}
