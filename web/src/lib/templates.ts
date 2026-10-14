import type { Language } from "../api.ts";

// Starter code per language: read all of stdin quickly, write output once.
export const TEMPLATES: Record<Language, string> = {
  cpp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
`,
  python: `import sys

def main():
    data = sys.stdin.read().split()

main()
`,
  // Fast I/O: a byte-buffered token reader (Scanner is far too slow for
  // large inputs) and one PrintWriter flushed at the end. The class must be
  // named Main.
  java: `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        FastReader in = new FastReader(System.in);
        PrintWriter out = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out)));

        // int n = in.nextInt();

        out.flush();
    }

    static final class FastReader {
        private final DataInputStream in;
        private final byte[] buf = new byte[1 << 16];
        private int len, ptr;

        FastReader(InputStream is) { in = new DataInputStream(is); }

        private int read() throws IOException {
            if (ptr == len) { len = in.read(buf, 0, buf.length); ptr = 0; if (len <= 0) return -1; }
            return buf[ptr++];
        }

        long nextLong() throws IOException {
            int c = read();
            while (c != '-' && (c < '0' || c > '9')) c = read();
            boolean neg = c == '-';
            if (neg) c = read();
            long r = 0;
            for (; c >= '0' && c <= '9'; c = read()) r = r * 10 + (c - '0');
            return neg ? -r : r;
        }

        int nextInt() throws IOException { return (int) nextLong(); }

        String next() throws IOException {
            int c = read();
            while (c != -1 && c <= ' ') c = read();
            StringBuilder sb = new StringBuilder();
            for (; c > ' '; c = read()) sb.append((char) c);
            return sb.toString();
        }
    }
}
`,
  javascript: `// Read all of stdin at once, write the answer at the end.
const data = require("fs").readFileSync(0, "utf8").split(/\\s+/).filter(Boolean);
let pos = 0;
const next = () => data[pos++];

const out = [];
// const n = Number(next());

console.log(out.join("\\n"));
`,
};
