// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"bytes"
	"debug/buildinfo"
	"debug/elf"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestLinuxELFPlatformCoversPinnedSupportedTargets(t *testing.T) {
	expected := map[string]struct {
		class   elf.Class
		data    elf.Data
		machine elf.Machine
	}{
		"386":      {elf.ELFCLASS32, elf.ELFDATA2LSB, elf.EM_386},
		"amd64":    {elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_X86_64},
		"arm":      {elf.ELFCLASS32, elf.ELFDATA2LSB, elf.EM_ARM},
		"arm64":    {elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_AARCH64},
		"loong64":  {elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_LOONGARCH},
		"mips":     {elf.ELFCLASS32, elf.ELFDATA2MSB, elf.EM_MIPS},
		"mipsle":   {elf.ELFCLASS32, elf.ELFDATA2LSB, elf.EM_MIPS},
		"mips64":   {elf.ELFCLASS64, elf.ELFDATA2MSB, elf.EM_MIPS},
		"mips64le": {elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_MIPS},
		"ppc64":    {elf.ELFCLASS64, elf.ELFDATA2MSB, elf.EM_PPC64},
		"ppc64le":  {elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_PPC64},
		"riscv64":  {elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_RISCV},
		"s390x":    {elf.ELFCLASS64, elf.ELFDATA2MSB, elf.EM_S390},
	}
	for target := range supportedGoTargets {
		goos, goarch, _ := strings.Cut(target, "/")
		if goos != "linux" {
			continue
		}
		want, ok := expected[goarch]
		if !ok {
			t.Fatalf("pinned Linux target %s has no expected ELF tuple", target)
		}
		class, data, machine, ok := elfPlatformForGoArch(goarch)
		if !ok || class != want.class || data != want.data || machine != want.machine {
			t.Errorf("%s ELF tuple = (%s, %s, %s, %t), want (%s, %s, %s, true)",
				target, class, data, machine, ok, want.class, want.data, want.machine)
		}
		delete(expected, goarch)
	}
	if len(expected) != 0 {
		t.Fatalf("ELF tuples are not pinned Linux targets: %v", expected)
	}
	if _, _, _, ok := elfPlatformForGoArch("unsupported"); ok {
		t.Fatal("unsupported Linux host architecture was accepted")
	}
}

func TestLinuxSelectedGoValidatesNewArchitectureELFTuples(t *testing.T) {
	tests := []struct {
		goarch  string
		class   elf.Class
		data    elf.Data
		machine elf.Machine
	}{
		{"loong64", elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_LOONGARCH},
		{"mips", elf.ELFCLASS32, elf.ELFDATA2MSB, elf.EM_MIPS},
		{"mipsle", elf.ELFCLASS32, elf.ELFDATA2LSB, elf.EM_MIPS},
		{"mips64", elf.ELFCLASS64, elf.ELFDATA2MSB, elf.EM_MIPS},
		{"mips64le", elf.ELFCLASS64, elf.ELFDATA2LSB, elf.EM_MIPS},
	}
	for _, test := range tests {
		t.Run(test.goarch, func(t *testing.T) {
			if err := validateSelectedGoPlatformForArch(
				minimalStaticELF(t, test.class, test.data, test.machine), test.goarch); err != nil {
				t.Fatalf("exact ELF tuple rejected: %v", err)
			}
			wrongClass := elf.ELFCLASS32
			if test.class == elf.ELFCLASS32 {
				wrongClass = elf.ELFCLASS64
			}
			wrongData := elf.ELFDATA2LSB
			if test.data == elf.ELFDATA2LSB {
				wrongData = elf.ELFDATA2MSB
			}
			for _, mutant := range []struct {
				name    string
				fixture []byte
			}{
				{"class", minimalStaticELF(t, wrongClass, test.data, test.machine)},
				{"data", minimalStaticELF(t, test.class, wrongData, test.machine)},
				{"machine", minimalStaticELF(t, test.class, test.data, elf.EM_NONE)},
			} {
				t.Run(mutant.name, func(t *testing.T) {
					if err := validateSelectedGoPlatformForArch(mutant.fixture, test.goarch); err == nil {
						t.Fatal("foreign ELF tuple was accepted")
					}
				})
			}
		})
	}
}

