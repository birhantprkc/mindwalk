package adapter

import (
	"path/filepath"
	"testing"
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
