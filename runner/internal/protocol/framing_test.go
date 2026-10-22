package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"runtime"
	"testing"
)

func TestMsgRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	prog := append(bytes.Repeat([]byte{7}, NonceSize), []byte("tar-bytes")...)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(WriteMsg(&buf, MsgProgram, prog))
	must(WriteMsg(&buf, MsgTest, []byte("1 2\n")))
	must(WriteMsg(&buf, MsgTest, nil)) // zero-length input is valid
	must(WriteMsg(&buf, MsgEnd, nil))

	want := []struct {
		typ byte
		p   []byte
	}{{MsgProgram, prog}, {MsgTest, []byte("1 2\n")}, {MsgTest, []byte{}}, {MsgEnd, []byte{}}}
	for i, w := range want {
		typ, p, err := ReadMsg(&buf, 1<<20)
		if err != nil {
			t.Fatalf("msg %d: %v", i, err)
		}
		if typ != w.typ || !bytes.Equal(p, w.p) {
			t.Fatalf("msg %d: got (%c, %q), want (%c, %q)", i, typ, p, w.typ, w.p)
		}
	}
	if _, _, err := ReadMsg(&buf, 1<<20); err != io.EOF {
		t.Fatalf("after last message: %v, want clean io.EOF", err)
	}
}

func TestMsgTruncated(t *testing.T) {
	var full bytes.Buffer
	if err := WriteMsg(&full, MsgTest, []byte("hello world")); err != nil {
		t.Fatal(err)
	}
	b := full.Bytes()
	for cut := 1; cut < len(b); cut++ { // every proper prefix, header or payload
		_, _, err := ReadMsg(bytes.NewReader(b[:cut]), 1<<20)
		if !errors.Is(err, ErrTruncated) {
			t.Fatalf("cut at %d/%d: err = %v, want ErrTruncated", cut, len(b), err)
		}
	}
}

// countingReader fails the test if more than limit bytes are read: proves an
// oversized length is rejected before the payload is read or allocated.
type countingReader struct {
	r     io.Reader
	n     int
	limit int
	t     *testing.T
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	if c.n > c.limit {
		c.t.Fatalf("read %d bytes past header", c.n)
	}
	return n, err
}

func TestMsgOversized(t *testing.T) {
	hdr := []byte{MsgTest, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(hdr[1:], 0xFFFFFFF0) // claims ~4 GiB
	r := &countingReader{r: bytes.NewReader(append(hdr, make([]byte, 64)...)), limit: 5 + 64, t: t}
	if _, _, err := ReadMsg(r, 1<<20); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	// exactly at the limit is fine, one over is not
	var ok, over bytes.Buffer
	_ = WriteMsg(&ok, MsgTest, make([]byte, 100))
	_ = WriteMsg(&over, MsgTest, make([]byte, 101))
	if _, _, err := ReadMsg(&ok, 100); err != nil {
		t.Fatalf("at limit: %v", err)
	}
	if _, _, err := ReadMsg(&over, 100); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("over limit: %v", err)
	}
}

func TestMsgMalformed(t *testing.T) {
	cases := map[string][]byte{
		"unknown type":               {'X', 0, 0, 0, 0},
		"end with payload":           {MsgEnd, 0, 0, 0, 1, 'z'},
		"program shorter than nonce": append([]byte{MsgProgram, 0, 0, 0, 4}, 1, 2, 3, 4),
	}
	for name, b := range cases {
		if _, _, err := ReadMsg(bytes.NewReader(b), 1<<20); err == nil || errors.Is(err, ErrTruncated) {
			t.Errorf("%s: err = %v, want a malformed-message error", name, err)
		}
	}
	if err := WriteMsg(io.Discard, 'X', nil); !errors.Is(err, ErrBadType) {
		t.Errorf("WriteMsg unknown type: %v", err)
	}
	if err := WriteMsg(io.Discard, MsgEnd, []byte("x")); err == nil {
		t.Error("WriteMsg end with payload accepted")
	}
}

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := Frame{Mode: "batch", Seq: 3, Nonce: "abcd", Status: StatusExited, ExitCode: 1, Stdout: []byte{0xff, 0x00, 'x'}}
	if err := WriteFrame(&buf, in); err != nil {
		t.Fatal(err)
	}
	if err := WriteFrame(&buf, Frame{Mode: "batch", Status: StatusReady}); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFrame(&buf, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if got.Seq != 3 || got.Nonce != "abcd" || got.ExitCode != 1 || !bytes.Equal(got.Stdout, in.Stdout) {
		t.Fatalf("got %+v", got)
	}
	if got, err := ReadFrame(&buf, 1<<20); err != nil || got.Status != StatusReady {
		t.Fatalf("second frame: %+v %v", got, err)
	}
	if _, err := ReadFrame(&buf, 1<<20); err != io.EOF {
		t.Fatalf("after last frame: %v, want io.EOF", err)
	}
}

