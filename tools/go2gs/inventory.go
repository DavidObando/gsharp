// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"encoding/base64"
	"fmt"
	"go/ast"
	"go/constant"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/tools/go/packages"
)

var (
	overlayDiagnosticPath = regexp.MustCompile(`[^\s\n]*gocommand-[0-9]+[/\\][0-9]+-([^:\s\n]+)`)
	quotedIncludePattern  = regexp.MustCompile(`(?m)^[\t ]*#[\t ]*include[\t ]*"([^"\r\n]+)"`)
)

type inventoryBuilder struct {
	analysis              *Analysis
	sourceRoot            string
	goroot                string
	profile               Profile
	packageIDs            map[*packages.Package]string
	packagePathIDs        map[string]string
	typeIDs               map[types.Type]string
	objectIDs             map[objectRef]string
	fileIDs               map[string]string
	moduleIDs             map[string]string
	seenModules           map[string]bool
	seenFiles             map[string]bool
	seenTypes             map[string]bool
	seenSymbols           map[string]bool
	seenMethodSets        map[string]bool
	scopeIDs              map[*types.Scope]string
	scopeRanges           []scopeRange
	diagnosticSeq         int
	sourceSnapshot        map[string][]byte
	snapshotPortable      map[string]string
	inputDrift            map[string]bool
	snapshotFiles         map[string][]string
	selectedSnapshotFiles map[string][]string
	snapshotRoles         map[string]map[string]string
	memberIdentity        map[types.Object]string
	skipSemantics         map[*packages.Package]bool
}

func newInventoryBuilder(analysis *Analysis, sourceRoot, goroot string, profile Profile) *inventoryBuilder {
	return &inventoryBuilder{
		analysis: analysis, sourceRoot: sourceRoot, goroot: goroot, profile: profile,
		packageIDs: map[*packages.Package]string{}, packagePathIDs: map[string]string{}, typeIDs: map[types.Type]string{},
		objectIDs: map[objectRef]string{}, fileIDs: map[string]string{},
		moduleIDs: map[string]string{}, seenModules: map[string]bool{},
		seenFiles: map[string]bool{}, seenTypes: map[string]bool{}, seenSymbols: map[string]bool{},
		seenMethodSets: map[string]bool{}, scopeIDs: map[*types.Scope]string{},
		inputDrift: map[string]bool{}, snapshotFiles: map[string][]string{},
		selectedSnapshotFiles: map[string][]string{}, snapshotPortable: map[string]string{},
		snapshotRoles: map[string]map[string]string{}, memberIdentity: map[types.Object]string{},
		skipSemantics: map[*packages.Package]bool{},
	}
}

type objectRef struct {
	object    types.Object
	packageID string
}

func (b *inventoryBuilder) collectManifests() error {
	names := []string{"go.mod", "go.sum", "go.work", "go.work.sum", filepath.Join("vendor", "modules.txt")}
	for _, name := range names {
		path, err := safeJoin(b.sourceRoot, name)
		if err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("manifest is not a regular file: %s", name)
		}
		hash, size, err := hashFile(path)
		if err != nil {
			return err
		}
		b.analysis.Manifests = append(b.analysis.Manifests, ManifestRecord{
			Kind: filepath.Base(name), Path: "source://" + slash(name), SHA256: hash, Bytes: size,
		})
	}
	sort.Slice(b.analysis.Manifests, func(i, j int) bool { return b.analysis.Manifests[i].Path < b.analysis.Manifests[j].Path })
	return nil
}

func (b *inventoryBuilder) indexPackages(packages []*packages.Package) {
	for _, pkg := range packages {
		id := stableID("package", packageCanonical(pkg))
		b.packageIDs[pkg] = id
		if packageVariant(pkg) == "ordinary" || b.packagePathIDs[pkg.PkgPath] == "" {
			b.packagePathIDs[pkg.PkgPath] = id
		}
	}
	b.indexDeclaredMembers(packages)
}

func (b *inventoryBuilder) addPackage(pkg *packages.Package) error {
	pkgID := b.packageIDs[pkg]
	moduleID, err := b.addModule(pkg.Module)
	if err != nil {
		return err
	}
	record := PackageRecord{
		ID: pkgID, ImportPath: pkg.PkgPath, Name: pkg.Name, Variant: packageVariant(pkg),
		ModuleID: moduleID, LanguageVersion: moduleGoVersion(pkg.Module),
		InventoryComplete: !pkg.IllTyped && len(pkg.Errors) == 0,
	}
	if b.inputDrift[packageInputKey(pkg)] {
		record.InventoryComplete = false
		b.block("input-drift", "selected package inputs changed while loading", []string{pkgID}, nil)
	}

	importKeys := make([]string, 0, len(pkg.Imports))
	for path := range pkg.Imports {
		importKeys = append(importKeys, path)
	}
	sort.Strings(importKeys)
	for _, path := range importKeys {
		imported := pkg.Imports[path]
		importedID := b.packageIDs[imported]
		if importedID != "" {
			record.ImportPackageIDs = append(record.ImportPackageIDs, importedID)
		}
		disposition := "translated-candidate"
		if imported.Module == nil {
			disposition = "standard-library"
		} else if !imported.Module.Main {
			disposition = "dependency-unclassified"
		}
		depID := stableID("dependency", pkgID+"\x00"+path)
		b.analysis.Dependencies = append(b.analysis.Dependencies, DependencyRecord{
			ID: depID, FromPackageID: pkgID, ImportPath: path, PackageID: importedID, Disposition: disposition,
		})
	}

	for _, pkgErr := range pkg.Errors {
		message, truncated := truncate(b.sanitizeDiagnosticMessage(pkg, pkgErr.Msg), b.profile.Limits.MaxStringBytes)
		position := b.portableDiagnosticPosition(pkg, pkgErr.Pos)
		id := stableID("diagnostic", pkgID+"\x00"+strconv.Itoa(int(pkgErr.Kind))+"\x00"+position+"\x00"+message)
		diagnostic := DiagnosticRecord{
			ID: id, Category: packageErrorCategory(pkgErr.Kind), Severity: "error",
			Message: message, Position: position, PackageID: pkgID, Truncated: truncated,
		}
		b.analysis.Diagnostics = append(b.analysis.Diagnostics, diagnostic)
		record.DiagnosticIDs = append(record.DiagnosticIDs, id)
		record.InventoryComplete = false
	}

	if !record.InventoryComplete {
		b.block("package-load", "package inventory is incomplete", []string{pkgID}, record.DiagnosticIDs)
	}

	if len(b.snapshotFiles[packageInputKey(pkg)]) > 0 {
		if err := b.addSourcePackage(pkg, &record); err != nil {
			return err
		}
	}

	if !b.skipSemantics[pkg] {
		b.addInitialization(pkg, &record)
	}
	sort.Strings(record.DiagnosticIDs)
	b.analysis.Packages = append(b.analysis.Packages, record)
	return nil
}

func (b *inventoryBuilder) sanitizeDiagnosticMessage(pkg *packages.Package, message string) string {
	message = overlayDiagnosticPath.ReplaceAllString(message, "<overlay>/$1")
	message = strings.ReplaceAll(message, b.sourceRoot, "<source>")
	message = strings.ReplaceAll(message, b.goroot, "<goroot>")
	if pkg.Module != nil && pkg.Module.Dir != "" {
		message = strings.ReplaceAll(message, pkg.Module.Dir, "<module>")
		if pkg.Module.Replace != nil && pkg.Module.Replace.Dir != "" {
			message = strings.ReplaceAll(message, pkg.Module.Replace.Dir, "<replacement>")
		}
	}
	return message
}

func (b *inventoryBuilder) portableDiagnosticPosition(pkg *packages.Package, position string) string {
	path, suffix := splitDiagnosticPosition(position)
	if path == "" {
		return position
	}
	if !filepath.IsAbs(path) {
		clean := filepath.Clean(path)
		if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			clean = filepath.Base(clean)
		}
		return "line://" + slash(clean) + suffix
	}
	if portable, err := b.portablePath(pkg, path); err == nil {
		return portable + suffix
	}
	return "external://" + slash(filepath.Base(path)) + suffix
}

func splitDiagnosticPosition(position string) (string, string) {
	last := strings.LastIndexByte(position, ':')
	if last < 0 {
		return "", ""
	}
	if _, err := strconv.Atoi(position[last+1:]); err != nil {
		return "", ""
	}
	start := last
	if previous := strings.LastIndexByte(position[:last], ':'); previous >= 0 {
		if _, err := strconv.Atoi(position[previous+1 : last]); err == nil {
			start = previous
		}
	}
	return position[:start], position[start:]
}

