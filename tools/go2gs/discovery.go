// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func findCgoImports(root string, maxFiles int) ([]string, error) {
	var sites []string
	count := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink is not allowed beneath source root: %s", path)
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}
		count++
		if count > maxFiles {
			return fmt.Errorf("source discovery exceeds file limit %d", maxFiles)
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		reader := bufio.NewReader(io.LimitReader(file, 1<<20))
		for {
			line, readErr := reader.ReadString('\n')
			if strings.TrimSpace(line) == `import "C"` {
				relative, err := pathWithin(root, path)
				if err != nil {
					return err
				}
				sites = append(sites, relative)
				break
			}
			if readErr != nil {
				if readErr == io.EOF {
					break
				}
				return readErr
			}
		}
		return nil
	})
	return sites, err
}
