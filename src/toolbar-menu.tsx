import { useEffect, useRef, type ReactNode } from "react";

export function ToolbarMenu({ label, icon, children }: {
  label: string;
  icon: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        ref.current.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  return (
    <details className="toolbarMenu" name="main-toolbar" ref={ref}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
          event.currentTarget.open = false;
        }
      }}>
      <summary className="toolbarActionBtn">
        <i className={`fa-solid ${icon}`} aria-hidden="true" />
        <span>{label}</span>
        <i className="fa-solid fa-chevron-down toolbarMenuChevron" aria-hidden="true" />
      </summary>
      <div className="toolbarMenuPanel" aria-label={`${label} controls`}>
        {children}
      </div>
    </details>
  );
}