func (b *inventoryBuilder) addSourcePackage(pkg *packages.Package, record *PackageRecord) error {
	compiled := stringSet(pkg.CompiledGoFiles)
	active := stringSet(pkg.GoFiles)
	embed := stringSet(pkg.EmbedFiles)
	activeCgo := b.packageImportsC(pkg)
	reachableHeaders, unsafeIncludes := selectedNativeIncludes(pkg, b.sourceSnapshot)
	nativeConsumer := hasSelectedNativeConsumer(pkg, activeCgo)
	all := append([]string{}, pkg.CompiledGoFiles...)
	all = append(all, pkg.GoFiles...)
	all = append(all, pkg.IgnoredFiles...)
	all = append(all, pkg.OtherFiles...)
	all = append(all, pkg.EmbedFiles...)
	all = append(all, b.snapshotFiles[packageInputKey(pkg)]...)
	all = uniqueSorted(all)
	newFiles := 0
	for _, path := range all {
		if _, captured := b.sourceSnapshot[path]; captured && b.fileIDs[b.fileKey(pkg, path)] == "" {
			newFiles++
		}
	}
	if len(b.seenFiles)+newFiles > b.profile.Limits.MaxFiles {
		return fmt.Errorf("file count exceeds limit %d", b.profile.Limits.MaxFiles)
	}
	if nativeConsumer {
		b.block("native", "selected package requires native, assembly, or CGo build inputs; M0 records them but does not authorize the native toolchain", []string{record.ID}, nil)
		record.InventoryComplete = false
	}
	if unsafeIncludes {
		b.block("native-include", "selected native source has an unsafe or unavailable local quoted include", []string{record.ID}, nil)
		record.InventoryComplete = false
	}
	unmappedCgo := activeCgo
	if unmappedCgo {
		b.block("cgo", "selected package uses CGo-transformed syntax that M0 cannot faithfully relate to original source", []string{record.ID}, nil)
		record.InventoryComplete = false
		b.skipSemantics[pkg] = true
	}
	for _, path := range all {
		if _, captured := b.sourceSnapshot[path]; !captured {
			if unmappedCgo {
				continue
			}
			b.block("input-snapshot", "selected package input was not captured before loading", []string{record.ID}, nil)
			record.InventoryComplete = false
			continue
		}
		role, reason := "active", ""
		switch {
		case embed[path]:
			role, reason = "embed", "selected by go:embed"
		case contains(pkg.OtherFiles, path):
			if activeCgo || !nativeHeader(path) || reachableHeaders[path] {
				role, reason = "native", "selected non-Go build input"
			} else {
				role, reason = "ignored", "no selected native source can consume this header"
			}
		case contains(pkg.IgnoredFiles, path):
			role, reason = "ignored", "excluded by current build constraints or file naming"
		case strings.HasSuffix(path, "_test.go"):
			role, reason = "test", "selected test source for this package variant"
		case compiled[path]:
			role = "compiled"
		case active[path]:
			role = "active"
		default:
			role, reason = "input", "reported by go/packages"
		}
		key := packageInputKey(pkg)
		if !contains(pkg.GoFiles, path) && !contains(pkg.CompiledGoFiles, path) &&
			!contains(pkg.IgnoredFiles, path) && !contains(pkg.OtherFiles, path) && !contains(pkg.EmbedFiles, path) {
			snapshotRole := b.snapshotRoles[key][path]
			if contains(b.selectedSnapshotFiles[key], path) {
				if snapshotRole != "" {
					role = snapshotRole
				}
				reason = "captured before package loading"
			} else {
				role = "ignored"
				reason = "discovered defensively but inactive in the selected profile"
			}
			if reachableHeaders[path] {
				role = "native"
				reason = "included by selected native source"
			}
		}
		fileID, err := b.addFile(pkg, path, role, reason)
		if err != nil {
			return err
		}
		record.FileIDs = append(record.FileIDs, fileID)
	}
	if unmappedCgo {
		sort.Strings(record.FileIDs)
		return nil
	}
	for _, path := range pkg.CompiledGoFiles {
		if fileID := b.fileIDs[b.fileKey(pkg, path)]; fileID != "" {
			record.CompiledFileIDs = append(record.CompiledFileIDs, fileID)
		}
	}

	b.addScopes(pkg)
	for index, file := range pkg.Syntax {
		if index >= len(pkg.CompiledGoFiles) {
			break
		}
		path := pkg.CompiledGoFiles[index]
		fileID := b.fileIDs[b.fileKey(pkg, path)]
		if fileID == "" {
			continue
		}
		b.markGenerated(fileID, generatedFile(file))
		b.addGenerateDirectives(pkg, fileID, file)
		b.addSyntax(pkg, fileID, file)
	}
	b.addSelections(pkg)
	b.addInstances(pkg)
	b.addMethodSets(pkg)
	b.addEmbeds(pkg)
	sort.Strings(record.FileIDs)
	sort.Strings(record.ImportPackageIDs)
	return nil
}

func (b *inventoryBuilder) packageImportsC(pkg *packages.Package) bool {
	return pathsImportC(pkg.GoFiles, b.sourceSnapshot)
}

func (b *inventoryBuilder) snapshotFileImportsC(path string) bool {
	if filepath.Ext(path) != ".go" {
		return false
	}
	data, captured := b.sourceSnapshot[path]
	if !captured {
		return false
	}
	file, err := parser.ParseFile(token.NewFileSet(), path, data, parser.ImportsOnly)
	if err != nil {
		return false
	}
	for _, imported := range file.Imports {
		if imported.Path.Value == `"C"` {
			return true
		}
	}
	return false
}

func hasSelectedNativeConsumer(pkg *packages.Package, activeCgo bool) bool {
	for _, path := range pkg.OtherFiles {
		if activeCgo || !nativeHeader(path) {
			return true
		}
	}
	return false
}

func pathsImportC(paths []string, snapshot map[string][]byte) bool {
	for _, path := range paths {
		if filepath.Ext(path) != ".go" {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, snapshot[path], parser.ImportsOnly)
		if err != nil {
			continue
		}
		for _, imported := range file.Imports {
			if imported.Path.Value == `"C"` {
				return true
			}
		}
	}
	return false
}

func selectedNativeIncludes(pkg *packages.Package, snapshot map[string][]byte) (map[string]bool, bool) {
	reachable := map[string]bool{}
	pending := []string{}
	for _, path := range pkg.OtherFiles {
		if !nativeHeader(path) {
			pending = append(pending, path)
		}
	}
	sort.Strings(pending)
	visited := map[string]bool{}
	unsafe := false
	for len(pending) > 0 {
		path := pending[0]
		pending = pending[1:]
		if visited[path] {
			continue
		}
		visited[path] = true
		data, captured := snapshot[path]
		if !captured {
			unsafe = true
			continue
		}
		for _, include := range localQuotedIncludes(data) {
			target, ok := resolveLocalInclude(pkg.Dir, path, include)
			if !ok {
				unsafe = true
				continue
			}
			if _, captured := snapshot[target]; !captured {
				unsafe = true
				continue
			}
			if !reachable[target] {
				reachable[target] = true
				pending = append(pending, target)
				sort.Strings(pending)
			}
		}
	}
	return reachable, unsafe
}

func localQuotedIncludes(data []byte) []string {
	matches := quotedIncludePattern.FindAllSubmatch(data, -1)
	result := make([]string, 0, len(matches))
	for _, match := range matches {
		result = append(result, string(match[1]))
	}
	sort.Strings(result)
	return result
}

func resolveLocalInclude(packageDir, includingPath, include string) (string, bool) {
	if packageDir == "" || include == "" || filepath.IsAbs(include) ||
		filepath.VolumeName(include) != "" || strings.ContainsRune(include, '\\') {
		return "", false
	}
	target := filepath.Clean(filepath.Join(filepath.Dir(includingPath), filepath.FromSlash(include)))
	if _, err := pathWithin(packageDir, target); err != nil {
		return "", false
	}
	return target, true
}

func nativeHeader(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".h", ".hh", ".hpp":
		return true
	default:
		return false
	}
}

func nativeIncludeCarrier(path string) bool {
	if nativeHeader(path) {
		return true
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".c", ".cc", ".cpp", ".cxx", ".f", ".f90", ".for", ".m", ".mm", ".s", ".swig", ".swigcxx":
		return true
	default:
		return false
	}
}

func (b *inventoryBuilder) addFile(pkg *packages.Package, path, role, reason string) (string, error) {
	key := b.fileKey(pkg, path)
	if id := b.fileIDs[key]; id != "" {
		return id, nil
	}
	portable := b.snapshotPortable[path]
	if portable == "" {
		var err error
		portable, err = b.portablePath(pkg, path)
		if err != nil {
			return "", err
		}
	}
	data, captured := b.sourceSnapshot[path]
	if !captured {
		return "", fmt.Errorf("selected package input was not captured in the immutable loader snapshot: %s", filepath.Base(path))
	}
	id := stableID("file", b.packageIDs[pkg]+"\x00"+portable+"\x00"+hashBytes(data))
	record := FileRecord{
		ID: id, PackageID: b.packageIDs[pkg], Path: portable, Role: role, Reason: reason,
		LanguageVersion: moduleGoVersion(pkg.Module), SHA256: hashBytes(data), Bytes: int64(len(data)),
		ContentBase64: base64.StdEncoding.EncodeToString(data), ValidUTF8: utf8.Valid(data),
		Native: role == "native", Embed: role == "embed", Provenance: "go/packages",
	}
	b.analysis.Files = append(b.analysis.Files, record)
	b.fileIDs[key] = id
	b.seenFiles[id] = true
	return id, nil
}

