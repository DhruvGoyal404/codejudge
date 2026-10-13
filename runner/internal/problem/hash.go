package problem

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

// ContentHash returns "sha256:<hex>" over everything that defines how a
// submission is judged: problem.yaml, statement.md and every test file.
// Generators and solutions are excluded. Each file contributes its
// slash-separated relative path and contents, length-prefixed, in sorted
// order, so the hash is identical on every OS and filesystem.
func (p *Problem) ContentHash() (string, error) {
	files := []string{"problem.yaml", "statement.md"}
	for _, t := range p.Tests {
		files = append(files, "tests/"+filepath.Base(t.InputPath), "tests/"+filepath.Base(t.OutputPath))
	}
	sort.Strings(files)
	h := sha256.New()
	var lenBuf [8]byte
	for _, rel := range files {
		f, err := os.Open(filepath.Join(p.Dir, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			return "", err
		}
		binary.BigEndian.PutUint64(lenBuf[:], uint64(len(rel)))
		h.Write(lenBuf[:])
		h.Write([]byte(rel))
		binary.BigEndian.PutUint64(lenBuf[:], uint64(st.Size()))
		h.Write(lenBuf[:])
		n, err := io.Copy(h, f)
		f.Close()
		if err != nil {
			return "", err
		}
		if n != st.Size() {
			return "", fmt.Errorf("%s changed while hashing", rel)
		}
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}
