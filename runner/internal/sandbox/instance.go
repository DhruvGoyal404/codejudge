package sandbox

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"strconv"
	"time"
)

// Container labels identifying the runner process ("instance") that owns a
// container. The reaper uses them to decide whether an owner is still alive.
const (
	LabelInstance = "judge.instance"  // random id per runner process
	LabelHost     = "judge.host"      // hostname of the owning process
	LabelPID      = "judge.pid"       // pid of the owning process
	LabelPIDStart = "judge.pid_start" // owning process start time (opaque, OS-specific); guards against pid reuse
)

// Limits that bound every container's lifetime. Problems are validated
// against these (internal/problem), and Run/batch enforce them.
const (
	MaxEffectiveTimeLimit = 10 * time.Second // per test, after the language time multiplier
	MaxTests              = 50               // tests per problem
	perTestGrace          = 5 * time.Second  // host guard per batch test beyond the wall limit
	removeTimeout         = 30 * time.Second // deferred force-remove budget
)

// ReaperThreshold is the age after which a judge.managed container is removed
// even if its owner looks alive. It must be strictly greater than
// MaxContainerLifetime (asserted by TestReaperThresholdExceedsLifetime).
const ReaperThreshold = 30 * time.Minute

// MaxContainerLifetime is the longest any container created by this package
// can exist: its host-side deadline (after which it is killed) plus the
// removal budget.
//
//	compile : compileWall + hostGrace + removeTimeout
//	run     : WallLimit(MaxEffectiveTimeLimit) + hostGrace + removeTimeout
//	batch   : hostGrace + MaxTests*(WallLimit(MaxEffectiveTimeLimit)+perTestGrace) + removeTimeout
func MaxContainerLifetime() time.Duration {
	compile := compileWallMs*time.Millisecond + hostGrace + removeTimeout
	run := WallLimit(MaxEffectiveTimeLimit) + hostGrace + removeTimeout
	batch := batchDeadline(MaxTests, MaxEffectiveTimeLimit) + removeTimeout
	return max(compile, run, batch)
}

// batchDeadline is the hard host-side deadline for a batch container that
// will run n tests with effective time limit tl.
func batchDeadline(n int, tl time.Duration) time.Duration {
	return hostGrace + time.Duration(n)*(WallLimit(tl)+perTestGrace)
}

// instance identifies this runner process.
type instance struct {
	ID, Host, PID, Start string
}

var self = func() instance {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	host, _ := os.Hostname()
	pid := os.Getpid()
	start, _ := processStart(pid)
	return instance{ID: hex.EncodeToString(b), Host: host, PID: strconv.Itoa(pid), Start: start}
}()

func (in instance) labels() map[string]string {
	return map[string]string{LabelInstance: in.ID, LabelHost: in.Host, LabelPID: in.PID, LabelPIDStart: in.Start}
}

// ownerDead reports whether the instance that created a container is known to
// be gone. Containers without instance labels (pre-Phase-2) count as dead.
// An owner on another host cannot be checked, so it is never "known dead";
// such containers are only reaped by age.
func ownerDead(labels map[string]string) bool {
	if labels[LabelInstance] == "" || labels[LabelPID] == "" {
		return true
	}
	if labels[LabelHost] != self.Host {
		return false
	}
	pid, err := strconv.Atoi(labels[LabelPID])
	if err != nil || pid <= 0 {
		return true
	}
	start, alive := processStart(pid)
	return !alive || start != labels[LabelPIDStart]
}
