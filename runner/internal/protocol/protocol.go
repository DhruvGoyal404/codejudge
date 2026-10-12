// Package protocol defines the wire format between the host runner and
// judge-exec (PID 1 inside every sandbox container).
//
// Host -> container: a tar stream on stdin, extracted into /box.
//
// Container -> host:
//   - run mode: exactly one JSON Frame on stdout, written after every process
//     in the container has been killed and reaped.
//   - compile mode: a tar stream on stdout whose first entry is ResultEntry
//     (a JSON Frame), followed by the compiled artifacts on success.
//   - batch mode: length-prefixed messages in, length-prefixed frames out;
//     see framing.go and docs/PROTOCOL.md.
package protocol

// ResultEntry is the name of the Frame entry in a compile-mode output tar.
const ResultEntry = "result.json"

// Termination reasons reported in Frame.Status.
const (
	StatusExited     = "exited"      // program exited on its own
	StatusSignaled   = "signaled"    // program killed by a signal it did not get from judge-exec
	StatusWallKilled = "wall_killed" // judge-exec killed it at the wall-clock limit
	StatusMemKilled  = "mem_killed"  // judge-exec killed it when peak RSS exceeded the memory limit
	StatusError      = "error"       // judge-exec itself failed; see Frame.Error
	StatusReady      = "ready"       // batch: program files received, ready for the first test
)

// Frame is the single result record produced by judge-exec.
// []byte fields are base64-encoded by encoding/json, which keeps arbitrary
// (non-UTF-8) program output intact.
type Frame struct {
	Mode            string   `json:"mode"`
	Seq             int      `json:"seq,omitempty"`   // batch: test number (1-based); 0 = ready frame
	Nonce           string   `json:"nonce,omitempty"` // batch: hex of the MsgProgram nonce, echoed in every frame
	Status          string   `json:"status"`
	ExitCode        int      `json:"exit_code"`
	Signal          int      `json:"signal"`
	CPUMs           int64    `json:"cpu_ms"`
	WallMs          int64    `json:"wall_ms"`
	MaxRSSKB        int64    `json:"max_rss_kb"`
	Stdout          []byte   `json:"stdout"`
	Stderr          []byte   `json:"stderr"`
	StdoutBytes     int64    `json:"stdout_bytes"` // full size the program wrote (before capping)
	StdoutTruncated bool     `json:"stdout_truncated"`
	StderrTruncated bool     `json:"stderr_truncated"`
	OutputLimitHit  bool     `json:"output_limit_hit"` // stdout file reached RLIMIT_FSIZE
	Artifacts       []string `json:"artifacts,omitempty"`
	Error           string   `json:"error,omitempty"`
}
