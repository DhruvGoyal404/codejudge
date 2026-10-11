// Package boxtar builds and safely reads the tar streams exchanged between the
// host runner and judge-exec. Every reader in this package treats its input as
// untrusted: entry names are validated, only regular files and directories are
// accepted, and total size and entry counts are bounded.
package boxtar

import (
	"archive/tar"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Limits bounds what a reader will accept.
type Limits struct {
	MaxBytes int64 // total payload bytes across all regular files
	MaxFiles int   // number of regular files
}

// File is one regular file in an archive.
type File struct {
	Name string // slash-separated relative path
	Mode int64  // permission bits (0644, 0755, ...)
	Data []byte
}

// ErrLimit is wrapped by errors caused by exceeding Limits.
var ErrLimit = errors.New("tar limit exceeded")

// Build returns a tar archive containing files.
func Build(files []File) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, f := range files {
		if err := CheckName(f.Name); err != nil {
			return nil, err
		}
		mode := f.Mode
		if mode == 0 {
			mode = 0o644
		}
		hdr := &tar.Header{Name: f.Name, Mode: mode, Size: int64(len(f.Data)), Typeflag: tar.TypeReg, Format: tar.FormatPAX}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if _, err := tw.Write(f.Data); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// CheckName rejects empty, absolute, backslash-containing, or ".."-containing
// entry names, and names that are not already in clean form.
func CheckName(name string) error {
	if name == "" {
		return fmt.Errorf("empty entry name")
	}
	if strings.ContainsAny(name, "\\:\x00") {
		return fmt.Errorf("illegal character in entry name %q", name)
	}
	if path.IsAbs(name) {
		return fmt.Errorf("absolute entry name %q", name)
	}
	trimmed := strings.TrimSuffix(name, "/")
	for _, el := range strings.Split(trimmed, "/") {
		if el == ".." {
			return fmt.Errorf("entry name %q contains ..", name)
		}
	}
	if path.Clean(trimmed) != trimmed || trimmed == "." {
		return fmt.Errorf("entry name %q is not clean", name)
	}
	return nil
}

// Extract reads a tar stream from r into dir, enforcing lim. Only regular
// files and directories are allowed; links, devices and FIFOs are rejected.
// Existing files are never overwritten.
func Extract(r io.Reader, dir string, lim Limits) error {
	tr := tar.NewReader(r)
	var total int64
	files := 0
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read tar: %w", err)
		}
		if err := CheckName(h.Name); err != nil {
			return err
		}
		dst := filepath.Join(dir, filepath.FromSlash(strings.TrimSuffix(h.Name, "/")))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			files++
			if lim.MaxFiles > 0 && files > lim.MaxFiles {
				return fmt.Errorf("%w: more than %d files", ErrLimit, lim.MaxFiles)
			}
			if h.Size < 0 || (lim.MaxBytes > 0 && total+h.Size > lim.MaxBytes) {
				return fmt.Errorf("%w: more than %d bytes", ErrLimit, lim.MaxBytes)
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			perm := os.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				perm = 0o755
			}
			f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
			if err != nil {
				return err
			}
			n, err := io.Copy(f, io.LimitReader(tr, h.Size))
			cerr := f.Close()
			if err != nil {
				return err
			}
			if cerr != nil {
				return cerr
			}
			if n != h.Size {
				return fmt.Errorf("short entry %q: %d of %d bytes", h.Name, n, h.Size)
			}
			total += n
		default:
			return fmt.Errorf("unsupported tar entry type %q for %q", h.Typeflag, h.Name)
		}
	}
}

// ReadAll reads a tar stream fully into memory under lim. Directories are
// skipped; any other non-regular entry is an error.
func ReadAll(r io.Reader, lim Limits) (map[string][]byte, error) {
	tr := tar.NewReader(r)
	out := map[string][]byte{}
	var total int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		if err := CheckName(h.Name); err != nil {
			return nil, err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			continue
		case tar.TypeReg:
		default:
			return nil, fmt.Errorf("unsupported tar entry type %q for %q", h.Typeflag, h.Name)
		}
		if lim.MaxFiles > 0 && len(out) >= lim.MaxFiles {
			return nil, fmt.Errorf("%w: more than %d files", ErrLimit, lim.MaxFiles)
		}
		if h.Size < 0 || (lim.MaxBytes > 0 && total+h.Size > lim.MaxBytes) {
			return nil, fmt.Errorf("%w: more than %d bytes", ErrLimit, lim.MaxBytes)
		}
		if _, dup := out[h.Name]; dup {
			return nil, fmt.Errorf("duplicate entry %q", h.Name)
		}
		data, err := io.ReadAll(io.LimitReader(tr, h.Size))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) != h.Size {
			return nil, fmt.Errorf("short entry %q", h.Name)
		}
		total += h.Size
		out[h.Name] = data
	}
}