func minimalStaticELF(t *testing.T, class elf.Class, data elf.Data, machine elf.Machine) []byte {
	t.Helper()
	size := 52
	headerSizeOffset := 40
	if class == elf.ELFCLASS64 {
		size = 64
		headerSizeOffset = 52
	}
	result := make([]byte, size)
	copy(result, []byte{0x7f, 'E', 'L', 'F'})
	result[elf.EI_CLASS] = byte(class)
	result[elf.EI_DATA] = byte(data)
	result[elf.EI_VERSION] = byte(elf.EV_CURRENT)
	var order binary.ByteOrder = binary.LittleEndian
	if data == elf.ELFDATA2MSB {
		order = binary.BigEndian
	}
	order.PutUint16(result[16:18], uint16(elf.ET_EXEC))
	order.PutUint16(result[18:20], uint16(machine))
	order.PutUint32(result[20:24], uint32(elf.EV_CURRENT))
	order.PutUint16(result[headerSizeOffset:headerSizeOffset+2], uint16(size))
	return result
}

func TestLinuxSelectedGoStaticValidation(t *testing.T) {
	realGo := filepath.Join(runtime.GOROOT(), "bin", "go")
	captured, _, err := captureSelectedGo(realGo, "")
	if err != nil {
		t.Fatalf("official cmd/go was rejected: %v", err)
	}
	if captured.goVersion != strings.TrimPrefix(runtime.Version(), "go") {
		t.Fatalf("captured Go version = %q, want %q", captured.goVersion, strings.TrimPrefix(runtime.Version(), "go"))
	}

	data, err := os.ReadFile(realGo)
	if err != nil {
		t.Fatal(err)
	}
	unsupported := append([]byte{}, data...)
	unsupported[18], unsupported[19] = 0, 0
	for name, input := range map[string][]byte{
		"non-ELF":     []byte("not an ELF executable"),
		"truncated":   data[:20],
		"malformed":   append([]byte{0x7f, 'E', 'L', 'F'}, make([]byte, 60)...),
		"unsupported": unsupported,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "go")
			if err := os.WriteFile(path, input, 0o755); err != nil {
				t.Fatal(err)
			}
			if _, _, err := captureSelectedGo(path, ""); err == nil {
				t.Fatalf("%s selected Go was accepted", name)
			}
		})
	}
}

func TestLinuxSelectedGoRejectsDynamicELFMetadata(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc is unavailable")
	}
	root := t.TempDir()
	source := filepath.Join(root, "fixture.c")
	if err := os.WriteFile(source, []byte("#include <stdio.h>\nint main(void) { return puts(\"x\"); }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	build := func(t *testing.T, output string, args ...string) []byte {
		t.Helper()
		command := exec.Command(gcc, append([]string{source, "-o", output}, args...)...)
		if outputBytes, err := command.CombinedOutput(); err != nil {
			t.Skipf("gcc cannot build ELF fixture: %v\n%s", err, outputBytes)
		}
		data, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	assertRejected := func(t *testing.T, data []byte, want string) {
		t.Helper()
		err := validateSelectedGoPlatform(data)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("dynamic ELF error = %v, want %q", err, want)
		}
	}

	t.Run("interpreter", func(t *testing.T) {
		assertRejected(t, build(t, filepath.Join(root, "dynamic")), "interpreter")
	})
	t.Run("dependency", func(t *testing.T) {
		assertRejected(t, build(t, filepath.Join(root, "dependency.so"), "-shared", "-fPIC"), "dynamic libraries")
	})
	t.Run("sectionless-dependency", func(t *testing.T) {
		data := build(t, filepath.Join(root, "sectionless-dependency.so"), "-shared", "-fPIC")
		assertRejected(t, rewriteELFSectionType(t, data, elf.SHT_DYNAMIC, elf.SHT_PROGBITS), "dynamic libraries")
	})
	t.Run("hidden-dynamic-symbols", func(t *testing.T) {
		data := build(t, filepath.Join(root, "hidden-dynamic-symbols.so"), "-shared", "-fPIC")
		assertRejected(t, rewriteELFSectionType(t, data, elf.SHT_DYNSYM, elf.SHT_PROGBITS), "does not match PT_DYNAMIC")
	})
	for _, test := range []struct {
		name string
		flag string
		want string
	}{
		{"RPATH", "-Wl,--disable-new-dtags,-rpath," + root, "DT_RPATH"},
		{"RUNPATH", "-Wl,--enable-new-dtags,-rpath," + root, "DT_RUNPATH"},
	} {
		t.Run(test.name, func(t *testing.T) {
			assertRejected(t, build(t, filepath.Join(root, test.name+".so"), "-shared", "-fPIC", test.flag), test.want)
		})
	}
}

