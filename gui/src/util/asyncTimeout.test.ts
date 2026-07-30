import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncTimeoutError, withAsyncTimeout } from "./asyncTimeout";

describe("withAsyncTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the wrapped value when it completes in time", async () => {
    await expect(
      withAsyncTimeout(Promise.resolve("done"), 100, "quick task"),
    ).resolves.toBe("done");
  });

  it("rejects and runs the timeout callback when the task stalls", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pending = new Promise<string>(() => undefined);
    const result = withAsyncTimeout(pending, 1_000, "stuck task", onTimeout);
    const rejection = expect(result).rejects.toBeInstanceOf(AsyncTimeoutError);

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
