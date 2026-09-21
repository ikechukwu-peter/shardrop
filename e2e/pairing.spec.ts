import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const sha256 = (bytes: Buffer | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fixtureFile(bytes: number): { path: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "zendrop-"));
  const path = join(dir, "payload.bin");
  const data = randomBytes(bytes);
  writeFileSync(path, data);
  return { path, hash: sha256(data) };
}

async function pickFile(page: Page, path: string): Promise<void> {
  await page.locator("#file-input").evaluate((input) => {
    input.removeAttribute("hidden");
  });
  await page.locator("#file-input").setInputFiles(path);
}

test.describe("pairing through the relay", () => {
  test("a shared link pairs two tabs with no copy-paste", async ({
    browser,
  }) => {
    const host = await (await browser.newContext()).newPage();
    const guest = await (await browser.newContext()).newPage();

    await host.goto("/");
    await host.getByRole("button", { name: "Create a code" }).click();

    // The link carries the code in the fragment, which never reaches the relay.
    const link = await host.locator("#code-link").textContent();
    expect(link).toMatch(/#c=[0-9A-Z]{16}$/);
    await expect(host.locator("#code-qr")).toBeVisible();

    await guest.goto(link!);

    await expect(host.locator("#connect-status")).toContainText(
      "ready to send",
    );
    await expect(guest.locator("#connect-status")).toContainText(
      "ready to receive",
    );
  });

  test("typing the code pairs, and a file crosses", async ({ browser }) => {
    const source = fixtureFile(400_000);
    const host = await (await browser.newContext()).newPage();
    const guest = await (await browser.newContext()).newPage();

    await host.goto("/");
    await guest.goto("/");
    await host.getByRole("button", { name: "Create a code" }).click();

    const code = await host.locator("#code-text").textContent();
    await guest.locator("#code-input").fill(code!);
    await guest.getByRole("button", { name: "Join" }).click();

    await expect(host.locator("#connect-status")).toContainText(
      "ready to send",
    );

    await pickFile(host, source.path);
    await host.locator("#chunk-size").selectOption("262144");
    await host.getByRole("button", { name: "Send file" }).click();

    await expect(guest.locator("#transfer-stats")).toContainText(
      "state: complete",
      { timeout: 60_000 },
    );

    const save = guest.getByRole("button", { name: /^Save/ });
    const download = await Promise.all([
      guest.waitForEvent("download"),
      save.click(),
    ]).then(([event]) => event);
    const saved = await download.path();
    expect(sha256(readFileSync(saved!))).toBe(source.hash);
  });
});
