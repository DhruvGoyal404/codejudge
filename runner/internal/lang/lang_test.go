package lang

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The Go image warms the standard library cache with the Dockerfile's ENV;
// submissions are built with goEnv. Any key that affects the build must have
// the same value in both, or every compile rebuilds the standard library.
func TestGoEnvMatchesImage(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "sandbox", "images", "go-compile.Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	// The ENV instruction of the final stage (it spans continuation lines).
	text := strings.ReplaceAll(string(df), "\\\n", " ")
	envs := regexp.MustCompile(`(?m)^ENV (.*)$`).FindAllStringSubmatch(text, -1)
	if len(envs) == 0 {
		t.Fatal("no ENV in go-compile.Dockerfile")
	}
	image := map[string]string{}
	for _, kv := range strings.Fields(envs[len(envs)-1][1]) {
		k, v, _ := strings.Cut(kv, "=")
		image[k] = v
	}
	sub := map[string]string{}
	for _, kv := range goEnv {
		k, v, _ := strings.Cut(kv, "=")
		sub[k] = v
	}
	for k, v := range image {
		if sub[k] != v {
			t.Errorf("image ENV %s=%s, goEnv has %q", k, v, sub[k])
		}
	}
	if !strings.Contains(string(df), "GOCACHE="+sub["GOCACHE"]+" ") {
		t.Errorf("the image does not warm GOCACHE=%s", sub["GOCACHE"])
	}
}

func TestLanguages(t *testing.T) {
	if want := []string{"c", "cpp", "go", "java", "javascript", "python"}; !slices.Equal(Names(), want) {
		t.Fatalf("Names() = %v, want %v", Names(), want)
	}
	for _, n := range Names() {
		l, _ := Get(n)
		if l.CompileImage == "" || l.RunImage == "" || l.Source == "" || len(l.CompileCmd) == 0 || len(l.RunCmd) == 0 {
			t.Errorf("%s: incomplete definition", n)
		}
		for _, kv := range append(slices.Clone(l.CompileEnv), l.RunEnv...) {
			if !regexp.MustCompile(`^[A-Z][A-Z0-9_]*=`).MatchString(kv) {
				t.Errorf("%s: bad env entry %q", n, kv)
			}
		}
	}
	g, _ := Get("go")
	if got := Expand(g.RunEnv, 256); !slices.Contains(got, "GOMEMLIMIT=256MiB") || !slices.Contains(got, "GOMAXPROCS=1") {
		t.Errorf("go run env = %v", got)
	}
}
