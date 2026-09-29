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

	"golang.org/x/mod/modfile"
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
	return analyzeWithSnapshotHooks(ctx, sourceRoot, outRoot, profile, afterSnapshot, nil)
}

func analyzeWithSnapshotHooks(ctx context.Context, sourceRoot, outRoot string, profile Profile, afterSnapshot, afterLoad func()) (Analysis, bool, error) {
	var err error
	sourceRoot, err = secureRoot(sourceRoot)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("source root: %w", err)
	}
	outRoot, err = filepath.Abs(outRoot)
	if err != nil {
		return Analysis{}, false, err
	}
	if filepath.Clean(outRoot) == filepath.Clean(sourceRoot) {
		return Analysis{}, false, errors.New("output root must be outside the source root")
	}
	if err := os.MkdirAll(outRoot, 0o700); err != nil {
		return Analysis{}, false, err
	}
	outRoot, err = secureRoot(outRoot)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("output root: %w", err)
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

	workRoot, err := os.MkdirTemp(outRoot, ".go2gs-work-*")
	if err != nil {
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
	if versionResult.ExitCode != 0 {
		return Analysis{}, false, fmt.Errorf("resolve selected Go version: %s", strings.TrimSpace(versionResult.Stderr))
	}
	actualVersion := parseGoVersion(versionResult.Stdout)
	if actualVersion == "" {
		return Analysis{}, false, errors.New("selected Go executable returned an unrecognized version")
	}
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

	mirror, err := createSourceMirror(sourceRoot, outRoot, workRoot, profile.Limits)
	if err != nil {
		return Analysis{}, false, err
	}
	builder := newInventoryBuilder(&analysis, mirror.root, targetGOROOT, profile)
	builder.collectManifests(mirror.manifests.records)
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
		Dir:        mirror.root,
		Env:        env,
		BuildFlags: buildFlags,
		Tests:      profile.LoadTests,
	}
	if afterSnapshot != nil {
		afterSnapshot()
	}
	selectedConfig := *config
	selectedConfig.Mode = packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
		packages.NeedEmbedFiles | packages.NeedEmbedPatterns | packages.NeedImports |
		packages.NeedDeps | packages.NeedModule | packages.NeedForTest
	selectedPreflight, _ := packages.Load(&selectedConfig, profile.EntryPatterns...)
	selectedPreflight = collectPackages(selectedPreflight)
	capturePreflight := selectedPreflight
	if !profile.CGOEnabled {
		defensiveConfig := selectedConfig
		defensiveConfig.Env = replaceEnvironment(config.Env, "CGO_ENABLED", "1")
		defensive, _ := packages.Load(&defensiveConfig, profile.EntryPatterns...)
		capturePreflight = collectPackages(append(selectedPreflight, defensive...))
	}
	sourceSnapshot, err := snapshotPackageInputs(selectedPreflight, capturePreflight, mirror.root, profile.Limits)
	if err != nil {
		return Analysis{}, false, err
	}
	config.Overlay = sourceSnapshot.overlay
	builder.sourceSnapshot = sourceSnapshot.data
	builder.snapshotPortable = sourceSnapshot.portable
	loaded, loadErr := packages.Load(config, profile.EntryPatterns...)
	if afterLoad != nil {
		afterLoad()
	}
	pkgConfigPath := unavailableToolPath(workRoot, "pkg-config")
	if sanitizeUnavailableToolFailure(loaded, pkgConfigPath) ||
		(loadErr != nil && strings.Contains(loadErr.Error(), pkgConfigPath)) {
		builder.block("pkg-config", "selected package requires #cgo pkg-config, but M0 has no approved pkg-config executable or provenance model", nil, nil)
	}
	if loadErr != nil {
		message := strings.ReplaceAll(loadErr.Error(), pkgConfigPath, "<disabled-pkg-config>")
		builder.block("loader", sanitizeMessage(message, mirror.root, profile.Limits.MaxStringBytes), nil, nil)
	}
	if len(loaded) == 0 {
		builder.block("loader", "the requested entry patterns selected no loadable packages under the pinned profile", nil, nil)
	}

	all := collectPackages(loaded)
	builder.inputDrift = verifyPackageInputs(sourceSnapshot, all, mirror.root)
	for key := range verifyOriginalPackageInputs(mirror, sourceSnapshot, profile) {
		builder.inputDrift[key] = true
	}
	if !verifyManifestSnapshot(mirror.manifests, sourceRoot, profile.Limits.MaxLocalHashBytes) {
		builder.block("input-drift", "module or workspace manifests changed while loading", nil, nil)
	}
	builder.snapshotFiles = sourceSnapshot.packageFiles
	builder.selectedSnapshotFiles = sourceSnapshot.selectedFiles
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

