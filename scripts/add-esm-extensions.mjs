// Appends .js to the relative specifiers tsc leaves alone.
//
// Node's ESM resolver requires the extension and refuses directory imports, and
// tsc emits specifiers exactly as written. Writing them with .js in the source
// is what NodeNext expects, but it puts a .js on every import in a TypeScript
// codebase and reads as though it is importing built output.
//
// Bundling would also solve it — that is what @gryt/ui does — but this package
// ships a web adapter and a React Native one. Metro picks between .native.ts
// and .web.ts per file, and a bundle has no files left to pick between, so
// bundling would foreclose the thing the package exists to do. So: unbundled
// output, and the extensions added on the way out.
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(p)));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

let patched = 0;
for (const file of await files(dist)) {
  const source = await readFile(file, "utf8");
  const specifiers = [...source.matchAll(/(from\s*|import\()"(\.\.?\/[^"]*)"/g)];
  let result = source;

  for (const [, , specifier] of specifiers) {
    if (/\.(js|json|mjs|cjs)$/.test(specifier)) continue;
    const target = resolve(dirname(file), specifier);
    const replacement = (await isDirectory(target))
      ? `${specifier}/index.js`
      : `${specifier}.js`;
    result = result.replaceAll(`"${specifier}"`, `"${replacement}"`);
  }

  if (result !== source) {
    await writeFile(file, result);
    patched += 1;
  }
}

console.log(`add-esm-extensions: rewrote specifiers in ${patched} files`);
