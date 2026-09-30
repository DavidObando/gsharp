// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
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

func TestIdentityBoundRemovalPreservesUnknownWhenAtomicRestorationFails(t *testing.T) {
	out := t.TempDir()
	output, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(out, "analysis.json")
	displaced := filepath.Join(out, "owned-analysis")
	if err := os.WriteFile(path, []byte("owned"), 0o644); err != nil {
		t.Fatal(err)
	}
	expected, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	outputBeforeDestructiveHook = func(name string) {
		if name != "analysis.json" {
			return
		}
		outputBeforeDestructiveHook = nil
		if err := os.Rename(path, displaced); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("competitor one"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	outputAfterDestructiveMoveHook = func(name string) {
		if name != "analysis.json" {
			return
		}
		outputAfterDestructiveMoveHook = nil
		if err := os.WriteFile(path, []byte("competitor two"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	originalExchange := outputAtomicExchangeBetween
	outputAtomicExchangeBetween = func(int, string, int, string) error {
		return errors.New("unsupported atomic exchange")
	}
	t.Cleanup(func() {
		outputBeforeDestructiveHook = nil
		outputAfterDestructiveMoveHook = nil
		outputAtomicExchangeBetween = originalExchange
	})
	if removed, err := removeOutputEntryIfSame(output, "analysis.json", expected); err == nil || removed {
		t.Fatalf("failed restoration did not fail closed: removed=%v err=%v", removed, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "competitor two" {
		t.Fatalf("second competitor changed: %q, %v", data, err)
	}
	outputAtomicExchangeBetween = originalExchange
	if err := output.release(); err == nil {
		t.Fatal("release succeeded with unknown quarantined data")
	}
	var foundFirst bool
	err = filepath.WalkDir(out, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if string(data) == "competitor one" {
			foundFirst = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !foundFirst {
		t.Fatal("first competitor was deleted after failed restoration")
	}
}

func TestOutputQuarantinePreservesUnownedAdditions(t *testing.T) {
	out := t.TempDir()
	output, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	unowned := filepath.Join(out, output.removalName, "competitor")
	if err := os.WriteFile(unowned, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := output.release(); err == nil {
		t.Fatal("release succeeded with an unowned quarantine entry")
	}
	var preserved string
	entries, err := os.ReadDir(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".go2gs-preserved-") {
			preserved = filepath.Join(out, entry.Name(), "competitor")
			break
		}
	}
	if preserved == "" {
		t.Fatal("unowned quarantine entry was not preserved")
	}
	if data, err := os.ReadFile(preserved); err != nil || string(data) != "keep" {
		t.Fatalf("preserved competitor changed: %q, %v", data, err)
	}
	if _, err := lockAndInvalidateOutput(out); err == nil ||
		!strings.Contains(err.Error(), "preserved output quarantine") {
		t.Fatalf("preserved quarantine was not surfaced on restart: %v", err)
	}
}
