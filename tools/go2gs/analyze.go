// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/token"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	return analyzeWithSnapshotHook(ctx, sourceRoot, outRoot, profile, nil)
}

func analyzeWithSnapshotHook(ctx context.Context, sourceRoot, outRoot string, profile Profile, afterSnapshot func()) (Analysis, bool, error) {
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
	cCompiler, cCompilerHash, err := resolveCCompiler(profile)
	if err != nil {
		return Analysis{}, false, err
	}
	profileIdentity := profile
	if cCompiler != "" {
		profileIdentity.CCompiler = filepath.Base(profile.CCompiler) + "@sha256:" + cCompilerHash
	}
	profileBytes, err := json.Marshal(profileIdentity)
	if err != nil {
		return Analysis{}, false, err
	}

	workRoot := filepath.Join(outRoot, ".go2gs-work")
	if err := os.RemoveAll(workRoot); err != nil {
		return Analysis{}, false, err
	}
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		return Analysis{}, false, err
	}
	defer os.RemoveAll(workRoot)
	blockedToolsRoot := filepath.Join(workRoot, "blocked-tools")
	if err := os.Mkdir(blockedToolsRoot, 0o500); err != nil {
		return Analysis{}, false, err
	}

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
	env, err := sanitizedEnvironment(profile, workRoot, targetGOROOT, executable, cCompiler)
	if err != nil {
		return Analysis{}, false, err
	}

	actualCommit, sourceCommitErr := sourceCommit(sourceRoot)
	toolchain := ToolchainProvenance{
		RequestedVersion: profile.RequestedGoVersion, ActualVersion: actualVersion,
		ExecutableSHA256: goHash, ExecutableName: filepath.Base(executable),
		GOROOTIdentity:      stableID("goroot", actualVersion+"\x00"+goHash+"\x00"+gorootVersionHash),
		GOROOTVersionSHA256: gorootVersionHash,
		GOROOTSource:        "selected executable: go env GOROOT (path intentionally omitted)",
		AutoDownload:        false,
	}
	if cCompiler != "" {
		toolchain.CCompilerName = filepath.Base(profile.CCompiler)
		toolchain.CCompilerSHA256 = cCompilerHash
	}
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
		Toolchain: toolchain,
	}

	builder := newInventoryBuilder(&analysis, sourceRoot, targetGOROOT, profile)
	if err := builder.collectManifests(); err != nil {
		return Analysis{}, false, err
	}
	analysis.Profile.SourceRootIdentity = sourceIdentity(actualCommit, analysis.Manifests)
	if sourceCommitErr != nil {
		builder.block("source-metadata", sourceCommitErr.Error(), nil, nil)
		builder.finish()
		return analysis, false, nil
	}
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
	preflightConfig := *config
	preflightConfig.Mode = packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
		packages.NeedEmbedFiles | packages.NeedEmbedPatterns | packages.NeedImports |
		packages.NeedDeps | packages.NeedModule | packages.NeedForTest
	if !profile.CGOEnabled {
		preflightConfig.Env = replaceEnvironment(config.Env, "CGO_ENABLED", "1")
	}
	preflight, _ := packages.Load(&preflightConfig, profile.EntryPatterns...)
	preflight = collectPackages(preflight)
	if !profile.CGOEnabled {
		for _, pkg := range preflight {
			importsC, err := selectedPackageImportsC(pkg)
			if err != nil {
				return Analysis{}, false, err
			}
			if importsC {
				builder.block("cgo", "selected package imports C but CGO_ENABLED=0; native preprocessing is not available in this profile", nil, nil)
			}
		}
	}
	sourceSnapshot, err := snapshotPackageInputs(preflight, sourceRoot, profile.Limits)
	if err != nil {
		return Analysis{}, false, err
	}
	config.Overlay = sourceSnapshot.overlay
	builder.sourceSnapshot = sourceSnapshot.data
	builder.snapshotPortable = sourceSnapshot.portable
	if afterSnapshot != nil {
		afterSnapshot()
	}
	loaded, loadErr := packages.Load(config, profile.EntryPatterns...)
	pkgConfigPath := unavailableToolPath(workRoot, "pkg-config")
	if sanitizeUnavailableToolFailure(loaded, pkgConfigPath) ||
		(loadErr != nil && strings.Contains(loadErr.Error(), pkgConfigPath)) {
		builder.block("pkg-config", "selected package requires #cgo pkg-config, but M0 has no approved pkg-config executable or provenance model", nil, nil)
	}
	if loadErr != nil {
		message := strings.ReplaceAll(loadErr.Error(), pkgConfigPath, "<disabled-pkg-config>")
		builder.block("loader", sanitizeMessage(message, sourceRoot, profile.Limits.MaxStringBytes), nil, nil)
	}
	if len(loaded) == 0 {
		builder.block("loader", "the requested entry patterns selected no loadable packages under the pinned profile", nil, nil)
	}

	all := collectPackages(loaded)
	builder.inputDrift = verifyPackageInputs(sourceSnapshot, all, sourceRoot)
	builder.snapshotFiles = sourceSnapshot.packageFiles
	builder.snapshotRoles = sourceSnapshot.packageRoles
	if len(builder.inputDrift) > 0 {
		builder.block("input-drift", "selected package inputs changed while loading", nil, nil)
	}
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

