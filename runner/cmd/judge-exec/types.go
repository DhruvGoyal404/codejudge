package main

// Declarations shared by the Linux implementation and the portable batch
// loop (batch.go), kept OS-independent so the loop's unit tests run on any OS.

import (
	"regexp"
	"strings"

	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

type options struct {
	mode        string
	maxTarBytes int64
	maxFiles    int
	cpuMs       int64 // RLIMIT_CPU is set to ceil(cpuMs/1000)+1 seconds; 0 = unlimited
	wallMs      int64
	fsize       int64 // RLIMIT_FSIZE bytes; 0 = unlimited
	stack       int64 // RLIMIT_STACK bytes; 0 = inherit
	nproc       int64 // RLIMIT_NPROC for the program (tasks of its uid); 0 = inherit
	memKB       int64 // kill when peak RSS (VmHWM) exceeds this; 0 = off
	stdoutCap   int64
	stderrCap   int64
	stdinFile   string
	batch       bool  // --batch: run the batch protocol (docs/PROTOCOL.md) instead of a single run
	maxInput    int64 // --max-input-bytes: largest accepted test input in batch mode
	artifacts   []string
	env         []string // --env KEY=VALUE: added to the program's fixed environment
	cmd         []string
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

// RunConfig is the per-run configuration (the parsed command-line options).
type RunConfig = options

// Result is one judge-exec result frame.
type Result = protocol.Frame

// envVarRE: an --env entry, KEY=VALUE on one line. The host builds these
// from lang.go; they are never user input.
var envVarRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]*=.*$`)

// programEnv is the environment of the judged program: base (childEnv) plus
// the language's --env entries, which override a base key of the same name.
func programEnv(base, extra []string) []string {
	env := make([]string, 0, len(base)+len(extra))
	override := map[string]bool{}
	for _, kv := range extra {
		override[strings.SplitN(kv, "=", 2)[0]] = true
	}
	for _, kv := range base {
		if !override[strings.SplitN(kv, "=", 2)[0]] {
			env = append(env, kv)
		}
	}
	return append(env, extra...)
}
