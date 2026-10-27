// <copyright file="ImportedAssemblySemantics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Compilation
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices

internal enum ImportedInheritanceMode {
    Unknown,
    Open,
    Closed,
    SealedHierarchy
}

/// Reads the small cross-assembly semantic markers gsc writes onto assemblies
/// via (cref:AssemblyMetadataAttribute) rows, plus standard
/// (cref:System.Runtime.CompilerServices.InternalsVisibleToAttribute)
/// declarations.
internal shared class ImportedAssemblySemantics {
    private data class AssemblySemantics(
        TypesByMetadataToken ImmutableDictionary[int32, ImportedTypeSemantics],
        MagicCollectionFieldsByMetadataToken ImmutableDictionary[int32, ImmutableDictionary[string, string]],
        FriendAssemblies ImmutableHashSet[string]
    ) : IEquatable[AssemblySemantics] { }

    const TypeSemanticsMetadataKey string = "GSharp.TypeSemantics"
    /// Issue #3329: the metadata key for the per-type magic-collection-field
    /// marker — recorded for EVERY gsc-compiled value-type struct with at
    /// least one ADR-0159 magic-collection-typed field (map/slice/fixed
    /// array/sequence), independent of the (cref:TypeSemanticsMetadataKey)
    /// gate (which only marks `data struct`/primary-constructor types).
    /// A struct literal for a type imported from another assembly (or, for
    /// the REPL, an EARLIER submission) has no access to the declaring
    /// compilation's own (cref:StructSymbol.InstanceFieldInitializers),
    /// where this zero-value synthesis is normally recorded — this marker
    /// lets it reconstruct exactly the same sound zero value instead of
    /// silently leaving the field at its raw (frequently null / NRE-prone)
    /// CLR default. See (cref:Binding.MagicCollectionZeroValue.ClassifyForMarker)
    /// / (cref:Binding.MagicCollectionZeroValue.TrySynthesizeEmptyInstanceFromMarker).
    const MagicCollectionFieldsMetadataKey string = "GSharp.MagicCollectionFields"

    private const AssemblyMetadataAttributeFullName string = "System.Reflection.AssemblyMetadataAttribute"
    private const InternalsVisibleToAttributeFullName string = "System.Runtime.CompilerServices.InternalsVisibleToAttribute"

    // Keyed on the reflection-only Assembly object so an assembly's markers are
    // parsed once. Issue #2269: this MUST be a ConditionalWeakTable rather than
    // a ConcurrentDictionary — a strong process-wide dictionary would pin every
    // Assembly (and the MetadataLoadContext reflection metadata behind it) for
    // the whole process. gsc creates one MetadataLoadContext per compilation, so
    // pinning leaks all of them across the parallel test host (and any long
    // running process), exhausting memory. TryGetTypeSemantics is now consulted
    // for imported *reference* types too (data-class support), which touches far
    // more assemblies, so the pinning became an out-of-memory regression. A weak
    // table lets each entry (and its Assembly key) be collected once the owning
    // load context is disposed and unreachable.
    private let Cache ConditionalWeakTable[Assembly, AssemblySemantics] = ConditionalWeakTable[
        Assembly,
        AssemblySemantics
    ]()

    private data class RecordShape(Semantics ImportedTypeSemantics?) { }
    private let RecordShapes ConditionalWeakTable[Type, RecordShape] = ConditionalWeakTable[Type, RecordShape]()

    func TryGetTypeSemantics(type Type?, @NotNullWhen(true) out semantics ImportedTypeSemantics?) bool {
        semantics = nil
        if type == nil {
            return false
        }
        try {
            return Cache
                .GetValue(type.Assembly, ReadAssemblySemantics)
                .TypesByMetadataToken
                .TryGetValue(type.MetadataToken, out semantics)
        } catch {
            return false
        }
    }

    /// Checks CLR eligibility and the declaring G# assembly's inheritance policy.
    /// @param type The imported base class.
    /// @returns Whether a different compilation may derive from the class.
    func IsInheritableClass(type Type) bool -> type.IsClass &&
        !type.IsSealed &&
        (!TryGetTypeSemantics(type, out var semantics) || semantics!!.InheritanceMode == ImportedInheritanceMode.Open)

    /// Issue #3329: looks up [`type`](paramref)'s magic-collection-field
    /// marker — the field-name-to-shape-tag map recorded by
    /// (cref:MagicCollectionFieldsMetadataKey) (independent of
    /// (cref:TryGetTypeSemantics)'s `data struct`/primary-ctor
    /// gate, so a PLAIN struct's magic-collection fields are covered too).
    /// @param type The reflected CLR type to inspect.
    /// @param fieldKinds The field name to marker-tag map on success.
    /// @returns `true` when the type carries the marker.
    func TryGetMagicCollectionFields(
        type Type?,
        @NotNullWhen(true) out fieldKinds ImmutableDictionary[string, string]?
    ) bool {
        fieldKinds = nil
        if type == nil {
            return false
        }
        try {
            return Cache
                .GetValue(type.Assembly, ReadAssemblySemantics)
                .MagicCollectionFieldsByMetadataToken
                .TryGetValue(type.MetadataToken, out fieldKinds)
        } catch {
            return false
        }
    }

    /// Issue #2291: recognizes a genuine C# compiler-emitted `record` /
    /// `record struct` shape when the assembly it lives in was compiled
    /// by the C# compiler (not gsc) and therefore never wrote a
    /// (cref:TypeSemanticsMetadataKey) marker for it. Every C# record
    /// synthesizes a `PrintMembers` method and a copy constructor
    /// (`.ctor(SameType)`); a `record class` additionally
    /// synthesizes a public parameterless `<Clone>$` method and a
    /// protected/internal `EqualityContract` property (a `record
    /// struct` has neither — value-type copying makes them unnecessary).
    /// Requiring the FULL marker set for the type's value/reference kind
    /// keeps this from ever misclassifying a hand-written class/struct that
    /// merely happens to declare one of these members incidentally.
    /// @param type The externally-referenced CLR type to inspect.
    /// @param semantics The synthesized semantics on success.
    /// @returns `true` when [`type`](paramref) has the full record shape.
    func TryDetectCSharpRecordSemantics(type Type?, @NotNullWhen(true) out semantics ImportedTypeSemantics?) bool {
        semantics = nil
        if type == nil {
            return false
        }
        CompilationMeasurements.Count("records.shape-queries")
        semantics = RecordShapes.GetValue(type, DetectRecordShape).Semantics
        return semantics != nil
    }

    private func DetectRecordShape(type Type) RecordShape {
        CompilationMeasurements.Count("records.shape-scans")
        using let measurement = CompilationMeasurements.BeginPhase("references.record-shape")
        TryDetectCSharpRecordSemanticsCore(type, out var semantics)
        return RecordShape(semantics)
    }

    private func TryDetectCSharpRecordSemanticsCore(
        type Type?,
        @NotNullWhen(true) out semantics ImportedTypeSemantics?
    ) bool {
        semantics = nil
        if type == nil || type.IsPrimitive || type.IsEnum || type.IsInterface || type.IsGenericTypeDefinition {
            return false
        }
        const InstanceAny = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        // Look up methods/constructors WITHOUT passing an explicit parameter
        // `Type[]` to `GetMethod`/`GetConstructor` overloads — under a
        // `MetadataLoadContext`-backed resolver, `typeof(StringBuilder)` (or
        // any host-runtime `Type`) is NOT "a type provided by the
        // MetadataLoadContext" that loaded `type`, and the reflection binder
        // throws `ArgumentException` rather than simply reporting no match.
        // Enumerating and matching by simple name/FullName instead works
        // uniformly for both the live-reflection and MLC-backed resolvers.
        var hasPrintMembers = false
        for method in ClrTypeUtilities.SafeGetMethods(type, InstanceAny) {
            let parameters = method.GetParameters()
            if string.Equals(method.Name, "PrintMembers", StringComparison.Ordinal) &&
                method
                .ReturnType
                .FullName == "System.Boolean" &&
                parameters.Length == 1 &&
                parameters[0]
                .ParameterType
                .FullName == "System.Text.StringBuilder" {
                hasPrintMembers = true
                break
            }
        }
        let hasReferenceAssemblyShape = !hasPrintMembers && HasCSharpRecordReferenceShape(type)
        if !hasPrintMembers && !hasReferenceAssemblyShape {
            return false
        }
        // Issue #2291 follow-up: a `record class` needs an explicit copy
        // constructor (`.ctor(SameType)`) plus `<Clone>$`/`EqualityContract`
        // because `with` on a reference type must allocate a brand-new
        // instance. A `record struct` has NEITHER — value-type assignment
        // already copies the whole instance, so the C# compiler never
        // synthesizes a copy constructor, `<Clone>$`, or `EqualityContract`
        // for it (verified by inspecting the compiler-emitted metadata
        // shape of `public record struct Point(int X, int Y)`). Requiring
        // those reference-type-only markers on a record STRUCT would always
        // fail detection, so `PrintMembers` alone — a marker unique to
        // compiler-synthesized records — is the correct, sufficient
        // signature for the value-type case.
        if !type.IsValueType && !hasReferenceAssemblyShape {
            var hasCopyConstructor = false
            for constructor in ClrTypeUtilities.SafeGetConstructors(type, InstanceAny) {
                let parameters = constructor.GetParameters()
                if parameters.Length == 1 && ClrTypeUtilities.AreSame(parameters[0].ParameterType, type) {
                    hasCopyConstructor = true
                    break
                }
            }
            var hasClone = false
            for method in ClrTypeUtilities.SafeGetMethods(type, BindingFlags.Public | BindingFlags.Instance) {
                if string.Equals(method.Name, "<Clone>$$", StringComparison.Ordinal) && method.GetParameters()
                    .Length == 0 &&
                    type.IsAssignableFrom(method.ReturnType) {
                    hasClone = true
                    break
                }
            }
            let hasEqualityContract = type.GetProperty(
                "EqualityContract",
                BindingFlags.NonPublic | BindingFlags.Instance
            ) is {} equalityContractProperty &&
                equalityContractProperty
                .PropertyType
                .FullName == "System.Type"
            if !hasCopyConstructor || !hasClone || !hasEqualityContract {
                return false
            }
        }
        let (parameterNames, parameterFieldTokens, parameterProperties) = BuildRecordPrimaryConstructorShape(type)
        semantics = ImportedTypeSemantics(
            MetadataToken: type.MetadataToken,
            IsValueType: type.IsValueType,
            IsData: true,
            PrimaryConstructorParameterNames: parameterNames,
            PrimaryConstructorParameterFieldTokens: parameterFieldTokens,
            PrimaryConstructorProperties: parameterProperties
        )
        return true
    }

    func GrantsInternalAccessTo(assembly Assembly?, consumerAssemblyName string?) bool {
        if assembly == nil || string.IsNullOrWhiteSpace(consumerAssemblyName) {
            return false
        }
        let normalizedConsumer = NormalizeAssemblyName(consumerAssemblyName)
        if string.IsNullOrEmpty(normalizedConsumer) {
            return false
        }
        try {
            let ownerName = NormalizeAssemblyName(assembly.GetName().Name)
            if string.Equals(ownerName, normalizedConsumer, StringComparison.Ordinal) {
                return true
            }
            // No unilateral ".Tests"-suffix auto-friend heuristic here — the
            // producer must explicitly opt in via a real
            // InternalsVisibleToAttribute row (either hand-written
            // `[assembly: InternalsVisibleTo(...)]` from a .NET-language
            // producer, or gsc's `@assembly:InternalsVisibleTo("...")`
            // annotation — see
            // Emit.AssemblyAttributeEmitter.EmitFriendAssemblyAttributes). A
            // consumer name is only trusted if the owner actually declared it.
            return Cache.GetValue(assembly, ReadAssemblySemantics).FriendAssemblies.Contains(normalizedConsumer)
        } catch {
            return false
        }
    }

    // Reference assemblies omit the private/protected markers of a sealed
    // record. Its compiler-generated public equality surface remains intact.
    private func HasCSharpRecordReferenceShape(type Type) bool {
        const PublicInstance = BindingFlags.Public | BindingFlags.Instance
        const PublicStatic = BindingFlags.Public | BindingFlags.Static
        if !type.IsSealed {
            return false
        }
        let IsCompilerGenerated = func (member MemberInfo) bool {
            for attribute in member.GetCustomAttributesData() {
                if attribute.AttributeType.FullName == "System.Runtime.CompilerServices.CompilerGeneratedAttribute" {
                    return true
                }
            }
            return false
        }
        var implementsSelfEquatable = false
        for interfaceType in type.GetInterfaces() {
            let arguments = if interfaceType.IsGenericType {
                interfaceType.GetGenericArguments()
            } else {
                Type.EmptyTypes
            }
            if interfaceType.IsGenericType && interfaceType.GetGenericTypeDefinition()
                .FullName == "System.IEquatable`1" &&
                arguments.Length == 1 &&
                arguments[0].FullName == type.FullName {
                implementsSelfEquatable = true
                break
            }
        }
        if !implementsSelfEquatable {
            return false
        }
        let methods = ClrTypeUtilities.SafeGetMethods(type, PublicInstance | PublicStatic)
        var hasTypedEquals = false
        var hasEquality = false
        var hasInequality = false
        var hasToString = false
        var hasGetHashCode = false
        for method in methods {
            if !IsCompilerGenerated(method) {
                continue
            }
            let parameters = method.GetParameters()
            hasTypedEquals |= method.Name == "Equals" &&
                !method.IsStatic &&
                method
                .ReturnType
                .FullName == "System.Boolean" &&
                parameters.Length == 1 &&
                parameters[0]
                .ParameterType
                .FullName == type.FullName
            hasEquality |= method.Name == "op_Equality" &&
                method.IsStatic &&
                method
                .ReturnType
                .FullName == "System.Boolean" &&
                parameters.Length == 2 &&
                parameters[0]
                .ParameterType
                .FullName == type.FullName &&
                parameters[1]
                .ParameterType
                .FullName == type.FullName
            hasInequality |= method.Name == "op_Inequality" &&
                method.IsStatic &&
                method
                .ReturnType
                .FullName == "System.Boolean" &&
                parameters.Length == 2 &&
                parameters[0]
                .ParameterType
                .FullName == type.FullName &&
                parameters[1]
                .ParameterType
                .FullName == type.FullName
            hasToString |= method.Name == "ToString" &&
                !method.IsStatic &&
                method
                .ReturnType
                .FullName == "System.String" &&
                parameters.Length == 0
            hasGetHashCode |= method.Name == "GetHashCode" &&
                !method.IsStatic &&
                method
                .ReturnType
                .FullName == "System.Int32" &&
                parameters.Length == 0
        }
        return hasTypedEquals && hasEquality && hasInequality && hasToString && hasGetHashCode
    }

    // Issue #2291: the record's POSITIONAL primary constructor is the public
    // instance constructor (other than the synthesized copy constructor,
    // `.ctor(SameType)`) whose open parameter signatures and names match
    // public auto-properties of the record (the shape every C#
    // `record`/`record struct` positional declaration produces). A record
    // with no positional parameters (e.g. `record struct Empty;`) has no such
    // constructor — <c>with</c> then has nothing to set, which still compiles
    // (an empty `{ }`  member list).
    private func BuildRecordPrimaryConstructorShape(type Type)(
        Names ImmutableArray[string],
        FieldTokens ImmutableArray[int32],
        Properties ImmutableArray[PropertyInfo]
    ) {
        let definition = if type.IsGenericType {
            type.GetGenericTypeDefinition()
        } else {
            type
        }
        let autoProperties = Dictionary[string, PropertyInfo](StringComparer.Ordinal)
        for property in definition.GetProperties(BindingFlags.Public | BindingFlags.Instance) {
            if property.GetMethod != nil && property.SetMethod != nil && property.GetIndexParameters().Length == 0 {
                autoProperties.Add(property.Name, property)
            }
        }
        if autoProperties.Count == 0 {
            return (ImmutableArray[string].Empty, ImmutableArray[int32].Empty, ImmutableArray[PropertyInfo].Empty)
        }
        var bestMatch ConstructorInfo? = nil
        var bestParameters = Array.Empty[ParameterInfo]()
        for ctor in definition.GetConstructors(BindingFlags.Public | BindingFlags.Instance) {
            let parameters = ctor.GetParameters()
            // Skip the synthesized copy constructor — it never denotes the
            // positional shape.
            if parameters.Length == 1 && ClrTypeUtilities.AreSame(parameters[0].ParameterType, definition) {
                continue
            }
            if parameters.Length == 0 || parameters.Length <= bestParameters.Length {
                continue
            }
            var allParametersMatch = true
            for parameter in parameters {
                if !autoProperties.TryGetValue(parameter.Name ?? string.Empty, out var property) ||
                    !ClrNullability
                    .GetSignatureType(parameter).Equals(ClrNullability.GetSignatureType(property)) {
                    allParametersMatch = false
                    break
                }
            }
            if allParametersMatch {
                bestMatch = ctor
                bestParameters = parameters
            }
        }
        if bestMatch == nil {
            return (ImmutableArray[string].Empty, ImmutableArray[int32].Empty, ImmutableArray[PropertyInfo].Empty)
        }
        let namesBuilder = ImmutableArray.CreateBuilder[string](bestParameters.Length)
        let tokensBuilder = ImmutableArray.CreateBuilder[int32](bestParameters.Length)
        let propertiesBuilder = ImmutableArray.CreateBuilder[PropertyInfo](bestParameters.Length)
        for parameter in bestParameters {
            let name string? = parameter.Name
            namesBuilder.Add(name ?? string.Empty)
            propertiesBuilder.Add(autoProperties[name ?? string.Empty])
            let backingField = definition.GetField(
                "<$name>k__BackingField",
                BindingFlags.NonPublic | BindingFlags.Instance
            )
            tokensBuilder.Add(backingField?.MetadataToken ?? 0)
        }
        return (namesBuilder.ToImmutable(), tokensBuilder.ToImmutable(), propertiesBuilder.ToImmutable())
    }

    private func ReadAssemblySemantics(assembly Assembly) AssemblySemantics {
        let typesByToken = Dictionary[int32, ImportedTypeSemantics]()
        let magicCollectionFieldsByToken = Dictionary[int32, ImmutableDictionary[string, string]]()
        let friends = HashSet[string](StringComparer.Ordinal)
        var attributes IList[CustomAttributeData]
        try {
            attributes = assembly.GetCustomAttributesData()
        } catch {
            return AssemblySemantics(
                typesByToken.ToImmutableDictionary(),
                magicCollectionFieldsByToken.ToImmutableDictionary(),
                friends.ToImmutableHashSet(StringComparer.Ordinal)
            )
        }
        for attribute in attributes {
            let attributeName = attribute.AttributeType?.FullName
            if string.Equals(attributeName, AssemblyMetadataAttributeFullName, StringComparison.Ordinal) {
                if attribute.ConstructorArguments.Count < 2 {
                    continue
                }
                let key = attribute.ConstructorArguments[0].Value as string
                let value = attribute.ConstructorArguments[1].Value as string
                if string.Equals(key, TypeSemanticsMetadataKey, StringComparison.Ordinal) {
                    if TryParseTypeSemantics(value, out var semantics) {
                        typesByToken[semantics.MetadataToken] = semantics
                    }
                } else if string.Equals(key, MagicCollectionFieldsMetadataKey, StringComparison.Ordinal) {
                    if TryParseMagicCollectionFields(value, out var typeToken, out var fieldKinds) {
                        magicCollectionFieldsByToken[typeToken] = fieldKinds
                    }
                }
                continue
            }
            if !string.Equals(attributeName, InternalsVisibleToAttributeFullName, StringComparison.Ordinal) ||
                attribute
                .ConstructorArguments
                .Count == 0 {
                continue
            }
            if attribute.ConstructorArguments[0].Value is string friendName {
                let normalized = NormalizeAssemblyName(friendName)
                if !string.IsNullOrEmpty(normalized) {
                    friends.Add(normalized)
                }
            }
        }
        return AssemblySemantics(
            typesByToken.ToImmutableDictionary(),
            magicCollectionFieldsByToken.ToImmutableDictionary(),
            friends.ToImmutableHashSet(StringComparer.Ordinal)
        )
    }

    // Issue #3329: payload shape is "typeToken|field1:kind1,field2:kind2,...";
    // see AssemblyAttributeEmitter.EmitGSharpMagicCollectionFieldMarkers for
    // the writer.
    private func TryParseMagicCollectionFields(
        value string?,
        out typeToken int32,
        @NotNullWhen(true) out fieldKinds ImmutableDictionary[string, string]?
    ) bool {
        typeToken = 0
        fieldKinds = nil
        if string.IsNullOrWhiteSpace(value) {
            return false
        }
        let parts = value.Split('|')
        if parts.Length != 2 || !int32.TryParse(parts[0], out typeToken) {
            return false
        }
        let builder = ImmutableDictionary.CreateBuilder[string, string](StringComparer.Ordinal)
        for entry in parts[1].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) {
            let colon = entry.IndexOf(':')
            if colon < 0 {
                continue
            }
            builder[entry.Substring(0, colon)] = entry.Substring(colon + 1)
        }
        fieldKinds = builder.ToImmutable()
        return true
    }

    private func TryParseTypeSemantics(value string?, @NotNullWhen(true) out semantics ImportedTypeSemantics?) bool {
        semantics = nil
        if string.IsNullOrWhiteSpace(value) {
            return false
        }
        let parts = value.Split('|')
        if parts.Length < 4 || !int32.TryParse(parts[0], out var metadataToken) {
            return false
        }
        let kind = parts[1]
        let isData = string.Equals(parts[2], "1", StringComparison.Ordinal)
        // Issue #1953 follow-up: each entry is "name:backingFieldToken" (token
        // is "0" when the emitter found no backing field, e.g. a property-
        // backed parameter). Tolerate the old name-only format too (no ':')
        // so a stale-but-compatible payload never turns into an outright
        // parse failure — it just carries no token.
        var primaryParameterNames = ImmutableArray[string].Empty
        var primaryParameterFieldTokens = ImmutableArray[int32].Empty
        if parts[3].Length != 0 {
            let entries = parts[3].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            let namesBuilder = ImmutableArray.CreateBuilder[string](entries.Length)
            let tokensBuilder = ImmutableArray.CreateBuilder[int32](entries.Length)
            for entry in entries {
                let colon = entry.IndexOf(':')
                if colon < 0 {
                    namesBuilder.Add(entry)
                    tokensBuilder.Add(0)
                    continue
                }
                namesBuilder.Add(entry.Substring(0, colon))
                tokensBuilder.Add(
                    if int32.TryParse(entry.Substring(colon + 1), out var token) {
                        token
                    } else {
                        0
                    }
                )
            }
            primaryParameterNames = namesBuilder.ToImmutable()
            primaryParameterFieldTokens = tokensBuilder.ToImmutable()
        }
        let inheritanceMode = if parts.Length > 4 {
            (
                switch parts[4] {
                    case "open": ImportedInheritanceMode.Open
                    case "closed": ImportedInheritanceMode.Closed
                    case "sealed": ImportedInheritanceMode.SealedHierarchy
                    default: ImportedInheritanceMode.Unknown
                }
            )
        } else {
            ImportedInheritanceMode.Unknown
        }
        semantics = ImportedTypeSemantics(
            MetadataToken: metadataToken,
            IsValueType: string.Equals(kind, "struct", StringComparison.Ordinal),
            IsData: isData,
            PrimaryConstructorParameterNames: primaryParameterNames,
            PrimaryConstructorParameterFieldTokens: primaryParameterFieldTokens,
            InheritanceMode: inheritanceMode
        )
        return true
    }

    private func NormalizeAssemblyName(value string?) string? {
        if string.IsNullOrWhiteSpace(value) {
            return nil
        }
        var trimmed = value.Trim()
        let comma = trimmed.IndexOf(',')
        if comma >= 0 {
            trimmed = trimmed.Substring(0, comma)
        }
        return trimmed.Trim()
    }
}

internal data class ImportedTypeSemantics(
    MetadataToken int32,
    IsValueType bool,
    IsData bool,
    PrimaryConstructorParameterNames ImmutableArray[string],
    PrimaryConstructorParameterFieldTokens ImmutableArray[int32] = default(ImmutableArray[int32]),
    InheritanceMode ImportedInheritanceMode = ImportedInheritanceMode.Unknown,
    PrimaryConstructorProperties ImmutableArray[PropertyInfo] = default(ImmutableArray[PropertyInfo])
) : IEquatable[ImportedTypeSemantics] { }
