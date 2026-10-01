import { describe, expect, it, vi } from "vitest";
import { installRandomUUIDFallback } from "./crypto-compat";

describe("HTTP LAN UUID compatibility", () => {
  it("preserves the native implementation", () => {
    const native = vi.fn();
    const crypto = { randomUUID: native } as unknown as Crypto;
    installRandomUUIDFallback(crypto);
    expect(crypto.randomUUID).toBe(native);
  });

  it("generates RFC 4122 v4 IDs using fresh cryptographic bytes without randomUUID", () => {
    let sequence = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(++sequence);
      return bytes;
    });
    const crypto = { getRandomValues } as unknown as Crypto;
    installRandomUUIDFallback(crypto);
    expect(crypto.randomUUID()).toBe("01010101-0101-4101-8101-010101010101");
    expect(crypto.randomUUID()).toBe("02020202-0202-4202-8202-020202020202");
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    const installed = crypto.randomUUID;
    installRandomUUIDFallback(crypto);
    expect(crypto.randomUUID).toBe(installed);
  });

  it("does not substitute weak randomness when Web Crypto is unavailable", () => {
    const crypto = {} as Crypto;
    installRandomUUIDFallback(crypto);
    expect(crypto.randomUUID).toBeUndefined();
  });
});
