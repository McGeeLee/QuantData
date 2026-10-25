import { AppError } from "./app-error";

const EMPTY_BODY_TIMEOUT_MS = 1_000;
const MAX_EMPTY_CHUNKS = 8;

/** Incoming HTTP requests may have a non-null stream even with zero body bytes. */
export async function assertEmptyRequestBody(request: Request): Promise<void> {
  if (request.body === null) return;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    throw new AppError("INVALID_REQUEST", 400);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppError("INVALID_REQUEST", 400)), EMPTY_BODY_TIMEOUT_MS);
  });
  try {
    // Never buffer a body. EOF means empty; the first non-empty chunk rejects it.
    // Bound zero-byte chunks too, so a busy stream cannot starve the deadline.
    for (let count = 0; count < MAX_EMPTY_CHUNKS; count += 1) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) return;
      if (chunk.value.byteLength > 0) throw new AppError("INVALID_REQUEST", 400);
    }
    throw new AppError("INVALID_REQUEST", 400);
  } catch {
    // Cancellation can itself stall; validation must still finish on time.
    void reader.cancel().catch(() => undefined);
    throw new AppError("INVALID_REQUEST", 400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
