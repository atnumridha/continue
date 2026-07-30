export class AsyncTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(
      `${operation} timed out after ${Math.round(timeoutMs / 1000)} seconds`,
    );
    this.name = "AsyncTimeoutError";
  }
}

export async function withAsyncTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new AsyncTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
