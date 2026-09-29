// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/tools/go/packages"
)

var requiredRecordKinds = []string{
	"blocker", "call", "constant", "dependency", "diagnostic", "embed", "feature",
	"file", "generate", "instance", "methodSet", "module", "node", "package",
	"scope", "selection", "symbol", "type",
}

func analyze(ctx context.Context, sourceRoot, outRoot string, profile Profile) (Analysis, bool, error) {
	profileBytes, err := json.Marshal(profile)
	if err != nil {
		return Analysis{}, false, err
	}
	executable, err := exec.LookPath("go")
	if err != nil {
		return Analysis{}, false, errors.New("Go executable not found")
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return Analysis{}, false, err
	}
	goHash, _, err := hashFile(executable)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("hash Go executable: %w", err)
	}
	self, err := os.Executable()
	if err != nil {
		return Analysis{}, false, err
	}
	helperHash, _, err := hashFile(self)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("hash helper: %w", err)
	}

	workRoot := filepath.Join(outRoot, ".go2gs-work")
	if err := os.RemoveAll(workRoot); err != nil {
		return Analysis{}, false, err
	}
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		return Analysis{}, false, err
	}
	defer os.RemoveAll(workRoot)

	bootstrapEnv := bootstrapEnvironment(workRoot, executable)
	versionResult, err := runProcess(ctx, 15*time.Second, profile.Limits.MaxLogBytes, sourceRoot, executable, []string{"version"}, bootstrapEnv)
	if err != nil {
		return Analysis{}, false, err
	}
	actualVersion := parseGoVersion(versionResult.Stdout)
	gorootResult, err := runProcess(ctx, 15*time.Second, profile.Limits.MaxLogBytes, sourceRoot, executable, []string{"env", "GOROOT"}, bootstrapEnv)
	if err != nil {
		return Analysis{}, false, err
	}
	if gorootResult.ExitCode != 0 {
		return Analysis{}, false, fmt.Errorf("resolve selected Go GOROOT: %s", strings.TrimSpace(gorootResult.Stderr))
	}
	targetGOROOT, err := secureRoot(strings.TrimSpace(gorootResult.Stdout))
	if err != nil {
		return Analysis{}, false, fmt.Errorf("selected Go GOROOT: %w", err)
	}
	gorootVersionHash, _, err := hashFile(filepath.Join(targetGOROOT, "VERSION"))
	if err != nil {
		return Analysis{}, false, fmt.Errorf("hash selected Go GOROOT VERSION: %w", err)
	}
	env, err := sanitizedEnvironment(profile, workRoot, targetGOROOT, executable)
	if err != nil {
		return Analysis{}, false, err
	}

	actualCommit := sourceCommit(ctx, sourceRoot, profile.Limits.MaxLogBytes)
	analysis := Analysis{
		Schema: SchemaHandshake{Name: schemaName, Version: schemaVersion, RequiredRecordKinds: append([]string{}, requiredRecordKinds...)},
		Tool:   VersionIdentity{Version: toolVersion, SHA256: helperHash},
		Helper: VersionIdentity{Version: helperVersion, SHA256: helperHash},
		Profile: ProfileSnapshot{
			ID: profile.ID, SHA256: hashBytes(profileBytes),
			ExpectedSourceCommit: profile.ExpectedSourceCommit, ActualSourceCommit: actualCommit,
			EntryPatterns: append([]string{}, profile.EntryPatterns...), LoadTests: profile.LoadTests,
			GOOS: profile.GOOS, GOARCH: profile.GOARCH,
			ArchitectureFeatures: append([]string{}, profile.ArchitectureFeatures...),
			BuildTags:            append([]string{}, profile.BuildTags...), CGOEnabled: profile.CGOEnabled,
			GOFLAGS: append([]string{}, profile.GOFLAGS...), GOEXPERIMENT: profile.GOEXPERIMENT,
			GODEBUG: copyMap(profile.GODEBUG), ModuleMode: profile.ModuleMode,
			VendorMode: profile.VendorMode, WorkspaceMode: profile.WorkspaceMode,
			Offline: profile.Offline, AllowNetwork: profile.AllowNetwork,
			GeneratorsExecuted: false, TargetBinariesExecuted: false,
			TrustBoundary: "go/packages may execute the selected Go command, compiler, assembler, linker metadata tools, and CGo toolchain; target binaries, tests, init functions, generators, and scripts are never executed",
			Limits:        profile.Limits,
		},
		Toolchain: ToolchainProvenance{
			RequestedVersion: profile.RequestedGoVersion, ActualVersion: actualVersion,
			ExecutableSHA256: goHash, ExecutableName: filepath.Base(executable),
			GOROOTIdentity:      stableID("goroot", actualVersion+"\x00"+goHash+"\x00"+gorootVersionHash),
			GOROOTVersionSHA256: gorootVersionHash,
			GOROOTSource:        "selected executable: go env GOROOT (path intentionally omitted)",
			AutoDownload:        false,
		},
	}

	builder := newInventoryBuilder(&analysis, sourceRoot, targetGOROOT, profile)
	if err := builder.collectManifests(); err != nil {
		return Analysis{}, false, err
	}
	analysis.Profile.SourceRootIdentity = sourceIdentity(actualCommit, analysis.Manifests)
	if actualVersion != profile.RequestedGoVersion {
		builder.block("toolchain", fmt.Sprintf("profile requests Go %s but verified executable is Go %s; automatic toolchain download and silent upgrade are disabled", profile.RequestedGoVersion, actualVersion), nil, nil)
		builder.finish()
		return analysis, false, nil
	}
	if profile.ExpectedSourceCommit != "" && actualCommit != profile.ExpectedSourceCommit {
		builder.block("source", fmt.Sprintf("profile requires source commit %s but checkout is %s", profile.ExpectedSourceCommit, displayMissing(actualCommit)), nil, nil)
		builder.finish()
		return analysis, false, nil
	}
	mode := packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
		packages.NeedEmbedFiles | packages.NeedEmbedPatterns | packages.NeedImports | packages.NeedDeps |
		packages.NeedExportFile | packages.NeedTypes | packages.NeedSyntax |
		packages.NeedTypesInfo | packages.NeedTypesSizes | packages.NeedModule |
		packages.NeedForTest
	buildFlags := []string{}
	if len(profile.BuildTags) > 0 {
		buildFlags = append(buildFlags, "-tags="+strings.Join(profile.BuildTags, ","))
	}
	config := &packages.Config{
		Context:    ctx,
		Mode:       mode,
		Dir:        sourceRoot,
		Env:        env,
		BuildFlags: buildFlags,
		Tests:      profile.LoadTests,
	}
	loaded, loadErr := packages.Load(config, profile.EntryPatterns...)
	if loadErr != nil {
		builder.block("loader", sanitizeMessage(loadErr.Error(), sourceRoot, profile.Limits.MaxStringBytes), nil, nil)
	}
	if !profile.CGOEnabled {
		cgoConfig := *config
		cgoConfig.Mode = packages.NeedName | packages.NeedFiles
		cgoConfig.Env = replaceEnvironment(config.Env, "CGO_ENABLED", "1")
		cgoPackages, _ := packages.Load(&cgoConfig, profile.EntryPatterns...)
		for _, pkg := range cgoPackages {
			cgo, err := selectedPackageImportsC(pkg)
			if err != nil {
				return Analysis{}, false, err
			}
			if cgo {
				builder.block("cgo", "selected package imports C but CGO_ENABLED=0; native preprocessing is not available in this profile", nil, nil)
				break
			}
		}
	}
	if len(loaded) == 0 {
		builder.block("loader", "the requested entry patterns selected no loadable packages under the pinned profile", nil, nil)
	}

	all := collectPackages(loaded)
	if len(all) > profile.Limits.MaxPackages {
		return Analysis{}, false, fmt.Errorf("loaded package count %d exceeds limit %d", len(all), profile.Limits.MaxPackages)
	}
	builder.indexPackages(all)
	for _, pkg := range all {
		if err := ctx.Err(); err != nil {
			return Analysis{}, false, err
		}
		if err := builder.addPackage(pkg); err != nil {
			return Analysis{}, false, err
		}
		if builder.recordCount() > profile.Limits.MaxRecords {
			return Analysis{}, false, fmt.Errorf("record count exceeds limit %d", profile.Limits.MaxRecords)
		}
	}
	builder.finish()
	return analysis, analysis.InventoryComplete, nil
}

