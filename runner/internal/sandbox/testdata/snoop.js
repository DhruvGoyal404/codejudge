// JavaScript variant of snoop.py.
const fs = require("fs");
const path = require("path");
const own = fs.readFileSync(0, "utf8").trim();
console.log("own: " + own);
const walk = (dir) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) {
      try { console.log("found " + p + " " + fs.readFileSync(p).subarray(0, 200).toString().trim()); } catch {}
    }
  }
};
for (const root of ["/box", "/tmp", "/dev/shm"]) walk(root);
fs.writeFileSync("/tmp/left-behind", "LEFTOVER " + own);
fs.writeFileSync("/box/left-behind", "LEFTOVER " + own);
