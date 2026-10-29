// <copyright file="AssemblyAttributeEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Globalization
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Runtime.CompilerServices
import System.Runtime.Versioning

/// PR-E-13 (#1361): assembly-attribute emitter. Owns the assembly-level
/// attribute orchestrators that decorate the `Assembly` row built in
/// `EmitCore`, plus the assembly-version parsing that feeds that row.
/// @remarks Methods moved here from (cref:ReflectionMetadataEmitter) in
/// PR-E-13:
///
/// - `EmitReferenceAssemblyAttribute` — marks metadata-only assemblies with
/// `ReferenceAssemblyAttribute`.
/// - `ParseAssemblyVersion` — parses (cref:EmitContext.AssemblyVersionOverride) into the four-part
/// (cref:Version) for the Assembly row.
/// - `EmitAssemblyInteropAttributes` — the cross-language-interop orchestrator (informational version,
/// type-semantics metadata, friend assemblies, assembly-level nullable context).
/// - `EmitUserAssemblyAttributes` — emits every user-declared `@assembly:` annotation (issue #2237).
/// - `EmitFriendAssemblyAttributes` — one `InternalsVisibleToAttribute` row per declared friend (issues
/// #1929/#1953).
/// - `EmitGSharpTypeSemantics` — the `AssemblyMetadataAttribute` type-semantics payload consumed by
/// (cref:ImportedAssemblySemantics).
/// - `EmitDebuggableAttribute` — stamps optimized or non-optimized CLR debugging flags independently
/// from PDB presence.
/// - `EmitNullableContextAttribute` — assembly-level `NullableContextAttribute(1)`.
///
/// Blob writing is delegated to (cref:CustomAttributeEncoder)
/// wherever the attribute shape allows; the fixed-shape emitters here
/// (reference-assembly, debuggable, nullable-context) write their blobs
/// inline exactly as they did on the root.
internal class AssemblyAttributeEmitter {
    private let emitCtx EmitContext
    private let cache MetadataTokenCache
    private let wellKnown WellKnownReferences
    private let attrEncoder CustomAttributeEncoder
    private let getTypeReference(Type) -> TypeReferenceHandle

    init(
        emitCtx EmitContext,
        cache MetadataTokenCache,
        wellKnown WellKnownReferences,
        attrEncoder CustomAttributeEncoder,
        getTypeReference(Type) -> TypeReferenceHandle
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.cache = cache ?? throw ArgumentNullException("cache")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.attrEncoder = attrEncoder ?? throw ArgumentNullException("attrEncoder")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
    }

    /// Marks the assembly with
    /// `System.Runtime.CompilerServices.ReferenceAssemblyAttribute()` so
    /// loaders treat it as metadata-only and refuse to execute its (absent)
    /// method bodies.
    func EmitReferenceAssemblyAttribute(assemblyHandle AssemblyDefinitionHandle) {
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Runtime.CompilerServices.ReferenceAssemblyAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            throw InvalidOperationException(
                "Reference assembly emit requires System.Runtime.CompilerServices.ReferenceAssemblyAttribute to be resolvable from the supplied references."
            )
            default(Type)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            0,
            (r ReturnTypeEncoder) -> r.Void(),
            (_ ParametersEncoder) -> { }
        )
        let ctorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        // Empty fixed/named argument blob: prolog 0x0001 + 0 named args.
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Parses the declared AssemblyVersion, or (cref:EmitContext.AssemblyVersionOverride)
    /// when none is declared, into the assembly identity. Falls back to `1.0.0.0` when absent or
    /// does not parse as a version.
    func ParseAssemblyVersion() Version {
        // Assembly identity and informational/product version are distinct.
        // The SDK supplies the former through its generated AssemblyInfo.
        let versionAttribute = this
            .emitCtx
            .Program
            .AssemblyAttributes
            .FirstOrDefault(
            (attribute BoundAttribute) -> attribute
                .AttributeType
                .ClrType
                ?.FullName == "System.Reflection.AssemblyVersionAttribute"
        )
        let declaredVersion string? = versionAttribute?.GetConstructorArgument(0, "version")?.Value as string
        var versionStr = declaredVersion ?? this.emitCtx.AssemblyVersionOverride
        if string.IsNullOrEmpty(versionStr) {
            return Version(1, 0, 0, 0)
        }
        // NuGet versions can contain pre-release suffixes (e.g. "1.2.3-beta.1").
        // Extract just the numeric prefix for System.Version.
        let dashIdx = versionStr.IndexOf('-')
        if dashIdx >= 0 {
            versionStr = versionStr.Substring(0, dashIdx)
        }
        let plusIdx = versionStr!!.IndexOf('+')
        if plusIdx >= 0 {
            versionStr = versionStr!!.Substring(0, plusIdx)
        }
        if Version.TryParse(versionStr, out var v) {
            // Pad to four components for ECMA-335 assembly identity.
            return Version(Math.Max(v.Major, 0), Math.Max(v.Minor, 0), Math.Max(v.Build, 0), Math.Max(v.Revision, 0))
        }
        return Version(1, 0, 0, 0)
    }