var manifestNames = []string{
	"go.mod",
	"go.sum",
	"go.work",
	"go.work.sum",
	filepath.Join("vendor", "modules.txt"),
}

type manifestSnapshot struct {
	records []ManifestRecord
	files   map[string]snapshottedInput
}

func snapshotManifests(sourceRoot string, limit int64) (manifestSnapshot, error) {
	result := manifestSnapshot{files: map[string]snapshottedInput{}}
	var total int64
	for _, name := range manifestNames {
		path, err := safeJoin(sourceRoot, name)
		if err != nil {
			return manifestSnapshot{}, err
		}
		initialInfo, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return manifestSnapshot{}, fmt.Errorf("inspect manifest %s: %w", name, err)
		}
		if !initialInfo.Mode().IsRegular() {
			return manifestSnapshot{}, fmt.Errorf("manifest is not a regular file: %s", name)
		}
		if err := rejectSymlinkBelow(sourceRoot, path); err != nil {
			return manifestSnapshot{}, fmt.Errorf("manifest path %s: %w", name, err)
		}
		if _, err := pathWithin(sourceRoot, path); err != nil {
			return manifestSnapshot{}, fmt.Errorf("manifest path %s: %w", name, err)
		}
		data, err := readBoundedRegularFile(path, limit-total)
		if err != nil {
			return manifestSnapshot{}, fmt.Errorf("read manifest %s: %w", name, err)
		}
		finalInfo, err := os.Lstat(path)
		if err != nil || !finalInfo.Mode().IsRegular() || !os.SameFile(initialInfo, finalInfo) {
			return manifestSnapshot{}, fmt.Errorf("manifest changed while reading: %s", name)
		}
		total += int64(len(data))
		result.files[path] = snapshottedInput{data: data, info: finalInfo}
		result.records = append(result.records, ManifestRecord{
			Kind: filepath.Base(name), Path: "source://" + slash(name),
			SHA256: hashBytes(data), Bytes: int64(len(data)),
		})
	}
	sort.Slice(result.records, func(i, j int) bool { return result.records[i].Path < result.records[j].Path })
	return result, nil
}

func verifyManifestSnapshot(snapshot manifestSnapshot, sourceRoot string, limit int64) bool {
	for _, name := range manifestNames {
		path, err := safeJoin(sourceRoot, name)
		if err != nil {
			return false
		}
		captured, existed := snapshot.files[path]
		info, err := os.Lstat(path)
		if !existed {
			if err == nil || !os.IsNotExist(err) {
				return false
			}
			continue
		}
		if err != nil || !info.Mode().IsRegular() || !os.SameFile(captured.info, info) {
			return false
		}
		if err := rejectSymlinkBelow(sourceRoot, path); err != nil {
			return false
		}
		if _, err := pathWithin(sourceRoot, path); err != nil {
			return false
		}
		data, err := readBoundedRegularFile(path, min(limit, int64(len(captured.data))+1))
		if err != nil || !bytes.Equal(data, captured.data) {
			return false
		}
	}
	return true
}

type mirrorBudget struct {
	files int
	bytes int64
}

type mirroredTree struct {
	sourceRoot string
	mirrorRoot string
	files      map[string]snapshottedInput
}

type sourceMirror struct {
	root      string
	manifests manifestSnapshot
	trees     []mirroredTree
}

