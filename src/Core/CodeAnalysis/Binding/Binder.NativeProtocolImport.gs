// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Text.Json

partial class Binder {
    private func ImportNativeProtocols(location TextLocation) {
        if $scope.References is not{} references {
            return
        }
        let registry = $scope.GetStructuralAdapterRegistry()
        for assembly in references.Assemblies.OrderBy((item Assembly) -> item.FullName, StringComparer.Ordinal) {
            let contract = NativeProtocolMetadata.Read(assembly)
            if contract.Error is {} error {
                Diagnostics.ReportNativeProtocol(location, assembly.FullName + ": " + error)
                continue
            }
            if contract.Manifest.ValueKind == JsonValueKind.Undefined {
                continue
            }
            try {
                let manifest = contract.Manifest
                let seenSources = HashSet[string](StringComparer.Ordinal)
                for declaration in manifest.GetProperty("declarations").EnumerateArray() {
                    let type = assembly.GetType(declaration.GetProperty("type").GetString()!!, throwOnError: true)!!
                    let protocol = TypeSymbol.FromClrTypeWithoutNullability(
                        type,
                        NullabilityFreeReason.ResolvedTypeName
                    )
                    ValidateNativeProtocolSlots(declaration.GetProperty("slots"), protocol, assembly.FullName!!)
                }
                for record in manifest.GetProperty("entries").EnumerateArray() {
                    NativeProtocolMetadata.RequireFields(record, "source", "origin", "storage", "coverage")
                    let sourceIdentity = NativeProtocolMetadata.Require(record, "source", JsonValueKind.String)
                        .GetString()!!
                    if !seenSources.Add(sourceIdentity) {
                        throw InvalidDataException("duplicate native protocol source record")
                    }
                    let sourceClr = ResolveNativeProtocolIdentity(sourceIdentity)
                    if !sourceClr.IsVisible ||
                        sourceClr.IsGenericType ||
                        sourceClr.IsEnum ||
                        sourceClr.IsInterface ||
                        sourceClr.IsByRefLike ||
                        !sourceClr.IsValueType &&
                        !sourceClr.IsSealed {
                        throw InvalidDataException("unsupported or inaccessible native protocol insertion type")
                    }
                    let source = TypeSymbol.FromClrTypeWithoutNullability(
                        sourceClr,
                        NullabilityFreeReason.ResolvedTypeName
                    )
                    let origin = NativeProtocolMetadata.Require(record, "origin", JsonValueKind.String).GetString()!!
                    let originAssembly = references.Assemblies.SingleOrDefault(
                        (item Assembly) -> item.FullName == origin
                    )
                    if originAssembly == nil {
                        throw InvalidDataException("missing canonical native protocol origin reference")
                    }
                    if origin != assembly.FullName {
                        let original = NativeProtocolMetadata.Read(originAssembly)
                        if original.Error != nil ||
                            original
                            .Manifest
                            .ValueKind == JsonValueKind.Undefined ||
                            !original
                            .Manifest
                            .GetProperty("entries")
                            .EnumerateArray()
                            .Any((item JsonElement) -> item.GetRawText() == record.GetRawText()) {
                            throw InvalidDataException(
                                "native protocol re-export does not preserve its canonical origin record"
                            )
                        }
                    }
                    if NativeProtocolMetadata.Require(record, "storage", JsonValueKind.String)
                        .GetString() != "retaining-entry/shallow-copy/1" {
                        throw InvalidDataException("unsupported native protocol storage/transport contract")
                    }
                    let entry = ImportedNativeProtocolEntry(source, origin, record.Clone())
                    for decision in NativeProtocolMetadata.Require(record, "coverage", JsonValueKind.Array)
                        .EnumerateArray() {
                        if decision.ValueKind != JsonValueKind.Object || !decision.TryGetProperty(
                            "positive",
                            out var positiveValue
                        ) ||
                            positiveValue.ValueKind != JsonValueKind.True &&
                            positiveValue.ValueKind != JsonValueKind.False {
                            throw InvalidDataException("malformed native protocol decision")
                        }
                        let positive = positiveValue.GetBoolean()
                        if positive {
                            NativeProtocolMetadata.RequireFields(
                                decision,
                                "protocol",
                                "slots",
                                "positive",
                                "targets",
                                "support",
                                "factory",
                                "matches",
                                "recover"
                            )
                        } else {
                            NativeProtocolMetadata.RequireFields(decision, "protocol", "slots", "positive", "targets")
                        }
                        let protocolClr = ResolveNativeProtocolIdentity(
                            NativeProtocolMetadata.Require(decision, "protocol", JsonValueKind.String).GetString()!!
                        )
                        let protocol = TypeSymbol.FromClrTypeWithoutNullability(
                            protocolClr,
                            NullabilityFreeReason.ResolvedTypeName
                        )
                        if !NativeProtocolMetadata.IsProtocol(protocol) || !protocolClr.IsVisible {
                            throw InvalidDataException("missing or inaccessible native protocol declaration evidence")
                        }
                        let slots = ValidateNativeProtocolSlots(
                            NativeProtocolMetadata.Require(decision, "slots", JsonValueKind.Array),
                            protocol,
                            origin
                        )
                        let targets = NativeProtocolMetadata.Require(decision, "targets", JsonValueKind.Array)
                        if targets.GetArrayLength() != (
                            if positive {
                                slots.Length
                            } else {
                                0
                            }
                        ) {
                            throw InvalidDataException("incomplete native protocol witness coverage")
                        }
                        let seenSlots = HashSet[string](StringComparer.Ordinal)
                        for target in targets.EnumerateArray() {
                            NativeProtocolMetadata.RequireFields(
                                target,
                                "slot",
                                "owner",
                                "name",
                                "signature",
                                "kind",
                                "authority"
                            )
                            let slotIdentity = NativeProtocolMetadata.Require(target, "slot", JsonValueKind.String)
                                .GetString()!!
                            let matchingSlots = slots.Where(
                                (slot FunctionSymbol) ->
                                NativeProtocolMetadata.Signature(slot, origin) == slotIdentity
                            )
                                .ToArray()
                            if matchingSlots.Length != 1 || !seenSlots.Add(slotIdentity) {
                                throw InvalidDataException("stale or duplicate native protocol witness slot")
                            }
                            let owner = ResolveNativeProtocolIdentity(
                                NativeProtocolMetadata.Require(target, "owner", JsonValueKind.String).GetString()!!
                            )
                            let name = NativeProtocolMetadata.Require(target, "name", JsonValueKind.String)
                                .GetString()!!
                            let signature = NativeProtocolMetadata.Require(target, "signature", JsonValueKind.String)
                                .GetString()!!
                            let kind = NativeProtocolMetadata.Require(target, "kind", JsonValueKind.String).GetString()
                            if !owner.IsVisible || NativeProtocolMetadata.Require(
                                target,
                                "authority",
                                JsonValueKind.String
                            )
                                .GetString() != "public" || kind != "instance" && kind != "extension-value" {
                                throw InvalidDataException(
                                    "invalid native protocol witness authority or receiver convention"
                                )
                            }
                            let ownerSymbol = TypeSymbol.FromClrTypeWithoutNullability(
                                owner,
                                NullabilityFreeReason.ResolvedTypeName
                            )
                            let methods = owner
                                .GetMethods(
                                BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
                            )
                                .Where(
                                (method MethodInfo) -> method.Name == name &&
                                    ImportedMethodMetadataSupported(method) &&
                                    NativeProtocolMetadata.Signature(
                                    CreateImportedAdapterContractMethod(method, ownerSymbol),
                                    origin
                                ) == signature
                            )
                                .ToArray()
                            if methods.Length != 1 || methods[0].IsStatic != (kind == "extension-value") {
                                throw InvalidDataException("stale or inaccessible exact native protocol witness target")
                            }
                            let candidate = CreateImportedAdapterContractMethod(methods[0], ownerSymbol)
                            let offset = if kind == "extension-value" {
                                1
                            } else {
                                0
                            }
                            if !NativeProtocolSignaturesMatch(matchingSlots[0], candidate, offset) ||
                                offset == 1 &&
                                candidate
                                .Parameters[0]
                                .Type != source ||
                                offset == 0 &&
                                !owner
                                .IsAssignableFrom(sourceClr) {
                                throw InvalidDataException(
                                    "native protocol witness signature does not match its exact insertion type"
                                )
                            }
                        }
                        var factory MethodInfo? = nil
                        var matches MethodInfo? = nil
                        var recover MethodInfo? = nil
                        if positive {
                            let supportName = NativeProtocolMetadata.Require(decision, "support", JsonValueKind.String)
                                .GetString()!!
                            let support = originAssembly.GetType(supportName, throwOnError: false)
                            if support == nil ||
                                !support.IsVisible ||
                                support.IsGenericType ||
                                !NativeProtocolMetadata
                                .HasSupportedFeatureMarker(support) {
                                throw InvalidDataException("missing public native protocol bridge contract")
                            }
                            factory = FindNativeProtocolBridge(support, decision, "factory", protocol, source)
                            matches = FindNativeProtocolBridge(
                                support,
                                decision,
                                "matches",
                                TypeSymbol.Bool,
                                NullableTypeSymbol.Get(protocol)
                            )
                            recover = FindNativeProtocolBridge(support, decision, "recover", source, protocol)
                        }
                        if !entry.Decisions.TryAdd(
                            protocol,
                            ImportedNativeProtocolDecision(
                                protocol,
                                positive,
                                origin + "|" + decision.GetRawText(),
                                factory,
                                matches,
                                recover
                            )
                        ) {
                            throw InvalidDataException("duplicate native protocol conformance/negative record")
                        }
                    }
                    if entry.Decisions.Count == 0 {
                        throw InvalidDataException("native protocol insertion entry has no conformance coverage")
                    }
                    let previous = registry.ImportedProtocolEntries.FirstOrDefault(
                        (item ImportedNativeProtocolEntry) -> item.SourceType == source
                    )
                    if previous != nil {
                        if previous.Origin != origin || previous.Record.GetRawText() != entry.Record.GetRawText() {
                            throw InvalidDataException(
                                "conflicting or unsupported multiple native entry origins for '${source.Name}'"
                            )
                        }
                        for decision in entry.Decisions {
                            if previous.Decisions.TryGetValue(decision.Key, out var old) {
                                if old.Fingerprint != decision.Value.Fingerprint {
                                    throw InvalidDataException(
                                        "conflicting canonical native protocol record for '${source.Name}/${decision.Key.Name}'"
                                    )
                                }
                            } else {
                                previous.Decisions.Add(decision.Key, decision.Value)
                            }
                        }
                    } else {
                        registry.ImportedProtocolEntries.Add(entry)
                    }
                }
            } catch (error InvalidDataException) {
                Diagnostics.ReportNativeProtocol(location, assembly.FullName + ": " + error.Message)
            } catch (error FileNotFoundException) {
                Diagnostics.ReportNativeProtocol(
                    location,
                    "missing native protocol metadata dependency: " + error.Message
                )
            } catch (error TypeLoadException) {
                Diagnostics.ReportNativeProtocol(location, "invalid native protocol metadata type: " + error.Message)
            } catch (error ArgumentException) {
                Diagnostics.ReportNativeProtocol(
                    location,
                    "malformed native protocol symbolic metadata: " + error.Message
                )
            }
        }
    }

