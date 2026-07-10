package adapter

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/cosmtrek/mindwalk/internal/model"
)

type Source interface {
	Harness() string
	SessionDir() string
	ListSessions() ([]model.SessionMeta, error)
	Summarize(path string) (model.SessionMeta, error)
	Parse(path string) (*model.Trace, error)
}

type ToolCall struct {
	ID        string
	Name      string
	Input     map[string]any
	Timestamp string
}

type ToolResult struct {
	Content string
	IsError bool
}

// SessionKey identifies one session file independently of the harness-level
// session ID. Codex resume rollouts can share an ID across multiple files, so
// IDs are display metadata rather than safe routing or cache keys.
func SessionKey(harness, path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	path = filepath.Clean(path)
	sum := sha256.Sum256([]byte(harness + "\x00" + path))
	return fmt.Sprintf("%s-%x", harness, sum[:12])
}

func ReadJSONLines(r io.Reader, visit func([]byte)) error {
	reader := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimRight(line, "\r\n")
			if len(line) > 0 {
				visit(line)
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func BuildEvent(trace *model.Trace, call ToolCall, result ToolResult) model.Event {
	action := actionFor(call.Name, call.Input, result.Content)
	targets, outside := targetsFor(trace.Session.Cwd, call.Name, call.Input, result.Content)
	if targets == nil {
		targets = []model.Target{}
	}
	return model.Event{
		Seq:         len(trace.Events),
		Timestamp:   call.Timestamp,
		Tool:        call.Name,
		Action:      action,
		Targets:     targets,
		Outside:     outside,
		ResultBytes: len(result.Content),
		IsError:     result.IsError,
		Summary:     SummarizeTool(call.Name, call.Input, targets, outside, result.IsError),
	}
}

func ContentToString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []any:
		parts := make([]string, 0, len(x))
		for _, item := range x {
			if m, ok := item.(map[string]any); ok {
				if text, ok := m["text"].(string); ok {
					parts = append(parts, text)
				}
				if text, ok := m["content"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

func IntFromAny(v any) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	default:
		return 0
	}
}

func actionFor(tool string, input map[string]any, result string) string {
	switch tool {
	case "Read":
		return "read"
	case "Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch":
		return "edit"
	case "Grep", "Glob", "LS", "view_image":
		return "search"
	case "Bash", "exec_command", "write_stdin", "js":
		command := firstString(input, "command", "cmd", "code", "chars")
		if verifyCommand(command) {
			return "verify"
		}
		return "exec"
	default:
		_ = result
		return "other"
	}
}

func targetsFor(cwd, tool string, input map[string]any, result string) ([]model.Target, []model.OutsideTouch) {
	var targets []model.Target
	var outside []model.OutsideTouch
	add := func(path, touch string, weak bool, lines [][2]int, base string) {
		rel, out, ok := normalizePath(cwd, base, path)
		if !ok {
			return
		}
		if out != nil {
			outside = append(outside, *out)
			return
		}
		if weak && !repoPathExists(cwd, rel) {
			return
		}
		for i := range targets {
			if targets[i].Path == rel {
				if model.RankTouch(touch) > model.RankTouch(targets[i].Touch) {
					targets[i].Touch = touch
				}
				targets[i].Lines = append(targets[i].Lines, lines...)
				return
			}
		}
		targets = append(targets, model.Target{Path: rel, Touch: touch, Lines: lines, Weak: weak})
	}

	switch tool {
	case "Read":
		if path, ok := input["file_path"].(string); ok {
			add(path, "read", false, readLines(input), "")
		}
	case "Write", "Edit", "MultiEdit", "NotebookEdit":
		if path, ok := input["file_path"].(string); ok {
			add(path, "edit", false, nil, "")
		}
		if path, ok := input["notebook_path"].(string); ok {
			add(path, "edit", false, nil, "")
		}
	case "Grep":
		for _, hit := range parsePathHits(result) {
			add(hit.path, "hit", false, hit.lines, "")
		}
		if len(targets) == 0 {
			if path, ok := input["path"].(string); ok {
				add(path, "hit", true, nil, "")
			}
		}
	case "Glob", "LS":
		for _, hit := range parsePathHits(result) {
			add(hit.path, "hit", false, nil, "")
		}
		if path, ok := input["path"].(string); ok && len(targets) == 0 {
			add(path, "hit", true, nil, "")
		}
	case "Bash":
		command := firstString(input, "command")
		for _, path := range extractCommandPaths(command) {
			add(path, "hit", true, nil, "")
		}
		for _, path := range extractPaths(command + "\n" + result) {
			add(path, "hit", true, nil, "")
		}
	case "exec_command":
		command := firstString(input, "cmd", "command")
		base := firstString(input, "workdir")
		for _, path := range extractCommandPaths(command) {
			add(path, "hit", true, nil, base)
		}
		for _, path := range extractPaths(command + "\n" + result) {
			add(path, "hit", true, nil, base)
		}
		for _, hit := range parsePathHits(result) {
			add(hit.path, "hit", true, hit.lines, base)
		}
	case "apply_patch":
		patch := firstString(input, "patch", "input", "_raw")
		for _, path := range parsePatchPaths(patch) {
			add(path, "edit", false, nil, "")
		}
	case "view_image":
		if path := firstString(input, "path"); path != "" {
			add(path, "read", false, nil, "")
		}
	case "js":
		code := firstString(input, "code", "script")
		for _, path := range extractPaths(code + "\n" + result) {
			add(path, "hit", true, nil, "")
		}
	}
	return targets, outside
}

func firstString(input map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := input[key].(string); ok {
			return value
		}
	}
	return ""
}

func repoPathExists(cwd, rel string) bool {
	if cwd == "" || rel == "" {
		return false
	}
	abs := filepath.Join(cwd, filepath.FromSlash(rel))
	_, err := os.Stat(abs)
	return err == nil
}

func readLines(input map[string]any) [][2]int {
	offset := IntFromAny(input["offset"])
	limit := IntFromAny(input["limit"])
	if offset <= 0 {
		return nil
	}
	if limit <= 0 {
		return [][2]int{{offset, offset}}
	}
	return [][2]int{{offset, offset + limit - 1}}
}

func normalizePath(cwd, base, path string) (string, *model.OutsideTouch, bool) {
	path = strings.TrimSpace(strings.Trim(path, `"'`))
	if path == "" || strings.Contains(path, "\n") {
		return "", nil, false
	}
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return "", nil, false
	}
	if !filepath.IsAbs(path) {
		clean := filepath.Clean(path)
		if clean == "." || strings.HasPrefix(clean, "..") {
			return "", nil, false
		}
		if base != "" && filepath.IsAbs(base) {
			abs := filepath.Clean(filepath.Join(base, clean))
			if cwd != "" {
				root := filepath.Clean(cwd)
				if rel, err := filepath.Rel(root, abs); err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
					return filepath.ToSlash(rel), nil, true
				}
			}
			return "", &model.OutsideTouch{Scope: outsideScope(abs), Path: abs}, true
		}
		return filepath.ToSlash(clean), nil, true
	}
	abs := filepath.Clean(path)
	if cwd != "" {
		root := filepath.Clean(cwd)
		if rel, err := filepath.Rel(root, abs); err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
			return filepath.ToSlash(rel), nil, true
		}
	}
	return "", &model.OutsideTouch{Scope: outsideScope(abs), Path: abs}, true
}