func (b *inventoryBuilder) portablePath(pkg *packages.Package, path string) (string, error) {
	if relative, err := pathWithin(b.sourceRoot, path); err == nil {
		return "source://" + relative, nil
	}
	if pkg.Module != nil && pkg.Module.Dir != "" {
		root := pkg.Module.Dir
		logicalPath := pkg.Module.Path
		version := pkg.Module.Version
		if pkg.Module.Replace != nil {
			root = pkg.Module.Replace.Dir
			if pkg.Module.Replace.Version != "" {
				logicalPath = pkg.Module.Replace.Path
				version = pkg.Module.Replace.Version
			} else {
				version = "local"
			}
		}
		if relative, err := pathWithin(root, path); err == nil {
			if version == "" {
				version = "local"
			}
			return "module://" + logicalPath + "@" + version + "/" + relative, nil
		}
	}
	if relative, err := pathWithin(b.goroot, path); err == nil {
		return "goroot://" + relative, nil
	}
	return "", fmt.Errorf("selected path is outside declared source/module/GOROOT roots: %s", path)
}

func (b *inventoryBuilder) markGenerated(fileID string, generated bool) {
	if !generated {
		return
	}
	for i := range b.analysis.Files {
		if b.analysis.Files[i].ID == fileID {
			b.analysis.Files[i].Generated = true
			return
		}
	}
}

func (b *inventoryBuilder) addSyntax(pkg *packages.Package, fileID string, file *ast.File) {
	pkgID := b.packageIDs[pkg]
	var parents []string
	nodeParents := map[ast.Node]ast.Node{}
	arrayLengths := map[ast.Expr]bool{}
	var astParents []ast.Node
	ast.Inspect(file, func(node ast.Node) bool {
		if node == nil {
			astParents = astParents[:len(astParents)-1]
			return true
		}
		if len(astParents) > 0 {
			nodeParents[node] = astParents[len(astParents)-1]
		}
		astParents = append(astParents, node)
		if array, ok := node.(*ast.ArrayType); ok && array.Len != nil {
			arrayLengths[array.Len] = true
		}
		return true
	})
	constants := declaredConstants(file)
	ast.Inspect(file, func(node ast.Node) bool {
		if node == nil {
			parents = parents[:len(parents)-1]
			return true
		}
		span := b.span(pkg, node.Pos(), node.End())
		nodeID := syntaxNodeID(pkgID, fileID, node, span)
		record := NodeRecord{ID: nodeID, PackageID: pkgID, FileID: fileID, Kind: fmt.Sprintf("%T", node), Span: span}
		if len(parents) > 0 {
			record.ParentID = parents[len(parents)-1]
		}
		parents = append(parents, nodeID)
		record.ScopeID = b.scopeFor(pkgID, node.Pos())
		if expression, ok := node.(ast.Expr); ok {
			tv, exists := pkg.TypesInfo.Types[expression]
			if exists {
				original, effective, conversion := expressionTypeFacts(pkg, expression, tv, nodeParents)
				record.OriginalTypeID = b.addType(pkg, original)
				record.EffectiveTypeID = b.addType(pkg, effective)
				record.ConversionTypeID = b.addType(pkg, conversion)
				record.Addressable = tv.Addressable()
				record.Assignable = tv.Assignable()
				record.IsType = tv.IsType()
				record.IsValue = tv.IsValue()
				record.IsNil = tv.IsNil()
				record.IsBuiltin = tv.IsBuiltin()
				if tv.Value != nil {
					b.addConstant(pkg, nodeID, expression, tv, conversion, span, arrayLengths[expression])
				}
			}
			if call, ok := expression.(*ast.CallExpr); ok {
				b.addCall(pkg, nodeID, call)
			}
		}
		if ident, ok := node.(*ast.Ident); ok {
			if object := pkg.TypesInfo.Defs[ident]; object != nil {
				record.DeclarationID = b.addObject(pkg, object, b.span(pkg, ident.Pos(), ident.End()))
				if value, ok := object.(*types.Const); ok {
					b.addDeclaredConstant(pkg, nodeID, record.DeclarationID, value, span, constants[ident])
				}
			}
			if object := pkg.TypesInfo.Uses[ident]; object != nil {
				if selector, ok := nodeParents[ident].(*ast.SelectorExpr); ok && selector.Sel == ident {
					if selection := pkg.TypesInfo.Selections[selector]; selection != nil {
						record.UseID = b.addObjectWithFallback(pkg, object, SourceSpan{}, selectionObjectIdentity(selection))
					} else {
						record.UseID = b.addObject(pkg, object, SourceSpan{})
					}
				} else {
					record.UseID = b.addObject(pkg, object, SourceSpan{})
				}
			}
		}
		b.analysis.Nodes = append(b.analysis.Nodes, record)
		b.addFeatureSites(pkg, pkgID, fileID, node, nodeID, span)
		return true
	})
}

func syntaxNodeID(pkgID, fileID string, node ast.Node, span SourceSpan) string {
	return stableID("node", pkgID+"\x00"+fileID+"\x00"+fmt.Sprintf("%d:%d:%T", span.StartByte, span.EndByte, node))
}

func expressionTypeFacts(pkg *packages.Package, expr ast.Expr, tv types.TypeAndValue, parents map[ast.Node]ast.Node) (original, effective, conversion types.Type) {
	effective = tv.Type
	if call, ok := expr.(*ast.CallExpr); ok && len(call.Args) == 1 {
		if fun, exists := pkg.TypesInfo.Types[call.Fun]; exists && fun.IsType() {
			argumentType := pkg.TypesInfo.TypeOf(call.Args[0])
			if argument, exists := pkg.TypesInfo.Types[call.Args[0]]; exists && argument.Value != nil {
				if untyped := untypedConstantType(pkg, call.Args[0], argument.Value); untyped != nil {
					argumentType = untyped
				}
			}
			return argumentType, tv.Type, tv.Type
		}
	}
	contextType := contextualType(pkg, expr, parents)
	if contextType != nil && tv.Type != nil && !types.Identical(tv.Type, contextType) && types.AssignableTo(tv.Type, contextType) {
		return tv.Type, contextType, contextType
	}
	if tv.Value != nil && tv.Type != nil && !isUntyped(tv.Type) {
		if untyped := untypedConstantType(pkg, expr, tv.Value); untyped != nil && !types.Identical(untyped, tv.Type) {
			return untyped, tv.Type, tv.Type
		}
	}
	return nil, effective, nil
}

func contextualType(pkg *packages.Package, expr ast.Expr, parents map[ast.Node]ast.Node) types.Type {
	parent := parents[expr]
	switch value := parent.(type) {
	case *ast.ValueSpec:
		if value.Type != nil && slices.Contains(value.Values, expr) {
			return pkg.TypesInfo.TypeOf(value.Type)
		}
	case *ast.AssignStmt:
		if value.Tok == token.ASSIGN && len(value.Lhs) == len(value.Rhs) {
			for i, rhs := range value.Rhs {
				if rhs == expr {
					return pkg.TypesInfo.TypeOf(value.Lhs[i])
				}
			}
		}
	case *ast.CallExpr:
		if fun, ok := pkg.TypesInfo.Types[value.Fun]; ok && fun.IsType() {
			return fun.Type
		}
		signature, _ := pkg.TypesInfo.TypeOf(value.Fun).(*types.Signature)
		if signature == nil {
			return nil
		}
		for i, argument := range value.Args {
			if argument != expr {
				continue
			}
			index := i
			if signature.Variadic() && index >= signature.Params().Len()-1 {
				index = signature.Params().Len() - 1
				parameter := signature.Params().At(index).Type()
				if !value.Ellipsis.IsValid() {
					if slice, ok := parameter.(*types.Slice); ok {
						return slice.Elem()
					}
				}
				return parameter
			}
			if index < signature.Params().Len() {
				return signature.Params().At(index).Type()
			}
		}
	case *ast.SendStmt:
		if value.Value == expr {
			channelType := pkg.TypesInfo.TypeOf(value.Chan)
			if channelType != nil {
				if channel, ok := channelType.Underlying().(*types.Chan); ok {
					return channel.Elem()
				}
			}
		}
	case *ast.ReturnStmt:
		for node := ast.Node(value); node != nil; node = parents[node] {
			switch function := parents[node].(type) {
			case *ast.FuncDecl:
				if object, ok := pkg.TypesInfo.Defs[function.Name].(*types.Func); ok {
					return resultTypeForExpression(object.Type().(*types.Signature), value, expr)
				}
			case *ast.FuncLit:
				if signature, ok := pkg.TypesInfo.TypeOf(function.Type).(*types.Signature); ok {
					return resultTypeForExpression(signature, value, expr)
				}
			}
		}
	case *ast.CompositeLit:
		return compositeElementType(pkg.TypesInfo.TypeOf(value), value, expr)
	case *ast.KeyValueExpr:
		if literal, ok := parents[value].(*ast.CompositeLit); ok {
			switch composite := pkg.TypesInfo.TypeOf(literal).Underlying().(type) {
			case *types.Map:
				if value.Key == expr {
					return composite.Key()
				}
				if value.Value == expr {
					return composite.Elem()
				}
			case *types.Struct:
				if value.Value == expr {
					if ident, ok := value.Key.(*ast.Ident); ok {
						for i := 0; i < composite.NumFields(); i++ {
							if composite.Field(i).Name() == ident.Name {
								return composite.Field(i).Type()
							}
						}
					}
				}
			}
		}
	}
	return nil
}

