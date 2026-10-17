// Package lang defines how each supported language is compiled and run.
package lang

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Lang describes one language. Image fields are keys into
// sandbox/images/images.lock.json, which maps them to pinned image IDs.
//
// Commands may contain placeholders, filled by Expand for each run:
//
//	{memMB}    the problem's memory limit in MB (heap size flags)
//	{stackKB}  a thread stack size safely below RLIMIT_STACK (= memory limit)
type Lang struct {
	Name         string
	CompileImage string
	RunImage     string
	Source       string   // file name the submission is stored as in /box
	CompileCmd   []string // run in /box by judge-exec in compile mode
	Artifacts    []string // files the compile step produces for the run step; empty = run the source itself
	RunCmd       []string // run in /box by judge-exec in run mode

	// MemOverheadMB is memory the runtime itself needs beyond the program's
	// heap (JVM metaspace, code cache, thread stacks; V8 isolate). It is added
	// to the container limit and to the RSS ceiling, so the problem's memory
	// limit applies to the program's data (the heap flag is {memMB}).
	MemOverheadMB int64
	// ExtraTasks raises the process/thread limits (RLIMIT_NPROC and the pids
	// cgroup alike) for runtimes that start many threads of their own.
	ExtraTasks int
	// OOMMarkers: stderr substrings meaning the runtime ran out of memory; a
	// run that failed with one of them is MLE, not RE.
	OOMMarkers []string

	// CompileEnv / RunEnv are KEY=VALUE pairs added to the program's fixed
	// environment (judge-exec --env); RunEnv may use the placeholders above.
	CompileEnv []string
	RunEnv     []string
	// CompileCPUMs / CompileWallMs raise the compile step's limits for slow
	// toolchains; 0 = the sandbox defaults. The sandbox caps them.
	CompileCPUMs  int
	CompileWallMs int
}

// goEnv is the Go toolchain's environment, identical at image build time
// (sandbox/images/go-compile.Dockerfile warms the standard library cache with
// it) and compile time: any difference changes the cache keys and every
// submission would recompile the standard library (~25 s).
var goEnv = []string{
	"CGO_ENABLED=0", "GOOS=linux", "GOARCH=amd64", "GOAMD64=v1", "GOTOOLCHAIN=local", "GOFLAGS=-trimpath",
	"GOPROXY=off", "GOSUMDB=off", "GOENV=off", "GOTELEMETRY=off", "GOWORK=off",
	// The image's warm cache, read-only in the sandbox: entries for main.go
	// itself fail to be written, harmlessly. Module downloads are impossible
	// (offline, GOPROXY=off): standard library only.
	"GOCACHE=/opt/gocache", "GOPATH=/tmp/gopath", "GOMODCACHE=/tmp/gopath/pkg/mod", "GOMAXPROCS=1",
}

