#!/usr/bin/env node
import { main } from "../src/cli.js";
const major = +process.versions.node.split(".")[0];
if (major < 20) { console.error(`BarixTerm needs Node.js 20 or newer (you have ${process.versions.node}). Get it at https://nodejs.org`); process.exit(1); }
main().catch((e) => { console.error(`\nBarixTerm error: ${e.message}`); if (process.env.BARIX_DEBUG) console.error(e.stack); process.exit(1); });