type snapshottedInput struct {
	data []byte
	info os.FileInfo
}

type packageInputSnapshot struct {
	data         map[string][]byte
	overlay      map[string][]byte
	files        map[string]snapshottedInput
	packageFiles map[string][]string
	packageRoles map[string]map[string]string
	fileOwners   map[string]map[string]bool
	portable     map[string]string
}

func snapshotPackageInputs(loaded []*packages.Package, sourceRoot string, limits Limits) (packageInputSnapshot, error) {
	result := packageInputSnapshot{
		data:         map[string][]byte{},
		overlay:      map[string][]byte{},
		files:        map[string]snapshottedInput{},
		packageFiles: map[string][]string{},
		packageRoles: map[string]map[string]string{},
		fileOwners:   map[string]map[string]bool{},
		portable:     map[string]string{},
	}
	directories := map[string]map[string]bool{}
	for _, pkg := range loaded {
		key := packageInputKey(pkg)
		result.packageRoles[key] = packageInputRoles(pkg)
		for _, path := range packageInputPaths(pkg, sourceRoot) {
			result.packageFiles[key] = append(result.packageFiles[key], path)
			if result.fileOwners[path] == nil {
				result.fileOwners[path] = map[string]bool{}
			}
			result.fileOwners[path][key] = true
			if filepath.Ext(path) == ".go" {
				directory := filepath.Dir(path)
				if directories[directory] == nil {
					directories[directory] = map[string]bool{}
				}
				directories[directory][key] = true
			}
		}
		result.packageFiles[key] = uniqueSorted(result.packageFiles[key])
	}
	sortedDirectories := make([]string, 0, len(directories))
	for directory := range directories {
		sortedDirectories = append(sortedDirectories, directory)
	}
	sort.Strings(sortedDirectories)
	for _, directory := range sortedDirectories {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return packageInputSnapshot{}, fmt.Errorf("snapshot source directory: %w", err)
		}
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" {
				continue
			}
			path := filepath.Join(directory, entry.Name())
			if result.fileOwners[path] == nil {
				result.fileOwners[path] = map[string]bool{}
			}
			for owner := range directories[directory] {
				result.fileOwners[path][owner] = true
			}
		}
	}
	paths := make([]string, 0, len(result.fileOwners))
	for path := range result.fileOwners {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	var total int64
	for _, path := range paths {
		if len(result.files) >= limits.MaxFiles || total >= limits.MaxLocalHashBytes {
			return packageInputSnapshot{}, fmt.Errorf("input snapshot exceeds configured limits")
		}
		initialInfo, err := os.Lstat(path)
		if err != nil {
			return packageInputSnapshot{}, fmt.Errorf("snapshot input %s: %w", filepath.Base(path), err)
		}
		data, err := readBoundedRegularFile(path, limits.MaxLocalHashBytes-total)
		if err != nil {
			return packageInputSnapshot{}, fmt.Errorf("snapshot input %s: %w", filepath.Base(path), err)
		}
		finalInfo, err := os.Lstat(path)
		if err != nil || !finalInfo.Mode().IsRegular() || !os.SameFile(initialInfo, finalInfo) {
			return packageInputSnapshot{}, fmt.Errorf("snapshot input changed while reading: %s", filepath.Base(path))
		}
		total += int64(len(data))
		result.data[path] = data
		result.files[path] = snapshottedInput{data: data, info: finalInfo}
		relative, _ := pathWithin(sourceRoot, path)
		result.portable[path] = "source://" + relative
		if filepath.Ext(path) == ".go" {
			result.overlay[path] = data
		}
	}
	return result, nil
}

