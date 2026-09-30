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
var outputAtomicExchangeBetween = atomicExchangeBetween

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
	output.removalOwned = map[string]os.FileInfo{}
	return nil
}

func closeOutputRemoval(output *boundOutputRoot) error {
	if output.removalRoot == nil {
		return nil
	}
	var result error
	if !output.removalUnknown {
		if err := removeOwnedQuarantineEntries(output); err != nil {
			output.removalUnknown = true
			result = errors.Join(result, err)
		}
	}
	if output.removalUnknown {
		if output.removalDirectory != nil {
			result = errors.Join(result, output.removalDirectory.Close())
			output.removalDirectory = nil
		}
		result = errors.Join(result, output.removalRoot.Close())
		output.removalRoot = nil
		preserved, err := uniqueOutputName(".go2gs-preserved-")
		if err == nil {
			err = outputAtomicRenameNoReplace(
				int(output.operationRoot.Fd()), output.removalName,
				int(output.operationRoot.Fd()), preserved,
			)
		}
		if err != nil {
			preserved = output.removalName
			result = errors.Join(result, err)
		}
		result = errors.Join(result, errors.New("unexpected output entry preserved for inspection: "+preserved))
		output.removalName = ""
		output.removalInfo = nil
		output.removalUnknown = false
		output.removalOwned = nil
		return result
	}
	if output.removalDirectory != nil {
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
	output.removalOwned = nil
	return result
}

func removeOwnedQuarantineEntries(output *boundOutputRoot) error {
	directory, err := output.removalRoot.Open(".")
	if err != nil {
		return err
	}
	entries, err := directory.ReadDir(-1)
	closeErr := directory.Close()
	if err != nil {
		return errors.Join(err, closeErr)
	}
	if closeErr != nil {
		return closeErr
	}
	if len(entries) != len(output.removalOwned) {
		return errors.New("output quarantine contains an unexpected entry")
	}
	for _, entry := range entries {
		expected := output.removalOwned[entry.Name()]
		if expected == nil {
			return errors.New("output quarantine contains an unowned entry")
		}
		current, err := output.removalRoot.Lstat(entry.Name())
		if err != nil || !os.SameFile(expected, current) {
			return errors.Join(errors.New("owned output quarantine entry changed"), err)
		}
		if current.IsDir() {
			child, err := output.removalRoot.OpenRoot(entry.Name())
			if err != nil {
				return err
			}
			childDirectory, err := child.Open(".")
			if err != nil {
				_ = child.Close()
				return err
			}
			children, readErr := childDirectory.ReadDir(-1)
			err = errors.Join(readErr, childDirectory.Close(), child.Close())
			if err != nil {
				return err
			}
			if len(children) != 0 {
				return errors.New("owned output quarantine directory contains an unexpected entry")
			}
		}
	}
	for name := range output.removalOwned {
		if err := output.removalRoot.Remove(name); err != nil {
			return err
		}
	}
	directory, err = output.removalRoot.Open(".")
	if err != nil {
		return err
	}
	remaining, readErr := directory.ReadDir(-1)
	err = errors.Join(readErr, directory.Close())
	if err != nil {
		return err
	}
	if len(remaining) != 0 {
		return errors.New("output quarantine was not empty after owned cleanup")
	}
	return nil
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
		output.removalOwned[quarantine] = moved
		return true, nil
	}

	wasUnknown := output.removalUnknown
	output.removalUnknown = true
	if outputAfterDestructiveMoveHook != nil {
		outputAfterDestructiveMoveHook(name)
	}
	current, currentErr := output.root.Lstat(name)
	if os.IsNotExist(currentErr) {
		if err := outputAtomicRenameNoReplace(
			int(output.removalDirectory.Fd()), quarantine, parentFD, name,
		); err != nil {
			return false, errors.Join(errors.New("output replacement could not be restored"), err)
		}
		output.removalUnknown = wasUnknown
	} else if currentErr != nil {
		return false, currentErr
	} else {
		if err := outputAtomicExchangeBetween(
			parentFD, name, int(output.removalDirectory.Fd()), quarantine,
		); err != nil {
			return false, errors.Join(errors.New("output replacement could not be atomically restored"), err)
		}
		output.removalUnknown = true
		preserved, err := output.removalRoot.Lstat(quarantine)
		if err != nil || !os.SameFile(current, preserved) {
			return false, errors.Join(errors.New("second output replacement was not preserved"), err)
		}
	}
	restored, err := output.root.Lstat(name)
	if err != nil {
		return false, err
	}
	if !os.SameFile(moved, restored) {
		return false, errors.New("output replacement identity changed during restoration")
	}
	if output.removalUnknown {
		return false, errors.New("second output replacement preserved in private quarantine")
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
