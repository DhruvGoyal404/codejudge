package sandbox

import (
	"bufio"
	"os"
	"strings"
	"testing"
	"time"
)

// The worker's systemd unit must give an in-flight submission time to finish
// on a graceful stop (SIGTERM → finish in-flight → exit). The longest
// submission is a compile container followed by a full batch container.
func TestSystemdStopTimeoutCoversLongestSubmission(t *testing.T) {
	path, err := FindRepoFile("deploy/systemd/judge-worker.service")
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var stop time.Duration
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "TimeoutStopSec="); ok {
			// systemd spells minutes "min"; Go wants "m".
			stop, err = time.ParseDuration(strings.ReplaceAll(v, "min", "m"))
			if err != nil {
				t.Fatalf("TimeoutStopSec=%s: %v", v, err)
			}
		}
	}
	if stop == 0 {
		t.Fatal("TimeoutStopSec not set in judge-worker.service")
	}
	compile := compileWallMs*time.Millisecond + hostGrace + removeTimeout
	// The worker judges with the default output cap.
	batch := batchDeadline(MaxTests, MaxEffectiveTimeLimit, maxBatchInputBytes, DefaultOutputBytes) + removeTimeout
	longest := compile + batch
	t.Logf("TimeoutStopSec=%v, longest submission (compile %v + batch %v) = %v", stop, compile, batch, longest)
	if stop <= longest {
		t.Fatalf("TimeoutStopSec %v must exceed the longest submission %v", stop, longest)
	}
}
