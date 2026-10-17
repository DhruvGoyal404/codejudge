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
  // Fast I/O: one big fread buffer and a hand-rolled integer reader; output
  // through one buffer written at the end. Link flags: -O2 -static -lm.
  c: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char ibuf[1 << 16];
static size_t ilen, ipos;

static int rd(void) {
    if (ipos == ilen) { ilen = fread(ibuf, 1, sizeof ibuf, stdin); ipos = 0; if (ilen == 0) return -1; }
    return ibuf[ipos++];
}

static long long next_ll(void) {
    int c = rd();
    while (c != '-' && (c < '0' || c > '9')) c = rd();
    int neg = c == '-';
    if (neg) c = rd();
    long long r = 0;
    for (; c >= '0' && c <= '9'; c = rd()) r = r * 10 + (c - '0');
    return neg ? -r : r;
}

int main(void) {
    // long long n = next_ll();

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
  // Fast I/O: a buffered byte reader with a hand-rolled integer parser
  // (fmt.Fscan is slow on large inputs) and one bufio.Writer flushed at the
  // end. Standard library only; package main.
  go: `package main

import (
	"bufio"
	"os"
	"strconv"
)

var in = bufio.NewReaderSize(os.Stdin, 1<<16)

func nextInt() int {
	n, c, neg := 0, readByte(), false
	for c == ' ' || c == '\\n' || c == '\\r' || c == '\\t' {
		c = readByte()
	}
	if c == '-' {
		neg, c = true, readByte()
	}
	for ; c >= '0' && c <= '9'; c = readByte() {
		n = n*10 + int(c-'0')
	}
	if neg {
		return -n
	}
	return n
}

func readByte() byte {
	b, err := in.ReadByte()
	if err != nil {
		return 0
	}
	return b
}

func main() {
	out := bufio.NewWriterSize(os.Stdout, 1<<16)
	defer out.Flush()

	// n := nextInt()
	// out.WriteString(strconv.Itoa(n)); out.WriteByte('\\n')
	_ = strconv.Itoa // keeps the import while unused
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
