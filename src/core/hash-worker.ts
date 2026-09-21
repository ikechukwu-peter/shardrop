/**
 * Hashes chunks off the main thread.
 *
 * crypto.subtle is already async, but the digest itself runs on the calling
 * thread: hashing a multi-gigabyte file one chunk at a time blocks rendering
 * for as long as it takes. Moving it here keeps the UI responsive, which is
 * the whole of milestone 15.
 *
 * Buffers arrive transferred, not copied, so the cost is the hash and nothing
 * else.
 */
export type HashRequest = { id: number; buffer: ArrayBuffer };
export type HashResponse =
  { id: number; hash: string } | { id: number; error: string };

self.addEventListener("message", (event: MessageEvent<HashRequest>) => {
  const { id, buffer } = event.data;
  void crypto.subtle
    .digest("SHA-256", buffer)
    .then((digest) => {
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      self.postMessage({ id, hash } satisfies HashResponse);
    })
    .catch((error: unknown) => {
      self.postMessage({ id, error: String(error) } satisfies HashResponse);
    });
});
