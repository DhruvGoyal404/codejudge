package sandbox

import (
	"os/exec"
	"runtime"
	"strconv"
	"testing"
)

func TestReaperThresholdExceedsLifetime(t *testing.T) {
	life := MaxContainerLifetime()
	t.Logf("MaxContainerLifetime = %v (compile %v, run %v, batch %v); ReaperThreshold = %v",
		life,
		compileWallMs*1e6+hostGrace+removeTimeout,
		WallLimit(MaxEffectiveTimeLimit)+hostGrace+removeTimeout,
		batchDeadline(MaxTests, MaxEffectiveTimeLimit)+removeTimeout,
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