    /// Emits assembly-level attributes required for cross-language interop (C#/F#
    /// consumability): `AssemblyInformationalVersionAttribute`,
    /// `AssemblyMetadataAttribute("RepositoryUrl", ...)`, and
    /// `NullableContextAttribute(1)`.
    func EmitAssemblyInteropAttributes(assemblyHandle AssemblyDefinitionHandle) {
        // Issue #2237: emit every user-declared `@assembly:` attribute
        // (everything except InternalsVisibleTo, which keeps its dedicated
        // emission below) first, so the built-in synthesized attributes that
        // follow can detect — and skip — a type the user already declared
        // explicitly (e.g. an NBGV-style
        // `@assembly:AssemblyInformationalVersionAttribute(...)`), avoiding a
        // duplicate, non-repeatable CustomAttribute row.
        let userDeclaredAttributeTypeNames = this.EmitUserAssemblyAttributes(assemblyHandle)
        // 1. AssemblyInformationalVersionAttribute — carries the full NuGet
        // version string including pre-release suffix.
        if !string.IsNullOrEmpty(this.emitCtx.AssemblyVersionOverride) && !userDeclaredAttributeTypeNames.Contains(
            "System.Reflection.AssemblyInformationalVersionAttribute"
        ) {
            this.attrEncoder.EmitStringAttribute(
                assemblyHandle,
                "System.Reflection.AssemblyInformationalVersionAttribute",
                typeof(AssemblyInformationalVersionAttribute),
                this.emitCtx.AssemblyVersionOverride!!
            )
        }
        if !string.IsNullOrEmpty(this.emitCtx.TargetFrameworkMoniker) && !userDeclaredAttributeTypeNames.Contains(
            "System.Runtime.Versioning.TargetFrameworkAttribute"
        ) {
            this.attrEncoder.EmitStringAttribute(
                assemblyHandle,
                "System.Runtime.Versioning.TargetFrameworkAttribute",
                typeof(TargetFrameworkAttribute),
                this.emitCtx.TargetFrameworkMoniker!!
            )
        }
        this.EmitGSharpTypeSemantics(assemblyHandle)
        this.EmitNativeProtocolDeclarations(assemblyHandle)
        this.EmitGSharpMagicCollectionFieldMarkers(assemblyHandle)
        // Issue #1929/#1953: producer-declared friend assemblies. Each
        // `@assembly:InternalsVisibleTo("Foo")` annotation becomes a real
        // System.Runtime.CompilerServices.InternalsVisibleToAttribute row so
        // cross-assembly internal access is genuine producer opt-in — no
        // consumer-side name heuristic (see ImportedAssemblySemantics).
        this.EmitFriendAssemblyAttributes(assemblyHandle)
        // 2. NullableContextAttribute(1) — declares the assembly's default
        // nullable context as "annotated" so C# consumers see non-null by
        // default for GSharp types (GSharp has no null references).
        this.EmitNullableContextAttribute(assemblyHandle)
    }