func packageInputKey(pkg *packages.Package) string {
	return pkg.PkgPath + "\x00" + pkg.ForTest + "\x00" + packageVariant(pkg)
}

func packageInputPaths(pkg *packages.Package, sourceRoot string) []string {
	files := append([]string{}, pkg.GoFiles...)
	files = append(files, pkg.CompiledGoFiles...)
	files = append(files, pkg.IgnoredFiles...)
	files = append(files, pkg.OtherFiles...)
	files = append(files, pkg.EmbedFiles...)
	var result []string
	for _, path := range uniqueSorted(files) {
		if _, err := pathWithin(sourceRoot, path); err == nil {
			result = append(result, path)
		}
	}
	return result
}

func packageInputRoles(pkg *packages.Package) map[string]string {
	roles := map[string]string{}
	for _, path := range pkg.GoFiles {
		roles[path] = "active"
	}
	for _, path := range pkg.CompiledGoFiles {
		roles[path] = "compiled"
	}
	for _, path := range pkg.IgnoredFiles {
		roles[path] = "ignored"
	}
	for _, path := range pkg.OtherFiles {
		roles[path] = "native"
	}
	for _, path := range pkg.EmbedFiles {
		roles[path] = "embed"
	}
	return roles
}

func verifyPackageInputs(snapshot packageInputSnapshot, loaded []*packages.Package, sourceRoot string) map[string]bool {
	drift := map[string]bool{}
	actual := map[string][]string{}
	for _, pkg := range loaded {
		actual[packageInputKey(pkg)] = packageInputPaths(pkg, sourceRoot)
	}
	keys := map[string]bool{}
	for key := range snapshot.packageFiles {
		keys[key] = true
	}
	for key := range actual {
		keys[key] = true
	}
	for key := range keys {
		if !slices.Equal(snapshot.packageFiles[key], actual[key]) {
			drift[key] = true
		}
	}
	for path, captured := range snapshot.files {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || !os.SameFile(captured.info, info) {
			for owner := range snapshot.fileOwners[path] {
				drift[owner] = true
			}
			continue
		}
		data, err := readBoundedRegularFile(path, int64(len(captured.data))+1)
		if err != nil || !bytes.Equal(data, captured.data) {
			for owner := range snapshot.fileOwners[path] {
				drift[owner] = true
			}
		}
	}
	return drift
}

func resolveCCompiler(profile Profile) (string, string, error) {
	if !profile.CGOEnabled {
		if profile.CCompiler != "" {
			return "", "", errors.New("cCompiler is only valid when cgoEnabled is true")
		}
		return "", "", nil
	}
	if err := validateCompilerPath(profile.CCompiler); err != nil {
		return "", "", err
	}
	path, err := filepath.EvalSymlinks(profile.CCompiler)
	if err != nil {
		return "", "", fmt.Errorf("resolve C compiler: %w", err)
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return "", "", fmt.Errorf("resolve C compiler: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return "", "", fmt.Errorf("C compiler is not a regular executable: %s", filepath.Base(path))
	}
	hash, _, err := hashFile(path)
	if err != nil {
		return "", "", fmt.Errorf("hash C compiler: %w", err)
	}
	return path, hash, nil
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

func sourceCommit(root string) (string, error) {
	gitPath := filepath.Join(root, ".git")
	info, err := os.Lstat(gitPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("inspect repository metadata: %w", err)
	}
	gitDir := gitPath
	commonDir := gitDir
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return "", errors.New("repository .git metadata is neither a directory nor a regular gitdir file")
		}
		data, err := readBoundedRegularFile(gitPath, 4096)
		if err != nil {
			return "", fmt.Errorf("read repository gitdir metadata: %w", err)
		}
		value := strings.TrimSpace(string(data))
		if strings.ContainsAny(value, "\r\n\x00") || !strings.HasPrefix(value, "gitdir: ") {
			return "", errors.New("repository gitdir metadata is malformed")
		}
		gitDir = strings.TrimSpace(strings.TrimPrefix(value, "gitdir: "))
		if gitDir == "" {
			return "", errors.New("repository gitdir metadata has an empty target")
		}
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(root, gitDir)
		}
		gitDir, err = filepath.Abs(gitDir)
		if err != nil {
			return "", fmt.Errorf("resolve repository gitdir metadata: %w", err)
		}
		if err := rejectSymlinkPath(gitDir); err != nil {
			return "", fmt.Errorf("repository gitdir metadata: %w", err)
		}
		targetInfo, err := os.Lstat(gitDir)
		if err != nil || !targetInfo.IsDir() {
			return "", errors.New("repository gitdir target is not a directory")
		}
		commonDir, err = validateGitDirIndirection(root, gitPath, gitDir)
		if err != nil {
			return "", err
		}
	} else if err := rejectSymlinkPath(gitDir); err != nil {
		return "", fmt.Errorf("repository metadata: %w", err)
	}
	head, err := readBoundedRegularFile(filepath.Join(gitDir, "HEAD"), 4096)
	if err != nil {
		return "", fmt.Errorf("read repository HEAD: %w", err)
	}
	value := strings.TrimSpace(string(head))
	if validCommitID(value) {
		return value, nil
	}
	if !strings.HasPrefix(value, "ref: ") {
		return "", errors.New("repository HEAD is malformed")
	}
	ref := strings.TrimSpace(strings.TrimPrefix(value, "ref: "))
	if !validGitRef(ref) {
		return "", fmt.Errorf("repository HEAD contains invalid ref %q", ref)
	}
	for _, metadataRoot := range uniqueSorted([]string{gitDir, commonDir}) {
		refPath := filepath.Join(metadataRoot, filepath.FromSlash(ref))
		if err := rejectSymlinkPath(refPath); err != nil {
			return "", fmt.Errorf("repository ref %q: %w", ref, err)
		}
		if data, err := readBoundedRegularFile(refPath, 4096); err == nil {
			if commit := strings.TrimSpace(string(data)); validCommitID(commit) {
				return commit, nil
			}
			return "", fmt.Errorf("repository ref %q has malformed content", ref)
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("read repository ref %q: %w", ref, err)
		}
		commit, found, err := packedGitReference(filepath.Join(metadataRoot, "packed-refs"), ref)
		if err != nil {
			return "", err
		}
		if found {
			return commit, nil
		}
	}
	return "", fmt.Errorf("repository ref %q is unresolved", ref)
}

