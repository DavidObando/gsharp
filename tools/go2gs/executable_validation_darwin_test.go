// Copyright (C) GSharp Authors. All rights reserved.

//go:build darwin

package main

import (
	"debug/macho"
	"encoding/binary"
	"testing"
)

func TestDarwinSelectedGoRequiresNativeExecutableMachO(t *testing.T) {
	for _, test := range []struct {
		goarch string
		cpu    macho.Cpu
	}{
		{"amd64", macho.CpuAmd64},
		{"arm64", macho.CpuArm64},
	} {
		t.Run(test.goarch, func(t *testing.T) {
			if err := validateSelectedGoPlatformForArch(
				minimalMachO64(test.cpu, macho.TypeExec), test.goarch); err != nil {
				t.Fatalf("native executable Mach-O rejected: %v", err)
			}
			for name, data := range map[string][]byte{
				"wrong-cpu":  minimalMachO64(macho.Cpu386, macho.TypeExec),
				"wrong-type": minimalMachO64(test.cpu, macho.TypeDylib),
				"foreign":    []byte("\x7fELF"),
			} {
				t.Run(name, func(t *testing.T) {
					if err := validateSelectedGoPlatformForArch(data, test.goarch); err == nil {
						t.Fatal("foreign or non-executable selected Go was accepted")
					}
				})
			}
		})
	}
	if _, ok := machoCPUForGoArch("unsupported"); ok {
		t.Fatal("unsupported Darwin architecture was accepted")
	}
}

func minimalMachO64(cpu macho.Cpu, fileType macho.Type) []byte {
	result := make([]byte, 32)
	binary.LittleEndian.PutUint32(result[0:4], uint32(macho.Magic64))
	binary.LittleEndian.PutUint32(result[4:8], uint32(cpu))
	binary.LittleEndian.PutUint32(result[8:12], 0)
	binary.LittleEndian.PutUint32(result[12:16], uint32(fileType))
	return result
}