func outsideScope(path string) string {
	home, _ := os.UserHomeDir()
	if home != "" {
		if rel, err := filepath.Rel(home, path); err == nil && !strings.HasPrefix(rel, "..") {
			return "home"
		}
	}
	if strings.HasPrefix(path, os.TempDir()) || strings.HasPrefix(path, "/tmp") {
		return "tmp"
	}
	return "other"
}

type pathHit struct {
	path  string
	lines [][2]int
}

var pathLineRe = regexp.MustCompile(`(?:^|[\s"'([])([A-Za-z0-9_./@+-]*[A-Za-z0-9_/@+-]\.[A-Za-z0-9][A-Za-z0-9._-]*):([0-9]+)`)
var pathOnlyRe = regexp.MustCompile(`(?:^|[\s"'([])([./~A-Za-z0-9_@+-]*[/][A-Za-z0-9_./~@+-]*\.[A-Za-z0-9][A-Za-z0-9._-]*)(?:$|[\s"',)\]:;])`)
var commandPathRe = regexp.MustCompile(`(?:^|[\s"'=])([./~A-Za-z0-9_@+-]+\.[A-Za-z0-9][A-Za-z0-9._-]*)(?:$|[\s"',)\]:;])`)
var patchFileRe = regexp.MustCompile(`(?m)^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$`)

