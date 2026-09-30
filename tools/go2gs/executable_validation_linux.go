// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"errors"
	"fmt"
	"runtime"
)

func validateSelectedGoPlatform(data []byte) error {
	file, err := elf.NewFile(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("selected Go Linux executable is not a valid ELF file: %w", err)
	}
	defer file.Close()

	class, dataOrder, machine, ok := nativeELFPlatform()
	if !ok || file.Class != class || file.Data != dataOrder || file.Machine != machine ||
		(file.Type != elf.ET_EXEC && file.Type != elf.ET_DYN) {
		return fmt.Errorf("selected Go Linux ELF format is unsupported: class=%s data=%s machine=%s type=%s",
			file.Class, file.Data, file.Machine, file.Type)
	}

	var violations []error
	var dynamic *elf.Prog
	for _, program := range file.Progs {
		if program.Type == elf.PT_INTERP {
			violations = append(violations, errors.New("selected Go Linux executable has a dynamic interpreter"))
		}
		if program.Type == elf.PT_DYNAMIC {
			if dynamic != nil {
				violations = append(violations, errors.New("selected Go Linux executable has multiple PT_DYNAMIC segments"))
			} else {
				dynamic = program
			}
		}
	}
	if dynamic != nil {
		tags, err := dynamicTags(data, dynamic, file.Class, file.ByteOrder)
		if err != nil {
			violations = append(violations, fmt.Errorf("inspect selected Go PT_DYNAMIC: %w", err))
		} else {
			if len(tags[elf.DT_NEEDED]) != 0 {
				violations = append(violations, errors.New("selected Go Linux executable imports dynamic libraries"))
			}
			for _, tag := range []struct {
				value elf.DynTag
				name  string
			}{
				{elf.DT_RPATH, "DT_RPATH"},
				{elf.DT_RUNPATH, "DT_RUNPATH"},
			} {
				if len(tags[tag.value]) != 0 {
					violations = append(violations, fmt.Errorf("selected Go Linux executable contains %s", tag.name))
				}
			}
			if addresses := tags[elf.DT_SYMTAB]; len(addresses) != 0 {
				if len(addresses) != 1 {
					violations = append(violations, errors.New("selected Go Linux executable has ambiguous DT_SYMTAB entries"))
				} else if section := dynamicSymbolSection(file); section == nil || section.Addr != addresses[0] {
					violations = append(violations, errors.New("selected Go Linux executable dynamic symbol table does not match PT_DYNAMIC"))
				} else if symbols, symbolErr := file.DynamicSymbols(); symbolErr != nil {
					violations = append(violations, fmt.Errorf("inspect selected Go imported dynamic symbols: %w", symbolErr))
				} else {
					imported := 0
					for _, symbol := range symbols {
						if symbol.Section == elf.SHN_UNDEF {
							imported++
						}
					}
					if imported != 0 {
						violations = append(violations, fmt.Errorf("selected Go Linux executable imports dynamic symbols or dependencies: %d", imported))
					}
				}
			}
		}
	}
	if err := errors.Join(violations...); err != nil {
		return fmt.Errorf("selected Go Linux executable must be statically linked: %w", err)
	}
	return nil
}

func dynamicTags(data []byte, program *elf.Prog, class elf.Class, order binary.ByteOrder) (map[elf.DynTag][]uint64, error) {
	entrySize := uint64(16)
	if class == elf.ELFCLASS32 {
		entrySize = 8
	}
	if program.Off > uint64(len(data)) || program.Filesz > uint64(len(data))-program.Off ||
		program.Filesz == 0 || program.Filesz%entrySize != 0 {
		return nil, errors.New("invalid PT_DYNAMIC bounds")
	}
	segment := data[program.Off : program.Off+program.Filesz]
	tags := make(map[elf.DynTag][]uint64)
	terminated := false
	for offset := uint64(0); offset < uint64(len(segment)); offset += entrySize {
		entry := segment[offset : offset+entrySize]
		var tag elf.DynTag
		var value uint64
		if class == elf.ELFCLASS32 {
			tag = elf.DynTag(int32(order.Uint32(entry[:4])))
			value = uint64(order.Uint32(entry[4:]))
		} else {
			tag = elf.DynTag(int64(order.Uint64(entry[:8])))
			value = order.Uint64(entry[8:])
		}
		if tag == elf.DT_NULL {
			terminated = true
			continue
		}
		if terminated {
			return nil, errors.New("non-null entry follows PT_DYNAMIC terminator")
		}
		tags[tag] = append(tags[tag], value)
	}
	if !terminated {
		return nil, errors.New("PT_DYNAMIC has no terminator")
	}
	return tags, nil
}

func dynamicSymbolSection(file *elf.File) *elf.Section {
	var result *elf.Section
	for _, section := range file.Sections {
		if section.Type != elf.SHT_DYNSYM {
			continue
		}
		if result != nil {
			return nil
		}
		result = section
	}
	return result
}

func nativeELFPlatform() (elf.Class, elf.Data, elf.Machine, bool) {
	switch runtime.GOARCH {
	case "386":
		return elf.ELFCLASS32, elf.ELFDATA2LSB, elf.EM_386, true
	case "amd64":
		return elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_X86_64, true
	case "arm":
		return elf.ELFCLASS32, elf.ELFDATA2LSB, elf.EM_ARM, true
	case "arm64":
		return elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_AARCH64, true
	case "ppc64":
		return elf.ELFCLASS64, elf.ELFDATA2MSB, elf.EM_PPC64, true
	case "ppc64le":
		return elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_PPC64, true
	case "riscv64":
		return elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_RISCV, true
	case "s390x":
		return elf.ELFCLASS64, elf.ELFDATA2MSB, elf.EM_S390, true
	default:
		return 0, 0, 0, false
	}
}
