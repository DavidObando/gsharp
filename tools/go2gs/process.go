// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
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
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdin = nil
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return processResult{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return processResult{}, err
	}
	if err := cmd.Start(); err != nil {
		return processResult{}, err
	}

	var outBuf, errBuf boundedBuffer
	outBuf.limit = maxOutput
	errBuf.limit = maxOutput
	var wg sync.WaitGroup
	var outErr, errErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, outErr = io.Copy(&outBuf, stdout)
	}()
	go func() {
		defer wg.Done()
		_, errErr = io.Copy(&errBuf, stderr)
	}()
	waitErr := cmd.Wait()
	wg.Wait()
	if outErr != nil || errErr != nil {
		return processResult{}, errors.Join(outErr, errErr)
	}
	if ctx.Err() != nil {
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

func sanitizedEnvironment(profile Profile, cacheRoot, goroot string) []string {
	values := map[string]string{
		"PATH":             os.Getenv("PATH"),
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
		"GOOS":             profile.GOOS,
		"GOARCH":           profile.GOARCH,
		"CGO_ENABLED":      boolString(profile.CGOEnabled),
		"GOEXPERIMENT":     profile.GOEXPERIMENT,
		"GOROOT":           goroot,
	}
	flags := append([]string{}, profile.GOFLAGS...)
	flags = append(flags, "-mod="+profile.ModuleMode)
	values["GOFLAGS"] = joinArgs(flags)
	values["GODEBUG"] = joinMap(profile.GODEBUG)
	for _, feature := range profile.ArchitectureFeatures {
		values[architectureVariable(profile.GOARCH)] = appendCSV(values[architectureVariable(profile.GOARCH)], feature)
	}
	return canonicalEnv(values)
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
