// Deep recursion (depth 200000) must work: goroutine stacks grow on the heap.
package main

import "fmt"

func depth(n int) int {
	if n == 0 {
		return 0
	}
	return 1 + depth(n-1)
}

func main() { fmt.Println(depth(200000)) }