func createSourceMirror(sourceRoot, outRoot, workRoot string, limits Limits) (sourceMirror, error) {
	mirrorBase := filepath.Join(workRoot, "source-mirror")
	root := filepath.Join(mirrorBase, "source")
	budget := &mirrorBudget{}
	tree, err := captureTree(sourceRoot, root, []string{outRoot, workRoot}, limits, budget)
	if err != nil {
		return sourceMirror{}, fmt.Errorf("create immutable source mirror: %w", err)
	}
	result := sourceMirror{root: root, trees: []mirroredTree{tree}}
	result.manifests = manifestsFromTree(tree)
	goModPath := filepath.Join(sourceRoot, "go.mod")
	capturedGoMod, ok := tree.files[goModPath]
	if !ok {
		return sourceMirror{}, errors.New("source root has no regular go.mod")
	}
	parsed, err := modfile.Parse("go.mod", capturedGoMod.data, nil)
	if err != nil {
		return sourceMirror{}, fmt.Errorf("parse captured go.mod: %w", err)
	}
	mirroredReplacements := map[string]string{}
	rewritten := false
	type replacementDirective struct {
		oldPath, oldVersion string
		newPath, newVersion string
	}
	replacements := make([]replacementDirective, 0, len(parsed.Replace))
	for _, replacement := range parsed.Replace {
		replacements = append(replacements, replacementDirective{
			oldPath: replacement.Old.Path, oldVersion: replacement.Old.Version,
			newPath: replacement.New.Path, newVersion: replacement.New.Version,
		})
	}
	for _, replacement := range replacements {
		if replacement.newVersion != "" {
			continue
		}
		replacementRoot, err := resolveLocalReplacementRoot(sourceRoot, replacement.newPath)
		if err != nil {
			return sourceMirror{}, fmt.Errorf("local replacement %s: %w", replacement.oldPath, err)
		}
		if lexicallyWithin(sourceRoot, replacementRoot) {
			continue
		}
		if lexicallyWithin(outRoot, replacementRoot) {
			return sourceMirror{}, fmt.Errorf("local replacement %s points into the output root", replacement.oldPath)
		}
		destination := mirroredReplacements[replacementRoot]
		if destination == "" {
			destination = filepath.Join(mirrorBase, "replacements", hashBytes([]byte(replacement.oldPath + "\x00" + replacement.newPath))[:16])
			replacementTree, captureErr := captureTree(replacementRoot, destination, nil, limits, budget)
			if captureErr != nil {
				return sourceMirror{}, fmt.Errorf("mirror local replacement %s: %w", replacement.oldPath, captureErr)
			}
			result.trees = append(result.trees, replacementTree)
			mirroredReplacements[replacementRoot] = destination
		}
		if err := parsed.AddReplace(replacement.oldPath, replacement.oldVersion, filepath.ToSlash(destination), ""); err != nil {
			return sourceMirror{}, fmt.Errorf("rewrite local replacement %s: %w", replacement.oldPath, err)
		}
		rewritten = true
	}
	if rewritten {
		data, err := parsed.Format()
		if err != nil {
			return sourceMirror{}, fmt.Errorf("format operational go.mod: %w", err)
		}
		if err := os.WriteFile(filepath.Join(root, "go.mod"), data, 0o600); err != nil {
			return sourceMirror{}, fmt.Errorf("write operational go.mod: %w", err)
		}
	}
	return result, nil
}

func captureTree(sourceRoot, mirrorRoot string, excluded []string, limits Limits, budget *mirrorBudget) (mirroredTree, error) {
	if err := os.MkdirAll(mirrorRoot, 0o700); err != nil {
		return mirroredTree{}, err
	}
	result := mirroredTree{sourceRoot: sourceRoot, mirrorRoot: mirrorRoot, files: map[string]snapshottedInput{}}
	err := filepath.WalkDir(sourceRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == sourceRoot {
			return nil
		}
		relative, err := lexicalRelative(sourceRoot, path)
		if err != nil {
			return err
		}
		if relative == ".git" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if excludedMirrorDirectory(path, entry.Name(), excluded) {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(mirrorRoot, relative), 0o700)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if slices.Contains(manifestNames, filepath.FromSlash(slash(relative))) {
				return fmt.Errorf("manifest is not a regular file: %s", relative)
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if budget.files >= limits.MaxFiles || budget.bytes >= limits.MaxLocalHashBytes {
			return errors.New("source mirror exceeds configured limits")
		}
		data, err := readBoundedRegularFile(path, limits.MaxLocalHashBytes-budget.bytes)
		if err != nil {
			return fmt.Errorf("capture %s: %w", relative, err)
		}
		finalInfo, err := os.Lstat(path)
		if err != nil || !finalInfo.Mode().IsRegular() || !os.SameFile(info, finalInfo) {
			return fmt.Errorf("source changed while capturing: %s", relative)
		}
		budget.files++
		budget.bytes += int64(len(data))
		destination := filepath.Join(mirrorRoot, relative)
		if err := os.WriteFile(destination, data, info.Mode().Perm()); err != nil {
			return err
		}
		result.files[path] = snapshottedInput{data: data, info: finalInfo}
		return nil
	})
	return result, err
}

