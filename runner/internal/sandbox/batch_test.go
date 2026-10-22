package sandbox

import (
	"testing"

	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

func TestValidateFrame(t *testing.T) {
	const nonce = "00112233445566778899aabbccddeeff"
	cases := []struct {
		name    string
		f       protocol.Frame
		wantSeq int
		ok      bool
	}{
		{"ready", protocol.Frame{Nonce: nonce, Seq: 0}, 0, true},
		{"next test", protocol.Frame{Nonce: nonce, Seq: 3}, 3, true},
		{"wrong nonce", protocol.Frame{Nonce: "ffff", Seq: 3}, 3, false},
		{"missing nonce", protocol.Frame{Seq: 3}, 3, false},
		{"replayed seq", protocol.Frame{Nonce: nonce, Seq: 2}, 3, false},
		{"skipped seq", protocol.Frame{Nonce: nonce, Seq: 4}, 3, false},
		{"ready when result expected", protocol.Frame{Nonce: nonce, Seq: 0}, 1, false},
	}
	for _, c := range cases {
		err := validateFrame(c.f, nonce, c.wantSeq)
		if (err == nil) != c.ok {
			t.Errorf("%s: validateFrame = %v, want ok=%v", c.name, err, c.ok)
		}
	}
}

// The host's frame limit for the largest output limit stays within the
// protocol's hard cap, so ReadFrame never refuses a legitimate frame.
func TestMaxFrameBytesCoversLargestOutput(t *testing.T) {
	if got := frameBytes(MaxOutputBytes); got > protocol.MaxFrameBytes {
		t.Fatalf("frameBytes(MaxOutputBytes) = %d > protocol.MaxFrameBytes %d", got, protocol.MaxFrameBytes)
	}
}
