package model

import "testing"

func TestComputeStatsFactCounters(t *testing.T) {
	trace := &Trace{
		Events: []Event{
			{Seq: 0, Action: "search", Targets: []Target{{Path: "a.go", Touch: "hit"}}, ResultBytes: 10},
			{Seq: 1, Action: "read", Targets: []Target{{Path: "a.go", Touch: "read"}}, ResultBytes: 20},
			{Seq: 2, Action: "edit", Targets: []Target{{Path: "a.go", Touch: "edit"}}},
			{Seq: 3, Action: "edit", IsError: true, Targets: []Target{{Path: "a.go", Touch: "edit"}}},
			{Seq: 4, Action: "edit", Targets: []Target{{Path: "a.go", Touch: "edit"}}},
			{Seq: 5, Action: "verify"},
			{Seq: 6, Action: "edit", Targets: []Target{{Path: "b.go", Touch: "edit"}}},
			{Seq: 7, Action: "exec", IsError: true},
		},
		Marks: []Mark{
			{Seq: 0, Type: "user-message"},
			{Seq: 3, Type: "user-message"},
			{Seq: 4, Type: "compaction"},
			{Seq: 5, Type: "subagent"},
		},
	}

	stats := ComputeStats(trace, 10)

	if stats.Actions != (ActionCounts{Search: 1, Read: 1, Edit: 4, Exec: 1, Verify: 1}) {
		t.Fatalf("actions = %#v", stats.Actions)
	}
	if stats.Errors != (ActionCounts{Edit: 1, Exec: 1}) {
		t.Fatalf("errors = %#v", stats.Errors)
	}
	if stats.MaxEditsPerFile != 3 || stats.ChurnFiles != 1 {
		t.Fatalf("maxEditsPerFile = %d, churnFiles = %d", stats.MaxEditsPerFile, stats.ChurnFiles)
	}
	if stats.UserTurns != 2 || stats.Compactions != 1 || stats.Subagents != 1 {
		t.Fatalf("marks = %d/%d/%d", stats.UserTurns, stats.Compactions, stats.Subagents)
	}
	if stats.ResultBytes != 30 {
		t.Fatalf("resultBytes = %d", stats.ResultBytes)
	}
	if stats.EditsAfterLastVerify != 1 {
		t.Fatalf("editsAfterLastVerify = %d", stats.EditsAfterLastVerify)
	}
}

func TestComputeStatsEditsAfterLastVerifyWithoutVerify(t *testing.T) {
	trace := &Trace{
		Events: []Event{
			{Seq: 0, Action: "edit", Targets: []Target{{Path: "a.go", Touch: "edit"}}},
			{Seq: 1, Action: "edit", Targets: []Target{{Path: "b.go", Touch: "edit"}}},
		},
	}
	if stats := ComputeStats(trace, 0); stats.EditsAfterLastVerify != 2 {
		t.Fatalf("editsAfterLastVerify = %d", stats.EditsAfterLastVerify)
	}
}
