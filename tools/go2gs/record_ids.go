// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"encoding/json"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

func semanticProfileIdentity(profile ProfileSnapshot, toolchain ToolchainProvenance) string {
	payload, _ := json.Marshal(struct {
		ActualGoVersion      string
		HelperGoVersion      string
		GOROOTGoVersion      string
		GOROOTIdentity       string
		LoadTests            bool
		GOOS                 string
		GOARCH               string
		ArchitectureFeatures []string
		BuildTags            []string
		CGOEnabled           bool
		GOFLAGS              []string
		GOEXPERIMENT         string
		GODEBUG              map[string]string
		ModuleMode           string
		VendorMode           bool
		WorkspaceMode        string
	}{
		ActualGoVersion: toolchain.ActualVersion, HelperGoVersion: toolchain.HelperSemanticVersion,
		GOROOTGoVersion: toolchain.GOROOTVersion, GOROOTIdentity: toolchain.GOROOTIdentity,
		LoadTests: profile.LoadTests,
		GOOS:      profile.GOOS, GOARCH: profile.GOARCH,
		ArchitectureFeatures: profile.ArchitectureFeatures, BuildTags: profile.BuildTags,
		CGOEnabled: profile.CGOEnabled, GOFLAGS: profile.GOFLAGS,
		GOEXPERIMENT: profile.GOEXPERIMENT, GODEBUG: profile.GODEBUG,
		ModuleMode: profile.ModuleMode, VendorMode: profile.VendorMode, WorkspaceMode: profile.WorkspaceMode,
	})
	return stableID("semanticProfile", string(payload))
}

func moduleRecordID(value ModuleRecord) string {
	if value.LocalContentSHA256 != "" {
		return stableID("module", value.Path+"\x00local-replacement\x00"+value.LocalContentSHA256)
	}
	return stableID("module", value.Path+"\x00"+value.Version+"\x00replace\x00"+value.ReplacementID)
}

func packageRecordID(semanticProfileID string, value PackageRecord) string {
	return stableID("package", semanticProfileID+"\x00"+value.ModuleID+"\x00"+
		value.ImportPath+"\x00"+value.Variant)
}

func fileRecordID(value FileRecord) string {
	return stableID("file", value.PackageID+"\x00"+value.Path+"\x00"+value.SHA256)
}

func typeRecordID(semanticProfileID string, value TypeRecord) string {
	return stableID("type", semanticProfileID+"\x00"+value.Canonical)
}

func nodeRecordID(value NodeRecord) string {
	return stableID("node", value.PackageID+"\x00"+value.FileID+"\x00"+
		strconv.Itoa(value.Span.StartByte)+":"+strconv.Itoa(value.Span.EndByte)+":"+value.Kind)
}

func constantRecordID(value ConstantRecord) string {
	owner := value.NodeID
	if value.SymbolID != "" {
		owner = value.SymbolID
	}
	return stableID("constant", owner+"\x00"+value.Exact)
}

func scopeRecordID(value ScopeRecord) string {
	return stableID("scope", value.PackageID+"\x00"+
		strconv.Itoa(value.Span.StartByte)+":"+strconv.Itoa(value.Span.EndByte))
}

func selectionRecordID(value SelectionRecord) string {
	return stableID("selection", value.NodeID)
}

func callRecordID(value CallRecord) string {
	return stableID("call", value.NodeID)
}

func methodSetRecordID(value MethodSetRecord) string {
	return stableID("methodSet", value.TypeID+"\x00"+strconv.FormatBool(value.Pointer))
}

func instanceRecordID(value InstanceRecord) string {
	return stableID("instance", value.NodeID)
}

func embedRecordID(value EmbedRecord) string {
	return stableID("embed", value.PackageID+"\x00"+value.Pattern+"\x00"+value.LogicalName)
}

func generateRecordID(value GenerateRecord) string {
	return stableID("generate", value.FileID+"\x00"+strconv.Itoa(value.Span.StartByte))
}

func dependencyRecordID(value DependencyRecord) string {
	return stableID("dependency", value.FromPackageID+"\x00"+value.ImportPath)
}

func featureRecordID(value FeatureSite) string {
	return stableID("feature", value.NodeID+"\x00"+value.Feature)
}

func diagnosticRecordID(value DiagnosticRecord) string {
	kind, _ := diagnosticErrorKind(value.Category)
	return stableID("diagnostic", value.PackageID+"\x00"+strconv.Itoa(int(kind))+"\x00"+
		value.Position+"\x00"+value.Message)
}

func diagnosticErrorKind(category string) (packages.ErrorKind, bool) {
	switch category {
	case "loader":
		return packages.ListError, true
	case "parser":
		return packages.ParseError, true
	case "typechecker":
		return packages.TypeError, true
	case "unknown":
		return packages.UnknownError, true
	default:
		return packages.UnknownError, false
	}
}

func blockerRecordID(value BlockerRecord) string {
	return blockerRecordIDPayload(value.Blocks, value.Category, value.Message, value.AffectedUnits)
}

func blockerRecordIDPayload(blocks, category, message string, affectedUnits []string) string {
	return stableID("blocker", blocks+"\x00"+category+"\x00"+message+"\x00"+
		strings.Join(affectedUnits, "\x00"))
}
