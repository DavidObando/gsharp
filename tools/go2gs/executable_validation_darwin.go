// Copyright (C) GSharp Authors. All rights reserved.

//go:build darwin

package main

import (
	"bytes"
	"debug/macho"
	"fmt"
	"runtime"
)

func validateSelectedGoPlatform(data []byte) error {
	return validateSelectedGoPlatformForArch(data, runtime.GOARCH)
}

func validateSelectedGoPlatformForArch(data []byte, goarch string) error {
	file, err := macho.NewFile(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("selected Go Darwin executable is not a valid Mach-O file: %w", err)
	}
	defer file.Close()

	cpu, ok := machoCPUForGoArch(goarch)
	if !ok || file.Cpu != cpu || file.Type != macho.TypeExec {
		return fmt.Errorf("selected Go Darwin Mach-O format is unsupported: cpu=%s type=%s",
			file.Cpu, file.Type)
	}
	return nil
}

func machoCPUForGoArch(goarch string) (macho.Cpu, bool) {
	switch goarch {
	case "amd64":
		return macho.CpuAmd64, true
	case "arm64":
		return macho.CpuArm64, true
	default:
		return 0, false
	}
}
