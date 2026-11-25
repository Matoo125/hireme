// Write to a temporary file next to the target, then rename it into place.
// A rename on the same filesystem is atomic, so a request reading the file
// at the same time sees the old contents or the new, never half of either.
import { rename, rm } from "fs/promises";

let counter = 0;

export async function writeFileAtomic(file: string, data: string | Uint8Array | ArrayBuffer | Blob): Promise<void> {
  const tmp = `${file}.${process.pid}.${++counter}.tmp`;
  try {
    await Bun.write(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