func TestFrameErrors(t *testing.T) {
	var full bytes.Buffer
	_ = WriteFrame(&full, Frame{Mode: "batch", Status: StatusExited})
	b := full.Bytes()
	for cut := 1; cut < len(b); cut++ {
		if _, err := ReadFrame(bytes.NewReader(b[:cut]), 1<<20); !errors.Is(err, ErrTruncated) {
			t.Fatalf("cut %d/%d: %v, want ErrTruncated", cut, len(b), err)
		}
	}
	if _, err := ReadFrame(bytes.NewReader(b), 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("small limit: %v, want ErrTooLarge", err)
	}
	bad := append([]byte("XFR1"), b[4:]...)
	if _, err := ReadFrame(bytes.NewReader(bad), 1<<20); !errors.Is(err, ErrBadMagic) {
		t.Fatalf("bad magic: %v", err)
	}
	notJSON := append([]byte(FrameMagic), 0, 0, 0, 3, 'a', 'b', 'c')
	if _, err := ReadFrame(bytes.NewReader(notJSON), 1<<20); !errors.Is(err, ErrBadPayload) {
		t.Fatalf("bad json: %v", err)
	}
	huge := append([]byte(FrameMagic), 0xff, 0xff, 0xff, 0xff)
	r := &countingReader{r: bytes.NewReader(huge), limit: 8, t: t}
	if _, err := ReadFrame(r, 1<<20); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("huge length: %v", err)
	}
}

// A body over MaxFrameBytes is refused before the frame (8+len) is built, and
// nothing is written.
func TestWriteFrameRejectsOversizeBody(t *testing.T) {
	var buf bytes.Buffer
	// base64 makes the JSON body 4/3 the size of Stdout: just over the limit.
	big := Frame{Mode: "batch", Status: StatusExited, Stdout: make([]byte, MaxFrameBytes/4*3+1)}
	if err := WriteFrame(&buf, big); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize body: %v, want ErrTooLarge", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("%d bytes written for a refused frame", buf.Len())
	}
	// The largest real frame (16 MiB stdout + 64 KiB stderr) still fits.
	largest := Frame{Mode: "batch", Status: StatusExited, Stdout: make([]byte, 16<<20), Stderr: make([]byte, 64<<10)}
	if err := WriteFrame(&buf, largest); err != nil {
		t.Fatalf("largest real frame: %v", err)
	}
}

// A length prefix over MaxFrameBytes is refused from the header alone, even
// when the caller allows more: nothing past the 8-byte header is read, and no
// body-sized buffer is allocated.
func TestReadFrameRejectsLengthAboveMaxFrameBytes(t *testing.T) {
	hdr := binary.BigEndian.AppendUint32([]byte(FrameMagic), MaxFrameBytes+1)
	r := &countingReader{r: io.MultiReader(bytes.NewReader(hdr), bytes.NewReader(make([]byte, 64))), limit: 8, t: t}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	_, err := ReadFrame(r, math.MaxUint32)
	runtime.ReadMemStats(&after)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("length MaxFrameBytes+1: %v, want ErrTooLarge", err)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 1<<20 {
		t.Fatalf("allocated %d bytes for a refused frame", alloc)
	}
}
