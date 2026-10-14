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
