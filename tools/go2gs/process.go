// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type processResult struct {
	ExitCode        int
	Stdout          string
	Stderr          string
	StdoutTruncated bool
	StderrTruncated bool
}

func runProcess(parent context.Context, timeout time.Duration, maxOutput int, dir, executable string, args, env []string) (processResult, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.Command(executable, args...)
	if err := configureProcessTree(cmd); err != nil {
		return processResult{}, fmt.Errorf("secure process isolation for %q: %w", executable, err)
	}
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdin = nil
	var outBuf, errBuf boundedBuffer
	outBuf.limit = maxOutput
	errBuf.limit = maxOutput
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Start(); err != nil {
		return processResult{}, err
	}
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	var waitErr error
	select {
	case waitErr = <-wait:
		if ctx.Err() != nil {
			if err := terminateProcessTree(cmd.Process); err != nil {
				return processResult{}, fmt.Errorf("terminate process tree for %q: %w", executable, err)
			}
			return processResult{}, fmt.Errorf("process %q timed out or was cancelled: %w", executable, ctx.Err())
		}
	case <-ctx.Done():
		killErr := terminateProcessTree(cmd.Process)
		waitErr = <-wait
		if killErr != nil {
			return processResult{}, fmt.Errorf("terminate process tree for %q: %w", executable, killErr)
		}
		return processResult{}, fmt.Errorf("process %q timed out or was cancelled: %w", executable, ctx.Err())
	}
	result := processResult{
		ExitCode:        cmd.ProcessState.ExitCode(),
		Stdout:          outBuf.String(),
		Stderr:          errBuf.String(),
		StdoutTruncated: outBuf.truncated,
		StderrTruncated: errBuf.truncated,
	}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(waitErr, &exitErr) {
			return result, waitErr
		}
	}
	return result, nil
}

type boundedBuffer struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	original := len(data)
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		b.truncated = true
		return original, nil
	}
	if len(data) > remaining {
		data = data[:remaining]
		b.truncated = true
	}
	_, err := b.buf.Write(data)
	return original, err
}

func (b *boundedBuffer) String() string { return b.buf.String() }

func bootstrapEnvironment(cacheRoot, executable string) []string {
	return canonicalEnv(map[string]string{
		"PATH":        selectedPath(executable),
		"HOME":        cacheRoot,
		"TMPDIR":      cacheRoot,
		"GOTOOLCHAIN": "local",
		"GOPROXY":     "off",
		"GOSUMDB":     "off",
		"GONOSUMDB":   "*",
		"GOPRIVATE":   "",
		"GONOPROXY":   "*",
		"GOWORK":      "off",
		"PKG_CONFIG":  unavailableToolPath(cacheRoot, "pkg-config"),
	})
}

func sanitizedEnvironment(profile Profile, cacheRoot, goroot, executable, cCompiler string) ([]string, error) {
	if err := validateGOFLAGS(profile.GOFLAGS); err != nil {
		return nil, err
	}
	if err := validateGODEBUG(profile.GODEBUG); err != nil {
		return nil, err
	}
	values := map[string]string{
		"PATH":             selectedPath(executable),
		"HOME":             cacheRoot,
		"TMPDIR":           cacheRoot,
		"GOCACHE":          cacheRoot + string(os.PathSeparator) + "build-cache",
		"GOMODCACHE":       cacheRoot + string(os.PathSeparator) + "module-cache",
		"GOTOOLCHAIN":      "local",
		"GOPROXY":          "off",
		"GOSUMDB":          "off",
		"GONOSUMDB":        "*",
		"GOPRIVATE":        "",
		"GONOPROXY":        "*",
		"GOWORK":           "off",
		"GOPACKAGESDRIVER": "off",
		"PKG_CONFIG":       unavailableToolPath(cacheRoot, "pkg-config"),
		"GOOS":             profile.GOOS,
		"GOARCH":           profile.GOARCH,
		"CGO_ENABLED":      boolString(profile.CGOEnabled),
		"GOEXPERIMENT":     profile.GOEXPERIMENT,
		"GOROOT":           goroot,
	}
	if cCompiler != "" {
		values["CC"] = cCompiler
	}
	flags := append([]string{}, profile.GOFLAGS...)
	flags = append(flags, "-mod="+profile.ModuleMode)
	values["GOFLAGS"] = joinArgs(flags)
	values["GODEBUG"] = joinMap(profile.GODEBUG)
	for _, feature := range profile.ArchitectureFeatures {
		values[architectureVariable(profile.GOARCH)] = appendCSV(values[architectureVariable(profile.GOARCH)], feature)
	}
	return canonicalEnv(values), nil
}

func unavailableToolPath(cacheRoot, name string) string {
	return filepath.Join(cacheRoot, "blocked-tools", name)
}

func selectedPath(executable string) string {
	return filepath.Dir(executable)
}

func boolString(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func joinArgs(values []string) string {
	var buf bytes.Buffer
	for i, value := range values {
		if i > 0 {
			buf.WriteByte(' ')
		}
		buf.WriteString(value)
	}
	return buf.String()
}

func joinMap(values map[string]string) string {
	entries := canonicalEnv(values)
	var buf bytes.Buffer
	for i, entry := range entries {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(entry)
	}
	return buf.String()
}

func appendCSV(current, value string) string {
	if current == "" {
		return value
	}
	return current + "," + value
}

func architectureVariable(goarch string) string {
	switch goarch {
	case "amd64":
		return "GOAMD64"
	case "arm64":
		return "GOARM64"
	case "386":
		return "GO386"
	case "mips", "mipsle":
		return "GOMIPS"
	case "mips64", "mips64le":
		return "GOMIPS64"
	case "ppc64", "ppc64le":
		return "GOPPC64"
	case "riscv64":
		return "GORISCV64"
	case "wasm":
		return "GOWASM"
	default:
		return "GOARCH_FEATURES"
	}
}
