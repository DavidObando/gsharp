// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	pathpkg "path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/tools/go/packages"
)

func validateAnalysis(a Analysis) error {
	return validateAnalysisContext(context.Background(), a)
}

func validateAnalysisContext(ctx context.Context, a Analysis) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.Schema.Name != schemaName || a.Schema.Version != schemaVersion {
		return fmt.Errorf("unsupported analysis schema %q version %d", a.Schema.Name, a.Schema.Version)
	}
	knownKinds := map[string]bool{
		"blocker": true, "call": true, "constant": true, "dependency": true,
		"diagnostic": true, "embed": true, "feature": true, "file": true,
		"generate": true, "instance": true, "methodSet": true, "module": true,
		"node": true, "package": true, "scope": true, "selection": true,
		"symbol": true, "type": true,
	}
	for _, kind := range a.Schema.RequiredRecordKinds {
		if !knownKinds[kind] {
			return fmt.Errorf("unknown required record kind %q", kind)
		}
	}
	if !slices.Equal(a.Schema.RequiredRecordKinds, requiredRecordKinds) {
		return errors.New("analysis required-record handshake does not exactly match schema v1")
	}
	if err := validateAnalysisHeader(a); err != nil {
		return err
	}
	if err := validateAnalysisCollections(a); err != nil {
		return err
	}
	if err := validateRecordFields(a); err != nil {
		return err
	}
	if err := validateRecordIDs(a); err != nil {
		return err
	}
	if a.MigrationReady {
		return errors.New("migrationReady must be false for schema v1 M0 inventories")
	}
	if a.InventoryComplete {
		for _, pkg := range a.Packages {
			if !pkg.InventoryComplete {
				return fmt.Errorf("complete analysis contains incomplete package %q", pkg.ID)
			}
		}
	}
	ids := map[string]string{}
	scopes := make(map[string]ScopeRecord, len(a.Scopes))
	add := func(id, kind string) error {
		if id == "" {
			return fmt.Errorf("%s record has empty id", kind)
		}
		if existing := ids[id]; existing != "" {
			return fmt.Errorf("duplicate id %q used by %s and %s", id, existing, kind)
		}
		ids[id] = kind
		return nil
	}
	for _, value := range a.Modules {
		if err := add(value.ID, "module"); err != nil {
			return err
		}
	}
	for _, value := range a.Packages {
		if err := add(value.ID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.Files {
		if err := add(value.ID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.Types {
		if err := add(value.ID, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Symbols {
		if err := add(value.ID, "symbol"); err != nil {
			return err
		}
	}
	for _, value := range a.Nodes {
		if err := add(value.ID, "node"); err != nil {
			return err
		}
	}
	for _, value := range a.Constants {
		if err := add(value.ID, "constant"); err != nil {
			return err
		}
	}
	for _, value := range a.Scopes {
		if _, duplicate := scopes[value.ID]; duplicate {
			return fmt.Errorf("duplicate scope id %q", value.ID)
		}
		if err := add(value.ID, "scope"); err != nil {
			return err
		}
		scopes[value.ID] = value
	}
	for _, value := range a.Selections {
		if err := add(value.ID, "selection"); err != nil {
			return err
		}
	}
	for _, value := range a.Calls {
		if err := add(value.ID, "call"); err != nil {
			return err
		}
	}
	for _, value := range a.MethodSets {
		if err := add(value.ID, "methodSet"); err != nil {
			return err
		}
	}
	for _, value := range a.Instances {
		if err := add(value.ID, "instance"); err != nil {
			return err
		}
	}
	for _, value := range a.Embeds {
		if err := add(value.ID, "embed"); err != nil {
			return err
		}
	}
	for _, value := range a.GenerateDirectives {
		if err := add(value.ID, "generate"); err != nil {
			return err
		}
	}
	for _, value := range a.Dependencies {
		if err := add(value.ID, "dependency"); err != nil {
			return err
		}
	}
	for _, value := range a.FeatureSites {
		if err := add(value.ID, "feature"); err != nil {
			return err
		}
	}
	for _, value := range a.Diagnostics {
		if err := add(value.ID, "diagnostic"); err != nil {
			return err
		}
	}
	for _, value := range a.Blockers {
		if err := add(value.ID, "blocker"); err != nil {
			return err
		}
	}
	require := func(owner, field, id, kind string) error {
		if id == "" {
			return nil
		}
		if ids[id] != kind {
			return fmt.Errorf("%s.%s has dangling %s id %q", owner, field, kind, id)
		}
		return nil
	}
	requireMany := func(owner, field string, values []string, kind string) error {
		for _, id := range values {
			if err := require(owner, field, id, kind); err != nil {
				return err
			}
		}
		return nil
	}
	for _, value := range a.Modules {
		if err := require(value.ID, "replacementId", value.ReplacementID, "module"); err != nil {
			return err
		}
	}
	for _, value := range a.Packages {
		if err := require(value.ID, "moduleId", value.ModuleID, "module"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "fileIds", value.FileIDs, "file"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "compiledFileIds", value.CompiledFileIDs, "file"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "methodAuthorityFileIds", value.MethodAuthorityFileIDs, "file"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "importPackageIds", value.ImportPackageIDs, "package"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "diagnosticIds", value.DiagnosticIDs, "diagnostic"); err != nil {
			return err
		}
		for _, initialization := range value.InitializationOrder {
			if err := require(value.ID, "initializationOrder.fileId", initialization.FileID, "file"); err != nil {
				return err
			}
			if err := require(value.ID, "initializationOrder.nodeId", initialization.NodeID, "node"); err != nil {
				return err
			}
			if err := requireMany(value.ID, "initializationOrder.symbolIds", initialization.SymbolIDs, "symbol"); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Files {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.Types {
		if err := requireMany(value.ID, "typeArgs", value.TypeArgs, "type"); err != nil {
			return err
		}
		if err := require(value.ID, "elementTypeId", value.ElementTypeID, "type"); err != nil {
			return err
		}
		if err := require(value.ID, "aliasTargetTypeId", value.AliasTargetTypeID, "type"); err != nil {
			return err
		}
		for _, field := range value.Fields {
			if err := require(value.ID, "fields.typeId", field.TypeID, "type"); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Symbols {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
		for field, id := range map[string]string{
			"methodDeclarationOwnerId": value.MethodDeclarationOwnerID,
			"methodSetOwnerSymbolId":   value.MethodSetOwnerSymbolID,
			"methodOriginSymbolId":     value.MethodOriginSymbolID,
		} {
			if err := require(value.ID, field, id, "symbol"); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Nodes {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
		for field, id := range map[string]string{
			"originalTypeId": value.OriginalTypeID, "effectiveTypeId": value.EffectiveTypeID,
			"conversionTypeId": value.ConversionTypeID,
		} {
			if err := require(value.ID, field, id, "type"); err != nil {
				return err
			}
		}
		if err := require(value.ID, "declarationId", value.DeclarationID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "useId", value.UseID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "scopeId", value.ScopeID, "scope"); err != nil {
			return err
		}
		if err := require(value.ID, "parentId", value.ParentID, "node"); err != nil {
			return err
		}
	}
	for _, value := range a.Constants {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "symbolId", value.SymbolID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
		if err := require(value.ID, "contextTypeId", value.ContextTypeID, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Scopes {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "parentId", value.ParentID, "scope"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "symbolIds", value.SymbolIDs, "symbol"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "labels", value.Labels, "symbol"); err != nil {
			return err
		}
	}
	for _, value := range a.Selections {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "objectId", value.ObjectID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "receiverTypeId", value.ReceiverTypeID, "type"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Calls {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "calleeSymbolId", value.CalleeSymbolID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "signatureTypeId", value.SignatureTypeID, "type"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "argumentTypeIds", value.ArgumentTypeIDs, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.MethodSets {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "ownerSymbolId", value.OwnerSymbolID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "methodSymbolIds", value.MethodSymbolIDs, "symbol"); err != nil {
			return err
		}
	}
	for _, value := range a.Instances {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "typeArgIds", value.TypeArgIDs, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Embeds {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.GenerateDirectives {
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.Dependencies {
		if err := require(value.ID, "fromPackageId", value.FromPackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.FeatureSites {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.Diagnostics {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.Blockers {
		if value.Blocks != "inventory" && value.Blocks != "migration" {
			return fmt.Errorf("%s.blocks has unknown disposition %q", value.ID, value.Blocks)
		}
		if a.InventoryComplete && value.Blocks == "inventory" {
			return errors.New("inventoryComplete cannot be true when inventory blockers exist")
		}
		if a.MigrationReady && value.Blocks == "migration" {
			return errors.New("migrationReady cannot be true when migration blockers exist")
		}
		if err := requireMany(value.ID, "affectedUnits", value.AffectedUnits, "package"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "diagnosticIds", value.DiagnosticIDs, "diagnostic"); err != nil {
			return err
		}
	}
	if err := validateOwnership(ctx, a, scopes); err != nil {
		return err
	}
	expectedCounts := RecordCounts{
		Modules: len(a.Modules), Packages: len(a.Packages), Files: len(a.Files), Types: len(a.Types), Symbols: len(a.Symbols),
		Nodes: len(a.Nodes), Constants: len(a.Constants), Scopes: len(a.Scopes), Selections: len(a.Selections),
		Calls: len(a.Calls), MethodSets: len(a.MethodSets), Instances: len(a.Instances), Embeds: len(a.Embeds),
		GenerateDirectives: len(a.GenerateDirectives), Dependencies: len(a.Dependencies),
		FeatureSites: len(a.FeatureSites), Diagnostics: len(a.Diagnostics), Blockers: len(a.Blockers),
	}
	expectedCounts.Total = expectedCounts.Modules + expectedCounts.Packages + expectedCounts.Files + expectedCounts.Types +
		expectedCounts.Symbols + expectedCounts.Nodes + expectedCounts.Constants + expectedCounts.Scopes +
		expectedCounts.Selections + expectedCounts.Calls + expectedCounts.MethodSets + expectedCounts.Instances +
		expectedCounts.Embeds + expectedCounts.GenerateDirectives + expectedCounts.Dependencies +
		expectedCounts.FeatureSites + expectedCounts.Diagnostics + expectedCounts.Blockers
	if a.RecordCounts != expectedCounts {
		return fmt.Errorf("recordCounts do not match records: got %#v, expected %#v", a.RecordCounts, expectedCounts)
	}
	if err := validateCompletenessEvidence(a); err != nil {
		return err
	}
	return ctx.Err()
}

func validateCompletenessEvidence(a Analysis) error {
	hasInventoryBlocker := slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
		return blocker.Blocks == "inventory"
	})
	if !a.InventoryComplete {
		if !hasInventoryBlocker {
			return errors.New("incomplete analysis requires an inventory blocker")
		}
		return nil
	}
	if hasInventoryBlocker {
		return errors.New("complete analysis cannot contain an inventory blocker")
	}
	if len(a.Modules) == 0 || len(a.Packages) == 0 || len(a.Files) == 0 {
		return errors.New("complete analysis requires loaded modules, packages, and source files")
	}
	mainModules := map[string]bool{}
	for _, module := range a.Modules {
		if module.Main {
			mainModules[module.ID] = true
		}
	}
	if len(mainModules) == 0 {
		return errors.New("complete analysis requires a main module")
	}
	for _, pkg := range a.Packages {
		if mainModules[pkg.ModuleID] && len(pkg.FileIDs) != 0 && len(pkg.CompiledFileIDs) != 0 {
			return nil
		}
	}
	return errors.New("complete analysis requires a loaded main-module package with owned source and compiled files")
}

func validateRecordIDs(a Analysis) error {
	semanticProfileID := semanticProfileIdentity(a.Profile, a.Toolchain)
	check := func(kind, actual, expected string) error {
		if actual != expected {
			return fmt.Errorf("%s record id %q does not match payload-derived identity %q", kind, actual, expected)
		}
		return nil
	}
	for _, value := range a.Modules {
		if err := check("module", value.ID, moduleRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Packages {
		if err := check("package", value.ID, packageRecordID(semanticProfileID, value)); err != nil {
			return err
		}
	}
	for _, value := range a.Files {
		if err := check("file", value.ID, fileRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Types {
		if err := check("type", value.ID, typeRecordID(semanticProfileID, value)); err != nil {
			return err
		}
	}
	for _, value := range a.Symbols {
		if value.MethodSetOwnerSymbolID != "" {
			if err := check("symbol", value.ID, methodSetSymbolID(value)); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Nodes {
		if err := check("node", value.ID, nodeRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Constants {
		if err := check("constant", value.ID, constantRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Scopes {
		if err := check("scope", value.ID, scopeRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Selections {
		if err := check("selection", value.ID, selectionRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Calls {
		if err := check("call", value.ID, callRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.MethodSets {
		if err := check("methodSet", value.ID, methodSetRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Instances {
		if err := check("instance", value.ID, instanceRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Embeds {
		if err := check("embed", value.ID, embedRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.GenerateDirectives {
		if err := check("generate", value.ID, generateRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Dependencies {
		if err := check("dependency", value.ID, dependencyRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.FeatureSites {
		if err := check("feature", value.ID, featureRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Diagnostics {
		if err := check("diagnostic", value.ID, diagnosticRecordID(value)); err != nil {
			return err
		}
	}
	for _, value := range a.Blockers {
		expected := blockerRecordIDPayload(value.Blocks, value.Category, value.Message, value.AffectedUnits)
		if err := check("blocker", value.ID, expected); err != nil {
			return err
		}
	}
	return nil
}

func validateAnalysisHeader(a Analysis) error {
	for name, value := range map[string]VersionIdentity{"tool": a.Tool, "helper": a.Helper} {
		if value.Version == "" || !validSHA256(value.SHA256) {
			return fmt.Errorf("%s identity requires version and SHA-256", name)
		}
	}
	p := a.Profile
	if p.ID == "" || !validSHA256(p.SHA256) || p.SourceRootIdentity == "" ||
		len(p.EntryPatterns) == 0 || p.GOOS == "" || p.GOARCH == "" ||
		p.ModuleMode == "" || p.WorkspaceMode == "" || !p.Offline || p.AllowNetwork ||
		p.GeneratorsExecuted || p.TargetBinariesExecuted || p.TrustBoundary == "" ||
		p.CCompilerHelpers == nil {
		return errors.New("analysis profile snapshot is missing mandatory or fail-closed fields")
	}
	if err := validateLimits(p.Limits); err != nil {
		return fmt.Errorf("analysis profile limits: %w", err)
	}
	if err := validateEntryPatterns(p.EntryPatterns); err != nil {
		return fmt.Errorf("analysis profile: %w", err)
	}
	if err := validateGOFLAGS(p.GOFLAGS); err != nil {
		return fmt.Errorf("analysis profile: %w", err)
	}
	if err := validateGoTarget(p.GOOS, p.GOARCH); err != nil {
		return fmt.Errorf("analysis profile: %w", err)
	}
	if _, err := resolveArchitectureSettings(p.GOARCH, p.ArchitectureFeatures); err != nil {
		return fmt.Errorf("analysis profile: %w", err)
	}
	for index, tag := range p.BuildTags {
		if !validBuildTag(tag) {
			return fmt.Errorf("analysis profile buildTags[%d] has invalid value %q", index, tag)
		}
	}
	if err := validateSemanticProfile(Profile{GOEXPERIMENT: p.GOEXPERIMENT, GODEBUG: p.GODEBUG}); err != nil {
		return fmt.Errorf("analysis profile: %w", err)
	}
	if (p.ExpectedSourceCommit != "" && !validCommitID(p.ExpectedSourceCommit)) ||
		(p.ActualSourceCommit != "" && !validCommitID(p.ActualSourceCommit)) {
		return errors.New("analysis source commits must be lowercase 40- or 64-character Git object IDs")
	}
	if p.SourceRootIdentity != sourceIdentity(p.ActualSourceCommit, a.Manifests) {
		return errors.New("analysis source root identity is inconsistent with the source commit and manifests")
	}
	if (p.ModuleMode != "readonly" && p.ModuleMode != "vendor") ||
		p.VendorMode != (p.ModuleMode == "vendor") || p.WorkspaceMode != "off" {
		return errors.New("analysis profile has inconsistent module or workspace mode")
	}
	t := a.Toolchain
	if t.RequestedVersion == "" || t.ActualVersion == "" || t.HelperSemanticVersion == "" ||
		t.GOROOTVersion == "" || !validSHA256(t.ExecutableSHA256) ||
		t.ExecutableName == "" || t.GOROOTIdentity == "" || !validSHA256(t.GOROOTVersionSHA256) ||
		t.GOROOTSource == "" || t.AutoDownload || t.CCompilerHelpers == nil {
		return errors.New("analysis toolchain provenance is missing mandatory or fail-closed fields")
	}
	for name, version := range map[string]string{
		"requested": t.RequestedVersion,
		"actual":    t.ActualVersion,
		"helper":    t.HelperSemanticVersion,
		"goroot":    t.GOROOTVersion,
	} {
		normalized, err := normalizeOfficialGoVersion(version, false)
		if err != nil || normalized != version {
			return fmt.Errorf("analysis %s Go version label is not canonical final-release form", name)
		}
	}
	if t.ActualVersion != t.HelperSemanticVersion || t.ActualVersion != t.GOROOTVersion {
		return errors.New("analysis selected, GOROOT, and helper Go version labels must match")
	}
	expectedGOROOTIdentity := stableID("goroot",
		t.ActualVersion+"\x00"+t.GOROOTVersion+"\x00"+t.HelperSemanticVersion+"\x00"+
			t.ExecutableSHA256+"\x00"+t.GOROOTVersionSHA256)
	if t.GOROOTIdentity != expectedGOROOTIdentity {
		return errors.New("analysis GOROOT identity is inconsistent with version labels and hashes")
	}
	if t.RequestedVersion != t.ActualVersion {
		if a.InventoryComplete || !slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
			return blocker.Blocks == "inventory" && blocker.Category == "toolchain"
		}) {
			return errors.New("analysis toolchain version mismatch requires an incomplete inventory and toolchain blocker")
		}
	}
	hasSourceBlocker := slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
		return blocker.Blocks == "inventory" && blocker.Category == "source"
	})
	hasSourceMetadataBlocker := slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
		return blocker.Blocks == "inventory" && blocker.Category == "source-metadata"
	})
	if p.ExpectedSourceCommit != "" && p.ActualSourceCommit == "" && !hasSourceMetadataBlocker {
		return errors.New("missing actual source commit requires a source-metadata blocker")
	}
	if p.ActualSourceCommit != "" && hasSourceMetadataBlocker {
		return errors.New("source-metadata blocker requires a missing actual source commit")
	}
	sourceMismatch := p.ExpectedSourceCommit != "" && p.ActualSourceCommit != "" &&
		p.ExpectedSourceCommit != p.ActualSourceCommit
	if sourceMismatch != hasSourceBlocker {
		return errors.New("analysis source commit mismatch and source blocker must agree")
	}
	if t.CCompilerName != "" || t.CCompilerSHA256 != "" ||
		len(t.CCompilerHelpers) != 0 || len(p.CCompilerHelpers) != 0 {
		return errors.New("M0 analysis must not contain obsolete C compiler provenance")
	}
	return nil
}

func validateAnalysisCollections(a Analysis) error {
	switch {
	case a.Schema.RequiredRecordKinds == nil:
		return errors.New("schema.requiredRecordKinds must be an array")
	case a.Profile.EntryPatterns == nil:
		return errors.New("profile.entryPatterns must be an array")
	case a.Profile.ArchitectureFeatures == nil:
		return errors.New("profile.architectureFeatures must be an array")
	case a.Profile.BuildTags == nil:
		return errors.New("profile.buildTags must be an array")
	case a.Profile.GOFLAGS == nil:
		return errors.New("profile.goFlags must be an array")
	case a.Profile.GODEBUG == nil:
		return errors.New("profile.goDebug must be an object")
	case a.Manifests == nil, a.Modules == nil, a.Packages == nil, a.Files == nil,
		a.Types == nil, a.Symbols == nil, a.Nodes == nil, a.Constants == nil,
		a.Scopes == nil, a.Selections == nil, a.Calls == nil, a.MethodSets == nil,
		a.Instances == nil, a.Embeds == nil, a.GenerateDirectives == nil,
		a.Dependencies == nil, a.FeatureSites == nil, a.Diagnostics == nil, a.Blockers == nil:
		return errors.New("analysis record collections must be arrays, not null or missing")
	}
	return nil
}

func validateRecordFields(a Analysis) error {
	for _, value := range a.Manifests {
		if value.Kind == "" || !validPortableLocation(value.Path) || !validSHA256(value.SHA256) || value.Bytes < 0 {
			return fmt.Errorf("manifest %q has invalid required fields", value.Path)
		}
	}
	for _, value := range a.Modules {
		if value.ID == "" || value.Path == "" || filepath.IsAbs(value.Path) ||
			filepath.VolumeName(value.Path) != "" || strings.Contains(value.Path, "\\") ||
			(value.LocalContentSHA256 != "" && !validSHA256(value.LocalContentSHA256)) {
			return fmt.Errorf("module %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.Packages {
		validVariant := value.Variant == "ordinary" || value.Variant == "in-package-test" ||
			value.Variant == "external-test" || value.Variant == "synthetic-test-main"
		if value.ID == "" || value.ImportPath == "" || value.Name == "" || !validVariant ||
			value.FileIDs == nil || value.CompiledFileIDs == nil || value.MethodAuthorityFileIDs == nil ||
			value.ImportPackageIDs == nil ||
			value.InitializationOrder == nil || value.DiagnosticIDs == nil {
			return fmt.Errorf("package %q has invalid required fields", value.ID)
		}
		for index, initialization := range value.InitializationOrder {
			if initialization.Order != index ||
				(initialization.Kind != "variable" && initialization.Kind != "init-function") ||
				initialization.SymbolIDs == nil {
				return fmt.Errorf("package %q has invalid initialization record %d", value.ID, index)
			}
			hasFile, hasNode := initialization.FileID != "", initialization.NodeID != ""
			if hasFile != hasNode || (initialization.Kind == "init-function" && !hasFile) ||
				(initialization.Kind == "variable" && len(value.CompiledFileIDs) > 0 && !hasFile) {
				return fmt.Errorf("package %q initialization record %d has incomplete location", value.ID, index)
			}
			if initialization.Kind == "variable" && len(initialization.SymbolIDs) == 0 {
				return fmt.Errorf("package %q variable initialization %d has no symbols", value.ID, index)
			}
		}
	}
	for _, value := range a.Files {
		data, err := base64.StdEncoding.DecodeString(value.ContentBase64)
		native, embed, validRole := fileRoleFlags(value.Role)
		if !validRole {
			return fmt.Errorf("file %q has unsupported schema-v1 role %q", value.ID, value.Role)
		}
		if value.Native != native || value.Embed != embed {
			return fmt.Errorf("file %q role %q disagrees with native/embed flags", value.ID, value.Role)
		}
		if value.ID == "" || value.PackageID == "" || !validPortableLocation(value.Path) ||
			value.Provenance == "" ||
			!validSHA256(value.SHA256) || value.Bytes < 0 || err != nil ||
			int64(len(data)) != value.Bytes || hashBytes(data) != value.SHA256 ||
			value.ValidUTF8 != utf8.Valid(data) {
			return fmt.Errorf("file %q has invalid required fields or content identity", value.ID)
		}
	}
	for _, value := range a.Types {
		if value.ID == "" || value.Kind == "" || value.Canonical == "" || value.Display == "" ||
			value.TypeArgs == nil || value.Fields == nil {
			return fmt.Errorf("type %q has invalid required fields", value.ID)
		}
		if (value.Kind == "pointer") != (value.ElementTypeID != "") ||
			value.Alias != (value.AliasTargetTypeID != "") ||
			value.Alias != (value.Kind == "alias") {
			return fmt.Errorf("type %q has inconsistent element or alias target provenance: kind=%q alias=%v element=%q target=%q",
				value.ID, value.Kind, value.Alias, value.ElementTypeID, value.AliasTargetTypeID)
		}
		for index, field := range value.Fields {
			if field.Name == "" || field.TypeID == "" {
				return fmt.Errorf("type %q struct field %d has invalid required fields", value.ID, index)
			}
			if field.TagBase64 != "" {
				if _, err := base64.StdEncoding.DecodeString(field.TagBase64); err != nil {
					return fmt.Errorf("type %q struct field %d has invalid tag encoding", value.ID, index)
				}
			}
		}
	}
	for _, value := range a.Symbols {
		if value.ID == "" || value.PackageID == "" || value.Name == "" || value.Kind == "" {
			return fmt.Errorf("symbol %q has invalid required fields", value.ID)
		}
		membership := value.MethodSetOwnerSymbolID != ""
		if membership != (value.MethodOriginSymbolID != "") ||
			membership != (value.MethodSelectionIndexPath != nil) ||
			(membership && (value.Kind != "function" || len(value.MethodSelectionIndexPath) == 0 ||
				value.PackageScopeType || value.MethodDeclarationOwnerID != "")) ||
			(!membership && value.MethodSetPointer) {
			return fmt.Errorf("symbol %q has inconsistent method-set membership provenance", value.ID)
		}
		declaration := value.MethodDeclarationOwnerID != ""
		if (declaration && (value.Kind != "function" ||
			value.MethodDeclarationIndex < 0 || value.PackageScopeType)) ||
			(!declaration && (value.MethodDeclarationPointer || value.MethodDeclarationIndex != 0)) {
			return fmt.Errorf("symbol %q has inconsistent method declaration provenance: name=%q kind=%q owner=%q index=%d",
				value.ID, value.Name, value.Kind, value.MethodDeclarationOwnerID, value.MethodDeclarationIndex)
		}
		if value.PackageScopeType && value.Kind != "type" {
			return fmt.Errorf("symbol %q has inconsistent package-scope type provenance", value.ID)
		}
		if value.MethodSetOwner && !value.PackageScopeType {
			return fmt.Errorf("symbol %q has inconsistent method-set owner eligibility", value.ID)
		}
		if value.Declaration != nil {
			if err := validateSourceSpan(*value.Declaration, value.ID+".declaration"); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Nodes {
		if value.ID == "" || value.PackageID == "" || value.FileID == "" || value.Kind == "" {
			return fmt.Errorf("node %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Constants {
		if value.ID == "" || value.NodeID == "" || value.Category == "" || value.Exact == "" {
			return fmt.Errorf("constant %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Scopes {
		if value.ID == "" || value.PackageID == "" || value.SymbolIDs == nil || value.Labels == nil {
			return fmt.Errorf("scope %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Selections {
		if value.ID == "" || value.NodeID == "" || value.Kind == "" || value.ObjectID == "" ||
			value.ReceiverTypeID == "" || value.TypeID == "" || value.IndexPath == nil {
			return fmt.Errorf("selection %q has invalid required fields", value.ID)
		}
		for _, index := range value.IndexPath {
			if index < 0 {
				return fmt.Errorf("selection %q has negative index path", value.ID)
			}
		}
	}
	for _, value := range a.Calls {
		if value.ID == "" || value.NodeID == "" || value.Kind == "" || value.ArgumentTypeIDs == nil {
			return fmt.Errorf("call %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.MethodSets {
		if value.ID == "" || value.PackageID == "" || value.OwnerSymbolID == "" ||
			value.TypeID == "" || value.MethodSymbolIDs == nil {
			return fmt.Errorf("method set %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.Instances {
		if value.ID == "" || value.NodeID == "" || value.TypeID == "" || value.TypeArgIDs == nil {
			return fmt.Errorf("instance %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.Embeds {
		if value.ID == "" || value.PackageID == "" || value.FileID == "" || value.Pattern == "" ||
			value.LogicalName == "" || !validSHA256(value.ContentSHA256) {
			return fmt.Errorf("embed %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.GenerateDirectives {
		if value.ID == "" || value.FileID == "" || value.Directive == "" || value.Executed {
			return fmt.Errorf("generate directive %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Dependencies {
		if value.ID == "" || value.FromPackageID == "" || value.ImportPath == "" || value.Disposition == "" {
			return fmt.Errorf("dependency %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.FeatureSites {
		if value.ID == "" || value.NodeID == "" || value.PackageID == "" || value.FileID == "" ||
			value.Feature == "" || value.Disposition == "" {
			return fmt.Errorf("feature %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Diagnostics {
		if value.ID == "" || value.Category == "" || value.Severity == "" || value.Message == "" {
			return fmt.Errorf("diagnostic %q has invalid required fields", value.ID)
		}
		if _, ok := diagnosticErrorKind(value.Category); !ok {
			return fmt.Errorf("diagnostic %q has unsupported category %q", value.ID, value.Category)
		}
		if value.Span != nil {
			if err := validateSourceSpan(*value.Span, value.ID+".span"); err != nil {
				return err
			}
		}
	}

	for _, value := range a.Blockers {
		if value.ID == "" || value.Blocks == "" || value.Category == "" || value.Message == "" ||
			value.AffectedUnits == nil || value.DiagnosticIDs == nil {
			return fmt.Errorf("blocker %q has invalid required fields", value.ID)
		}
	}
	return nil
}

func validateSourceSpan(span SourceSpan, owner string) error {
	if !validPortableLocation(span.Path) || !validPortableLocation(span.DisplayPath) ||
		span.StartByte < 0 || span.EndByte < span.StartByte ||
		span.StartLine < 1 || span.StartColumn < 1 || span.EndLine < span.StartLine ||
		(span.EndLine == span.StartLine && span.EndColumn < span.StartColumn) ||
		span.EndColumn < 1 || span.DisplayLine < 1 || span.DisplayColumn < 0 ||
		(!span.LineDirective && (span.DisplayPath != span.Path ||
			span.DisplayLine != span.StartLine || span.DisplayColumn != span.StartColumn)) ||
		(span.LineDirective && !strings.HasPrefix(span.DisplayPath, "line://")) {
		return fmt.Errorf("%s is not a complete, ordered source span: %#v", owner, span)
	}
	return nil
}

func validateOwnership(ctx context.Context, a Analysis, scopes map[string]ScopeRecord) error {
	packages := make(map[string]PackageRecord, len(a.Packages))
	files := make(map[string]FileRecord, len(a.Files))
	nodes := make(map[string]NodeRecord, len(a.Nodes))
	symbols := make(map[string]SymbolRecord, len(a.Symbols))
	packagePaths := make(map[string]bool, len(a.Packages))
	fileListings := map[string]map[string]int{}
	compiledFileListings := map[string]map[string]bool{}
	methodAuthorityFileListings := map[string]map[string]bool{}
	positionMaps := map[string]*sourcePositionMap{}
	for _, pkg := range a.Packages {
		packages[pkg.ID] = pkg
		packagePaths[pkg.ImportPath] = true
		listings := map[string]int{}
		for _, fileID := range pkg.FileIDs {
			listings[fileID]++
			if listings[fileID] != 1 {
				return fmt.Errorf("package %q lists file %q more than once", pkg.ID, fileID)
			}
		}
		fileListings[pkg.ID] = listings
		compiled := map[string]bool{}
		for _, fileID := range pkg.CompiledFileIDs {
			if compiled[fileID] {
				return fmt.Errorf("package %q lists compiled file %q more than once", pkg.ID, fileID)
			}
			compiled[fileID] = true
			if listings[fileID] != 1 {
				return fmt.Errorf("package %q compiled file %q is not listed exactly once", pkg.ID, fileID)
			}
		}
		compiledFileListings[pkg.ID] = compiled
		authority := map[string]bool{}
		for _, fileID := range pkg.MethodAuthorityFileIDs {
			if authority[fileID] {
				return fmt.Errorf("package %q lists method-authority file %q more than once", pkg.ID, fileID)
			}
			authority[fileID] = true
			if listings[fileID] != 1 {
				return fmt.Errorf("package %q method-authority file %q is not listed exactly once", pkg.ID, fileID)
			}
		}
		methodAuthorityFileListings[pkg.ID] = authority
	}
	for _, file := range a.Files {
		if _, ok := packages[file.PackageID]; !ok {
			return fmt.Errorf("file %q has unknown package %q", file.ID, file.PackageID)
		}
		if fileListings[file.PackageID][file.ID] != 1 {
			return fmt.Errorf("file %q is not listed exactly once by package %q", file.ID, file.PackageID)
		}
		if (file.Role == "compiled") != compiledFileListings[file.PackageID][file.ID] {
			return fmt.Errorf("file %q role %q disagrees with package %q compiledFileIds membership",
				file.ID, file.Role, file.PackageID)
		}
		files[file.ID] = file
	}
	for _, pkg := range a.Packages {
		for _, fileID := range pkg.FileIDs {
			if file, ok := files[fileID]; !ok || file.PackageID != pkg.ID {
				return fmt.Errorf("package %q lists file %q owned by another package", pkg.ID, fileID)
			}
		}
	}
	nodesByFile := map[string][]string{}
	var nodeFileOrder []string
	for _, node := range a.Nodes {
		file, ok := files[node.FileID]
		if !ok || file.PackageID != node.PackageID {
			return fmt.Errorf("node %q package/file ownership is inconsistent", node.ID)
		}
		if !compiledFileListings[node.PackageID][node.FileID] {
			return fmt.Errorf("node %q belongs to noncompiled file %q", node.ID, node.FileID)
		}
		if err := validateSpanForFile(node.Span, file, node.ID+".span", positionMaps); err != nil {
			return err
		}
		nodes[node.ID] = node
		if len(nodesByFile[node.FileID]) == 0 {
			nodeFileOrder = append(nodeFileOrder, node.FileID)
		}
		nodesByFile[node.FileID] = append(nodesByFile[node.FileID], node.ID)
	}
	for _, node := range a.Nodes {
		if node.ParentID == "" {
			continue
		}
		parent, ok := nodes[node.ParentID]
		if !ok || parent.PackageID != node.PackageID || parent.FileID != node.FileID {
			return fmt.Errorf("node %q parent %q ownership is inconsistent", node.ID, node.ParentID)
		}
	}
	if err := validateNodeTrees(nodeFileOrder, nodesByFile, nodes); err != nil {
		return err
	}
	for _, file := range a.Files {
		authority := methodAuthorityFileListings[file.PackageID][file.ID]
		if (file.Role == "method-authority" && !authority) ||
			(authority && file.Role != "compiled" && file.Role != "method-authority") {
			return fmt.Errorf("file %q role %q disagrees with package %q methodAuthorityFileIds membership",
				file.ID, file.Role, file.PackageID)
		}
	}
	if a.InventoryComplete {
		for _, pkg := range a.Packages {
			for _, fileID := range pkg.CompiledFileIDs {
				if len(nodesByFile[fileID]) == 0 {
					return fmt.Errorf("complete analysis compiled file %q requires exactly one *ast.File node", fileID)
				}
			}
		}
	}
	for _, symbol := range a.Symbols {
		if _, ok := packages[symbol.PackageID]; !ok {
			return fmt.Errorf("symbol %q has unknown package %q", symbol.ID, symbol.PackageID)
		}
		if symbol.Declaration != nil {
			if err := validateSpanInPackage(*symbol.Declaration, symbol.PackageID, fileListings, files, symbol.ID+".declaration", positionMaps); err != nil {
				return err
			}
		}
		symbols[symbol.ID] = symbol
	}
	membershipReferences := map[string]int{}
	for _, methodSet := range a.MethodSets {
		owner, ok := symbols[methodSet.OwnerSymbolID]
		if !ok || owner.PackageID != methodSet.PackageID || !owner.MethodSetOwner ||
			owner.Kind != "type" || owner.TypeID != methodSet.TypeID {
			return fmt.Errorf("method set %q owner symbol relationship is inconsistent", methodSet.ID)
		}
		for _, methodSymbolID := range methodSet.MethodSymbolIDs {
			membershipReferences[methodSymbolID]++
			method, ok := symbols[methodSymbolID]
			if !ok || method.PackageID != methodSet.PackageID ||
				method.Kind != "function" || method.TypeID == "" ||
				method.MethodSetOwnerSymbolID != methodSet.OwnerSymbolID ||
				method.MethodSetPointer != methodSet.Pointer {
				return fmt.Errorf("method set %q method symbol %q membership is inconsistent",
					methodSet.ID, methodSymbolID)
			}
			origin, ok := symbols[method.MethodOriginSymbolID]
			if !ok || origin.MethodDeclarationOwnerID == "" || origin.Declaration == nil ||
				method.Name != origin.Name || method.TypeID != origin.TypeID ||
				method.Exported != origin.Exported {
				return fmt.Errorf("method set %q method symbol %q origin is inconsistent",
					methodSet.ID, methodSymbolID)
			}
		}
	}
	for _, symbol := range a.Symbols {
		if symbol.MethodSetOwnerSymbolID != "" && membershipReferences[symbol.ID] != 1 {
			return fmt.Errorf("method-set symbol %q requires exactly one reverse reference; found %d",
				symbol.ID, membershipReferences[symbol.ID])
		}
	}
	if err := validateRetypedMethodSets(ctx, a, files, symbols); err != nil {
		return err
	}
	for _, node := range a.Nodes {
		if node.DeclarationID == "" {
			continue
		}
		symbol := symbols[node.DeclarationID]
		if symbol.PackageID != node.PackageID || symbol.Declaration == nil || *symbol.Declaration != node.Span {
			return fmt.Errorf("node %q (%s) declaration %q ownership or span is inconsistent: node=%#v declaration=%#v", node.ID, node.Kind, node.DeclarationID, node.Span, symbol.Declaration)
		}
	}
	diagnostics := make(map[string]DiagnosticRecord, len(a.Diagnostics))
	for _, diagnostic := range a.Diagnostics {
		diagnostics[diagnostic.ID] = diagnostic
	}
	for _, pkg := range a.Packages {
		diagnosticListings := map[string]bool{}
		for _, diagnosticID := range pkg.DiagnosticIDs {
			diagnostic := diagnostics[diagnosticID]
			if diagnosticListings[diagnosticID] || diagnostic.PackageID != pkg.ID {
				return fmt.Errorf("package %q diagnostic %q ownership is inconsistent", pkg.ID, diagnosticID)
			}
			diagnosticListings[diagnosticID] = true
		}
		for _, initialization := range pkg.InitializationOrder {
			if initialization.FileID != "" {
				file, ok := files[initialization.FileID]
				if !ok || file.PackageID != pkg.ID || fileListings[pkg.ID][file.ID] != 1 {
					return fmt.Errorf("package %q initialization file ownership is inconsistent", pkg.ID)
				}
				node, ok := nodes[initialization.NodeID]
				if !ok || node.PackageID != pkg.ID || node.FileID != file.ID {
					return fmt.Errorf("package %q initialization node ownership is inconsistent", pkg.ID)
				}
				if initialization.Kind == "init-function" && node.Kind != "*ast.FuncDecl" {
					return fmt.Errorf("package %q init-function does not reference a function declaration", pkg.ID)
				}
			}
			for _, symbolID := range initialization.SymbolIDs {
				if symbol, ok := symbols[symbolID]; !ok || symbol.PackageID != pkg.ID {
					return fmt.Errorf("package %q initialization symbol ownership is inconsistent", pkg.ID)
				}
			}
		}
	}
	if err := validateScopeParents(a.Scopes, scopes); err != nil {
		return err
	}
	labelListings := map[string]int{}
	for _, scope := range a.Scopes {
		if err := validateSpanInPackage(scope.Span, scope.PackageID, fileListings, files, scope.ID+".span", positionMaps); err != nil {
			return err
		}
		listed := make(map[string]bool, len(scope.SymbolIDs))
		for _, symbolID := range scope.SymbolIDs {
			if symbol, ok := symbols[symbolID]; !ok || symbol.PackageID != scope.PackageID {
				return fmt.Errorf("scope %q symbol ownership is inconsistent", scope.ID)
			}
			if listed[symbolID] {
				return fmt.Errorf("scope %q lists symbol %q more than once", scope.ID, symbolID)
			}
			listed[symbolID] = true
		}
		labels := make(map[string]bool, len(scope.Labels))
		for _, labelID := range scope.Labels {
			symbol, ok := symbols[labelID]
			if !ok || symbol.PackageID != scope.PackageID || symbol.Kind != "label" || !listed[labelID] {
				return fmt.Errorf("scope %q label %q relationship is inconsistent", scope.ID, labelID)
			}
			if labels[labelID] {
				return fmt.Errorf("scope %q lists label %q more than once", scope.ID, labelID)
			}
			labels[labelID] = true
			labelListings[labelID]++
		}
		for symbolID := range listed {
			if symbols[symbolID].Kind == "label" && !labels[symbolID] {
				return fmt.Errorf("scope %q label symbol %q is not listed as a label", scope.ID, symbolID)
			}
		}
	}
	for _, symbol := range a.Symbols {
		if symbol.Kind == "label" && labelListings[symbol.ID] != 1 {
			return fmt.Errorf("label symbol %q must be listed by exactly one scope", symbol.ID)
		}
	}
	constantsBySymbol := map[string]int{}
	for _, constant := range a.Constants {
		node := nodes[constant.NodeID]
		if constant.Span != node.Span {
			return fmt.Errorf("constant %q span does not match node %q", constant.ID, constant.NodeID)
		}
		if constant.SymbolID != "" {
			symbol := symbols[constant.SymbolID]
			if node.DeclarationID != symbol.ID || node.PackageID != symbol.PackageID {
				return fmt.Errorf("constant %q declaration ownership is inconsistent", constant.ID)
			}
			constantsBySymbol[constant.SymbolID]++
			if constantsBySymbol[constant.SymbolID] != 1 {
				return fmt.Errorf("symbol %q has multiple declared constant values", constant.SymbolID)
			}
		}
	}
	for _, symbol := range a.Symbols {
		if symbol.Kind == "constant" && symbol.Declaration != nil && constantsBySymbol[symbol.ID] != 1 {
			return fmt.Errorf("declared constant symbol %q must have exactly one linked value", symbol.ID)
		}
	}
	for _, embed := range a.Embeds {
		if file := files[embed.FileID]; file.PackageID != embed.PackageID ||
			(!file.Embed && file.Role != "compiled") || file.SHA256 != embed.ContentSHA256 {
			return fmt.Errorf("embed %q package/file ownership is inconsistent", embed.ID)
		}
	}

	for _, generate := range a.GenerateDirectives {
		if err := validateSpanForFile(generate.Span, files[generate.FileID], generate.ID+".span", positionMaps); err != nil {
			return err
		}
	}
	for _, feature := range a.FeatureSites {
		node := nodes[feature.NodeID]
		if node.PackageID != feature.PackageID || node.FileID != feature.FileID || node.Span != feature.Span {
			return fmt.Errorf("feature %q node/package/file/span ownership is inconsistent", feature.ID)
		}
	}
	for _, diagnostic := range a.Diagnostics {
		if diagnostic.PackageID != "" {
			pkg, ok := packages[diagnostic.PackageID]
			if !ok {
				return fmt.Errorf("diagnostic %q has unknown package %q", diagnostic.ID, diagnostic.PackageID)
			}
			if !slices.Contains(pkg.DiagnosticIDs, diagnostic.ID) {
				return fmt.Errorf("diagnostic %q is not listed by package %q", diagnostic.ID, diagnostic.PackageID)
			}
			if diagnostic.Span != nil {
				if err := validateSpanInPackage(*diagnostic.Span, diagnostic.PackageID, fileListings, files, diagnostic.ID+".span", positionMaps); err != nil {
					return err
				}
			}
		}
	}
	for _, value := range a.Types {
		if value.Package != "" && !packagePaths[value.Package] {
			return fmt.Errorf("type %q has unknown package path %q", value.ID, value.Package)
		}
	}
	return nil
}

type methodAuthorityPlan struct {
	rootPackages    map[string]bool
	closurePackages map[string]bool
	selectedFiles   map[string][]string
}

func deriveMethodAuthorityPlan(
	a Analysis,
	files map[string]FileRecord,
) (methodAuthorityPlan, error) {
	result := methodAuthorityPlan{
		rootPackages:    map[string]bool{},
		closurePackages: map[string]bool{},
		selectedFiles:   map[string][]string{},
	}
	modules := make(map[string]ModuleRecord, len(a.Modules))
	for _, module := range a.Modules {
		modules[module.ID] = module
	}
	packageRecords := make(map[string]PackageRecord, len(a.Packages))
	for _, record := range a.Packages {
		packageRecords[record.ID] = record
		if methodAuthorityRootPackage(record, modules) {
			result.rootPackages[record.ID] = true
		}
		selected, err := independentlySelectedGoFiles(a, record, files)
		if err != nil {
			return result, err
		}
		result.selectedFiles[record.ID] = selected
	}

	state := map[string]uint8{}
	var visit func(string) error
	visit = func(packageID string) error {
		switch state[packageID] {
		case 1:
			return fmt.Errorf("method-authority source closure contains an import cycle at package %q", packageID)
		case 2:
			return nil
		}
		record, ok := packageRecords[packageID]
		if !ok {
			return fmt.Errorf("method-authority source closure references unknown package %q", packageID)
		}
		state[packageID] = 1
		result.closurePackages[packageID] = true
		imports, err := capturedMethodAuthorityImports(
			record, result.selectedFiles[packageID], files, packageRecords)
		if err != nil {
			return err
		}
		for _, importedID := range imports {
			if err := visit(importedID); err != nil {
				return err
			}
		}
		state[packageID] = 2
		return nil
	}
	var roots []string
	for packageID := range result.rootPackages {
		roots = append(roots, packageID)
	}
	sort.Strings(roots)
	for _, packageID := range roots {
		if err := visit(packageID); err != nil {
			return result, err
		}
	}

	for _, record := range a.Packages {
		expectedAuthority := []string{}
		if result.closurePackages[record.ID] {
			expectedAuthority = append(expectedAuthority, result.selectedFiles[record.ID]...)
		}
		sort.Strings(expectedAuthority)
		actualAuthority := append([]string{}, record.MethodAuthorityFileIDs...)
		sort.Strings(actualAuthority)
		if !slices.Equal(actualAuthority, expectedAuthority) {
			return result, fmt.Errorf(
				"package %q methodAuthorityFileIds differ from independently derived compiled-source closure: expected %q, got %q",
				record.ID, expectedAuthority, actualAuthority)
		}

		expectedCompiled := []string{}
		if result.rootPackages[record.ID] {
			expectedCompiled = append(expectedCompiled, result.selectedFiles[record.ID]...)
		}
		sort.Strings(expectedCompiled)
		actualCompiled := append([]string{}, record.CompiledFileIDs...)
		sort.Strings(actualCompiled)
		if !slices.Equal(actualCompiled, expectedCompiled) {
			return result, fmt.Errorf(
				"package %q compiledFileIds differ from independently selected captured source: expected %q, got %q",
				record.ID, expectedCompiled, actualCompiled)
		}

		for _, fileID := range expectedAuthority {
			file := files[fileID]
			role, reason, provenance := "method-authority",
				"captured compiled Go source required to independently derive method sets",
				"go/packages-typed-source"
			if result.rootPackages[record.ID] {
				role, reason, provenance = "compiled", "", "go/packages"
				if strings.HasSuffix(pathpkg.Base(file.Path), "_test.go") {
					reason = "selected test source compiled for this package variant"
				}
			}
			if file.Role != role || file.Reason != reason || file.Provenance != provenance {
				return result, fmt.Errorf(
					"method-authority file %q metadata differs from independently derived source role: role=%q reason=%q provenance=%q",
					file.ID, file.Role, file.Reason, file.Provenance)
			}
		}
	}
	return result, nil
}

func methodAuthorityRootPackage(record PackageRecord, modules map[string]ModuleRecord) bool {
	module, ok := modules[record.ModuleID]
	if !ok {
		return false
	}
	if module.Main || module.LocalContentSHA256 != "" {
		return true
	}
	replacement, ok := modules[module.ReplacementID]
	return ok && replacement.LocalContentSHA256 != ""
}

func independentlySelectedGoFiles(
	a Analysis,
	record PackageRecord,
	files map[string]FileRecord,
) ([]string, error) {
	var result []string
	for _, fileID := range record.FileIDs {
		file := files[fileID]
		if pathpkg.Ext(file.Path) != ".go" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(file.ContentBase64)
		if err != nil {
			return nil, fmt.Errorf("cannot classify captured Go source file %q", file.ID)
		}
		selected, err := capturedGoFileSelected(a, record, file.Path, data)
		if err != nil {
			return nil, fmt.Errorf("classify captured Go source file %q: %w", file.ID, err)
		}
		if selected {
			result = append(result, file.ID)
		}
	}
	sort.Strings(result)
	return result, nil
}

func capturedGoFileSelected(
	a Analysis,
	record PackageRecord,
	path string,
	data []byte,
) (bool, error) {
	profile := Profile{
		RequestedGoVersion:   strings.TrimPrefix(a.Toolchain.RequestedVersion, "go"),
		GOOS:                 a.Profile.GOOS,
		GOARCH:               a.Profile.GOARCH,
		ArchitectureFeatures: append([]string{}, a.Profile.ArchitectureFeatures...),
		BuildTags:            append([]string{}, a.Profile.BuildTags...),
		CGOEnabled:           a.Profile.CGOEnabled,
		GOFLAGS:              append([]string{}, a.Profile.GOFLAGS...),
	}
	effectiveTags, err := effectiveBuildTags(profile)
	if err != nil {
		return false, err
	}
	profile.BuildTags = effectiveTags
	context := profileBuildContext(profile)
	context.CgoEnabled = profile.CGOEnabled
	context.OpenFile = func(string) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(data)), nil
	}
	matched, err := context.MatchFile("captured", pathpkg.Base(path))
	if err != nil || !matched {
		return false, err
	}
	file, err := parser.ParseFile(token.NewFileSet(), path, data, parser.PackageClauseOnly)
	if err != nil || file.Name.Name != record.Name {
		return false, err
	}
	testFile := strings.HasSuffix(pathpkg.Base(path), "_test.go")
	switch record.Variant {
	case "ordinary":
		return !testFile, nil
	case "in-package-test":
		return true, nil
	case "external-test":
		return testFile, nil
	case "synthetic-test-main":
		return false, nil
	default:
		return false, fmt.Errorf("unsupported package variant %q", record.Variant)
	}
}

func capturedMethodAuthorityImports(
	record PackageRecord,
	fileIDs []string,
	files map[string]FileRecord,
	packages map[string]PackageRecord,
) ([]string, error) {
	importsByPath := map[string]string{}
	for _, importedID := range record.ImportPackageIDs {
		imported, ok := packages[importedID]
		if !ok {
			return nil, fmt.Errorf("package %q method-authority closure has unknown import %q",
				record.ID, importedID)
		}
		if existing := importsByPath[imported.ImportPath]; existing != "" && existing != importedID {
			return nil, fmt.Errorf("package %q method-authority closure has ambiguous import path %q",
				record.ID, imported.ImportPath)
		}
		importsByPath[imported.ImportPath] = importedID
	}
	selected := map[string]bool{}
	for _, fileID := range fileIDs {
		file := files[fileID]
		data, err := base64.StdEncoding.DecodeString(file.ContentBase64)
		if err != nil {
			return nil, fmt.Errorf("cannot decode method-authority source file %q", file.ID)
		}
		parsed, err := parser.ParseFile(
			token.NewFileSet(), file.Path, data, parser.SkipObjectResolution|parser.AllErrors)
		if err != nil {
			return nil, fmt.Errorf("cannot parse method-authority source file %q: %w", file.ID, err)
		}
		aliases := map[string]string{}
		var dotImports []string
		for _, specification := range parsed.Imports {
			importPath, err := strconv.Unquote(specification.Path.Value)
			if err != nil || importPath == "unsafe" {
				continue
			}
			importedID := importsByPath[importPath]
			name := ""
			if specification.Name != nil {
				name = specification.Name.Name
			}
			switch name {
			case "_":
				continue
			case ".":
				dotImports = append(dotImports, importedID)
			case "":
				if importedID != "" {
					aliases[packages[importedID].Name] = importedID
				}
			default:
				aliases[name] = importedID
			}
		}
		inspect := func(node ast.Node) error {
			var missing string
			ast.Inspect(node, func(candidate ast.Node) bool {
				selector, ok := candidate.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				identifier, ok := selector.X.(*ast.Ident)
				if !ok {
					return true
				}
				if importedID, exists := aliases[identifier.Name]; exists {
					if importedID == "" {
						missing = identifier.Name
					} else {
						selected[importedID] = true
					}
				}
				return true
			})
			if missing != "" {
				return fmt.Errorf("package %q method-authority source uses unavailable import alias %q",
					record.ID, missing)
			}
			for _, importedID := range dotImports {
				if importedID == "" {
					return fmt.Errorf("package %q method-authority source uses unavailable dot import", record.ID)
				}
				selected[importedID] = true
			}
			return nil
		}
		for _, declaration := range parsed.Decls {
			switch value := declaration.(type) {
			case *ast.GenDecl:
				if value.Tok == token.TYPE || value.Tok == token.CONST {
					if err := inspect(value); err != nil {
						return nil, err
					}
				}
			case *ast.FuncDecl:
				if value.Recv != nil {
					if err := inspect(value.Recv); err != nil {
						return nil, err
					}
					if err := inspect(value.Type); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	result := make([]string, 0, len(selected))
	for packageID := range selected {
		result = append(result, packageID)
	}
	sort.Strings(result)
	return result, nil
}

type retypedRootType struct {
	packageID string
	name      string
	symbolID  string
	typeName  *types.TypeName
}

type retypedMethodAuthority struct {
	packages         map[string]*packages.Package
	typeBySymbol     map[string]*types.TypeName
	symbolByMethod   map[*types.Func]string
	symbolByType     map[*types.TypeName]string
	declarationOwner map[*types.Func]*types.TypeName
	declarationIndex map[*types.Func]int
	rootTypes        []retypedRootType
}

func validateRetypedMethodSets(
	ctx context.Context,
	a Analysis,
	files map[string]FileRecord,
	symbols map[string]SymbolRecord,
) error {
	if !a.InventoryComplete || !slices.ContainsFunc(a.Modules, func(value ModuleRecord) bool {
		return value.Main
	}) {
		return nil
	}
	authority, err := retypeMethodAuthority(ctx, a, files, symbols)
	if err != nil {
		return err
	}

	sets := map[string]map[bool]MethodSetRecord{}
	for _, record := range a.MethodSets {
		if sets[record.OwnerSymbolID] == nil {
			sets[record.OwnerSymbolID] = map[bool]MethodSetRecord{}
		}
		if sets[record.OwnerSymbolID][record.Pointer].ID != "" {
			return fmt.Errorf("type symbol %q has duplicate pointer=%v method sets",
				record.OwnerSymbolID, record.Pointer)
		}
		sets[record.OwnerSymbolID][record.Pointer] = record
	}
	eligibleOwners := make(map[string]bool, len(authority.rootTypes))
	for _, rootType := range authority.rootTypes {
		eligibleOwners[rootType.symbolID] = true
		for _, pointer := range []bool{false, true} {
			record := sets[rootType.symbolID][pointer]
			if record.ID == "" {
				return fmt.Errorf(
					"re-type-checked package-scope type %q.%s requires complete value and pointer method sets",
					rootType.packageID, rootType.name)
			}
			expected, err := retypedMethodSetTuples(
				rootType.typeName, pointer, authority.symbolByMethod)
			if err != nil {
				return fmt.Errorf("method set %q cannot derive captured-source membership: %w", record.ID, err)
			}
			actual := make([]string, 0, len(record.MethodSymbolIDs))
			for _, methodID := range record.MethodSymbolIDs {
				method := symbols[methodID]
				actual = append(actual, methodSetTuple(
					method.MethodOriginSymbolID, method.MethodSelectionIndexPath))
			}
			sort.Strings(actual)
			if !slices.Equal(actual, expected) {
				return fmt.Errorf(
					"method set %q membership differs from re-type-checked captured source: expected %q, got %q",
					record.ID, expected, actual)
			}
		}
	}
	for _, symbol := range a.Symbols {
		if symbol.MethodSetOwner && !eligibleOwners[symbol.ID] {
			return fmt.Errorf(
				"method-set owner symbol %q does not match an eligible re-type-checked package-scope type",
				symbol.ID)
		}
	}
	return nil
}

func retypeMethodAuthority(
	ctx context.Context,
	a Analysis,
	files map[string]FileRecord,
	symbols map[string]SymbolRecord,
) (retypedMethodAuthority, error) {
	result := retypedMethodAuthority{
		packages:         map[string]*packages.Package{},
		typeBySymbol:     map[string]*types.TypeName{},
		symbolByMethod:   map[*types.Func]string{},
		symbolByType:     map[*types.TypeName]string{},
		declarationOwner: map[*types.Func]*types.TypeName{},
		declarationIndex: map[*types.Func]int{},
	}
	plan, err := deriveMethodAuthorityPlan(a, files)
	if err != nil {
		return result, err
	}
	loaded := make([]*packages.Package, 0, len(a.Packages))
	for _, record := range a.Packages {
		pkg := &packages.Package{
			ID: record.ID, PkgPath: record.ImportPath, Name: record.Name,
			Imports: map[string]*packages.Package{},
		}
		if record.LanguageVersion != "" {
			pkg.Module = &packages.Module{GoVersion: strings.TrimPrefix(record.LanguageVersion, "go")}
		}
		result.packages[record.ID] = pkg
		loaded = append(loaded, pkg)
	}
	sources := map[string][]byte{}
	sourceHashes := map[string]string{}
	for _, record := range a.Packages {
		pkg := result.packages[record.ID]
		if !plan.closurePackages[record.ID] {
			pkg.Types = types.NewPackage(record.ImportPath, record.Name)
			continue
		}
		for _, fileID := range plan.selectedFiles[record.ID] {
			file := files[fileID]
			data, err := base64.StdEncoding.DecodeString(file.ContentBase64)
			if err != nil {
				return result, fmt.Errorf("method-authority source file %q has invalid content", fileID)
			}
			if existing := sourceHashes[file.Path]; existing != "" && existing != file.SHA256 {
				return result, fmt.Errorf("method-authority source path %q has conflicting captured content", file.Path)
			}
			data, err = methodAuthoritySource(file.Path, data)
			if err != nil {
				return result, fmt.Errorf("prepare method-authority source file %q: %w", fileID, err)
			}
			sourceHashes[file.Path] = file.SHA256
			sources[file.Path] = data
			pkg.GoFiles = append(pkg.GoFiles, file.Path)
		}
		if len(pkg.GoFiles) == 0 {
			name := record.Name
			if name == "" {
				name = pathpkg.Base(record.ImportPath)
			}
			pkg.Types = types.NewPackage(record.ImportPath, name)
		}
	}
	for _, record := range a.Packages {
		pkg := result.packages[record.ID]
		for _, importID := range record.ImportPackageIDs {
			imported := result.packages[importID]
			if imported == nil {
				return result, fmt.Errorf("package %q has unavailable captured import %q", record.ID, importID)
			}
			if existing := pkg.Imports[imported.PkgPath]; existing != nil && existing != imported {
				return result, fmt.Errorf("package %q has ambiguous captured import path %q",
					record.ID, imported.PkgPath)
			}
			pkg.Imports[imported.PkgPath] = imported
		}
	}
	profile := Profile{
		RequestedGoVersion: strings.TrimPrefix(a.Toolchain.ActualVersion, "go"),
		GOARCH:             a.Profile.GOARCH,
	}
	if err := typeCheckMethodAuthorityPackages(ctx, loaded, sources, profile); err != nil {
		return result, fmt.Errorf("re-type-check captured source: %w", err)
	}
	for _, record := range a.Packages {
		pkg := result.packages[record.ID]
		if !record.InventoryComplete {
			continue
		}
		if pkg.Types == nil || pkg.IllTyped {
			message := "unknown type-check failure"
			if len(pkg.Errors) != 0 {
				message = pkg.Errors[0].Error()
			}
			return result, fmt.Errorf("re-type-check package %q from captured source: %s", record.ID, message)
		}
	}

	declarations := map[string][]SymbolRecord{}
	for _, symbol := range symbols {
		if symbol.Declaration != nil {
			key := sourceDeclarationKey(symbol.PackageID, *symbol.Declaration)
			declarations[key] = append(declarations[key], symbol)
		}
	}
	typeDeclarationKeys := map[*types.TypeName]string{}
	for _, record := range a.Packages {
		pkg := result.packages[record.ID]
		if pkg.TypesInfo == nil || pkg.Fset == nil {
			continue
		}
		type definition struct {
			name string
			key  string
			obj  types.Object
		}
		definitions := make([]definition, 0, len(pkg.TypesInfo.Defs))
		for identifier, object := range pkg.TypesInfo.Defs {
			if object == nil {
				continue
			}
			start := pkg.Fset.PositionFor(identifier.Pos(), false)
			end := pkg.Fset.PositionFor(identifier.End(), false)
			key := sourceDeclarationKey(record.ID, SourceSpan{
				Path: start.Filename, StartByte: start.Offset, EndByte: end.Offset,
			})
			definitions = append(definitions, definition{
				name: identifier.Name, key: key, obj: object,
			})
		}
		sort.Slice(definitions, func(i, j int) bool {
			if definitions[i].key != definitions[j].key {
				return definitions[i].key < definitions[j].key
			}
			return definitions[i].name < definitions[j].name
		})
		for _, definition := range definitions {
			candidates := declarations[definition.key]
			if len(candidates) > 1 {
				return result, fmt.Errorf(
					"re-type-checked declaration %q maps to %d serialized symbols",
					definition.key, len(candidates))
			}
			var symbol SymbolRecord
			if len(candidates) == 1 {
				symbol = candidates[0]
			}
			switch object := objectOrigin(definition.obj).(type) {
			case *types.Func:
				if symbol.ID != "" {
					result.symbolByMethod[object] = symbol.ID
				}
			case *types.TypeName:
				typeDeclarationKeys[object] = definition.key
				if symbol.ID != "" {
					result.typeBySymbol[symbol.ID] = object
					result.symbolByType[object] = symbol.ID
				}
			}
		}
	}
	for _, record := range a.Packages {
		pkg := result.packages[record.ID]
		if pkg.Types == nil || !record.InventoryComplete {
			continue
		}
		names := pkg.Types.Scope().Names()
		sort.Strings(names)
		for _, name := range names {
			typeName, ok := pkg.Types.Scope().Lookup(name).(*types.TypeName)
			if !ok {
				continue
			}
			symbolID := result.symbolByType[typeName]
			if plan.rootPackages[record.ID] {
				key := typeDeclarationKeys[typeName]
				candidates := declarations[key]
				if key == "" || len(candidates) != 1 {
					return result, fmt.Errorf(
						"re-type-checked package-scope type %q.%s maps to %d serialized symbols",
						record.ID, name, len(candidates))
				}
				symbol := candidates[0]
				if symbol.PackageID != record.ID || symbol.Name != name ||
					symbol.Kind != "type" || !symbol.PackageScopeType || !symbol.MethodSetOwner {
					return result, fmt.Errorf(
						"re-type-checked package-scope type %q.%s has ineligible serialized owner %q",
						record.ID, name, symbol.ID)
				}
				symbolID = symbol.ID
				result.typeBySymbol[symbolID] = typeName
				result.symbolByType[typeName] = symbolID
				result.rootTypes = append(result.rootTypes, retypedRootType{
					packageID: record.ID, name: name, symbolID: symbolID, typeName: typeName,
				})
			}
			if symbolID != "" {
				indexRetypedDeclaredMethods(
					typeName, result.declarationOwner, result.declarationIndex)
			}
		}
	}
	sort.Slice(result.rootTypes, func(i, j int) bool {
		if result.rootTypes[i].packageID != result.rootTypes[j].packageID {
			return result.rootTypes[i].packageID < result.rootTypes[j].packageID
		}
		return result.rootTypes[i].name < result.rootTypes[j].name
	})
	type declarationAuthority struct {
		method   *types.Func
		methodID string
		ownerID  string
	}
	var declarationsToValidate []declarationAuthority
	for method, owner := range result.declarationOwner {
		method = method.Origin()
		methodID := result.symbolByMethod[method]
		ownerID := result.symbolByType[owner]
		if methodID == "" {
			continue
		}
		if ownerID == "" {
			return result, fmt.Errorf("re-type-checked method declaration lacks serialized source provenance")
		}
		declarationsToValidate = append(declarationsToValidate, declarationAuthority{
			method: method, methodID: methodID, ownerID: ownerID,
		})
	}
	sort.Slice(declarationsToValidate, func(i, j int) bool {
		return declarationsToValidate[i].methodID < declarationsToValidate[j].methodID
	})
	for _, declaration := range declarationsToValidate {
		method, methodID, ownerID := declaration.method, declaration.methodID, declaration.ownerID
		symbol := symbols[methodID]
		if symbol.MethodDeclarationOwnerID != ownerID ||
			symbol.MethodDeclarationIndex != result.declarationIndex[method] ||
			symbol.MethodDeclarationPointer != methodReceiverPointer(method) {
			return result, fmt.Errorf(
				"method declaration symbol %q disagrees with re-type-checked captured source", methodID)
		}
	}
	return result, nil
}

func methodAuthoritySource(path string, data []byte) ([]byte, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, data, parser.SkipObjectResolution|parser.AllErrors)
	if err != nil {
		return nil, err
	}
	tokenFile := fset.File(file.Pos())
	result := append([]byte{}, data...)
	blank := func(start, end token.Pos) {
		first, last := tokenFile.Offset(start), tokenFile.Offset(end)
		for index := first; index < last; index++ {
			if result[index] != '\n' && result[index] != '\r' {
				result[index] = ' '
			}
		}
	}
	for _, declaration := range file.Decls {
		switch value := declaration.(type) {
		case *ast.GenDecl:
			if value.Tok == token.VAR {
				blank(value.Pos(), value.End())
			}
		case *ast.FuncDecl:
			if value.Recv == nil {
				blank(value.Pos(), value.End())
			}
		}
	}
	return result, nil
}

func indexRetypedDeclaredMethods(
	typeName *types.TypeName,
	owners map[*types.Func]*types.TypeName,
	indexes map[*types.Func]int,
) {
	switch value := typeName.Type().(type) {
	case *types.Alias:
		if iface, ok := value.Rhs().(*types.Interface); ok {
			iface.Complete()
			for index := 0; index < iface.NumExplicitMethods(); index++ {
				method := iface.ExplicitMethod(index).Origin()
				owners[method] = typeName
				indexes[method] = index
			}
		}
	case *types.Named:
		value = value.Origin()
		for index := 0; index < value.NumMethods(); index++ {
			method := value.Method(index).Origin()
			owners[method] = value.Obj()
			indexes[method] = index
		}
		if iface, ok := value.Underlying().(*types.Interface); ok {
			iface.Complete()
			for index := 0; index < iface.NumExplicitMethods(); index++ {
				method := iface.ExplicitMethod(index).Origin()
				owners[method] = value.Obj()
				indexes[method] = index
			}
		}
	}
}

func retypedMethodSetTuples(
	typeName *types.TypeName,
	pointer bool,
	symbolByMethod map[*types.Func]string,
) ([]string, error) {
	var target types.Type = typeName.Type()
	if pointer {
		target = types.NewPointer(target)
	}
	set := types.NewMethodSet(target)
	result := make([]string, 0, set.Len())
	for index := 0; index < set.Len(); index++ {
		selection := set.At(index)
		method, ok := objectOrigin(selection.Obj()).(*types.Func)
		if !ok {
			return nil, fmt.Errorf("selection %q is not a function", selection.Obj().Name())
		}
		originID := symbolByMethod[method]
		if originID == "" {
			return nil, fmt.Errorf("method %q has no serialized source declaration", method.Name())
		}
		result = append(result, methodSetTuple(originID, selection.Index()))
	}
	sort.Strings(result)
	return result, nil
}

func methodSetTuple(originID string, indexPath []int) string {
	return originID + "@" + selectionIndexKey(indexPath)
}

type sourceTypeReference struct {
	name      string
	qualifier string
	pointer   bool
}

type sourceFieldDeclaration struct {
	name      string
	embedded  bool
	reference sourceTypeReference
}

type sourceTypeDeclaration struct {
	name            string
	kind            string
	alias           bool
	target          sourceTypeReference
	fields          []sourceFieldDeclaration
	interfaceEmbeds []sourceTypeReference
	imports         map[string]string
	dotImports      map[string]bool
}

type sourceMethodDeclaration struct {
	name      string
	ownerName string
	pointer   bool
}

type sourceDeclarationIndex struct {
	types   map[string]sourceTypeDeclaration
	methods map[string]sourceMethodDeclaration
}

func sourceDeclarationKey(packageID string, span SourceSpan) string {
	return packageID + "\x00" + span.Path + "\x00" +
		strconv.Itoa(span.StartByte) + ":" + strconv.Itoa(span.EndByte)
}

func sourceOffsetKey(packageID, path string, file *token.File, start, end token.Pos) string {
	return packageID + "\x00" + path + "\x00" +
		strconv.Itoa(file.Offset(start)) + ":" + strconv.Itoa(file.Offset(end))
}

func indexSourceDeclarations(
	files []FileRecord,
	packages map[string]PackageRecord,
) (sourceDeclarationIndex, error) {
	result := sourceDeclarationIndex{
		types:   map[string]sourceTypeDeclaration{},
		methods: map[string]sourceMethodDeclaration{},
	}
	packageNames := map[string]string{}
	for _, pkg := range packages {
		if packageNames[pkg.ImportPath] == "" || pkg.Variant == "ordinary" {
			packageNames[pkg.ImportPath] = pkg.Name
		}
	}
	for _, record := range files {
		if record.Role != "compiled" || !packages[record.PackageID].InventoryComplete {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(record.ContentBase64)
		if err != nil {
			return result, fmt.Errorf("cannot decode source declarations from file %q", record.ID)
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, record.Path, data, parser.SkipObjectResolution)
		if err != nil {
			return result, fmt.Errorf("cannot parse source declarations from file %q: %w", record.ID, err)
		}
		tokenFile := fset.File(file.Pos())
		imports, dotImports := sourceImports(file, packageNames)
		for _, declaration := range file.Decls {
			switch value := declaration.(type) {
			case *ast.GenDecl:
				if value.Tok != token.TYPE {
					continue
				}
				for _, raw := range value.Specs {
					specification, ok := raw.(*ast.TypeSpec)
					if !ok {
						continue
					}
					typeDeclaration := sourceTypeDeclaration{
						name: specification.Name.Name, alias: specification.Assign.IsValid(),
						imports: imports, dotImports: dotImports,
					}
					typeDeclaration.target, _ = sourceTypeReferenceFor(specification.Type)
					switch declared := specification.Type.(type) {
					case *ast.StructType:
						typeDeclaration.kind = "struct"
						typeDeclaration.fields = sourceStructFields(declared)
					case *ast.InterfaceType:
						typeDeclaration.kind = "interface"
						for _, field := range declared.Methods.List {
							if len(field.Names) == 0 {
								if reference, ok := sourceTypeReferenceFor(field.Type); ok {
									typeDeclaration.interfaceEmbeds = append(
										typeDeclaration.interfaceEmbeds, reference)
								}
								continue
							}
							if _, ok := field.Type.(*ast.FuncType); !ok {
								continue
							}
							for _, name := range field.Names {
								key := sourceOffsetKey(record.PackageID, record.Path, tokenFile, name.Pos(), name.End())
								result.methods[key] = sourceMethodDeclaration{
									name: name.Name, ownerName: specification.Name.Name,
								}
							}
						}
					default:
						typeDeclaration.kind = "reference"
					}
					key := sourceOffsetKey(
						record.PackageID, record.Path, tokenFile,
						specification.Name.Pos(), specification.Name.End(),
					)
					result.types[key] = typeDeclaration
				}
			case *ast.FuncDecl:
				if value.Recv == nil || len(value.Recv.List) != 1 {
					continue
				}
				receiver, ok := sourceTypeReferenceFor(value.Recv.List[0].Type)
				if !ok {
					continue
				}
				key := sourceOffsetKey(record.PackageID, record.Path, tokenFile, value.Name.Pos(), value.Name.End())
				result.methods[key] = sourceMethodDeclaration{
					name: value.Name.Name, ownerName: receiver.name, pointer: receiver.pointer,
				}
			}
		}
	}
	return result, nil
}

func sourceImports(file *ast.File, packageNames map[string]string) (map[string]string, map[string]bool) {
	imports := map[string]string{}
	dotImports := map[string]bool{}
	for _, specification := range file.Imports {
		importPath, err := strconv.Unquote(specification.Path.Value)
		if err != nil {
			continue
		}
		name := packageNames[importPath]
		if name == "" {
			name = pathpkg.Base(importPath)
		}
		if specification.Name != nil {
			name = specification.Name.Name
		}
		switch name {
		case "_":
			continue
		case ".":
			dotImports[importPath] = true
		default:
			imports[name] = importPath
		}
	}
	return imports, dotImports
}

func sourceStructFields(structure *ast.StructType) []sourceFieldDeclaration {
	var result []sourceFieldDeclaration
	for _, field := range structure.Fields.List {
		reference, _ := sourceTypeReferenceFor(field.Type)
		if len(field.Names) == 0 {
			result = append(result, sourceFieldDeclaration{embedded: true, reference: reference})
			continue
		}
		for _, name := range field.Names {
			result = append(result, sourceFieldDeclaration{name: name.Name, reference: reference})
		}
	}
	return result
}

func sourceTypeReferenceFor(expression ast.Expr) (sourceTypeReference, bool) {
	result := sourceTypeReference{}
	for {
		switch value := expression.(type) {
		case *ast.ParenExpr:
			expression = value.X
		case *ast.StarExpr:
			if result.pointer {
				return sourceTypeReference{}, false
			}
			result.pointer = true
			expression = value.X
		case *ast.IndexExpr:
			expression = value.X
		case *ast.IndexListExpr:
			expression = value.X
		case *ast.Ident:
			result.name = value.Name
			return result, true
		case *ast.SelectorExpr:
			qualifier, ok := value.X.(*ast.Ident)
			if !ok {
				return sourceTypeReference{}, false
			}
			result.qualifier = qualifier.Name
			result.name = value.Sel.Name
			return result, true
		default:
			return sourceTypeReference{}, false
		}
	}
}

func validateDeclaredMethodIndexes(symbols []SymbolRecord) error {
	indexes := map[string]map[int]string{}
	for _, symbol := range symbols {
		if symbol.MethodDeclarationOwnerID == "" {
			continue
		}
		if indexes[symbol.MethodDeclarationOwnerID] == nil {
			indexes[symbol.MethodDeclarationOwnerID] = map[int]string{}
		}
		if existing := indexes[symbol.MethodDeclarationOwnerID][symbol.MethodDeclarationIndex]; existing != "" {
			return fmt.Errorf("method declarations %q and %q share owner index %d",
				existing, symbol.ID, symbol.MethodDeclarationIndex)
		}
		indexes[symbol.MethodDeclarationOwnerID][symbol.MethodDeclarationIndex] = symbol.ID
	}
	return nil
}

func validateMethodSelection(
	methodSet MethodSetRecord,
	method SymbolRecord,
	origin SymbolRecord,
	symbols map[string]SymbolRecord,
	typesByID map[string]TypeRecord,
	packages map[string]PackageRecord,
	packageTypes map[string]SymbolRecord,
	declarations sourceDeclarationIndex,
) error {
	owner := symbols[methodSet.OwnerSymbolID]
	pointerEligible := methodSet.Pointer
	var err error
	owner, pointerEligible, err = resolveMethodOwner(
		owner, pointerEligible, symbols, typesByID, packages, packageTypes, declarations)
	if err != nil {
		return fmt.Errorf("method-set symbol %q selection is inconsistent: %w", method.ID, err)
	}
	indexPath := method.MethodSelectionIndexPath
	for _, fieldIndex := range indexPath[:len(indexPath)-1] {
		typeRecord := typesByID[owner.TypeID]
		if fieldIndex < 0 || fieldIndex >= len(typeRecord.Fields) {
			return fmt.Errorf("method-set symbol %q selection field index %d is out of range", method.ID, fieldIndex)
		}
		field := typeRecord.Fields[fieldIndex]
		if !field.Embedded {
			return fmt.Errorf("method-set symbol %q selection field index %d is not embedded", method.ID, fieldIndex)
		}
		if owner.Declaration != nil {
			if declaration, ok := declarations.types[sourceDeclarationKey(owner.PackageID, *owner.Declaration)]; ok &&
				declaration.kind == "struct" {
				if fieldIndex >= len(declaration.fields) ||
					!declaration.fields[fieldIndex].embedded ||
					!sourceReferenceMatchesType(
						declaration.fields[fieldIndex].reference, declaration,
						packages[owner.PackageID], typesByID[field.TypeID], typesByID,
					) {
					return fmt.Errorf("method-set symbol %q promoted selection path disagrees with source", method.ID)
				}
			}
		}
		owner, pointerEligible, err = methodOwnerForType(
			field.TypeID, owner.PackageID, pointerEligible,
			symbols, typesByID, packages, packageTypes, declarations,
		)
		if err != nil {
			return fmt.Errorf("method-set symbol %q promoted selection is inconsistent: %w", method.ID, err)
		}
	}
	originOwner := symbols[origin.MethodDeclarationOwnerID]
	if owner.ID != originOwner.ID {
		reachable, reachErr := interfaceMethodOwnerReachable(
			owner, originOwner, symbols, typesByID, packages, packageTypes, declarations, map[string]bool{})
		if reachErr != nil {
			return fmt.Errorf("method-set symbol %q interface selection is inconsistent: %w", method.ID, reachErr)
		}
		if !reachable {
			return fmt.Errorf("method-set symbol %q selection reaches owner %q, not declaration owner %q",
				method.ID, owner.ID, originOwner.ID)
		}
	}
	ownerDeclaration := sourceTypeDeclaration{}
	if originOwner.Declaration != nil {
		ownerDeclaration = declarations.types[sourceDeclarationKey(originOwner.PackageID, *originOwner.Declaration)]
	}
	if ownerDeclaration.kind != "interface" &&
		indexPath[len(indexPath)-1] != origin.MethodDeclarationIndex {
		return fmt.Errorf("method-set symbol %q selection method index is inconsistent", method.ID)
	}
	if origin.MethodDeclarationPointer && !pointerEligible {
		return fmt.Errorf("method-set symbol %q includes a pointer-only method in a value method set", method.ID)
	}
	return nil
}

func resolveMethodOwner(
	owner SymbolRecord,
	pointerEligible bool,
	symbols map[string]SymbolRecord,
	typesByID map[string]TypeRecord,
	packages map[string]PackageRecord,
	packageTypes map[string]SymbolRecord,
	declarations sourceDeclarationIndex,
) (SymbolRecord, bool, error) {
	seen := map[string]bool{}
	for {
		record := typesByID[owner.TypeID]
		if !record.Alias {
			return owner, pointerEligible, nil
		}
		if seen[owner.ID] {
			return SymbolRecord{}, pointerEligible, errors.New("alias owner cycle")
		}
		seen[owner.ID] = true
		if owner.Declaration == nil {
			return SymbolRecord{}, pointerEligible, errors.New("alias owner has no source declaration")
		}
		declaration := declarations.types[sourceDeclarationKey(owner.PackageID, *owner.Declaration)]
		target := typesByID[record.AliasTargetTypeID]
		if !declaration.alias ||
			(declaration.kind == "reference" &&
				!sourceReferenceMatchesType(declaration.target, declaration, packages[owner.PackageID], target, typesByID)) ||
			(declaration.kind == "interface" && target.Kind != "interface") ||
			(declaration.kind == "struct" && target.Kind != "struct") {
			return SymbolRecord{}, pointerEligible, errors.New("alias target disagrees with source")
		}
		targetBase := target
		for targetBase.Kind == "pointer" {
			pointerEligible = true
			targetBase = typesByID[targetBase.ElementTypeID]
		}
		if targetBase.Name == "" {
			return owner, pointerEligible, nil
		}
		var err error
		owner, pointerEligible, err = methodOwnerForType(
			record.AliasTargetTypeID, owner.PackageID, pointerEligible,
			symbols, typesByID, packages, packageTypes, declarations,
		)
		if err != nil {
			return SymbolRecord{}, pointerEligible, err
		}
	}
}

func methodOwnerForType(
	typeID, contextPackageID string,
	pointerEligible bool,
	symbols map[string]SymbolRecord,
	typesByID map[string]TypeRecord,
	packages map[string]PackageRecord,
	packageTypes map[string]SymbolRecord,
	declarations sourceDeclarationIndex,
) (SymbolRecord, bool, error) {
	record := typesByID[typeID]
	for record.Kind == "pointer" {
		pointerEligible = true
		record = typesByID[record.ElementTypeID]
	}
	if record.Name == "" || record.Package == "" {
		return SymbolRecord{}, pointerEligible, fmt.Errorf("type %q has no declared owner", typeID)
	}
	packageID := contextPackageID
	if packages[packageID].ImportPath != record.Package {
		packageID = ""
		for id, pkg := range packages {
			if pkg.ImportPath == record.Package &&
				(packageID == "" || pkg.Variant == "ordinary") {
				packageID = id
				if pkg.Variant == "ordinary" {
					break
				}
			}
		}
	}
	owner := packageTypes[packageID+"\x00"+record.Name]
	if owner.ID == "" {
		return SymbolRecord{}, pointerEligible,
			fmt.Errorf("type %q has no package-scope owner symbol", typeID)
	}
	return resolveMethodOwner(
		owner, pointerEligible, symbols, typesByID, packages, packageTypes, declarations)
}

func sourceReferenceMatchesType(
	reference sourceTypeReference,
	declaration sourceTypeDeclaration,
	pkg PackageRecord,
	record TypeRecord,
	typesByID map[string]TypeRecord,
) bool {
	pointer := false
	for record.Kind == "pointer" {
		pointer = true
		record = typesByID[record.ElementTypeID]
	}
	if reference.name == "" || reference.name != record.Name || reference.pointer != pointer {
		return false
	}
	if reference.qualifier != "" {
		return declaration.imports[reference.qualifier] == record.Package
	}
	return record.Package == pkg.ImportPath || declaration.dotImports[record.Package]
}

func interfaceMethodOwnerReachable(
	owner, target SymbolRecord,
	symbols map[string]SymbolRecord,
	typesByID map[string]TypeRecord,
	packages map[string]PackageRecord,
	packageTypes map[string]SymbolRecord,
	declarations sourceDeclarationIndex,
	seen map[string]bool,
) (bool, error) {
	if owner.ID == target.ID {
		return true, nil
	}
	if seen[owner.ID] || owner.Declaration == nil {
		return false, nil
	}
	seen[owner.ID] = true
	declaration := declarations.types[sourceDeclarationKey(owner.PackageID, *owner.Declaration)]
	if declaration.kind != "interface" {
		return false, nil
	}
	for _, embedded := range declaration.interfaceEmbeds {
		embeddedOwner := sourceReferenceOwner(embedded, declaration, owner.PackageID, packages, packageTypes)
		if embeddedOwner.ID == "" {
			return false, fmt.Errorf("interface owner %q has an unresolved embedded type", owner.ID)
		}
		resolved, _, err := resolveMethodOwner(
			embeddedOwner, false, symbols, typesByID, packages, packageTypes, declarations)
		if err != nil {
			return false, err
		}
		if reachable, err := interfaceMethodOwnerReachable(
			resolved, target, symbols, typesByID, packages, packageTypes, declarations, seen,
		); err != nil || reachable {
			return reachable, err
		}
	}
	return false, nil
}

func sourceReferenceOwner(
	reference sourceTypeReference,
	declaration sourceTypeDeclaration,
	contextPackageID string,
	packages map[string]PackageRecord,
	packageTypes map[string]SymbolRecord,
) SymbolRecord {
	packageID := contextPackageID
	if reference.qualifier != "" {
		importPath := declaration.imports[reference.qualifier]
		packageID = ""
		for id, pkg := range packages {
			if pkg.ImportPath == importPath && (packageID == "" || pkg.Variant == "ordinary") {
				packageID = id
				if pkg.Variant == "ordinary" {
					break
				}
			}
		}
	} else if packageTypes[packageID+"\x00"+reference.name].ID == "" {
		for importPath := range declaration.dotImports {
			for id, pkg := range packages {
				if pkg.ImportPath == importPath && pkg.Variant == "ordinary" {
					if owner := packageTypes[id+"\x00"+reference.name]; owner.ID != "" {
						return owner
					}
				}
			}
		}
	}
	return packageTypes[packageID+"\x00"+reference.name]
}

func validateNodeTrees(fileOrder []string, nodesByFile map[string][]string, nodes map[string]NodeRecord) error {
	for _, fileID := range fileOrder {
		nodeIDs := nodesByFile[fileID]
		roots := make([]string, 0, 1)
		for _, nodeID := range nodeIDs {
			node := nodes[nodeID]
			if node.ParentID == "" {
				if node.Kind != "*ast.File" {
					return fmt.Errorf("node %q is a detached parentless non-*ast.File node", node.ID)
				}
				roots = append(roots, node.ID)
			} else if node.Kind == "*ast.File" {
				return fmt.Errorf("*ast.File node %q has a parent", node.ID)
			}
		}

		state := make(map[string]uint8, len(nodeIDs))
		for _, startID := range nodeIDs {
			if state[startID] == 2 {
				continue
			}
			var path []string
			currentID := startID
			for currentID != "" && state[currentID] == 0 {
				state[currentID] = 1
				path = append(path, currentID)
				currentID = nodes[currentID].ParentID
			}
			if currentID != "" && state[currentID] == 1 {
				if nodes[currentID].ParentID == currentID {
					return fmt.Errorf("node %q has a self-cycle", currentID)
				}
				return fmt.Errorf("node graph for file %q contains a parent cycle at node %q", fileID, currentID)
			}
			for _, nodeID := range path {
				state[nodeID] = 2
			}
		}

		if len(roots) != 1 {
			return fmt.Errorf("node graph for file %q requires exactly one parentless *ast.File root; found %d", fileID, len(roots))
		}
	}
	return nil
}

func validateScopeParents(values []ScopeRecord, scopes map[string]ScopeRecord) error {
	for _, scope := range values {
		if scope.ParentID == "" {
			continue
		}
		parent, ok := scopes[scope.ParentID]
		if !ok || parent.PackageID != scope.PackageID {
			return fmt.Errorf("scope %q parent ownership is inconsistent", scope.ID)
		}
	}
	state := make(map[string]uint8, len(scopes))
	for _, scope := range values {
		if state[scope.ID] == 2 {
			continue
		}
		path := []string{}
		for id := scope.ID; id != ""; {
			switch state[id] {
			case 1:
				return fmt.Errorf("scope %q parent cycle is inconsistent", id)
			case 2:
				id = ""
				continue
			}
			state[id] = 1
			path = append(path, id)
			id = scopes[id].ParentID
		}
		for _, id := range path {
			state[id] = 2
		}
	}
	return nil
}

func validateSpanInPackage(span SourceSpan, packageID string, listings map[string]map[string]int, files map[string]FileRecord, owner string, positionMaps map[string]*sourcePositionMap) error {
	for fileID := range listings[packageID] {
		file := files[fileID]
		if file.Path == span.Path {
			return validateSpanForFile(span, file, owner, positionMaps)
		}
	}
	return fmt.Errorf("%s path %q does not belong to package %q", owner, span.Path, packageID)
}

func validateSpanForFile(span SourceSpan, file FileRecord, owner string, positionMaps map[string]*sourcePositionMap) error {
	if span.Path != file.Path || int64(span.StartByte) > file.Bytes || int64(span.EndByte) > file.Bytes {
		return fmt.Errorf("%s does not match file %q or exceeds its byte bounds", owner, file.ID)
	}
	positions := positionMaps[file.ID]
	if positions == nil {
		data, err := base64.StdEncoding.DecodeString(file.ContentBase64)
		if err != nil {
			return fmt.Errorf("%s references file %q with invalid content", owner, file.ID)
		}
		positions, err = newSourcePositionMap(file.Path, data)
		if err != nil {
			return fmt.Errorf("%s cannot reconstruct file %q positions: %w", owner, file.ID, err)
		}
		positionMaps[file.ID] = positions
	}
	rawStart, rawEnd, displayPath, displayLine, displayColumn, lineDirective :=
		positions.span(span.StartByte, span.EndByte)
	if span.StartLine != rawStart.Line || span.StartColumn != rawStart.Column ||
		span.EndLine != rawEnd.Line || span.EndColumn != rawEnd.Column {
		return fmt.Errorf("%s raw coordinates do not match file %q byte offsets", owner, file.ID)
	}
	if span.DisplayPath != displayPath || span.DisplayLine != displayLine ||
		span.DisplayColumn != displayColumn || span.LineDirective != lineDirective {
		return fmt.Errorf("%s display coordinates do not match file %q line directives", owner, file.ID)
	}
	return nil
}

func validPortableLocation(value string) bool {
	if value == "" || filepath.IsAbs(value) {
		return false
	}
	prefixes := []string{"source://", "module://", "goroot://", "line://", "external://"}
	prefix := ""
	for _, candidate := range prefixes {
		if strings.HasPrefix(value, candidate) {
			prefix = candidate
			break
		}
	}
	if prefix == "" {
		return false
	}
	path := strings.TrimPrefix(value, prefix)
	if path == "" || path == "." || strings.Contains(path, "\\") || isDrivePath(path) ||
		strings.HasPrefix(path, "/") || filepath.IsAbs(path) || filepath.VolumeName(path) != "" {
		return false
	}
	clean := pathpkg.Clean(path)
	return clean == path && clean != ".." && !strings.HasPrefix(clean, "../")
}

func isDrivePath(value string) bool {
	return len(value) >= 2 && ((value[0] >= 'a' && value[0] <= 'z') ||
		(value[0] >= 'A' && value[0] <= 'Z')) && value[1] == ':'
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
