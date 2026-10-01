// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix

package main

import (
	"runtime"
	"syscall"
)

func peakRSS() int64 {
	var usage syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &usage) != nil {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return int64(usage.Maxrss)
	}
	// Linux and the BSDs report KiB.
	return int64(usage.Maxrss) * 1024
}
