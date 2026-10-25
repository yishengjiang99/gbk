// Push fan-out for social events (comment on your song, fork of your song, DM). No-op until APNs is configured.
import type { Config } from "../config.ts";
import type { NativeStore } from "../persistence/native.ts";
import { apnsConfigured, createApnsSender, deadToken, type ApnsSender } from "./apns.ts";

export type Notify = (user: string, n: { kind: "comment" | "fork" | "dm"; title: string; body: string; link: string }) => void;
export function createNotifier(cfg: Config, store: NativeStore, log: (o: object) => void, sender?: ApnsSender): Notify {
  const send = sender ?? (apnsConfigured(cfg) ? createApnsSender(cfg) : null);
  return (user, n) => {
    if (!send) return;
    for (const d of store.devices(user)) {
      void send(d.token, d.environment, { aps: { alert: { title: n.title.slice(0, 80), body: n.body.slice(0, 180) }, sound: "default" }, kind: n.kind, link: n.link })
        .then((r) => { if (deadToken(r)) store.dropToken(d.token); log({ evt: "apns_send", kind: n.kind, status: r.status, reason: r.reason }); })
        .catch((e) => log({ evt: "apns_error", message: (e as Error).message }));
    }
  };
}