func excludedMirrorDirectory(path, name string, excluded []string) bool {
	for _, root := range excluded {
		if root != "" && lexicallyWithin(root, path) {
			return true
		}
	}
	return name == ".git" || name == ".go2gs-work" ||
		strings.HasPrefix(name, ".go2gs-work-") ||
		strings.HasPrefix(name, ".go2gs-worker-") ||
		strings.HasPrefix(name, ".go2gs-bootstrap-")
}

func lexicalRelative(root, path string) (string, error) {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("path escapes root")
	}
	return relative, nil
}

func lexicallyWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func manifestsFromTree(tree mirroredTree) manifestSnapshot {
	result := manifestSnapshot{files: map[string]snapshottedInput{}}
	for _, name := range manifestNames {
		path := filepath.Join(tree.sourceRoot, name)
		captured, ok := tree.files[path]
		if !ok {
			continue
		}
		result.files[path] = captured
		result.records = append(result.records, ManifestRecord{
			Kind: filepath.Base(name), Path: "source://" + slash(name),
			SHA256: hashBytes(captured.data), Bytes: int64(len(captured.data)),
		})
	}
	sort.Slice(result.records, func(i, j int) bool { return result.records[i].Path < result.records[j].Path })
	return result
}

func resolveLocalReplacementRoot(sourceRoot, replacement string) (string, error) {
	path := filepath.FromSlash(replacement)
	if !filepath.IsAbs(path) {
		path = filepath.Join(sourceRoot, path)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	if filepath.Clean(absolute) != filepath.Clean(resolved) {
		return "", errors.New("symlinked local replacement roots are not allowed")
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("local replacement root is not a directory")
	}
	return resolved, nil
}

func (mirror sourceMirror) originalPath(path string) (string, snapshottedInput, bool) {
	for _, tree := range mirror.trees {
		relative, err := lexicalRelative(tree.mirrorRoot, path)
		if err != nil {
			continue
		}
		original := filepath.Join(tree.sourceRoot, relative)
		captured, ok := tree.files[original]
		return original, captured, ok
	}
	return "", snapshottedInput{}, false
}

func (mirror sourceMirror) originalDirectory(path string) (string, bool) {
	for _, tree := range mirror.trees {
		if filepath.Clean(path) == filepath.Clean(tree.mirrorRoot) {
			return tree.sourceRoot, true
		}
		if relative, err := lexicalRelative(tree.mirrorRoot, path); err == nil {
			return filepath.Join(tree.sourceRoot, relative), true
		}
	}
	return "", false
}

func verifyOriginalPackageInputs(mirror sourceMirror, snapshot packageInputSnapshot, profile Profile) map[string]bool {
	drift := map[string]bool{}
	for path, owners := range snapshot.selectedOwners {
		original, captured, ok := mirror.originalPath(path)
		if !ok || !sameCapturedFile(original, captured) {
			for owner := range owners {
				drift[owner] = true
			}
		}
	}
	for key, directory := range snapshot.packageDirs {
		if len(snapshot.selectedFiles[key]) == 0 {
			continue
		}
		originalDirectory, ok := mirror.originalDirectory(directory)
		if !ok || !samePackageFileSet(originalDirectory, directory, profile) {
			drift[key] = true
		}
	}
	return drift
}

func sameCapturedFile(path string, captured snapshottedInput) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(captured.info, info) {
		return false
	}
	data, err := readBoundedRegularFile(path, int64(len(captured.data))+1)
	return err == nil && bytes.Equal(data, captured.data)
}