func parsePathHits(text string) []pathHit {
	byPath := map[string][][2]int{}
	for _, m := range pathLineRe.FindAllStringSubmatch(text, -1) {
		line := 0
		fmt.Sscanf(m[2], "%d", &line)
		if line > 0 {
			if path, ok := cleanExtractedPath(m[1], true); ok {
				byPath[path] = append(byPath[path], [2]int{line, line})
			}
		}
	}
	for _, p := range extractPaths(text) {
		if _, ok := byPath[p]; !ok {
			byPath[p] = nil
		}
	}
	out := make([]pathHit, 0, len(byPath))
	for path, lines := range byPath {
		out = append(out, pathHit{path: path, lines: lines})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out
}

func extractPaths(text string) []string {
	matches := pathOnlyRe.FindAllStringSubmatch(text, -1)
	seen := map[string]bool{}
	paths := make([]string, 0, len(matches))
	for _, m := range matches {
		path, ok := cleanExtractedPath(m[1], false)
		if !ok {
			continue
		}
		if path == "" || seen[path] || strings.Contains(path, "://") {
			continue
		}
		seen[path] = true
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func extractCommandPaths(command string) []string {
	matches := commandPathRe.FindAllStringSubmatch(command, -1)
	seen := map[string]bool{}
	paths := make([]string, 0, len(matches))
	for _, m := range matches {
		path, ok := cleanExtractedPath(m[1], true)
		if !ok || seen[path] {
			continue
		}
		seen[path] = true
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func parsePatchPaths(patch string) []string {
	matches := patchFileRe.FindAllStringSubmatch(patch, -1)
	seen := map[string]bool{}
	paths := make([]string, 0, len(matches))
	for _, m := range matches {
		raw := m[1]
		if raw == "" {
			raw = m[2]
		}
		path, ok := cleanExtractedPath(raw, true)
		if !ok || seen[path] {
			continue
		}
		seen[path] = true
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func cleanExtractedPath(path string, allowTopLevel bool) (string, bool) {
	path = strings.TrimSpace(strings.Trim(path, `"' ,;:()[]{}`))
	path = strings.TrimPrefix(path, "a/")
	path = strings.TrimPrefix(path, "b/")
	path = strings.TrimPrefix(path, "./")
	if path == "" || strings.Contains(path, "://") || strings.ContainsAny(path, "\n\r\t") {
		return "", false
	}
	if strings.HasPrefix(path, "--") || strings.HasPrefix(path, "++") {
		return "", false
	}
	if !allowTopLevel && !strings.Contains(path, "/") {
		return "", false
	}
	return path, true
}

func verifyCommand(command string) bool {
	c := strings.ToLower(command)
	patterns := []string{"go test", "go vet", "npm test", "npm run build", "pnpm test", "pnpm build", "pytest", "make test", "cargo test", "swift test"}
	for _, pattern := range patterns {
		if strings.Contains(c, pattern) {
			return true
		}
	}
	return false
}

func SummarizeTool(tool string, input map[string]any, targets []model.Target, outside []model.OutsideTouch, isError bool) string {
	verb := tool
	if desc, ok := input["description"].(string); ok && desc != "" {
		verb = desc
	}
	if command := firstString(input, "command", "cmd"); command != "" {
		verb = command
		if len(verb) > 96 {
			verb = verb[:93] + "..."
		}
	}
	status := ""
	if isError {
		status = " error"
	}
	return fmt.Sprintf("%s -> %d targets, %d outside%s", verb, len(targets), len(outside), status)
}
