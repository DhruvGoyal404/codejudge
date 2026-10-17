package sandbox

import (
	"os/exec"
	"runtime"
	"strconv"
	"testing"

	"github.com/DhruvGoyal404/codejudge/runner/internal/lang"
)

func TestReaperThresholdExceedsLifetime(t *testing.T) {
	life := MaxContainerLifetime()
	t.Logf("MaxContainerLifetime = %v (compile %v, run %v, batch %v); ReaperThreshold = %v",
		life,
		maxCompileWallMs*1e6+hostGrace+removeTimeout,
		WallLimit(MaxEffectiveTimeLimit)+hostGrace+removeTimeout,
		batchDeadline(MaxTests, MaxEffectiveTimeLimit, maxBatchInputBytes, MaxOutputBytes)+removeTimeout,
		ReaperThreshold)
	if ReaperThreshold <= life {
		t.Fatalf("ReaperThreshold %v must be > MaxContainerLifetime %v", ReaperThreshold, life)
	}
}

func TestOwnerDead(t *testing.T) {
	if self.Start == "" {
		t.Fatal("could not determine own process start time")
	}
	if ownerDead(self.labels()) {
		t.Fatal("own (live) instance reported dead")
	}

	other := self.labels()
	other[LabelInstance] = "someotherinstance" // different runner, same live process identity
	if ownerDead(other) {
		t.Fatal("live owner reported dead")
	}

	// A process that has exited.
	cmd := exec.Command("go", "version")
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", "exit", "0")
	}
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	dead := self.labels()
	dead[LabelPID] = strconv.Itoa(cmd.ProcessState.Pid())
	if !ownerDead(dead) {
		t.Fatal("exited process reported alive")
	}

	reused := self.labels()
	reused[LabelPIDStart] = "win:1" // same pid, different start time => pid was reused
	if !ownerDead(reused) {
		t.Fatal("pid with mismatched start time reported alive")
	}

	remote := dead
	remote[LabelHost] = "some-other-host"
	if ownerDead(remote) {
		t.Fatal("owner on another host must not be judged dead (age rule only)")
	}

	if !ownerDead(map[string]string{LabelManaged: "true"}) {
		t.Fatal("unlabelled (legacy) container should count as dead-owned")
	}
}

// compileLimits never exceeds the caps MaxContainerLifetime is computed from.
func TestCompileLimitsCapped(t *testing.T) {
	for _, n := range lang.Names() {
		l, _ := lang.Get(n)
		cpu, wall := compileLimits(l)
		if cpu > maxCompileCPUMs || wall > maxCompileWallMs || cpu > wall {
			t.Errorf("%s: compile cpu %d ms, wall %d ms (caps %d / %d)", n, cpu, wall, maxCompileCPUMs, maxCompileWallMs)
		}
	}
	if l, _ := lang.Get("go"); func() bool { c, _ := compileLimits(l); return c <= compileCPUMs }() {
		t.Error("go should get a raised compile limit")
	}
}
