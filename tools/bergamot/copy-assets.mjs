import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const packageWorkerDirectory = resolve(
  repositoryRoot,
  'node_modules/@browsermt/bergamot-translator/worker',
);
const targetRoot = resolve(process.cwd(), process.argv[2] ?? '.');
const outputDirectory = resolve(targetRoot, 'public/bergamot');

await mkdir(outputDirectory, { recursive: true });

for (const filename of [
  'translator-worker.js',
  'bergamot-translator-worker.js',
  'bergamot-translator-worker.wasm',
]) {
  await copyFile(
    resolve(packageWorkerDirectory, filename),
    resolve(outputDirectory, filename),
  );
}

console.log(`Copied Bergamot worker assets to ${outputDirectory}`);
