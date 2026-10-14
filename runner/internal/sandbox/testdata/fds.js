// JavaScript variant of fds.cpp: list this process's descriptors.
const fs = require("fs");
for (const name of fs.readdirSync("/proc/self/fd").map(Number).sort((a, b) => a - b)) {
  try { console.log(`fd ${name} -> ${fs.readlinkSync("/proc/self/fd/" + name)}`); } catch {}
}
