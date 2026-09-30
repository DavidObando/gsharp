// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityBoundRemovalFailsClosedWhenAtomicRenameIsUnavailable(t *testing.T) {
	out := t.TempDir()
	output, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(out, "analysis.json")
	if err := os.WriteFile(path, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	expected, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	original := outputAtomicRenameNoReplace
	outputAtomicRenameNoReplace = func(int, string, int, string) error {
		return errors.New("unsupported atomic rename")
	}
	t.Cleanup(func() { outputAtomicRenameNoReplace = original })
	if removed, err := removeOutputEntryIfSame(output, "analysis.json", expected); err == nil || removed {
		t.Fatalf("unsupported rename did not fail closed: removed=%v err=%v", removed, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "keep" {
		t.Fatalf("failed rename changed target: %q, %v", data, err)
	}
	outputAtomicRenameNoReplace = original
	if err := output.release(); err != nil {
		t.Fatal(err)
	}
}
