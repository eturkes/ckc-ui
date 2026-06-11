import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localDir = path.join(root, ".local");
const downloadsDir = path.join(localDir, "downloads");
const binDir = path.join(localDir, "bin");
const llamaDir = path.join(localDir, "llama.cpp", "b9592");
const modelDir = path.join(localDir, "models");

const llamaArchive = "llama-b9592-bin-ubuntu-x64.tar.gz";
const llamaUrl = `https://github.com/ggml-org/llama.cpp/releases/download/b9592/${llamaArchive}`;
const modelFile = "qwen2.5-0.5b-instruct-q2_k.gguf";
const modelUrl = `https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/${modelFile}`;

const archivePath = path.join(downloadsDir, llamaArchive);
const modelPath = path.join(modelDir, modelFile);
const linkedCli = path.join(binDir, "llama-cli");

async function download(url, destination) {
  if (existsSync(destination)) return;
  console.log(`download ${url}`);
  const response = await fetch(url, { headers: { "User-Agent": "ckc-manuscript-figures-local-model-setup" } });
  if (!response.ok || !response.body) {
    throw new Error(`download failed ${response.status} ${response.statusText}: ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`setup-local-model currently supports linux x64 only; got ${process.platform} ${process.arch}`);
  }

  await mkdir(downloadsDir, { recursive: true });
  await mkdir(modelDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(llamaDir, { recursive: true });

  await download(llamaUrl, archivePath);
  await download(modelUrl, modelPath);

  if (!existsSync(path.join(llamaDir, "llama-cli"))) {
    const result = spawnSync("tar", ["-xzf", archivePath, "-C", llamaDir], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`tar failed: ${result.stderr || result.stdout}`);
    }
  }

  const cli = await findFile(llamaDir, "llama-cli");
  await chmod(cli, 0o755);
  await unlink(linkedCli).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(path.relative(binDir, cli), linkedCli);

  const version = spawnSync(linkedCli, ["--version"], { encoding: "utf8" });
  console.log(JSON.stringify({
    llama_cli: path.relative(root, linkedCli),
    llama_version: `${version.stdout}${version.stderr}`.trim().split("\n")[0],
    model: path.relative(root, modelPath),
    model_sha256: await sha256File(modelPath)
  }, null, 2));
}

async function findFile(directory, basename) {
  const result = spawnSync("find", [directory, "-type", "f", "-name", basename, "-print", "-quit"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`find failed: ${result.stderr || result.stdout}`);
  }
  const found = result.stdout.trim();
  if (!found) throw new Error(`${basename} not found under ${directory}`);
  return found;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
