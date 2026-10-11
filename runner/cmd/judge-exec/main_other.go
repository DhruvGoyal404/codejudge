//go:build !linux

// judge-exec only runs inside Linux sandbox containers. This stub keeps
// `go build ./...` and `go vet ./...` working on the Windows dev host.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "judge-exec runs only on Linux (inside sandbox containers)")
	os.Exit(2)
}
