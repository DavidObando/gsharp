// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestAnalysisWorkerAppliesHardMemoryCeiling(t *testing.T) {
	const probe = "GO2GS_TEST_WORKER_MEMORY_LIMIT"
	if os.Getenv(probe) == "1" {
		analysisWorkerMemoryLimitTestHook = func() {
			var limit unix.Rlimit
			if err := unix.Getrlimit(unix.RLIMIT_DATA, &limit); err != nil {
				panic(err)
			}
			fmt.Printf("worker-memory-limit=%d:%d\n", limit.Cur, limit.Max)
		}
		_ = runAnalyzeWorker(context.Background(), nil)
		return
	}

	command := exec.Command(os.Args[0], "-test.run=^TestAnalysisWorkerAppliesHardMemoryCeiling$")
	command.Env = append(os.Environ(),
		probe+"=1",
		"GO2GS_SELECTED_GO=/private/go",
		"GO2GS_SELECTED_GO_SHA256=test",
		"GO2GS_SELECTED_GOROOT=/private/goroot",
		"GO2GS_EXEC_NAMESPACE=1",
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("worker memory probe failed: %v\n%s", err, output)
	}
	value := ""
	for _, field := range strings.Fields(string(output)) {
		if parsed, found := strings.CutPrefix(field, "worker-memory-limit="); found {
			value = parsed
			break
		}
	}
	if value == "" {
		t.Fatalf("worker path did not apply the memory ceiling: %q", output)
	}
	softText, hardText, found := strings.Cut(value, ":")
	if !found {
		t.Fatalf("invalid worker memory ceiling %q", value)
	}
	soft, err := strconv.ParseUint(softText, 10, 64)
	if err != nil {
		t.Fatalf("invalid worker memory ceiling %q: %v", value, err)
	}
	hard, err := strconv.ParseUint(hardText, 10, 64)
	if err != nil {
		t.Fatalf("invalid worker memory ceiling %q: %v", value, err)
	}
	if soft == uint64(unix.RLIM_INFINITY) || hard == uint64(unix.RLIM_INFINITY) ||
		soft > analysisWorkerDataLimitBytes || hard > analysisWorkerDataLimitBytes {
		t.Fatalf("worker RLIMIT_DATA = %d:%d, want both at most %d",
			soft, hard, analysisWorkerDataLimitBytes)
	}
}