    /// Issue #2237: emits a real `CustomAttribute` row for every
    /// file-level `@assembly:` annotation the binder resolved
    /// ((cref:Binding.BoundProgram.AssemblyAttributes)) — every
    /// annotation EXCEPT `InternalsVisibleTo`, which
    /// (cref:EmitFriendAssemblyAttributes) already covers. Reuses the
    /// same generic (cref:CustomAttributeEncoder.EmitBoundAttribute)
    /// path used for type/method/field-level attributes, so any attribute
    /// type the compiler can resolve — BCL (`AssemblyVersionAttribute`,
    /// `AssemblyMetadataAttribute`, ...) or a same-compilation
    /// user-declared attribute type — becomes real assembly metadata,
    /// achieving parity with C#'s `[assembly: ...]`.
    /// @returns The distinct set of emitted attributes' CLR type full names, used by
    /// (cref:EmitAssemblyInteropAttributes) to avoid emitting a
    /// duplicate built-in synthesized attribute of the same (non-repeatable)
    /// type.
    private func EmitUserAssemblyAttributes(assemblyHandle AssemblyDefinitionHandle) ImmutableHashSet[string] {
        let emitted = ImmutableHashSet.CreateBuilder[string](StringComparer.Ordinal)
        for attr in this.emitCtx.Program.AssemblyAttributes {
            this.attrEncoder.EmitBoundAttribute(assemblyHandle, attr)
            let clrTypeName string? = attr.AttributeType?.ClrType?.FullName
            if clrTypeName != nil {
                emitted.Add(clrTypeName)
            }
        }
        return emitted.ToImmutable()
    }

    /// Emits every user-declared `@module:` annotation on the module row.
    func EmitUserModuleAttributes(moduleHandle ModuleDefinitionHandle) {
        for attr in this.emitCtx.Program.ModuleAttributes {
            this.attrEncoder.EmitBoundAttribute(moduleHandle, attr)
        }
    }

    private func EmitFriendAssemblyAttributes(assemblyHandle AssemblyDefinitionHandle) {
        for friend in this.emitCtx.Program.FriendAssemblies {
            this.attrEncoder.EmitStringAttribute(
                assemblyHandle,
                "System.Runtime.CompilerServices.InternalsVisibleToAttribute",
                typeof(InternalsVisibleToAttribute),
                friend
            )
        }
    }

