package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

// fakeEnv records every call the loop makes, in order.
type fakeEnv struct {
	log        []string
	inputs     map[string][]byte // path -> data written by writeInput
	extractErr error
	resetErr   error
	resetFails int // fail resetWorkDir on this call number (1-based); 0 = never
	resets     int
	runResult  func(input []byte) Result
}

func (f *fakeEnv) deps(in io.Reader, out io.Writer) batchDeps {
	return batchDeps{
		in:  in,
		out: out,
		runOne: func(cfg RunConfig, inputPath string) Result {
			data := f.inputs[inputPath]
			f.log = append(f.log, fmt.Sprintf("run(%s)", data))
			if f.runResult != nil {
				return f.runResult(data)
			}
			return Result{Status: protocol.StatusExited, Stdout: append([]byte("out:"), data...)}
		},
		reapAll: func() { f.log = append(f.log, "reap") },
		resetWorkDir: func(dir string) error {
			f.resets++
			f.log = append(f.log, "reset("+dir+")")
			if f.resetFails == f.resets {
				return f.resetErr
			}
			return nil
		},
		extract: func(b []byte) error {
			f.log = append(f.log, "extract("+string(b)+")")
			return f.extractErr
		},
		writeInput: func(path string, data []byte) error {
			f.log = append(f.log, "input("+string(data)+")")
			if f.inputs == nil {
				f.inputs = map[string][]byte{}
			}
			f.inputs[path] = append([]byte(nil), data...)
			return nil
		},
		workDir:    "/box",
		scratch:    []string{"/tmp"},
		inputPath:  "/box/input",
		maxProgram: 1 << 10,
		maxInput:   64,
	}
}

var nonce = bytes.Repeat([]byte{0xab}, protocol.NonceSize)

func msgs(t *testing.T, ms ...[2]string) *bytes.Buffer {
	t.Helper()
	var b bytes.Buffer
	for _, m := range ms {
		payload := []byte(m[1])
		if m[0] == "P" {
			payload = append(append([]byte{}, nonce...), payload...)
		}
		if err := protocol.WriteMsg(&b, m[0][0], payload); err != nil {
			t.Fatal(err)
		}
	}
	return &b
}

func frames(t *testing.T, out *bytes.Buffer) []Result {
	t.Helper()
	var fs []Result
	for {
		f, err := protocol.ReadFrame(out, 1<<20)
		if err == io.EOF {
			return fs
		}
		if err != nil {
			t.Fatalf("reading frames: %v", err)
		}
		fs = append(fs, f)
	}
}

func TestBatchHappyPath(t *testing.T) {
	env := &fakeEnv{}
	var out bytes.Buffer
	code := runBatch(RunConfig{mode: "run"}, env.deps(msgs(t, [2]string{"P", "prog"}, [2]string{"T", "1 2"}, [2]string{"T", ""}, [2]string{"T", "3"}, [2]string{"E", ""}), &out))
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	fs := frames(t, &out)
	if len(fs) != 4 {
		t.Fatalf("got %d frames, want ready + 3 results", len(fs))
	}
	wantNonce := hex.EncodeToString(nonce)
	for i, f := range fs {
		if f.Seq != i || f.Nonce != wantNonce || f.Mode != "batch" {
			t.Fatalf("frame %d: seq=%d nonce=%q mode=%q", i, f.Seq, f.Nonce, f.Mode)
		}
	}
	if fs[0].Status != protocol.StatusReady {
		t.Fatalf("first frame status %q, want ready", fs[0].Status)
	}
	if string(fs[1].Stdout) != "out:1 2" || string(fs[2].Stdout) != "out:" || string(fs[3].Stdout) != "out:3" {
		t.Fatalf("results out of order / mixed: %q %q %q", fs[1].Stdout, fs[2].Stdout, fs[3].Stdout)
	}

	// Exact per-test ordering: fresh program, input, run, reap, reset all dirs.
	want := strings.Join([]string{
		"extract(prog)", "reset(/box)", "reset(/tmp)", // P: verify, then clean
		"extract(prog)", "input(1 2)", "run(1 2)", "reap", "reset(/box)", "reset(/tmp)",
		"extract(prog)", "input()", "run()", "reap", "reset(/box)", "reset(/tmp)",
		"extract(prog)", "input(3)", "run(3)", "reap", "reset(/box)", "reset(/tmp)",
	}, " ")
	if got := strings.Join(env.log, " "); got != want {
		t.Fatalf("call order:\n got  %s\n want %s", got, want)
	}
}

func TestBatchCleanEOFIsEnd(t *testing.T) {
	env := &fakeEnv{}
	var out bytes.Buffer
	if code := runBatch(RunConfig{}, env.deps(msgs(t, [2]string{"P", "prog"}, [2]string{"T", "x"}), &out)); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if n := len(frames(t, &out)); n != 2 {
		t.Fatalf("%d frames", n)
	}
}

func TestBatchErrors(t *testing.T) {
	oversized := msgs(t, [2]string{"P", "prog"})
	_ = protocol.WriteMsg(oversized, protocol.MsgTest, make([]byte, 65)) // maxInput is 64

	truncated := msgs(t, [2]string{"P", "prog"}, [2]string{"T", "hello"})
	truncated.Truncate(truncated.Len() - 2)

	cases := map[string]struct {
		in        *bytes.Buffer
		env       *fakeEnv
		wantSeq   int
		wantError string
		noReady   bool
	}{
		"test before program":   {in: msgs(t, [2]string{"T", "x"}), env: &fakeEnv{}, wantError: "want program", noReady: true},
		"empty stream":          {in: &bytes.Buffer{}, env: &fakeEnv{}, wantError: "read program", noReady: true},
		"bad program tar":       {in: msgs(t, [2]string{"P", "prog"}), env: &fakeEnv{extractErr: errors.New("absolute path")}, wantError: "absolute path", noReady: true},
		"second program":        {in: msgs(t, [2]string{"P", "prog"}, [2]string{"P", "again"}), env: &fakeEnv{}, wantError: "unexpected message"},
		"oversized input":       {in: oversized, env: &fakeEnv{}, wantSeq: 0, wantError: "exceeds size limit"},
		"truncated input":       {in: truncated, env: &fakeEnv{}, wantSeq: 0, wantError: "truncated"},
		"reset fails after run": {in: msgs(t, [2]string{"P", "prog"}, [2]string{"T", "x"}, [2]string{"T", "y"}), env: &fakeEnv{resetErr: errors.New("busy"), resetFails: 3}, wantSeq: 1, wantError: "busy"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			if code := runBatch(RunConfig{}, c.env.deps(c.in, &out)); code == 0 {
				t.Fatal("exit 0 on protocol error")
			}
			fs := frames(t, &out)
			if len(fs) == 0 {
				t.Fatal("no error frame")
			}
			last := fs[len(fs)-1]
			if last.Status != protocol.StatusError || !strings.Contains(last.Error, c.wantError) {
				t.Fatalf("last frame %+v, want error containing %q", last, c.wantError)
			}
			if last.Seq != c.wantSeq {
				t.Fatalf("error frame seq=%d, want %d", last.Seq, c.wantSeq)
			}
			if c.noReady {
				for _, f := range fs {
					if f.Status == protocol.StatusReady {
						t.Fatal("ready emitted despite bad program")
					}
				}
			}
			// A failed reset must stop before the next test's input is written.
			if name == "reset fails after run" && strings.Contains(strings.Join(c.env.log, " "), "input(y)") {
				t.Fatal("next test started after a failed reset")
			}
		})
	}
}
