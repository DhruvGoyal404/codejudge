//go:build linux

package main

import (
	"bytes"
	"os"
	"path/filepath"

	"github.com/DhruvGoyal404/codejudge/runner/internal/boxtar"
	"github.com/DhruvGoyal404/codejudge/runner/internal/protocol"
)

// realBatchDeps wires runBatch to the real container environment.
func realBatchDeps(o options) batchDeps {
	return batchDeps{
		in:           os.Stdin,
		out:          os.Stdout,
		runOne:       runOne,
		reapAll:      reapAll,
		resetWorkDir: resetWorkDir,
		cleanIPC:     cleanSysVIPC,
		extract: func(tarBytes []byte) error {
			return boxtar.Extract(bytes.NewReader(tarBytes), boxDir, boxtar.Limits{MaxBytes: o.maxTarBytes, MaxFiles: o.maxFiles})
		},
		writeInput: func(path string, data []byte) error {
			return os.WriteFile(path, data, 0o400)
		},
		workDir:    boxDir,
		scratch:    append([]string{"/tmp"}, optionalScratch()...),
		inputPath:  filepath.Join(boxDir, "input"),
		maxProgram: uint32(protocol.NonceSize + o.maxTarBytes),
		maxInput:   uint32(o.maxInput),
	}
}