    private func EmitNativeProtocolDeclarations(assemblyHandle AssemblyDefinitionHandle) {
        let assemblyIdentity = (this.emitCtx.AssemblyNameOverride ?? this.emitCtx.Program.PackageName ?? "Default") +
            ", Version=" +
            this
            .ParseAssemblyVersion().ToString() + ", Culture=neutral, PublicKeyToken=null"
        let declarations = this
            .emitCtx
            .Program
            .Interfaces
            .Where((item InterfaceSymbol) -> item.IsProtocol && NativeProtocolMetadata.IsPublic(item))
            .Select(
            (item InterfaceSymbol) -> NativeProtocolRecord(
                ("type", NativeProtocolMetadata.TypeName(item)),
                (
                    "slots",
                    item
                        .Methods
                        .Select((method FunctionSymbol) -> NativeProtocolMetadata.Signature(method, assemblyIdentity))
                        .OrderBy((signature string) -> signature, StringComparer.Ordinal)
                        .ToArray()
                )
            )
        )
            .OrderBy((item Dictionary[string, object]) -> cast[string](item["type"]), StringComparer.Ordinal)
            .ToArray()
        let entries = List[object]()
        for entry in this
            .emitCtx
            .Program
            .Structs
            .Where((item StructSymbol) -> item.NativeProtocolEntry != nil)
            .Select((item StructSymbol) -> item.NativeProtocolEntry!!)
            .OrderBy(
            (item NativeProtocolEntryPlan) -> NativeProtocolMetadata.Identity(item.SourceType, assemblyIdentity),
            StringComparer.Ordinal
        ) {
            if !NativeProtocolMetadata.IsPublic(entry.SourceType) {
                continue
            }
            let coverage = List[object]()
            for decision in entry
                .Decisions
                .Where((item NativeProtocolDecision) -> NativeProtocolMetadata.IsPublic(item.Protocol))
                .OrderBy(
                (item NativeProtocolDecision) -> NativeProtocolMetadata.Identity(item.Protocol, assemblyIdentity),
                StringComparer.Ordinal
            ) {
                let targets = List[object]()
                for witness in decision.Witnesses.OrderBy(
                    (item NativeProtocolWitness) -> NativeProtocolMetadata.Signature(item.Slot, assemblyIdentity),
                    StringComparer.Ordinal
                ) {
                    let imported = witness.ImportedTarget
                    let source = witness.Target
                    let owner = if imported != nil {
                        let declaringType = imported.DeclaringType!!
                        declaringType.Assembly.FullName + "|" + declaringType.FullName
                    } else {
                        let target = source!!
                        if target.ReceiverType is {} receiver && !witness.IsExtension {
                            NativeProtocolMetadata.Identity(receiver, assemblyIdentity)
                        } else if target.StaticOwnerType is {} staticOwner {
                            NativeProtocolMetadata.Identity(staticOwner, assemblyIdentity)
                        } else {
                            assemblyIdentity + "|" + target.Package!!.Name + ".<Program>"
                        }
                    }
                    targets.Add(
                        NativeProtocolRecord(
                            ("slot", NativeProtocolMetadata.Signature(witness.Slot, assemblyIdentity)),
                            ("owner", owner),
                            ("name", imported?.Name ?? source!!.Name),
                            (
                                "signature",
                                if source != nil {
                                    NativeProtocolMetadata.Signature(source, assemblyIdentity)
                                } else {
                                    NativeProtocolMetadata.Signature(witness.Slot, assemblyIdentity)
                                }
                            ),
                            (
                                "kind",
                                if witness.IsExtension {
                                    "extension-value"
                                } else {
                                    "instance"
                                }
                            ),
                            ("authority", "public")
                        )
                    )
                }
                let record = NativeProtocolRecord(
                    ("protocol", NativeProtocolMetadata.Identity(decision.Protocol, assemblyIdentity)),
                    (
                        "slots",
                        decision
                            .Slots
                            .Select(
                            (method FunctionSymbol) -> NativeProtocolMetadata.Signature(method, assemblyIdentity)
                        )
                            .OrderBy((signature string) -> signature, StringComparer.Ordinal)
                            .ToArray()
                    ),
                    ("positive", decision.Positive),
                    ("targets", targets)
                )
                if decision.Positive {
                    let bridge = entry.Bridges.Single((item NativeProtocolBridge) -> item.Protocol == decision.Protocol)
                    record.Add("support", NativeProtocolMetadata.TypeName(entry.BridgeType!!))
                    record.Add("factory", bridge.Factory.Name)
                    record.Add("matches", bridge.Matches.Name)
                    record.Add("recover", bridge.Recover.Name)
                }
                coverage.Add(record)
            }
            if coverage.Count > 0 {
                entries.Add(
                    NativeProtocolRecord(
                        ("source", NativeProtocolMetadata.Identity(entry.SourceType, assemblyIdentity)),
                        ("origin", assemblyIdentity),
                        ("storage", "retaining-entry/shallow-copy/1"),
                        ("coverage", coverage)
                    )
                )
            }
        }
        if this.emitCtx.Program.NativeProtocols is {} nativePlan {
            for imported in nativePlan.Imports.OrderBy(
                (item ImportedNativeProtocolEntry) -> NativeProtocolMetadata.Identity(
                    item.SourceType,
                    assemblyIdentity
                ),
                StringComparer.Ordinal
            ) {
                entries.Add(imported.Record)
            }
        }
        if declarations.Length == 0 && entries.Count == 0 && this.emitCtx.Program.NativeProtocolOperations.Count == 0 {
            return
        }
        let payload = System.Collections.Generic.Dictionary[string, object]()
        payload.Add("schema", NativeProtocolMetadata.Schema)
        payload.Add("declarations", declarations)
        payload.Add("entries", entries)
        this.attrEncoder.EmitStringPairAttribute(
            assemblyHandle,
            "System.Reflection.AssemblyMetadataAttribute",
            typeof(AssemblyMetadataAttribute),
            NativeProtocolMetadata.FeatureKey,
            NativeProtocolMetadata.Schema
        )
        this.attrEncoder.EmitStringPairAttribute(
            assemblyHandle,
            "System.Reflection.AssemblyMetadataAttribute",
            typeof(AssemblyMetadataAttribute),
            NativeProtocolMetadata.Key,
            System.Text.Json.JsonSerializer.Serialize(payload)
        )
    }