func validateGitDirIndirection(root, gitPath, gitDir string) (string, error) {
	data, err := readBoundedRegularFile(filepath.Join(gitDir, "commondir"), 4096)
	if err != nil {
		return "", errors.New("external gitdir target is not a supported linked worktree")
	}
	common := strings.TrimSpace(string(data))
	if common == "" || strings.ContainsAny(common, "\r\n\x00") {
		return "", errors.New("repository commondir metadata is malformed")
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(gitDir, common)
	}
	common, err = filepath.Abs(common)
	if err != nil {
		return "", fmt.Errorf("resolve repository commondir: %w", err)
	}
	expectedWorktrees := filepath.Join(common, "worktrees")
	relative, err := filepath.Rel(expectedWorktrees, gitDir)
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		strings.Contains(relative, string(filepath.Separator)) {
		return "", errors.New("repository gitdir target escapes the linked-worktree metadata area")
	}
	backlink, err := readBoundedRegularFile(filepath.Join(gitDir, "gitdir"), 4096)
	if err != nil {
		return "", errors.New("linked-worktree gitdir backlink is missing or unsafe")
	}
	backlinkPath := strings.TrimSpace(string(backlink))
	if !filepath.IsAbs(backlinkPath) {
		backlinkPath = filepath.Join(gitDir, backlinkPath)
	}
	backlinkPath, err = filepath.Abs(backlinkPath)
	if err != nil || filepath.Clean(backlinkPath) != filepath.Clean(gitPath) {
		return "", errors.New("linked-worktree gitdir backlink does not match the source root")
	}
	if err := rejectSymlinkPath(common); err != nil {
		return "", fmt.Errorf("repository common metadata: %w", err)
	}
	return common, nil
}

