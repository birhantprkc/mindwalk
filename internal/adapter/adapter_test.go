package adapter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/cosmtrek/mindwalk/internal/model"
)

func TestSessionKeyIsStableAndSourceSpecific(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	first := SessionKey("codex", path)
	if second := SessionKey("codex", path); second != first {
		t.Fatalf("SessionKey changed: %q != %q", first, second)
	}
	if other := SessionKey("claude-code", path); other == first {
		t.Fatalf("SessionKey ignored harness: %q", other)
	}
	if other := SessionKey("codex", path+".copy"); other == first {
		t.Fatalf("SessionKey ignored path: %q", other)
	}
}

func TestBuildEventKeepsExecAggregatedAndFindsSingleCommandTarget(t *testing.T) {
	root := t.TempDir()
	writeAdapterTestFile(t, root, "README.md")
	source := `const r = await tools.exec_command({cmd:"sed -n '1,20p' README.md",workdir:` + jsonString(t, root) + `});`

	event := buildExecEvent(root, map[string]any{"_raw": source})
	if event.Tool != "exec" || event.Action != "exec" {
		t.Fatalf("event = %#v", event)
	}
	if len(event.Targets) != 1 || event.Targets[0].Path != "README.md" || !event.Targets[0].Weak {
		t.Fatalf("targets = %#v", event.Targets)
	}
}

func TestBuildEventExtractsPromiseAllCommandTargets(t *testing.T) {
	root := t.TempDir()
	writeAdapterTestFile(t, root, "first/main.go")
	writeAdapterTestFile(t, root, "second/main.go")
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	source := `const rs = await Promise.all([
  tools.exec_command({cmd:"sed -n '1,20p' main.go",workdir:` + jsonString(t, first) + `}),
  tools.exec_command({"cmd":"rg TODO main.go","workdir":` + jsonString(t, second) + `})
]);`

	event := buildExecEvent(root, map[string]any{"code": source})
	if event.Tool != "exec" || event.Action != "exec" {
		t.Fatalf("event = %#v", event)
	}
	if len(event.Targets) != 2 {
		t.Fatalf("targets = %#v", event.Targets)
	}
	want := []string{"first/main.go", "second/main.go"}
	for i, target := range event.Targets {
		if target.Path != want[i] || !target.Weak {
			t.Fatalf("target %d = %#v", i, target)
		}
	}
}

func TestBuildEventDecodesEscapedExecStrings(t *testing.T) {
	root := t.TempDir()
	workdir := filepath.Join(root, `quoted"dir`)
	writeAdapterTestFile(t, workdir, "src/main.go")
	command := `sed -n "1,20p" src/main.go`
	source := `tools.exec_command({cmd:` + jsonString(t, command) + `,workdir:` + jsonString(t, workdir) + `});`

	event := buildExecEvent(root, map[string]any{"script": source})
	if len(event.Targets) != 1 || event.Targets[0].Path != `quoted"dir/src/main.go` || !event.Targets[0].Weak {
		t.Fatalf("targets = %#v", event.Targets)
	}
}

func TestBuildEventAcceptsWorkdirBeforeCommand(t *testing.T) {
	root := t.TempDir()
	workdir := filepath.Join(root, "sub")
	writeAdapterTestFile(t, workdir, "main.go")
	source := `tools.exec_command({workdir:` + jsonString(t, workdir) + `,cmd:"sed main.go"});`

	event := buildExecEvent(root, map[string]any{"_raw": source})
	if len(event.Targets) != 1 || event.Targets[0].Path != "sub/main.go" {
		t.Fatalf("targets = %#v", event.Targets)
	}
}

func TestBuildEventExecActionRequiresEveryCommandToVerify(t *testing.T) {
	tests := []struct {
		name   string
		source string
		want   string
	}{
		{
			name:   "all verification commands",
			source: `Promise.all([tools.exec_command({cmd:"go test ./..."}), tools.exec_command({cmd:"make test"})])`,
			want:   "verify",
		},
		{
			name:   "verification and ordinary command",
			source: `Promise.all([tools.exec_command({cmd:"go test ./..."}), tools.exec_command({cmd:"sed -n '1,20p' README.md"})])`,
			want:   "exec",
		},
		{
			name:   "verification and another tool",
			source: `Promise.all([tools.exec_command({cmd:"go test ./..."}), tools.apply_patch("*** Begin Patch")])`,
			want:   "exec",
		},
		{
			name:   "dynamic command",
			source: `tools.exec_command({cmd,workdir:"/tmp"})`,
			want:   "exec",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			event := buildExecEvent(t.TempDir(), map[string]any{"_raw": tt.source})
			if event.Tool != "exec" || event.Action != tt.want {
				t.Fatalf("event = %#v, want action %q", event, tt.want)
			}
		})
	}
}

func TestBuildEventDoesNotPairDistantExecWorkdir(t *testing.T) {
	root := t.TempDir()
	writeAdapterTestFile(t, root, "README.md")
	source := `tools.exec_command({cmd:"sed README.md"}); const metadata = {workdir:"/tmp/not-the-command-workdir"};`

	event := buildExecEvent(root, map[string]any{"_raw": source})
	if len(event.Targets) != 1 || event.Targets[0].Path != "README.md" || !event.Targets[0].Weak {
		t.Fatalf("targets = %#v", event.Targets)
	}
	if len(event.Outside) != 0 {
		t.Fatalf("outside = %#v", event.Outside)
	}
}

func TestBuildEventIgnoresExecExamplesInStringsAndComments(t *testing.T) {
	root := t.TempDir()
	writeAdapterTestFile(t, root, "README.md")
	source := "const quoted = 'tools.exec_command({cmd:\"go test ./...\"})';\n" +
		"const template = `tools.exec_command({cmd:\"sed README.md\"})`;\n" +
		"// tools.exec_command({cmd:\"sed README.md\"})\n" +
		"/* tools.exec_command({cmd:\"sed README.md\"}) */\n" +
		"text(quoted + template);"

	event := buildExecEvent(root, map[string]any{"_raw": source})
	if event.Action != "exec" || len(event.Targets) != 0 {
		t.Fatalf("event = %#v", event)
	}
}

func TestBuildEventExtractsJSReplTargets(t *testing.T) {
	root := t.TempDir()
	writeAdapterTestFile(t, root, "packages/db/src/index.ts")
	code := `const db = await import("./packages/db/src/index.ts")`

	for _, key := range []string{"code", "_raw"} {
		t.Run(key, func(t *testing.T) {
			trace := &model.Trace{Session: model.TraceSession{Cwd: root}}
			event := BuildEvent(trace, ToolCall{Name: "js_repl", Input: map[string]any{key: code}}, ToolResult{})
			if event.Tool != "js_repl" || event.Action != "exec" {
				t.Fatalf("event = %#v", event)
			}
			if len(event.Targets) != 1 || event.Targets[0].Path != "packages/db/src/index.ts" || !event.Targets[0].Weak {
				t.Fatalf("targets = %#v", event.Targets)
			}
		})
	}
}

func buildExecEvent(cwd string, input map[string]any) model.Event {
	trace := &model.Trace{Session: model.TraceSession{Cwd: cwd}}
	return BuildEvent(trace, ToolCall{Name: "exec", Input: input}, ToolResult{})
}

func writeAdapterTestFile(t *testing.T, root, path string) {
	t.Helper()
	fullPath := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fullPath, []byte("test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func jsonString(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
