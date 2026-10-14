// Keeps allocating: V8 hits --max-old-space-size -> "heap out of memory" -> MLE.
const blocks = [];
for (;;) blocks.push(new Array(1 << 17).fill(1.5));