func packedGitReference(path, ref string) (string, bool, error) {
	data, err := readBoundedRegularFile(path, 16<<20)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read repository packed refs: %w", err)
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		return "", false, errors.New("repository packed-refs metadata is missing its terminating newline")
	}
	if len(data) == 0 {
		return "", false, nil
	}
	var match, previousRef, lastRef string
	previousPeeled := false
	sortedFile := false
	objectIDWidth := 0
	seen := map[string]bool{}
	headerRegion := true
	headerSeen := false
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			return "", false, errors.New("repository packed-refs metadata contains an empty record")
		}
		if strings.HasPrefix(line, "#") {
			if !headerRegion {
				return "", false, errors.New("repository packed-refs metadata has a comment after its first ref")
			}
			const header = "# pack-refs with: "
			if headerSeen || !strings.HasPrefix(line, header) {
				return "", false, errors.New("repository packed-refs metadata has an invalid header")
			}
			traits := strings.Fields(strings.TrimPrefix(line, header))
			if len(traits) == 0 {
				return "", false, errors.New("repository packed-refs metadata has an empty header")
			}
			headerSeen = true
			seenTraits := map[string]bool{}
			for _, trait := range traits {
				if seenTraits[trait] {
					return "", false, errors.New("repository packed-refs metadata has a duplicate header trait")
				}
				seenTraits[trait] = true
				switch trait {
				case "peeled", "fully-peeled":
				case "sorted":
					sortedFile = true
				default:
					return "", false, fmt.Errorf("repository packed-refs metadata has unknown header trait %q", trait)
				}
			}
			previousRef = ""
			previousPeeled = false
			continue
		}
		headerRegion = false
		if strings.HasPrefix(line, "^") {
			hash := strings.TrimPrefix(line, "^")
			if previousRef == "" || previousPeeled || !validCommitID(hash) || len(hash) != objectIDWidth {
				return "", false, errors.New("repository packed-refs metadata has malformed peeled content")
			}
			previousPeeled = true
			continue
		}
		hash, name, found := strings.Cut(line, " ")
		if !found || strings.ContainsAny(name, " \t\r") || !validCommitID(hash) || !validGitRef(name) || seen[name] {
			return "", false, errors.New("repository packed-refs metadata is malformed")
		}
		if objectIDWidth == 0 {
			objectIDWidth = len(hash)
		} else if len(hash) != objectIDWidth {
			return "", false, errors.New("repository packed-refs metadata mixes object ID widths")
		}
		if sortedFile && lastRef != "" && name <= lastRef {
			return "", false, errors.New("repository packed-refs metadata violates sorted ordering")
		}
		seen[name] = true
		previousRef = name
		lastRef = name
		previousPeeled = false
		if name == ref {
			match = hash
		}
	}
	return match, match != "", nil
}

func readBoundedRegularFile(path string, limit int64) ([]byte, error) {
	return readBoundedRegularFileWithHooks(path, limit, nil, nil)
}

func readBoundedRegularFileAfterOpen(path string, limit int64, afterOpen func()) (data []byte, err error) {
	return readBoundedRegularFileWithHooks(path, limit, nil, afterOpen)
}

func readBoundedRegularFileWithHooks(path string, limit int64, beforeOpen, afterOpen func()) (data []byte, err error) {
	initialInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !initialInfo.Mode().IsRegular() {
		return nil, errors.New("metadata path is not a regular file")
	}
	if beforeOpen != nil {
		beforeOpen()
	}
	file, err := openMetadataFile(path)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := file.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close metadata file: %w", closeErr)
		}
	}()
	if afterOpen != nil {
		afterOpen()
	}
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect opened metadata file: %w", err)
	}
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect metadata path: %w", err)
	}
	if !openedInfo.Mode().IsRegular() || !pathInfo.Mode().IsRegular() ||
		!os.SameFile(initialInfo, openedInfo) || !os.SameFile(openedInfo, pathInfo) ||
		openedInfo.Size() > limit {
		return nil, errors.New("not a bounded regular file")
	}
	data, err = io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read metadata file: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, errors.New("metadata file exceeds size limit")
	}
	return data, nil
}

func sanitizeUnavailableToolFailure(packages []*packages.Package, path string) bool {
	found := false
	for _, pkg := range packages {
		for i := range pkg.Errors {
			if strings.Contains(pkg.Errors[i].Msg, path) {
				found = true
				pkg.Errors[i].Msg = strings.ReplaceAll(pkg.Errors[i].Msg, path, "<disabled-pkg-config>")
			}
		}
	}
	return found
}

func validGitRef(value string) bool {
	if !strings.HasPrefix(value, "refs/") || strings.HasSuffix(value, "/") ||
		strings.Contains(value, "..") || strings.Contains(value, "@{") ||
		strings.Contains(value, "//") {
		return false
	}
	for _, char := range value {
		if char <= ' ' || char == 0x7f || strings.ContainsRune("~^:?*[\\", char) {
			return false
		}
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || component == "." || component == ".." ||
			strings.HasPrefix(component, ".") || strings.HasSuffix(component, ".") ||
			strings.HasSuffix(component, ".lock") {
			return false
		}
	}
	return true
}

func validCommitID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
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
