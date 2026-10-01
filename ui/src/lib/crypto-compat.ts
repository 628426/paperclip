/** randomUUID is secure-context-only; getRandomValues also works on HTTP LANs.
 * Install before rendering so editor dependencies can use the same API. */
export function installRandomUUIDFallback(webCrypto: Crypto | undefined = globalThis.crypto): void {
  if (!webCrypto || typeof webCrypto.randomUUID === "function") return;
  if (typeof webCrypto.getRandomValues !== "function") return;

  Object.defineProperty(webCrypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: (): ReturnType<Crypto["randomUUID"]> => {
      const bytes = webCrypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<Crypto["randomUUID"]>;
    },
  });
}
