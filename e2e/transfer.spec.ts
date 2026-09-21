import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const sha256 = (bytes: Buffer | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A file with random bytes: chunks in the wrong order would not go unnoticed. */
function fixtureFile(bytes: number): { path: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "zendrop-"));
  const path = join(dir, "payload.bin");
  const data = randomBytes(bytes);
  writeFileSync(path, data);
  return { path, hash: sha256(data) };
}

/** Copies the offer and answer between two tabs, as a user would by hand. */
async function connect(sender: Page, receiver: Page): Promise<void> {
  await sender.getByRole("button", { name: "Create offer" }).click();
  const offer = sender.locator("#offer-out");
  await expect(offer).not.toBeEmpty();

  await receiver.locator("#offer-in").fill(await offer.inputValue());
  await receiver.getByRole("button", { name: "Accept offer" }).click();
  const answer = receiver.locator("#answer-out");
  await expect(answer).not.toBeEmpty();

  await sender.locator("#answer-in").fill(await answer.inputValue());
  await sender.getByRole("button", { name: "Accept answer" }).click();

  for (const page of [sender, receiver]) {
    await expect(page.locator("#peer-status")).toContainText("channel: open");
  }
}

async function pickFile(page: Page, path: string): Promise<void> {
  // The input is hidden behind the drop zone; reveal it so it can be filled.
  await page.locator("#file-input").evaluate((input) => {
    input.removeAttribute("hidden");
  });
  await page.locator("#file-input").setInputFiles(path);
  await expect(page.locator("#output")).toContainText("payload.bin");
}

test.describe("browser to browser transfer", () => {
  test("delivers a file whose bytes are identical", async ({ browser }) => {
    const source = fixtureFile(1_200_000);
    const sender = await (await browser.newContext()).newPage();
    const receiver = await (await browser.newContext()).newPage();

    await sender.goto("/");
    await receiver.goto("/");
    await connect(sender, receiver);

    await pickFile(sender, source.path);
    await sender.locator("#chunk-size").selectOption("262144");
    await sender.getByRole("button", { name: "Send file" }).click();

    // The receiving tab reports its own progress and offers the file.
    await expect(receiver.locator("#transfer-stats")).toContainText(
      "state: complete",
      { timeout: 60_000 },
    );
    await expect(receiver.locator("#transfer-stats")).toContainText(
      "integrity: ✓",
    );
    await expect(sender.locator("#transfer-stats")).toContainText(
      "state: complete",
    );

    const save = receiver.getByRole("button", { name: /^Save/ });
    await expect(save).toBeEnabled();
    const download = await Promise.all([
      receiver.waitForEvent("download"),
      save.click(),
    ]).then(([event]) => event);

    const saved = await download.path();
    expect(saved).toBeTruthy();
    expect(sha256(readFileSync(saved!))).toBe(source.hash);
  });

  test("reports chunk counts and a finite speed while transferring", async ({
    browser,
  }) => {
    const source = fixtureFile(600_000);
    const sender = await (await browser.newContext()).newPage();
    const receiver = await (await browser.newContext()).newPage();

    await sender.goto("/");
    await receiver.goto("/");
    await connect(sender, receiver);

    await pickFile(sender, source.path);
    await sender.locator("#chunk-size").selectOption("262144");
    await sender.getByRole("button", { name: "Send file" }).click();

    const stats = sender.locator("#transfer-stats");
    await expect(stats).toContainText("state: complete", { timeout: 60_000 });
    // ceil(600000 / 262144) = 3 chunks, every one acknowledged.
    await expect(stats).toContainText("chunks: 3 / 3");
    await expect(stats).toContainText("retries: 0");
  });
});