func resultTypeForExpression(signature *types.Signature, statement *ast.ReturnStmt, expr ast.Expr) types.Type {
	if signature == nil || signature.Results() == nil || len(statement.Results) != signature.Results().Len() {
		return nil
	}
	for i, result := range statement.Results {
		if result == expr {
			return signature.Results().At(i).Type()
		}
	}
	return nil
}

func compositeElementType(t types.Type, literal *ast.CompositeLit, expr ast.Expr) types.Type {
	if t == nil {
		return nil
	}
	switch composite := t.Underlying().(type) {
	case *types.Array:
		return composite.Elem()
	case *types.Slice:
		return composite.Elem()
	case *types.Struct:
		for i, element := range literal.Elts {
			if element == expr && i < composite.NumFields() {
				return composite.Field(i).Type()
			}
		}
	}
	return nil
}

func untypedConstantType(pkg *packages.Package, expr ast.Expr, value constant.Value) types.Type {
	if !isUntypedConstantExpression(pkg, expr) {
		return nil
	}
	if ident, ok := expr.(*ast.Ident); ok {
		if object, ok := pkg.TypesInfo.Uses[ident].(*types.Const); ok {
			return object.Type()
		}
	}
	if literal, ok := expr.(*ast.BasicLit); ok && literal.Kind == token.CHAR {
		return types.Typ[types.UntypedRune]
	}
	switch value.Kind() {
	case constant.Bool:
		return types.Typ[types.UntypedBool]
	case constant.String:
		return types.Typ[types.UntypedString]
	case constant.Int:
		return types.Typ[types.UntypedInt]
	case constant.Float:
		return types.Typ[types.UntypedFloat]
	case constant.Complex:
		return types.Typ[types.UntypedComplex]
	default:
		return nil
	}
}

func isUntypedConstantExpression(pkg *packages.Package, expression ast.Expr) bool {
	switch value := expression.(type) {
	case *ast.BasicLit:
		return true
	case *ast.Ident:
		if object, ok := pkg.TypesInfo.Uses[value].(*types.Const); ok {
			return isUntyped(object.Type())
		}
		return value.Name == "true" || value.Name == "false" || value.Name == "iota"
	case *ast.ParenExpr:
		return isUntypedConstantExpression(pkg, value.X)
	case *ast.UnaryExpr:
		return isUntypedConstantExpression(pkg, value.X)
	case *ast.BinaryExpr:
		return isUntypedConstantExpression(pkg, value.X) && isUntypedConstantExpression(pkg, value.Y)
	default:
		return false
	}
}

func declaredConstants(file *ast.File) map[*ast.Ident]bool {
	result := map[*ast.Ident]bool{}
	for _, declaration := range file.Decls {
		group, ok := declaration.(*ast.GenDecl)
		if !ok || group.Tok != token.CONST {
			continue
		}
		var inherited []ast.Expr
		for _, raw := range group.Specs {
			spec := raw.(*ast.ValueSpec)
			if len(spec.Values) > 0 {
				inherited = spec.Values
			}
			for index, name := range spec.Names {
				result[name] = index < len(inherited) && expressionsContainIota([]ast.Expr{inherited[index]})
			}
		}
	}
	return result
}

func expressionsContainIota(expressions []ast.Expr) bool {
	found := false
	for _, expression := range expressions {
		ast.Inspect(expression, func(node ast.Node) bool {
			if ident, ok := node.(*ast.Ident); ok && ident.Name == "iota" {
				found = true
			}
			return !found
		})
	}
	return found
}

func calleeObject(pkg *packages.Package, expression ast.Expr) types.Object {
	switch value := expression.(type) {
	case *ast.Ident:
		return pkg.TypesInfo.Uses[value]
	case *ast.SelectorExpr:
		if selection := pkg.TypesInfo.Selections[value]; selection != nil {
			return selection.Obj()
		}
		return pkg.TypesInfo.Uses[value.Sel]
	case *ast.IndexExpr:
		return calleeObject(pkg, value.X)
	case *ast.IndexListExpr:
		return calleeObject(pkg, value.X)
	case *ast.ParenExpr:
		return calleeObject(pkg, value.X)
	default:
		return nil
	}
}

func (b *inventoryBuilder) addConstant(pkg *packages.Package, nodeID string, expr ast.Expr, tv types.TypeAndValue, contextType types.Type, span SourceSpan, arrayLength bool) {
	exact := tv.Value.ExactString()
	record := ConstantRecord{
		ID: stableID("constant", nodeID+"\x00"+exact), NodeID: nodeID,
		TypeID: b.addType(pkg, tv.Type), Category: constantCategory(tv.Type), Exact: exact,
		Untyped: isUntyped(tv.Type), ContextTypeID: b.addType(pkg, contextType), Span: span,
	}
	if tv.Value.Kind() == constant.Complex {
		record.RealExact = constant.Real(tv.Value).ExactString()
		record.ImaginaryExact = constant.Imag(tv.Value).ExactString()
	}
	if ident, ok := expr.(*ast.Ident); ok && ident.Name == "iota" {
		record.Iota = true
	}
	record.ArrayLength = arrayLength
	b.analysis.Constants = append(b.analysis.Constants, record)
}

func (b *inventoryBuilder) addDeclaredConstant(pkg *packages.Package, nodeID, symbolID string, value *types.Const, span SourceSpan, iota bool) {
	exact := value.Val().ExactString()
	record := ConstantRecord{
		ID: stableID("constant", symbolID+"\x00"+exact), NodeID: nodeID, SymbolID: symbolID,
		TypeID: b.addType(pkg, value.Type()), Category: constantCategory(value.Type()), Exact: exact,
		Untyped: isUntyped(value.Type()), Iota: iota, Span: span,
	}
	if !record.Untyped {
		record.ContextTypeID = record.TypeID
	}
	if value.Val().Kind() == constant.Complex {
		record.RealExact = constant.Real(value.Val()).ExactString()
		record.ImaginaryExact = constant.Imag(value.Val()).ExactString()
	}
	b.analysis.Constants = append(b.analysis.Constants, record)
}

func (b *inventoryBuilder) addCall(pkg *packages.Package, nodeID string, call *ast.CallExpr) {
	record := CallRecord{ID: stableID("call", nodeID), NodeID: nodeID, Kind: "function", Ellipsis: call.Ellipsis.IsValid()}
	if tv, ok := pkg.TypesInfo.Types[call.Fun]; ok && tv.IsType() {
		record.Kind = "conversion"
		record.SignatureTypeID = b.addType(pkg, tv.Type)
	}
	if signature, ok := pkg.TypesInfo.TypeOf(call.Fun).(*types.Signature); ok {
		record.SignatureTypeID = b.addType(pkg, signature)
		record.Variadic = signature.Variadic()
	}
	if object := calleeObject(pkg, call.Fun); object != nil {
		if _, isType := object.(*types.TypeName); !isType {
			record.CalleeSymbolID = b.addObject(pkg, object, SourceSpan{})
		}
		if _, ok := object.(*types.Builtin); ok {
			record.Kind = "builtin"
			record.Builtin = object.Name()
		}
	}
	for _, argument := range call.Args {
		record.ArgumentTypeIDs = append(record.ArgumentTypeIDs, b.addType(pkg, pkg.TypesInfo.TypeOf(argument)))
	}
	b.analysis.Calls = append(b.analysis.Calls, record)
}

