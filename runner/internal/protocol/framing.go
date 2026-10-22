package protocol

// Batch-mode framing. See docs/PROTOCOL.md for the full specification.
//
// Host -> judge-exec (container stdin), a sequence of messages:
//
//	+------+----------------+-----------------+
//	| type | length (u32 BE)| payload (length)|
//	+------+----------------+-----------------+
//	  1 B        4 B
//
//	MsgProgram 'P' : payload = NonceSize-byte nonce || tar of program files. First message, exactly once.
//	MsgTest    'T' : payload = the test's raw stdin bytes (may be empty).
//	MsgEnd     'E' : payload empty. judge-exec exits 0.
//
// judge-exec -> host (container stdout), a sequence of frames:
//
//	+--------+----------------+----------------------+
//	| "JFR1" | length (u32 BE)| JSON Frame (length)  |
//	+--------+----------------+----------------------+

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Message types (host -> judge-exec).
const (
	MsgProgram byte = 'P'
	MsgTest    byte = 'T'
	MsgEnd     byte = 'E'
)

// FrameMagic prefixes every result frame (judge-exec -> host).
const FrameMagic = "JFR1"

// NonceSize is the length of the per-batch nonce at the start of MsgProgram.
const NonceSize = 16

// MaxFrameBytes bounds a result frame's JSON body, on both sides. The largest
// real frame carries the largest accepted stdout (sandbox.MaxOutputBytes,
// 16 MiB) plus capped stderr (64 KiB), base64-encoded by encoding/json (x4/3),
// and a few hundred bytes of metadata: about 22.5 MB, which is what the host
// allows for it (sandbox frameBytes). 32 MiB is comfortably above that, and far
// below the u32 length prefix's range, so 8+len and the uint32 conversion can
// never overflow.
const MaxFrameBytes = 32 << 20

// Framing errors.
var (
	ErrTruncated  = errors.New("truncated message")
	ErrTooLarge   = errors.New("message exceeds size limit")
	ErrBadType    = errors.New("unknown message type")
	ErrBadMagic   = errors.New("bad frame magic")
	ErrBadPayload = errors.New("malformed payload")
)

// WriteMsg writes one host -> judge-exec message.
func WriteMsg(w io.Writer, typ byte, payload []byte) error {
	if !validType(typ) {
		return ErrBadType
	}
	if typ == MsgEnd && len(payload) != 0 {
		return fmt.Errorf("%w: end message carries no payload", ErrBadPayload)
	}
	if uint64(len(payload)) > 0xFFFFFFFF {
		return ErrTooLarge
	}
	var hdr [5]byte
	hdr[0] = typ
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		_, err := w.Write(payload)
		return err
	}
	return nil
}

// ReadMsg reads one message, refusing payloads larger than maxPayload before
// allocating anything. It returns io.EOF only if the stream ended cleanly
// before the first header byte; an EOF inside a message is ErrTruncated.
func ReadMsg(r io.Reader, maxPayload uint32) (typ byte, payload []byte, err error) {
	var hdr [5]byte
	n, err := io.ReadFull(r, hdr[:])
	if err != nil {
		if n == 0 && err == io.EOF {
			return 0, nil, io.EOF
		}
		if errors.Is(err, io.ErrUnexpectedEOF) || err == io.EOF {
			return 0, nil, ErrTruncated
		}
		return 0, nil, err
	}
	typ = hdr[0]
	if !validType(typ) {
		return 0, nil, fmt.Errorf("%w: 0x%02x", ErrBadType, typ)
	}
	size := binary.BigEndian.Uint32(hdr[1:])
	if size > maxPayload {
		return 0, nil, fmt.Errorf("%w: %d > %d bytes", ErrTooLarge, size, maxPayload)
	}
	if typ == MsgEnd && size != 0 {
		return 0, nil, fmt.Errorf("%w: end message with %d-byte payload", ErrBadPayload, size)
	}
	if typ == MsgProgram && size < NonceSize {
		return 0, nil, fmt.Errorf("%w: program message shorter than nonce", ErrBadPayload)
	}
	payload = make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || err == io.EOF {
			return 0, nil, ErrTruncated
		}
		return 0, nil, err
	}
	return typ, payload, nil
}

func validType(t byte) bool { return t == MsgProgram || t == MsgTest || t == MsgEnd }

// WriteFrame writes one judge-exec -> host result frame.
func WriteFrame(w io.Writer, f Frame) error {
	body, err := json.Marshal(f)
	if err != nil {
		return err
	}
	if len(body) > MaxFrameBytes {
		return fmt.Errorf("%w: frame body %d > %d bytes", ErrTooLarge, len(body), MaxFrameBytes)
	}
	buf := make([]byte, 0, 8+len(body))
	buf = append(buf, FrameMagic...)
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(body)))
	buf = append(buf, body...)
	_, err = w.Write(buf) // single write: a frame is never interleaved with another
	return err
}

// ReadFrame reads one result frame of at most min(maxLen, MaxFrameBytes) JSON
// bytes, refusing a larger length prefix before allocating anything.
func ReadFrame(r io.Reader, maxLen uint32) (Frame, error) {
	var f Frame
	var hdr [8]byte
	n, err := io.ReadFull(r, hdr[:])
	if err != nil {
		if n == 0 && err == io.EOF {
			return f, io.EOF
		}
		if errors.Is(err, io.ErrUnexpectedEOF) || err == io.EOF {
			return f, ErrTruncated
		}
		return f, err
	}
	if string(hdr[:4]) != FrameMagic {
		return f, ErrBadMagic
	}
	size := binary.BigEndian.Uint32(hdr[4:])
	if size > maxLen || size > MaxFrameBytes {
		return f, fmt.Errorf("%w: %d > %d bytes", ErrTooLarge, size, min(maxLen, MaxFrameBytes))
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(r, body); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || err == io.EOF {
			return f, ErrTruncated
		}
		return f, err
	}
	if err := json.Unmarshal(body, &f); err != nil {
		return f, fmt.Errorf("%w: %v", ErrBadPayload, err)
	}
	return f, nil
}
