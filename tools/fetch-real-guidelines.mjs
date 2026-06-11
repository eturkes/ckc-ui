import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "corpus", "real_guidelines", "japanese_guidelines.json");
const manifestPath = path.join(root, "corpus", "raw", "real-guidelines", "manifest.json");

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "ckc-manuscript-figures-source-fetcher/1.0 (+https://local.invalid/ckc)"
    }
  });
  if (!response.ok) {
    throw new Error(`fetch failed ${response.status} ${response.statusText}: ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const sources = [];

  for (const source of registry.sources) {
    const artifacts = [];
    for (const raw of source.raw_artifacts) {
      const bytes = await fetchBytes(raw.url);
      const absolutePath = path.join(root, raw.path);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, bytes);
      artifacts.push({
        artifact_id: raw.artifact_id,
        kind: raw.kind,
        url: raw.url,
        path: raw.path,
        bytes: bytes.length,
        sha256: sha256Bytes(bytes),
        fetched_at_utc: new Date().toISOString()
      });
    }
    sources.push({
      id: source.id,
      title_ja: source.title_ja,
      license_label: source.license.label,
      artifacts
    });
  }

  const manifest = {
    artifact_kind: "RawRealGuidelineFetchManifest",
    schema_version: 1,
    registry_path: path.relative(root, registryPath),
    fetched_at_utc: new Date().toISOString(),
    sources
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    manifest: path.relative(root, manifestPath),
    sources: sources.length,
    artifacts: sources.reduce((count, source) => count + source.artifacts.length, 0)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