func (b *inventoryBuilder) addFeatureSites(pkg *packages.Package, pkgID, fileID string, node ast.Node, nodeID string, span SourceSpan) {
	features := map[string]string{}
	add := func(feature, blocker string) {
		features[feature] = blocker
	}
	switch node.(type) {
	case *ast.GoStmt:
		add("goroutine", "m1-concurrency")
	case *ast.DeferStmt:
		add("defer", "m1-panic-defer-recover")
	case *ast.RangeStmt:
		add("range", "")
	case *ast.TypeSwitchStmt:
		add("type-switch", "m1-typed-nil-interface")
	case *ast.IndexListExpr:
		add("generic-instantiation", "")
	case *ast.FuncLit:
		add("closure", "")
	case *ast.SendStmt:
		add("channel-send", "m1-concurrency")
	case *ast.SelectStmt:
		add("channel-select", "m1-concurrency")
	case *ast.ChanType:
		add("channel-type", "m1-concurrency")
	case *ast.ArrayType:
		if node.(*ast.ArrayType).Len != nil {
			add("fixed-value-array", "m1-fixed-value-arrays")
		}
	}
	if expression, ok := node.(ast.Expr); ok {
		t := pkg.TypesInfo.TypeOf(expression)
		if t != nil {
			switch t.Underlying().(type) {
			case *types.Interface:
				add("interface-value", "m1-typed-nil-interface")
			case *types.Map:
				add("map-value", "m1-byte-strings-maps")
			case *types.Array:
				add("fixed-value-array", "m1-fixed-value-arrays")
			case *types.Chan:
				add("channel-value", "m1-concurrency")
			}
		}
		if isStringType(t) {
			add("byte-string", "m1-byte-strings-maps")
		}
	}
	if ident, ok := node.(*ast.Ident); ok {
		switch ident.Name {
		case "nil":
			add("nil-value", "m1-typed-nil-interface")
		case "panic", "recover":
			if _, builtin := pkg.TypesInfo.Uses[ident].(*types.Builtin); builtin {
				add(ident.Name, "m1-panic-defer-recover")
			}
		case "close":
			if _, builtin := pkg.TypesInfo.Uses[ident].(*types.Builtin); builtin {
				add("channel-close", "m1-concurrency")
			}
		}
	}
	if unary, ok := node.(*ast.UnaryExpr); ok && unary.Op == token.ARROW {
		add("channel-receive", "m1-concurrency")
	}
	names := make([]string, 0, len(features))
	for feature := range features {
		names = append(names, feature)
	}
	sort.Strings(names)
	for _, feature := range names {
		blocker := features[feature]
		disposition := "inventoried"
		if blocker != "" {
			disposition = "m1-prerequisite"
			b.migrationBlock(blocker, "M1 requires an approved lowering/runtime design for "+feature, []string{pkgID})
		}
		b.analysis.FeatureSites = append(b.analysis.FeatureSites, FeatureSite{
			ID: stableID("feature", nodeID+"\x00"+feature), NodeID: nodeID, PackageID: pkgID, FileID: fileID,
			Feature: feature, Disposition: disposition, Span: span,
		})
	}
}

func isStringType(t types.Type) bool {
	if t == nil {
		return false
	}
	basic, ok := t.Underlying().(*types.Basic)
	return ok && basic.Info()&types.IsString != 0
}

func (b *inventoryBuilder) addScopes(pkg *packages.Package) {
	type pair struct {
		node  ast.Node
		scope *types.Scope
	}
	var scopes []pair
	for node, scope := range pkg.TypesInfo.Scopes {
		scopes = append(scopes, pair{node, scope})
	}
	sort.Slice(scopes, func(i, j int) bool {
		return scopes[i].node.Pos() < scopes[j].node.Pos()
	})
	for _, entry := range scopes {
		span := b.span(pkg, entry.node.Pos(), entry.node.End())
		id := stableID("scope", b.packageIDs[pkg]+"\x00"+fmt.Sprintf("%d:%d", span.StartByte, span.EndByte))
		b.scopeIDs[entry.scope] = id
		b.scopeRanges = append(b.scopeRanges, scopeRange{packageID: b.packageIDs[pkg], start: entry.node.Pos(), end: entry.node.End(), id: id})
		names := entry.scope.Names()
		sort.Strings(names)
		record := ScopeRecord{ID: id, PackageID: b.packageIDs[pkg], Span: span}
		for _, name := range names {
			object := entry.scope.Lookup(name)
			symbolID := b.addObject(pkg, object, SourceSpan{})
			record.SymbolIDs = append(record.SymbolIDs, symbolID)
			if _, ok := object.(*types.Label); ok {
				record.Labels = append(record.Labels, symbolID)
			}
		}
		b.analysis.Scopes = append(b.analysis.Scopes, record)
	}
	for i := range b.analysis.Scopes {
		for scope, id := range b.scopeIDs {
			if id == b.analysis.Scopes[i].ID && scope.Parent() != nil {
				b.analysis.Scopes[i].ParentID = b.scopeIDs[scope.Parent()]
			}
		}
	}
}

type scopeRange struct {
	packageID string
	start     token.Pos
	end       token.Pos
	id        string
}

func (b *inventoryBuilder) scopeFor(packageID string, pos token.Pos) string {
	best := ""
	var bestWidth token.Pos
	for _, candidate := range b.scopeRanges {
		if candidate.packageID != packageID || pos < candidate.start || pos > candidate.end {
			continue
		}
		width := candidate.end - candidate.start
		if best == "" || width < bestWidth {
			best = candidate.id
			bestWidth = width
		}
	}
	return best
}

func (b *inventoryBuilder) addSelections(pkg *packages.Package) {
	type entry struct {
		expr      *ast.SelectorExpr
		selection *types.Selection
	}
	var entries []entry
	for expr, selection := range pkg.TypesInfo.Selections {
		entries = append(entries, entry{expr, selection})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].expr.Pos() < entries[j].expr.Pos() })
	for _, item := range entries {
		span := b.span(pkg, item.expr.Pos(), item.expr.End())
		nodeID := stableID("node", b.packageIDs[pkg]+"\x00"+b.fileIDForPosition(pkg, item.expr.Pos())+"\x00"+fmt.Sprintf("%d:%d:%T", span.StartByte, span.EndByte, item.expr))
		index := append([]int{}, item.selection.Index()...)
		objectID := b.addObjectWithFallback(pkg, item.selection.Obj(), SourceSpan{}, selectionObjectIdentity(item.selection))
		b.analysis.Selections = append(b.analysis.Selections, SelectionRecord{
			ID: stableID("selection", nodeID), NodeID: nodeID, Kind: selectionKind(item.selection.Kind()),
			ObjectID:       objectID,
			ReceiverTypeID: b.addType(pkg, item.selection.Recv()), TypeID: b.addType(pkg, item.selection.Type()),
			IndexPath: index, Indirect: item.selection.Indirect(),
		})
	}
}

func (b *inventoryBuilder) addInstances(pkg *packages.Package) {
	type entry struct {
		ident    *ast.Ident
		instance types.Instance
	}
	var entries []entry
	for ident, instance := range pkg.TypesInfo.Instances {
		entries = append(entries, entry{ident, instance})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ident.Pos() < entries[j].ident.Pos() })
	for _, item := range entries {
		span := b.span(pkg, item.ident.Pos(), item.ident.End())
		nodeID := stableID("node", b.packageIDs[pkg]+"\x00"+b.fileIDForPosition(pkg, item.ident.Pos())+"\x00"+fmt.Sprintf("%d:%d:%T", span.StartByte, span.EndByte, item.ident))
		record := InstanceRecord{ID: stableID("instance", nodeID), NodeID: nodeID, TypeID: b.addType(pkg, item.instance.Type)}
		for i := 0; i < item.instance.TypeArgs.Len(); i++ {
			record.TypeArgIDs = append(record.TypeArgIDs, b.addType(pkg, item.instance.TypeArgs.At(i)))
		}
		b.analysis.Instances = append(b.analysis.Instances, record)
	}
}

func (b *inventoryBuilder) addMethodSets(pkg *packages.Package) {
	if pkg.Types == nil {
		return
	}
	names := pkg.Types.Scope().Names()
	sort.Strings(names)
	for _, name := range names {
		typeName, ok := pkg.Types.Scope().Lookup(name).(*types.TypeName)
		if !ok {
			continue
		}
		t := typeName.Type()
		for _, candidate := range []struct {
			t       types.Type
			pointer bool
		}{{t, false}, {types.NewPointer(t), true}} {
			typeID := b.addType(pkg, candidate.t)
			id := stableID("methodSet", typeID+"\x00"+strconv.FormatBool(candidate.pointer))
			if b.seenMethodSets[id] {
				continue
			}
			b.seenMethodSets[id] = true
			record := MethodSetRecord{ID: id, TypeID: typeID, Pointer: candidate.pointer}
			for _, method := range methodSetObjects(candidate.t) {
				fallback := "method-set\x00" + typeID + "\x00" + method.Name()
				record.MethodSymbolIDs = append(record.MethodSymbolIDs, b.addObjectWithFallback(pkg, method, SourceSpan{}, fallback))
			}
			b.analysis.MethodSets = append(b.analysis.MethodSets, record)
		}
	}
}

func (b *inventoryBuilder) addEmbeds(pkg *packages.Package) {
	if len(pkg.EmbedPatterns) == 0 {
		return
	}
	for _, pattern := range pkg.EmbedPatterns {
		pattern = b.embedPattern(pkg, pattern)
		for _, path := range pkg.EmbedFiles {
			logical := filepath.Base(path)
			if pkg.Dir != "" {
				if relative, err := pathWithin(pkg.Dir, path); err == nil {
					logical = relative
				}
			}
			if !embedPatternMatches(pattern, logical) {
				continue
			}
			fileID := b.fileIDs[b.fileKey(pkg, path)]
			if fileID == "" {
				continue
			}

			hash := ""
			for _, file := range b.analysis.Files {
				if file.ID == fileID {
					hash = file.SHA256
					break
				}
			}
			b.analysis.Embeds = append(b.analysis.Embeds, EmbedRecord{
				ID:        stableID("embed", b.packageIDs[pkg]+"\x00"+pattern+"\x00"+logical),
				PackageID: b.packageIDs[pkg], FileID: fileID, Pattern: pattern,
				LogicalName: logical, ContentSHA256: hash,
			})
		}
	}
}

