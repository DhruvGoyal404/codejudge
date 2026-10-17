package main

var sink uint64

func main() {
	for i := uint64(0); ; i++ {
		sink += i
	}
}
