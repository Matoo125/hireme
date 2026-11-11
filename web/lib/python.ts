// The Python that runs the repo's scripts: $PYTHON if set, else the project's
// virtualenv (made by `uv sync`, with the locked dependencies), else python3.

import { existsSync } from "fs";
import path from "path";

export function pythonFor(repoDir: string): string {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = path.join(repoDir, ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}
