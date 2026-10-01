// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWindowsSelectedGoPlatformValidation(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(runtime.GOROOT(), "bin", selectedGoName()))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateSelectedGoPlatform(data); err != nil {
		t.Fatalf("native Go executable rejected: %v", err)
	}
	if err := validateSelectedGoPlatform([]byte("not a PE executable")); err == nil {
		t.Fatal("non-PE selected Go executable accepted")
	}
}
