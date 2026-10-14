// Reports Node's thread count after start-up (calibrates ExtraTasks).
const s = require("fs").readFileSync("/proc/self/status", "utf8");
console.log(s.match(/^Threads:\s+(\d+)/m)[1]);
