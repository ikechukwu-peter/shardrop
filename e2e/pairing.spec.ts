import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const sha256 = (bytes: Buffer | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fixtureFile(bytes: number): { path: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "shardrop-"));
  const path = join(dir, "payload.bin");
  const data = randomBytes(bytes);
  writeFileSync(path, data);
  return { path, hash: sha256(data) };
}

async function pickFiles(page: Page, paths: string[]): Promise<void> {
  await page.locator("#file-input").evaluate((input) => {
    input.removeAttribute("hidden");
  });
  await page.locator("#file-input").setInputFiles(paths);
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
      "Ready to send",
    );
    await expect(guest.locator("#connect-status")).toContainText(
      "Ready to receive",
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
      "Ready to send",
    );

    await pickFiles(host, [source.path]);
    await host.locator("#chunk-size").selectOption("262144");
    await host.getByRole("button", { name: "Send file" }).click();

    await expect(guest.locator("#readout-headline")).toContainText(
      "Every shard matched its hash",
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

test("a folder of files arrives intact, with the connection type shown", async ({
  browser,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "shardrop-folder-"));
  const files = ["alpha.bin", "beta.bin", "gamma.bin"].map((name) => {
    const path = join(dir, name);
    const data = randomBytes(150_000);
    writeFileSync(path, data);
    return { name, path, hash: sha256(data) };
  });

  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto("/");
  await host.getByRole("button", { name: "Create a code" }).click();
  const link = await host.locator("#code-link").textContent();
  await guest.goto(link!);

  // Two tabs on one machine can only be a direct connection.
  await expect(host.locator("#peer-pill")).toHaveText("paired · direct");
  await expect(host.locator("#connect-status")).toContainText(
    "Connected directly",
  );

  await host.locator("#file-input").evaluate((input) => {
    input.removeAttribute("hidden");
  });
  await host.locator("#file-input").setInputFiles(files.map((f) => f.path));
  await expect(host.locator("#btn-send-file")).toHaveText("Send 3 files");
  await host.locator("#chunk-size").selectOption("262144");
  await host.getByRole("button", { name: "Send 3 files" }).click();

  const rows = guest.locator("#received-list li");
  await expect(rows).toHaveCount(3, { timeout: 60_000 });
  await expect(host.locator("#readout-headline")).toContainText("File 3 of 3");

  for (const [index, file] of files.entries()) {
    await expect(rows.nth(index).locator(".path")).toHaveText(file.name);
    const download = await Promise.all([
      guest.waitForEvent("download"),
      rows.nth(index).getByRole("link", { name: "Save" }).click(),
    ]).then(([event]) => event);
    expect(sha256(readFileSync((await download.path())!))).toBe(file.hash);
  }
});
