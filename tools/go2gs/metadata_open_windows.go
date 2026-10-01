// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const windowsMetadataShare = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
const windowsFileAddSubdirectory = 0x00000004

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
	budget := newMetadataTraversalBudget()
	return walkRootedMetadataTreeContext(context.Background(), root, &budget, visit)
}

func walkRootedMetadataTreeContext(ctx context.Context, root string, budget *metadataTraversalBudget, visit func(string, os.DirEntry) (bool, error)) error {
	directory, err := openAbsoluteWindowsMetadataPath(root, true)
	if err != nil {
		return err
	}
	return walkRootedWindowsMetadataDirectory(ctx, directory, root, "", budget, visit)
}

func walkRootedWindowsMetadataDirectory(ctx context.Context, directory *os.File, root, relative string, budget *metadataTraversalBudget, visit func(string, os.DirEntry) (bool, error)) error {
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
		if err := walkRootedWindowsMetadataDirectory(ctx, child, root, childRelative, budget, visit); err != nil {
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
	directory, err := openAbsoluteWindowsMetadataPath(path, true)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	budget := newMetadataTraversalBudget()
	return readMetadataDirectoryEntriesContext(ctx, directory, &budget)
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

func ensureOutputRoot(path string, _ os.FileMode) error {
	if !filepath.IsAbs(path) {
		return errors.New("output root must be absolute")
	}
	clean := filepath.Clean(path)
	volume := filepath.VolumeName(clean)
	ntRoot, err := windowsMetadataVolumeRoot(volume)
	if err != nil {
		return err
	}
	rootName, err := windows.NewNTUnicodeString(ntRoot)
	if err != nil {
		return err
	}
	current, err := openWindowsOutputDirectory(
		0, rootName, windows.FILE_OPEN, windows.FILE_GENERIC_READ, volume+string(filepath.Separator))
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(volume+string(filepath.Separator), clean)
	if err != nil {
		_ = current.Close()
		return err
	}
	if relative == "." {
		return current.Close()
	}
	components, err := windowsRelativeComponents(relative)
	if err != nil {
		_ = current.Close()
		return err
	}
	display := volume + string(filepath.Separator)
	currentCanCreate := false
	for _, component := range components {
		display = filepath.Join(display, component)
		if outputCreateBeforeComponentHook != nil {
			outputCreateBeforeComponentHook(display)
		}
		name, nameErr := windows.NewNTUnicodeString(component)
		if nameErr != nil {
			_ = current.Close()
			return nameErr
		}
		next, openErr := openWindowsOutputDirectory(
			windows.Handle(current.Fd()), name, windows.FILE_OPEN, windows.FILE_GENERIC_READ, display)
		created := false
		if os.IsNotExist(openErr) {
			if !currentCanCreate {
				parentPath := filepath.Dir(display)
				heldInfo, statErr := current.Stat()
				if statErr != nil {
					_ = current.Close()
					return statErr
				}
				_ = current.Close()
				current, openErr = openWindowsOutputPathWithAccess(
					parentPath, windows.FILE_GENERIC_READ|windowsFileAddSubdirectory)
				if openErr != nil {
					return openErr
				}
				reopenedInfo, statErr := current.Stat()
				if statErr != nil || !os.SameFile(heldInfo, reopenedInfo) {
					_ = current.Close()
					if statErr != nil {
						return statErr
					}
					return errors.New("output parent changed while acquiring create access")
				}
			}
			next, openErr = openWindowsOutputDirectory(
				windows.Handle(current.Fd()), name, windows.FILE_OPEN_IF,
				windows.FILE_GENERIC_READ|windowsFileAddSubdirectory, display)
			created = openErr == nil
		}
		_ = current.Close()
		if openErr != nil {
			return openErr
		}
		current = next
		currentCanCreate = created
	}
	return current.Close()
}

func openWindowsOutputPathWithAccess(path string, finalAccess uint32) (*os.File, error) {
	clean := filepath.Clean(path)
	volume := filepath.VolumeName(clean)
	ntRoot, err := windowsMetadataVolumeRoot(volume)
	if err != nil {
		return nil, err
	}
	rootName, err := windows.NewNTUnicodeString(ntRoot)
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(volume+string(filepath.Separator), clean)
	if err != nil {
		return nil, err
	}
	rootAccess := uint32(windows.FILE_GENERIC_READ)
	if relative == "." {
		rootAccess = finalAccess
	}
	current, err := openWindowsOutputDirectory(
		0, rootName, windows.FILE_OPEN, rootAccess, volume+string(filepath.Separator))
	if err != nil || relative == "." {
		return current, err
	}
	components, err := windowsRelativeComponents(relative)
	if err != nil {
		_ = current.Close()
		return nil, err
	}
	display := volume + string(filepath.Separator)
	for index, component := range components {
		display = filepath.Join(display, component)
		name, nameErr := windows.NewNTUnicodeString(component)
		if nameErr != nil {
			_ = current.Close()
			return nil, nameErr
		}
		access := uint32(windows.FILE_GENERIC_READ)
		if index == len(components)-1 {
			access = finalAccess
		}
		next, openErr := openWindowsOutputDirectory(
			windows.Handle(current.Fd()), name, windows.FILE_OPEN, access, display)
		_ = current.Close()
		if openErr != nil {
			return nil, openErr
		}
		current = next
	}
	return current, nil
}

func openWindowsOutputDirectory(parent windows.Handle, name *windows.NTUnicodeString, disposition, access uint32, displayPath string) (*os.File, error) {
	attributes := windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: parent,
		ObjectName:    name,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err := windows.NtCreateFile(
		&handle,
		access,
		&attributes,
		&status,
		nil,
		windows.FILE_ATTRIBUTE_DIRECTORY,
		windowsMetadataShare,
		disposition,
		windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
		0,
		0,
	)
	if err != nil {
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
	if information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("output path contains a reparse point or non-directory component")
	}
	file := os.NewFile(uintptr(handle), displayPath)
	if file == nil {
		_ = windows.CloseHandle(handle)
		return nil, errors.New("open output directory handle")
	}
	return file, nil
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
