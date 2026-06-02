import { describe, expect, it } from "vitest";
import { isUserNotInitializedError } from "./altastata";

describe("isUserNotInitializedError", () => {
  it("matches FAILED_PRECONDITION (gRPC status 9)", () => {
    expect(
      isUserNotInitializedError(
        new Error("gRPC status=9 message=User is not initialized"),
      ),
    ).toBe(true);
  });

  it("matches the literal 'User is not initialized' message", () => {
    expect(isUserNotInitializedError("User is not initialized")).toBe(true);
  });

  it("matches the alternate 'has not been initialized' wording", () => {
    expect(
      isUserNotInitializedError(
        new Error("gRPC status=9 message=User has not been initialized"),
      ),
    ).toBe(true);
  });

  it("matches the password-bootstrap signatures (status=13)", () => {
    expect(
      isUserNotInitializedError(
        new Error(
          "gRPC status=13 message=Read stream failed: Password is null, but a password is required",
        ),
      ),
    ).toBe(true);
    expect(
      isUserNotInitializedError("call setPassword first"),
    ).toBe(true);
    expect(
      isUserNotInitializedError("set password for user failed"),
    ).toBe(true);
    expect(
      isUserNotInitializedError("account_password cannot be empty"),
    ).toBe(true);
  });

  it("matches UNAUTHENTICATED (gRPC status 16 / Invalid token)", () => {
    expect(
      isUserNotInitializedError(new Error("gRPC status=16 message=Invalid token")),
    ).toBe(true);
    expect(
      isUserNotInitializedError("invalid token"),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(
      isUserNotInitializedError(new Error("Network error: failed to fetch")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=14 message=Unavailable")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=5 message=Not found")),
    ).toBe(false);
    expect(isUserNotInitializedError(undefined)).toBe(false);
    expect(isUserNotInitializedError(null)).toBe(false);
  });

  it("does not confuse status=9/16 prefix-collisions like status=99 or status=160", () => {
    expect(
      isUserNotInitializedError(new Error("gRPC status=99 message=Synthetic")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=19 message=Synthetic")),
    ).toBe(false);
    expect(
      isUserNotInitializedError(new Error("gRPC status=160 message=Synthetic")),
    ).toBe(false);
  });
});
