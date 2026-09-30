// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"debug/buildinfo"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
)

const maxToolExecutableBytes int64 = 256 << 20

var captureSelectedExecutableTestHook func(context.Context)

type capturedExecutable struct {
	name       string
	sourcePath string
	data       []byte
	sourceInfo os.FileInfo
	mode       os.FileMode
	goVersion  string
}

type executableCapsule struct {
	directory executableDirectory
	entries   []capturedExecutable
	immutable bool
}

type executableDirectory interface {
	writePath() string
	executionPath() string
	seal() error
	close() error
}

func selectedGoName() string {
	if runtime.GOOS == "windows" {
		return "go.exe"
	}
	return "go"
}

func captureSelectedExecutable(name, path string, expectedHash string, limit int64, allowFinalSymlink bool) (capturedExecutable, string, error) {
	return captureSelectedExecutableContext(context.Background(), name, path, expectedHash, limit, allowFinalSymlink)
}

func captureSelectedExecutableContext(ctx context.Context, name, path string, expectedHash string, limit int64, allowFinalSymlink bool) (capturedExecutable, string, error) {
	if err := ctx.Err(); err != nil {
		return capturedExecutable{}, "", err
	}
	if captureSelectedExecutableTestHook != nil {
		captureSelectedExecutableTestHook(ctx)
	}
	if err := ctx.Err(); err != nil {
		return capturedExecutable{}, "", err
	}
	if allowFinalSymlink {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return capturedExecutable{}, "", err
		}
		path = resolved
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return capturedExecutable{}, "", err
	}
	parent, err := secureRoot(filepath.Dir(path))
	if err != nil {
		return capturedExecutable{}, "", err
	}
	path = filepath.Join(parent, filepath.Base(path))
	initialInfo, err := os.Lstat(path)
	if err != nil {
		return capturedExecutable{}, "", err
	}
	if !initialInfo.Mode().IsRegular() || initialInfo.Mode().Perm()&0o111 == 0 {
		return capturedExecutable{}, "", errors.New("not a regular executable")
	}
	data, err := readBoundedRegularFileContext(ctx, path, limit)
	if err != nil {
		return capturedExecutable{}, "", err
	}
	finalInfo, err := os.Lstat(path)
	if err != nil || !os.SameFile(initialInfo, finalInfo) || finalInfo.Mode() != initialInfo.Mode() {
		return capturedExecutable{}, "", errors.New("executable changed during capture")
	}
	hash := hashBytes(data)
	if expectedHash != "" && expectedHash != hash {
		return capturedExecutable{}, "", errors.New("SHA-256 mismatch")
	}
	return capturedExecutable{
		name: name, sourcePath: path, data: data, sourceInfo: initialInfo,
		mode: initialInfo.Mode().Perm() & 0o555,
	}, hash, nil
}

func captureSelectedGo(path, expectedHash string) (capturedExecutable, string, error) {
	return captureSelectedGoContext(context.Background(), path, expectedHash)
}

func captureSelectedGoContext(ctx context.Context, path, expectedHash string) (capturedExecutable, string, error) {
	captured, hash, err := captureSelectedExecutableContext(
		ctx,
		selectedGoName(), path, expectedHash, maxToolExecutableBytes, true,
	)
	if err != nil {
		return capturedExecutable{}, "", err
	}
	if err := validateSelectedGoPlatform(captured.data); err != nil {
		return capturedExecutable{}, "", err
	}
	info, err := buildinfo.Read(bytes.NewReader(captured.data))
	if err != nil || info.Path != "cmd/go" {
		return capturedExecutable{}, "", errors.New("selected Go must be a genuine native cmd/go executable")
	}
	if info.GoVersion == "" {
		return capturedExecutable{}, "", errors.New("selected Go build metadata has no Go version")
	}
	captured.goVersion, err = normalizeOfficialGoVersion(info.GoVersion, true)
	if err != nil {
		return capturedExecutable{}, "", errors.New("selected cmd/go must self-report a canonical final-release Go version")
	}
	return captured, hash, nil
}

