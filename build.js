/* Builds dist/ from src/. Run before tagging a release — jsDelivr
   serves whatever is committed at the tag, so dist/ must be in git. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const src = path.join(ROOT, "src", "consent-gate.js");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const banner = `/*! consent-gate v${pkg.version} | MIT | ${pkg.homepage} */\n`;

fs.writeFileSync(
  path.join(ROOT, "dist", "consent-gate.js"),
  banner + fs.readFileSync(src, "utf8")
);

const min = execFileSync("npx", ["terser", src, "-c", "-m", "--toplevel"], {
  encoding: "utf8",
  cwd: ROOT
}).trim();
fs.writeFileSync(path.join(ROOT, "dist", "consent-gate.min.js"), banner + min + "\n");

console.log("dist/consent-gate.js     ", fs.statSync(path.join(ROOT,"dist","consent-gate.js")).size, "bytes");
console.log("dist/consent-gate.min.js ", fs.statSync(path.join(ROOT,"dist","consent-gate.min.js")).size, "bytes");
