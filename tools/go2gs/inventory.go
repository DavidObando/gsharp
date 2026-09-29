// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"encoding/base64"
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/tools/go/packages"
)

type inventoryBuilder struct {
	analysis       *Analysis
	sourceRoot     string
	profile        Profile
	packageIDs     map[*packages.Package]string
	packagePathIDs map[string]string
	typeIDs        map[types.Type]string
	objectIDs      map[types.Object]string
	fileIDs        map[string]string
	moduleIDs      map[string]string
	seenModules    map[string]bool
	seenFiles      map[string]bool
	seenTypes      map[string]bool
	seenSymbols    map[string]bool
	seenMethodSets map[string]bool
	scopeIDs       map[*types.Scope]string
	scopeRanges    []scopeRange
	diagnosticSeq  int
}

func newInventoryBuilder(analysis *Analysis, sourceRoot string, profile Profile) *inventoryBuilder {
	return &inventoryBuilder{
		analysis: analysis, sourceRoot: sourceRoot, profile: profile,
		packageIDs: map[*packages.Package]string{}, packagePathIDs: map[string]string{}, typeIDs: map[types.Type]string{},
		objectIDs: map[types.Object]string{}, fileIDs: map[string]string{},
		moduleIDs: map[string]string{}, seenModules: map[string]bool{},
		seenFiles: map[string]bool{}, seenTypes: map[string]bool{}, seenSymbols: map[string]bool{},
		seenMethodSets: map[string]bool{}, scopeIDs: map[*types.Scope]string{},
	}
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
		message, truncated := truncate(sanitizeMessage(pkgErr.Msg, b.sourceRoot, b.profile.Limits.MaxStringBytes), b.profile.Limits.MaxStringBytes)
		id := stableID("diagnostic", pkgID+"\x00"+strconv.Itoa(int(pkgErr.Kind))+"\x00"+pkgErr.Pos+"\x00"+message)
		diagnostic := DiagnosticRecord{ID: id, Category: packageErrorCategory(pkgErr.Kind), Severity: "error", Message: message, PackageID: pkgID, Truncated: truncated}
		b.analysis.Diagnostics = append(b.analysis.Diagnostics, diagnostic)
		record.DiagnosticIDs = append(record.DiagnosticIDs, id)
		record.InventoryComplete = false
	}
	if !record.InventoryComplete {
		b.block("package-load", "package inventory is incomplete", []string{pkgID}, record.DiagnosticIDs)
	}

	if isSourcePackage(pkg, b.sourceRoot) {
		if err := b.addSourcePackage(pkg, &record); err != nil {
			return err
		}
	}

	for _, init := range pkg.TypesInfo.InitOrder {
		record.InitializationOrder = append(record.InitializationOrder, b.initCanonical(pkgID, init))
	}
	sort.Strings(record.DiagnosticIDs)
	b.analysis.Packages = append(b.analysis.Packages, record)
	return nil
}

func isSourcePackage(pkg *packages.Package, sourceRoot string) bool {
	for _, path := range pkg.CompiledGoFiles {
		if _, err := pathWithin(sourceRoot, path); err == nil {
			return true
		}
	}
	return false
}

