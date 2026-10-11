package boxtar

import (
	"archive/tar"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func rawTar(t *testing.T, hdrs ...*tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, h := range hdrs {
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg && h.Size > 0 {
			if _, err := tw.Write(bytes.Repeat([]byte("x"), int(h.Size))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestRoundTrip(t *testing.T) {
	data, err := Build([]File{{Name: "main.cpp", Data: []byte("int main(){}")}, {Name: "sub/input", Mode: 0o755, Data: []byte("1 2\n")}})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := Extract(bytes.NewReader(data), dir, Limits{MaxBytes: 1 << 20, MaxFiles: 4}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "sub", "input"))
	if err != nil || string(got) != "1 2\n" {
		t.Fatalf("got %q, %v", got, err)
	}
	m, err := ReadAll(bytes.NewReader(data), Limits{MaxBytes: 1 << 20, MaxFiles: 4})
	if err != nil || string(m["main.cpp"]) != "int main(){}" {
		t.Fatalf("ReadAll: %v %v", m, err)
	}
}

func TestRejects(t *testing.T) {
	lim := Limits{MaxBytes: 100, MaxFiles: 2}
	cases := map[string][]byte{
		"absolute":  rawTar(t, &tar.Header{Name: "/etc/passwd", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
		"dotdot":    rawTar(t, &tar.Header{Name: "a/../../x", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
		"leading..": rawTar(t, &tar.Header{Name: "../x", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
		"backslash": rawTar(t, &tar.Header{Name: "..\\x", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
		"symlink":   rawTar(t, &tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}),
		"hardlink":  rawTar(t, &tar.Header{Name: "hl", Typeflag: tar.TypeLink, Linkname: "main"}),
		"fifo":      rawTar(t, &tar.Header{Name: "p", Typeflag: tar.TypeFifo}),
		"too-big":   rawTar(t, &tar.Header{Name: "big", Typeflag: tar.TypeReg, Size: 101, Mode: 0o644}),
		"too-many": rawTar(t,
			&tar.Header{Name: "a", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644},
			&tar.Header{Name: "b", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644},
			&tar.Header{Name: "c", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
		"duplicate": rawTar(t,
			&tar.Header{Name: "a", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644},
			&tar.Header{Name: "a", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
		"unclean": rawTar(t, &tar.Header{Name: "a//b", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if err := Extract(bytes.NewReader(data), t.TempDir(), lim); err == nil {
				t.Fatal("Extract accepted malicious archive")
			}
			if _, err := ReadAll(bytes.NewReader(data), lim); err == nil {
				t.Fatal("ReadAll accepted malicious archive")
			}
		})
	}
	err := Extract(bytes.NewReader(cases["too-big"]), t.TempDir(), lim)
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("want ErrLimit, got %v", err)
	}
}
