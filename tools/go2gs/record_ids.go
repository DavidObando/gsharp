// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

func moduleRecordID(value ModuleRecord) string {
	if value.LocalContentSHA256 != "" {
		return stableID("module", value.Path+"\x00local-replacement\x00"+value.LocalContentSHA256)
	}
	return stableID("module", value.Path+"\x00"+value.Version+"\x00replace\x00"+value.ReplacementID)
}

func fileRecordID(value FileRecord) string {
	return stableID("file", value.PackageID+"\x00"+value.Path+"\x00"+value.SHA256)
}

func typeRecordID(value TypeRecord) string {
	return stableID("type", value.Canonical)
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
