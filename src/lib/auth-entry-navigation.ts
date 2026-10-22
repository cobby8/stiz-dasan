import { isSafeInternalPath } from "./auth-routes";

type SearchReader = { get: (name: string) => string | null };

/** 가입 방법을 바꿔도 원래 화면과 신청 연결 정보만 이어 간다. */
export function parentAuthEntryHref(
  target: "login" | "signup",
  search: SearchReader,
  options: { existing?: boolean } = {},
) {
  const params = new URLSearchParams();
  const requested = target === "login"
    ? search.get("next") || search.get("redirect")
    : search.get("redirect") || search.get("next");
  if (isSafeInternalPath(requested)) params.set(target === "login" ? "redirect" : "next", requested!);
  const handoff = search.get("handoff") || search.get("enrollmentHandoff");
  if (handoff) params.set("enrollmentHandoff", handoff);
  if (target === "signup" && options.existing) params.set("existing", "1");
  const query = params.toString();
  return `${target === "login" ? "/login" : "/signup/parent"}${query ? `?${query}` : ""}`;
}
