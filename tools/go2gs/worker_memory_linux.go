// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"fmt"

	"golang.org/x/sys/unix"
)

const analysisWorkerDataLimitBytes uint64 = 2 << 30

var analysisWorkerMemoryLimitTestHook func()

func constrainAnalysisWorkerMemory() error {
	var limit unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_DATA, &limit); err != nil {
		return err
	}
	target := analysisWorkerDataLimitBytes
	if limit.Max != unix.RLIM_INFINITY && target > limit.Max {
		target = limit.Max
	}
	soft := target
	if limit.Cur != unix.RLIM_INFINITY && limit.Cur < soft {
		soft = limit.Cur
	}
	if soft == 0 {
		return fmt.Errorf("RLIMIT_DATA hard limit is zero")
	}
	if limit.Cur != soft || limit.Max != target {
		limit.Cur = soft
		limit.Max = target
		if err := unix.Setrlimit(unix.RLIMIT_DATA, &limit); err != nil {
			return err
		}
	}
	if analysisWorkerMemoryLimitTestHook != nil {
		analysisWorkerMemoryLimitTestHook()
	}
	return nil
}
