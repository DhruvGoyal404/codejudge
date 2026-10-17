// Imports a package outside the standard library: the sandbox is offline
// and has no module cache, so this must be a compilation error.
package main

import "golang.org/x/exp/constraints"

func max[T constraints.Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}

func main() { println(max(1, 2)) }