func embedPatternMatches(pattern, logical string) bool {
	all := strings.HasPrefix(pattern, "all:")
	pattern = strings.TrimPrefix(pattern, "all:")
	logical = slash(logical)
	matched, err := pathpkg.Match(pattern, logical)
	if err != nil {
		return false
	}
	if matched {
		return true
	}
	for directory := pathpkg.Dir(logical); directory != "." && directory != "/"; directory = pathpkg.Dir(directory) {
		matched, err := pathpkg.Match(pattern, directory)
		if err != nil {
			return false
		}
		if !matched {
			continue
		}
		relative := strings.TrimPrefix(logical, directory+"/")
		return all || embedWalkVisible(relative)
	}
	return false
}

func embedWalkVisible(relative string) bool {
	for _, element := range strings.Split(relative, "/") {
		if strings.HasPrefix(element, ".") || strings.HasPrefix(element, "_") {
			return false
		}
	}
	return true
}

func (b *inventoryBuilder) embedPattern(pkg *packages.Package, pattern string) string {
	if !filepath.IsAbs(pattern) {
		return slash(pattern)
	}
	if pkg.Dir != "" {
		if relative, err := filepath.Rel(pkg.Dir, pattern); err == nil &&
			relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return slash(relative)
		}
	}
	if relative, err := filepath.Rel(b.sourceRoot, pattern); err == nil &&
		relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return slash(relative)
	}
	return slash(filepath.Base(pattern))
}

func (b *inventoryBuilder) addGenerateDirectives(pkg *packages.Package, fileID string, file *ast.File) {
	for _, group := range file.Comments {
		for _, comment := range group.List {
			text := strings.TrimSpace(strings.TrimPrefix(comment.Text, "//"))
			if !strings.HasPrefix(text, "go:generate ") {
				continue
			}
			span := b.span(pkg, comment.Pos(), comment.End())
			b.analysis.GenerateDirectives = append(b.analysis.GenerateDirectives, GenerateRecord{
				ID:     stableID("generate", fileID+"\x00"+fmt.Sprintf("%d", span.StartByte)),
				FileID: fileID, Directive: boundedDirective(strings.TrimPrefix(text, "go:generate "), b.profile.Limits.MaxStringBytes), Executed: false, Span: span,
			})
		}
	}
}

func boundedDirective(value string, limit int) string {
	value, _ = truncate(value, limit)
	return value
}

func (b *inventoryBuilder) addType(pkg *packages.Package, t types.Type) string {
	if t == nil {
		return ""
	}
	if id := b.typeIDs[t]; id != "" {
		return id
	}
	display := canonicalType(t)
	canonical := b.typeIdentity(pkg, t)
	id := stableID("type", canonical)
	b.typeIDs[t] = id
	if b.seenTypes[id] {
		return id
	}
	b.seenTypes[id] = true
	pkgPath, name, alias, named, args, underlying := typeDetails(t)
	record := TypeRecord{
		ID: id, Kind: typeKind(t), Canonical: canonical, Display: display,
		Package: pkgPath, Name: name, Alias: alias, Named: named, Underlying: underlying,
		Comparable: types.Comparable(t), Size: -1, Align: -1,
	}
	for _, arg := range args {
		record.TypeArgs = append(record.TypeArgs, b.addType(pkg, arg))
	}
	if parameter, ok := t.(*types.TypeParam); ok {
		record.Constraint = canonicalType(parameter.Constraint())
	}
	if structure, ok := t.Underlying().(*types.Struct); ok {
		for i := 0; i < structure.NumFields(); i++ {
			field := structure.Field(i)
			record.Fields = append(record.Fields, StructFieldRecord{
				Name: field.Name(), TypeID: b.addType(pkg, field.Type()),
				TagBase64: base64.StdEncoding.EncodeToString([]byte(structure.Tag(i))),
				Exported:  field.Exported(), Embedded: field.Embedded(),
			})
		}
	}
	if pkg.TypesSizes != nil {
		record.Size, record.Align = safeSize(pkg.TypesSizes, t)
	}
	b.analysis.Types = append(b.analysis.Types, record)
	return id
}

func safeSize(sizes types.Sizes, t types.Type) (size, align int64) {
	size, align = -1, -1
	defer func() {
		if recover() != nil {
			size, align = -1, -1
		}
	}()
	size = sizes.Sizeof(t)
	align = int64(sizes.Alignof(t))
	return size, align
}

func (b *inventoryBuilder) typeIdentity(pkg *packages.Package, t types.Type) string {
	return canonicalTypeIdentityWith(t, func(object *types.TypeName) string {
		base := typeObjectIdentity(object)
		if object == nil || object.Pkg() == nil || object.Parent() == object.Pkg().Scope() ||
			!object.Pos().IsValid() || pkg == nil || pkg.Fset == nil {
			return base
		}
		span := b.span(pkg, object.Pos(), object.Pos()+token.Pos(len(object.Name())))
		if span.Path == "" {
			return base
		}
		return base + ":" + span.Path + ":" + strconv.Itoa(span.StartByte)
	})
}

func (b *inventoryBuilder) addObject(pkg *packages.Package, object types.Object, declaration SourceSpan) string {
	return b.addObjectWithFallback(pkg, object, declaration, "")
}

func (b *inventoryBuilder) addObjectWithFallback(pkg *packages.Package, object types.Object, declaration SourceSpan, fallback string) string {
	if object == nil {
		return ""
	}
	object = objectOrigin(object)
	if identity := b.memberIdentity[object]; identity != "" {
		fallback = identity
	}
	pkgID := b.packageIDs[pkg]
	if object.Pkg() != nil && object.Pkg().Path() != pkg.PkgPath {
		pkgID = b.packagePathIDs[object.Pkg().Path()]
		if pkgID == "" {
			pkgID = b.packageIDs[pkg]
		}
	}
	if declaration.Path == "" && object.Pos().IsValid() && b.fileIDForPosition(pkg, object.Pos()) != "" {
		declaration = b.span(pkg, object.Pos(), object.Pos()+token.Pos(len(object.Name())))
	}
	key := objectRef{object: object, packageID: pkgID}
	if id := b.objectIDs[key]; id != "" {
		if declaration.Path != "" {
			for i := range b.analysis.Symbols {
				if b.analysis.Symbols[i].ID == id && b.analysis.Symbols[i].Declaration == nil {
					b.analysis.Symbols[i].Declaration = &declaration
					break
				}
			}
		}
		return id
	}
	declarationKey := ""
	if identity := b.memberIdentity[object]; identity != "" {
		declarationKey = identity
	} else if declaration.Path != "" {
		declarationKey = declaration.Path + "\x00" + strconv.Itoa(declaration.StartByte)
	} else if fallback != "" {
		declarationKey = fallback
	}
	id := stableID("symbol", objectCanonical(pkgID, object, declarationKey))
	b.objectIDs[key] = id
	if b.seenSymbols[id] {
		return id
	}
	b.seenSymbols[id] = true
	record := SymbolRecord{
		ID: id, PackageID: pkgID, Name: object.Name(), Kind: objectKind(object),
		TypeID: b.addType(pkg, object.Type()), Exported: object.Exported(),
	}
	if declaration.Path != "" {
		record.Declaration = &declaration
	}
	b.analysis.Symbols = append(b.analysis.Symbols, record)
	return id
}

func objectOrigin(object types.Object) types.Object {
	switch value := object.(type) {
	case *types.Var:
		return value.Origin()
	case *types.Func:
		return value.Origin()
	default:
		return object
	}
}

func (b *inventoryBuilder) indexDeclaredMembers(loaded []*packages.Package) {
	seen := map[types.Type]bool{}
	var indexType func(*packages.Package, types.Type)
	indexType = func(pkg *packages.Package, current types.Type) {
		switch value := current.(type) {
		case *types.Pointer:
			indexType(pkg, value.Elem())
		case *types.Alias:
			indexType(pkg, value.Origin().Rhs())
		case *types.Named:
			value = value.Origin()
			if seen[value] {
				return
			}
			seen[value] = true
			owner := b.typeIdentity(pkg, value)
			for i := 0; i < value.NumMethods(); i++ {
				method := value.Method(i).Origin()
				b.memberIdentity[method] = owner + "\x00method\x00" + strconv.Itoa(i)
			}
			switch underlying := value.Underlying().(type) {
			case *types.Struct:
				for i := 0; i < underlying.NumFields(); i++ {
					field := underlying.Field(i).Origin()
					b.memberIdentity[field] = owner + "\x00field\x00" + strconv.Itoa(i)
					if field.Embedded() {
						indexType(pkg, field.Type())
					}
				}
			case *types.Interface:
				underlying.Complete()
				for i := 0; i < underlying.NumExplicitMethods(); i++ {
					method := underlying.ExplicitMethod(i).Origin()
					b.memberIdentity[method] = owner + "\x00interface-method\x00" + strconv.Itoa(i)
				}
				for i := 0; i < underlying.NumEmbeddeds(); i++ {
					indexType(pkg, underlying.EmbeddedType(i))
				}
			}
		}
	}
	for _, pkg := range loaded {
		if pkg.Types == nil {
			continue
		}
		for _, name := range pkg.Types.Scope().Names() {
			if object, ok := pkg.Types.Scope().Lookup(name).(*types.TypeName); ok {
				indexType(pkg, object.Type())
			}
		}
	}
}

