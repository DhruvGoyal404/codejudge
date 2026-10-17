// Go variant of fds.cpp: lists every open file descriptor and its target.
// The Go runtime opens none of its own beyond 0-2 (no epoll until a poller
// is needed), so any extra entry is a leak from judge-exec.
package main

import (
	"fmt"
	"os"
)

func main() {
	// Read the directory with a raw fd-free walk: os.ReadDir opens the
	// directory itself (that fd is listed too, as for the C++ variant).
	ents, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		fmt.Println("readdir:", err)
		os.Exit(1)
	}
	for _, e := range ents {
		target, err := os.Readlink("/proc/self/fd/" + e.Name())
		if err != nil {
			continue
		}
		fmt.Printf("fd %s -> %s\n", e.Name(), target)
	}
}