func (b *inventoryBuilder) addSourcePackage(pkg *packages.Package, record *PackageRecord) error {
	compiled := stringSet(pkg.CompiledGoFiles)
	active := stringSet(pkg.GoFiles)
	embed := stringSet(pkg.EmbedFiles)
	all := append([]string{}, pkg.CompiledGoFiles...)
	all = append(all, pkg.GoFiles...)
	all = append(all, pkg.IgnoredFiles...)
	all = append(all, pkg.OtherFiles...)
	all = append(all, pkg.EmbedFiles...)
	all = uniqueSorted(all)
	newFiles := 0
	for _, path := range all {
		if b.fileIDs[b.fileKey(pkg, path)] == "" {
			newFiles++
		}
	}
	if len(b.seenFiles)+newFiles > b.profile.Limits.MaxFiles {
		return fmt.Errorf("file count exceeds limit %d", b.profile.Limits.MaxFiles)
	}
	if len(pkg.OtherFiles) > 0 {
		b.block("native", "selected package requires native, assembly, or CGo build inputs; M0 records them but does not authorize the native toolchain", []string{record.ID}, nil)
		record.InventoryComplete = false
	}
	for _, path := range all {
		role, reason := "active", ""
		switch {
		case embed[path]:
			role, reason = "embed", "selected by go:embed"
		case contains(pkg.OtherFiles, path):
			role, reason = "native", "selected non-Go build input"
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
		fileID, err := b.addFile(pkg, path, role, reason)
		if err != nil {
			return err
		}
		record.FileIDs = append(record.FileIDs, fileID)
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

func (b *inventoryBuilder) addFile(pkg *packages.Package, path, role, reason string) (string, error) {
	key := b.fileKey(pkg, path)
	if id := b.fileIDs[key]; id != "" {
		return id, nil
	}
	portable, err := b.portablePath(pkg, path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
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
		module := pkg.Module
		if module.Replace != nil {
			module = module.Replace
		}
		if relative, err := pathWithin(module.Dir, path); err == nil {
			version := module.Version
			if version == "" {
				version = "local"
			}
			return "module://" + module.Path + "@" + version + "/" + relative, nil
		}
	}
	if relative, err := pathWithin(runtimeGOROOT(), path); err == nil {
		return "goroot://" + relative, nil
	}
	return "", fmt.Errorf("selected path is outside declared source/module/GOROOT roots: %s", path)
}

func runtimeGOROOT() string {
	return runtime.GOROOT()
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
	arrayLengths := map[ast.Expr]bool{}
	ast.Inspect(file, func(node ast.Node) bool {
		if array, ok := node.(*ast.ArrayType); ok && array.Len != nil {
			arrayLengths[array.Len] = true
		}
		return true
	})
	ast.Inspect(file, func(node ast.Node) bool {
		if node == nil {
			return true
		}
		span := b.span(pkg, node.Pos(), node.End())
		nodeID := stableID("node", pkgID+"\x00"+fileID+"\x00"+fmt.Sprintf("%d:%d:%T", span.StartByte, span.EndByte, node))
		record := NodeRecord{ID: nodeID, PackageID: pkgID, FileID: fileID, Kind: fmt.Sprintf("%T", node), Span: span}
		record.ScopeID = b.scopeFor(pkgID, node.Pos())
		if expression, ok := node.(ast.Expr); ok {
			tv, exists := pkg.TypesInfo.Types[expression]
			if exists {
				record.OriginalTypeID = b.addType(pkg, tv.Type)
				record.EffectiveTypeID = record.OriginalTypeID
				record.Addressable = tv.Addressable()
				record.Assignable = tv.Assignable()
				record.IsType = tv.IsType()
				record.IsValue = tv.IsValue()
				record.IsNil = tv.IsNil()
				record.IsBuiltin = tv.IsBuiltin()
				if tv.Value != nil {
					b.addConstant(pkg, nodeID, expression, tv, span, arrayLengths[expression])
				}
			}
			if call, ok := expression.(*ast.CallExpr); ok {
				b.addCall(pkg, nodeID, call)
			}
		}
		if ident, ok := node.(*ast.Ident); ok {
			if object := pkg.TypesInfo.Defs[ident]; object != nil {
				record.DeclarationID = b.addObject(pkg, object, b.span(pkg, ident.Pos(), ident.End()))
			}
			if object := pkg.TypesInfo.Uses[ident]; object != nil {
				record.UseID = b.addObject(pkg, object, SourceSpan{})
			}
		}
		b.analysis.Nodes = append(b.analysis.Nodes, record)
		b.addFeatureSite(pkgID, fileID, node, nodeID, span)
		return true
	})
}

func (b *inventoryBuilder) addConstant(pkg *packages.Package, nodeID string, expr ast.Expr, tv types.TypeAndValue, span SourceSpan, arrayLength bool) {
	exact := tv.Value.ExactString()
	record := ConstantRecord{
		ID: stableID("constant", nodeID+"\x00"+exact), NodeID: nodeID,
		TypeID: b.addType(pkg, tv.Type), Category: constantCategory(tv.Type), Exact: exact,
		Untyped: isUntyped(tv.Type), Span: span,
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
	if ident, ok := call.Fun.(*ast.Ident); ok {
		if object := pkg.TypesInfo.Uses[ident]; object != nil {
			record.CalleeSymbolID = b.addObject(pkg, object, SourceSpan{})
			if _, ok := object.(*types.Builtin); ok {
				record.Kind = "builtin"
				record.Builtin = object.Name()
			}
		}
	}
	for _, argument := range call.Args {
		record.ArgumentTypeIDs = append(record.ArgumentTypeIDs, b.addType(pkg, pkg.TypesInfo.TypeOf(argument)))
	}
	b.analysis.Calls = append(b.analysis.Calls, record)
}

func (b *inventoryBuilder) addFeatureSite(pkgID, fileID string, node ast.Node, nodeID string, span SourceSpan) {
	feature := ""
	disposition := "inventoried"
	switch node.(type) {
	case *ast.GoStmt:
		feature = "goroutine"
	case *ast.DeferStmt:
		feature = "defer"
	case *ast.RangeStmt:
		feature = "range"
	case *ast.TypeSwitchStmt:
		feature = "type-switch"
	case *ast.IndexListExpr:
		feature = "generic-instantiation"
	case *ast.FuncLit:
		feature = "closure"
	case *ast.SendStmt:
		feature = "channel-send"
	}
	if feature == "" {
		return
	}
	b.analysis.FeatureSites = append(b.analysis.FeatureSites, FeatureSite{
		ID: stableID("feature", nodeID+"\x00"+feature), PackageID: pkgID, FileID: fileID,
		Feature: feature, Disposition: disposition, Span: span,
	})
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
		b.analysis.Selections = append(b.analysis.Selections, SelectionRecord{
			ID: stableID("selection", nodeID), NodeID: nodeID, Kind: selectionKind(item.selection.Kind()),
			ObjectID:       b.addObject(pkg, item.selection.Obj(), SourceSpan{}),
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
				record.MethodSymbolIDs = append(record.MethodSymbolIDs, b.addObject(pkg, method, SourceSpan{}))
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
			fileID := b.fileIDs[b.fileKey(pkg, path)]
			if fileID == "" {
				continue
			}
			logical := filepath.Base(path)
			if pkg.Dir != "" {
				if relative, err := pathWithin(pkg.Dir, path); err == nil {
					logical = relative
				}
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
	canonical := canonicalType(t)
	id := stableID("type", canonical)
	b.typeIDs[t] = id
	if b.seenTypes[id] {
		return id
	}
	b.seenTypes[id] = true
	pkgPath, name, alias, named, args, underlying := typeDetails(t)
	record := TypeRecord{
		ID: id, Kind: typeKind(t), Canonical: canonical, Display: canonical,
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

func (b *inventoryBuilder) addObject(pkg *packages.Package, object types.Object, declaration SourceSpan) string {
	if object == nil {
		return ""
	}
	if id := b.objectIDs[object]; id != "" {
		return id
	}
	declarationKey := ""
	if declaration.Path != "" {
		declarationKey = declaration.Path + "\x00" + strconv.Itoa(declaration.StartByte)
	}
	pkgID := b.packageIDs[pkg]
	if object.Pkg() != nil && object.Pkg().Path() != pkg.PkgPath {
		pkgID = b.packagePathIDs[object.Pkg().Path()]
		if pkgID == "" {
			pkgID = b.packageIDs[pkg]
		}
	}
	id := stableID("symbol", objectCanonical(pkgID, object, declarationKey))
	b.objectIDs[object] = id
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

func (b *inventoryBuilder) addModule(module *packages.Module) (string, error) {
	if module == nil {
		return "", nil
	}
	canonical := module.Path + "\x00" + module.Version
	if module.Replace != nil {
		canonical += "\x00replace\x00" + module.Replace.Path + "\x00" + module.Replace.Version
	}
	id := stableID("module", canonical)
	b.moduleIDs[canonical] = id
	if b.seenModules[id] {
		return id, nil
	}
	b.seenModules[id] = true
	record := ModuleRecord{ID: id, Path: module.Path, Version: module.Version, GoVersion: module.GoVersion, Main: module.Main}
	if module.Replace != nil {
		replacementID, err := b.addModule(module.Replace)
		if err != nil {
			return "", err
		}
		record.ReplacementID = replacementID
		if module.Replace.Version == "" && module.Replace.Dir != "" {
			hash, err := hashTree(module.Replace.Dir, b.profile.Limits.MaxLocalHashBytes)
			if err != nil {
				return "", fmt.Errorf("hash local replacement %s: %w", module.Replace.Path, err)
			}
			record.LocalContentSHA256 = hash
		}
	}
	if b.profile.VendorMode {
		record.VendorProvenance = "source://vendor/modules.txt"
	}
	b.analysis.Modules = append(b.analysis.Modules, record)
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
	lineDirective := display.Filename != rawStart.Filename || display.Line != rawStart.Line
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

func (b *inventoryBuilder) initCanonical(pkgID string, init *types.Initializer) string {
	lhs := make([]string, 0, len(init.Lhs))
	for _, variable := range init.Lhs {
		lhs = append(lhs, b.addObjectForPackageID(pkgID, variable))
	}
	return strings.Join(lhs, ",") + "=" + types.ExprString(init.Rhs)
}

func (b *inventoryBuilder) addObjectForPackageID(pkgID string, object types.Object) string {
	if id := b.objectIDs[object]; id != "" {
		return id
	}
	id := stableID("symbol", objectCanonical(pkgID, object, ""))
	b.objectIDs[object] = id
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
	canonical := canonicalType(t)
	id := stableID("type", canonical)
	b.typeIDs[t] = id
	if !b.seenTypes[id] {
		b.seenTypes[id] = true
		pkgPath, name, alias, named, _, underlying := typeDetails(t)
		b.analysis.Types = append(b.analysis.Types, TypeRecord{
			ID: id, Kind: typeKind(t), Canonical: canonical, Display: canonical,
			Package: pkgPath, Name: name, Alias: alias, Named: named,
			Underlying: underlying, Comparable: types.Comparable(t), Size: -1, Align: -1,
		})
	}
	return id
}

func (b *inventoryBuilder) block(category, message string, units, diagnostics []string) {
	if units == nil {
		units = []string{}
	}
	if diagnostics == nil {
		diagnostics = []string{}
	}
	sort.Strings(units)
	sort.Strings(diagnostics)
	id := stableID("blocker", category+"\x00"+message+"\x00"+strings.Join(units, "\x00"))
	for _, existing := range b.analysis.Blockers {
		if existing.ID == id {
			return
		}
	}
	b.analysis.Blockers = append(b.analysis.Blockers, BlockerRecord{
		ID: id, Category: category, Message: message, AffectedUnits: units, DiagnosticIDs: diagnostics,
	})
}

func (b *inventoryBuilder) recordCount() int {
	a := b.analysis
	return len(a.Packages) + len(a.Files) + len(a.Types) + len(a.Symbols) + len(a.Nodes) +
		len(a.Constants) + len(a.Scopes) + len(a.Selections) + len(a.Calls) + len(a.MethodSets) +
		len(a.Instances) + len(a.Embeds) + len(a.GenerateDirectives) + len(a.Dependencies) +
		len(a.FeatureSites) + len(a.Diagnostics) + len(a.Blockers)
}

func (b *inventoryBuilder) finish() {
	a := b.analysis
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
		Packages: len(a.Packages), Files: len(a.Files), Types: len(a.Types), Symbols: len(a.Symbols),
		Nodes: len(a.Nodes), Constants: len(a.Constants), Scopes: len(a.Scopes), Selections: len(a.Selections),
		Calls: len(a.Calls), MethodSets: len(a.MethodSets), Instances: len(a.Instances), Embeds: len(a.Embeds),
		GenerateDirectives: len(a.GenerateDirectives), Dependencies: len(a.Dependencies),
		FeatureSites: len(a.FeatureSites), Diagnostics: len(a.Diagnostics), Blockers: len(a.Blockers),
	}
	a.RecordCounts.Total = b.recordCount()
	a.InventoryComplete = len(a.Blockers) == 0
	a.MigrationReady = false
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