var langs = map[string]Lang{
	"cpp": {
		Name:         "cpp",
		CompileImage: "cpp-compile",
		RunImage:     "cpp-run", // FROM scratch: no compiler, no shell, no libc
		Source:       "main.cpp",
		CompileCmd:   []string{"g++", "-std=gnu++17", "-O2", "-pipe", "-static", "-o", "main", "main.cpp"},
		Artifacts:    []string{"main"},
		RunCmd:       []string{"/box/main"},
	},
	"c": {
		Name:         "c",
		CompileImage: "cpp-compile", // gcc 14.2.0 compiles C too
		RunImage:     "cpp-run",     // FROM scratch, as for C++
		Source:       "main.c",
		CompileCmd:   []string{"gcc", "-std=c17", "-O2", "-pipe", "-static", "-o", "main", "main.c", "-lm"},
		Artifacts:    []string{"main"},
		RunCmd:       []string{"/box/main"},
	},
	"go": {
		Name:         "go",
		CompileImage: "go-compile", // Go 1.27.2, standard library pre-compiled
		RunImage:     "cpp-run",    // a static Go binary needs nothing: FROM scratch
		Source:       "main.go",
		// No go.mod: main.go builds as "command-line-arguments" in module mode,
		// so any import outside the standard library fails (offline): CE.
		CompileCmd:    []string{"/usr/local/go/bin/go", "build", "-p", "1", "-o", "main", "main.go"},
		CompileEnv:    goEnv,
		CompileCPUMs:  30_000, // cold packages (rare imports) compile on the spot
		CompileWallMs: 60_000,
		Artifacts:     []string{"main"},
		RunCmd:        []string{"/box/main"},
		// One CPU; the soft heap limit is the problem's memory limit, so the GC
		// works to stay inside it before the hard limit (RSS) is reached.
		RunEnv: []string{"GOMAXPROCS=1", "GOMEMLIMIT={memMB}MiB", "GOTRACEBACK=single"},
		// The runtime's own memory beyond the heap: goroutine stacks are
		// heap-allocated, but binary text, mspans and GC metadata are not.
		MemOverheadMB: 32,
		// sysmon, GC workers, and an extra thread per goroutine blocked in a syscall.
		ExtraTasks: 16,
		OOMMarkers: []string{"runtime: out of memory", "fatal error: out of memory"},
	},
	"python": {
		Name:         "python",
		CompileImage: "python",
		RunImage:     "python",
		Source:       "main.py",
		CompileCmd:   []string{"python3", "-m", "py_compile", "main.py"},
		RunCmd:       []string{"python3", "main.py"},
		OOMMarkers:   []string{"MemoryError"},
	},
	"java": {
		Name:         "java",
		CompileImage: "java-compile", // Temurin 21 JDK
		RunImage:     "java-run",     // Temurin 21 JRE only: no javac at run time
		Source:       "Main.java",
		// javac, then require class Main (the entry point), then one jar as the
		// single artifact (nested and helper classes included).
		CompileCmd: []string{"sh", "-c", "/opt/java/openjdk/bin/javac -J-Xmx512m -J-XX:+UseSerialGC -J-XX:-UsePerfData -encoding UTF-8 -d out Main.java" +
			" && { [ -f out/Main.class ] || { echo 'error: no class named Main: the program must declare class Main with public static void main(String[] args)' >&2; exit 1; }; }" +
			" && /opt/java/openjdk/bin/jar --create --file main.jar -C out ."},
		Artifacts: []string{"main.jar"},
		RunCmd: []string{"/opt/java/openjdk/bin/java",
			"-Xmx{memMB}m", "-Xss{stackKB}k", // heap = the problem's limit; deep recursion
			"-XX:+UseSerialGC", "-XX:ActiveProcessorCount=1", "-XX:CICompilerCount=2",
			"-XX:-UsePerfData", "-XX:+ExitOnOutOfMemoryError", "-Xshare:auto",
			"-cp", "/box/main.jar", "Main"},
		MemOverheadMB: 128,
		ExtraTasks:    24,
		OOMMarkers:    []string{"java.lang.OutOfMemoryError"},
	},
	"javascript": {
		Name:         "javascript",
		CompileImage: "node", // Node.js 22 LTS
		RunImage:     "node",
		Source:       "main.js",
		CompileCmd:   []string{"node", "--check", "main.js"},
		RunCmd: []string{"node",
			"--max-old-space-size={memMB}", "--stack-size={stackKB}", "--v8-pool-size=1",
			"/box/main.js"},
		MemOverheadMB: 64,
		ExtraTasks:    16,
		OOMMarkers:    []string{"JavaScript heap out of memory"},
	},
}

// Expand fills the {memMB} and {stackKB} placeholders of cmd for a memory
// limit of memMB megabytes. {stackKB} is three quarters of RLIMIT_STACK (set
// to the memory limit), at most 64 MB, so a runtime's own stack-size flag can
// never exceed the real stack.
func Expand(cmd []string, memMB int64) []string {
	stackKB := memMB * 1024 * 3 / 4
	if stackKB > 64*1024 {
		stackKB = 64 * 1024
	}
	r := strings.NewReplacer("{memMB}", strconv.FormatInt(memMB, 10), "{stackKB}", strconv.FormatInt(stackKB, 10))
	out := make([]string, len(cmd))
	for i, a := range cmd {
		out[i] = r.Replace(a)
	}
	return out
}

// Get returns the language with the given name.
func Get(name string) (Lang, error) {
	l, ok := langs[name]
	if !ok {
		return Lang{}, fmt.Errorf("unsupported language %q (supported: %v)", name, Names())
	}
	return l, nil
}

// Names lists supported languages.
func Names() []string {
	out := make([]string, 0, len(langs))
	for n := range langs {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
