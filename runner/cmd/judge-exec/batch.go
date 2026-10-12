package main

// Batch mode: one container runs many tests. See docs/PROTOCOL.md.
//
//	P (nonce || program tar) -> extract into /box, reset, emit ready
//	T (input)                -> fresh program files + /box/input (0400),
//	                            runOne, reapAll, reset work dirs, emit result
//	E / clean EOF            -> exit 0
//	anything else            -> emit error frame, exit non-zero
//
// The loop only uses the functions in batchDeps so it can be unit-tested
// with fakes on any OS; batch_linux.go wires in the real implementations.

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

type batchDeps struct {
	in  io.Reader
	out io.Writer

	runOne       func(cfg RunConfig, inputPath string) Result
	reapAll      func()
	resetWorkDir func(dir string) error
	extract      func(programTar []byte) error        // verify + extract program files into the work dir
	writeInput   func(path string, data []byte) error // create path with mode 0400

	workDir    string   // /box: program files, input, outputs; program's cwd
	scratch    []string // other writable dirs reset after every test (/tmp)
	inputPath  string   // /box/input
	maxProgram uint32   // max P payload (nonce + tar)
	maxInput   uint32   // max T payload
}

// runBatch runs the batch protocol and returns the process exit code.
func runBatch(cfg RunConfig, d batchDeps) int {
	nonce := ""
	seq := 0
	fail := func(err error) int {
		_ = protocol.WriteFrame(d.out, Result{Mode: "batch", Seq: seq, Nonce: nonce, Status: protocol.StatusError, Error: err.Error()})
		return 2
	}
	reset := func() error {
		for _, dir := range append([]string{d.workDir}, d.scratch...) {
			if err := d.resetWorkDir(dir); err != nil {
				return fmt.Errorf("reset %s: %w", dir, err)
			}
		}
		return nil
	}

	// First message: the program.
	typ, payload, err := protocol.ReadMsg(d.in, d.maxProgram)
	if err != nil {
		return fail(fmt.Errorf("read program: %w", err))
	}
	if typ != protocol.MsgProgram {
		return fail(fmt.Errorf("first message is %q, want program", typ))
	}
	nonce = hex.EncodeToString(payload[:protocol.NonceSize])
	program := payload[protocol.NonceSize:]
	if err := d.extract(program); err != nil { // verify it extracts cleanly
		return fail(fmt.Errorf("program: %w", err))
	}
	if err := reset(); err != nil {
		return fail(err)
	}
	if err := protocol.WriteFrame(d.out, Result{Mode: "batch", Seq: 0, Nonce: nonce, Status: protocol.StatusReady}); err != nil {
		return 2
	}

	for {
		typ, payload, err := protocol.ReadMsg(d.in, d.maxInput)
		if errors.Is(err, io.EOF) {
			return 0 // clean EOF at a message boundary is treated like E
		}
		if err != nil {
			return fail(fmt.Errorf("read test %d: %w", seq+1, err))
		}
		switch typ {
		case protocol.MsgEnd:
			return 0
		case protocol.MsgTest:
		default:
			return fail(fmt.Errorf("unexpected message %q", typ))
		}
		seq++

		// Every test starts from a fresh copy of the program files.
		if err := d.extract(program); err != nil {
			return fail(fmt.Errorf("program: %w", err))
		}
		if err := d.writeInput(d.inputPath, payload); err != nil {
			return fail(fmt.Errorf("write input: %w", err))
		}
		r := d.runOne(cfg, d.inputPath)
		d.reapAll()
		if err := reset(); err != nil {
			return fail(err) // fail closed: never run the next test in a dirty box
		}
		r.Mode, r.Seq, r.Nonce = "batch", seq, nonce
		if err := protocol.WriteFrame(d.out, r); err != nil {
			return 2
		}
		if r.Status == protocol.StatusError {
			return 2
		}
	}
}
