import fs from "node:fs";
import path from "node:path";

export function loadEnvFiles(rootDir = process.cwd()) {
  for (const name of [".env", ".env.local"]) {
    const filePath = path.join(rootDir, name);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseEnv(content);

    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function parseEnv(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const exportLine = line.startsWith("export ") ? line.slice(7) : line;
    const separatorIndex = exportLine.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = exportLine.slice(0, separatorIndex).trim();
    let value = exportLine.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}
