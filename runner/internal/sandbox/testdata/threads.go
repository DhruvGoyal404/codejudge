// 8 goroutines sum disjoint ranges (concurrency works in the sandbox, with
// GOMAXPROCS=1 they share one OS thread for Go code).
package main

import (
	"fmt"
	"sync"
)

func main() {
	const T = 8
	part := make([]int64, T)
	var wg sync.WaitGroup
	for t := 0; t < T; t++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := int64(id); i < 1_000_000; i += T {
				part[id] += i
			}
		}(t)
	}
	wg.Wait()
	var sum int64
	for _, p := range part {
		sum += p
	}
	fmt.Printf("threads=%d sum=%d\n", T, sum)
}
