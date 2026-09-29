// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
)

const maxToolExecutableBytes int64 = 256 << 20

type capturedExecutable struct {
	name       string
	sourcePath string
	data       []byte
	sourceInfo os.FileInfo
	mode       os.FileMode
}

type executableCapsule struct {
	directory executableDirectory
	entries   []capturedExecutable
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
	data, err := readBoundedRegularFile(path, limit)
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

func createExecutableCapsule(workRoot string, entries []capturedExecutable, immutable bool) (*executableCapsule, error) {
	if len(entries) == 0 {
		return nil, errors.New("executable capsule requires at least one entry")
	}
	sorted := append([]capturedExecutable{}, entries...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].name < sorted[j].name })
	for index := range sorted {
		if !validCompilerHelperName(sorted[index].name) {
			return nil, fmt.Errorf("invalid executable capsule name %q", sorted[index].name)
		}
		if index > 0 && compilerHelperNameKey(sorted[index-1].name) == compilerHelperNameKey(sorted[index].name) {
			return nil, fmt.Errorf("executable capsule names collide: %q", sorted[index].name)
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
	capsule := &executableCapsule{directory: directory, entries: sorted}
	success := false
	defer func() {
		if !success {
			_ = capsule.close()
		}
	}()
	for _, entry := range sorted {
		if err := atomicWrite(filepath.Join(directory.writePath(), entry.name), entry.data, entry.mode); err != nil {
			return nil, fmt.Errorf("stage executable %q: %w", entry.name, err)
		}
	}
	if err := directory.seal(); err != nil {
		return nil, err
	}
	if err := capsule.verify(); err != nil {
		return nil, err
	}
	success = true
	return capsule, nil
}

func (c *executableCapsule) path(name string) string {
	return filepath.Join(c.directory.executionPath(), name)
}

func (c *executableCapsule) verify() error {
	entries, err := os.ReadDir(c.directory.executionPath())
	if err != nil {
		return err
	}
	if len(entries) != len(c.entries) {
		return errors.New("executable capsule contains unexpected entries")
	}
	for index, entry := range c.entries {
		if entries[index].Name() != entry.name {
			return errors.New("executable capsule ordering or contents changed")
		}
		sourceInfo, err := os.Lstat(entry.sourcePath)
		if err != nil || !sourceInfo.Mode().IsRegular() ||
			!os.SameFile(entry.sourceInfo, sourceInfo) || sourceInfo.Mode() != entry.sourceInfo.Mode() {
			return fmt.Errorf("executable %q source identity changed", entry.name)
		}
		sourceData, err := readBoundedRegularFile(entry.sourcePath, int64(len(entry.data)))
		if err != nil || !bytes.Equal(sourceData, entry.data) {
			return fmt.Errorf("executable %q source content changed", entry.name)
		}
		stagedPath := c.path(entry.name)
		stagedInfo, err := os.Lstat(stagedPath)
		if err != nil || !stagedInfo.Mode().IsRegular() || stagedInfo.Mode().Perm() != entry.mode {
			return fmt.Errorf("executable %q staged identity changed", entry.name)
		}
		stagedData, err := readBoundedRegularFile(stagedPath, int64(len(entry.data)))
		if err != nil || !bytes.Equal(stagedData, entry.data) {
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
