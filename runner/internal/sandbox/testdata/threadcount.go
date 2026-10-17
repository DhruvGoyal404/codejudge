// Reports the Go runtime's thread count after start-up and some work
// (calibrates ExtraTasks), plus the limits the sandbox set for it.
package main

import (
	"fmt"
	"os"
	"regexp"
	"runtime"
	"runtime/debug"
)

func main() {
	// Allocate and collect a few times so the GC's background workers start.
	var keep [][]byte
	for i := 0; i < 64; i++ {
		keep = append(keep, make([]byte, 1<<20))
		if i%8 == 0 {
			runtime.GC()
		}
	}
	_ = keep
	s, _ := os.ReadFile("/proc/self/status")
	m := regexp.MustCompile(`(?m)^Threads:\s+(\d+)`).FindSubmatch(s)
	fmt.Println(string(m[1]))
	fmt.Fprintf(os.Stderr, "GOMAXPROCS=%d memlimit=%d\n", runtime.GOMAXPROCS(0), debug.SetMemoryLimit(-1))
}