    private func NativeProtocolRecord(fields ...(Name string, Value object)) Dictionary[string, object] {
        let result = Dictionary[string, object]()
        for field in fields {
            result.Add(field.Name, field.Value)
        }
        return result
    }

    private func EmitGSharpTypeSemantics(assemblyHandle AssemblyDefinitionHandle) {
        for type in this.emitCtx.Program.Structs {
            if !this.cache.StructTypeDefs.TryGetValue(type, out var handle) {
                continue
            }
            // Classes also carry their source inheritance mode: a sealed
            // hierarchy is deliberately not CLR-sealed. Plain classes remain
            // ordinary CLR imports, not data-semantic aggregates.
            if !type.IsClass && !type.IsData && !type.HasPrimaryConstructor {
                continue
            }
            // Issue #1953 follow-up: pair each primary-ctor parameter name
            // with its backing field's metadata token (0 when no backing
            // field is found, including a computed property), so the
            // importer (ImportedTypeSymbol.BuildPrimaryConstructorParameters)
            // can recover the parameter's type via the exact field even when
            // a future lowering/mangling pass makes the parameter name differ
            // from the field name — falling back to name matching only when
            // no token was recorded.
            let fieldsByName = type.Fields.ToDictionary((field FieldSymbol) -> field.Name, StringComparer.Ordinal)
            let parameterEntries = type.PrimaryConstructorParameters.Select(
                (p ParameterSymbol) -> {
                    var token = 0
                    var backingField FieldSymbol? = nil
                    let hasBacking = if type.UsesConstructorOwnedDataConstruction || type.IsClass && type.IsData {
                        ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(type, p.Name, out backingField)
                    } else {
                        fieldsByName.TryGetValue(p.Name, out backingField)
                    }
                    if hasBacking && this.cache.StructFieldDefs.TryGetValue(backingField!!, out var fieldHandle) {
                        token = MetadataTokens.GetToken(fieldHandle)
                    }
                    return "${p.Name}:${token.ToString(CultureInfo.InvariantCulture)}"
                }
            )
            let payload = string.Join(
                "|",
                MetadataTokens.GetToken(handle).ToString(CultureInfo.InvariantCulture),
                if type.IsClass {
                    "class"
                } else {
                    "struct"
                },
                if type.IsData {
                    "1"
                } else {
                    "0"
                },
                string.Join(",", parameterEntries),
                if type.IsSealedHierarchy {
                    "sealed"
                } else {
                    (
                        if type.IsOpen {
                            "open"
                        } else {
                            "closed"
                        }
                    )
                }
            )
            this.attrEncoder.EmitStringPairAttribute(
                assemblyHandle,
                "System.Reflection.AssemblyMetadataAttribute",
                typeof(AssemblyMetadataAttribute),
                ImportedAssemblySemantics.TypeSemanticsMetadataKey,
                payload
            )
        }
    }

