// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicAnalyzeFailsClosedWithoutExecutionBinding(t *testing.T) {
	out := filepath.Join(t.TempDir(), "out")
	err := runAnalyze(t.Context(), []string{
		"--source", t.TempDir(),
		"--profile", filepath.Join(t.TempDir(), "profile.json"),
		"--out", out,
	})
	var exitErr *exitError
	if !errors.As(err, &exitErr) || exitErr.code != 2 ||
		!strings.Contains(err.Error(), unsupportedExecutionBinding) {
		t.Fatalf("public analyze did not report unsupported execution binding: %v", err)
	}
	if _, statErr := os.Lstat(out); !os.IsNotExist(statErr) {
		t.Fatalf("unsupported public analyze created output: %v", statErr)
	}
}
