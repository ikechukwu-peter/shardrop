// SHA-256 as lowercase hex

export async function hashChunk(data: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await data.arrayBuffer());
  return toHex(hash);
}

/**
 * Utility function to compute a SHA-256 hash from a plain text string
 */
export async function computeStringSHA256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // Convert the binary buffer into a hex string
  return toHex(hashBuffer);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
