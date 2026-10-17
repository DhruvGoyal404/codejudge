package main

import (
	"slices"
	"testing"
)

func TestProgramEnv(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HOME=/tmp"}
	got := programEnv(base, []string{"GOMAXPROCS=1", "HOME=/box"})
	want := []string{"PATH=/usr/bin", "GOMAXPROCS=1", "HOME=/box"}
	if !slices.Equal(got, want) {
		t.Fatalf("programEnv = %q, want %q", got, want)
	}
	if got := programEnv(base, nil); !slices.Equal(got, base) {
		t.Fatalf("no extras: %q", got)
	}
}

func TestEnvVarRE(t *testing.T) {
	for _, ok := range []string{"GOMAXPROCS=1", "GOMEMLIMIT=256MiB", "GOFLAGS=-trimpath", "A=", "X_1=a=b"} {
		if !envVarRE.MatchString(ok) {
			t.Errorf("%q rejected", ok)
		}
	}
	for _, bad := range []string{"", "=1", "gomaxprocs=1", "GO MAXPROCS=1", "A", "A=1\nB=2", "1A=x"} {
		if envVarRE.MatchString(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}