    /// Records collection declaration shapes for struct fields and a data class's own primary storage.
    /// Imported primary arguments need these shapes before the selected constructor runs.
    /// ADR-0218 excludes class body fields and inherited storage.
    private func EmitGSharpMagicCollectionFieldMarkers(assemblyHandle AssemblyDefinitionHandle) {
        for type in this.emitCtx.Program.Structs {
            if type.IsClass && !type.IsData || !this.cache.StructTypeDefs.TryGetValue(type, out var handle) {
                continue
            }
            let entries = type
                .Fields
                .Concat(
                if type.UsesConstructorOwnedDataConstruction || type.IsClass && type.IsData {
                    type
                        .Properties
                        .Where(
                        (property PropertySymbol) -> property.BackingField != nil &&
                            type
                            .PrimaryConstructorParameters
                            .Any((parameter ParameterSymbol) -> parameter.Name == property.Name)
                    )
                        .Select((property PropertySymbol) -> property.BackingField!!)
                } else {
                    Enumerable.Empty[FieldSymbol]()
                }
            )
                .Where(
                (field FieldSymbol) -> !type.IsClass || type.PrimaryConstructorParameters.Any(
                    (parameter ParameterSymbol) -> ReflectionMetadataEmitter.TryGetPrimaryCtorTargetField(
                        type,
                        parameter.Name,
                        out var primaryField
                    ) &&
                        object.ReferenceEquals(field, primaryField)
                )
            )
                .Select((f FieldSymbol) -> (Field: f, Kind: MagicCollectionZeroValue.ClassifyForMarker(f.Type)))
                .Where((e(Field FieldSymbol, Kind string?)) -> e.Item2 != nil)
                .Select((e(Field FieldSymbol, Kind string?)) -> "${e.Item1.Name}:${e.Item2}")
                .ToArray()
            if entries.Length == 0 {
                continue
            }
            let payload = string.Join(
                "|",
                MetadataTokens.GetToken(handle).ToString(CultureInfo.InvariantCulture),
                string.Join(",", entries)
            )
            this.attrEncoder.EmitStringPairAttribute(
                assemblyHandle,
                "System.Reflection.AssemblyMetadataAttribute",
                typeof(AssemblyMetadataAttribute),
                ImportedAssemblySemantics.MagicCollectionFieldsMetadataKey,
                payload
            )
        }
    }

    /// Emits the CLR debugging flags for an optimized or non-optimized runtime
    /// assembly.
    func EmitDebuggableAttribute(assemblyHandle AssemblyDefinitionHandle, optimize bool) {
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(
            "System.Diagnostics.DebuggableAttribute",
            requireExternalVisibility: false,
            out var resolved
        ) {
            resolved!!
        } else {
            typeof(DebuggableAttribute)
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let modesType = Invariant.Required(
            attrType.GetNestedType("DebuggingModes"),
            "System.Diagnostics.DebuggableAttribute declares the nested DebuggingModes enum",
            expression: "attrType.GetNestedType(\"DebuggingModes\")"
        )
        let modesTypeRef = this.getTypeReference(modesType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> {
                p.AddParameter().Type().Type(modesTypeRef, isValueType: true)
            }
        )
        let ctorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001) // Prolog
        let flags = if optimize {
            DebuggableAttribute.DebuggingModes.IgnoreSymbolStoreSequencePoints
        } else {
            DebuggableAttribute.DebuggingModes.Default | DebuggableAttribute.DebuggingModes.DisableOptimizations
        }
        valueBlob.WriteInt32(int32(flags))
        valueBlob.WriteUInt16(0) // NumNamed
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Emits `System.Runtime.CompilerServices.NullableContextAttribute(1)`
    /// on the assembly so C# consumers see GSharp public surface as non-nullable
    /// (oblivious context = 0, annotated = 1, warnings-only = 2).
    private func EmitNullableContextAttribute(assemblyHandle AssemblyDefinitionHandle) {
        // Reuse the cached NullableContextAttribute(byte) ctor MemberRef so the
        // assembly-, type-, and method-level emitters all share one row (the
        // P3-11 dedup invariant; see DeterministicEmitTests).
        let ctorRef = this.wellKnown.GetNullableContextAttributeByteCtorRef()
        if ctorRef.IsNil {
            // The attribute may not exist in older TFMs — skip silently.
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001) // Prolog
        valueBlob.WriteByte(1) // Flag = Annotated (non-null by default)
        valueBlob.WriteUInt16(0) // NumNamed
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }
}
