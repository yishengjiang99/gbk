import test from "node:test";
import assert from "node:assert/strict";
import { withAppArgument, syncSmartAppBanner } from "../src/smart-app-banner.ts";

test("smart app banner app-argument follows the current URL", () => {
  assert.equal(withAppArgument("app-id=1, app-argument=https://x/", "https://x/s/a-b-c?edit=1"), "app-id=1, app-argument=https://x/s/a-b-c?edit=1");
  assert.equal(withAppArgument("app-id=1", "https://x/u/al,ice"), "app-id=1, app-argument=https://x/u/al%2Cice");
  let content = "app-id=1, app-argument=https://x/";
  const meta = { getAttribute: () => content, setAttribute: (_: string, v: string) => { content = v; } };
  syncSmartAppBanner({ querySelector: () => meta } as unknown as Document, { href: "https://x/studio" } as Location);
  assert.equal(content, "app-id=1, app-argument=https://x/studio");
});
