export type HeaderFit = { available: number; brand: number; navigation: number; actions: number; gap: number };

/** 소수 픽셀 오차는 4px, 다시 펼칠 때는 추가 4px만 여유를 둔다. */
export function shouldCollapseHeader(sizes: HeaderFit, wasCollapsed: boolean): boolean {
  if (Object.values(sizes).some((value) => !Number.isFinite(value) || value < 0)
    || sizes.available === 0 || sizes.navigation === 0) return true;
  const required = sizes.brand + sizes.navigation + sizes.actions + sizes.gap * 2 + 4;
  return required + (wasCollapsed ? 4 : 0) > sizes.available;
}
