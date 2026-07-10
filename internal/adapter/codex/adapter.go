package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cosmtrek/mindwalk/internal/adapter"
	"github.com/cosmtrek/mindwalk/internal/model"
)

type Adapter struct {
	Dir       string
	IndexPath string
}

func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex", "sessions")
}

func DefaultIndexPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex", "session_index.jsonl")
}

func (a Adapter) Harness() string {
	return "codex"
}

func (a Adapter) SessionDir() string {
	if a.Dir != "" {
		return a.Dir
	}
	return DefaultDir()
}

func (a Adapter) ListSessions() ([]model.SessionMeta, error) {
	dir := a.SessionDir()
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return nil, nil
	}
	var metas []model.SessionMeta
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".jsonl" {
			return nil
		}
		meta, err := a.Summarize(path)
		if err == nil {
			metas = append(metas, meta)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(metas, func(i, j int) bool {
		return metas[i].EndedAt > metas[j].EndedAt
	})
	return metas, nil
}

func (a Adapter) Summarize(path string) (model.SessionMeta, error) {
	f, err := os.Open(path)
	if err != nil {
		return model.SessionMeta{}, err
	}
	defer f.Close()

	id := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	meta := model.SessionMeta{Key: adapter.SessionKey(a.Harness(), path), ID: id, Harness: a.Harness(), Path: path}
	recognized := false
	err = adapter.ReadJSONLines(f, func(data []byte) {
		var line rawLine
		if json.Unmarshal(data, &line) != nil {
			return
		}
		if line.Timestamp != "" {
			if meta.StartedAt == "" {
				meta.StartedAt = line.Timestamp
			}
			meta.EndedAt = line.Timestamp
		}
		switch line.Type {
		case "session_meta":
			recognized = true
			var payload sessionMetaPayload
			if json.Unmarshal(line.Payload, &payload) == nil {
				applySessionMeta(&meta, payload)
			}
		case "turn_context":
			recognized = true
			var payload turnContextPayload
			if json.Unmarshal(line.Payload, &payload) == nil {
				if payload.Cwd != "" && meta.Cwd == "" {
					meta.Cwd = payload.Cwd
				}
				if payload.Model != "" && meta.Model == "" {
					meta.Model = payload.Model
				}
			}
		case "response_item":
			recognized = true
			var payload responseItemPayload
			if json.Unmarshal(line.Payload, &payload) == nil && payload.Type == "function_call" {
				meta.EventCount++
			}
		case "event_msg":
			recognized = true
		case "message":
			recognized = true
		case "":
			if line.ID != "" {
				recognized = true
				meta.ID = line.ID
			}
		}
	})
	if meta.Title == "" {
		meta.Title = a.titleFor(meta.ID)
	}
	if meta.Title == "" {
		meta.Title = filepath.Base(path)
	}
	if !recognized {
		return model.SessionMeta{}, fmt.Errorf("not a Codex session: %s", path)
	}
	return meta, err
}