    private func ResolveNativeProtocolIdentity(identity string) Type {
        let separator = identity.IndexOf('|')
        if separator <= 0 || separator == identity.Length - 1 {
            throw InvalidDataException("malformed native protocol symbolic identity")
        }
        let assemblyIdentity = identity.Substring(0, separator)
        let name = identity.Substring(separator + 1)
        let assembly = $scope.References!!.Assemblies.SingleOrDefault(
            (item Assembly) -> item.FullName == assemblyIdentity
        )
        let type = assembly?.GetType(name, throwOnError: false)
        if type == nil {
            throw InvalidDataException("missing exact native protocol contract reference '" + identity + "'")
        }
        return type
    }

    private func ValidateNativeProtocolSlots(recorded JsonElement, protocol TypeSymbol, origin string) ImmutableArray[
        FunctionSymbol
    ] {
        let type = protocol.ClrType!!
        let methods = type.GetMethods()
        if !type.IsInterface || !NativeProtocolMetadata.HasSupportedFeatureMarker(type) ||
            type.IsGenericType ||
            type
            .GetInterfaces().Length != 0 || type.GetProperties().Length != 0 || type.GetEvents()
            .Length != 0 ||
            methods
            .Any(
            (method MethodInfo) -> method.IsStatic ||
                !method.IsAbstract ||
                !ImportedMethodMetadataSupported(method) ||
                method.IsGenericMethod ||
                method
                .ReturnType
                .IsByRef ||
                method
                .GetParameters().Any((parameter ParameterInfo) -> parameter.ParameterType.IsByRef)
        ) {
            throw InvalidDataException("unsupported native protocol slot contract")
        }
        let slots = methods.Select((method MethodInfo) -> CreateImportedAdapterContractMethod(method, protocol))
            .ToImmutableArray()
        for slot in slots {
            NativeProtocolSafety.ValidateSignature(slot, Diagnostics)
        }
        let expected = slots
            .Select((slot FunctionSymbol) -> NativeProtocolMetadata.Signature(slot, origin))
            .OrderBy((value string) -> value, StringComparer.Ordinal)
            .ToArray()
        let actual = recorded
            .EnumerateArray()
            .Select(
            (item JsonElement) -> {
                if item.ValueKind != JsonValueKind.String {
                    throw InvalidDataException("malformed native protocol slot identity")
                }
                return item.GetString()!!
            }
        )
            .ToArray()
        if !expected.SequenceEqual(actual, StringComparer.Ordinal) {
            throw InvalidDataException(
                "stale or incomplete native protocol contract revision; imported [" + string.Join("; ", expected) +
                    "], recorded [" +
                    string.Join("; ", actual) + "]"
            )
        }
        return slots
    }

    private func FindNativeProtocolBridge(
        support Type,
        record JsonElement,
        field string,
        result TypeSymbol,
        parameter TypeSymbol
    ) MethodInfo {
        let name = NativeProtocolMetadata.Require(record, field, JsonValueKind.String).GetString()!!
        let owner = TypeSymbol.FromClrTypeWithoutNullability(support, NullabilityFreeReason.ResolvedTypeName)
        let candidates = support
            .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(
            (method MethodInfo) -> {
                if method.Name != name || !ImportedMethodMetadataSupported(method) || method.IsGenericMethod {
                    return false
                }
                let symbolic = CreateImportedAdapterContractMethod(method, owner)
                return symbolic.ReturnRefKind == RefKind.None &&
                    symbolic.Type == result &&
                    symbolic
                    .Parameters
                    .Length == 1 &&
                    symbolic
                    .Parameters[0]
                    .RefKind == RefKind.None &&
                    symbolic
                    .Parameters[0]
                    .Type == parameter
            }
        )
            .ToArray()
        if candidates.Length != 1 {
            throw InvalidDataException("stale or unsupported typed native protocol bridge '" + field + "'")
        }
        return candidates[0]
    }
}
