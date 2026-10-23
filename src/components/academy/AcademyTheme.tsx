import type { ComponentPropsWithoutRef } from "react";

type AcademyThemeProps = Omit<ComponentPropsWithoutRef<"div">, "role"> & {
  role: "admin" | "parent" | "teacher" | "driver";
};

/** 서버·클라이언트 화면이 같은 색상 기준을 사용하도록 경계를 둔다. */
export default function AcademyTheme({ role, className = "", children, ...props }: AcademyThemeProps) {
  return (
    <div {...props} data-academy-role={role} className={`academy-app ${className}`}>
      {children}
    </div>
  );
}