func (a Adapter) Parse(path string) (*model.Trace, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	id := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	trace := &model.Trace{
		Version: 1,
		Session: model.TraceSession{
			ID:      id,
			Harness: a.Harness(),
			Path:    path,
		},
		Events: []model.Event{},
		Marks:  []model.Mark{},
	}

	recognized := false
	pending := map[string]adapter.ToolCall{}
	pendingOrder := []string{}
	err = adapter.ReadJSONLines(f, func(data []byte) {
		var line rawLine
		if json.Unmarshal(data, &line) != nil {
			return
		}
		applyLineTime(trace, line.Timestamp)
		switch line.Type {
		case "session_meta":
			recognized = true
			var payload sessionMetaPayload
			if json.Unmarshal(line.Payload, &payload) == nil {
				applyTraceSessionMeta(trace, payload)
			}
		case "turn_context":
			recognized = true
			var payload turnContextPayload
			if json.Unmarshal(line.Payload, &payload) == nil {
				if payload.Cwd != "" && trace.Session.Cwd == "" {
					trace.Session.Cwd = payload.Cwd
				}
				if payload.Model != "" && trace.Session.Model == "" {
					trace.Session.Model = payload.Model
				}
			}
		case "response_item":
			recognized = true
			var payload responseItemPayload
			if json.Unmarshal(line.Payload, &payload) != nil {
				return
			}
			switch payload.Type {
			case "function_call":
				callID := payload.CallID
				if callID == "" {
					callID = payload.ID
				}
				call := adapter.ToolCall{
					ID:        callID,
					Name:      payload.Name,
					Input:     parseArguments(payload.Arguments),
					Timestamp: line.Timestamp,
				}
				if call.Name == "" || call.ID == "" {
					return
				}
				if _, exists := pending[call.ID]; !exists {
					pendingOrder = append(pendingOrder, call.ID)
				}
				pending[call.ID] = call
			case "function_call_output":
				call, ok := pending[payload.CallID]
				if !ok {
					return
				}
				delete(pending, payload.CallID)
				output := adapter.ContentToString(payload.Output)
				event := adapter.BuildEvent(trace, call, adapter.ToolResult{
					Content: output,
					IsError: commandOutputFailed(output),
				})
				trace.Events = append(trace.Events, event)
			case "message":
				if payload.Role == "user" && payload.Content.HasText() {
					trace.Marks = append(trace.Marks, model.Mark{Seq: len(trace.Events), Type: "user-message"})
				}
			}
		case "message":
			recognized = true
			if line.Role == "user" && line.Content.HasText() {
				trace.Marks = append(trace.Marks, model.Mark{Seq: len(trace.Events), Type: "user-message"})
			}
		case "event_msg":
			recognized = true
		case "":
			if line.ID != "" {
				recognized = true
				trace.Session.ID = line.ID
			}
		}
	})
	for _, id := range pendingOrder {
		if call, ok := pending[id]; ok {
			trace.Events = append(trace.Events, adapter.BuildEvent(trace, call, adapter.ToolResult{}))
		}
	}
	for i := range trace.Events {
		trace.Events[i].Seq = i
	}
	if trace.Session.Title == "" {
		trace.Session.Title = a.titleFor(trace.Session.ID)
	}
	trace.Session.EventCount = len(trace.Events)
	trace.Stats = model.ComputeStats(trace, 0)
	if !recognized {
		return nil, fmt.Errorf("not a Codex session: %s", path)
	}
	return trace, err
}

type rawLine struct {
	Type      string           `json:"type"`
	Timestamp string           `json:"timestamp"`
	Payload   json.RawMessage  `json:"payload"`
	ID        string           `json:"id"`
	Role      string           `json:"role"`
	Content   codexContentList `json:"content"`
}

type sessionMetaPayload struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Timestamp string `json:"timestamp"`
	Cwd       string `json:"cwd"`
	Git       struct {
		Branch     string `json:"branch"`
		CommitHash string `json:"commit_hash"`
	} `json:"git"`
}

type turnContextPayload struct {
	Cwd   string `json:"cwd"`
	Model string `json:"model"`
}

type responseItemPayload struct {
	Type      string           `json:"type"`
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Arguments string           `json:"arguments"`
	CallID    string           `json:"call_id"`
	Output    any              `json:"output"`
	Role      string           `json:"role"`
	Content   codexContentList `json:"content"`
}

type codexContentList struct {
	Items []codexContentItem
}

func (c *codexContentList) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		return nil
	}
	if data[0] == '"' {
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		c.Items = []codexContentItem{{Type: "text", Text: s}}
		return nil
	}
	var items []codexContentItem
	if err := json.Unmarshal(data, &items); err != nil {
		return err
	}
	c.Items = items
	return nil
}

func (c codexContentList) HasText() bool {
	for _, item := range c.Items {
		if strings.TrimSpace(item.Text) != "" {
			return true
		}
	}
	return false
}

