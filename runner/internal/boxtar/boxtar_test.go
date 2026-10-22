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
		"chardev":   rawTar(t, &tar.Header{Name: "null", Typeflag: tar.TypeChar, Devmajor: 1, Devminor: 3}),
		"blockdev":  rawTar(t, &tar.Header{Name: "sda", Typeflag: tar.TypeBlock, Devmajor: 8}),
		"colon":     rawTar(t, &tar.Header{Name: "c:x", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644}),
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

// CheckName is the only gate between an entry name and filepath.Join in
// Extract (CodeQL go/zipslip on boxtar.go): every escaping or ambiguous form is
// refused, and ordinary relative names pass.
func TestCheckName(t *testing.T) {
	for _, ok := range []string{"a", "a/b", "dir/", "Main.class", "a-b_c.1"} {
		if err := CheckName(ok); err != nil {
			t.Errorf("CheckName(%q) = %v, want ok", ok, err)
		}
	}
	for _, bad := range []string{
		"",                 // empty
		"/etc/passwd", "/", // absolute
		"..", "../x", "a/../../x", "a/..", "a/../b", // ".." components
		"a\\b", "..\\x", // backslash
		"c:x", "C:/x", // colon (drive letters, ADS)
		"a\x00b",                           // NUL
		"a//b", "./a", "a/./b", ".", "a/.", // not clean
	} {
		if err := CheckName(bad); err == nil {
			t.Errorf("CheckName(%q) accepted", bad)
		}
	}
}

// Extract never overwrites anything already in the target directory: not a
// regular file (here), and not a planted symlink, which would redirect the
// write outside dir (next test; skipped where symlinks need privileges, e.g.
// Windows, and run in CI on Linux). O_EXCL refuses both, and the originals are
// untouched.
func TestExtractNeverOverwrites(t *testing.T) {
	data := rawTar(t, &tar.Header{Name: "a", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644})

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a"), []byte("orig"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Extract(bytes.NewReader(data), dir, Limits{}); err == nil {
		t.Fatal("Extract overwrote an existing file")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "a")); string(got) != "orig" {
		t.Fatalf("existing file changed to %q", got)
	}
}

func TestExtractNeverWritesThroughASymlink(t *testing.T) {
	data := rawTar(t, &tar.Header{Name: "a", Typeflag: tar.TypeReg, Size: 1, Mode: 0o644})
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "a")); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
	if err := Extract(bytes.NewReader(data), dir, Limits{}); err == nil {
		t.Fatal("Extract wrote through a planted symlink")
	}
	if got, _ := os.ReadFile(outside); string(got) != "outside" {
		t.Fatalf("symlink target changed to %q", got)
	}
}
