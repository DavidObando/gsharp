// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

func selectedPackageCgoRequirements(pkg *packages.Package) (importsC, usesPkgConfig bool, err error) {
	files := append([]string{}, pkg.GoFiles...)
	files = append(files, pkg.CompiledGoFiles...)
	for _, path := range uniqueSorted(files) {
		file, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly|parser.ParseComments)
		if parseErr != nil {
			return false, false, fmt.Errorf("inspect selected package CGo imports in %s: %w", filepath.Base(path), parseErr)
		}
		fileImportsC := false
		for _, declaration := range file.Decls {
			group, ok := declaration.(*ast.GenDecl)
			if !ok || group.Tok != token.IMPORT {
				continue
			}
			for _, raw := range group.Specs {
				spec := raw.(*ast.ImportSpec)
				value, unquoteErr := strconv.Unquote(spec.Path.Value)
				if unquoteErr != nil || value != "C" {
					continue
				}
				fileImportsC = true
				importsC = true
				if cgoCommentUsesPkgConfig(group.Doc) || cgoCommentUsesPkgConfig(spec.Doc) {
					usesPkgConfig = true
				}
			}
		}
		if fileImportsC && usesPkgConfig {
			continue
		}
	}
	return importsC, usesPkgConfig, nil
}

func cgoCommentUsesPkgConfig(group *ast.CommentGroup) bool {
	if group == nil {
		return false
	}
	for _, comment := range group.List {
		for _, line := range strings.Split(comment.Text, "\n") {
			line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "/*"))
			if strings.HasPrefix(line, "#cgo ") && strings.Contains(line, "pkg-config:") {
				return true
			}
		}
	}
	return false
}
