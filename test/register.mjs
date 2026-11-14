/**
 * Module resolution for the tests.
 *
 * The library is written for the bundler: `@/lib/pg` for the project root
 * and `./pg` for a sibling, both without an extension. Node's loader knows
 * neither, so without this a test can only load a module that imports
 * nothing — which is why every DB-backed module was untestable. The hook
 * maps `@/` onto `src/` and tries `.ts` (then `/index.ts`) on a bare
 * specifier. Nothing else changes: a test that writes `../src/lib/x.ts`
 * resolves exactly as before.
 *
 * Wired in by `npm test` (`node --import ./test/register.mjs --test …`).
 */
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

register(
  `data:text/javascript,${encodeURIComponent(`
    import { existsSync } from "node:fs";
    import { fileURLToPath, pathToFileURL } from "node:url";
    const root = ${JSON.stringify(root)};
    export async function resolve(specifier, context, next) {
      let target = specifier;
      if (target.startsWith("@/")) target = pathToFileURL(root + "/src/" + target.slice(2)).href;
      else if ((target.startsWith("./") || target.startsWith("../")) && context.parentURL)
        target = new URL(target, context.parentURL).href;
      else return next(specifier, context);
      if (target.startsWith("file:") && !/\\.[a-z]+$/i.test(target)) {
        const path = fileURLToPath(target);
        if (existsSync(path + ".ts")) target += ".ts";
        else if (existsSync(path + "/index.ts")) target += "/index.ts";
      }
      return next(target, context);
    }
  `)}`,
  { parentURL: pathToFileURL(root + "/").href },
);
