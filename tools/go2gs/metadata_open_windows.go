// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const windowsMetadataShare = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE

func openMetadataFile(path string) (*os.File, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	return openAbsoluteWindowsMetadataPath(absolute, false)
}

func openRootedMetadataFile(root, relative string) (*os.File, error) {
	if !filepath.IsAbs(root) || filepath.IsAbs(relative) || filepath.VolumeName(relative) != "" {
		return nil, errors.New("rooted metadata path must use an absolute root and relative path")
	}
	components, err := windowsRelativeComponents(relative)
	if err != nil {
		return nil, err
	}
	directory, err := openAbsoluteWindowsMetadataPath(root, true)
	if err != nil {
		return nil, err
	}
	return openWindowsMetadataComponents(directory, components, false, filepath.Join(root, relative))
}

func walkRootedMetadataTree(root string, visit func(string, os.DirEntry) (bool, error)) error {
	directory, err := openAbsoluteWindowsMetadataPath(root, true)
	if err != nil {
		return err
	}
	return walkRootedWindowsMetadataDirectory(directory, root, "", visit)
}

func walkRootedWindowsMetadataDirectory(directory *os.File, root, relative string, visit func(string, os.DirEntry) (bool, error)) error {
	defer directory.Close()
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
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
		child, err := openWindowsMetadataChild(
			windows.Handle(directory.Fd()), entry.Name(), true, filepath.Join(root, childRelative))
		if err != nil {
			return err
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
		if err := walkRootedWindowsMetadataDirectory(child, root, childRelative, visit); err != nil {
			return err
		}
	}
	return nil
}

func readRootedMetadataDirectory(path string) ([]os.DirEntry, error) {
	if rootedDirectoryBeforeOpenHook != nil {
		rootedDirectoryBeforeOpenHook(path)
	}
	directory, err := openAbsoluteWindowsMetadataPath(path, true)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}

func openAbsoluteWindowsMetadataPath(path string, directory bool) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("rooted metadata path must be absolute")
	}
	clean := filepath.Clean(path)
	volume := filepath.VolumeName(clean)
	ntRoot, err := windowsMetadataVolumeRoot(volume)
	if err != nil {
		return nil, err
	}
	root, err := openWindowsMetadataNTPath(ntRoot, true, volume+string(filepath.Separator))
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(volume+string(filepath.Separator), clean)
	if err != nil {
		_ = root.Close()
		return nil, err
	}
	if relative == "." {
		if !directory {
			_ = root.Close()
			return nil, errors.New("metadata file path names a volume root")
		}
		return root, nil
	}
	components, err := windowsRelativeComponents(relative)
	if err != nil {
		_ = root.Close()
		return nil, err
	}
	return openWindowsMetadataComponents(root, components, directory, clean)
}

func windowsMetadataVolumeRoot(volume string) (string, error) {
	switch {
	case len(volume) == 2 && volume[1] == ':':
		return `\??\` + volume + `\`, nil
	case strings.HasPrefix(volume, `\\`) &&
		!strings.HasPrefix(volume, `\\?\`) &&
		!strings.HasPrefix(volume, `\\.\`):
		return `\??\UNC\` + strings.TrimPrefix(volume, `\\`) + `\`, nil
	default:
		return "", errors.New("unsupported Windows metadata volume path")
	}
}

func windowsRelativeComponents(relative string) ([]string, error) {
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || filepath.IsAbs(clean) || filepath.VolumeName(clean) != "" ||
		strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return nil, errors.New("rooted metadata path escapes root")
	}
	return strings.Split(clean, string(filepath.Separator)), nil
}

func openWindowsMetadataComponents(parent *os.File, components []string, directory bool, displayPath string) (*os.File, error) {
	current := parent
	for index, component := range components {
		last := index == len(components)-1
		next, err := openWindowsMetadataChild(
			windows.Handle(current.Fd()), component, !last || directory, displayPath)
		_ = current.Close()
		if err != nil {
			return nil, err
		}
		current = next
	}
	return current, nil
}

func openWindowsMetadataNTPath(path string, directory bool, displayPath string) (*os.File, error) {
	name, err := windows.NewNTUnicodeString(path)
	if err != nil {
		return nil, err
	}
	return openWindowsMetadataHandle(0, name, directory, displayPath)
}

func openWindowsMetadataChild(parent windows.Handle, name string, directory bool, displayPath string) (*os.File, error) {
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return nil, err
	}
	return openWindowsMetadataHandle(parent, objectName, directory, displayPath)
}

func openWindowsMetadataHandle(parent windows.Handle, name *windows.NTUnicodeString, directory bool, displayPath string) (*os.File, error) {
	attributes := windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: parent,
		ObjectName:    name,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	options := uint32(windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if directory {
		options |= windows.FILE_DIRECTORY_FILE
	} else {
		options |= windows.FILE_NON_DIRECTORY_FILE
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	if err := windows.NtCreateFile(
		&handle,
		windows.FILE_GENERIC_READ,
		&attributes,
		&status,
		nil,
		0,
		windowsMetadataShare,
		windows.FILE_OPEN,
		options,
		0,
		0,
	); err != nil {
		if status, ok := err.(windows.NTStatus); ok {
			return nil, status.Errno()
		}
		return nil, err
	}
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("rooted metadata path contains a reparse point")
	}
	isDirectory := information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	if isDirectory != directory {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("rooted metadata path has unexpected file type")
	}
	file := os.NewFile(uintptr(handle), displayPath)
	if file == nil {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("open rooted metadata handle")
	}
	return file, nil
}