func (b *inventoryBuilder) addModule(module *packages.Module) (string, error) {
	if module == nil {
		return "", nil
	}
	replacementID := ""
	if module.Replace != nil {
		var err error
		if module.Replace.Version == "" && module.Replace.Dir != "" {
			replacementID, err = b.addLocalReplacement(module.Path, module.Replace)
		} else {
			replacementID, err = b.addModule(module.Replace)
		}
		if err != nil {
			return "", err
		}
	}
	canonical := module.Path + "\x00" + module.Version + "\x00replace\x00" + replacementID
	id := stableID("module", canonical)
	b.moduleIDs[canonical] = id
	if b.seenModules[id] {
		return id, nil
	}
	b.seenModules[id] = true
	record := ModuleRecord{ID: id, Path: module.Path, Version: module.Version, GoVersion: module.GoVersion, Main: module.Main}
	if replacementID != "" {
		record.ReplacementID = replacementID
	}
	if b.profile.VendorMode {
		record.VendorProvenance = "source://vendor/modules.txt"
	}
	b.analysis.Modules = append(b.analysis.Modules, record)
	return id, nil
}

func (b *inventoryBuilder) addLocalReplacement(logicalPath string, replacement *packages.Module) (string, error) {
	hash, err := hashTree(replacement.Dir, b.profile.Limits.MaxLocalHashBytes)
	if err != nil {
		return "", fmt.Errorf("hash local replacement for %s: %w", logicalPath, err)
	}
	canonical := logicalPath + "\x00local-replacement\x00" + hash
	id := stableID("module", canonical)
	if b.seenModules[id] {
		return id, nil
	}
	b.seenModules[id] = true
	b.analysis.Modules = append(b.analysis.Modules, ModuleRecord{
		ID: id, Path: logicalPath, GoVersion: replacement.GoVersion, LocalContentSHA256: hash,
	})
	return id, nil
}

func hashTree(root string, maxBytes int64) (string, error) {
	var entries []string
	var total int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink not allowed in local replacement: %s", path)
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := pathWithin(root, path)
		if err != nil {
			return err
		}
		hash, size, err := hashFile(path)
		if err != nil {
			return err
		}
		total += size
		if total > maxBytes {
			return fmt.Errorf("content exceeds %d-byte limit", maxBytes)
		}
		entries = append(entries, relative+"\x00"+hash)
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(entries)
	return hashBytes([]byte(strings.Join(entries, "\n"))), nil
}

func (b *inventoryBuilder) span(pkg *packages.Package, start, end token.Pos) SourceSpan {
	rawStart := tokenPositionFor(pkg.Fset, start, false)
	rawEnd := tokenPositionFor(pkg.Fset, end, false)
	display := tokenPositionFor(pkg.Fset, start, true)
	path := ""
	portable := ""
	if rawStart.Filename != "" {
		if value, err := b.portablePath(pkg, rawStart.Filename); err == nil {
			portable = value
			path = value
		}
	}
	displayPath := portable
	lineDirective := display.Filename != rawStart.Filename || display.Line != rawStart.Line || display.Column != rawStart.Column
	if lineDirective {
		displayPath = "line://" + b.logicalDisplayPath(display.Filename)
	}
	return SourceSpan{
		Path: path, StartByte: rawStart.Offset, EndByte: rawEnd.Offset,
		StartLine: rawStart.Line, StartColumn: rawStart.Column, EndLine: rawEnd.Line, EndColumn: rawEnd.Column,
		DisplayPath: displayPath, DisplayLine: display.Line, DisplayColumn: display.Column,
		LineDirective: lineDirective,
	}
}

func (b *inventoryBuilder) logicalDisplayPath(path string) string {
	if relative, err := filepath.Rel(b.sourceRoot, path); err == nil &&
		relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative) {
		return slash(relative)
	}
	return slash(filepath.Base(path))
}

func (b *inventoryBuilder) fileIDForPosition(pkg *packages.Package, pos token.Pos) string {
	position := tokenPositionFor(pkg.Fset, pos, false)
	return b.fileIDs[b.fileKey(pkg, position.Filename)]
}

func (b *inventoryBuilder) fileKey(pkg *packages.Package, path string) string {
	return b.packageIDs[pkg] + "\x00" + path
}

func (b *inventoryBuilder) addInitialization(pkg *packages.Package, record *PackageRecord) {
	for _, init := range pkg.TypesInfo.InitOrder {
		entry := InitializationRecord{Order: len(record.InitializationOrder), Kind: "variable", SymbolIDs: []string{}}
		for _, variable := range init.Lhs {
			entry.SymbolIDs = append(entry.SymbolIDs, b.addObjectForPackageID(record.ID, variable))
		}
		if position := pkg.Fset.PositionFor(init.Rhs.Pos(), false); position.IsValid() {
			entry.FileID = b.fileIDs[b.fileKey(pkg, position.Filename)]
			if entry.FileID != "" {
				entry.NodeID = syntaxNodeID(record.ID, entry.FileID, init.Rhs, b.span(pkg, init.Rhs.Pos(), init.Rhs.End()))
			}
		}
		record.InitializationOrder = append(record.InitializationOrder, entry)
	}
	for index, file := range pkg.Syntax {
		if index >= len(pkg.CompiledGoFiles) {
			break
		}
		fileID := b.fileIDs[b.fileKey(pkg, pkg.CompiledGoFiles[index])]
		if fileID == "" {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv != nil || function.Name.Name != "init" {
				continue
			}
			span := b.span(pkg, function.Pos(), function.End())
			record.InitializationOrder = append(record.InitializationOrder, InitializationRecord{
				Order: len(record.InitializationOrder), Kind: "init-function", FileID: fileID,
				NodeID: syntaxNodeID(record.ID, fileID, function, span), SymbolIDs: []string{},
			})
		}
	}
}

func (b *inventoryBuilder) addObjectForPackageID(pkgID string, object types.Object) string {
	object = objectOrigin(object)
	key := objectRef{object: object, packageID: pkgID}
	if id := b.objectIDs[key]; id != "" {
		return id
	}
	id := stableID("symbol", objectCanonical(pkgID, object, ""))
	b.objectIDs[key] = id
	if !b.seenSymbols[id] {
		b.seenSymbols[id] = true
		b.analysis.Symbols = append(b.analysis.Symbols, SymbolRecord{
			ID: id, PackageID: pkgID, Name: object.Name(), Kind: objectKind(object),
			TypeID: b.addTypeForUnknown(object.Type()), Exported: object.Exported(),
		})
	}
	return id
}

func (b *inventoryBuilder) addTypeForUnknown(t types.Type) string {
	if t == nil {
		return ""
	}
	if id := b.typeIDs[t]; id != "" {
		return id
	}
	display := canonicalType(t)
	canonical := canonicalTypeIdentity(t)
	id := stableID("type", canonical)
	b.typeIDs[t] = id
	if !b.seenTypes[id] {
		b.seenTypes[id] = true
		pkgPath, name, alias, named, _, underlying := typeDetails(t)
		b.analysis.Types = append(b.analysis.Types, TypeRecord{
			ID: id, Kind: typeKind(t), Canonical: canonical, Display: display,
			Package: pkgPath, Name: name, Alias: alias, Named: named,
			Underlying: underlying, Comparable: types.Comparable(t), Size: -1, Align: -1,
		})
	}
	return id
}

func (b *inventoryBuilder) block(category, message string, units, diagnostics []string) {
	b.addBlocker("inventory", category, message, units, diagnostics)
}

func (b *inventoryBuilder) migrationBlock(category, message string, units []string) {
	b.addBlocker("migration", category, message, units, nil)
}

func (b *inventoryBuilder) addBlocker(blocks, category, message string, units, diagnostics []string) {
	if units == nil {
		units = []string{}
	}
	if diagnostics == nil {
		diagnostics = []string{}
	}
	sort.Strings(units)
	sort.Strings(diagnostics)
	id := stableID("blocker", blocks+"\x00"+category+"\x00"+message+"\x00"+strings.Join(units, "\x00"))
	for _, existing := range b.analysis.Blockers {
		if existing.ID == id {
			return
		}
	}
	b.analysis.Blockers = append(b.analysis.Blockers, BlockerRecord{
		ID: id, Blocks: blocks, Category: category, Message: message, AffectedUnits: units, DiagnosticIDs: diagnostics,
	})
}