func replaceEnvironment(env []string, key, value string) []string {
	prefix := key + "="
	result := append([]string{}, env...)
	for i, entry := range result {
		if strings.HasPrefix(entry, prefix) {
			result[i] = prefix + value
			return result
		}
	}
	return append(result, prefix+value)
}

func collectPackages(roots []*packages.Package) []*packages.Package {
	seen := map[*packages.Package]bool{}
	var result []*packages.Package
	var visit func(*packages.Package)
	visit = func(pkg *packages.Package) {
		if pkg == nil || seen[pkg] {
			return
		}
		seen[pkg] = true
		result = append(result, pkg)
		keys := make([]string, 0, len(pkg.Imports))
		for key := range pkg.Imports {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			visit(pkg.Imports[key])
		}
	}
	for _, root := range roots {
		visit(root)
	}
	sort.Slice(result, func(i, j int) bool {
		return packageCanonical(result[i]) < packageCanonical(result[j])
	})
	return result
}

func packageCanonical(pkg *packages.Package) string {
	files := append([]string{}, pkg.CompiledGoFiles...)
	for i := range files {
		files[i] = filepath.Base(files[i])
	}
	sort.Strings(files)
	module := ""
	if pkg.Module != nil {
		module = pkg.Module.Path + "@" + pkg.Module.Version
		if pkg.Module.Replace != nil {
			if pkg.Module.Replace.Version == "" {
				module += "=>local"
			} else {
				module += "=>" + pkg.Module.Replace.Path + "@" + pkg.Module.Replace.Version
			}
		}
	}
	return module + "\x00" + pkg.PkgPath + "\x00" + packageVariant(pkg) + "\x00" + strings.Join(files, "\x00")
}

