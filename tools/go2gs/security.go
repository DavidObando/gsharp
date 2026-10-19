// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var outputCreateBeforeComponentHook func(string)

func secureRoot(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("must be a directory")
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return filepath.Clean(resolved), nil
}

func normalizeSystemPathAliases(path string) string {
	if runtime.GOOS == "darwin" {
		for _, alias := range []string{"/tmp", "/var"} {
			if normalized, ok := normalizePathAlias(alias, path); ok {
				return normalized
			}
		}
	}
	temp, err := filepath.Abs(os.TempDir())
	if err != nil {
		return path
	}
	normalized, ok := normalizePathAlias(temp, path)
	if !ok {
		return path
	}
	return normalized
}

func normalizePathAlias(alias, path string) (string, bool) {
	resolved, err := filepath.EvalSymlinks(alias)
	if err != nil || resolved == alias {
		return "", false
	}
	relative, err := filepath.Rel(alias, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		return "", false
	}
	return filepath.Join(resolved, relative), true
}

func validateOutputSourceRoots(sourceRoot, outRoot string) error {
	resolvedSource, err := secureRoot(sourceRoot)
	if err != nil {
		return err
	}
	info, err := os.Stat(outRoot)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("output root must be a directory")
	}
	resolvedOutput, err := secureRoot(outRoot)
	if err != nil {
		return err
	}
	return validateResolvedOutputSourceRoots(resolvedSource, resolvedOutput)
}

func validateResolvedOutputSourceRoots(sourceRoot, outRoot string) error {
	if lexicallyWithin(outRoot, sourceRoot) {
		return errors.New("output root must not equal or contain the source root")
	}
	return nil
}

func rejectSymlinkPath(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	current := absolute
	for {
		info, err := os.Lstat(current)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink path component is not allowed: %s", current)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}

func pathWithin(root, path string) (string, error) {
	rootResolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	pathResolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(rootResolved, pathResolved)
	if err != nil {
		return "", err
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("path escapes declared root: %s", path)
	}
	return slash(relative), nil
}

func safeJoin(root string, relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", errors.New("absolute paths are not allowed")
	}
	clean := filepath.Clean(relative)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("path traversal is not allowed")
	}
	path := filepath.Join(root, clean)
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes root")
	}
	return path, nil
}

func rejectSymlinkBelow(root, path string) error {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("path escapes root")
	}
	current := root
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink path component is not allowed: %s", current)
		}
	}
	return nil
}
