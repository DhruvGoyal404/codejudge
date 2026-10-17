// Go variant of overread.cpp: reads its input to EOF, then keeps trying to
// read more. Must never receive bytes belonging to a later test.
package main

import (
	"fmt"
	"io"
	"os"
	"time"
)

func main() {
	own, _ := io.ReadAll(os.Stdin)
	var extra []byte
	buf := make([]byte, 4096)
	for i := 0; i < 20; i++ {
		time.Sleep(50 * time.Millisecond)
		for {
			n, err := os.Stdin.Read(buf)
			extra = append(extra, buf[:n]...)
			if n == 0 || err != nil {
				break
			}
		}
	}
	fmt.Printf("own=%s extra=%d extradata=%s\n", own, len(extra), extra)
}
