// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"bytes"
	"debug/pe"
	"fmt"
	"runtime"
)

func validateSelectedGoPlatform(data []byte) error {
	file, err := pe.NewFile(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("selected Go Windows executable is not a valid PE file: %w", err)
	}
	defer file.Close()

	machine, ok := nativePEMachine()
	if !ok || file.Machine != machine ||
		file.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 ||
		file.Characteristics&pe.IMAGE_FILE_DLL != 0 {
		return fmt.Errorf("selected Go Windows PE format is unsupported: machine=%#x characteristics=%#x",
			file.Machine, file.Characteristics)
	}
	return nil
}

func nativePEMachine() (uint16, bool) {
	switch runtime.GOARCH {
	case "386":
		return pe.IMAGE_FILE_MACHINE_I386, true
	case "amd64":
		return pe.IMAGE_FILE_MACHINE_AMD64, true
	case "arm64":
		return pe.IMAGE_FILE_MACHINE_ARM64, true
	default:
		return 0, false
	}
}
