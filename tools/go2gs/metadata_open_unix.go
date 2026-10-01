// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func openMetadataFile(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func openRootedMetadataFile(root, relative string) (*os.File, error) {
	if !filepath.IsAbs(root) || filepath.IsAbs(relative) {
		return nil, errors.New("rooted metadata path must use an absolute root and relative path")
	}
	cleanRelative := filepath.Clean(relative)
	if cleanRelative == "." || cleanRelative == ".." ||
		strings.HasPrefix(cleanRelative, ".."+string(filepath.Separator)) {
		return nil, errors.New("rooted metadata path escapes root")
	}
	components := append(pathComponents(root), pathComponents(cleanRelative)...)
	if len(components) == 0 {
		return nil, errors.New("rooted metadata path is empty")
	}
	fd, err := unix.Open(string(filepath.Separator),
		unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	for index, component := range components {
		last := index == len(components)-1
		flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
		if !last {
			flags |= unix.O_DIRECTORY
		}
		next, openErr := unix.Openat(fd, component, flags, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), filepath.Join(root, cleanRelative)), nil
}

func walkRootedMetadataTree(root string, visit func(string, os.DirEntry) (bool, error)) error {
	budget := newMetadataTraversalBudget()
	return walkRootedMetadataTreeContext(context.Background(), root, &budget, visit)
}

func walkRootedMetadataTreeContext(ctx context.Context, root string, budget *metadataTraversalBudget, visit func(string, os.DirEntry) (bool, error)) error {
	fd, err := openAbsoluteMetadataDirectory(root)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(fd), root)
	if directory == nil {
		_ = unix.Close(fd)
		return errors.New("open rooted metadata directory")
	}
	return walkRootedMetadataDirectory(ctx, directory, root, "", budget, visit)
}

func walkRootedMetadataDirectory(ctx context.Context, directory *os.File, root, relative string, budget *metadataTraversalBudget, visit func(string, os.DirEntry) (bool, error)) error {
	defer directory.Close()
	entries, err := readMetadataDirectoryEntriesContext(ctx, directory, budget)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		childRelative := filepath.Join(relative, entry.Name())
		descend, err := visit(childRelative, entry)
		if err != nil {
			return err
		}
		if !descend {
			continue
		}
		if rootedWalkBeforeDescendHook != nil {
			rootedWalkBeforeDescendHook(childRelative)
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		childFD, err := unix.Openat(int(directory.Fd()), entry.Name(),
			unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		child := os.NewFile(uintptr(childFD), filepath.Join(root, childRelative))
		if child == nil {
			_ = unix.Close(childFD)
			return errors.New("open rooted metadata child directory")
		}
		childInfo, err := child.Stat()
		if err != nil {
			_ = child.Close()
			return err
		}
		if !os.SameFile(entryInfo, childInfo) {
			_ = child.Close()
			return errors.New("rooted metadata directory changed during traversal")
		}
		if err := walkRootedMetadataDirectory(ctx, child, root, childRelative, budget, visit); err != nil {
			return err
		}
	}
	return nil
}

func readRootedMetadataDirectory(path string) ([]os.DirEntry, error) {
	return readRootedMetadataDirectoryContext(context.Background(), path)
}

func readRootedMetadataDirectoryContext(ctx context.Context, path string) ([]os.DirEntry, error) {
	if rootedDirectoryBeforeOpenHook != nil {
		rootedDirectoryBeforeOpenHook(path)
	}
	fd, err := openAbsoluteMetadataDirectory(path)
	if err != nil {
		return nil, err
	}
	directory := os.NewFile(uintptr(fd), path)
	if directory == nil {
		_ = unix.Close(fd)
		return nil, errors.New("open rooted metadata directory")
	}
	defer directory.Close()
	budget := newMetadataTraversalBudget()
	return readMetadataDirectoryEntriesContext(ctx, directory, &budget)
}

func openAbsoluteMetadataDirectory(path string) (int, error) {
	if !filepath.IsAbs(path) {
		return -1, errors.New("rooted metadata directory must be absolute")
	}
	fd, err := unix.Open(string(filepath.Separator),
		unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return -1, err
	}
	for _, component := range pathComponents(path) {
		next, openErr := unix.Openat(fd, component,
			unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return -1, openErr
		}
		fd = next
	}
	return fd, nil
}

func ensureOutputRoot(path string, perm os.FileMode) error {
	if !filepath.IsAbs(path) {
		return errors.New("output root must be absolute")
	}
	fd, err := unix.Open(string(filepath.Separator),
		unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	current := string(filepath.Separator)
	for _, component := range pathComponents(path) {
		current = filepath.Join(current, component)
		if outputCreateBeforeComponentHook != nil {
			outputCreateBeforeComponentHook(current)
		}
		next, openErr := unix.Openat(fd, component,
			unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		if errors.Is(openErr, syscall.ENOENT) {
			if mkdirErr := unix.Mkdirat(fd, component, uint32(perm.Perm())); mkdirErr != nil {
				_ = unix.Close(fd)
				return mkdirErr
			}
			next, openErr = unix.Openat(fd, component,
				unix.O_RDONLY|unix.O_CLOEXEC|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		}
		_ = unix.Close(fd)
		if openErr != nil {
			return openErr
		}
		fd = next
	}
	return unix.Close(fd)
}

func pathComponents(path string) []string {
	path = strings.TrimPrefix(filepath.Clean(path), string(filepath.Separator))
	if path == "" || path == "." {
		return nil
	}
	return strings.Split(path, string(filepath.Separator))
}
