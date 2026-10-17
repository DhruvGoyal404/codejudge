// Keeps every 1 MB block alive and touches it: the heap passes GOMEMLIMIT
// (a soft limit) and then the hard limit, which must be MLE, not RE or TLE.
package main

func main() {
	var keep [][]byte
	for {
		b := make([]byte, 1<<20)
		for i := range b {
			b[i] = 1
		}
		keep = append(keep, b)
	}
}