func rewriteELFSectionType(t *testing.T, data []byte, from, to elf.SectionType) []byte {
	t.Helper()
	file, err := elf.NewFile(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	index := -1
	for candidate, section := range file.Sections {
		if section.Type == from {
			if index != -1 {
				t.Skipf("ELF fixture has multiple %s sections", from)
			}
			index = candidate
		}
	}
	if index == -1 {
		t.Skipf("ELF fixture has no %s section", from)
	}

	var sectionOffset uint64
	var entrySize uint16
	switch file.Class {
	case elf.ELFCLASS32:
		sectionOffset = uint64(file.ByteOrder.Uint32(data[0x20:0x24]))
		entrySize = file.ByteOrder.Uint16(data[0x2e:0x30])
	case elf.ELFCLASS64:
		sectionOffset = file.ByteOrder.Uint64(data[0x28:0x30])
		entrySize = file.ByteOrder.Uint16(data[0x3a:0x3c])
	default:
		t.Fatalf("unsupported ELF class %s", file.Class)
	}
	typeOffset := sectionOffset + uint64(index)*uint64(entrySize) + 4
	if typeOffset+4 > uint64(len(data)) {
		t.Fatal("ELF section header exceeds fixture")
	}
	result := append([]byte{}, data...)
	file.ByteOrder.PutUint32(result[typeOffset:typeOffset+4], uint32(to))
	return result
}

func TestLinuxSelectedGoAllowsInternalStaticPIE(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.test/staticpie\n\ngo 1.22\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\nfunc main() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(root, "static-pie")
	command := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-buildmode=pie", "-o", output, ".")
	command.Dir = root
	command.Env = replaceEnvironment(os.Environ(), "CGO_ENABLED", "0")
	if buildOutput, err := command.CombinedOutput(); err != nil {
		t.Skipf("internal static PIE is unavailable: %v\n%s", err, buildOutput)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	file, err := elf.Open(output)
	if err != nil {
		t.Fatal(err)
	}
	fileType := file.Type
	hasInterpreter := false
	for _, program := range file.Progs {
		if program.Type == elf.PT_INTERP {
			hasInterpreter = true
			break
		}
	}
	_ = file.Close()
	if fileType != elf.ET_DYN {
		t.Skipf("toolchain did not produce PIE (ELF type %s)", fileType)
	}
	if hasInterpreter {
		t.Skip("toolchain did not produce a static PIE")
	}
	if err := validateSelectedGoPlatform(data); err != nil {
		t.Fatalf("internally linked static PIE was rejected: %v", err)
	}
}

func TestPublicAnalyzeRejectsExternallyLinkedCmdGoBeforeConstructor(t *testing.T) {
	gcc, err := exec.LookPath("gcc")
	if err != nil {
		t.Skip("gcc is unavailable")
	}
	root := t.TempDir()
	marker := filepath.Join(root, "constructor-ran")
	librarySource := filepath.Join(root, "marker.c")
	source := "#include <stdio.h>\n__attribute__((constructor)) static void mark(void) { FILE *f = fopen(" +
		strconv.Quote(marker) + ", \"w\"); if (f) fclose(f); }\n"
	if err := os.WriteFile(librarySource, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	library := filepath.Join(root, "libmarker.so")
	if output, err := exec.Command(gcc, "-shared", "-fPIC", "-o", library, librarySource).CombinedOutput(); err != nil {
		t.Skipf("cannot build constructor library: %v\n%s", err, output)
	}
	selectedDir := t.TempDir()
	selectedGo := filepath.Join(selectedDir, selectedGoName())
	extFlags := "-Wl,--no-as-needed -L" + root + " -Wl,--disable-new-dtags,-rpath," + root + " -lmarker"
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build",
		"-o", selectedGo, "-ldflags=-linkmode=external -extldflags="+extFlags, "cmd/go")
	build.Env = replaceEnvironment(os.Environ(), "CGO_ENABLED", "1")
	build.Env = replaceEnvironment(build.Env, "CC", gcc)
	if output, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build externally linked cmd/go: %v\n%s", err, output)
	}
	file, err := elf.Open(selectedGo)
	if err != nil {
		t.Fatal(err)
	}
	libraries, err := file.ImportedLibraries()
	rpaths, rpathErr := file.DynString(elf.DT_RPATH)
	_ = file.Close()
	if err != nil || rpathErr != nil || !containsString(libraries, "libmarker.so") || !containsString(rpaths, root) {
		t.Skipf("external linker did not retain constructor library and RPATH: libraries=%v rpaths=%v errors=%v/%v",
			libraries, rpaths, err, rpathErr)
	}

	binary := buildGo2gsBinary(t)
	out, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "analyze",
		"--source", copyFixture(t, "complete"),
		"--profile", writeTestProfile(t, testProfile()),
		"--out", out)
	command.Env = replaceEnvironment(os.Environ(), "PATH", selectedDir)
	output, runErr := command.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(runErr, &exitErr) || exitErr.ExitCode() != 2 {
		t.Fatalf("dynamic cmd/go should exit 2: %v\n%s", runErr, output)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("shared-library constructor executed: %v", err)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if _, err := os.Lstat(filepath.Join(out, name)); !os.IsNotExist(err) {
			t.Fatalf("bootstrap rejection wrote %s: %v", name, err)
		}
	}
}

