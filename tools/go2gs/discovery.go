// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"fmt"
	"go/ast"
	"go/build"
	"go/build/constraint"
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

func selectedPackageCgoRequirements(pkg *packages.Package, profile Profile) (importsC, usesPkgConfig bool, err error) {
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
				groupUses, err := cgoCommentUsesPkgConfig(group.Doc, profile)
				if err != nil {
					return false, false, err
				}
				specUses, err := cgoCommentUsesPkgConfig(spec.Doc, profile)
				if err != nil {
					return false, false, err
				}
				if groupUses || specUses {
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

func cgoCommentUsesPkgConfig(group *ast.CommentGroup, profile Profile) (bool, error) {
	if group == nil {
		return false, nil
	}
	for _, comment := range group.List {
		for _, line := range strings.Split(comment.Text, "\n") {
			line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "/*"))
			if !strings.HasPrefix(line, "#cgo ") {
				continue
			}
			beforeColon, _, found := strings.Cut(strings.TrimPrefix(line, "#cgo "), ":")
			fields := strings.Fields(beforeColon)
			if !found || len(fields) == 0 || fields[len(fields)-1] != "pkg-config" {
				continue
			}
			active, err := cgoConstraintsMatch(fields[:len(fields)-1], profile)
			if err != nil {
				return false, err
			}
			if active {
				return true, nil
			}
		}
	}
	return false, nil
}

func cgoConstraintsMatch(terms []string, profile Profile) (bool, error) {
	if len(terms) == 0 {
		return true, nil
	}
	expression, err := constraint.Parse("// +build " + strings.Join(terms, " "))
	if err != nil {
		return false, fmt.Errorf("parse #cgo build constraints: %w", err)
	}
	context := build.Default
	context.GOOS = profile.GOOS
	context.GOARCH = profile.GOARCH
	context.CgoEnabled = profile.CGOEnabled
	context.BuildTags = append([]string{}, profile.BuildTags...)
	context.BuildTags = append(context.BuildTags, goFlagBuildTags(profile.GOFLAGS)...)
	tags := map[string]bool{
		context.GOOS:     true,
		context.GOARCH:   true,
		context.Compiler: true,
		"cgo":            context.CgoEnabled,
	}
	for _, values := range [][]string{context.BuildTags, context.ToolTags, context.ReleaseTags} {
		for _, tag := range values {
			tags[tag] = true
		}
	}
	switch context.GOOS {
	case "android":
		tags["linux"] = true
	case "illumos":
		tags["solaris"] = true
	case "ios":
		tags["darwin"] = true
	}
	return expression.Eval(func(tag string) bool { return tags[tag] }), nil
}

func goFlagBuildTags(flags []string) []string {
	var result []string
	for i := 0; i < len(flags); i++ {
		if flags[i] == "-tags" && i+1 < len(flags) {
			result = append(result, strings.Split(flags[i+1], ",")...)
			i++
		} else if strings.HasPrefix(flags[i], "-tags=") {
			result = append(result, strings.Split(strings.TrimPrefix(flags[i], "-tags="), ",")...)
		}
	}
	return result
}
