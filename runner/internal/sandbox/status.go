package sandbox

import "github.com/DhruvGoyal404/codejudge/runner/internal/protocol"

// Verdict statuses. AC/WA (output comparison) arrive in Phase 2.
const (
	StatusOK  = "OK"  // ran to completion within all limits, exit code 0
	StatusCE  = "CE"  // compilation error
	StatusRE  = "RE"  // runtime error: nonzero exit or killed by a signal
	StatusTLE = "TLE" // CPU time over the limit, or killed at the wall-clock limit
	StatusMLE = "MLE" // memory limit exceeded
	StatusOLE = "OLE" // output limit exceeded
	StatusIE  = "IE"  // internal error in the judge
)

// Linux signal numbers (fixed on amd64/arm64). Defined here so this file
// also compiles on the Windows dev host.
const (
	sigXCPU = 24
	sigXFSZ = 25
)

// runEvidence is everything the classifier looks at.
type runEvidence struct {
	frame        *protocol.Frame // nil if judge-exec produced no parseable frame
	oomKilled    bool            // docker inspect State.OOMKilled
	hostDeadline bool            // host-side outer deadline fired
	hostErr      error           // docker / transport / parse failure
	limits       Limits
}

// classify applies the precedence IE > MLE > TLE > OLE > RE > OK.
//
// Deviation (documented in docs/PHASE1.md): when judge-exec produced no frame
// but the container was OOM-killed, the result is MLE rather than IE. With the
// configured headroom the kernel OOM killer targets the program, but if the
// cgroup limit is hit hard enough to take judge-exec down too, the cause is the
// submission's memory use, not a judge fault.
func classify(ev runEvidence) (status, reason string) {
	f := ev.frame
	if f == nil {
		switch {
		case ev.oomKilled:
			return StatusMLE, "container OOM-killed before judge-exec reported"
		case ev.hostDeadline:
			return StatusIE, "host deadline exceeded without a result from judge-exec"
		case ev.hostErr != nil:
			return StatusIE, ev.hostErr.Error()
		default:
			return StatusIE, "no result frame from judge-exec"
		}
	}
	if ev.hostErr != nil {
		return StatusIE, ev.hostErr.Error()
	}
	if f.Status == protocol.StatusError {
		return StatusIE, "judge-exec: " + f.Error
	}
	limKB := ev.limits.MemoryMB * 1024
	if ev.oomKilled || f.Status == protocol.StatusMemKilled || (limKB > 0 && f.MaxRSSKB > limKB) {
		return StatusMLE, ""
	}
	if f.Status == protocol.StatusWallKilled || f.CPUMs > ev.limits.TimeLimit.Milliseconds() || f.Signal == sigXCPU {
		return StatusTLE, ""
	}
	if f.Signal == sigXFSZ || f.OutputLimitHit || f.StdoutTruncated {
		return StatusOLE, ""
	}
	if f.Signal != 0 || f.ExitCode != 0 || f.Status == protocol.StatusSignaled {
		return StatusRE, ""
	}
	return StatusOK, ""
}
