// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly || solaris

package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

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
		return nil
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
		return nil
	}
	err = unix.Unlinkat(parentFD, filepath.Base(tombstone), unix.AT_REMOVEDIR)
	if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTEMPTY) {
		return nil
	}
	return err
}

func removeDirectoryContents(directory *os.File) error {
	entries, err := directory.ReadDir(-1)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	fd := int(directory.Fd())
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
			if err := unix.Unlinkat(fd, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
				return err
			}
			continue
		}
		childFD, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		child := os.NewFile(uintptr(childFD), name)
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