type codexContentItem struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func applySessionMeta(meta *model.SessionMeta, payload sessionMetaPayload) {
	if payload.ID != "" {
		meta.ID = payload.ID
	} else if payload.SessionID != "" {
		meta.ID = payload.SessionID
	}
	if payload.Cwd != "" && meta.Cwd == "" {
		meta.Cwd = payload.Cwd
	}
	if payload.Git.Branch != "" && meta.GitBranch == "" {
		meta.GitBranch = payload.Git.Branch
	}
	if payload.Timestamp != "" {
		if meta.StartedAt == "" {
			meta.StartedAt = payload.Timestamp
		}
		if meta.EndedAt == "" {
			meta.EndedAt = payload.Timestamp
		}
	}
}

func applyTraceSessionMeta(trace *model.Trace, payload sessionMetaPayload) {
	if payload.ID != "" {
		trace.Session.ID = payload.ID
	} else if payload.SessionID != "" {
		trace.Session.ID = payload.SessionID
	}
	if payload.Cwd != "" && trace.Session.Cwd == "" {
		trace.Session.Cwd = payload.Cwd
	}
	if payload.Git.CommitHash != "" {
		trace.Session.Commit = payload.Git.CommitHash
	}
	if payload.Timestamp != "" && trace.Session.StartedAt == "" {
		trace.Session.StartedAt = payload.Timestamp
	}
}

func applyLineTime(trace *model.Trace, ts string) {
	if ts == "" {
		return
	}
	if trace.Session.StartedAt == "" {
		trace.Session.StartedAt = ts
	}
	trace.Session.EndedAt = ts
}

func parseArguments(raw string) map[string]any {
	raw = strings.TrimSpace(raw)
	input := map[string]any{}
	if raw == "" {
		return input
	}
	if json.Unmarshal([]byte(raw), &input) == nil {
		return input
	}
	var text string
	if json.Unmarshal([]byte(raw), &text) == nil {
		input["_raw"] = text
	} else {
		input["_raw"] = raw
	}
	return input
}

var exitCodeRe = regexp.MustCompile(`Process exited with code ([0-9]+)`)

func commandOutputFailed(output string) bool {
	match := exitCodeRe.FindStringSubmatch(output)
	if len(match) != 2 {
		return false
	}
	return match[1] != "0"
}

func (a Adapter) titleFor(id string) string {
	if id == "" {
		return ""
	}
	index := a.indexPath()
	if index == "" {
		return ""
	}
	return loadTitleIndex(index)[id]
}

// titleIndexCache holds the parsed session index; summarizing a whole
// sessions directory looks up a title per file, so re-reading the index
// each time would make the scan quadratic
var titleIndexCache struct {
	mu      sync.Mutex
	path    string
	size    int64
	modTime time.Time
	titles  map[string]string
}

func loadTitleIndex(path string) map[string]string {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	titleIndexCache.mu.Lock()
	defer titleIndexCache.mu.Unlock()
	if titleIndexCache.path == path && titleIndexCache.size == info.Size() && titleIndexCache.modTime.Equal(info.ModTime()) {
		return titleIndexCache.titles
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	titles := map[string]string{}
	_ = adapter.ReadJSONLines(f, func(data []byte) {
		var row struct {
			ID         string `json:"id"`
			ThreadName string `json:"thread_name"`
		}
		if json.Unmarshal(data, &row) == nil && row.ID != "" && row.ThreadName != "" {
			titles[row.ID] = row.ThreadName
		}
	})
	titleIndexCache.path = path
	titleIndexCache.size = info.Size()
	titleIndexCache.modTime = info.ModTime()
	titleIndexCache.titles = titles
	return titles
}

func (a Adapter) indexPath() string {
	if a.IndexPath != "" {
		return a.IndexPath
	}
	if a.Dir != "" {
		dir := filepath.Clean(a.SessionDir())
		candidate := filepath.Join(filepath.Dir(dir), "session_index.jsonl")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if candidate := DefaultIndexPath(); candidate != "" {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	dir := filepath.Clean(a.SessionDir())
	candidate := filepath.Join(filepath.Dir(dir), "session_index.jsonl")
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return ""
}
