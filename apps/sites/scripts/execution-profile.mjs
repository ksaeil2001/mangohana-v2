import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));

export function readExecutionProfile(root = siteRoot) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(join(root, ".sites-runtime", "execution-profile.json"), "utf8"));
  } catch (error) {
    // Clean clones and remote builds have no checkout-local selection.
    if (error.code === "ENOENT") return "portable";
    throw error;
  }
  if (!["managed-linux", "portable"].includes(settings?.executionProfile)) {
    throw new Error("Invalid local execution profile; rerun the Sites plugin's configure-execution-profile.mjs.");
  }
  return settings.executionProfile;
}

export function readHostingConfig(root = siteRoot) {
  try {
    return readFileSync(join(root, ".openai", "hosting.json"));
  } catch (error) {
    if (error.code !== "ENOENT" || readExecutionProfile(root) !== "portable") throw error;
    return Buffer.from('{"d1":null,"r2":null}\n');
  }
}
