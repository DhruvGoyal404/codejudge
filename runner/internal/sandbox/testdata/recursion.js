// Deep recursion (depth 200000) must work: --stack-size raises V8's limit.
function depth(n) { return n === 0 ? 0 : 1 + depth(n - 1); }
console.log(depth(200000));
