import { useSyncExternalStore } from "react";
import { workstation } from "../../workstation/instance.ts";
export function useWorkstation() {
  return useSyncExternalStore((cb) => workstation.subscribe(cb), () => workstation.getState());
}
export { workstation };