func samePackageFileSet(originalDirectory, mirrorDirectory string, profile Profile) bool {
	originalEntries, err := os.ReadDir(originalDirectory)
	if err != nil {
		return false
	}
	mirrorEntries, err := os.ReadDir(mirrorDirectory)
	if err != nil {
		return false
	}
	actual := map[string]bool{}
	for _, entry := range originalEntries {
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension == ".go" || (profile.CGOEnabled && nativeSourceExtension(extension)) {
			actual[entry.Name()] = true
		}
	}
	expected := map[string]bool{}
	for _, entry := range mirrorEntries {
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension == ".go" || (profile.CGOEnabled && nativeSourceExtension(extension)) {
			expected[entry.Name()] = true
		}
	}
	return mapsEqual(actual, expected)
}

func nativeSourceExtension(extension string) bool {
	switch extension {
	case ".c", ".cc", ".cpp", ".cxx", ".m", ".mm", ".s", ".sx":
		return true
	default:
		return false
	}
}

func mapsEqual(left, right map[string]bool) bool {
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if !right[key] {
			return false
		}
	}
	return true
}

type packageInputSnapshot struct {
	data           map[string][]byte
	overlay        map[string][]byte
	files          map[string]snapshottedInput
	packageFiles   map[string][]string
	selectedFiles  map[string][]string
	packageRoles   map[string]map[string]string
	fileOwners     map[string]map[string]bool
	selectedOwners map[string]map[string]bool
	packageDirs    map[string]string
	portable       map[string]string
}