func createExecutableCapsule(workRoot string, entries []capturedExecutable, immutable bool) (*executableCapsule, error) {
	return createExecutableCapsuleContext(context.Background(), workRoot, entries, immutable)
}

func createExecutableCapsuleContext(ctx context.Context, workRoot string, entries []capturedExecutable, immutable bool) (*executableCapsule, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, errors.New("executable capsule requires at least one entry")
	}
	sorted := append([]capturedExecutable{}, entries...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].name < sorted[j].name })
	for index, entry := range sorted {
		if entry.name == "" || filepath.Base(entry.name) != entry.name {
			return nil, fmt.Errorf("invalid executable name %q", entry.name)
		}
		if index > 0 && sorted[index-1].name == entry.name {
			return nil, fmt.Errorf("duplicate executable name %q", entry.name)
		}
	}
	var totalBytes int64
	for _, entry := range sorted {
		if int64(len(entry.data)) > maxToolExecutableBytes || totalBytes > 8<<30-int64(len(entry.data)) {
			return nil, errors.New("executable capsule exceeds its size limit")
		}
		totalBytes += int64(len(entry.data))
	}
	path := filepath.Join(workRoot, "toolchain")
	directory, err := prepareExecutableDirectory(path, immutable, totalBytes+(1<<20))
	if err != nil {
		return nil, err
	}
	capsule := &executableCapsule{directory: directory, entries: sorted, immutable: immutable}
	success := false
	defer func() {
		if !success {
			_ = capsule.close()
		}
	}()
	for _, entry := range sorted {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := atomicWrite(filepath.Join(directory.writePath(), entry.name), entry.data, entry.mode); err != nil {
			return nil, fmt.Errorf("stage executable %q: %w", entry.name, err)
		}
	}
	if err := directory.seal(); err != nil {
		return nil, err
	}
	if err := capsule.verifyContext(ctx); err != nil {
		return nil, err
	}
	success = true
	return capsule, nil
}

func (c *executableCapsule) path(name string) string {
	return filepath.Join(c.directory.executionPath(), name)
}

func (c *executableCapsule) verify() error {
	return c.verifyContext(context.Background())
}

func (c *executableCapsule) verifyContext(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := os.ReadDir(c.directory.executionPath())
	if err != nil {
		return err
	}
	if len(entries) != len(c.entries) {
		return errors.New("executable capsule contains unexpected entries")
	}
	for index, entry := range c.entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entries[index].Name() != entry.name {
			return errors.New("executable capsule ordering or contents changed")
		}
		if !c.immutable {
			sourceInfo, err := os.Lstat(entry.sourcePath)
			if err != nil || !sourceInfo.Mode().IsRegular() ||
				!os.SameFile(entry.sourceInfo, sourceInfo) || sourceInfo.Mode() != entry.sourceInfo.Mode() {
				return fmt.Errorf("executable %q source identity changed", entry.name)
			}
			sourceData, err := readBoundedRegularFileContext(ctx, entry.sourcePath, int64(len(entry.data)))
			if err != nil {
				return fmt.Errorf("verify executable %q source content: %w", entry.name, err)
			}
			if !bytes.Equal(sourceData, entry.data) {
				return fmt.Errorf("executable %q source content changed", entry.name)
			}
		}
		stagedPath := c.path(entry.name)
		stagedInfo, err := os.Lstat(stagedPath)
		if err != nil || !stagedInfo.Mode().IsRegular() || stagedInfo.Mode().Perm() != entry.mode {
			return fmt.Errorf("executable %q staged identity changed", entry.name)
		}
		stagedData, err := readBoundedRegularFileContext(ctx, stagedPath, int64(len(entry.data)))
		if err != nil {
			return fmt.Errorf("verify executable %q staged content: %w", entry.name, err)
		}
		if !bytes.Equal(stagedData, entry.data) {
			return fmt.Errorf("executable %q staged content changed", entry.name)
		}
	}
	return nil
}

func (c *executableCapsule) close() error {
	if c == nil || c.directory == nil {
		return nil
	}
	return c.directory.close()
}
