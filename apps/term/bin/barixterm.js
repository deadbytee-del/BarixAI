#!/usr/bin/env node
import { main } from "../src/cli.js";
const major = +process.versions.node.split(".")[0];
if (major < 20) { console.error(`BarixTerm needs Node.js 20 or newer (you have ${process.versions.node}). Get it at https://nodejs.org`); process.exit(1); }
main().catch(async (e) => {
  console.error(`\nBarixTerm error: ${e.message}`);
  try { // keep full details for bug reports: ~/.barix/last-error.log
    const { mkdir, writeFile } = await import("node:fs/promises"); const { homedir } = await import("node:os"); const { join } = await import("node:path"); const dir = join(homedir(), ".barix"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "last-error.log"), `${new Date().toISOString()}\nnode ${process.version} ${process.platform}/${process.arch}\nargs: ${process.argv.slice(2).join(" ")}\ncode: ${e.code ?? ""}\n${e.stack ?? e.message}\n`);
    console.error(`Details saved to ${join(dir, "last-error.log")}. For a self-check run:  BarixTerm.bat doctor`);
  } catch { /* best effort */ }
  if (process.env.BARIX_DEBUG) console.error(e.stack); process.exit(1);
});
