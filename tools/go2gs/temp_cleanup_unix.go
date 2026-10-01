// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux || darwin

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

var tempCleanupOpenFile = unix.Openat

func cleanupOwnedTempDir(directory ownedTempDir, beforeRename func(), afterTombstoneIdentity func(string)) error {
	parent := filepath.Dir(directory.path)
	parentFD, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)

	reservation, err := os.CreateTemp(parent, ".go2gs-cleanup-*")
	if err != nil {
		return err
	}
	tombstone := reservation.Name()
	if err := reservation.Close(); err != nil {
		_ = os.Remove(tombstone)
		return err
	}
	if err := os.Remove(tombstone); err != nil {
		return err
	}
	if beforeRename != nil {
		beforeRename()
	}
	if err := unix.Renameat(parentFD, filepath.Base(directory.path), parentFD, filepath.Base(tombstone)); err != nil {
		return err
	}
	fd, err := unix.Openat(parentFD, filepath.Base(tombstone), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		restoreRenamedDirectory(parentFD, tombstone, directory.path)
		return err
	}
	file := os.NewFile(uintptr(fd), tombstone)
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.IsDir() || !os.SameFile(directory.info, openedInfo) {
		_ = file.Close()
		restoreRenamedDirectory(parentFD, tombstone, directory.path)
		return errors.New("owned temporary directory changed during cleanup")
	}
	var opened unix.Stat_t
	if err := unix.Fstat(fd, &opened); err != nil {
		_ = file.Close()
		return err
	}
	if afterTombstoneIdentity != nil {
		afterTombstoneIdentity(tombstone)
	}
	if err := removeDirectoryContents(file); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	var current unix.Stat_t
	if err := unix.Fstatat(parentFD, filepath.Base(tombstone), &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	if !sameUnixFile(current, opened) {
		return errors.New("temporary cleanup tombstone was replaced")
	}
	err = unix.Unlinkat(parentFD, filepath.Base(tombstone), unix.AT_REMOVEDIR)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if errors.Is(err, unix.ENOTEMPTY) {
		return errors.New("owned temporary directory remains non-empty after cleanup")
	}
	return err
}

func removeDirectoryContents(directory *os.File) error {
	fd := int(directory.Fd())
	for {
		readerFD, err := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		reader := os.NewFile(uintptr(readerFD), directory.Name())
		entries, readErr := reader.ReadDir(metadataReadDirBatchSize)
		closeErr := reader.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if len(entries) == 0 {
			return nil
		}
		for _, entry := range entries {
			name := entry.Name()
			if name == "." || name == ".." || filepath.Base(name) != name {
				return errors.New("unsafe directory entry")
			}
			var before unix.Stat_t
			if err := unix.Fstatat(fd, name, &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				if errors.Is(err, unix.ENOENT) {
					continue
				}
				return err
			}
			if before.Mode&unix.S_IFMT != unix.S_IFDIR {
				if before.Mode&unix.S_IFMT != unix.S_IFREG {
					return errors.New("owned temporary directory remains non-empty after cleanup")
				}
				if err := quarantineAndRemoveFile(fd, directory.Name(), name, before); err != nil {
					return err
				}
				continue
			}
			childFD, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return err
			}
			child := os.NewFile(uintptr(childFD), filepath.Join(directory.Name(), name))
			var opened unix.Stat_t
			if err := unix.Fstat(childFD, &opened); err != nil || !sameUnixFile(before, opened) {
				_ = child.Close()
				return errors.New("temporary directory entry changed while opening")
			}
			if err := removeDirectoryContents(child); err != nil {
				_ = child.Close()
				return err
			}
			if err := child.Close(); err != nil {
				return err
			}
			var current unix.Stat_t
			if err := unix.Fstatat(fd, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				if errors.Is(err, unix.ENOENT) {
					continue
				}
				return err
			}
			if !sameUnixFile(before, current) {
				return errors.New("temporary directory entry changed during cleanup")
			}
			if err := unix.Unlinkat(fd, name, unix.AT_REMOVEDIR); err != nil && !errors.Is(err, unix.ENOENT) {
				return err
			}
		}
	}
}

func quarantineAndRemoveFile(parentFD int, directoryPath, name string, before unix.Stat_t) error {
	if before.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil
	}
	originalFD, err := tempCleanupOpenFile(parentFD, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ELOOP) {
			return nil
		}
		return fmt.Errorf("open temporary file for quarantine: %w", err)
	}
	defer unix.Close(originalFD)
	var opened unix.Stat_t
	if err := unix.Fstat(originalFD, &opened); err != nil || !sameUnixFile(before, opened) {
		return nil
	}
	placeholder, err := uniquePlaceholderName()
	if err != nil {
		return err
	}
	placeholderFD, err := unix.Openat(parentFD, placeholder, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	defer unix.Close(placeholderFD)
	var placeholderStat unix.Stat_t
	if err := unix.Fstat(placeholderFD, &placeholderStat); err != nil {
		return err
	}
	if tempCleanupPlaceholderCreatedHook != nil {
		tempCleanupPlaceholderCreatedHook(directoryPath, name, placeholder)
	}
	if err := atomicExchange(parentFD, name, placeholder); err != nil {
		return errors.Join(
			fmt.Errorf("atomically exchange temporary entry %q: %w", name, err),
			removeKnownPlaceholder(parentFD, placeholder, placeholderStat),
		)
	}
	var quarantined unix.Stat_t
	if err := unix.Fstatat(parentFD, placeholder, &quarantined, unix.AT_SYMLINK_NOFOLLOW); err != nil ||
		!sameUnixFile(opened, quarantined) {
		return errors.Join(
			errors.New("temporary entry quarantine identity changed"),
			atomicExchange(parentFD, name, placeholder),
			removeKnownPlaceholder(parentFD, placeholder, placeholderStat),
		)
	}
	if err := unix.Unlinkat(parentFD, placeholder, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	if err := removeKnownPlaceholder(parentFD, name, placeholderStat); err != nil {
		return err
	}
	return nil
}

func removeKnownPlaceholder(parentFD int, name string, expected unix.Stat_t) error {
	var current unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	if !sameUnixFile(current, expected) {
		return nil
	}
	if err := unix.Unlinkat(parentFD, name, 0); !errors.Is(err, unix.ENOENT) {
		return err
	}
	return nil
}

func restoreRenamedDirectory(parentFD int, tombstone, original string) {
	var current unix.Stat_t
	if err := unix.Fstatat(parentFD, filepath.Base(original), &current, unix.AT_SYMLINK_NOFOLLOW); errors.Is(err, unix.ENOENT) {
		_ = unix.Renameat(parentFD, filepath.Base(tombstone), parentFD, filepath.Base(original))
	}
}

func sameUnixFile(left, right unix.Stat_t) bool {
	return uint64(left.Dev) == uint64(right.Dev) && uint64(left.Ino) == uint64(right.Ino)
}

func secureTempCleanupSupported() bool {
	return true
}
