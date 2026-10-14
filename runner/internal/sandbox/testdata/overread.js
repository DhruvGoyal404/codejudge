// JavaScript variant of overread.cpp.
const fs = require("fs");
const buf = Buffer.alloc(4096);
const readAll = () => {
  const parts = [];
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) { if (e.code === "EAGAIN") break; throw e; }
    if (n <= 0) break;
    parts.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(parts);
};
const own = readAll();
const extras = [];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; i < 20; i++) { sleep(50); extras.push(readAll()); }
const extra = Buffer.concat(extras);
console.log(`own=${own.toString()} extra=${extra.length} extradata=${extra.toString()}`);