func TestPublicAnalyzeRejectsCmdGoClaimingDifferentHelperVersion(t *testing.T) {
	const claimedVersion = "1.26.6"
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	selectedGo := filepath.Join(root, "bin", selectedGoName())
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build",
		"-o", selectedGo, "-ldflags=-X=runtime.buildVersion=go"+claimedVersion, "cmd/go")
	build.Env = replaceEnvironment(os.Environ(), "CGO_ENABLED", "0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build selected cmd/go mutant: %v\n%s", err, output)
	}
	info, err := buildinfo.ReadFile(selectedGo)
	if err != nil {
		t.Fatal(err)
	}
	if info.GoVersion != "go"+claimedVersion {
		t.Fatalf("cmd/go mutant claims %q, want %q", info.GoVersion, "go"+claimedVersion)
	}
	if err := os.WriteFile(filepath.Join(root, "VERSION"), []byte("go"+claimedVersion+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	selectedData, err := os.ReadFile(selectedGo)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO2GS_SELECTED_GO", selectedGo)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", hashBytes(selectedData))
	t.Setenv("GO2GS_SELECTED_GOROOT", root)
	loads := 0
	packageLoadTestHook = func(string) { loads++ }
	t.Cleanup(func() { packageLoadTestHook = nil })
	profile := testProfile()
	profile.RequestedGoVersion = claimedVersion
	if _, _, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile); err == nil ||
		!strings.Contains(err.Error(), "canonical Go version labels differ") {
		t.Fatalf("cmd/go/helper semantic mismatch was accepted: %v", err)
	}
	if loads != 0 {
		t.Fatalf("semantic mismatch reached packages.Load %d times", loads)
	}

	requireExecutableNamespaceTest(t)
	binary := buildGo2gsBinary(t)
	out, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "analyze",
		"--source", copyFixture(t, "complete"),
		"--profile", writeTestProfile(t, profile),
		"--out", out)
	command.Env = replaceEnvironment(os.Environ(), "PATH", filepath.Join(root, "bin"))
	output, runErr := command.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(runErr, &exitErr) || exitErr.ExitCode() != 2 ||
		!strings.Contains(string(output), "canonical Go version labels differ") {
		t.Fatalf("public semantic mismatch should exit 2: %v\n%s", runErr, output)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if _, err := os.Lstat(filepath.Join(out, name)); !os.IsNotExist(err) {
			t.Fatalf("semantic mismatch wrote %s: %v", name, err)
		}
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
