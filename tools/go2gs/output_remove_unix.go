// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux || darwin

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

var outputAtomicRenameNoReplace = atomicRenameNoReplace

func initializeOutputRemoval(output *boundOutputRoot) error {
	name, err := uniqueOutputName(".go2gs-quarantine-")
	if err != nil {
		return err
	}
	if err := output.root.Mkdir(name, 0o700); err != nil {
		return err
	}
	root, err := output.root.OpenRoot(name)
	if err != nil {
		_ = output.root.Remove(name)
		return err
	}
	directory, err := root.Open(".")
	if err != nil {
		_ = root.Close()
		_ = output.root.Remove(name)
		return err
	}
	info, err := directory.Stat()
	if err != nil {
		_ = directory.Close()
		_ = root.Close()
		_ = output.root.Remove(name)
		return err
	}
	output.removalName = name
	output.removalRoot = root
	output.removalDirectory = directory
	output.removalInfo = info
	return nil
}

func closeOutputRemoval(output *boundOutputRoot) error {
	if output.removalRoot == nil {
		return nil
	}
	var result error
	if output.removalDirectory != nil {
		result = errors.Join(result, removeDirectoryContents(output.removalDirectory))
		result = errors.Join(result, output.removalDirectory.Close())
		output.removalDirectory = nil
	}
	result = errors.Join(result, output.removalRoot.Close())
	output.removalRoot = nil
	if result == nil {
		current, err := output.root.Lstat(output.removalName)
		if err != nil {
			result = errors.Join(result, err)
		} else if !os.SameFile(output.removalInfo, current) {
			result = errors.Join(result, errors.New("output quarantine directory identity changed"))
		} else {
			result = errors.Join(result, output.root.Remove(output.removalName))
		}
	}
	output.removalName = ""
	output.removalInfo = nil
	return result
}

func removeOutputEntryIfSame(output *boundOutputRoot, name string, expected os.FileInfo) (bool, error) {
	if expected == nil || filepath.Base(name) != name ||
		(!expected.Mode().IsRegular() && !expected.IsDir()) {
		return false, errors.New("unsupported output entry for identity-bound removal")
	}
	if output.removalRoot == nil || output.removalDirectory == nil {
		return false, errors.New("output quarantine is unavailable")
	}
	parentFD := int(output.operationRoot.Fd())
	flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	if expected.IsDir() {
		flags |= unix.O_DIRECTORY
	}
	fd, err := unix.Openat(parentFD, name, flags, 0)
	if errors.Is(err, unix.ENOENT) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	held := os.NewFile(uintptr(fd), name)
	defer held.Close()
	heldInfo, err := held.Stat()
	if err != nil {
		return false, err
	}
	if !os.SameFile(expected, heldInfo) {
		return false, nil
	}

	quarantine, err := uniqueOutputName(filepath.Base(name) + "-")
	if err != nil {
		return false, err
	}
	if outputBeforeDestructiveHook != nil {
		outputBeforeDestructiveHook(name)
	}
	if err := outputAtomicRenameNoReplace(
		parentFD, name, int(output.removalDirectory.Fd()), quarantine,
	); err != nil {
		return false, err
	}
	moved, err := output.removalRoot.Lstat(quarantine)
	if err != nil {
		return false, err
	}
	if os.SameFile(expected, moved) {
		return true, nil
	}

	if err := outputAtomicRenameNoReplace(
		int(output.removalDirectory.Fd()), quarantine, parentFD, name,
	); err != nil {
		return false, errors.Join(errors.New("output replacement could not be restored"), err)
	}
	restored, err := output.root.Lstat(name)
	if err != nil {
		return false, err
	}
	if !os.SameFile(moved, restored) {
		return false, errors.New("output replacement identity changed during restoration")
	}
	return false, nil
}

func uniqueOutputName(prefix string) (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(value[:]), nil
}
