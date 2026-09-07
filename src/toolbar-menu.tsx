import { useEffect, useRef, type ReactNode } from "react";

export function ToolbarMenu({
  label,
  icon,
  children,
  variant = "menu",
}: {
  label: string;
  icon: string;
  children: ReactNode;
  variant?: "menu" | "nav";
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const isNav = variant === "nav";

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
    <details
      className={`toolbarMenu${isNav ? " navMenu" : ""}`}
      name="main-toolbar"
      ref={ref}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary className={`toolbarActionBtn${isNav ? " navMenuToggle" : ""}`}>
        <i className={`fa-solid ${icon}`} aria-hidden="true" />
        <span>{label}</span>
        {isNav ? null : (
          <i className="fa-solid fa-chevron-down toolbarMenuChevron" aria-hidden="true" />
        )}
      </summary>
      <div
        className={`toolbarMenuPanel${isNav ? " navMenuPanel" : ""}`}
        aria-label={`${label} controls`}
        onClick={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest("button, label.toolbarFileBtn")) {
            ref.current && (ref.current.open = false);
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}

export function NavMenuSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="navMenuSection">
      <h3 className="navMenuSectionLabel">{label}</h3>
      <div className="toolbarButtonRow">{children}</div>
    </section>
  );
}