func snapshotPackageInputs(selected, captured []*packages.Package, sourceRoot string, limits Limits) (packageInputSnapshot, error) {
	result := packageInputSnapshot{
		data:           map[string][]byte{},
		overlay:        map[string][]byte{},
		files:          map[string]snapshottedInput{},
		packageFiles:   map[string][]string{},
		selectedFiles:  map[string][]string{},
		packageRoles:   map[string]map[string]string{},
		fileOwners:     map[string]map[string]bool{},
		selectedOwners: map[string]map[string]bool{},
		packageDirs:    map[string]string{},
		portable:       map[string]string{},
	}
	directories := map[string]map[string]bool{}
	for _, pkg := range captured {
		key := packageInputKey(pkg)
		result.packageRoles[key] = packageInputRoles(pkg)
		if pkg.Dir != "" {
			result.packageDirs[key] = pkg.Dir
		}
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
	for _, pkg := range selected {
		key := packageInputKey(pkg)
		result.packageRoles[key] = packageInputRoles(pkg)
		if pkg.Dir != "" {
			result.packageDirs[key] = pkg.Dir
		}
		result.selectedFiles[key] = packageInputPaths(pkg, sourceRoot)
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
	var total int64
	pending := map[string]bool{}
	for path := range result.fileOwners {
		pending[path] = true
	}
	for len(pending) > 0 {
		paths := make([]string, 0, len(pending))
		for path := range pending {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		path := paths[0]
		delete(pending, path)
		if _, captured := result.files[path]; captured {
			continue
		}
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
		if relative, err := pathWithin(sourceRoot, path); err == nil {
			result.portable[path] = "source://" + relative
		}
		if filepath.Ext(path) == ".go" {
			result.overlay[path] = data
		}
		if !nativeIncludeCarrier(path) {
			continue
		}
		includes, malformed := localQuotedIncludes(data)
		if malformed {
			continue
		}
		for _, include := range includes {
			for owner := range result.fileOwners[path] {
				target, ok := resolveLocalInclude(result.packageDirs[owner], path, include)
				if !ok {
					continue
				}
				if _, err := pathWithin(result.packageDirs[owner], target); err != nil {
					continue
				}
				if result.fileOwners[target] == nil {
					result.fileOwners[target] = map[string]bool{}
				}
				result.fileOwners[target][owner] = true
				result.packageFiles[owner] = append(result.packageFiles[owner], target)
				result.packageRoles[owner][target] = "native"
				pending[target] = true
			}
		}
	}
	for key := range result.packageFiles {
		result.packageFiles[key] = uniqueSorted(result.packageFiles[key])
	}
	selectedByKey := map[string]*packages.Package{}
	for _, pkg := range selected {
		selectedByKey[packageInputKey(pkg)] = pkg
	}
	for key, files := range result.selectedFiles {
		pkg := selectedByKey[key]
		activeCgo := pathsImportC(pkg.GoFiles, result.data)
		reachable, _ := selectedNativeIncludes(pkg, result.data)
		refined := make([]string, 0, len(files))
		for _, path := range files {
			if nativeHeader(path) && !activeCgo && !reachable[path] {
				continue
			}
			refined = append(refined, path)
			if result.selectedOwners[path] == nil {
				result.selectedOwners[path] = map[string]bool{}
			}
			result.selectedOwners[path][key] = true
		}
		for path := range reachable {
			if !contains(refined, path) {
				refined = append(refined, path)
			}
			if result.selectedOwners[path] == nil {
				result.selectedOwners[path] = map[string]bool{}
			}
			result.selectedOwners[path][key] = true
		}
		result.selectedFiles[key] = uniqueSorted(refined)
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
		if packageInputPathAllowed(pkg, sourceRoot, path) {
			result = append(result, path)
		}
	}
	return result
}

func packageInputPathAllowed(pkg *packages.Package, sourceRoot, path string) bool {
	if _, err := pathWithin(sourceRoot, path); err == nil {
		return true
	}
	return pkg.Module != nil && pkg.Module.Replace != nil && pkg.Module.Replace.Version == "" &&
		pkg.Module.Replace.Dir != "" && func() bool {
		_, err := pathWithin(pkg.Module.Replace.Dir, path)
		return err == nil
	}()
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
	for path := range roles {
		if strings.HasSuffix(path, "_test.go") && roles[path] != "ignored" {
			roles[path] = "test"
		}
	}
	return roles
}

func verifyPackageInputs(snapshot packageInputSnapshot, loaded []*packages.Package, sourceRoot string) map[string]bool {
	drift := map[string]bool{}
	actual := map[string][]string{}
	for _, pkg := range loaded {
		files := packageInputPaths(pkg, sourceRoot)
		activeCgo := pathsImportC(pkg.GoFiles, snapshot.data)
		reachable, _ := selectedNativeIncludes(pkg, snapshot.data)
		for _, path := range files {
			if nativeHeader(path) && !activeCgo && !reachable[path] {
				continue
			}
			actual[packageInputKey(pkg)] = append(actual[packageInputKey(pkg)], path)
		}
		for path := range reachable {
			if !contains(actual[packageInputKey(pkg)], path) {
				actual[packageInputKey(pkg)] = append(actual[packageInputKey(pkg)], path)
			}
		}
		actual[packageInputKey(pkg)] = uniqueSorted(actual[packageInputKey(pkg)])
	}
	keys := map[string]bool{}
	for key := range snapshot.selectedFiles {
		keys[key] = true
	}
	for key := range actual {
		keys[key] = true
	}
	for key := range keys {
		if !slices.Equal(snapshot.selectedFiles[key], actual[key]) {
			drift[key] = true
		}
	}
	for path, owners := range snapshot.selectedOwners {
		captured := snapshot.files[path]
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || !os.SameFile(captured.info, info) {
			for owner := range owners {
				drift[owner] = true
			}
			continue
		}
		data, err := readBoundedRegularFile(path, int64(len(captured.data))+1)
		if err != nil || !bytes.Equal(data, captured.data) {
			for owner := range owners {
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
	if len(fields) < 3 || fields[0] != "go" || fields[1] != "version" || !strings.HasPrefix(fields[2], "go1.") {
		return ""
	}
	version := strings.TrimPrefix(fields[2], "go")
	rest := version[2:]
	minorLength := leadingDigits(rest)
	if minorLength == 0 {
		return ""
	}
	rest = rest[minorLength:]
	if strings.HasPrefix(rest, ".") {
		rest = rest[1:]
		patchLength := leadingDigits(rest)
		if patchLength == 0 {
			return ""
		}
		rest = rest[patchLength:]
	}
	for _, prefix := range []string{"beta", "rc"} {
		if strings.HasPrefix(rest, prefix) {
			rest = rest[len(prefix):]
			if leadingDigits(rest) != len(rest) || rest == "" {
				return ""
			}
			return version
		}
	}
	if rest != "" {
		return ""
	}
	return version
}

func leadingDigits(value string) int {
	index := 0
	for index < len(value) && value[index] >= '0' && value[index] <= '9' {
		index++
	}
	return index
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