func packageVariant(pkg *packages.Package) string {
	switch {
	case pkg.ForTest == "":
		return "ordinary"
	case pkg.Name == "main" && strings.HasSuffix(pkg.PkgPath, ".test"):
		return "synthetic-test-main"
	case strings.HasSuffix(pkg.PkgPath, "_test"):
		return "external-test"
	default:
		return "in-package-test"
	}
}

func parseGoVersion(output string) string {
	fields := strings.Fields(output)
	for _, field := range fields {
		if strings.HasPrefix(field, "go1.") {
			return strings.TrimPrefix(field, "go")
		}
	}
	return strings.TrimSpace(output)
}

func sourceCommit(ctx context.Context, root string, maxOutput int) string {
	git, err := exec.LookPath("git")
	if err != nil {
		return ""
	}
	git, err = filepath.Abs(git)
	if err != nil {
		return ""
	}
	result, err := runProcess(ctx, 10*time.Second, maxOutput, root, git, []string{"-C", root, "rev-parse", "HEAD"}, []string{"PATH=" + selectedPath(git)})
	if err != nil || result.ExitCode != 0 {
		return ""
	}
	return strings.TrimSpace(result.Stdout)
}

func sourceIdentity(commit string, manifests []ManifestRecord) string {
	var parts []string
	if commit != "" {
		parts = append(parts, "commit="+commit)
	}
	for _, manifest := range manifests {
		parts = append(parts, manifest.Kind+"\x00"+manifest.Path+"\x00"+manifest.SHA256)
	}
	return stableID("source", strings.Join(parts, "\x00"))
}

func sanitizeMessage(message, sourceRoot string, max int) string {
	message = strings.ReplaceAll(message, sourceRoot, "<source>")
	message, _ = truncate(message, max)
	return message
}

func copyMap(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func displayMissing(value string) string {
	if value == "" {
		return "<not a git checkout>"
	}
	return value
}

func generatedFile(file *ast.File) bool {
	return ast.IsGenerated(file)
}

func tokenPositionFor(fset *token.FileSet, pos token.Pos, adjusted bool) token.Position {
	if fset == nil || pos == token.NoPos {
		return token.Position{}
	}
	return fset.PositionFor(pos, adjusted)
}
