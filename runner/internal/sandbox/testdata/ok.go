package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	var a, b int64
	fmt.Fscan(bufio.NewReader(os.Stdin), &a, &b)
	fmt.Println(a + b)
}