func (b *inventoryBuilder) recordCount() int {
	a := b.analysis
	return len(a.Modules) + len(a.Packages) + len(a.Files) + len(a.Types) + len(a.Symbols) + len(a.Nodes) +
		len(a.Constants) + len(a.Scopes) + len(a.Selections) + len(a.Calls) + len(a.MethodSets) +
		len(a.Instances) + len(a.Embeds) + len(a.GenerateDirectives) + len(a.Dependencies) +
		len(a.FeatureSites) + len(a.Diagnostics) + len(a.Blockers)
}

func (b *inventoryBuilder) finish() {
	a := b.analysis
	normalizeAnalysisCollections(a)
	sort.Slice(a.Modules, func(i, j int) bool { return a.Modules[i].ID < a.Modules[j].ID })
	sort.Slice(a.Packages, func(i, j int) bool { return a.Packages[i].ID < a.Packages[j].ID })
	sort.Slice(a.Files, func(i, j int) bool { return a.Files[i].ID < a.Files[j].ID })
	sort.Slice(a.Types, func(i, j int) bool { return a.Types[i].ID < a.Types[j].ID })
	sort.Slice(a.Symbols, func(i, j int) bool { return a.Symbols[i].ID < a.Symbols[j].ID })
	sort.Slice(a.Nodes, func(i, j int) bool { return a.Nodes[i].ID < a.Nodes[j].ID })
	sort.Slice(a.Constants, func(i, j int) bool { return a.Constants[i].ID < a.Constants[j].ID })
	sort.Slice(a.Scopes, func(i, j int) bool { return a.Scopes[i].ID < a.Scopes[j].ID })
	sort.Slice(a.Selections, func(i, j int) bool { return a.Selections[i].ID < a.Selections[j].ID })
	sort.Slice(a.Calls, func(i, j int) bool { return a.Calls[i].ID < a.Calls[j].ID })
	sort.Slice(a.MethodSets, func(i, j int) bool { return a.MethodSets[i].ID < a.MethodSets[j].ID })
	sort.Slice(a.Instances, func(i, j int) bool { return a.Instances[i].ID < a.Instances[j].ID })
	sort.Slice(a.Embeds, func(i, j int) bool { return a.Embeds[i].ID < a.Embeds[j].ID })
	sort.Slice(a.GenerateDirectives, func(i, j int) bool { return a.GenerateDirectives[i].ID < a.GenerateDirectives[j].ID })
	sort.Slice(a.Dependencies, func(i, j int) bool { return a.Dependencies[i].ID < a.Dependencies[j].ID })
	sort.Slice(a.FeatureSites, func(i, j int) bool { return a.FeatureSites[i].ID < a.FeatureSites[j].ID })
	sort.Slice(a.Diagnostics, func(i, j int) bool { return a.Diagnostics[i].ID < a.Diagnostics[j].ID })
	sort.Slice(a.Blockers, func(i, j int) bool { return a.Blockers[i].ID < a.Blockers[j].ID })
	a.RecordCounts = RecordCounts{
		Modules: len(a.Modules), Packages: len(a.Packages), Files: len(a.Files), Types: len(a.Types), Symbols: len(a.Symbols),
		Nodes: len(a.Nodes), Constants: len(a.Constants), Scopes: len(a.Scopes), Selections: len(a.Selections),
		Calls: len(a.Calls), MethodSets: len(a.MethodSets), Instances: len(a.Instances), Embeds: len(a.Embeds),
		GenerateDirectives: len(a.GenerateDirectives), Dependencies: len(a.Dependencies),
		FeatureSites: len(a.FeatureSites), Diagnostics: len(a.Diagnostics), Blockers: len(a.Blockers),
	}
	a.RecordCounts.Total = b.recordCount()
	a.InventoryComplete = true
	for _, blocker := range a.Blockers {
		if blocker.Blocks == "inventory" {
			a.InventoryComplete = false
			break
		}
	}
	a.MigrationReady = false
}

func normalizeAnalysisCollections(a *Analysis) {
	if a.Profile.EntryPatterns == nil {
		a.Profile.EntryPatterns = []string{}
	}
	if a.Profile.ArchitectureFeatures == nil {
		a.Profile.ArchitectureFeatures = []string{}
	}
	if a.Profile.BuildTags == nil {
		a.Profile.BuildTags = []string{}
	}
	if a.Profile.GOFLAGS == nil {
		a.Profile.GOFLAGS = []string{}
	}
	if a.Profile.GODEBUG == nil {
		a.Profile.GODEBUG = map[string]string{}
	}
	if a.Manifests == nil {
		a.Manifests = []ManifestRecord{}
	}
	if a.Modules == nil {
		a.Modules = []ModuleRecord{}
	}
	if a.Packages == nil {
		a.Packages = []PackageRecord{}
	}
	if a.Files == nil {
		a.Files = []FileRecord{}
	}
	if a.Types == nil {
		a.Types = []TypeRecord{}
	}
	if a.Symbols == nil {
		a.Symbols = []SymbolRecord{}
	}
	if a.Nodes == nil {
		a.Nodes = []NodeRecord{}
	}
	if a.Constants == nil {
		a.Constants = []ConstantRecord{}
	}
	if a.Scopes == nil {
		a.Scopes = []ScopeRecord{}
	}
	if a.Selections == nil {
		a.Selections = []SelectionRecord{}
	}
	if a.Calls == nil {
		a.Calls = []CallRecord{}
	}
	if a.MethodSets == nil {
		a.MethodSets = []MethodSetRecord{}
	}
	if a.Instances == nil {
		a.Instances = []InstanceRecord{}
	}
	if a.Embeds == nil {
		a.Embeds = []EmbedRecord{}
	}
	if a.GenerateDirectives == nil {
		a.GenerateDirectives = []GenerateRecord{}
	}
	if a.Dependencies == nil {
		a.Dependencies = []DependencyRecord{}
	}
	if a.FeatureSites == nil {
		a.FeatureSites = []FeatureSite{}
	}
	if a.Diagnostics == nil {
		a.Diagnostics = []DiagnosticRecord{}
	}
	if a.Blockers == nil {
		a.Blockers = []BlockerRecord{}
	}
	for i := range a.Packages {
		if a.Packages[i].FileIDs == nil {
			a.Packages[i].FileIDs = []string{}
		}
		if a.Packages[i].CompiledFileIDs == nil {
			a.Packages[i].CompiledFileIDs = []string{}
		}
		if a.Packages[i].ImportPackageIDs == nil {
			a.Packages[i].ImportPackageIDs = []string{}
		}
		if a.Packages[i].InitializationOrder == nil {
			a.Packages[i].InitializationOrder = []InitializationRecord{}
		}
		if a.Packages[i].DiagnosticIDs == nil {
			a.Packages[i].DiagnosticIDs = []string{}
		}
		for j := range a.Packages[i].InitializationOrder {
			if a.Packages[i].InitializationOrder[j].SymbolIDs == nil {
				a.Packages[i].InitializationOrder[j].SymbolIDs = []string{}
			}
		}
	}
	for i := range a.Types {
		if a.Types[i].TypeArgs == nil {
			a.Types[i].TypeArgs = []string{}
		}
		if a.Types[i].Fields == nil {
			a.Types[i].Fields = []StructFieldRecord{}
		}
	}
	for i := range a.Scopes {
		if a.Scopes[i].SymbolIDs == nil {
			a.Scopes[i].SymbolIDs = []string{}
		}
		if a.Scopes[i].Labels == nil {
			a.Scopes[i].Labels = []string{}
		}
	}
	for i := range a.Calls {
		if a.Calls[i].ArgumentTypeIDs == nil {
			a.Calls[i].ArgumentTypeIDs = []string{}
		}
	}
	for i := range a.MethodSets {
		if a.MethodSets[i].MethodSymbolIDs == nil {
			a.MethodSets[i].MethodSymbolIDs = []string{}
		}
	}
	for i := range a.Instances {
		if a.Instances[i].TypeArgIDs == nil {
			a.Instances[i].TypeArgIDs = []string{}
		}
	}
	for i := range a.Blockers {
		if a.Blockers[i].AffectedUnits == nil {
			a.Blockers[i].AffectedUnits = []string{}
		}
		if a.Blockers[i].DiagnosticIDs == nil {
			a.Blockers[i].DiagnosticIDs = []string{}
		}
	}
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func uniqueSorted(values []string) []string {
	set := stringSet(values)
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func moduleGoVersion(module *packages.Module) string {
	if module == nil {
		return ""
	}
	return module.GoVersion
}

func packageErrorCategory(kind packages.ErrorKind) string {
	switch kind {
	case packages.ListError:
		return "loader"
	case packages.ParseError:
		return "parser"
	case packages.TypeError:
		return "typechecker"
	default:
		return "unknown"
	}
}
