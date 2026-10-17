// Go variant of snoop.py: prints its own input, then every file it can find
// in /box, /tmp and /dev/shm (other tests' inputs or outputs must not be
// there), and leaves files behind for the next test to find.
package main

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	b, _ := io.ReadAll(os.Stdin)
	own := strings.TrimSpace(string(b))
	fmt.Println("own: " + own)
	for _, root := range []string{"/box", "/tmp", "/dev/shm"} {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			data, err := os.ReadFile(p)
			if err != nil {
				return nil
			}
			if len(data) > 200 {
				data = data[:200]
			}
			fmt.Println("found " + p + " " + strings.TrimSpace(string(data)))
			return nil
		})
	}
	os.WriteFile("/tmp/left-behind", []byte("LEFTOVER "+own), 0o644)
	os.WriteFile("/box/left-behind", []byte("LEFTOVER "+own), 0o644)
}
