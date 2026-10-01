// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"encoding/json"
	"strconv"
	"testing"
	"unicode/utf8"
)

func TestTruncatePreservesUTF8AndByteLimit(t *testing.T) {
	tests := []struct {
		name      string
		value     string
		max       int
		want      string
		truncated bool
	}{
		{"empty-zero", "", 0, "", false},
		{"smaller-than-ellipsis", "abcd", 2, "..", true},
		{"ellipsis-boundary", "abcd", 3, "...", true},
		{"ascii-exact", "abcdef", 6, "abcdef", false},
		{"ascii-truncated", "abcdefg", 6, "abc...", true},
		{"multibyte-boundary", "αβγδ", 6, "α...", true},
		{"combining-code-point-boundary", "e\u0301xy", 4, "e...", true},
		{"invalid-normalized", string([]byte{'a', 0xff, 'b'}), 8, "a\uFFFDb", true},
		{"invalid-and-truncated", string([]byte{'a', 0xff, 'b'}), 4, "a...", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, truncated := truncate(test.value, test.max)
			if got != test.want || truncated != test.truncated {
				t.Fatalf("truncate(%q, %d) = %q, %v; want %q, %v",
					test.value, test.max, got, truncated, test.want, test.truncated)
			}
			if !utf8.ValidString(got) || len(got) > test.max {
				t.Fatalf("bounded value is invalid or too large: %q (%d > %d)", got, len(got), test.max)
			}
		})
	}
}

func TestTruncatedDiagnosticIDMatchesPublishedJSON(t *testing.T) {
	const (
		max       = 6
		packageID = "package:test"
		kind      = 1
		position  = "fixture.go:1:1"
	)
	message, truncated := truncate("αβγδ", max)
	record := DiagnosticRecord{
		ID:       stableID("diagnostic", packageID+"\x00"+strconv.Itoa(kind)+"\x00"+position+"\x00"+message),
		Category: "type", Severity: "error", Message: message, Position: position,
		PackageID: packageID, Truncated: truncated,
	}
	first, err := marshalCanonical(record)
	if err != nil {
		t.Fatal(err)
	}
	second, err := marshalCanonical(record)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("truncated diagnostic output is nondeterministic:\n%s\n%s", first, second)
	}
	var published DiagnosticRecord
	if err := json.Unmarshal(first, &published); err != nil {
		t.Fatal(err)
	}
	if !utf8.ValidString(published.Message) || len(published.Message) > max {
		t.Fatalf("published message is invalid or too large: %q", published.Message)
	}
	wantID := stableID("diagnostic",
		published.PackageID+"\x00"+strconv.Itoa(kind)+"\x00"+published.Position+"\x00"+published.Message)
	if published.ID != wantID {
		t.Fatalf("published diagnostic ID = %q; want %q for message %q", published.ID, wantID, published.Message)
	}
}
