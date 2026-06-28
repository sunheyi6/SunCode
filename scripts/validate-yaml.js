import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const targets = ['.github/workflows', 'electron-builder.yml'];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function validateFile(path) {
  const content = readFileSync(path, 'utf-8');
  parse(content);
  console.log(`✓ ${path}`);
}

function validateDirectory(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!isFile(path)) continue;
    if (!/\.(yml|yaml)$/i.test(entry)) continue;
    validateFile(path);
  }
}

let failed = false;

for (const target of targets) {
  try {
    if (isFile(target)) {
      validateFile(target);
    } else {
      validateDirectory(target);
    }
  } catch (error) {
    failed = true;
    console.error(`✗ ${target}`);
    console.error(/** @type {Error} */ (error).message);
  }
}

if (failed) {
  process.exit(1);
}

console.log('All YAML files are valid.');
