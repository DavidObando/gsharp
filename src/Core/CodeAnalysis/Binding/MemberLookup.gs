// <copyright file="MemberLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis
import System.Collections
import System.Collections.Concurrent
import SystemObject = System.Object
import System.Globalization
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax

/// Result of resolving an imported CLR indexer overload set.
internal enum ClrIndexerResolutionOutcome {
    NoneFound,
    NoneApplicable,
    Ambiguous,
    Resolved
}

/// PR-B-2: the binder-facing facade for "given a type T and a member name N,
/// return the candidates". Delegates low-level CLR member walks (including
/// inherited interfaces) to (cref:ClrTypeUtilities) and user-symbol
/// scope lookups to (cref:BoundScope) via (cref:BinderContext).
/// @remarks This type is deliberately <em>pure</em>: it does not emit diagnostics,
/// it does not construct `BoundExpression` values, and it does not
/// mutate (cref:BinderContext.NarrowedVariables) or
/// (cref:BinderContext.LoopStack). The cache fields on
/// (cref:BindingServices) for imported `[Extension]` classes
/// ((cref:BindingServices.CachedImportedExtensionClasses) and
/// (cref:BindingServices.CachedImportedExtensionImportCount)) are
/// intentionally written by (cref:GetImportedExtensionClasses) —
/// those fields exist on the binding services precisely so this facade can
/// populate them and every body of the pass can reuse them.
///
/// All decisions about "what to do with no candidate" — diagnostic emission
/// (e.g. `GS0159`, `GS0125`, `GS0187`), error-recovery
/// `BoundErrorExpression` construction, narrowing-state updates — live
/// on the caller in (cref:Binder).
internal class MemberLookup {
    private let binderCtx BinderContext

    /// Initializes a new instance of the (cref:MemberLookup) class.
    /// @param binderCtx The shared binder context that exposes the
    /// reference resolver, the root (cref:BoundScope), and the
    /// imported-extension cache fields.
    init(binderCtx BinderContext) {
        this.binderCtx = binderCtx ?? throw ArgumentNullException("binderCtx")
    }

    /// Finds the nearest lexical type with a named member, including visible imported base members.
    /// @param type The innermost lexical type.
    /// @param name The source member name.
    /// @returns The lexical lookup owner, or null when no member exists.
    internal func FindLexicalMemberOwner(type TypeSymbol, name string) TypeSymbol? {
        CompilationMeasurements.Count("binding.lexical-member-owner.queries")
        let matches Func[Symbol, bool] = (member Symbol) -> member.Name == name &&
            member is not PropertySymbol{IsIndexer: true}
        const dataMembers = MemberKinds.Field | MemberKinds.Property | MemberKinds.Event
        for var current TypeSymbol? = type; current != nil; current = current!!.ContainingType {
            if TypeMemberModel.EnumerateMembers(current, MemberQuery.Instance(dataMembers)).Any(matches) ||
                TypeMemberModel
                .EnumerateMembers(current, MemberQuery.Static(dataMembers)).Any(matches) || TypeMemberModel.GetMethods(
                current,
                name,
                MemberQuery.Instance(MemberKinds.Method)
            )
                .Length != 0 ||
                TypeMemberModel
                .GetMethods(current, name, MemberQuery.Static(MemberKinds.Method))
                .Length != 0 ||
                TypeMemberModel.TryGetStaticField(current, name, out _) {
                return current
            }
            if current is InterfaceSymbol iface &&
                (
                iface.GetStaticField(name) != nil || iface.GetPrivateMethods(name)
                    .Length != 0 ||
                    iface
                    .GetStaticPrivateMethods(name)
                    .Length != 0 ||
                    GetInterfaceImportedBaseInstanceDataMember(iface, name, dataMembers) != nil ||
                    GetInterfaceImportedBaseInstanceMethods(iface, name, out _).Count != 0
            ) {
                return current
            }
            if current is not StructSymbol && current is not InterfaceSymbol {
                continue
            }
            let clrBase = if current is StructSymbol currentStruct {
                ExpressionBinder.GetInheritedClrBaseType(currentStruct) ?? typeof(object)
            } else {
                typeof(object)
            }
            if SafeGetMethodsIncludingSelfAndInterfaces(clrBase, name).Count != 0 {
                return current
            }
            if current is not StructSymbol {
                continue
            }
            let canAccessInternals = (owner Type?) -> binderCtx.References.CanAccessInternalMembers(owner?.Assembly)
            if ClrTypeUtilities.SafeGetInheritedInstanceProperty(clrBase, name, canAccessInternals) != nil ||
                ClrTypeUtilities.SafeGetInheritedInstanceField(clrBase, name, canAccessInternals) != nil {
                return current
            }
            const flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            if ClrTypeUtilities.SafeGetMethods(clrBase, flags).Any(
                (method MethodInfo) -> ClrTypeUtilities.EmittedMemberNameMatches(method, name) &&
                    ClrMemberVisibility.IsVisibleFromDerived(method, canAccessInternals(method.DeclaringType))
            ) {
                return current
            }
            let eventInfo = ClrTypeUtilities.SafeGetEvent(clrBase, name, flags)
            if eventInfo != nil && ClrMemberVisibility.IsVisibleFromDerived(
                eventInfo.GetAddMethod(nonPublic: true),
                canAccessInternals(eventInfo.DeclaringType)
            ) {
                return current
            }
        }
        return nil
    }

    internal enum SymbolicInferenceBoundKind {
        Exact,
        Lower,
        Upper,
        MethodGroupSource,
        MethodGroupUpper
    }

    // ----- Indexer / Nullable<> / extension-method probes (instance helpers) -----
    /// Looks up a public instance indexer on [`clrTarget`](paramref)
    /// whose `GetIndexParameters()` matches [`boundArguments`](paramref)
    /// by name-based assignability. The caller is expected to have already
    /// bound the index argument expressions — keeping
    /// (cref:MemberLookup) free of `BindExpression` side effects.
    /// @param targetType The symbolic receiver type used to recover
    /// same-compilation generic arguments from the erased CLR shape.
    /// @param clrTarget The CLR receiver type whose indexers to probe.
    /// @param boundArguments The pre-bound index argument expressions.
    /// @param indexer The matching (cref:PropertyInfo), on success.
    /// @param resolvedArguments The arguments in parameter order, including omitted optional defaults.
    /// @returns The result of indexer overload resolution.
    func TryResolveClrIndexer(
        targetType TypeSymbol,
        clrTarget Type,
        boundArguments ImmutableArray[BoundExpression],
        out indexer PropertyInfo?,
        out resolvedArguments ImmutableArray[BoundExpression]
    ) ClrIndexerResolutionOutcome {
        indexer = nil
        resolvedArguments = default(ImmutableArray[BoundExpression])
        let properties = CollectVisibleClrIndexers(targetType, clrTarget)
        if properties.Length == 0 {
            return ClrIndexerResolutionOutcome.NoneFound
        }
        var hasSymbolicArgument = false
        for argument in boundArguments {
            hasSymbolicArgument |= argument.Type?.ClrType == nil || TypeSymbol.ContainsTypeParameter(argument.Type) ||
                TypeSymbol.ContainsSameCompilationUserType(argument.Type) ||
                (argument.Type is ImportedTypeSymbol and {HasSubstitutableTypeArgument: true})
        }
        var hasSetOnlyIndexer = false
        for property in properties {
            hasSetOnlyIndexer |= ClrMemberVisibility.GetVisibleGetter(
                property,
                this.binderCtx.References.CanAccessInternalMembers(property.DeclaringType?.Assembly)
            ) == nil
        }
        if hasSymbolicArgument || hasSetOnlyIndexer {
            let applicable = List[(Property PropertyInfo, ParameterTypes ImmutableArray[TypeSymbol])]()
            for property in properties {
                let parameters = property.GetIndexParameters()
                var hasRequiredOmittedParameter = false
                for var i = boundArguments.Length; i < parameters.Length; i++ {
                    hasRequiredOmittedParameter |= !parameters[i].IsOptional
                }
                if boundArguments.Length > parameters.Length || hasRequiredOmittedParameter {
                    continue
                }
                let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](boundArguments.Length)
                var candidateApplicable = true
                for var i = 0; i < boundArguments.Length; i++ {
                    let parameterType = GetIndexerParameterTypeSymbol(targetType, property, i)
                    parameterTypes.Add(parameterType)
                    let conversion = ClassifySymbolicIndexerConversion(boundArguments[i], parameterType)
                    if !conversion.IsImplicit {
                        candidateApplicable = false
                        break
                    }
                }
                if candidateApplicable {
                    applicable.Add((property, parameterTypes.MoveToImmutable()))
                }
            }
            if applicable.Count != 0 {
                var winnerProperty PropertyInfo? = nil
                for candidate in applicable {
                    var betterThanAll = true
                    for other in applicable {
                        if object.ReferenceEquals(candidate.Property, other.Property) {
                            continue
                        }
                        if !IsBetterSymbolicIndexerCandidate(
                            candidate.ParameterTypes,
                            other.ParameterTypes,
                            boundArguments
                        ) {
                            betterThanAll = false
                            break
                        }
                    }
                    if betterThanAll {
                        winnerProperty = candidate.Property
                        break
                    }
                }
                if winnerProperty != nil {
                    indexer = winnerProperty
                    resolvedArguments = ConversionClassifier.AppendOmittedOptionalArguments(
                        boundArguments,
                        indexer!!.GetIndexParameters()
                    )
                    return ClrIndexerResolutionOutcome.Resolved
                }
                // Do not retry a genuine symbolic ambiguity against the
                // object-erased CLR shape: doing so can incorrectly prefer an
                // object overload over a more specific symbolic interface.
                return ClrIndexerResolutionOutcome.Ambiguous
            }
            if hasSetOnlyIndexer {
                return ClrIndexerResolutionOutcome.NoneApplicable
            }
        }
        let argTypes = [boundArguments.Length]Type?
        for var i = 0; i < boundArguments.Length; i++ {
            argTypes[i] = boundArguments[i].Type?.ClrType
            if argTypes[i] == nil {
                // Issue #2471: imported generic receivers constructed with a
                // same-compilation source type use System.Object as the
                // reflection-time placeholder for that symbolic argument.
                // Project an index argument with the same not-yet-emitted type
                // onto that placeholder as well, so overload resolution sees
                // the erased shape while the original BoundExpression keeps
                // the real source TypeSymbol for conversion and emit.
                argTypes[i] = this.binderCtx.References.GetCoreType("System.Object")
            }
        }
        let getterMethods = List[MethodInfo]()
        for property in properties {
            if property.GetMethod != nil {
                getterMethods.Add(property.GetMethod!!)
            }
        }
        let resolution = ClrOverloadResolution.Resolve[MethodInfo](
            getterMethods,
            argTypes,
            constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(boundArguments)
        )
        if resolution.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved {
            return if resolution.Outcome == ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                ClrIndexerResolutionOutcome.Ambiguous
            } else {
                ClrIndexerResolutionOutcome.NoneApplicable
            }
        }
        let best MethodInfo? = resolution.Best
        if best == nil {
            return ClrIndexerResolutionOutcome.NoneApplicable
        }
        for property in properties {
            if object.ReferenceEquals(property.GetMethod, best) {
                indexer = property
                break
            }
        }
        if indexer == nil {
            return ClrIndexerResolutionOutcome.NoneApplicable
        }
        resolvedArguments = OverloadResolver.BuildOrderedCallArguments(
            boundArguments,
            resolution.ParameterMapping,
            best.GetParameters()
        )
        return ClrIndexerResolutionOutcome.Resolved
    }

    /// Constructs `Nullable<TUnderlying>` projected onto the
    /// binder's (cref:ReferenceResolver). Returns false when the
    /// open `Nullable<>` is not reachable from the references in
    /// scope, or when projecting [`underlying`](paramref) through the
    /// reference set fails.
    /// @param underlying The value-type underlying type.
    /// @param constructed The constructed nullable CLR type, on success.
    /// @returns `true` when construction succeeded.
    func TryGetNullableConstructedType(
        underlying Type,
        @NotNullWhen(true) out constructed Type?
    ) bool -> NullableLifting.TryConstructNullable(this.binderCtx.References, underlying, out constructed)

    /// Enumerates imported CLR method groups for member-call probing. Instance
    /// groups use the same self/interface walk as final CLR instance binding;
    /// extension groups report offset 1 for their synthetic receiver parameter.
    /// @param staticClassType The imported static class to inspect, or `null` for receiver calls.
    /// @param receiverClrType The receiver CLR type for instance probes, or `null`.
    /// @param methodName The method name to match.
    /// @param includeExtensions Whether to append imported extension-method probes.
    /// @returns The imported method probe groups in existing lookup order.
    func CollectImportedMethodProbes(
        staticClassType Type?,
        receiverClrType Type?,
        methodName string,
        includeExtensions bool
    ) List[ImportedMethodProbe] {
        let result = List[ImportedMethodProbe]()
        if staticClassType != nil {
            let statics = List[MethodInfo]()
            // Issue #3679: widen to the `internal` statics as well when the
            // declaring assembly named this compilation in an
            // `InternalsVisibleTo`; only `assembly` accessibility is admitted.
            var staticFlags = BindingFlags.Static | BindingFlags.Public
            let staticsIncludeInternal = this.binderCtx.References.CanAccessInternalMembers(staticClassType.Assembly)
            if staticsIncludeInternal {
                staticFlags |= BindingFlags.NonPublic
            }
            for method in ClrTypeUtilities.SafeGetMethods(staticClassType, staticFlags) {
                if (method.IsPublic || (staticsIncludeInternal && method.IsAssembly)) &&
                    ClrTypeUtilities.EmittedMemberNameMatches(method, methodName) {
                    statics.Add(method)
                }
            }
            if statics.Count > 0 {
                result.Add(ImportedMethodProbe(statics, receiverParameterOffset: 0))
            }
            return result
        }
        if receiverClrType != nil {
            // Issue #3679: friend-visible `internal` instance methods are
            // candidates here too, exactly as they are on the final CLR
            // instance-call path.
            let instance = List[MethodInfo](
                SafeGetMethodsIncludingSelfAndInterfaces(
                    receiverClrType,
                    methodName,
                    includeInternal: this.binderCtx.References.CanAccessInternalMembers(receiverClrType.Assembly)
                )
            )
            if instance.Count > 0 {
                result.Add(ImportedMethodProbe(instance, receiverParameterOffset: 0))
            }
        }
        if includeExtensions {
            let extensions = this.CollectImportedExtensionMethods(methodName)
            if extensions.Count > 0 {
                result.Add(ImportedMethodProbe(extensions, receiverParameterOffset: 1))
            }
        }
        return result
    }

    /// Issue #294: collects every `static [Extension]` method named
    /// [`methodName`](paramref) across the imported extension-holding
    /// classes (see (cref:GetImportedExtensionClasses)).
    /// @param methodName The extension method's simple name.
    /// @returns The list of candidate (cref:MethodInfo) overloads.
    func CollectImportedExtensionMethods(methodName string) List[MethodInfo] {
        let classes = this.GetImportedExtensionClasses()
        let cache = binderCtx
            .Services
            .CachedImportedExtensionMethods ??
            Dictionary[string, ImmutableArray[MethodInfo]](StringComparer.Ordinal)
        binderCtx.Services.CachedImportedExtensionMethods = cache
        if cache.TryGetValue(methodName, out var cached) {
            CompilationMeasurements.Count("extensions.name-index-hits")
            return cached.ToList()
        }
        using let measurement = CompilationMeasurements.BeginPhase("references.extension-name-index")
        let result = List[MethodInfo]()
        for type in classes {
            let metadata = importedExtensionIndexes.GetValue(type, BuildImportedExtensionIndex)
            if !metadata.Methods.TryGetValue(methodName, out var candidates) {
                continue
            }
            for method in candidates {
                if IsVisibleImportedMethod(method) && method.GetParameters().Length > 0 {
                    result.Add(method)
                }
            }
        }
        cache[methodName] = result.ToImmutableArray()
        return result
    }

    /// A type declared in a namespace, with its position in the reference
    /// set's assembly and metadata order.
    private data class HolderCandidate(Candidate Type, Ordinal int32) { }

    /// The types of a reference set grouped by namespace. Enumerating the
    /// assemblies happens once. A namespace is probed for static `[Extension]`
    /// classes the first time an import names it, so only types in imported
    /// namespaces are ever probed.
    private class ImportedExtensionHolderIndex {
        private let gate object = SystemObject()
        private let namespaces Dictionary[string, List[HolderCandidate]]
        private let probed Dictionary[string, ImmutableArray[HolderCandidate]] =
        Dictionary[string, ImmutableArray[HolderCandidate]](StringComparer.Ordinal)

        internal init(namespaces Dictionary[string, List[HolderCandidate]]) {
            this.namespaces = namespaces
        }

        /// Gets the static `[Extension]` classes declared in a namespace, in
        /// reference-set order and regardless of accessibility.
        internal func GetHolders(namespaceName string) ImmutableArray[HolderCandidate] {
            lock gate {
                if probed.TryGetValue(namespaceName, out var existing) {
                    return existing
                }
                let holders = ImmutableArray.CreateBuilder[HolderCandidate]()
                if namespaces.TryGetValue(namespaceName, out var candidates) {
                    for candidate in candidates {
                        CompilationMeasurements.Count("extensions.holder-probes")
                        // The probes below walk base types and attributes, which
                        // under MetadataLoadContext can throw for types whose
                        // dependency closure is unresolvable in the compile's
                        // reference set — e.g. a HOST-fallback net10 BCL assembly
                        // scanned during a netstandard2.0 compile, whose typerefs
                        // target assembly versions the netstandard facade set
                        // cannot satisfy. Such a type can never be a usable
                        // extension holder here; skip it instead of failing the
                        // whole compilation (the GS9998 TypeLoadException wall on
                        // the migrated netstandard2.0 Gsharp.NET.Sdk, #3501).
                        try {
                            if !IsStaticClass(candidate.Candidate) || !HasExtensionAttribute(candidate.Candidate) {
                                continue
                            }
                        } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                            continue
                        }
                        holders.Add(candidate)
                    }
                }
                let result = holders.ToImmutable()
                probed[namespaceName] = result
                return result
            }
        }
    }

    private func CreateImportedExtensionHolderIndex(references ReferenceResolver) Lazy[
        ImportedExtensionHolderIndex
    ] -> Lazy[ImportedExtensionHolderIndex](
        () -> BuildImportedExtensionHolderIndex(references),
        System.Threading.LazyThreadSafetyMode.ExecutionAndPublication
    )

    private func BuildImportedExtensionHolderIndex(references ReferenceResolver) ImportedExtensionHolderIndex {
        using let measurement = CompilationMeasurements.BeginPhase("references.extension-holders")
        CompilationMeasurements.Count("extensions.holder-scans")
        let namespaces = Dictionary[string, List[HolderCandidate]](StringComparer.Ordinal)
        var ordinal int32 = 0
        for assembly in references.Assemblies {
            var types IEnumerable[Type?]
            try {
                types = assembly.GetTypes()
            } catch (ex ReflectionTypeLoadException) {
                types = ex.Types
            } catch {
                continue
            }
            for type in types {
                if type == nil || type.Namespace == nil {
                    continue
                }
                if !namespaces.TryGetValue(type.Namespace!!, out var bucket) {
                    bucket = List[HolderCandidate]()
                    namespaces.Add(type.Namespace!!, bucket)
                }
                bucket.Add(HolderCandidate(type, ordinal))
                ordinal++
            }
        }
        return ImportedExtensionHolderIndex(namespaces)
    }

    private data class ImportedExtensionIndex(Methods ImmutableDictionary[string, ImmutableArray[MethodInfo]]) { }

    private func BuildImportedExtensionIndex(type Type) ImportedExtensionIndex {
        using let measurement = CompilationMeasurements.BeginPhase("references.extension-metadata-index")
        let byName = Dictionary[string, List[MethodInfo]](StringComparer.Ordinal)
        let methods = ClrTypeUtilities.SafeGetMethods(
            type,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        const allMembers = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
        let scopeNames = ClrTypeUtilities
            .SafeGetProperties(type, allMembers)
            .Select((candidate PropertyInfo) -> candidate.Name)
            .Concat(ClrTypeUtilities.SafeGetFields(type, allMembers).Select((candidate FieldInfo) -> candidate.Name))
            .Concat(ClrTypeUtilities.SafeGetEvents(type, allMembers).Select((candidate EventInfo) -> candidate.Name))
            .Concat(ClrTypeUtilities.SafeGetMethods(type, allMembers).Select((candidate MethodInfo) -> candidate.Name))
            .ToArray()
        for method in methods {
            CompilationMeasurements.Count("extensions.method-visits")
            if !HasExtensionAttribute(method) {
                continue
            }
            AddImportedExtensionCandidate(byName, method.Name, method)
            let emittedName = SyntaxFacts.GetEmittedIdentifier(method.Name, IdentifierNameContext.General, scopeNames)
            if emittedName != method.Name {
                AddImportedExtensionCandidate(byName, emittedName, method)
            }
        }
        return ImportedExtensionIndex(
            byName.ToImmutableDictionary(
                (pair KeyValuePair[string, List[MethodInfo]]) -> pair.Key,
                (pair KeyValuePair[string, List[MethodInfo]]) -> pair.Value.ToImmutableArray(),
                StringComparer.Ordinal
            )
        )
    }

    private func AddImportedExtensionCandidate(
        index Dictionary[string, List[MethodInfo]],
        name string,
        method MethodInfo
    ) {
        if !index.TryGetValue(name, out var bucket) {
            bucket = List[MethodInfo]()
            index.Add(name, bucket)
        }
        bucket.Add(method)
    }

    /// Issue #294: enumerates static classes declared in the currently
    /// imported namespaces that carry `[Extension]` (i.e. host
    /// extension methods). The result is cached on the
    /// (cref:BindingServices) of the binding pass. Reference, import, file, and consumer identities
    /// invalidate the cache; an equivalent lexical child scope does not.
    /// @returns The imported static extension-holding classes.
    func GetImportedExtensionClasses() List[Type] {
        let imports = this.binderCtx.RootScope.GetDeclaredImports()
        let importCount = if imports.IsDefault {
            0
        } else {
            imports.Length
        }
        let services = binderCtx.Services
        if services.CachedImportedExtensionClasses != nil &&
            services.CachedImportedExtensionImportCount == importCount &&
            object.ReferenceEquals(services.CachedImportedExtensionReferences, binderCtx.References) &&
            services.CachedImportedExtensionAssemblyName == binderCtx
            .References
            .CurrentAssemblyName &&
            services
            .CachedImportedExtensionImports
            .SequenceEqual(imports) && object.ReferenceEquals(
            services.CachedImportedExtensionSyntaxTree,
            binderCtx.RootScope.GetCurrentReferencingSyntaxTreeForCache()
        ) {
            return services.CachedImportedExtensionClasses!!
        }
        services.CachedImportedExtensionMethods = nil
        let namespaces = HashSet[string](StringComparer.Ordinal)
        if !imports.IsDefault {
            for import_ in imports {
                if !string.IsNullOrEmpty(import_.Target) {
                    namespaces.Add(import_.Target)
                }
            }
        }
        let classes = List[Type]()
        if namespaces.Count > 0 {
            // The reference set is enumerated once per resolver and each
            // imported namespace is probed once. Holders are merged back into
            // reference-set order, then filtered by the consumer's
            // accessibility, which depends on the current assembly name.
            let index = importedExtensionHolders.GetValue(binderCtx.References, CreateImportedExtensionHolderIndex)
                .Value
            let merged = List[HolderCandidate]()
            for namespaceName in namespaces {
                merged.AddRange(index.GetHolders(namespaceName))
            }
            merged.Sort((left HolderCandidate, right HolderCandidate) -> left.Ordinal.CompareTo(right.Ordinal))
            for holder in merged {
                try {
                    if !IsVisibleImportedType(holder.Candidate) {
                        continue
                    }
                } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                    continue
                }
                classes.Add(holder.Candidate)
            }
        }
        services.CachedImportedExtensionClasses = classes
        services.CachedImportedExtensionImportCount = importCount
        services.CachedImportedExtensionImports = imports
        services.CachedImportedExtensionReferences = binderCtx.References
        services.CachedImportedExtensionAssemblyName = binderCtx.References.CurrentAssemblyName
        services.CachedImportedExtensionSyntaxTree = binderCtx.RootScope.GetCurrentReferencingSyntaxTreeForCache()
        return classes
    }

    private func CollectVisibleClrIndexers(targetType TypeSymbol, clrTarget Type)[]PropertyInfo {
        let declaringTypes = if clrTarget.IsInterface {
            EnumerateSelfAndInterfaces(clrTarget)
        } else {
            cast[IEnumerable[Type]](List[Type]{clrTarget})
        }
        // Issue #3705: the indexer was the member kind #3693 / #3702 never
        // reached, so a friend assembly's `internal this[…]` — or a
        // `{ get; internal set; }` indexer — was invisible while its
        // methods, properties and fields were not. Only metadata `assembly`
        // accessibility is admitted.
        let includeInternal = this.binderCtx.References.CanAccessInternalMembers(clrTarget.Assembly)
        let collected = List[PropertyInfo]()
        for declaringType in declaringTypes {
            for property in ClrTypeUtilities.SafeGetProperties(
                declaringType,
                ClrMemberVisibility.Widen(BindingFlags.Public | BindingFlags.Instance, includeInternal)
            ) {
                var alreadyCollected = false
                for existing in collected {
                    if object.ReferenceEquals(existing.Module, property.Module) &&
                        existing.MetadataToken == property.MetadataToken &&
                        ClrTypeUtilities.AreSame(existing.DeclaringType, property.DeclaringType) {
                        alreadyCollected = true
                        break
                    }
                }
                if property.GetIndexParameters().Length == 0 || !ClrMemberVisibility.IsVisible(
                    property,
                    includeInternal
                ) ||
                    alreadyCollected {
                    continue
                }
                collected.Add(property)
            }
        }
        // Issue #2525: hide only along an actual declaration ancestry edge.
        // Same-signature slots from unrelated bases must remain ambiguous.
        let visible = List[PropertyInfo]()
        for candidate in collected {
            var hidden = false
            for other in collected {
                if !object.ReferenceEquals(candidate, other) &&
                    other.DeclaringType is Type otherDeclaringType &&
                    candidate.DeclaringType is Type candidateDeclaringType &&
                    IsMoreDerivedClrType(otherDeclaringType, candidateDeclaringType) &&
                    HaveSameIndexerSignature(targetType, other, candidate) {
                    hidden = true
                    break
                }
            }
            if !hidden {
                visible.Add(candidate)
            }
        }
        return visible.ToArray()
    }

    private func IsVisibleImportedMethod(method MethodBase) bool -> method.IsPublic ||
        (method.IsAssembly && this.binderCtx.References.CanAccessInternalMembers(method.DeclaringType?.Assembly))

    private func IsVisibleImportedType(type Type) bool -> type.IsPublic ||
        type.IsNestedPublic ||
        (
        (type.IsNotPublic || type.IsNestedAssembly) && this.binderCtx.References.CanAccessInternalMembers(type.Assembly)
    )

    /// Issue #985: a single CLR interface method slot that an implementing type
    /// must satisfy, paired with the symbolic type arguments needed to resolve
    /// any generic-parameter positions in its signature. (cref:IsInherited)
    /// is `true` when the slot comes from a base interface that
    /// the declared interface inherits (e.g. the non-generic
    /// `IEnumerable.GetEnumerator()` reached through
    /// `IEnumerable<T>`).
    struct ClrInterfaceSlot {
        init(method MethodInfo, slotOwner TypeSymbol, symbolicArgs ImmutableArray[TypeSymbol], isInherited bool) {
            this.Method = method
            this.SlotOwner = slotOwner
            this.SymbolicArgs = symbolicArgs
            this.IsInherited = isInherited
        }

        prop Method MethodInfo {
            get;
        }

        prop SlotOwner TypeSymbol {
            get;
        }

        prop SymbolicArgs ImmutableArray[TypeSymbol] {
            get;
        }

        prop IsInherited bool {
            get;
        }
    }

    /// A CLR interface property slot and its symbolic substitutions.
    struct ClrInterfacePropertySlot {
        init(property PropertyInfo, slotOwner TypeSymbol, symbolicArgs ImmutableArray[TypeSymbol], isInherited bool) {
            this.Property = property
            this.SlotOwner = slotOwner
            this.SymbolicArgs = symbolicArgs
            this.IsInherited = isInherited
        }

        prop Property PropertyInfo {
            get;
        }

        prop SlotOwner TypeSymbol {
            get;
        }

        prop SymbolicArgs ImmutableArray[TypeSymbol] {
            get;
        }

        prop IsInherited bool {
            get;
        }
    }

    internal struct ImportedMethodProbe {
        init(methods IReadOnlyList[MethodInfo], receiverParameterOffset int32) {
            this.Methods = methods
            this.ReceiverParameterOffset = receiverParameterOffset
        }

        prop Methods IReadOnlyList[MethodInfo] {
            get;
        }

        prop ReceiverParameterOffset int32 {
            get;
        }
    }

    private class SymbolicInferenceBounds {
        init(arity int32) {
            this.Exact = [arity]List[TypeSymbol]?
            this.Lower = [arity]List[TypeSymbol]?
            this.Upper = [arity]List[TypeSymbol]?
            this.AmbiguousProjection = [arity]bool
        }

        prop Arity int32 -> this.Exact.Length

        prop Exact[]List[TypeSymbol]? {
            get;
        }

        prop Lower[]List[TypeSymbol]? {
            get;
        }

        prop Upper[]List[TypeSymbol]? {
            get;
        }

        prop AmbiguousProjection[]bool {
            get;
        }

        func Add(position int32, type TypeSymbol, kind SymbolicInferenceBoundKind) {
            // Issue #4133 (Copilot review finding, hot-core translation
            // guard PR): a bound recovered from a bare method group's OWN
            // parameter type is discarded outright, never routed to any
            // list — not even as a last-resort fallback for a slot with no
            // other bound. C# never treats it as input-inference evidence
            // (§12.6.3.7); `Fallback.Wrap[T](predicate Func[T, bool])`
            // called as `Wrap(Check)` with no other argument to fix `T`
            // reports CS0411 in `csc`, measured, not assumed. A prior
            // version of this fix promoted it into `Upper` as a fallback,
            // which made gsc accept that exact shape — strictly MORE
            // permissive than `csc`, the opposite direction of #4133's own
            // defect.
            if kind == SymbolicInferenceBoundKind.MethodGroupUpper {
                return
            }
            let slots = switch kind {
                case SymbolicInferenceBoundKind.Exact: this.Exact
                case SymbolicInferenceBoundKind.Upper: this.Upper
                default: this.Lower
            }
            var slot List[TypeSymbol]? = slots[position]
            if slot == nil {
                slot = List[TypeSymbol]()
                slots[position] = slot
            }
            slot.Add(type)
        }
    }

    private class SymbolicInferenceConflictMarker { }

    private class SourceInferenceBounds {
        public var Exact TypeSymbol?
        public var Lower TypeSymbol?
        public let Upper List[TypeSymbol] = List[TypeSymbol]()
    }

    private class SourceInferenceState {
        init(substitution Dictionary[TypeParameterSymbol, TypeSymbol]) {
            this.FixedParameters = HashSet[TypeParameterSymbol](substitution.Keys)
            this.Bounds = Dictionary[TypeParameterSymbol, SourceInferenceBounds]()
        }

        prop FixedParameters HashSet[TypeParameterSymbol] {
            get;
        }

        prop Bounds Dictionary[TypeParameterSymbol, SourceInferenceBounds] {
            get;
        }
    }

    shared {
        // Preserve the kind of provisional evidence across argument sites without
        // extending the substitution's lifetime or changing its dictionary API.
        private let sourceInferenceBounds ConditionalWeakTable[
            Dictionary[TypeParameterSymbol, TypeSymbol],
            SourceInferenceState
        ] = ConditionalWeakTable[Dictionary[TypeParameterSymbol, TypeSymbol], SourceInferenceState]()

        private let importedExtensionIndexes ConditionalWeakTable[Type, ImportedExtensionIndex] =
        ConditionalWeakTable[Type, ImportedExtensionIndex]()

        // ConditionalWeakTable.GetValue can run its factory more than once for
        // the same key under a race. The factory only creates the Lazy, so the
        // scan itself runs once per resolver.
        private let importedExtensionHolders ConditionalWeakTable[
            ReferenceResolver,
            Lazy[ImportedExtensionHolderIndex]
        ] =
        ConditionalWeakTable[ReferenceResolver, Lazy[ImportedExtensionHolderIndex]]()

        /// Issue #3679: distinguishes the internal-inclusive candidate set from the
        /// public-only one inside (cref:methodsIncludingSelfAndInterfacesCache).
        /// A NUL is not a legal metadata method name, so no probed name can collide
        /// with a suffixed key.
        private const InternalCandidatesCacheKeySuffix string = "\u0000internal"

        /// Issue #4013: cache-key suffix for the candidate set that still includes
        /// abstract interface members on a CLASS receiver — the collection-literal
        /// `Add` probe's view, kept distinct from the ordinary-call view so
        /// the two never overwrite one another.
        private const ExplicitInterfaceCandidatesCacheKeySuffix string = "\u0000explicitiface"

        private let OpenMethodsByMappedMethod ConditionalWeakTable[MethodInfo, MethodInfo] = ConditionalWeakTable[
            MethodInfo,
            MethodInfo
        ]()
        private let SymbolicInferenceConflict TypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            typeof(SymbolicInferenceConflictMarker),
            NullabilityFreeReason.TypeLiteral
        )

        /// Process-wide memoization backing (cref:SafeGetMethodsIncludingSelfAndInterfaces(Type, string,
        /// bool)),
        /// keyed on the CLR (cref:Type) plus the probed method name.
        /// Cleared via (cref:ClearCache) (wired into
        /// (cref:ReferenceResolver.Dispose)) so entries keyed on a disposed
        /// `MetadataLoadContext`'s (cref:Type) instances do not pin
        /// that context's memory for the process lifetime (#1622-style leak).
        private var methodsIncludingSelfAndInterfacesCache ConditionalWeakTable[
            Type,
            ConcurrentDictionary[string, IReadOnlyList[MethodInfo]]
        ] = ConditionalWeakTable[Type, ConcurrentDictionary[string, IReadOnlyList[MethodInfo]]]()

        // ----- CLR-side type walks -----
        /// Enumerates [`t`](paramref) followed by every interface it
        /// implements (direct and inherited). The common building block used by
        /// the dictionary/enumerable shape probes below — kept here so future
        /// fixes for #568/#572/#573 (which all need the same interface walk) can
        /// reuse one helper.
        /// @param t The starting CLR type.
        /// @returns The type and its interfaces in walk order.
        func EnumerateSelfAndInterfaces(t Type) sequence[Type] {
            yield t
            for interfaceType in t.GetInterfaces() {
                yield interfaceType
            }
        }

        /// Returns source-declared instance methods visible on a receiver-like type.
        /// Keeps diagnostics/private-interface handling at the call site.
        /// @param receiverType The receiver or constraint type to inspect.
        /// @param methodName The method name to match.
        /// @returns The source-declared method candidates in existing lookup order.
        func CollectSourceInstanceMethods(receiverType TypeSymbol, methodName string) ImmutableArray[FunctionSymbol] {
            return switch receiverType {
                case structRecv is StructSymbol: TypeMemberModel.GetMethods(
                    structRecv,
                    methodName,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                case ifaceRecv is InterfaceSymbol: TypeMemberModel.GetMethods(
                    ifaceRecv,
                    methodName,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                case TypeParameterSymbol{InterfaceConstraint: {} constraint}: TypeMemberModel.GetMethods(
                    constraint,
                    methodName,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                case TypeParameterSymbol{ClassConstraint: StructSymbol classConstraint}: TypeMemberModel.GetMethods(
                    classConstraint,
                    methodName,
                    MemberQuery.Instance(MemberKinds.Method)
                )
                default: ImmutableArray[FunctionSymbol].Empty
            }
        }

        /// Walks [`clrType`](paramref) and its transitive implemented interfaces
        /// looking for a public instance method whose name matches [`name`](paramref).
        /// Closes the post-#529 gap for *concrete* receivers — `*IncludingInterfaces`
        /// in (cref:ClrTypeUtilities) only walks interfaces when the receiver is itself
        /// an interface; this helper extends the walk to concrete classes for the
        /// #568 / #572 family.
        /// @param clrType The CLR type (concrete class or interface) to probe.
        /// @param name The method name to match.
        /// @param parameterTypes Optional parameter types for exact-match filtering.
        /// Pass `null` to match by name only (first hit).
        /// @returns The matching (cref:MethodInfo), or `null` when none is found.
        func SafeGetMethodIncludingSelfAndInterfaces(
            clrType Type?,
            name string,
            parameterTypes[]?Type = nil
        ) MethodInfo? {
            if clrType == nil {
                return nil
            }
            for type in EnumerateSelfAndInterfaces(clrType) {
                var method MethodInfo?
                try {
                    method = if parameterTypes != nil {
                        type.GetMethod(
                            name,
                            BindingFlags.Public | BindingFlags.Instance,
                            binder: nil,
                            types: parameterTypes,
                            modifiers: nil
                        )
                    } else {
                        type.GetMethod(name, BindingFlags.Public | BindingFlags.Instance)
                    }
                } catch {
                    continue
                }
                if method != nil {
                    return method
                }
            }
            return nil
        }

        /// Resolves the public, non-generic, parameterless `GetEnumerator`
        /// method used by both binding and lowering.
        /// @param clrType The imported CLR type.
        /// @param isAmbiguous Whether one declaration level contains multiple matching methods.
        /// @returns The selected method, or `null`.
        func ResolveGetEnumerator(clrType Type?, out isAmbiguous bool) MethodInfo? {
            let GetDeclaredCandidates = func (type Type) List[MethodInfo] {
                let candidates = List[MethodInfo]()
                for method in ClrTypeUtilities.SafeGetMethods(
                    type,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                ) {
                    if string.Equals(method.Name, "GetEnumerator", StringComparison.Ordinal) &&
                        !method.IsGenericMethod &&
                        method
                        .GetParameters().Length == 0 {
                        candidates.Add(method)
                    }
                }
                return candidates
            }
            let GetBaseTypeSafe = func (type Type) Type? {
                try {
                    return type.BaseType
                } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                    return nil
                }
            }
            isAmbiguous = false
            if clrType == nil {
                return nil
            }
            for var current Type? = clrType; current != nil; current = GetBaseTypeSafe(current!!) {
                let candidates = GetDeclaredCandidates(current)
                if candidates.Count > 1 {
                    isAmbiguous = true
                    return nil
                }
                if candidates.Count == 1 {
                    return candidates[0]
                }
            }
            var genericEnumerable MethodInfo? = nil
            var nonGenericEnumerable MethodInfo? = nil
            var fallback MethodInfo? = nil
            for iface in ClrTypeUtilities.SafeGetInterfaces(clrType) {
                let candidates = GetDeclaredCandidates(iface)
                if candidates.Count > 1 {
                    isAmbiguous = true
                    return nil
                }
                if candidates.Count == 0 {
                    continue
                }
                let candidate = candidates[0]
                if iface.IsGenericType && iface.GetGenericTypeDefinition()
                    .FullName == "System.Collections.Generic.IEnumerable`1" {
                    genericEnumerable ??= candidate
                } else if iface.FullName == "System.Collections.IEnumerable" {
                    nonGenericEnumerable ??= candidate
                } else {
                    fallback ??= candidate
                }
            }
            return genericEnumerable ?? nonGenericEnumerable ?? fallback
        }

        /// Enumerates every public instance method on [`clrType`](paramref),
        /// its base chain, and its transitive implemented interfaces with the given
        /// [`name`](paramref).
        /// The overload-resolution-facing variant, used by call sites that need to
        /// pass a candidate set into (cref:ClrOverloadResolution.Resolve).
        /// Hides base-method-with-same-signature shadowing the same way C# does
        /// (via the existing `IsHiddenByExisting` helper in (cref:ClrTypeUtilities)).
        /// @param clrType The CLR type (concrete class or interface) to probe.
        /// @param name The method name to match.
        /// @returns The candidate list with self-slot methods first.
        func SafeGetMethodsIncludingSelfAndInterfaces(clrType Type, name string) IReadOnlyList[
            MethodInfo
        ] -> SafeGetMethodsIncludingSelfAndInterfaces(clrType, name, includeInternal: false)

        /// Issue #3679: the [`includeInternal`](paramref) variant of
        /// (cref:SafeGetMethodsIncludingSelfAndInterfaces(Type, string)),
        /// which also surfaces `internal` (metadata `assembly`) instance
        /// methods declared by [`clrType`](paramref) or its base chain.
        /// Callers pass `true` only when the declaring assembly
        /// grants this compilation internal access — i.e. when
        /// (cref:ReferenceResolver.CanAccessInternalMembers) says so for an
        /// `InternalsVisibleTo` friend — mirroring the property/field probes
        /// in `ExpressionBinder.Access.MemberLookup`, which already widen to
        /// (cref:BindingFlags.NonPublic) under that same condition. Without
        /// it a friend assembly could reach a referenced assembly's internal
        /// fields and properties but never its internal methods.
        ///
        /// The result is cached under a distinct key so the public-only and
        /// internal-inclusive candidate sets never overwrite one another. Neither
        /// set depends on WHICH consumer is asking — only on the members' declared
        /// accessibility — so the process-wide cache stays consumer-independent.
        /// @param clrType The CLR type (concrete class or interface) to probe.
        /// @param name The method name to match.
        /// @param includeInternal Whether to also return `internal` instance methods.
        /// @returns The candidate list with self-slot methods first.
        func SafeGetMethodsIncludingSelfAndInterfaces(clrType Type, name string, includeInternal bool) IReadOnlyList[
            MethodInfo
        ] -> SafeGetMethodsIncludingSelfAndInterfaces(
            clrType,
            name,
            includeInternal,
            includeExplicitInterfaceMembers: false
        )

        /// Issue #4013: the [`includeExplicitInterfaceMembers`](paramref)
        /// variant, which keeps offering an ABSTRACT interface member on a CLASS
        /// receiver — i.e. one the class can only have implemented explicitly.
        /// @remarks The ordinary-call view (every other caller) must not, because an
        /// explicitly-implemented member is not on the implementing type's own
        /// surface in C# and offering it turned `List[int32]().Add("x")` into
        /// a run-time `ArgumentException`. The COLLECTION-LITERAL `Add`
        /// probe is a different question and passes `true`: G#'s
        /// spread form (issue #3096) fills a `Dictionary[K, V]` from
        /// `KeyValuePair` elements through
        /// `ICollection<KeyValuePair<K, V>>.Add`, which
        /// `Dictionary` implements explicitly, and lowering emits that call
        /// through the interface — so the member really is reachable there and the
        /// literal must keep seeing it. Narrowing this probe as well made
        /// `Dictionary[string, int32](){ ...pairs }` report `GS0369`
        /// ("no accessible 'Add' method or settable indexer").
        ///
        /// Restricting the re-admission to GENERIC interfaces was tried, since the
        /// hazard the issue names is specifically a NON-GENERIC sibling
        /// (`IList.Add(object)`) — and it broke
        /// `Issue3096CollectionSpreadEmitTests.UserDefinedSpreadConversions_ArrayAndCollection_RunAndVerify`:
        /// spreading a `[]Celsius` into a `List[float64]` relies on
        /// `IList.Add(object)`, because a same-compilation struct has no CLR
        /// type while binding and so cannot match `Add(double)` through its
        /// user-defined conversion. The literal path therefore keeps the FULL
        /// pre-#4013 view here, and for a while `List[int32]{"x"}` still bound
        /// `IList.Add(object)` and threw at run time — the same hole as this
        /// issue's, reached through a collection literal rather than an
        /// author-written call.
        ///
        /// Issue #4028 closed that without touching this probe: a lookup memoized
        /// on `(Type, name)` cannot see arguments, so the discrimination is
        /// made at APPLICABILITY instead, by
        /// (cref:ExcludeUnreachableNonGenericInterfaceCandidates), which
        /// drops a NON-GENERIC interface's widening member from the collected list
        /// unless the call really has an erasure to repair. Both views above are
        /// therefore still exactly as #4013 left them.
        /// @param clrType The CLR type (concrete class or interface) to probe.
        /// @param name The method name to match.
        /// @param includeInternal Whether to also return `internal` instance methods.
        /// @param includeExplicitInterfaceMembers Whether a class receiver keeps abstract interface members.
        /// @returns The candidate list with self-slot methods first.
        func SafeGetMethodsIncludingSelfAndInterfaces(
            clrType Type?,
            name string,
            includeInternal bool,
            includeExplicitInterfaceMembers bool
        ) IReadOnlyList[MethodInfo] {
            let GetBaseTypeSafe = func (type Type) Type? {
                try {
                    return type.BaseType
                } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                    return nil
                }
            }
            if clrType == nil {
                return Array.Empty[MethodInfo]()
            }
            // Issue #1678: this result is recomputed identically at every call
            // site that probes the same (type, name) pair — e.g. the "does this
            // type have an accessible Add?" collection-initializer check runs once
            // per collection-literal expression against the same receiver type.
            // ClrTypeUtilities.SafeGetMethods/SafeGetInterfaces are themselves
            // memoized per Type now, but the name filter and the O(result ×
            // candidates) IsMethodHiddenByExisting dedup below still re-ran on
            // every call before this cache existed. Keyed on the CLR Type (not the
            // GSharp symbol) so it is naturally invalidated by
            // ClrTypeUtilities.ClearCache() clearing the caches it reads from.
            return methodsIncludingSelfAndInterfacesCache.GetValue(
                clrType,
                (_ Type) -> ConcurrentDictionary[string, IReadOnlyList[MethodInfo]](StringComparer.Ordinal)
            )
                .GetOrAdd(
                (
                    if includeInternal {
                        name + InternalCandidatesCacheKeySuffix
                    } else {
                        name
                    }
                ) +
                    (
                    if includeExplicitInterfaceMembers {
                        ExplicitInterfaceCandidatesCacheKeySuffix
                    } else {
                        string.Empty
                    }
                ),
                func (_ string) IReadOnlyList[MethodInfo] {
                    // The cache key may carry the internal-inclusive suffix; the probe
                    // itself always matches on the bare method name.
                    let n = name
                    let selfMethods = ClrTypeUtilities.SafeGetMethods(
                        clrType,
                        BindingFlags.Public | BindingFlags.Instance
                    )
                    let result = List[MethodInfo]()
                    for m in selfMethods {
                        if ClrTypeUtilities.EmittedMemberNameMatches(m, n) {
                            result.Add(m)
                        }
                    }
                    // Issues #2614 / #2638: an aggregate metadata walk may return a
                    // usable but incomplete set. Always probe each declaration level
                    // and union accessible methods without duplicating inherited slots.
                    for var current Type? = clrType; current != nil; current = GetBaseTypeSafe(current!!) {
                        for m in ClrTypeUtilities.SafeGetMethods(
                            current,
                            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                        ) {
                            if ClrTypeUtilities.EmittedMemberNameMatches(m, n) && !IsMethodHiddenByExisting(result, m) {
                                result.Add(m)
                            }
                        }
                        // Issue #3679: an `internal` instance method of a friend
                        // assembly is a legal candidate. Only `assembly` accessibility
                        // is admitted — `private`/`protected`/`private protected`
                        // members stay invisible however the friendship is declared.
                        if !includeInternal {
                            continue
                        }
                        for m in ClrTypeUtilities.SafeGetMethods(
                            current,
                            BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly
                        ) {
                            if m.IsAssembly && ClrTypeUtilities.EmittedMemberNameMatches(m, n) &&
                                !IsMethodHiddenByExisting(result, m) {
                                result.Add(m)
                            }
                        }
                    }
                    if clrType.IsConstructedGenericType {
                        for openMethod in ClrTypeUtilities.SafeGetMethods(
                            clrType.GetGenericTypeDefinition(),
                            BindingFlags.Public | BindingFlags.Instance
                        ) {
                            if !ClrTypeUtilities.EmittedMemberNameMatches(openMethod, n) {
                                continue
                            }
                            // TypeBuilder.GetMethod accepts only a TypeBuilder instantiation of the
                            // method's own generic declaring type; every other shape would throw.
                            let openDeclaringType = openMethod.DeclaringType
                            if !ClrTypeUtilities.IsTypeBuilderInstantiation(clrType) ||
                                openDeclaringType == nil ||
                                !openDeclaringType.IsGenericTypeDefinition ||
                                openDeclaringType != clrType.GetGenericTypeDefinition() ||
                                (openMethod.IsGenericMethod && !openMethod.IsGenericMethodDefinition) {
                                continue
                            }
                            try {
                                let mapped = TypeBuilder.GetMethod(clrType, openMethod)
                                OpenMethodsByMappedMethod.GetValue(mapped, (_ MethodInfo) -> openMethod)
                                if !IsMethodHiddenByExisting(result, mapped) {
                                    result.Add(mapped)
                                }
                            } catch (ArgumentException) {
                                // Runtime constructed types already exposed their methods above.

                            }
                        }
                    }
                    // Walk transitive interfaces for DIMs not surfaced by the concrete type.
                    let receiverIsInterface = clrType.IsInterface
                    for iface in ClrTypeUtilities.SafeGetInterfaces(clrType) {
                        for m in ClrTypeUtilities.SafeGetMethods(iface, BindingFlags.Public | BindingFlags.Instance) {
                            if !ClrTypeUtilities.EmittedMemberNameMatches(m, n) {
                                continue
                            }
                            // Issue #4013: on a CLASS receiver an ABSTRACT interface
                            // member is not part of the type's own surface. The class
                            // must implement it, and how it did so decides whether the
                            // member is reachable here:
                            //
                            //  - implemented IMPLICITLY — the class's own public method
                            //    is already in `result` from the self/base walk above,
                            //    so admitting the interface's copy adds nothing;
                            //  - implemented EXPLICITLY — C# says the member is NOT on
                            //    the implementing type's surface and is reachable only
                            //    through an interface-typed receiver.
                            //
                            // Admitting it anyway is unsound, not merely permissive:
                            // `List[int32]().Add("x")` fell through the generic
                            // `Add(T)` to `IList.Add(object)` (which accepts anything)
                            // and turned a static type error into a run-time
                            // ArgumentException. Only a genuine DEFAULT interface
                            // method — a non-abstract interface instance method, which
                            // the class need not implement at all — is what this walk
                            // exists to surface, so only that is admitted. An interface
                            // receiver keeps the full walk: a base interface's abstract
                            // members really are members of the derived interface.
                            if receiverIsInterface || includeExplicitInterfaceMembers || !m.IsAbstract {
                                if !IsMethodHiddenByExisting(result, m) {
                                    result.Add(m)
                                }
                            }
                        }
                    }
                    return result
                }
            )
        }

        /// Issue #4013: the interface declaring an abstract instance member named
        /// [`name`](paramref) that [`clrType`](paramref) — a class —
        /// implements EXPLICITLY and that is APPLICABLE to this call, in the case
        /// where the class exposes no member of that name on its own surface.
        /// @remarks The diagnostic companion to the interface-walk rule in
        /// (cref:SafeGetMethodsIncludingSelfAndInterfaces(Type, string, bool)).
        /// That rule stops offering such a member as a candidate for an ordinary
        /// call; without this helper the resulting failure reads
        /// `GS0159 Cannot find function Contains`, which is what a genuinely
        /// misspelled member reports too and does not tell the author that the
        /// member exists and how to reach it.
        ///
        /// Deliberately UNCACHED and called only from the terminal
        /// member-not-found error path, so the memoized candidate lookup on the hot
        /// path is untouched. Two conditions gate it. The class surface must be
        /// empty for this name — when the class does expose a same-named member the
        /// call is an ordinary inapplicable-overload failure and keeps GS0159,
        /// exactly as an imported member with no interface sibling already does.
        /// And one of the EXCLUDED members must actually be applicable to the bound
        /// arguments: a name match alone is not enough, because the advice this
        /// diagnostic gives — "reach it through an interface-typed receiver" — is a
        /// dead end otherwise. `map[string, int32]{}.Contains(1, 2)` matches
        /// `Contains` by name, but no unary
        /// `ICollection<KeyValuePair<K, V>>.Contains` can take two
        /// arguments, so that call keeps GS0159 (review finding on PR #4031).
        /// @param clrType The class receiver's CLR type.
        /// @param name The member name the call site used.
        /// @param argumentClrTypes The bound arguments' erased CLR types, in source order.
        /// @param declaringInterface The interface declaring the applicable member.
        /// @returns True when the member is reachable only through an interface-typed receiver.
        func TryFindInterfaceOnlyInstanceMethod(
            clrType Type?,
            name string,
            argumentClrTypes IReadOnlyList[Type?],
            @NotNullWhen(true) out declaringInterface Type?
        ) bool {
            declaringInterface = nil
            if clrType == nil || clrType.IsInterface || string.IsNullOrEmpty(name) {
                return false
            }
            // The class surface, as the candidate lookup now sees it. Non-empty
            // means the call is an ordinary overload failure, not this.
            if SafeGetMethodsIncludingSelfAndInterfaces(clrType, name).Count != 0 {
                return false
            }
            let excluded = List[MethodInfo]()
            for iface in ClrTypeUtilities.SafeGetInterfaces(clrType) {
                for m in ClrTypeUtilities.SafeGetMethods(iface, BindingFlags.Public | BindingFlags.Instance) {
                    if m.IsAbstract && ClrTypeUtilities.EmittedMemberNameMatches(m, name) {
                        excluded.Add(m)
                    }
                }
            }
            if excluded.Count == 0 {
                return false
            }
            // Ask the resolver, not the name: only an excluded member that could
            // have taken this call makes the interface-typed-receiver advice true.
            // An ambiguity still means at least one of them applies, so it counts.
            let resolution = ClrOverloadResolution.Resolve(excluded, argumentClrTypes)
            let applicable = resolution.Best ??
                (
                if resolution.Ambiguous.IsDefaultOrEmpty {
                    default(MethodInfo?)
                } else {
                    resolution.Ambiguous[0]
                }
            )
            if applicable?.DeclaringType is not{} declaring {
                return false
            }
            declaringInterface = declaring
            return true
        }

        /// Walks [`clrType`](paramref) and its transitive implemented interfaces
        /// looking for a public instance property whose name matches [`name`](paramref).
        /// The concrete-receiver companion to (cref:ClrTypeUtilities.SafeGetPropertyIncludingInterfaces)
        /// (which only walks interfaces when the receiver is itself an interface).
        /// @param clrType The CLR type to probe.
        /// @param name The property name to match.
        /// @returns The matching (cref:PropertyInfo), or `null` when none is found.
        func SafeGetPropertyIncludingSelfAndInterfaces(clrType Type?, name string) PropertyInfo? {
            if clrType == nil {
                return nil
            }
            let direct PropertyInfo? = ClrTypeUtilities.SafeGetProperty(
                clrType,
                name,
                BindingFlags.Public | BindingFlags.Instance
            )
            if direct != nil {
                return direct
            }
            for iface in ClrTypeUtilities.SafeGetInterfaces(clrType) {
                let prop PropertyInfo? = ClrTypeUtilities.SafeGetProperty(
                    iface,
                    name,
                    BindingFlags.Public | BindingFlags.Instance
                )
                if prop != nil {
                    return prop
                }
            }
            return nil
        }

        /// Finds a visible instance event on a CLR type or any implemented
        /// interface. Issue #3705: `event` was the member kind #3693 and
        /// #3702 never reached, so a friend assembly's `internal event` was
        /// invisible while its `internal` methods, properties and fields were
        /// not. Only metadata `assembly` accessibility is admitted.
        /// @param clrType The CLR type to probe.
        /// @param name The event name to match.
        /// @param includeInternal Whether friend internals are visible.
        /// @returns The matching (cref:EventInfo), or `null`.
        func SafeGetEventIncludingSelfAndInterfaces(
            clrType Type?,
            name string,
            includeInternal bool = false
        ) EventInfo? {
            if clrType == nil {
                return nil
            }
            let flags = ClrMemberVisibility.Widen(BindingFlags.Public | BindingFlags.Instance, includeInternal)
            for type in EnumerateSelfAndInterfaces(clrType) {
                let eventInfo = ClrTypeUtilities.SafeGetEvent(type, name, flags)
                if ClrMemberVisibility.IsVisible(eventInfo, includeInternal) {
                    return eventInfo
                }
            }
            return nil
        }

        /// Issue #1181: collects the transitive closure of imported/BCL base
        /// interfaces declared on [`interfaceSymbol`](paramref). Delegates
        /// to (cref:ClrTypeUtilities.GetTransitiveClrBaseInterfaces).
        /// @param interfaceSymbol The user interface whose imported base interfaces to collect.
        /// @returns The transitive CLR base interface (cref:Type)s, each appearing once.
        func GetTransitiveClrBaseInterfaces(interfaceSymbol InterfaceSymbol) IReadOnlyList[
            Type
        ] -> ClrTypeUtilities.GetTransitiveClrBaseInterfaces(interfaceSymbol)

        /// Finds the imported interface property shared by lexical hiding and member access.
        /// @param interfaceSymbol The source interface receiver.
        /// @param name The ordinary property name.
        /// @returns The public instance property, excluding indexers, or null.
        internal func GetInterfaceImportedBaseInstanceProperty(
            interfaceSymbol InterfaceSymbol,
            name string
        ) PropertyInfo? -> GetInterfaceImportedBaseInstanceDataMember(
            interfaceSymbol,
            name,
            MemberKinds.Property
        ) as PropertyInfo

        /// Finds imported instance data members using the ordinary property and event readers.
        /// @param interfaceSymbol The source interface receiver.
        /// @param name The ordinary member name.
        /// @param kinds The data-member kinds to admit.
        /// @returns The visible instance member, excluding indexers, or null.
        internal func GetInterfaceImportedBaseInstanceDataMember(
            interfaceSymbol InterfaceSymbol,
            name string,
            kinds MemberKinds
        ) MemberInfo? {
            for clrBase in GetTransitiveClrBaseInterfaces(interfaceSymbol) {
                if (kinds & MemberKinds.Property) != 0 {
                    let property = ClrTypeUtilities.SafeGetProperty(
                        clrBase,
                        name,
                        BindingFlags.Public | BindingFlags.Instance
                    )
                    if property != nil && property.GetIndexParameters().Length == 0 {
                        return property
                    }
                }
                if (kinds & MemberKinds.Event) != 0 {
                    let eventInfo = SafeGetEventIncludingSelfAndInterfaces(clrBase, name)
                    if eventInfo != nil {
                        return eventInfo
                    }
                }
            }
            return nil
        }

        /// Collects the imported interface overloads shared by lexical hiding and call resolution.
        /// @param interfaceSymbol The source interface receiver.
        /// @param name The ordinary method name.
        /// @param representativeBase The first imported base, retained for diagnostic context.
        /// @returns The public instance overloads, deduplicated by CLR signature.
        internal func GetInterfaceImportedBaseInstanceMethods(
            interfaceSymbol InterfaceSymbol,
            name string,
            out representativeBase Type?
        ) IReadOnlyList[MethodInfo] {
            let clrBases = GetTransitiveClrBaseInterfaces(interfaceSymbol)
            representativeBase = if clrBases.Count == 0 {
                nil
            } else {
                clrBases[0]
            }
            let candidates = List[MethodInfo]()
            for clrBase in clrBases {
                for method in ClrTypeUtilities.SafeGetMethods(clrBase, BindingFlags.Instance | BindingFlags.Public) {
                    if ClrTypeUtilities.EmittedMemberNameMatches(method, name) &&
                        !HasSameSignature(candidates, method) {
                        candidates.Add(method)
                    }
                }
            }
            return candidates
        }

        /// Issue #1181: returns whether [`candidate`](paramref) already has a
        /// same-name, same-parameter-types entry in [`existing`](paramref)
        /// (structural CLR comparison via (cref:ClrTypeUtilities.AreSame)).
        /// Used to dedupe imported base-interface methods projected onto a user
        /// interface receiver so a signature surfaced by two related interfaces
        /// (e.g. `IEnumerable<T>` and `IEnumerable`) is not added
        /// twice into an overload set.
        /// @param existing The methods collected so far.
        /// @param candidate The candidate method to test.
        /// @returns True when a structurally-equal signature is already present.
        func HasSameSignature(existing IReadOnlyList[MethodInfo], candidate MethodInfo) bool {
            for m in existing {
                if !string.Equals(m.Name, candidate.Name, StringComparison.Ordinal) {
                    continue
                }
                if m.GetGenericArguments().Length != candidate.GetGenericArguments().Length {
                    continue
                }
                let existingParams = m.GetParameters()
                let candidateParams = candidate.GetParameters()
                if existingParams.Length != candidateParams.Length {
                    continue
                }
                var match = true
                for var i = 0; i < existingParams.Length; i++ {
                    if !ClrTypeUtilities.AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType) {
                        match = false
                        break
                    }
                }
                if match {
                    return true
                }
            }
            return false
        }

        /// Returns the G# field on [`structSymbol`](paramref) that satisfies
        /// the property contract of [`clrProp`](paramref): same name, the
        /// field's type's CLR projection matches the property's PropertyType, and
        /// the field is publicly accessible. For read-write contracts (setter
        /// present), the field must additionally be mutable (not read-only).
        /// Returns `null` when no such field exists.
        /// @param structSymbol The user struct symbol to inspect.
        /// @param clrProp The CLR property whose contract to check.
        /// @returns The matching (cref:FieldSymbol), or `null`.
        func FindMatchingFieldForPropertyContract(structSymbol StructSymbol, clrProp PropertyInfo) FieldSymbol? {
            if !structSymbol.TryGetFieldIncludingInherited(clrProp.Name, out var field, out _) {
                return nil
            }
            if field!!.Accessibility != Accessibility.Public {
                return nil
            }
            if !ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(field!!.Type), clrProp.PropertyType) {
                return nil
            }
            // A read-only field cannot satisfy a read-write property contract.
            if clrProp.SetMethod != nil && field!!.IsReadOnly {
                return nil
            }
            return field!!
        }

        /// Probes [`type`](paramref) for an
        /// `IAsyncEnumerable<T>` implementation, OR (issue #2280,
        /// parallel to the sync `GetEnumerator()` pattern support for
        /// #939/#990) the fully duck-typed `await foreach` pattern — a
        /// public instance `GetAsyncEnumerator(...)` method independent of
        /// any interface — and returns the element type when either shape is
        /// present. The interface path is tried first (fast path, and it is the
        /// only path that recovers a same-compilation user element type through
        /// the symbolic (cref:ImportedTypeSymbol) machinery); the pattern
        /// path is the fallback used for CLR wrapper types that implement no
        /// interfaces at all, such as
        /// `System.Runtime.CompilerServices.ConfiguredCancelableAsyncEnumerable<T>`
        /// (the type produced by `IAsyncEnumerable<T>.ConfigureAwait(bool)`).
        /// @param type The (cref:TypeSymbol) to probe.
        /// @param elementType The bound element type symbol, on success.
        /// @returns `true` when the type implements
        /// `IAsyncEnumerable<T>` or exposes the pattern-based
        /// `await foreach` shape.
        func TryGetAsyncEnumerableElementType(type TypeSymbol, out elementType TypeSymbol?) bool {
            elementType = nil
            // Issue #4020: `async sequence[T]` IS `IAsyncEnumerable[T]` (ADR-0041),
            // and its element type is written right on the symbol — but the CLR
            // walk below can only find it through `ClrType`, which
            // `AsyncSequenceTypeSymbol.MakeClrType` leaves null the moment the
            // element has no CLR backing (an in-scope type parameter, a
            // same-compilation class). So `await for v in s` over an OPEN
            // `async sequence[T]` parameter reported GS0134 "cannot be iterated
            // with 'await for'" while the CLOSED `async sequence[int32]` spelling
            // of the same parameter iterated, and while the synchronous `for v in
            // s` over an equally open `sequence[T]` iterated too — the shape was
            // recognised by its ClrType when closed and by nothing at all when
            // open, the #3982 / #3987 / #4011 family. Answer from the symbol
            // itself, which is authoritative for both spellings; the closed one
            // reaches the identical answer one branch later.
            if type is AsyncSequenceTypeSymbol asyncSequence {
                elementType = asyncSequence.ElementType
                return true
            }
            // Issue #1002 (parallel to #939 / #990 for sync `for-in`): an
            // `IAsyncEnumerable[Shape]` whose `Shape` is a same-compilation
            // user `class` / `data struct` is modelled as an
            // `ImportedTypeSymbol` carrying `Shape` symbolically in
            // `TypeArguments` while its `ClrType` is the erased
            // `IAsyncEnumerable<object>` (user types have no ClrType yet, so
            // `MakeGenericType` falls back to `object`). Walking only the CLR
            // type below would type the `await for s in seq` loop variable as
            // `object` and member access (`s.Tag()`) would fail to bind.
            // Honour the symbolic argument first so the loop variable
            // recovers the member-bearing user `Shape` symbol.
            if type is ImportedTypeSymbol importedSym &&
                importedSym.OpenDefinition != nil &&
                !importedSym
                .TypeArguments
                .IsDefaultOrEmpty {
                if importedSym
                    .OpenDefinition
                    .FullName == "System.Collections.Generic.IAsyncEnumerable`1" &&
                    importedSym
                    .TypeArguments
                    .Length == 1 {
                    elementType = importedSym.TypeArguments[0]
                    return true
                }
                // The receiver may be a user/BCL type that implements
                // `IAsyncEnumerable[Shape]`; probe the OpenDefinition for the
                // interface and substitute the symbolic argument back.
                for iface in EnumerateSelfAndInterfaces(importedSym.OpenDefinition) {
                    if iface.IsGenericType && !iface.IsGenericTypeDefinition && iface.GetGenericTypeDefinition()
                        .FullName == "System.Collections.Generic.IAsyncEnumerable`1" {
                        elementType = MapOpenClrTypeToSymbolicWithoutNullability(
                            iface.GetGenericArguments()[0],
                            importedSym,
                            NullabilityFreeReason.TypeStructure
                        )
                        return true
                    }
                }
                if TryResolveClrPatternAsyncEnumerator(
                    importedSym.OpenDefinition,
                    out _,
                    out _,
                    out var openCurrentMember
                ) &&
                    openCurrentMember != nil {
                    elementType = GetClrMemberValueTypeSymbol(
                        openCurrentMember,
                        importedSym.OpenDefinition,
                        importedSym.TypeArguments
                    )
                    return true
                }
            }
            let clr Type? = type?.ClrType
            if clr == nil {
                return false
            }
            for iface in EnumerateSelfAndInterfaces(clr) {
                if iface.IsGenericType && !iface.IsGenericTypeDefinition && iface.GetGenericTypeDefinition()
                    .FullName == "System.Collections.Generic.IAsyncEnumerable`1" {
                    elementType = TypeSymbol.FromClrTypeWithoutNullability(
                        iface.GetGenericArguments()[0],
                        NullabilityFreeReason.TypeStructure
                    )
                    return true
                }
            }
            // Issue #2280: neither `type` nor its OpenDefinition (when
            // symbolic) implements `IAsyncEnumerable[T]`. Fall back to the
            // duck-typed `await foreach` pattern before giving up — this is
            // what makes `ConfiguredCancelableAsyncEnumerable[T]` (returned by
            // `IAsyncEnumerable[T].ConfigureAwait(false)`) and other
            // fully-pattern-based async enumerables iterable.
            if TryResolveClrPatternAsyncEnumerator(clr, out _, out _, out var currentMember) && currentMember != nil {
                elementType = GetClrMemberValueTypeSymbol(currentMember)
                return true
            }
            return false
        }

        /// Issue #2280: resolves the C# spec's duck-typed `await foreach`
        /// pattern directly on [`clrType`](paramref) — a public instance
        /// `GetAsyncEnumerator(...)` method (accepting zero arguments, or a
        /// single optional argument such as `CancellationToken`), whose
        /// return type in turn exposes a parameterless `MoveNextAsync()`
        /// method and a `Current` member — all independent of any
        /// interface. Mirrors (cref:TryGetClrPatternEnumerableCurrentMember)
        /// (the sync `GetEnumerator()` pattern probe for #939/#990) for the
        /// async shape.
        /// @param clrType The CLR type to probe.
        /// @param getAsyncEnumerator The resolved `GetAsyncEnumerator` method, on success.
        /// @param moveNextAsync The resolved `MoveNextAsync` method on the enumerator type, on success.
        /// @param currentMember The resolved `Current` property or field on the enumerator type, on success.
        /// @returns `true` when the pattern-based shape matches.
        func TryResolveClrPatternAsyncEnumerator(
            clrType Type?,
            @NotNullWhen(true) out getAsyncEnumerator MethodInfo?,
            @NotNullWhen(true) out moveNextAsync MethodInfo?,
            @NotNullWhen(true) out currentMember MemberInfo?
        ) bool {
            getAsyncEnumerator = nil
            moveNextAsync = nil
            currentMember = nil
            if clrType == nil {
                return false
            }
            // Prefer a parameterless `GetAsyncEnumerator()` (the shape produced
            // by `ConfiguredCancelableAsyncEnumerable[T]`) over a single-argument
            // overload (the shape produced by `IAsyncEnumerable[T]` itself, which
            // takes an optional `CancellationToken`) when a type happens to
            // expose both — matching how the interface fast path always wins
            // when present, so the pattern probe's own preference order rarely
            // matters in practice.
            var zeroArgCandidate MethodInfo? = nil
            var oneArgCandidate MethodInfo? = nil
            for candidate in ClrTypeUtilities.SafeGetMethods(clrType, BindingFlags.Public | BindingFlags.Instance) {
                if !string.Equals(candidate.Name, "GetAsyncEnumerator", StringComparison.Ordinal) {
                    continue
                }
                let parameters = candidate.GetParameters()
                if parameters.Length == 0 && zeroArgCandidate == nil {
                    zeroArgCandidate = candidate
                } else if parameters.Length == 1 && oneArgCandidate == nil {
                    oneArgCandidate = candidate
                }
            }
            let resolved MethodInfo? = zeroArgCandidate ?? oneArgCandidate
            if resolved == nil {
                return false
            }
            let enumeratorType = resolved.ReturnType
            let moveNext MethodInfo? = SafeGetMethodIncludingSelfAndInterfaces(
                enumeratorType,
                "MoveNextAsync",
                Type.EmptyTypes
            )
            if moveNext == nil {
                return false
            }
            if !TryGetClrCurrentMemberIncludingSelfAndInterfaces(enumeratorType, out var current) {
                return false
            }
            getAsyncEnumerator = resolved
            moveNextAsync = moveNext
            currentMember = current
            return true
        }

        /// Looks up the `Current` member on a duck-typed CLR enumerator —
        /// preferring a property over a field — walking the type's transitive
        /// implemented interfaces in addition to the type itself. The async
        /// counterpart to (cref:TryGetClrCurrentMember), which only
        /// probes the type directly (sufficient for the sync pattern, whose
        /// enumerator is always concrete); kept separate so that call site is
        /// left untouched.
        /// @param enumeratorType The duck-typed enumerator type.
        /// @param currentMember The resolved `Current` property or field, on success.
        /// @returns `true` when a `Current` member exists.
        func TryGetClrCurrentMemberIncludingSelfAndInterfaces(
            enumeratorType Type,
            @NotNullWhen(true) out currentMember MemberInfo?
        ) bool {
            let currentProperty PropertyInfo? = SafeGetPropertyIncludingSelfAndInterfaces(enumeratorType, "Current")
            if currentProperty != nil {
                currentMember = currentProperty
                return true
            }
            let currentField FieldInfo? = ClrTypeUtilities.SafeGetField(
                enumeratorType,
                "Current",
                BindingFlags.Instance | BindingFlags.Public
            )
            if currentField != nil {
                currentMember = currentField
                return true
            }
            currentMember = nil
            return false
        }

        /// Probes [`clrType`](paramref) for a member-mapping shape and returns
        /// the key/value type arguments when present. Recognizes the broader
        /// read-only mapping family: any interface whose generic type definition is
        /// `IDictionary<TKey, TValue>` or
        /// `IReadOnlyDictionary<TKey, TValue>` — mirroring how the
        /// enumerable probe accepts the whole `IEnumerable<T>` family
        /// rather than one concrete type (issue #1483). This lets
        /// `for k, v in d` key/value destructure receivers that surface only
        /// through the read-only contract (e.g. immutable dictionaries or user
        /// types implementing only `IReadOnlyDictionary<,>`).
        ///
        /// When a type implements BOTH interfaces (e.g. `Dictionary<K, V>`),
        /// the writable `IDictionary<,>` is preferred. This is enforced
        /// with a two-pass probe — the first pass scans for `IDictionary<,>`
        /// and only when none is found does the second pass scan for
        /// `IReadOnlyDictionary<,>` — so enumeration order can never pick
        /// the read-only interface over an available writable one (they may even
        /// carry different type arguments in pathological types).
        /// @param clrType The CLR type to probe.
        /// @param keyType The dictionary's key type, on success.
        /// @param valueType The dictionary's value type, on success.
        /// @returns `true` when the type implements
        /// `IDictionary<,>` or `IReadOnlyDictionary<,>`.
        func TryGetClrDictionaryTypes(clrType Type, out keyType Type?, out valueType Type?) bool {
            // First pass: prefer the writable IDictionary<,> (write scenarios) when
            // a type implements both contracts.
            for iface in EnumerateSelfAndInterfaces(clrType) {
                if iface.IsGenericType && iface.GetGenericTypeDefinition()
                    .FullName == "System.Collections.Generic.IDictionary`2" {
                    let args = iface.GetGenericArguments()
                    keyType = args[0]
                    valueType = args[1]
                    return true
                }
            }
            // Second pass: only when no writable IDictionary<,> was found, accept the
            // read-only IReadOnlyDictionary<,> mapping family.
            for iface in EnumerateSelfAndInterfaces(clrType) {
                if iface.IsGenericType && iface.GetGenericTypeDefinition()
                    .FullName == "System.Collections.Generic.IReadOnlyDictionary`2" {
                    let args = iface.GetGenericArguments()
                    keyType = args[0]
                    valueType = args[1]
                    return true
                }
            }
            keyType = nil
            valueType = nil
            return false
        }

        /// Probes [`clrType`](paramref) for an
        /// `IEnumerable<T>` implementation (preferred) or a
        /// non-generic (cref:System.Collections.IEnumerable) (fallback
        /// with element type (cref:object)).
        /// @param clrType The CLR type to probe.
        /// @param elementType The element CLR type, on success.
        /// @returns `true` when the type is enumerable.
        func TryGetClrEnumerableElementType(clrType Type, @NotNullWhen(true) out elementType Type?) bool {
            // Issue #2859: walk the interface closure transitively. `GetInterfaces()`
            // on a type projected through a MetadataLoadContext does not always
            // expand an interface's own base interfaces, so a class that declares
            // only `IReadOnlyCollection[T]` (as every cs2gs-translated collection
            // does) would otherwise never surface the `IEnumerable[T]` it derives.
            let seen = HashSet[Type]()
            let pending = Queue[Type](EnumerateSelfAndInterfaces(clrType))
            while pending.Count > 0 {
                let iface Type? = pending.Dequeue()
                if iface == nil || !seen.Add(iface) {
                    continue
                }
                if iface.IsGenericType && iface.GetGenericTypeDefinition()
                    .FullName == "System.Collections.Generic.IEnumerable`1" {
                    elementType = iface.GetGenericArguments()[0]
                    return true
                }
                if !object.ReferenceEquals(iface, clrType) {
                    for nested in iface.GetInterfaces() {
                        pending.Enqueue(nested)
                    }
                }
            }
            // Non-generic IEnumerable falls back to object. Issue #3705 (family 3):
            // the generic arm above walks the interface closure by FullName (#2859)
            // but this fallback used `typeof(IEnumerable).IsAssignableFrom`, which
            // is unconditionally false for a MetadataLoadContext type — i.e. for
            // every `/reference:`-compiled program. Ask the load-context funnel.
            if ClrLoadContext.Satisfies(clrType, typeof(IEnumerable)) {
                elementType = typeof(object)
                return true
            }
            elementType = nil
            return false
        }

        /// Resolves the `Current` member of a duck-typed CLR enumerable's
        /// enumerator (`GetEnumerator()` → `MoveNext()` / `Current`).
        /// ADR-0193 Phase 2: this hands back the MEMBER, not its CLR type, so the
        /// caller reads the element through the funnel
        /// ((cref:GetClrMemberValueTypeSymbol(MemberInfo))) with the
        /// declaration's nullability, rather than converting a bare
        /// `PropertyType`.
        /// @param clrType The enumerable CLR type (open or closed).
        /// @param current The enumerator's `Current` property or field, on success.
        /// @returns `true` when the pattern matches.
        func TryGetClrPatternEnumerableCurrentMember(clrType Type, @NotNullWhen(true) out current MemberInfo?) bool {
            let getEnumerator MethodInfo? = ResolveGetEnumerator(clrType, out _)
            if getEnumerator == nil {
                current = nil
                return false
            }
            let enumeratorType = getEnumerator.ReturnType
            // Issue #2859: `MoveNext`/`Current` live on the base `IEnumerator`
            // interface when the enumerator is an `IEnumerator[T]`, and
            // `Type.GetMethod` does not search an interface's base interfaces.
            let moveNext = SafeGetMethodIncludingSelfAndInterfaces(enumeratorType, "MoveNext", Type.EmptyTypes)
            if moveNext?.ReturnType.IsSameAs(typeof(bool)) != true {
                current = nil
                return false
            }
            return TryGetClrCurrentMember(enumeratorType, out current)
        }

        /// Looks up the `Current` member on a duck-typed CLR enumerator —
        /// preferring a property over a field, matching the canonical pattern.
        /// @param enumeratorType The duck-typed enumerator type.
        /// @param current The `Current` property or field, on success.
        /// @returns `true` when a `Current` member exists.
        func TryGetClrCurrentMember(enumeratorType Type, @NotNullWhen(true) out current MemberInfo?) bool {
            current = cast[MemberInfo?](
                ClrTypeUtilities.SafeGetProperty(enumeratorType, "Current", BindingFlags.Instance | BindingFlags.Public)
            ) ??
                cast[MemberInfo?](
                ClrTypeUtilities.SafeGetField(enumeratorType, "Current", BindingFlags.Instance | BindingFlags.Public)
            ) ??
                SafeGetPropertyIncludingSelfAndInterfaces(enumeratorType, "Current")
            return current != nil
        }

        /// Issue #3501 / ADR-0193 Phase 2: a pattern enumerator's element — its
        /// `Current` member's value, read through the funnel, and seen
        /// through a `ref` (ADR-0056 §1 auto-dereference).
        /// @param valueType The `Current` member's value type.
        /// @returns The pointee for a by-ref member; the type unchanged otherwise.
        func DereferenceByRefElement(valueType TypeSymbol) TypeSymbol -> if valueType is ByRefTypeSymbol byRef {
            byRef.PointeeType
        } else {
            valueType
        }

        /// Issue #774: maps an open generic CLR (cref:Type) (such as the
        /// element type extracted from `IEnumerable<TParam>`) back to
        /// the symbolic (cref:TypeSymbol) carried on
        /// [`openImp`](paramref)'s (cref:ImportedTypeSymbol.TypeArguments).
        /// @remarks For a generic parameter declared on (cref:ImportedTypeSymbol.OpenDefinition),
        /// the result is the symbolic argument at the same ordinal — e.g. the
        /// `T` in `IEnumerable[T]` becomes the function-level
        /// (cref:TypeParameterSymbol) `T`.
        ///
        /// For a constructed generic type whose arguments transitively reference
        /// open parameters (e.g. `KeyValuePair<TKey, TValue>` on
        /// `Dictionary<TKey, TValue>`), the helper recurses and
        /// reconstructs the closed shape via (cref:ImportedTypeSymbol.GetConstructed)
        /// so downstream emit keeps the symbolic projection.
        ///
        /// For anything else (closed primitive, unrelated CLR type, unmapped
        /// parameter), falls back to (cref:TypeSymbol.FromClrType).
        /// @param openClr The open CLR type to map.
        /// @param openImp The receiver carrying symbolic type arguments.
        /// @returns The symbolic (cref:TypeSymbol) projection.
        @NullabilityFunnel
        func MapOpenClrTypeToSymbolic(
            openClr Type?,
            openImp ImportedTypeSymbol?
        ) TypeSymbol -> MapOpenClrTypeToSymbolic(
            openClr,
            openImp?.OpenDefinition,
            openImp?.TypeArguments ?? ImmutableArray[TypeSymbol].Empty
        )

        /// Generalised entry point for (cref:MapOpenClrTypeToSymbolic(Type, ImportedTypeSymbol))
        /// that accepts the open definition and symbolic arguments directly so
        /// callers can pull them from any container shape
        /// ((cref:ImportedTypeSymbol), (cref:SequenceTypeSymbol),
        /// (cref:AsyncSequenceTypeSymbol)).
        /// @param openClr The open CLR type to map.
        /// @param openDefinition The open generic definition that [`openClr`](paramref)'s parameters bind
        /// against.
        /// @param typeArguments The symbolic arguments at the same ordinals as [`openDefinition`](paramref)'s
        /// generic parameters.
        /// @returns The symbolic (cref:TypeSymbol) projection.
        @NullabilityFunnel
        func MapOpenClrTypeToSymbolic(
            openClr Type?,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol]
        ) TypeSymbol -> MapOpenClrTypeToSymbolic(
            openClr,
            openDefinition,
            typeArguments,
            openMethodDefinition: nil,
            methodTypeArguments: default(ImmutableArray[TypeSymbol?])
        )

        /// Issue #833: extended mapping entry point that also substitutes
        /// <em>method</em> generic parameters (`MVar(idx)`) using the
        /// symbolic arguments at the corresponding ordinals on
        /// [`openMethodDefinition`](paramref). This is the call-site
        /// sibling of the open-receiver substitution from #794: it allows
        /// `Enumerable.Empty[T]()` to surface its open `IEnumerable<TResult>`
        /// return as the symbolic `IEnumerable[T]` (rather than the
        /// type-erased `IEnumerable<object>`) and `[]T{}.ToArray()`
        /// to surface its open `TSource[]` return as `[]T`.
        /// @param openClr The open CLR type to map.
        /// @param openDefinition The open generic <em>type</em> definition the parameters of
        /// [`openClr`](paramref) may bind against. May be `null`.
        /// @param typeArguments The symbolic arguments at the same ordinals as [`openDefinition`](paramref)'s
        /// generic parameters; may be default/empty.
        /// @param openMethodDefinition The open generic <em>method</em> definition the parameters of
        /// [`openClr`](paramref) may bind against. May be `null`.
        /// @param methodTypeArguments The symbolic arguments at the same ordinals as
        /// [`openMethodDefinition`](paramref)'s generic parameters; may be default/empty.
        /// @returns The symbolic (cref:TypeSymbol) projection.
        @NullabilityFunnel
        func MapOpenClrTypeToSymbolic(
            openClr Type?,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol],
            openMethodDefinition MethodInfo?,
            methodTypeArguments ImmutableArray[TypeSymbol?]
        ) TypeSymbol {
            if openClr == nil {
                return TypeSymbol.Error
            }
            if openClr.IsGenericParameter {
                // Type-level parameter (declared on a generic type): map through
                // the receiver/container's symbolic TypeArguments.
                //
                // Issue #2375 follow-up: `Type.DeclaringType` for a *method*-level
                // generic parameter (e.g. `TRelated` of `Builder<TEntity>
                // .HasOneRequired<TRelated>(...)`) returns the METHOD's declaring
                // type (`Builder<TEntity>`), not `null` — only `DeclaringMethod`
                // distinguishes a method-level parameter from a type-level one.
                // Because a single-type-parameter type and a single-method-type-
                // parameter method both report `GenericParameterPosition == 0`,
                // this branch — guarded only by `DeclaringType`/`openDefinition`
                // matching — previously matched `TRelated` too and returned
                // `typeArguments[0]` (the receiver's `TEntity` argument, e.g.
                // `Book`) instead of falling through to the method-level branch
                // below. That silently substituted the wrong closed type for a
                // deferred lambda's `Expression<Func<TEntity,TRelated>>`
                // conversion target, producing invalid IL (`Func<Book,Book>`
                // instead of `Func<Book,Conversion>`) that ILVerify rejected as
                // `StackUnexpected`. Require `IsGenericTypeParameter` (equivalently
                // `DeclaringMethod == null`) so a method-level parameter always
                // falls through to its own (method-scoped) substitution below.
                let declaring Type? = if openClr.IsGenericTypeParameter {
                    openClr.DeclaringType
                } else {
                    default(Type?)
                }
                if declaring != nil && openDefinition != nil && !typeArguments.IsDefaultOrEmpty {
                    let declaringDef = if declaring.IsGenericTypeDefinition {
                        declaring
                    } else {
                        (
                            if declaring.IsGenericType {
                                declaring.GetGenericTypeDefinition()
                            } else {
                                declaring
                            }
                        )
                    }
                    if ClrTypeUtilities.AreSame(declaringDef, openDefinition) {
                        let pos = openClr.GenericParameterPosition
                        if uint32(pos) < uint32(typeArguments.Length) {
                            return typeArguments[pos]
                        }
                    }
                }
                // Issue #833: method-level parameter (declared on a generic
                // method). `DeclaringMethod` is the only reliable discriminator —
                // `DeclaringType` is set for these too (to the method's own
                // declaring type, issue #2375 follow-up above) — so substitute via
                // the parallel method-type-args slot whenever `DeclaringMethod` is
                // present, regardless of `DeclaringType`.
                if openClr.DeclaringMethod != nil && !methodTypeArguments.IsDefaultOrEmpty {
                    if openMethodDefinition == nil || object.ReferenceEquals(
                        openClr.DeclaringMethod,
                        openMethodDefinition
                    ) ||
                        openClr.DeclaringMethod!!.MetadataToken == openMethodDefinition
                        .MetadataToken {
                        let pos = openClr.GenericParameterPosition
                        if uint32(pos) < uint32(methodTypeArguments.Length) {
                            let mapped TypeSymbol? = methodTypeArguments[pos]
                            if mapped != nil {
                                return mapped
                            }
                        }
                    }
                }
                return TypeSymbol.FromClrType(openClr)
            }
            if openClr.IsArray && openClr.GetArrayRank() > 1 {
                let mappedElement = MapOpenClrTypeToSymbolic(
                    openClr.GetElementType(),
                    openDefinition,
                    typeArguments,
                    openMethodDefinition,
                    methodTypeArguments
                )
                return RectangularArrayTypeSymbol.Get(mappedElement, openClr.GetArrayRank())
            }
            // Issue #794: an open generic type's instance member can return an
            // array of an open parameter (e.g. `List<T>.ToArray()` → `T[]`). The
            // CLR `Type` reports `IsArray` for those, not `IsGenericType`. Recurse
            // on the element type and surface a G# slice (`[]T`) so the call site
            // sees the symbolic projection rather than the erased `object[]`.
            // Issue #833 extends the recursion to method-level parameters so
            // `Enumerable.ToArray[T](IEnumerable[T]) → T[]` surfaces as `[]T`.
            if openClr.IsArray && openClr.GetArrayRank() == 1 {
                let openElement = openClr.GetElementType()
                let mappedElement = MapOpenClrTypeToSymbolic(
                    openElement,
                    openDefinition,
                    typeArguments,
                    openMethodDefinition,
                    methodTypeArguments
                )
                // Issue #1216: a method-level parameter may be substituted by a
                // same-compilation user type (e.g. `GC.AllocateArray[Foo]` /
                // `Array.Empty[Foo]` whose open return is `T[]`). The closed CLR
                // method erased `Foo` to `object`, so without surfacing the
                // symbolic slice here the call's return would collapse to the
                // erased `object[]` and fail to convert to `[]Foo` (GS0155). Mirror
                // the generic-type branch below, which already honours #903.
                if TypeSymbol.RequiresSymbolicProjection(mappedElement) ||
                    (
                    openElement?.ContainsGenericParameters == true &&
                        mappedElement
                        .ClrType
                        ?.ContainsGenericParameters == false
                ) {
                    return SliceTypeSymbol.Get(mappedElement)
                }
                return TypeSymbol.FromClrType(openClr)
            }
            // Issue #794: a managed pointer return (e.g. `List<T>.this[int]` on
            // `Span<T>`) reports `IsByRef`. Recurse on the pointee and wrap with
            // `ByRefTypeSymbol` to mirror the open-shape's contract.
            if openClr.IsByRef {
                let openPointee = openClr.GetElementType()
                let mappedPointee = MapOpenClrTypeToSymbolic(
                    openPointee,
                    openDefinition,
                    typeArguments,
                    openMethodDefinition,
                    methodTypeArguments
                )
                if TypeSymbol.RequiresSymbolicProjection(mappedPointee) ||
                    (
                    openPointee?.ContainsGenericParameters == true &&
                        mappedPointee
                        .ClrType
                        ?.ContainsGenericParameters == false
                ) {
                    return ByRefTypeSymbol.Get(mappedPointee)
                }
                return TypeSymbol.FromClrType(openClr)
            }
            // Issue #2391: keep substituted Nullable<T> positions in the
            // canonical G# nullable shape. The generic reconstruction below is
            // appropriate for ordinary imported generics, but using it for an
            // interface member such as IRepo<T>.Echo(T?) previously produced an
            // ImportedTypeSymbol for System.Nullable<Color>. The matching return
            // position was then distinct from the source Color? symbol even
            // though both came from the same receiver substitution.
            if NullableLifting.IsValueTypeNullableClr(openClr) {
                let openUnderlying = openClr.GetGenericArguments()[0]
                let mappedUnderlying = MapOpenClrTypeToSymbolic(
                    openUnderlying,
                    openDefinition,
                    typeArguments,
                    openMethodDefinition,
                    methodTypeArguments
                )
                return NullableLifting.WrapValueTypeNullable(mappedUnderlying)
            }
            if openClr.IsGenericType {
                let openArgs = openClr.GetGenericArguments()
                let symbolic = ImmutableArray.CreateBuilder[TypeSymbol](openArgs.Length)
                var anyParam = openClr.IsGenericTypeDefinition && !typeArguments.IsDefaultOrEmpty
                for a in openArgs {
                    let mapped = MapOpenClrTypeToSymbolic(
                        a,
                        openDefinition,
                        typeArguments,
                        openMethodDefinition,
                        methodTypeArguments
                    )
                    symbolic.Add(mapped)
                    // Issue #833 surfaced this projection for in-scope type
                    // parameters. Issue #903 extends it to same-compilation user
                    // types: a constructed return like `IEnumerable<TSource>` over
                    // a `List[Check]` must surface `IEnumerable[Check]` so a
                    // chained call (`Where(…).ToList()`) and the consuming
                    // receiver keep the `Check` element identity instead of
                    // collapsing to the type-erased `IEnumerable<object>` (which
                    // for a value-type element is not even a legal up-cast).
                    // ADR-0172: a named-tuple-bearing argument (at any nesting
                    // depth — `List[(a int32, b string)]` as the argument of an
                    // outer generic) shares its CLR backing with the unnamed
                    // shape, so collapsing to FromClrType would erase the names.
                    // Issue #4024 (review finding 2): an ARRAY-shaped argument is
                    // the third member of that family and was missing. `[]T` and
                    // `[N]T` at every length share the one SZ-array `T[]`, so
                    // collapsing to `FromClrType` here erases which spelling the
                    // author wrote — and this is the branch a generic METHOD's
                    // constructed return goes through, so
                    // `Factory.Make[[]int32]()` came back as a metadata-only
                    // `List<int[]>` (whose shape is genuinely unknowable) and
                    // filled a `List[[3]int32]` slot. Measured accepted on `main`
                    // and on this branch until this line was added; the named-tuple
                    // sibling one line up already proved the path was live.
                    if TypeSymbol.RequiresSymbolicProjection(mapped) || TypeSymbol.ContainsNamedTupleElements(mapped) ||
                        (a.ContainsGenericParameters && mapped.ClrType?.ContainsGenericParameters == false) {
                        anyParam = true
                    }
                }
                let openDef = openClr.GetGenericTypeDefinition()
                if !anyParam {
                    return TypeSymbol.FromClrType(openClr)
                }
                // Construct the type-erased closed shape (`<object, object, …>`) so
                // the resulting symbol mirrors the existing convention used by
                // ImportedTypeSymbol.GetConstructed callers (#313 / #671): ClrType
                // remains a real closed `Type` that reflection can probe for
                // members, while TypeArguments carries the symbolic projection.
                //
                // Issue #1305: when this projection runs over a method-level
                // return type (e.g. `Where<TSource>(…) → IEnumerable<TSource>`)
                // whose `openDef` was loaded by the references' MetadataLoadContext,
                // a live `typeof(object)` cannot close it ("type was not loaded by
                // the MetadataLoadContext"). The construction then fell into the
                // catch below and surfaced the *open* `IEnumerable<TSource>` as the
                // result's ClrType, so the next chained extension lookup
                // (`e.Where(…).Where(…)`) matched against an unbound method type
                // parameter and reported GS0159. Erase using an `object` resolved
                // in the same context as `openDef`.
                let openParams = openDef.GetGenericArguments()
                let contextObject = ResolveErasedObjectInContext(openDef)
                // Issue #1422: preserve the *nested* generic structure of each
                // symbolic argument when erasing. A chained projection such as
                // `xs.Select(e -> e.GetEnumerator())` yields an element type that is
                // itself a constructed generic interface (`IEnumerator[T]`). Flatly
                // erasing every top-level argument to `object` would collapse the
                // result's ClrType to `IEnumerable<object>`, so the next chained
                // extension (`.Select((e IEnumerator[T]) -> …)`) would infer
                // `TSource = object` and reject the typed selector with GS0159.
                // Recurse through each symbolic argument's own open definition so
                // the erased closed shape becomes `IEnumerable<IEnumerator<object>>`
                // — matching the (identically erased) selector parameter type — and
                // generic inference recovers the right `TSource`. Symbolic leaves
                // erase to `object`; concrete leaves keep their CLR identity, matching
                // the selector parameter's erasure and keeping both shapes aligned.
                let symbolicArgs = symbolic.ToImmutable()
                let erasedClosed = TryBuildErasedClosedGeneric(openDef, openParams, symbolicArgs, contextObject) ??
                    openClr
                return ImportedTypeSymbol.GetConstructed(erasedClosed, openDef, symbolicArgs)
            }
            return TypeSymbol.FromClrType(openClr)
        }

        /// Issue #833: structural unification that recovers the symbolic
        /// type-argument vector for an open generic CLR method when the call
        /// site did <em>not</em> supply an explicit `[T1, T2]` list.
        /// Walks every `(openParameter, symbolicArgument)` pair in
        /// parallel and records the symbolic shape sitting at each
        /// `MVar(idx)` slot, then returns the per-ordinal vector. When
        /// some slot is still missing the corresponding entry is `null`
        /// — callers must treat `null` as "no symbolic
        /// override; fall back to the closed-CLR projection". Conflicting exact
        /// or upper bounds use a private sentinel distinct from
        /// (cref:TypeSymbol.Error), while lower-only bounds with no symbolic
        /// common type remain unresolved so CLR inference can supply the erased
        /// common type.
        /// @param openMethod The open generic method definition.
        /// @param symbolicArgTypes Symbolic argument types in call order (receiver included as slot 0 for
        /// extension methods).
        /// @param isExpanded Whether the final params-array parameter consumes individual trailing arguments.
        /// @returns An array sized to the open method's generic-parameter arity, with one entry per ordinal
        /// (`null` when unrecovered).
        func InferSymbolicMethodTypeArguments(
            openMethod MethodInfo,
            symbolicArgTypes ImmutableArray[TypeSymbol?],
            isExpanded bool = false
        )[]TypeSymbol? -> InferSymbolicMethodTypeArgumentsCore(openMethod, symbolicArgTypes, isExpanded, out _)

        /// Issue #833 (sibling to #794 on the call-site argument side): when the
        /// imported generic method's open return type <em>contains</em> a method
        /// type parameter that maps to an in-scope G# type parameter, substitute
        /// the open return with the symbolic projection so the call site surfaces
        /// e.g. `IEnumerable[T]` rather than the type-erased
        /// `IEnumerable<object>`. [`symbolicMethodTypeArgs`](paramref)
        /// carries the resolved symbolic arguments at MVar ordinals (explicit-list
        /// or inferred via (cref:InferSymbolicMethodTypeArguments)).
        /// Returns `null` when no symbolic substitution applies, so
        /// callers keep their existing return-type derivation.
        ///
        /// ADR-0193 Phase 2 (GSA0007): this member and
        /// (cref:ResolveByRefParameterPointeeFromSymbolicTypeArgs) return a
        /// projected signature position with no declaration-nullability merge, so
        /// a concrete oblivious container returned (or `out`-bound) through a
        /// symbolically inferred generic call loses its `!`. Both reach the
        /// door only through (cref:MapOpenSignatureWithoutDeclarationMerge),
        /// the one suppressed member, so the gap stays one call wide.
        /// @param closed The closed generic method selected by overload resolution.
        /// @param symbolicMethodTypeArgs Per-MVar symbolic type arguments; entries may be `null`.
        /// @param receiverType The receiver's static type symbol (for type-level Var substitution); may be
        /// `null`.
        /// @returns The override return type symbol, or `null`.
        func ResolveCallReturnTypeFromSymbolicTypeArgs(
            closed MethodInfo?,
            symbolicMethodTypeArgs ImmutableArray[TypeSymbol?],
            receiverType TypeSymbol?
        ) TypeSymbol? {
            if closed == nil || !closed.IsGenericMethod {
                return nil
            }
            if symbolicMethodTypeArgs.IsDefaultOrEmpty || !symbolicMethodTypeArgs.Any((s TypeSymbol?) -> s != nil) {
                return nil
            }
            let openMethod = ReopenForSymbolicProjection(
                closed,
                receiverType,
                out var receiverOpenDef,
                out var receiverTypeArgs
            )
            let openReturn Type? = openMethod.ReturnType
            if openReturn == nil || openReturn.IsSameAs(typeof(Void)) {
                return nil
            }
            if openReturn.IsGenericType && !openReturn.IsGenericTypeDefinition {
                let openReturnDefinition = openReturn.GetGenericTypeDefinition()
                let fullName = openReturnDefinition.FullName
                if (
                    fullName is "System.Threading.Tasks.Task`1" or
                        "System.Threading.Tasks.ValueTask`1" or
                        "System.Collections.Generic.IAsyncEnumerable`1"
                ) {
                    let openArguments = openReturn.GetGenericArguments()
                    let projectedArguments = ImmutableArray.CreateBuilder[TypeSymbol](openArguments.Length)
                    for argument in openArguments {
                        projectedArguments.Add(
                            MapOpenSignatureWithoutDeclarationMerge(
                                argument,
                                receiverOpenDef,
                                receiverTypeArgs,
                                openMethod,
                                symbolicMethodTypeArgs
                            )
                        )
                    }
                    let symbolicArguments = projectedArguments.MoveToImmutable()
                    let erasedObject = ResolveErasedObjectInContext(openReturnDefinition)
                    let closedReturn = TryBuildErasedClosedGeneric(
                        openReturnDefinition,
                        openReturnDefinition.GetGenericArguments(),
                        symbolicArguments,
                        erasedObject
                    ) ??
                        openReturn
                    return ImportedTypeSymbol.GetConstructed(closedReturn, openReturnDefinition, symbolicArguments)
                }
            }
            let mapped = MapOpenSignatureWithoutDeclarationMerge(
                openReturn,
                receiverOpenDef,
                receiverTypeArgs,
                openMethod,
                symbolicMethodTypeArgs
            )
            // ADR-0172: a named-tuple-bearing return shares its CLR backing with
            // the unnamed shape, so the CLR fallback would erase the names — keep
            // the symbolic projection for it too.
            // Issue #4024 (review finding 2): an ARRAY-shaped return needs the same
            // treatment, and for the same reason — `[]T` and `[N]T` at every length
            // share the one SZ-array `T[]`, so the CLR fallback erases which
            // spelling the author wrote. Without this the call fell back to the
            // metadata-only `List<int[]>`, whose shape is genuinely unknowable, and
            // `var x List[[3]int32] = Factory.Make[[]int32]()` was accepted — this
            // issue's own hole, reached through a generic factory RETURN rather
            // than a construction, and measured accepted both on `main` and on this
            // branch before the review.
            //
            // Two lines close it, and only two: this one and the
            // `BuildSymbolicMethodTypeArgs` gate that decides whether a symbolic
            // vector reaches this method at all. Ablated individually, each alone
            // leaves the program accepted. Two further candidate sites
            // (`MapOpenClrTypeToSymbolic`'s inner retention test, and a new arm in
            // `ResolveImportedGenericReturnType` for a constructed-generic return)
            // were written, measured to change nothing once these two were in
            // place, and dropped.
            // #4451 (ADR-0193 amendment): a return that IS a method type
            // parameter bound to `T!` (an explicit argument at an oblivious
            // declaration, or #4459's oblivious-slot inference) keeps it. The CLR
            // fallback reads the closed `string` and would drop the `!`.
            return if TypeSymbol.RequiresSymbolicProjection(mapped) || TypeSymbol.ContainsNamedTupleElements(mapped) ||
                TypeSymbol.ContainsSourceArrayShape(mapped) || mapped is PlatformTypeSymbol {
                mapped
            } else {
                default(TypeSymbol?)
            }
        }

        /// Issue #4350: the by-ref counterpart of
        /// (cref:ResolveCallReturnTypeFromSymbolicTypeArgs) for an inline
        /// `out var`. When the resolved generic method's parameter pointee
        /// contains a method type parameter that maps to an in-scope G# type
        /// parameter (`MemoryMarshal.TryGetArray[T](memory, out var segment)`
        /// inside `Slice[T]`), the declared local takes the symbolic
        /// `ArraySegment[T]` rather than the erased `ArraySegment[object]`.
        /// @param closed The closed generic method selected by overload resolution.
        /// @param parameterIndex The by-ref parameter's position.
        /// @param symbolicMethodTypeArgs Per-MVar symbolic type arguments; entries may be `null`.
        /// @param receiverType The receiver's static type symbol (for type-level Var substitution); may be
        /// `null`.
        /// @returns The symbolic pointee type, or `null` when no symbolic substitution applies.
        func ResolveByRefParameterPointeeFromSymbolicTypeArgs(
            closed MethodInfo?,
            parameterIndex int32,
            symbolicMethodTypeArgs ImmutableArray[TypeSymbol?],
            receiverType TypeSymbol?
        ) TypeSymbol? {
            if closed == nil ||
                !closed.IsGenericMethod ||
                symbolicMethodTypeArgs.IsDefaultOrEmpty ||
                !symbolicMethodTypeArgs.Any((s TypeSymbol?) -> s != nil) {
                return nil
            }
            let openMethod = ReopenForSymbolicProjection(
                closed,
                receiverType,
                out var receiverOpenDef,
                out var receiverTypeArgs
            )
            let parameters = openMethod.GetParameters()
            if parameterIndex < 0 || parameterIndex >= parameters.Length {
                return nil
            }
            var openType = parameters[parameterIndex].ParameterType
            if openType.IsByRef && openType.GetElementType() is {} pointee {
                openType = pointee
            }
            if !openType.ContainsGenericParameters {
                return nil
            }
            let mapped = MapOpenSignatureWithoutDeclarationMerge(
                openType,
                receiverOpenDef,
                receiverTypeArgs,
                openMethod,
                symbolicMethodTypeArgs
            )
            return if TypeSymbol.RequiresSymbolicProjection(mapped) {
                mapped
            } else {
                default(TypeSymbol?)
            }
        }

        // The one suppression ADR-0193 Phase 2 allows. It covers exactly this
        // member, whose body is the one door call the phase cannot close; a
        // whole-member region is also the only shape cs2gs carries into the
        // self-migrated tree as @SuppressDiagnostic (ADR-0175), so a pragma around
        // the call alone would be dropped there. Merging here is blocked on Phase
        // 3: the symbolic-projection consumers do not peel `PlatformTypeSymbol`,
        // which is why PR #4362 round 3 (`b0c76053d`) backed the merge out. Phase
        // 4 (issue #4363) adds the merge, attributes this member
        // `[NullabilityFunnel]` and deletes the pragma. Every reference to it is
        // pinned by Adr0193SymbolicProjectionGapCallersTests.
        /// ADR-0193 Phase 2: the known symbolic-projection gap, in one place.
        /// (cref:ResolveCallReturnTypeFromSymbolicTypeArgs) and
        /// (cref:ResolveByRefParameterPointeeFromSymbolicTypeArgs) project
        /// through here, and so do the symbolic lambda- and delegate-target projections (the binder's
        /// `TryBuildSymbolicDelegateTarget*` and deferred-lambda paths)
        /// project a delegate-typed signature position through symbolic type
        /// arguments and read the literal's target shape off the result. They
        /// need the declaration's `[Nullable]` merged — a
        /// `Func<string?, T>` parameter's `string?` lives in the
        /// PARAMETER's flags, not `Invoke`'s — but the merge stamps a root
        /// `!` or `?` onto the projected delegate, and every one of those
        /// consumers tests the result for (cref:ImportedTypeSymbol) without
        /// peeling it: exactly the blocker that keeps
        /// (cref:ResolveCallReturnTypeFromSymbolicTypeArgs) unmerged.
        /// The params-array element projection over symbolic method type
        /// arguments (`OverloadResolver.ExpandParamsArguments`) shares the
        /// same blocker. Routing them here, rather than calling the door from
        /// several binder files, keeps the gap to one suppressed region that
        /// Phase 4 closes by adding the merge in this one member.
        /// @param openClr The open signature type to project.
        /// @param openDefinition The open declaring type, if any.
        /// @param typeArguments The declaring type's symbolic arguments.
        /// @param openMethodDefinition The open generic method, if any.
        /// @param methodTypeArguments The method's symbolic arguments.
        /// @returns The unmerged symbolic projection.
        @SuppressDiagnostic("GSA0007")
        func MapOpenSignatureWithoutDeclarationMerge(
            openClr Type?,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol],
            openMethodDefinition MethodInfo? = nil,
            methodTypeArguments ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
        ) TypeSymbol -> MapOpenClrTypeToSymbolic(
            openClr,
            openDefinition,
            typeArguments,
            openMethodDefinition,
            methodTypeArguments
        )

        /// ADR-0193 amendment (2026-09-26, #4451): the type an explicit method
        /// type argument binds, decided by
        /// (cref:NullabilityImportRule.ApplyExplicitOpenSlotArgument) from
        /// what the open declaration says about a parameter slot the type
        /// parameter fills directly. A type parameter that fills no parameter
        /// slot directly keeps the argument as written.
        /// @param closedOrOpenMethod The called method.
        /// @param ordinal The type parameter's position.
        /// @param argument The explicit type argument.
        /// @returns The type the type parameter is bound to.
        func ApplyExplicitMethodTypeArgument(
            closedOrOpenMethod MethodInfo,
            ordinal int32,
            argument TypeSymbol
        ) TypeSymbol {
            let openMethod = if closedOrOpenMethod.IsGenericMethodDefinition || !closedOrOpenMethod.IsGenericMethod {
                closedOrOpenMethod
            } else {
                closedOrOpenMethod.GetGenericMethodDefinition()
            }
            // Every slot the type parameter fills directly must agree. If one is
            // oblivious and another is annotated or enabled, a `T!` binding
            // would take the check away from the stated slot, so the argument
            // stays as written and each slot is converted on its own terms.
            var agreed ClrNullabilityState? = nil
            for parameter in openMethod.GetParameters() {
                let parameterType = if parameter.ParameterType.IsByRef {
                    parameter.ParameterType.GetElementType()
                } else {
                    parameter.ParameterType
                }
                if parameterType != nil &&
                    parameterType.IsGenericParameter == true &&
                    parameterType.DeclaringMethod != nil &&
                    parameterType.GenericParameterPosition == ordinal {
                    let state = ClrNullability.GetParameterDeclaredState(parameter)
                    if agreed is {} previous && previous != state {
                        return argument
                    }
                    agreed = state
                }
            }
            return if agreed is {} declared {
                NullabilityImportRule.ApplyExplicitOpenSlotArgument(argument, declared)
            } else {
                argument
            }
        }

        /// Issue #833: build the per-MVar symbolic type-argument vector for an
        /// imported generic-method call. When the call site supplied an explicit
        /// `[T1, T2]` list ([`explicitTypeArgSymbols`](paramref) is
        /// non-default), those symbols are used directly. Otherwise the vector
        /// is inferred from the call's symbolic argument types
        /// ([`symbolicArgTypes`](paramref)) via structural unification.
        /// Returns `default` when the method is not generic or
        /// no symbolic information can be recovered.
        /// @param closed The closed generic method selected by overload resolution.
        /// @param explicitTypeArgSymbols The explicit symbols, or default when none were supplied.
        /// @param symbolicArgTypes Symbolic argument types in call order (receiver first when applicable).
        /// @param isExpanded Whether params-array inference should unify trailing scalar arguments with the
        /// array element type.
        /// @param argumentNames Issue #4026: the call's per-source-index argument names, so a named call's
        /// symbolic vector is reordered into parameter order exactly as the CLR one already is; null entries
        /// are positional, and a null list means nothing to reorder.
        /// @returns The per-MVar vector (length == open arity), or default when nothing recoverable.
        func BuildSymbolicMethodTypeArgs(
            closed MethodInfo?,
            explicitTypeArgSymbols ImmutableArray[TypeSymbol],
            symbolicArgTypes ImmutableArray[TypeSymbol],
            isExpanded bool = false,
            argumentNames IReadOnlyList[string?]? = nil
        ) ImmutableArray[TypeSymbol?] -> BuildSymbolicMethodTypeArgs(
            closed,
            explicitTypeArgSymbols,
            symbolicArgTypes,
            isExpanded,
            argumentNames,
            methodGroupArgumentSlots: default(ImmutableArray[bool])
        )

        /// Issue #4133 (hot-core translation guard finding): overload that also
        /// accepts, parallel to [`symbolicArgTypes`](paramref), which
        /// argument slots were recovered from a bare method group (see
        /// `RefineSymbolicArgsForMethodGroups`'s method-group-slots
        /// overload) — forwarded to `InferSymbolicMethodTypeArgumentsCore`
        /// so their contravariant contribution demotes to a same-slot fallback
        /// instead of outranking a real bound. Reordered here the same way
        /// [`symbolicArgTypes`](paramref) is reordered for a named-argument
        /// call, so the two stay aligned by parameter position.
        /// @param closed The winning (possibly closed generic) CLR method.
        /// @param explicitTypeArgSymbols Explicit type arguments supplied at the call site, if any.
        /// @param symbolicArgTypes The pre-resolution symbolic argument vector.
        /// @param isExpanded Whether trailing arguments target a params-array element.
        /// @param argumentNames Optional source-slot argument names.
        /// @param methodGroupArgumentSlots Parallel to [`symbolicArgTypes`](paramref): `true` for a slot
        /// recovered from a bare method group.
        /// @returns The recovered symbolic type arguments, or `default` when none could be recovered.
        func BuildSymbolicMethodTypeArgs(
            closed MethodInfo?,
            explicitTypeArgSymbols ImmutableArray[TypeSymbol],
            symbolicArgTypes ImmutableArray[TypeSymbol],
            isExpanded bool,
            argumentNames IReadOnlyList[string?]?,
            methodGroupArgumentSlots ImmutableArray[bool]
        ) ImmutableArray[TypeSymbol?] {
            if closed == nil || !closed.IsGenericMethod {
                return default(ImmutableArray[TypeSymbol?])
            }
            let openMethod = if closed.IsGenericMethodDefinition {
                closed
            } else {
                closed.GetGenericMethodDefinition()
            }
            let arity = openMethod.GetGenericArguments().Length
            if arity == 0 {
                return default(ImmutableArray[TypeSymbol?])
            }
            var inferred[]TypeSymbol?
            var requiresRecoveredInference = false
            if !symbolicArgTypes.IsDefault && symbolicArgTypes.Length > 0 {
                let nullableSymbolicArgTypes = ImmutableArray.CreateBuilder[TypeSymbol?](symbolicArgTypes.Length)
                for symbolicArgType in symbolicArgTypes {
                    nullableSymbolicArgTypes.Add(symbolicArgType)
                }
                var orderedSymbolicArgTypes = nullableSymbolicArgTypes.MoveToImmutable()
                var orderedMethodGroupArgumentSlots = methodGroupArgumentSlots
                // Issue #4026 (review finding): unification below zips the open
                // parameters with these arguments POSITIONALLY, so a call that
                // names its arguments out of order pairs each one with the wrong
                // parameter — `Marked[T](int marker, Dictionary[string, T] entries)`
                // called as `Marked(entries: entries, marker: 0)` unified the map
                // against `int` and recovered no `T` at all, leaving the MethodSpec
                // closed over the argument's erasure and the assembly failing
                // ILVerify with `StackUnexpected`. CLR inference has reordered here
                // since #343 (`TryBuildOrderedArgTypesForInference`); this is the
                // symbolic side of the same correction, reusing the resolver's own
                // mapping so the two can never disagree about it. Nothing moves
                // unless the call actually named an argument.
                if ClrOverloadResolution.TryBuildNamedArgumentReordering(
                    openMethod,
                    orderedSymbolicArgTypes.Length,
                    argumentNames,
                    isExpanded,
                    out var sourceToParameter
                ) {
                    let parameterCount = openMethod.GetParameters().Length
                    if isExpanded && parameterCount > 0 && ClrOverloadResolution.IsParamsArrayParameter(
                        openMethod.GetParameters()[^1]
                    ) {
                        let paramsIndex = parameterCount - 1
                        let expandedCount = sourceToParameter.Count((parameter int32) -> parameter == paramsIndex)
                        let byParameter = [paramsIndex + expandedCount]TypeSymbol?
                        var expandedSlot = paramsIndex
                        for var source = 0;
                            source < orderedSymbolicArgTypes.Length &&
                            source < sourceToParameter.Length;
                            source++ {
                            let parameter = sourceToParameter[source]
                            if parameter == paramsIndex {
                                byParameter[expandedSlot] = orderedSymbolicArgTypes[source]
                                expandedSlot++
                            } else {
                                byParameter[parameter] = orderedSymbolicArgTypes[source]
                            }
                        }
                        orderedSymbolicArgTypes = ImmutableArray.Create(byParameter)
                        if !methodGroupArgumentSlots.IsDefault {
                            let byParameterFlags = [paramsIndex + expandedCount]bool
                            var expandedFlagSlot = paramsIndex
                            for var source = 0;
                                source < methodGroupArgumentSlots.Length &&
                                source < sourceToParameter.Length;
                                source++ {
                                let parameter = sourceToParameter[source]
                                if parameter == paramsIndex {
                                    byParameterFlags[expandedFlagSlot] = methodGroupArgumentSlots[source]
                                    expandedFlagSlot++
                                } else {
                                    byParameterFlags[parameter] = methodGroupArgumentSlots[source]
                                }
                            }
                            orderedMethodGroupArgumentSlots = ImmutableArray.Create(byParameterFlags)
                        }
                    } else {
                        let byParameter = [parameterCount]TypeSymbol?
                        for var source = 0;
                            source < orderedSymbolicArgTypes.Length &&
                            source < sourceToParameter.Length;
                            source++ {
                            byParameter[sourceToParameter[source]] = orderedSymbolicArgTypes[source]
                        }
                        orderedSymbolicArgTypes = ImmutableArray.Create(byParameter)
                        if !methodGroupArgumentSlots.IsDefault {
                            let byParameterFlags = [parameterCount]bool
                            for var source = 0;
                                source < methodGroupArgumentSlots.Length &&
                                source < sourceToParameter.Length;
                                source++ {
                                byParameterFlags[sourceToParameter[source]] = methodGroupArgumentSlots[source]
                            }
                            orderedMethodGroupArgumentSlots = ImmutableArray.Create(byParameterFlags)
                        }
                    }
                }
                inferred = InferSymbolicMethodTypeArgumentsCore(
                    openMethod,
                    orderedSymbolicArgTypes,
                    isExpanded,
                    orderedMethodGroupArgumentSlots,
                    out requiresRecoveredInference
                )
            } else {
                inferred = [arity]TypeSymbol?
            }
            // Explicit list takes precedence at each slot when present.
            if !explicitTypeArgSymbols.IsDefaultOrEmpty {
                requiresRecoveredInference = false
                for var i = 0; i < arity && i < explicitTypeArgSymbols.Length; i++ {
                    if explicitTypeArgSymbols[i] != nil {
                        inferred[i] = ApplyExplicitMethodTypeArgument(openMethod, i, explicitTypeArgSymbols[i])
                    }
                }
            }
            var anySymbolic = requiresRecoveredInference
            for var i = 0; i < inferred.Length; i++ {
                // Issue #833: an in-scope type parameter requires the symbolic
                // vector. Issue #903: a same-compilation user type (e.g. `Check`
                // recovered from a `List[Check]` receiver) does too — the closed
                // CLR method erased it to `object`, so without the symbolic vector
                // the call's return type / lambda parameter type would be `object`.
                // ADR-0172: a named-tuple-bearing inferred argument also needs
                // the symbolic vector — the closed CLR method's shapes share the
                // unnamed backing, so the CLR fallback would erase the names.
                // Issue #4024 (review finding 2): an ARRAY-shaped argument needs it
                // for the same reason. This is the OUTERMOST of the three gates a
                // generic method's constructed return passes through, and the one
                // that actually decided: with the vector dropped here,
                // `ResolveCallReturnTypeFromSymbolicTypeArgs` bails on its
                // `IsDefaultOrEmpty` guard and the call falls back to the closed
                // CLR return `List<int[]>` — indistinguishable from metadata, so
                // `var x List[[3]int32] = Factory.Make[[]int32]()` was accepted.
                // The named-tuple clause above is why the tuple spelling of the
                // same program already worked, which is how the gate was located.
                if inferred[i] is {} inferredType &&
                    (
                    IsSymbolicInferenceConflict(inferredType) || TypeSymbol.RequiresSymbolicProjection(inferredType) ||
                        TypeSymbol.ContainsNamedTupleElements(inferredType) || TypeSymbol.ContainsSourceArrayShape(
                        inferredType
                    ) ||
                        symbolicArgTypes.Any(
                        (symbolic TypeSymbol) -> symbolic != nil && TypeSymbol.ContainsNullLiteralType(symbolic)
                    )
                ) {
                    anySymbolic = true
                    break
                }
            }
            if !anySymbolic {
                return default(ImmutableArray[TypeSymbol?])
            }
            return ImmutableArray.Create(inferred)
        }

        /// Issue #833: convenience helper that builds the
        /// (receiver, arguments) → symbolic-type vector consumed by
        /// (cref:InferSymbolicMethodTypeArguments).
        /// @param receiverType The receiver's symbolic type (for instance/extension calls); may be `null` for
        /// static calls.
        /// @param argumentTypes The bound arguments' symbolic types.
        /// @returns An immutable array with receiver-first ordering when present.
        func BuildSymbolicArgTypeVector(
            receiverType TypeSymbol?,
            argumentTypes ImmutableArray[TypeSymbol]
        ) ImmutableArray[TypeSymbol] {
            let argCount = if argumentTypes.IsDefault {
                0
            } else {
                argumentTypes.Length
            }
            let count = (
                if receiverType != nil {
                    1
                } else {
                    0
                }
            ) +
                argCount
            if count == 0 {
                return ImmutableArray[TypeSymbol].Empty
            }
            let b = ImmutableArray.CreateBuilder[TypeSymbol](count)
            if receiverType != nil {
                b.Add(receiverType)
            }
            if argCount > 0 {
                for a in argumentTypes {
                    b.Add(a)
                }
            }
            return b.MoveToImmutable()
        }

        /// Issue #3907: removes imported candidates that could only accept a
        /// by-ref argument over a same-compilation user REFERENCE type by erasing
        /// it — i.e. whose parameter at such a slot is a by-ref over a type that is
        /// not generic in the OPEN definition.
        /// @remarks C# requires a `ref` argument to match its parameter exactly,
        /// and no imported signature can name a class this compilation has not
        /// emitted yet, so a generic `ref T` is the only parameter such an
        /// argument can legally reach. Without this filter the non-generic
        /// `Interlocked.Exchange(ref object?, object?)` was an exact IDENTITY
        /// match for `Interlocked.Exchange(&nodeField, nil)` — the #658
        /// erasure made `ref Node` look like `ref object` — so it beat
        /// `Exchange<T>(ref T, T)`, a candidate csc never even
        /// considers.
        ///
        /// The filter runs on the OPEN candidates on purpose: once a generic
        /// candidate is closed over the erasure its `ref T` has already become
        /// `ref object` and is indistinguishable from the non-generic
        /// overload's. Slots are matched positionally and the filter declines to
        /// act when the call site uses named arguments, so it can never drop a
        /// candidate whose parameter order it has not actually established.
        /// @param candidates The imported candidates to filter.
        /// @param symbolicByRefArgs Per-argument flags marking the symbolic by-ref slots; `null` disables the
        /// filter.
        /// @param argumentNames Optional source argument names aligned with the arguments.
        /// @returns Candidates that can accept the symbolic by-ref argument without erasing it.
        func ExcludeNonGenericByRefCandidates(
            candidates IEnumerable[MethodInfo]?,
            symbolicByRefArgs IReadOnlyList[bool]?,
            argumentNames IReadOnlyList[string?]? = nil
        ) IEnumerable[MethodInfo] {
            let AcceptsSymbolicByRefSlots = func (candidate MethodInfo, symbolicByRefArgs IReadOnlyList[bool]) bool {
                let open_ = if candidate.IsGenericMethod && !candidate.IsGenericMethodDefinition {
                    candidate.GetGenericMethodDefinition()
                } else {
                    candidate
                }
                let parameters = open_.GetParameters()
                for var i = 0; i < symbolicByRefArgs.Count; i++ {
                    if !symbolicByRefArgs[i] {
                        continue
                    }
                    if i >= parameters.Length {
                        return false
                    }
                    let parameterType = parameters[i].ParameterType
                    if !parameterType.IsByRef || parameterType.GetElementType()?.IsGenericParameter != true {
                        return false
                    }
                }
                return true
            }
            if candidates == nil || symbolicByRefArgs == nil {
                return candidates ?? Enumerable.Empty[MethodInfo]()
            }
            if argumentNames != nil {
                for name in argumentNames {
                    if name != nil {
                        return candidates
                    }
                }
            }
            let filtered = List[MethodInfo]()
            for candidate in candidates {
                if AcceptsSymbolicByRefSlots(candidate, symbolicByRefArgs) {
                    filtered.Add(candidate)
                }
            }
            return filtered
        }

        /// Issue #4028: removes an explicitly-implemented member of a NON-GENERIC
        /// interface — the `object`-widening kind, `IList.Add(object)` and
        /// `IDictionary.Add(object, object)` — from a class receiver's
        /// candidate set unless it is genuinely there to REPAIR an erasure.
        /// @remarks #4013 took every abstract interface member off a class's own
        /// surface but kept two exemptions at candidate COLLECTION, because the
        /// compiler still depended on them: a synthesized collection-initializer
        /// `Add`, and a call whose argument carries a same-compilation type.
        /// Those exemptions are what left `List[int32]{"x"}` compiling and
        /// throwing `ArgumentException`, and
        /// `Dictionary[string, int32]{"a": "x"}` with it. The collection lookup
        /// is memoized on `(Type, name)` and cannot see arguments, so the
        /// discrimination happens here, at applicability, on the candidate list the
        /// call already has — exactly where the issue says it has to.
        ///
        /// Two things keep the member, and both are about the CALL rather than
        /// the member:
        ///
        /// 1. The RECEIVER carries a same-compilation type, so its own members' parameter types are erasure
        /// surrogates and cannot be trusted to judge anything. `List[System.Action[Mode]]` is built over the
        /// flat `System.Object` placeholder of the generic-CONSTRUCTION path and presents as
        /// `List<Action<object>>`, while the lambda erases the enum and presents as `Action<int>`; the type's
        /// own `Add` is inapplicable for a reason that has nothing to do with the author's code
        /// (`Issue2918InlineLambdaErasedReceiverTests`). That is #4016's defect one site over, and until it is
        /// repaired there the escape hatch has to stay open here.
        /// 2. The receiver's own surface WOULD have taken this call on the arguments' REAL types. A
        /// same-compilation struct has no CLR type while binding, so a `[]Celsius` spread into a
        /// `List[float64]` erases to `object` and cannot match `Add(double)` through its user-defined
        /// conversion — but the conversion exists, and asking the conversion classifier on the symbolic types
        /// finds it (`Issue3096CollectionSpreadEmitTests.UserDefinedSpreadConversions…`). The receiver has no
        /// erasure of its own in this branch, so its members' CLOSED parameter types ARE their real types and
        /// no symbolic re-derivation is needed. Issue #4036: keeping the member is only half the answer — the
        /// conversion this branch FINDS must also be APPLIED, or the kept member wins on the erased argument
        /// and the call throws. (cref:FindUserDefinedConversionRepairTargets) asks this same question a second
        /// time and names the parameter type to convert to, so the member stays reachable but stops winning.
        ///
        /// What is left over is the reported hole and only it: a genuine
        /// `string` at a genuine `int32`, or a `Celsius` at an
        /// `int32` it does not convert to. Neither is an erasure to repair, so
        /// the widening member goes and the call reports `GS0159` — the same
        /// diagnostic the author-written `List[int32]().Add("x")` already
        /// reports since #4013. A GENERIC interface's member is never a target here:
        /// on a constructed class receiver it is closed over the receiver's own type
        /// arguments and cannot widen, which is why
        /// `Dictionary[K, V](){ ...pairs }` goes on reaching
        /// `ICollection<KeyValuePair<K, V>>.Add`.
        ///
        /// An argument with no bound type at all (an un-inferred lambda, a
        /// method group) makes the whole judgement unavailable, so the candidates
        /// are returned untouched: this filter never removes on ignorance.
        /// @param candidates The collected candidates, in candidate order.
        /// @param clrType The receiver's CLR type; an interface receiver is exempt.
        /// @param receiverType The receiver's symbolic type.
        /// @param argumentTypes The bound arguments' symbolic types, in source order.
        /// @param argumentNames The per-source-index argument names; null entries are positional.
        /// @returns The candidates, less any unreachable widening member.
        func ExcludeUnreachableNonGenericInterfaceCandidates(
            candidates IReadOnlyList[MethodInfo]?,
            clrType Type?,
            receiverType TypeSymbol?,
            argumentTypes IReadOnlyList[TypeSymbol?],
            argumentNames IReadOnlyList[string?]? = nil
        ) IReadOnlyList[MethodInfo] {
            // An abstract member of a NON-GENERIC interface: the kind a class can
            // only have implemented explicitly, and whose parameters are therefore
            // not closed over the receiver's type arguments — so it is the only kind
            // that can widen a slot the type's own member would have narrowed.
            let IsWidening = func (candidate MethodInfo) bool {
                return candidate is {IsAbstract: true, DeclaringType: {IsInterface: true, IsGenericType: false}}
            }
            if candidates == nil || candidates.Count == 0 || clrType == nil || clrType.IsInterface {
                return candidates ?? cast[IReadOnlyList[MethodInfo]](Array.Empty[MethodInfo]())
            }
            var hasWideningInterfaceCandidate = false
            for candidate in candidates {
                if IsWidening(candidate) {
                    hasWideningInterfaceCandidate = true
                    break
                }
            }
            if !hasWideningInterfaceCandidate {
                return candidates
            }
            // (1) An erased receiver's own members are surrogates; judge nothing.
            if receiverType != nil && TypeSymbol.ContainsSameCompilationUserType(receiverType) {
                return candidates
            }
            for argumentType in argumentTypes {
                if argumentType == nil {
                    return candidates
                }
            }
            // (2) Would the receiver's own surface have taken this call for real?
            let name = candidates[0].Name
            for own in SafeGetMethodsIncludingSelfAndInterfaces(clrType, name) {
                if IsWidening(own) {
                    continue
                }
                let parameters = own.GetParameters()
                if parameters.Length != argumentTypes.Count {
                    continue
                }
                // Issue #4036 (review finding): the arguments arrive in SOURCE
                // order and these parameters are in DECLARATION order, so a call
                // that names its arguments out of order compared each one against
                // the wrong slot — `Add(value: someCelsius, key: "a")` asked
                // whether a `Celsius` fits `key: string`, decided the receiver's
                // own `Add` could not take the call, removed the widening member
                // and reported GS0159 for a call that is perfectly valid. Reorder
                // through the resolver's OWN mapping, exactly as #4026 had to for
                // symbolic type-argument recovery, so the two can never disagree.
                if !TryMapSourceArgumentsToParameters(own, argumentTypes.Count, argumentNames, out var ownMapping) {
                    // The call names an argument this member does not declare, so
                    // this member genuinely cannot take the call.
                    continue
                }
                var accepts = true
                for var i = 0; i < parameters.Length; i++ {
                    let argumentType TypeSymbol? = argumentTypes[i]
                    let parameterSymbol TypeSymbol? = ClrNullability.GetParameterTypeSymbol(
                        parameters[ownMapping?[i] ?? i]
                    )
                    if argumentType == nil ||
                        parameterSymbol == nil ||
                        !(
                        Conversion.Classify(argumentType, parameterSymbol)
                            .Exists ||
                            ConversionClassifier.HasUserDefinedImplicitConversionForTypes(argumentType, parameterSymbol)
                    ) {
                        accepts = false
                        break
                    }
                }
                if accepts {
                    return candidates
                }
            }
            let kept = List[MethodInfo](candidates.Count)
            for candidate in candidates {
                if !IsWidening(candidate) {
                    kept.Add(candidate)
                }
            }
            return kept
        }

        /// Issue #4036: the conversion-APPLICATION half of what
        /// (cref:ExcludeUnreachableNonGenericInterfaceCandidates) decides.
        /// When that filter finds the receiver's own surface would have taken the
        /// call only through a user-defined implicit conversion, it KEEPS the
        /// widening member on purpose — the erasure is genuine and there is a
        /// repair for it. This method names the repair: the parameter type, per
        /// argument position, that the argument must be converted to for the
        /// receiver's own member to be applicable on real types.
        /// @remarks <b>The defect.</b> A same-compilation struct has no CLR type while
        /// binding, so `Celsius` presents to overload resolution as
        /// `object`. Against `List<double>` that is an IDENTITY
        /// match for `System.Collections.IList.Add(object)` and no match at
        /// all for `Add(double)`, so the widening member wins every
        /// betterness ranking and `list.Add(someCelsius)` compiled to
        /// verifiable IL that threw `ArgumentException` from inside the BCL.
        /// The same erasure made `list.Contains(someCelsius)` answer
        /// `False` and `list.IndexOf(someCelsius)` answer `-1`
        /// without any diagnostic at all, and `list.Remove(someCelsius)`
        /// report `GS0124` because `IList.Remove` is `void`.
        ///
        /// <b>Why the spread form was already right.</b>
        /// `List[float64](){ ...someCelsiusSlice }` lowers through
        /// `ExpressionBinder.BindConvertedCollectionAddCall`, which types its
        /// item placeholder as the collection's ELEMENT type and converts the item
        /// to it BEFORE binding `Add` — so overload resolution never sees the
        /// erased argument and picks `List<double>.Add(double)`. That
        /// path is collection-shaped: it knows an element type. An ordinary call
        /// has no element type, only a candidate set, so the two cannot share one
        /// path. They can agree, and this makes them agree — convert first, then
        /// bind.
        ///
        /// <b>Why this is safe.</b> The gate is
        /// (cref:ExcludeUnreachableNonGenericInterfaceCandidates)' own,
        /// verbatim: no widening member in the candidate set means no repair (an
        /// ordinary call already ranks user-defined conversions for itself); an
        /// erased RECEIVER means nothing here can judge the call; an argument with
        /// no bound type means the judgement is unavailable. On top of that, a
        /// position is repaired only when the ordinary conversion does NOT exist
        /// and the user-defined one does, and only when the own surface offers
        /// exactly ONE distinct parameter-type vector — so
        /// `List<double>.Add(double)` and
        /// `ICollection<double>.Add(double)` count as one answer, and a
        /// genuinely ambiguous surface is left alone. `List[object]` is
        /// untouched because `Celsius -> object` is an ordinary boxing
        /// conversion, so no position needs repairing.
        ///
        /// <b>What it deliberately does not do.</b> It does not remove the
        /// widening member — #4028 keeps it here on purpose, and that release note
        /// stays literally true. The member is still collected and still
        /// applicable; it simply stops WINNING, because the repaired argument is a
        /// real `double` and identity beats boxing.
        /// @param candidates The collected candidates, in candidate order.
        /// @param clrType The receiver's CLR type; an interface receiver is exempt.
        /// @param receiverType The receiver's symbolic type.
        /// @param argumentTypes The bound arguments' symbolic types, in source order.
        /// @param argumentNames The per-source-index argument names; null entries are positional.
        /// @returns Per SOURCE argument position, the type to convert that argument to, or
        /// `null` to leave it alone; `default` when no
        /// repair applies at all. Source-indexed rather than parameter-indexed so
        /// the caller can apply it directly to its own argument list, whatever
        /// order the author wrote the arguments in.
        func FindUserDefinedConversionRepairTargets(
            candidates IReadOnlyList[MethodInfo]?,
            clrType Type?,
            receiverType TypeSymbol?,
            argumentTypes IReadOnlyList[TypeSymbol?]?,
            argumentNames IReadOnlyList[string?]? = nil
        ) ImmutableArray[TypeSymbol?] {
            // An abstract member of a NON-GENERIC interface: the widening member
            // whose presence is the whole reason this repair is needed. Same
            // predicate as ExcludeUnreachableNonGenericInterfaceCandidates.
            let IsWidening = func (candidate MethodInfo) bool {
                return candidate is {IsAbstract: true, DeclaringType: {IsInterface: true, IsGenericType: false}}
            }
            if candidates == nil ||
                candidates.Count == 0 ||
                clrType == nil ||
                clrType.IsInterface ||
                argumentTypes == nil ||
                argumentTypes.Count == 0 {
                return default(ImmutableArray[TypeSymbol?])
            }
            var hasWideningInterfaceCandidate = false
            for candidate in candidates {
                if IsWidening(candidate) {
                    hasWideningInterfaceCandidate = true
                    break
                }
            }
            if !hasWideningInterfaceCandidate {
                return default(ImmutableArray[TypeSymbol?])
            }
            // An erased receiver's own members are surrogates; judge nothing.
            if receiverType != nil && TypeSymbol.ContainsSameCompilationUserType(receiverType) {
                return default(ImmutableArray[TypeSymbol?])
            }
            for argumentType in argumentTypes {
                if argumentType == nil {
                    return default(ImmutableArray[TypeSymbol?])
                }
            }
            // Collect the DISTINCT parameter-type vectors of the receiver's own
            // non-widening surface that accept this call, where at least one
            // position needs a user-defined implicit conversion to do so.
            let name = candidates[0].Name
            var agreedVector[]?TypeSymbol? = nil
            for own in SafeGetMethodsIncludingSelfAndInterfaces(clrType, name) {
                if IsWidening(own) {
                    continue
                }
                let parameters = own.GetParameters()
                if parameters.Length != argumentTypes.Count {
                    continue
                }
                // Issue #4036 (review finding): same source-order/declaration-order
                // reconciliation as the candidacy filter above. Without it
                // `Add(value: someCelsius, key: "a")` would look for a conversion
                // from `Celsius` to `key: string`, find none, and decline to repair
                // a call that only needed its SECOND parameter converted.
                if !TryMapSourceArgumentsToParameters(own, argumentTypes.Count, argumentNames, out var ownMapping) {
                    continue
                }
                let vector = [parameters.Length]TypeSymbol?
                var accepts = true
                var needsUserDefined = false
                for var i = 0; i < parameters.Length; i++ {
                    let argumentType TypeSymbol? = argumentTypes[i]
                    let parameterSymbol TypeSymbol? = ClrNullability.GetParameterTypeSymbol(
                        parameters[ownMapping?[i] ?? i]
                    )
                    if argumentType == nil || parameterSymbol == nil {
                        accepts = false
                        break
                    }
                    if Conversion.Classify(argumentType, parameterSymbol).Exists {
                        continue
                    }
                    if !ConversionClassifier.HasUserDefinedImplicitConversionForTypes(argumentType, parameterSymbol) {
                        accepts = false
                        break
                    }
                    vector[i] = parameterSymbol
                    needsUserDefined = true
                }
                if !accepts || !needsUserDefined {
                    continue
                }
                if agreedVector == nil {
                    agreedVector = vector
                    continue
                }
                for var i = 0; i < vector.Length; i++ {
                    if !object.Equals(agreedVector!![i], vector[i]) {
                        // Two own members disagree about what to convert to. That
                        // is a genuine ambiguity, not an erasure to repair.
                        return default(ImmutableArray[TypeSymbol?])
                    }
                }
            }
            return if agreedVector == nil {
                default(ImmutableArray[TypeSymbol?])
            } else {
                ImmutableArray.Create(agreedVector)
            }
        }

        /// Issue #2494: removes imported method candidates that are applicable only
        /// because a same-compilation enum was projected to its temporary CLR
        /// `int32` representation. The projection is a lookup aid; it is not a
        /// source-language enum-to-integer conversion. Open generic parameter
        /// positions remain eligible so the existing symbolic substitution path can
        /// recover the enum identity for the selected method and its return type.
        /// @param candidates The imported candidates to filter.
        /// @param symbolicArgTypes Symbolic argument types in candidate parameter order.
        /// @param argumentNames Optional source argument names aligned with [`symbolicArgTypes`](paramref).
        /// @param symbolicReceiverType The symbolic instance receiver, used to reopen an erased constructed
        /// declaring type.
        /// @returns Candidates that do not require an enum-erasure-only match.
        func ExcludeErasureOnlyEnumCandidates(
            candidates IEnumerable[MethodInfo]?,
            symbolicArgTypes ImmutableArray[TypeSymbol],
            argumentNames IReadOnlyList[string?]? = nil,
            symbolicReceiverType TypeSymbol? = nil
        ) IEnumerable[MethodInfo] {
            let TryGetNullableTypeArgument = func (type Type?, out argument Type?) bool {
                argument = nil
                if type == nil || !type.IsGenericType {
                    return false
                }
                var definition Type
                try {
                    definition = type.GetGenericTypeDefinition()
                } catch {
                    return false
                }
                if !string.Equals(definition.FullName, typeof(Nullable[_]).FullName, StringComparison.Ordinal) {
                    return false
                }
                argument = type.GetGenericArguments()[0]
                return true
            }
            let IsErasureOnlyEnumMatch = func (openParameterType Type?, symbolicArgumentType TypeSymbol?) bool {
                var openParameterType = openParameterType
                var symbolicArgumentType = symbolicArgumentType
                if openParameterType == nil || symbolicArgumentType == nil {
                    return false
                }
                if openParameterType.IsByRef {
                    openParameterType = openParameterType.GetElementType()
                }
                if symbolicArgumentType is ByRefTypeSymbol byRefArgument {
                    symbolicArgumentType = byRefArgument.PointeeType
                }
                // A generic slot captures the symbolic enum and is repaired downstream
                // by BuildSymbolicMethodTypeArgs/ResolveCallReturnTypeFromSymbolicTypeArgs.
                if openParameterType == nil || openParameterType.IsGenericParameter {
                    return false
                }
                if symbolicArgumentType is EnumSymbol {
                    return string.Equals(openParameterType.FullName, typeof(int32).FullName, StringComparison.Ordinal)
                }
                if symbolicArgumentType is NullableTypeSymbol nullable {
                    if TryGetNullableTypeArgument(openParameterType, out var nullableParameter) {
                        return IsErasureOnlyEnumMatch(nullableParameter, nullable.UnderlyingType)
                    }
                    // Reference-type nullability is an annotation, not a distinct
                    // CLR generic wrapper. Continue matching the underlying symbolic
                    // shape against the same formal parameter.
                    return IsErasureOnlyEnumMatch(openParameterType, nullable.UnderlyingType)
                }
                if symbolicArgumentType is FunctionTypeSymbol functionType {
                    var invoke MethodInfo?
                    try {
                        invoke = openParameterType.GetMethod("Invoke")
                    } catch {
                        return false
                    }
                    if invoke == nil {
                        return false
                    }
                    let invokeParameters = invoke.GetParameters()
                    let parameterCount = Math.Min(invokeParameters.Length, functionType.ParameterTypes.Length)
                    for var i = 0; i < parameterCount; i++ {
                        if IsErasureOnlyEnumMatch(invokeParameters[i].ParameterType, functionType.ParameterTypes[i]) {
                            return true
                        }
                    }
                    return !FunctionTypeSymbol.IsVoidReturn(functionType.ReturnType) &&
                        IsErasureOnlyEnumMatch(invoke.ReturnType, functionType.ReturnType)
                }
                if symbolicArgumentType is TupleTypeSymbol tuple && openParameterType.IsGenericType {
                    let tupleDefinition = openParameterType.GetGenericTypeDefinition()
                    let tupleArguments = openParameterType.GetGenericArguments()
                    if tupleDefinition.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true &&
                        tupleArguments.Length == tuple
                        .ElementTypes
                        .Length {
                        for var i = 0; i < tupleArguments.Length; i++ {
                            if IsErasureOnlyEnumMatch(tupleArguments[i], tuple.ElementTypes[i]) {
                                return true
                            }
                        }
                        return false
                    }
                }
                if openParameterType.IsArray && openParameterType.GetArrayRank() == 1 {
                    let symbolicElement TypeSymbol? = TryGetElementType(symbolicArgumentType!!)
                    return symbolicElement != nil &&
                        IsErasureOnlyEnumMatch(openParameterType.GetElementType(), symbolicElement)
                }
                if openParameterType.IsArray && openParameterType.GetArrayRank() > 1 &&
                    symbolicArgumentType is RectangularArrayTypeSymbol rectangular &&
                    rectangular.Rank == openParameterType
                    .GetArrayRank() {
                    return IsErasureOnlyEnumMatch(openParameterType.GetElementType(), rectangular.ElementType)
                }
                if openParameterType.IsGenericType {
                    let openArguments = openParameterType.GetGenericArguments()
                    if symbolicArgumentType is ImportedTypeSymbol implemented &&
                        TryMapThroughImplemented(
                        implemented,
                        openParameterType.GetGenericTypeDefinition(),
                        out var liftedArguments
                    ) &&
                        liftedArguments.Length == openArguments
                        .Length {
                        for var i = 0; i < openArguments.Length; i++ {
                            if IsErasureOnlyEnumMatch(openArguments[i], liftedArguments[i]) {
                                return true
                            }
                        }
                        return false
                    }
                    if openArguments.Length == 1 {
                        let symbolicElement TypeSymbol? = TryGetElementType(symbolicArgumentType!!)
                        if symbolicElement != nil {
                            return IsErasureOnlyEnumMatch(openArguments[0], symbolicElement)
                        }
                    }
                    if symbolicArgumentType is ImportedTypeSymbol imported &&
                        !imported
                        .TypeArguments
                        .IsDefaultOrEmpty &&
                        imported
                        .TypeArguments
                        .Length == openArguments
                        .Length {
                        for var i = 0; i < openArguments.Length; i++ {
                            if IsErasureOnlyEnumMatch(openArguments[i], imported.TypeArguments[i]) {
                                return true
                            }
                        }
                    }
                }
                return false
            }
            let HasErasureOnlyEnumParameterMatch = func (
                candidate MethodInfo?,
                symbolicArgTypes ImmutableArray[TypeSymbol],
                argumentNames IReadOnlyList[string?]?,
                symbolicReceiverType TypeSymbol?
            ) bool {
                if candidate == nil {
                    return false
                }
                var openCandidate = if candidate.IsGenericMethod && !candidate.IsGenericMethodDefinition {
                    candidate.GetGenericMethodDefinition()
                } else {
                    candidate
                }
                let declaringType Type? = openCandidate.DeclaringType
                if declaringType?.IsConstructedGenericType == true &&
                    symbolicReceiverType is ImportedTypeSymbol symbolicReceiver &&
                    symbolicReceiver.OpenDefinition != nil {
                    let declaringDefinition = declaringType!!.GetGenericTypeDefinition()
                    var receiverCarriesSymbolicType = ClrTypeUtilities.AreSame(
                        symbolicReceiver.OpenDefinition,
                        declaringDefinition
                    ) &&
                        TypeSymbol.ContainsSameCompilationUserType(symbolicReceiverType)
                    if !receiverCarriesSymbolicType &&
                        TryMapThroughImplemented(
                        symbolicReceiver,
                        declaringDefinition,
                        out var liftedReceiverArguments
                    ) {
                        receiverCarriesSymbolicType = liftedReceiverArguments.Any(
                            TypeSymbol.ContainsSameCompilationUserType
                        )
                    }
                    if receiverCarriesSymbolicType {
                        let reopened MethodInfo? = TryGetOpenMethodOnDeclaringType(declaringDefinition, openCandidate)
                        if reopened != nil {
                            openCandidate = reopened
                        }
                    }
                }
                var parameters[]ParameterInfo
                try {
                    parameters = openCandidate.GetParameters()
                } catch {
                    return false
                }
                let hasParams = parameters.Length > 0 && ClrOverloadResolution.IsParamsArrayParameter(
                    parameters[parameters.Length - 1]
                )
                var nextPositionalParameter = 0
                for var i = 0; i < symbolicArgTypes.Length; i++ {
                    let argumentName = if argumentNames != nil && i < argumentNames.Count {
                        argumentNames[i]
                    } else {
                        default(string?)
                    }
                    var parameterIndex = -1
                    if !string.IsNullOrEmpty(argumentName) {
                        for var p = 0; p < parameters.Length; p++ {
                            if string.Equals(parameters[p].Name, argumentName, StringComparison.Ordinal) {
                                parameterIndex = p
                                break
                            }
                        }
                    } else if nextPositionalParameter < parameters.Length {
                        parameterIndex = nextPositionalParameter
                        nextPositionalParameter++
                    } else if hasParams {
                        parameterIndex = parameters.Length - 1
                    }
                    if parameterIndex < 0 || parameterIndex >= parameters.Length {
                        continue
                    }
                    var parameterType = parameters[parameterIndex].ParameterType
                    if hasParams && parameterIndex == parameters.Length - 1 && string.IsNullOrEmpty(argumentName) &&
                        parameterType.IsArray &&
                        !(symbolicArgTypes[i] is SliceTypeSymbol) &&
                        !(symbolicArgTypes[i] is ArrayTypeSymbol) {
                        parameterType = parameterType.GetElementType()!!
                        nextPositionalParameter = parameterIndex
                    }
                    if IsErasureOnlyEnumMatch(parameterType, symbolicArgTypes[i]) {
                        return true
                    }
                }
                return false
            }
            if candidates == nil || symbolicArgTypes.IsDefaultOrEmpty {
                return candidates ?? Enumerable.Empty[MethodInfo]()
            }
            let filtered = List[MethodInfo]()
            for candidate in candidates {
                if !HasErasureOnlyEnumParameterMatch(candidate, symbolicArgTypes, argumentNames, symbolicReceiverType) {
                    filtered.Add(candidate)
                }
            }
            return filtered
        }

        /// Issue #833: projects a (cref:TypeSymbol) that may contain
        /// open type/method parameters to a CLR (cref:System.Type)
        /// using `object` as the erasure placeholder. This lets
        /// overload resolution match the open generic candidate (the real
        /// symbolic substitution is recovered downstream via
        /// `BuildSymbolicMethodTypeArgs` +
        /// (cref:ResolveCallReturnTypeFromSymbolicTypeArgs)).
        /// @param t The argument's bound type.
        /// @param erased On success, an erased CLR projection.
        /// @returns `true` when an erasure projection exists.
        func TryProjectErasedClrType(t TypeSymbol?, @NotNullWhen(true) out erased Type?) bool {
            erased = nil
            if t == nil {
                return false
            }
            // Issue #4444, ADR-0186 §1: `T!` has `T`'s signature, so it erases
            // exactly as `T` does. Over a G#-declared type the wrapper's ClrType is
            // null, and no arm below matched it, so the projection failed and the
            // imported call it gated (`Enumerable.Repeat(n, 2)` with `n Node!`)
            // reported GS0159.
            if t is PlatformTypeSymbol platform {
                return TryProjectErasedClrType(platform.UnderlyingType, out erased)
            }
            if t is ImportedTypeSymbol imported {
                let openDefinition Type? = imported.OpenDefinition
                if openDefinition != nil && !imported.TypeArguments.IsDefaultOrEmpty {
                    let contextObject = ResolveErasedObjectInContext(openDefinition)
                    erased = TryBuildErasedClosedGeneric(
                        openDefinition,
                        openDefinition.GetGenericArguments(),
                        imported.TypeArguments,
                        contextObject
                    )
                    if erased != nil {
                        return true
                    }
                }
            }
            if t.ClrType != nil {
                erased = t.ClrType
                return true
            }
            if t == TypeSymbol.Null {
                // A nil literal nested inside a symbolic tuple/array has no CLR
                // type of its own. Erase it to object for overload gating; the
                // symbolic target conversion still decides whether nil is legal.
                erased = typeof(object)
                return true
            }
            switch t {
                case TypeParameterSymbol {
                    erased = typeof(object)
                    return true
                }
                case slice is SliceTypeSymbol {
                    if TryProjectErasedClrType(slice.ElementType, out var sliceElement) && sliceElement != nil {
                        erased = sliceElement.MakeArrayType()
                        return true
                    }
                    return false
                }
                case channel is ChannelTypeSymbol {
                    // ADR-0174 D2: chan[T] / in chan[T] / out chan[T] over a symbolic
                    // element erases to Channel<erased T> / ChannelReader<…> / ChannelWriter<…>.
                    if TryProjectErasedClrType(channel.ElementType, out var channelElement) && channelElement != nil {
                        erased = ChannelTypeSymbol.OpenClrDefinition(channel.Direction).MakeGenericType(channelElement)
                        return true
                    }
                    return false
                }
                case array is ArrayTypeSymbol {
                    if TryProjectErasedClrType(array.ElementType, out var arrayElement) && arrayElement != nil {
                        erased = arrayElement.MakeArrayType()
                        return true
                    }
                    return false
                }
                case array is RectangularArrayTypeSymbol {
                    if TryProjectErasedClrType(array.ElementType, out var rectangularElement) &&
                        rectangularElement != nil {
                        erased = rectangularElement.MakeArrayType(array.Rank)
                        return true
                    }
                    return false
                }
                case map_ is MapTypeSymbol {
                    // Issue #3303: a `map[K, V]` whose key or value structurally
                    // references an open type parameter (e.g. the `map[K, V]`
                    // field of a generic class) or a same-compilation user type
                    // has a null ClrType, so the ClrType gate above missed it.
                    // Its runtime backing is still `Dictionary<K, V>` — erase the
                    // key/value (type parameter → `object`, mirroring the slice
                    // and sequence cases) and re-form the closed dictionary so
                    // overload resolution can rank `object`-shaped parameters as
                    // applicable (`Console.WriteLine(items)` previously
                    // dead-ended with GS0159 while the monomorphic map bound
                    // fine). Symbolic recovery downstream re-derives the real
                    // key/value types when a generic candidate is chosen.
                    if TryProjectErasedClrType(map_.KeyType, out var mapKeyErased) &&
                        TryProjectErasedClrType(map_.ValueType, out var mapValueErased) &&
                        mapKeyErased != nil &&
                        mapValueErased != nil &&
                        !mapKeyErased.IsByRef &&
                        !mapKeyErased.IsPointer &&
                        !mapValueErased.IsByRef &&
                        !mapValueErased
                        .IsPointer {
                        try {
                            // Issue #4023: the erasure exists to be REFLECTED on,
                            // and the host `typeof(Dictionary<,>)` cannot produce a
                            // reflectable one when an argument came from the
                            // compilation's MetadataLoadContext — which the arm
                            // above produces for a same-compilation
                            // `class Derived : ImportedBase`, erased to its
                            // imported base. Mixing contexts yields a
                            // `TypeBuilderInstantiation`, whose members all throw,
                            // and the map lost its whole BCL surface. Build it
                            // inside the argument's OWN context first, the same way
                            // `ResolveErasedObjectInContext` keeps `object` in the
                            // open definition's context two arms up.
                            //
                            // The host construction stays as the FALLBACK, for when
                            // no projector is registered for the argument's
                            // assembly or the projection is refused. It is not dead:
                            // #4016's `map[Derived, string]` passed on 565b9a04
                            // with exactly that host `TypeBuilderInstantiation`,
                            // because overload gating needs only the erasure's
                            // SHAPE. Measured, #4016 now takes the upgraded path
                            // (its `ImportedBase` carrier IS a registered reference
                            // assembly) and passes there too — but an earlier draft
                            // that collapsed a non-host argument to `object`
                            // instead of re-contexting it destroyed that shape and
                            // turned both of #4016's derived-class rows into
                            // GS0159. Upgrade the erasure; never flatten it.
                            if !mapKeyErased.IsRuntimeProvidedType() || !mapValueErased.IsRuntimeProvidedType() {
                                let inContext Type? = MapTypeSymbol.TryMakeErasedClrTypeInReferenceContext(
                                    mapKeyErased,
                                    mapValueErased
                                )
                                if inContext != nil {
                                    erased = inContext
                                    return true
                                }
                            }
                            erased = typeof(System.Collections.Generic.Dictionary[_, _]).MakeGenericType(
                                mapKeyErased,
                                mapValueErased
                            )
                            return true
                        } catch {
                            return false
                        }
                    }
                    return false
                }
                case byRef is ByRefTypeSymbol {
                    if TryProjectErasedClrType(byRef.PointeeType, out var byRefPointee) &&
                        byRefPointee != nil &&
                        !byRefPointee.IsByRef {
                        erased = byRefPointee.MakeByRefType()
                        return true
                    }
                    return false
                }
                case pointer is PointerTypeSymbol {
                    // Issue #2838: `*T` under `T : unmanaged` — canonically the
                    // pointer bound by `fixed p *T = span` — has a null ClrType
                    // because its pointee is an open type parameter. Without this
                    // case the argument produced no erased CLR type at all, so
                    // `TryLookupFunction` bailed out before overload resolution ran
                    // and an imported generic call over the pointer (e.g.
                    // `Vector256.Load(p)`) dead-ended with GS0159. Erase the pointee
                    // and re-form the pointer so the candidate's `!!0*` parameter can
                    // unify; symbolic recovery downstream re-derives the real type
                    // argument for the MethodSpec.
                    if TryProjectErasedClrType(pointer.PointeeType, out var pointeeErased) &&
                        pointeeErased != nil &&
                        !pointeeErased.IsByRef {
                        erased = pointeeErased.MakePointerType()
                        return true
                    }
                    return false
                }
                case seq is SequenceTypeSymbol {
                    // Issue #1320: `sequence[T]` (an iterator return, alias for
                    // `IEnumerable<T>`) over a same-compilation user element type has
                    // a null ClrType during binding. Erase the element so the
                    // constructed enumerable still passes the ClrType gate; the
                    // symbolic-argument recovery downstream re-derives the real
                    // element type for the member's return projection.
                    if TryProjectErasedClrType(seq.ElementType, out var seqElement) && seqElement != nil {
                        erased = typeof(System.Collections.Generic.IEnumerable[_]).MakeGenericType(seqElement)
                        return true
                    }
                    return false
                }
                case aseq is AsyncSequenceTypeSymbol {
                    // Issue #1320: the async-iterator counterpart, alias for
                    // `IAsyncEnumerable<T>`.
                    if TryProjectErasedClrType(aseq.ElementType, out var aseqElement) && aseqElement != nil {
                        erased = typeof(System.Collections.Generic.IAsyncEnumerable[_]).MakeGenericType(aseqElement)
                        return true
                    }
                    return false
                }
                case nullable is NullableTypeSymbol when nullable.UnderlyingType != nil {
                    if !TryProjectErasedClrType(nullable.UnderlyingType, out var erasedUnderlying) {
                        return false
                    }
                    if erasedUnderlying == nil {
                        return false
                    }
                    if !erasedUnderlying.IsValueType || Nullable.GetUnderlyingType(erasedUnderlying) != nil {
                        erased = erasedUnderlying
                        return true
                    }
                    try {
                        let nullableDefinition = if erasedUnderlying.Assembly == typeof(object).Assembly {
                            typeof(Nullable[_])
                        } else {
                            erasedUnderlying.Assembly.GetType(
                                typeof(Nullable[_]).FullName ?? "System.Nullable`1",
                                throwOnError: false
                            )
                        }
                        erased = nullableDefinition?.MakeGenericType(erasedUnderlying) ?? erasedUnderlying
                        return true
                    } catch {
                        erased = erasedUnderlying
                        return true
                    }
                }
                case fn is FunctionTypeSymbol {
                    // Issue #932: a func/arrow literal whose natural delegate type
                    // closes over a same-compilation user class (whose ClrType is
                    // still null during binding) has a null FunctionType.ClrType, so
                    // overload resolution would otherwise reject every candidate
                    // (GS0159) before even classifying the delegate parameter — e.g.
                    // `Assert.DoesNotContain(items, func(i LibraryItem) bool { ... })`
                    // where `items : List[LibraryItem]`. Erase the literal's natural
                    // Func<...>/Action<...> shape, mapping each symbolic component the
                    // same way the generic-argument erasure does (user class → its
                    // imported base or `object`, enum → int32), so the produced
                    // delegate's parameter/return types line up with the inferred
                    // (erased) element type and the structural delegate conversion
                    // applies.
                    return TryProjectErasedDelegateClrType(fn, out erased)
                }
                case StructSymbol{IsClass: true} userClass {
                    // Issue #1162: a slice/array element that is a same-compilation
                    // user type has a null ClrType during binding, so projecting
                    // `[]Segment` previously failed at the element and aborted the
                    // whole slice projection — blocking IEnumerable<T> extension
                    // (LINQ) candidate gating with GS0159. Erase user types just
                    // enough to pass the ClrType gate (mirroring the delegate-
                    // component eraser); the symbolic-argument recovery downstream
                    // re-derives the real element type for inference.
                    erased = userClass.ImportedBaseType?.ClrType ?? typeof(object)
                    return true
                }
                case InterfaceSymbol {
                    erased = typeof(object)
                    return true
                }
                case tuple is TupleTypeSymbol {
                    // Issue #1902: a query's transparent-identifier tuple
                    // (`(x1, x2)`) carrying a same-compilation user element (e.g. a
                    // `data class` range variable) has a null ClrType — same root
                    // cause as the slice/array case above, `TupleTypeSymbol.
                    // BuildClrType` refuses to build `ValueTuple<...>` when any
                    // element's ClrType is null. Left unhandled, a LINQ method
                    // taking or returning such a tuple (`Select`, `Join`,
                    // `GroupJoin`, …) had no ClrType to gate on and fell through to
                    // GS0159 "Cannot find function" even though the same tuple
                    // shape with only built-in element types (e.g. `(int32,
                    // int32)`) resolved fine. Erase each element (recursively, so a
                    // nested tuple/array/user-type element still projects) and
                    // rebuild the closed `ValueTuple<...>` shape from the erased
                    // elements; symbolic-argument recovery downstream re-derives
                    // the real element types for inference same as the other
                    // erasure cases.
                    {
                        let elementTypes = tuple.ElementTypes
                        let erasedElements = [elementTypes.Length]Type
                        for var i = 0; i < elementTypes.Length; i++ {
                            if !TryProjectErasedClrType(elementTypes[i], out var erasedElement) ||
                                erasedElement == nil {
                                return false
                            }
                            erasedElements[i] = erasedElement
                        }
                        erased = TupleTypeSymbol.BuildClrType(erasedElements)
                        return erased != nil
                    }
                }
                case StructSymbol {
                    erased = typeof(object)
                    return true
                }
                case EnumSymbol {
                    erased = typeof(int32)
                    return true
                }
                default {
                    return false
                }
            }
        }

        /// Issue #3311: normalizes a `map[K, V]` receiver whose
        /// (cref:TypeSymbol.ClrType) is `null` (K or V is
        /// an in-scope type parameter — null by construction — or a
        /// same-compilation user class) to the symbolic constructed
        /// (cref:ImportedTypeSymbol) view an explicitly-typed
        /// `Dictionary[K, V]` receiver already carries (#313/#794/#1107):
        /// the type-erased closed `Dictionary<…>` shape drives
        /// reflection member lookup, while the symbolic `[K, V]` arguments
        /// drive return / parameter / out-var re-projection
        /// ((cref:MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol})))
        /// and symbolic MemberRef parenting at emit
        /// (`ImportedMemberRefFactory.TryNormalizeToSymbolicContainer`).
        /// Concrete maps (loadable ClrType) are left on the existing reflection
        /// fast path. Returns `false` when no normalization
        /// applies.
        /// @param receiverType The receiver's static type symbol.
        /// @param view The symbolic Dictionary view, on success.
        /// @returns `true` when a symbolic view was produced.
        func TryGetSymbolicOpenMapReceiverView(
            receiverType TypeSymbol?,
            @NotNullWhen(true) out view ImportedTypeSymbol?
        ) bool {
            view = nil
            if receiverType is not MapTypeSymbol map_ ||
                map_.ClrType != nil ||
                !TryProjectErasedClrType(map_, out var erasedMap) {
                return false
            }
            view = ImportedTypeSymbol.GetConstructed(
                erasedMap,
                typeof(System.Collections.Generic.Dictionary[_, _]),
                ImmutableArray.Create(map_.KeyType, map_.ValueType)
            )
            return true
        }

        /// ADR-0174 D12: the channel twin of (cref:TryGetSymbolicOpenMapReceiverView).
        /// A `chan[T]` / `in chan[T]` / `out chan[T]` over a
        /// same-compilation or type-parameter element has no loadable CLR type;
        /// surface the symbolic constructed `Channel[T]` /
        /// `ChannelReader[T]` / `ChannelWriter[T]` view so the BCL member
        /// surface and the `Close()` extension bind exactly as on a CLR-backed
        /// element. Concrete channels stay on the reflection fast path.
        /// @param receiverType The receiver's static type symbol.
        /// @param view The symbolic channel view, on success.
        /// @returns `true` when a symbolic view was produced.
        func TryGetSymbolicOpenChannelReceiverView(
            receiverType TypeSymbol?,
            @NotNullWhen(true) out view ImportedTypeSymbol?
        ) bool {
            view = nil
            if receiverType is not ChannelTypeSymbol{ClrType: nil} channel {
                return false
            }
            let open_ = ChannelTypeSymbol.OpenClrDefinition(channel.Direction)
            view = ImportedTypeSymbol.GetConstructed(
                open_.MakeGenericType(typeof(object)),
                open_,
                ImmutableArray.Create(channel.ElementType)
            )
            return true
        }

        /// Normalizes any magic-collection receiver without a loadable CLR type to
        /// its symbolic constructed BCL view (open maps, issue #3311; channels,
        /// ADR-0174 D12).
        /// @param receiverType The receiver's static type symbol.
        /// @param view The symbolic view, on success.
        /// @returns `true` when a symbolic view was produced.
        func TryGetSymbolicOpenReceiverView(
            receiverType TypeSymbol?,
            @NotNullWhen(true) out view ImportedTypeSymbol?
        ) bool -> TryGetSymbolicOpenMapReceiverView(receiverType, out view) ||
            TryGetSymbolicOpenChannelReceiverView(receiverType, out view)

        /// Probes a user-defined (cref:StructSymbol) for the
        /// duck-typed enumerable shape (`GetEnumerator() → MoveNext() / Current`).
        /// @remarks The returned enumerator can be source-declared or imported.
        /// @param type The user struct symbol to probe.
        /// @param elementType The element (cref:TypeSymbol), on success.
        /// @returns `true` when the duck-typed shape matches.
        func TryGetUserPatternEnumerableElementType(type StructSymbol, out elementType TypeSymbol?) bool {
            elementType = nil
            if !TypeMemberModel.TryGetMethodIncludingInherited(type, "GetEnumerator", out var getEnumerator) ||
                getEnumerator!!
                .Parameters
                .Length != 0 ||
                getEnumerator!!.Type == nil {
                return false
            }
            // ADR-0186 §9: a GetEnumerator declared in an oblivious scope returns
            // a platform enumerator (`IEnumerator[Item]!`); its shape — and so the
            // element type — is the underlying enumerator's.
            var effectiveEnumeratorType TypeSymbol? = type.SubstituteMemberType(getEnumerator!!.Type)
            if effectiveEnumeratorType != nil {
                effectiveEnumeratorType = PlatformTypeSymbol.StripTopLevel(effectiveEnumeratorType)
            }
            if effectiveEnumeratorType is StructSymbol enumeratorType {
                if TypeMemberModel.TryGetMethodIncludingInherited(enumeratorType, "MoveNext", out var moveNext) &&
                    moveNext!!
                    .Parameters
                    .Length == 0 &&
                    moveNext!!.Type == TypeSymbol.Bool &&
                    TryGetUserEnumeratorCurrent(enumeratorType, out _, out elementType) {
                    return true
                }
                return false
            }
            return effectiveEnumeratorType != nil &&
                TryGetClrEnumeratorElementType(effectiveEnumeratorType, out elementType)
        }

        /// Resolves the readable instance `Current` member shared by pattern binding and lowering.
        /// @param type The source enumerator type.
        /// @param current The selected field or property.
        /// @param elementType The construction-substituted element type.
        /// @returns Whether the enumerator exposes a public readable `Current`.
        func TryGetUserEnumeratorCurrent(type StructSymbol, out current Symbol?, out elementType TypeSymbol?) bool {
            current = nil
            elementType = nil
            for owner in type.GetHierarchy() {
                if owner.TryGetField("Current", out var field) {
                    current = field
                    if field!!.Accessibility != Accessibility.Public {
                        return false
                    }
                    elementType = field!!.Type
                    return true
                }
                for property in owner.Properties {
                    if property.Name != "Current" ||
                        property.IsStatic ||
                        property.IsIndexer ||
                        property.HasExplicitInterfaceClause ||
                        property.ExplicitInterfaceClauseTarget != nil {
                        continue
                    }
                    current = property
                    if !property.HasGetter || property.GetterAccessibility != Accessibility.Public {
                        return false
                    }
                    elementType = property.Type
                    return true
                }
            }
            return false
        }

        /// Issue #889: resolves the (cref:FunctionTypeSymbol) shape of any
        /// delegate-like target type — a native G# function type, a user-declared
        /// named delegate ((cref:DelegateTypeSymbol)), or an imported CLR
        /// delegate (`System.Action`/`System.Func`/named delegates).
        /// Used to target-type lambda/func literals against delegate parameters
        /// and variable slots.
        /// @param type The candidate delegate-like target type.
        /// @param functionType The matching function-type symbol, on success.
        /// @returns `true` when the type is delegate-like.
        func TryGetDelegateFunctionTypeFromSymbol(
            type TypeSymbol,
            @NotNullWhen(true) out functionType FunctionTypeSymbol?
        ) bool {
            functionType = nil
            switch type {
                case nil {
                    return false
                }
                case fn is FunctionTypeSymbol {
                    functionType = fn
                    return true
                }
                case del is DelegateTypeSymbol {
                    functionType = del.EquivalentFunctionType
                    return functionType != nil
                }
                case nullable is NullableTypeSymbol {
                    return TryGetDelegateFunctionTypeFromSymbol(nullable.UnderlyingType, out functionType)
                }
                case platform is PlatformTypeSymbol {
                    return TryGetDelegateFunctionTypeFromSymbol(platform.UnderlyingType, out functionType)
                }
                case imported is ImportedTypeSymbol when imported.OpenDefinition != nil &&
                    !imported
                    .TypeArguments
                    .IsDefaultOrEmpty &&
                    TryGetDelegateFunctionTypeFromOpenDefinition(
                    imported.OpenDefinition,
                    imported.TypeArguments,
                    out functionType
                ) {
                    return true
                }
                default {
                    return type.ClrType != nil && TryGetDelegateFunctionType(type.ClrType, out functionType)
                }
            }
        }

        /// Reifies a structural function type as an expected named delegate when
        /// their complete signatures are identical. The direction is deliberate:
        /// two named delegates never become equivalent merely because their
        /// `Invoke` methods have the same shape.
        /// @param actual The source structural function type.
        /// @param expected The expected named delegate type.
        /// @param canonical The expected delegate on success; otherwise the source type.
        /// @returns `true` when the structural signature exactly matches the delegate.
        func TryCanonicalizeStructuralFunctionType(
            actual TypeSymbol,
            expected TypeSymbol,
            out canonical TypeSymbol
        ) bool {
            var FunctionShapesExactlyMatch((FunctionTypeSymbol, FunctionTypeSymbol) -> bool)? = nil
            var FunctionComponentExactlyMatches((TypeSymbol, TypeSymbol) -> bool)? = nil
            FunctionShapesExactlyMatch = func (actual FunctionTypeSymbol, expected FunctionTypeSymbol) bool {
                if actual.Arity != expected.Arity || !actual.IsVariadic.SequenceEqual(expected.IsVariadic) ||
                    !FunctionComponentExactlyMatches!!(actual.ReturnType, expected.ReturnType) {
                    return false
                }
                for var i = 0; i < actual.Arity; i++ {
                    if !FunctionComponentExactlyMatches!!(actual.ParameterTypes[i], expected.ParameterTypes[i]) {
                        return false
                    }
                }
                return true
            }
            FunctionComponentExactlyMatches = func (actual TypeSymbol, expected TypeSymbol) bool {
                if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(actual, expected) {
                    return true
                }
                return actual is FunctionTypeSymbol actualFunction &&
                    !(expected is FunctionTypeSymbol) &&
                    TryGetDelegateFunctionTypeFromSymbol(expected, out var expectedFunction) &&
                    expectedFunction != nil &&
                    FunctionShapesExactlyMatch!!(actualFunction, expectedFunction)
            }
            canonical = actual
            if actual is not FunctionTypeSymbol actualFunction ||
                expected is FunctionTypeSymbol ||
                !TryGetDelegateFunctionTypeFromSymbol(expected, out var expectedFunction) ||
                expectedFunction == nil ||
                !FunctionShapesExactlyMatch(actualFunction, expectedFunction) {
                return false
            }
            canonical = expected
            return true
        }

        /// Reifies the conventional structural CLR event shape as
        /// (cref:EventHandler) or (cref:EventHandler{TEventArgs}).
        /// This is intentionally event-only: the same function shape in a method,
        /// field, or local remains an (cref:Action{T1,T2}).
        /// @param handlerType The declared event handler type.
        /// @returns The matching nominal event delegate, or [`handlerType`](paramref).
        func CanonicalizeWellKnownEventHandler(handlerType TypeSymbol) TypeSymbol {
            let IsEventArgsType = func (type TypeSymbol, clrType Type?) bool {
                if clrType != nil {
                    return ClrTypeUtilities.IsAssignableByName(typeof(EventArgs), clrType)
                }
                if type is TypeParameterSymbol{ClassConstraint: TypeSymbol classConstraint} {
                    return IsEventArgsType(classConstraint, NullableLifting.GetEffectiveClrType(classConstraint))
                }
                if type is not StructSymbol structType {
                    return false
                }
                for current in structType.GetHierarchy() {
                    let importedBaseClr Type? = NullableLifting.GetEffectiveClrType(current.ImportedBaseType)
                    if importedBaseClr != nil && ClrTypeUtilities.IsAssignableByName(
                        typeof(EventArgs),
                        importedBaseClr
                    ) {
                        return true
                    }
                }
                return false
            }
            if handlerType is not FunctionTypeSymbol function ||
                function.Arity != 2 ||
                function.HasVariadic ||
                !FunctionTypeSymbol.IsVoidReturn(function.ReturnType) {
                return handlerType
            }
            let senderType TypeSymbol? = switch function.ParameterTypes[0] {
                case nullable is NullableTypeSymbol: nullable.UnderlyingType
                case annotated is NullabilityAnnotatedTypeSymbol: annotated.BaseType
                default: default(TypeSymbol?)
            }
            if senderType == nil || !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                senderType,
                TypeSymbol.Object
            ) {
                return handlerType
            }
            let eventArgsType = function.ParameterTypes[1]
            let eventArgsClr Type? = NullableLifting.GetEffectiveClrType(eventArgsType)
            if !IsEventArgsType(eventArgsType, eventArgsClr) {
                return handlerType
            }
            if eventArgsClr != nil && string.Equals(
                eventArgsClr.FullName,
                typeof(EventArgs).FullName,
                StringComparison.Ordinal
            ) {
                return TypeSymbol.FromClrTypeWithoutNullability(typeof(EventHandler), NullabilityFreeReason.TypeLiteral)
            }
            let closedEventHandler = if eventArgsClr == nil {
                typeof(EventHandler[EventArgs])
            } else {
                typeof(EventHandler[_]).MakeGenericType(eventArgsClr)
            }
            return ImportedTypeSymbol.GetConstructed(
                closedEventHandler,
                typeof(EventHandler[_]),
                ImmutableArray.Create(eventArgsType)
            )
        }

        /// Issue #2130: resolves the effective lambda target shape for any target
        /// type that may consume a source lambda — a native function type, a
        /// delegate, or `System.Linq.Expressions.Expression<TDelegate>`.
        /// Returns the underlying delegate/function signature that should be used
        /// for target-typed lambda parameter/return binding.
        /// @param type The candidate lambda target type.
        /// @param functionType The effective function-type shape, on success.
        /// @returns `true` when [`type`](paramref) is a valid lambda target.
        func TryGetLambdaTargetFunctionTypeFromSymbol(
            type TypeSymbol,
            @NotNullWhen(true) out functionType FunctionTypeSymbol?
        ) bool {
            if TryGetDelegateFunctionTypeFromSymbol(type, out functionType) {
                return true
            }
            if !TryGetExpressionTreeDelegateTypeFromSymbol(type, out var delegateType) || delegateType == nil {
                functionType = nil
                return false
            }
            return TryGetDelegateFunctionTypeFromSymbol(delegateType, out functionType)
        }

        /// Issue #2130: resolves the effective lambda target shape for a CLR
        /// delegate or expression-tree type.
        /// @param type The candidate lambda target CLR type.
        /// @param functionType The effective function-type shape, on success.
        /// @returns `true` when [`type`](paramref) is a valid lambda target.
        func TryGetLambdaTargetFunctionType(type Type, @NotNullWhen(true) out functionType FunctionTypeSymbol?) bool {
            if TryGetDelegateFunctionType(type, out functionType) {
                return true
            }
            if !TryGetExpressionTreeDelegateType(type, out var delegateType) || delegateType == nil {
                functionType = nil
                return false
            }
            return TryGetDelegateFunctionType(delegateType, out functionType)
        }

        /// Issue #2130: returns the delegate type argument of a
        /// `System.Linq.Expressions.Expression<TDelegate>` target.
        /// @param type The candidate expression-tree target type.
        /// @param delegateType The delegate type argument, on success.
        /// @returns `true` when [`type`](paramref) is an expression-tree target.
        func TryGetExpressionTreeDelegateTypeFromSymbol(
            type TypeSymbol?,
            @NotNullWhen(true) out delegateType TypeSymbol?
        ) bool {
            delegateType = nil
            if type == nil {
                return false
            }
            if type is ImportedTypeSymbol imported && imported.OpenDefinition != nil && string.Equals(
                imported.OpenDefinition.FullName,
                "System.Linq.Expressions.Expression`1",
                StringComparison.Ordinal
            ) &&
                imported
                .TypeArguments
                .Length == 1 {
                delegateType = imported.TypeArguments[0]
                return true
            }
            if type.ClrType == nil || !TryGetExpressionTreeDelegateType(type.ClrType, out var delegateClrType) {
                return false
            }
            delegateType = TypeSymbol.FromClrTypeWithoutNullability(
                delegateClrType,
                NullabilityFreeReason.TypeStructure
            )
            return true
        }

        /// Issue #2130: returns the delegate type argument of a CLR
        /// `Expression<TDelegate>` target.
        /// @param type The candidate CLR expression-tree target type.
        /// @param delegateType The delegate type argument, on success.
        /// @returns `true` when [`type`](paramref) is an expression-tree target.
        func TryGetExpressionTreeDelegateType(type Type?, @NotNullWhen(true) out delegateType Type?) bool {
            delegateType = nil
            if type == nil || !type.IsGenericType {
                return false
            }
            let open_ = if type.IsGenericTypeDefinition {
                type
            } else {
                type.GetGenericTypeDefinition()
            }
            if !string.Equals(open_.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal) {
                return false
            }
            let args = type.GetGenericArguments()
            if args.Length != 1 {
                return false
            }
            delegateType = args[0]
            return true
        }

        /// Probes [`delegateType`](paramref) for the canonical delegate
        /// shape ((cref:System.MulticastDelegate)-derived, or
        /// `System.Func`N`/`System.Action`N`) and exposes the
        /// corresponding (cref:FunctionTypeSymbol).
        /// @param delegateType The candidate delegate CLR type.
        /// @param functionType The matching function-type symbol, on success.
        /// @returns `true` when the type is a delegate shape.
        func TryGetDelegateFunctionType(
            delegateType Type,
            @NotNullWhen(true) out functionType FunctionTypeSymbol?
        ) bool {
            functionType = nil
            if !ClrTypeUtilities.IsDelegateType(delegateType) && !string.Equals(
                delegateType?.BaseType?.FullName,
                "System.MulticastDelegate",
                StringComparison.Ordinal
            ) &&
                !(delegateType?.FullName?.StartsWith("System.Func`", StringComparison.Ordinal) == true) &&
                !(delegateType?.FullName?.StartsWith("System.Action`", StringComparison.Ordinal) == true) {
                return false
            }
            let invoke MethodInfo? = delegateType.GetMethodSafe("Invoke")
            if invoke == nil {
                return false
            }
            let parameters = invoke.GetParameters()
            let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](parameters.Length)
            let variadicBuilder = ImmutableArray.CreateBuilder[bool](parameters.Length)
            var anyVariadic = false
            for parameter in parameters {
                parameterTypes.Add(
                    if parameter.ParameterType.ContainsGenericParameters {
                        TypeSymbol.Object
                    } else {
                        ClrNullability.GetParameterTypeSymbol(parameter)
                    }
                )
                // ADR-0102 follow-up / issue #818: a delegate whose CLR Invoke
                // parameter carries [ParamArrayAttribute] is variadic from the
                // G# perspective too — the call-site pack / pass-through rules
                // mirror what direct method calls already do for params methods.
                let paramArray = HasParamArrayAttribute(parameter)
                variadicBuilder.Add(paramArray)
                anyVariadic |= paramArray
            }
            // Issue #3695: the return position must read its reference-type
            // nullability from metadata exactly as the parameter positions above
            // already do (ClrNullability.GetParameterTypeSymbol). Dropping it here
            // made a delegate whose C# signature returns `T?` (e.g.
            // `ResolveEventHandler`, whose Invoke returns `Assembly?`) present a
            // non-null `T` target return to lambda binding, so an arrow lambda
            // body's `return nil` was rejected with GS0155.
            var returnType = if invoke.ReturnType.IsSameAs(typeof(Void)) {
                TypeSymbol.Void
            } else {
                (
                    if invoke.ReturnType.ContainsGenericParameters {
                        TypeSymbol.Object
                    } else {
                        ClrNullability.GetReturnTypeSymbol(invoke)
                    }
                )
            }
            if returnType is ByRefTypeSymbol byRefReturn {
                returnType = byRefReturn.PointeeType
            }
            let variadicFlags = if anyVariadic {
                variadicBuilder.ToImmutable()
            } else {
                default(ImmutableArray[bool])
            }
            functionType = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), variadicFlags, returnType)
            return true
        }

        /// Collects the parameter-name set of every overload of
        /// [`methodName`](paramref) on [`receiverClrType`](paramref).
        /// Used to surface "did you mean X" diagnostics for unknown named
        /// arguments; this helper itself does not emit diagnostics.
        /// @param receiverClrType The receiver CLR type.
        /// @param methodName The method simple name.
        /// @param bindingFlags The binding flags to use for the
        /// reflection probe.
        /// @returns The union of parameter names across matching overloads.
        /// Empty when reflection failed.
        func CollectClrParameterNames(receiverClrType Type, methodName string, bindingFlags BindingFlags) HashSet[
            string
        ] {
            let names = HashSet[string](StringComparer.Ordinal)
            var methods[]MethodInfo
            try {
                methods = receiverClrType.GetMethods(bindingFlags)
            } catch {
                return names
            }
            for method in methods {
                if !ClrTypeUtilities.EmittedMemberNameMatches(method, methodName) {
                    continue
                }
                for parameter in method.GetParameters() {
                    if parameter.Name != nil {
                        names.Add(parameter.Name!!)
                    }
                }
            }
            return names
        }

        /// Collects the parameter-name set across every public instance
        /// constructor of [`clrType`](paramref). Used in the same way as
        /// (cref:CollectClrParameterNames), for constructor call sites.
        /// @param clrType The CLR type whose constructors to inspect.
        /// @returns The union of parameter names across matching constructors.
        /// Empty when reflection failed.
        func CollectClrConstructorParameterNames(clrType Type) HashSet[string] {
            let names = HashSet[string](StringComparer.Ordinal)
            var ctors[]ConstructorInfo
            try {
                ctors = ClrTypeUtilities.SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance)
            } catch {
                return names
            }
            for ctor in ctors {
                for parameter in ctor.GetParameters() {
                    if parameter.Name != nil {
                        names.Add(parameter.Name!!)
                    }
                }
            }
            return names
        }

        // ----- User-symbol member walks -----
        /// Finds the user method whose CLR-projected signature satisfies an
        /// imported interface slot.
        /// @param structSymbol The user struct symbol to inspect.
        /// @param clrMethod The imported interface slot.
        /// @returns The matching method, or `null`.
        func FindMatchingMethodForClrSignature(structSymbol StructSymbol, clrMethod MethodInfo) FunctionSymbol? {
            for candidate in structSymbol.GetMethodsIncludingInherited(clrMethod.Name) {
                if IsImplicitInterfaceImplementationCandidate(candidate) &&
                    MethodMatchesClrSignature(candidate, clrMethod) {
                    return candidate
                }
            }
            return nil
        }

        /// Determines whether one G# method matches an imported CLR method signature.
        /// @param candidate The candidate G# method.
        /// @param clrMethod The imported CLR method.
        /// @returns `true` when the signatures match.
        func MethodMatchesClrSignature(candidate FunctionSymbol, clrMethod MethodInfo) bool {
            if candidate.ReturnRefKind != RefCapabilities.GetReturnRefKind(clrMethod) {
                return false
            }
            // ReturnType.IsByRef guarantees a non-null reflected element type on that branch.
            let clrReturnType = if clrMethod.ReturnType.IsByRef {
                clrMethod.ReturnType.GetElementType()!!
            } else {
                clrMethod.ReturnType
            }
            let clrParams = clrMethod.GetParameters()
            // Issue #2230: an imported (metadata) interface method may itself be
            // generic (e.g. `ILogger.BeginScope<TState>(TState state)`). Those
            // method-own generic parameters need to be matched positionally
            // against the implementer's method type parameters — the same way
            // `TryBuildMethodTypeParameterMap` already does for source-declared
            // interfaces (issue #1007) — because an unbound G# type parameter
            // carries no `ClrType` and the plain `ClrTypeUtilities.AreSame`
            // comparison below can never succeed for it.
            let methodGenericParams = if clrMethod.IsGenericMethodDefinition {
                clrMethod.GetGenericArguments()
            } else {
                Array.Empty[Type]()
            }
            let callable = GetCallableParameters(candidate)
            if callable.Length != clrParams.Length {
                return false
            }
            let candidateTypeParams = if candidate.TypeParameters.IsDefaultOrEmpty {
                ImmutableArray[TypeParameterSymbol].Empty
            } else {
                candidate.TypeParameters
            }
            if methodGenericParams.Length != candidateTypeParams.Length {
                return false
            }
            if candidate.IsAsync && AsyncReturnTypeNormalizer.TryUnwrapTaskClrType(
                clrMethod.ReturnType,
                out var awaitedReturnClr
            ) {
                if !ClrParamTypeMatchesGenericMethodParam(
                    candidate.Type,
                    awaitedReturnClr,
                    methodGenericParams,
                    candidateTypeParams
                ) {
                    return false
                }
            } else if !ClrParamTypeMatchesGenericMethodParam(
                candidate.Type,
                clrReturnType,
                methodGenericParams,
                candidateTypeParams
            ) {
                return false
            }
            for var i = 0; i < callable.Length; i++ {
                let clrParamType = clrParams[i].ParameterType
                let gsParam = callable[i]
                if clrParamType.IsByRef {
                    if gsParam.RefKind == RefKind.None ||
                        !ClrParamTypeMatchesGenericMethodParam(
                        gsParam.Type,
                        clrParamType.GetElementType(),
                        methodGenericParams,
                        candidateTypeParams
                    ) {
                        return false
                    }
                } else if gsParam.RefKind != RefKind.None ||
                    !ClrParamTypeMatchesGenericMethodParam(
                    gsParam.Type,
                    clrParamType,
                    methodGenericParams,
                    candidateTypeParams
                ) {
                    return false
                }
            }
            return true
        }

        /// Issue #949: detects a CLR generic interface constructed over at least
        /// one user-defined G# type argument (e.g. `IEquatable[Shape]`,
        /// including the self-referential `class Shape : IEquatable[Shape]`
        /// pattern). Such an interface is represented as an
        /// (cref:ImportedTypeSymbol) whose `ClrType` is the type-erased
        /// closed shape (`IEquatable<object>`) but whose
        /// (cref:ImportedTypeSymbol.TypeArguments) preserve the real,
        /// symbolic arguments. Matching against the erased shape would demand
        /// `Equals(object)`; we must instead substitute the symbolic
        /// arguments into the OPEN definition's method signatures.
        /// @param ifaceSym The implemented interface type symbol.
        /// @param openDefinition The open generic CLR definition (e.g. `IEquatable`1`) on success.
        /// @param symbolicArgs The symbolic type arguments (e.g. `[Shape]`) on success.
        /// @returns `true` when the interface is a symbolic constructed CLR generic.
        func TryGetSymbolicClrGenericInterface(
            ifaceSym TypeSymbol,
            @NotNullWhen(true) out openDefinition Type?,
            out symbolicArgs ImmutableArray[TypeSymbol]
        ) bool {
            openDefinition = nil
            symbolicArgs = default(ImmutableArray[TypeSymbol])
            if ifaceSym is ImportedTypeSymbol imported &&
                imported.OpenDefinition != nil &&
                imported
                .OpenDefinition
                .IsInterface &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty &&
                imported
                .TypeArguments
                .Any(IsSymbolicTypeArgument) {
                openDefinition = imported.OpenDefinition
                symbolicArgs = imported.TypeArguments
                return true
            }
            return false
        }

        /// Issue #949: walks [`structSymbol`](paramref) (and its base chain)
        /// for an instance method that satisfies [`openMethod`](paramref) from
        /// a CLR generic interface's OPEN definition, with the interface's
        /// generic parameters substituted by [`symbolicArgs`](paramref). A
        /// generic-parameter position in the contract (e.g. the `T` in
        /// `IEquatable<T>.Equals(T)`) is matched against the symbolic
        /// type argument (e.g. `Shape`) using G# type-symbol identity;
        /// non-generic positions fall back to CLR-projected comparison.
        /// @param structSymbol The user struct symbol to inspect.
        /// @param openMethod The interface method from the open definition.
        /// @param symbolicArgs The symbolic type arguments closing the interface.
        /// @returns The matching method, or `null`.
        func FindMatchingMethodForSymbolicClrInterface(
            structSymbol StructSymbol,
            openMethod MethodInfo,
            symbolicArgs ImmutableArray[TypeSymbol]
        ) FunctionSymbol? {
            for candidate in structSymbol.GetMethodsIncludingInherited(openMethod.Name) {
                if IsImplicitInterfaceImplementationCandidate(candidate) &&
                    MethodMatchesSymbolicClrInterfaceSignature(candidate, openMethod, symbolicArgs) {
                    return candidate
                }
            }
            return nil
        }

        /// Issue #3814: whether one G# method satisfies [`openMethod`](paramref)
        /// — a method of a CLR generic interface's OPEN definition — once the
        /// interface's [`symbolicArgs`](paramref) are substituted in. The
        /// per-candidate core of
        /// (cref:FindMatchingMethodForSymbolicClrInterface), factored out so
        /// the explicit-interface-clause resolver can ask the same question about
        /// one specific method (its name may not even be the slot's, and it must
        /// pick a slot rather than answer "some method matched").
        /// @param candidate The candidate G# method.
        /// @param openMethod The interface method from the open definition.
        /// @param symbolicArgs The symbolic type arguments closing the interface.
        /// @returns `true` when the signatures match after substitution.
        func MethodMatchesSymbolicClrInterfaceSignature(
            candidate FunctionSymbol,
            openMethod MethodInfo,
            symbolicArgs ImmutableArray[TypeSymbol]
        ) bool {
            if !TryGetMethodTypeArguments(candidate, openMethod, out var methodTypeArgs) {
                return false
            }
            let clrParams = openMethod.GetParameters()
            let callable = GetCallableParameters(candidate)
            if callable.Length != clrParams.Length {
                return false
            }
            // ReturnType.IsByRef guarantees a non-null reflected element type on that branch.
            if candidate.ReturnRefKind != RefCapabilities.GetReturnRefKind(openMethod) ||
                !ReturnTypeMatchesSubstituted(
                candidate.Type,
                if openMethod.ReturnType.IsByRef {
                    openMethod.ReturnType.GetElementType()!!
                } else {
                    openMethod.ReturnType
                },
                symbolicArgs,
                methodTypeArgs
            ) {
                return false
            }
            for var i = 0; i < callable.Length; i++ {
                let clrParamType = clrParams[i].ParameterType
                let gsParam = callable[i]
                if clrParamType.IsByRef {
                    if gsParam.RefKind == RefKind.None ||
                        !ParameterTypeMatchesSubstituted(
                        gsParam.Type,
                        clrParamType.GetElementType(),
                        symbolicArgs,
                        methodTypeArgs
                    ) {
                        return false
                    }
                } else if gsParam.RefKind != RefKind.None ||
                    !ParameterTypeMatchesSubstituted(gsParam.Type, clrParamType, symbolicArgs, methodTypeArgs) {
                    return false
                }
            }
            return true
        }

        /// Selects the member-definition type and projected arguments for an inherited CLR interface slot.
        /// @param reflectedInterface The inherited interface returned by reflection.
        /// @param slotOwner The projected constructed interface that owns the slot.
        /// @param symbolicArgs The projected owner arguments used to substitute open member signatures.
        /// @returns The open interface definition for symbolic owners; otherwise the reflected interface.
        func GetClrInterfaceSlotProjection(
            reflectedInterface Type,
            slotOwner TypeSymbol,
            out symbolicArgs ImmutableArray[TypeSymbol]
        ) Type {
            if TryGetSymbolicClrGenericInterface(slotOwner, out _, out symbolicArgs) &&
                reflectedInterface.IsGenericType {
                return reflectedInterface.GetGenericTypeDefinition()
            }
            symbolicArgs = ImmutableArray[TypeSymbol].Empty
            return reflectedInterface
        }

        /// Issue #985: enumerates instance method slots contributed by
        /// a CLR interface listed in a type's base-type clause, INCLUDING the
        /// methods of every interface it transitively inherits. The declared
        /// interface's slots are reported with (cref:ClrInterfaceSlot.IsInherited)
        /// = `false`; inherited base-interface slots with
        /// `true`. Generic-parameter positions in each slot's
        /// signature resolve against the declared interface's symbolic type
        /// arguments projected through each slot's constructed owner. Abstract slots are
        /// returned by default; [`includeDefaultMethods`](paramref) also
        /// returns default interface methods so an existing replacement can be
        /// validated even though a missing replacement is optional.
        /// @param ifaceSym A CLR interface type symbol from the base clause.
        /// @param includeDefaultMethods Whether to include non-abstract default methods.
        /// @returns The slots, or an empty sequence when the symbol is not a CLR interface.
        func EnumerateClrInterfaceSlots(ifaceSym TypeSymbol, includeDefaultMethods bool = false) sequence[
            ClrInterfaceSlot
        ] {
            let MethodsOf = func (
                iface Type,
                slotOwner TypeSymbol,
                slotArgs ImmutableArray[TypeSymbol],
                isInherited bool,
                includeDefaultMethods bool
            ) IEnumerable[ClrInterfaceSlot] {
                for method in iface.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                    if method.IsSpecialName || (!method.IsAbstract && !includeDefaultMethods) {
                        continue
                    }
                    yield ClrInterfaceSlot(method, slotOwner, slotArgs, isInherited)
                }
            }
            var declared Type? = nil
            var symbolicArgs = ImmutableArray[TypeSymbol].Empty
            if TryGetSymbolicClrGenericInterface(ifaceSym, out var openDefinition, out var args) &&
                openDefinition != nil {
                declared = openDefinition
                symbolicArgs = args
            }
            if declared == nil {
                let clr Type? = ifaceSym.ClrType
                if clr == nil || !clr.IsInterface {
                    yield break
                }
                declared = clr
            }
            for slot in MethodsOf(declared, ifaceSym, symbolicArgs, isInherited: false, includeDefaultMethods) {
                yield slot
            }
            for baseIface in declared.GetInterfaces() {
                let slotOwner = MapOpenClrTypeToSymbolicWithoutNullability(
                    baseIface,
                    declared,
                    symbolicArgs,
                    NullabilityFreeReason.TypeStructure
                )
                let slotDefinition = GetClrInterfaceSlotProjection(baseIface, slotOwner, out var slotArgs)
                for slot in MethodsOf(slotDefinition, slotOwner, slotArgs, isInherited: true, includeDefaultMethods) {
                    yield slot
                }
            }
        }

        /// Enumerates direct and inherited CLR interface property slots.
        /// @param ifaceSym A CLR interface type symbol from the base clause.
        /// @returns Property slots with the symbolic arguments needed for matching.
        func EnumerateClrInterfacePropertySlots(ifaceSym TypeSymbol) sequence[ClrInterfacePropertySlot] {
            let PropertiesOf = func (iface Type) IEnumerable[PropertyInfo] {
                return iface.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            }
            var declared Type? = nil
            var symbolicArgs = ImmutableArray[TypeSymbol].Empty
            if TryGetSymbolicClrGenericInterface(ifaceSym, out var openDefinition, out var args) &&
                openDefinition != nil {
                declared = openDefinition
                symbolicArgs = args
            }
            if declared == nil {
                let clr Type? = ifaceSym.ClrType
                if clr == nil || !clr.IsInterface {
                    yield break
                }
                declared = clr
            }
            for property in PropertiesOf(declared) {
                yield ClrInterfacePropertySlot(property, ifaceSym, symbolicArgs, isInherited: false)
            }
            for baseIface in declared.GetInterfaces() {
                let slotOwner = MapOpenClrTypeToSymbolicWithoutNullability(
                    baseIface,
                    declared,
                    symbolicArgs,
                    NullabilityFreeReason.TypeStructure
                )
                let slotDefinition = GetClrInterfaceSlotProjection(baseIface, slotOwner, out var slotArgs)
                for property in PropertiesOf(slotDefinition) {
                    yield ClrInterfacePropertySlot(property, slotOwner, slotArgs, isInherited: true)
                }
            }
        }

        /// Issue #985: tests whether a single G# method satisfies a CLR interface
        /// slot — same parameter count, matching ref-kinds, and return/parameter
        /// types equal after substituting the interface's symbolic type arguments
        /// into any generic-parameter positions.
        /// @param method The candidate G# method.
        /// @param slot The interface slot to satisfy.
        /// @returns `true` when the method satisfies the slot.
        func MethodSatisfiesClrSlot(method FunctionSymbol, slot ClrInterfaceSlot) bool {
            if !TryGetMethodTypeArguments(method, slot.Method, out var methodTypeArgs) {
                return false
            }
            let clrParams = slot.Method.GetParameters()
            let callable = GetCallableParameters(method)
            if callable.Length != clrParams.Length {
                return false
            }
            // ReturnType.IsByRef guarantees a non-null reflected element type on that branch.
            if method.ReturnRefKind != RefCapabilities.GetReturnRefKind(slot.Method) ||
                !ReturnTypeMatchesSubstituted(
                method.Type,
                if slot.Method.ReturnType.IsByRef {
                    slot.Method.ReturnType.GetElementType()!!
                } else {
                    slot.Method.ReturnType
                },
                slot.SymbolicArgs,
                methodTypeArgs
            ) {
                return false
            }
            for var i = 0; i < callable.Length; i++ {
                let clrParamType = clrParams[i].ParameterType
                let gsParam = callable[i]
                if clrParamType.IsByRef {
                    if gsParam.RefKind == RefKind.None ||
                        !ParameterTypeMatchesSubstituted(
                        gsParam.Type,
                        clrParamType.GetElementType(),
                        slot.SymbolicArgs,
                        methodTypeArgs
                    ) {
                        return false
                    }
                } else {
                    if gsParam.RefKind != RefKind.None ||
                        !ParameterTypeMatchesSubstituted(
                        gsParam.Type,
                        clrParamType,
                        slot.SymbolicArgs,
                        methodTypeArgs
                    ) {
                        return false
                    }
                }
            }
            return true
        }

        /// Issue #985: recognises a covariant-return interface bridge — two
        /// same-name, same-parameter methods that differ ONLY by return type and
        /// satisfy two DIFFERENT CLR interface slots. The canonical case is a
        /// generic collection implementing `IEnumerable[T]` with both the
        /// generic `GetEnumerator() IEnumerator[T]` (satisfying
        /// `IEnumerable<T>.GetEnumerator`) and the non-generic
        /// `GetEnumerator() IEnumerator` (satisfying the inherited
        /// `IEnumerable.GetEnumerator`). Such a pair is legal IL even though
        /// G# overload rules (and C#) otherwise reject methods differing only by
        /// return type.
        ///
        /// On success, [`bridgeMethod`](paramref) is the method bound to an
        /// inherited base-interface slot (the one that, being private or otherwise
        /// non-implicitly-matchable, needs an explicit `MethodImpl` row) and
        /// [`bridgeSlot`](paramref) is that slot's CLR method.
        /// @param implementedClrInterfaces The CLR interfaces from the type's base clause.
        /// @param first The already-declared method.
        /// @param second The new same-signature method.
        /// @param bridgeMethod The method that explicitly bridges an inherited slot.
        /// @param bridgeSlot The inherited CLR interface slot to bind via MethodImpl.
        /// @param bridgeSlotOwner The constructed interface type that owns [`bridgeSlot`](paramref).
        /// @returns `true` when the pair forms a valid covariant interface bridge.
        func TryResolveCovariantInterfaceBridge(
            implementedClrInterfaces ImmutableArray[TypeSymbol],
            first FunctionSymbol?,
            second FunctionSymbol?,
            out bridgeMethod FunctionSymbol?,
            out bridgeSlot MethodInfo?,
            out bridgeSlotOwner TypeSymbol?
        ) bool {
            bridgeMethod = nil
            bridgeSlot = nil
            bridgeSlotOwner = nil
            if first == nil || second == nil || implementedClrInterfaces.IsDefaultOrEmpty {
                return false
            }
            // Identical return types are a genuine duplicate, never a bridge.
            if ReturnTypeSignaturesEqual(first.Type, second.Type) {
                return false
            }
            let slots = List[ClrInterfaceSlot]()
            for ifaceSym in implementedClrInterfaces {
                for slot in EnumerateClrInterfaceSlots(ifaceSym) {
                    slots.Add(slot)
                }
            }
            if slots.Count == 0 {
                return false
            }
            // Find a distinct slot for each method: the pair is a valid bridge only
            // when `first` satisfies a slot that `second` does not, and vice versa.
            var firstOnly ClrInterfaceSlot? = nil
            var secondOnly ClrInterfaceSlot? = nil
            for slot in slots {
                let firstOk = MethodSatisfiesClrSlot(first, slot)
                let secondOk = MethodSatisfiesClrSlot(second, slot)
                if firstOk && !secondOk && firstOnly == nil {
                    firstOnly = slot
                } else if secondOk && !firstOk && secondOnly == nil {
                    secondOnly = slot
                }
            }
            if firstOnly == nil || secondOnly == nil {
                return false
            }
            // The bridge method is the one bound to an inherited base-interface slot
            // (e.g. the non-generic IEnumerable.GetEnumerator). That slot is the one
            // a private/covariant method cannot implicitly implement, so it needs the
            // explicit MethodImpl row. Prefer an inherited slot; if both are
            // inherited, bridge whichever the second method covers.
            if secondOnly.IsInherited {
                bridgeMethod = second
                bridgeSlot = secondOnly.Method
                bridgeSlotOwner = secondOnly.SlotOwner
                return true
            }
            if firstOnly.IsInherited {
                bridgeMethod = first
                bridgeSlot = firstOnly.Method
                bridgeSlotOwner = firstOnly.SlotOwner
                return true
            }
            return false
        }

        /// Issue #985: renders a short, human-readable signature for a CLR
        /// interface slot method, used in GS0187 diagnostics for inherited
        /// interface members.
        /// @param method The interface slot method.
        /// @returns A signature such as `GetEnumerator` or `CompareTo(T)`.
        func FormatClrSlotSignature(method MethodInfo) string {
            let ps = method.GetParameters()
            if ps.Length == 0 {
                return method.Name
            }
            let names = [ps.Length]string
            for var i = 0; i < ps.Length; i++ {
                names[i] = ps[i].ParameterType.Name
            }
            return "${method.Name}(${string.Join(", ", names)})"
        }

        /// Issue #949: tests whether a candidate G# property satisfies an open
        /// CLR interface property whose type may be a generic parameter, with
        /// [`symbolicArgs`](paramref) substituted in.
        /// @param structSymbol The user struct symbol to inspect.
        /// @param openProp The interface property from the open definition.
        /// @param symbolicArgs The symbolic type arguments closing the interface.
        /// @returns The matching (cref:PropertySymbol), or `null`.
        func FindMatchingPropertyForSymbolicClrInterface(
            structSymbol StructSymbol,
            openProp PropertyInfo,
            symbolicArgs ImmutableArray[TypeSymbol]
        ) PropertySymbol? {
            for implProp in structSymbol.Properties {
                if IsImplicitInterfaceImplementationCandidate(implProp) &&
                    PropertyMatchesSymbolicClrInterfaceSignature(implProp, openProp, symbolicArgs) {
                    return implProp
                }
            }
            return nil
        }

        /// Tests a property against an open CLR interface property after symbolic substitution.
        /// @param property The candidate G# property.
        /// @param openProperty The CLR property from the open generic interface definition.
        /// @param symbolicArgs The projected symbolic arguments for the property owner.
        /// @returns `true` when the complete property signature matches.
        func PropertyMatchesSymbolicClrInterfaceSignature(
            property PropertySymbol,
            openProperty PropertyInfo,
            symbolicArgs ImmutableArray[TypeSymbol]
        ) bool {
            let openPropertyType Type? = if openProperty.PropertyType.IsByRef {
                openProperty.PropertyType.GetElementType()
            } else {
                openProperty.PropertyType
            }
            if openPropertyType == nil ||
                property.Name != openProperty.Name ||
                property.ReturnRefKind != RefCapabilities.GetReturnRefKind(openProperty) ||
                !ParameterTypeMatchesSubstituted(property.Type, openPropertyType, symbolicArgs) {
                return false
            }
            let openParameters = openProperty.GetIndexParameters()
            if property.Parameters.Length != openParameters.Length {
                return false
            }
            for var i = 0; i < openParameters.Length; i++ {
                let openParameter = openParameters[i]
                let openParameterType Type? = if openParameter.ParameterType.IsByRef {
                    openParameter.ParameterType.GetElementType()
                } else {
                    openParameter.ParameterType
                }
                if openParameterType == nil || property.Parameters[i].RefKind != RefCapabilities.GetParameterRefKind(
                    openParameter
                ) ||
                    !ParameterTypeMatchesSubstituted(property.Parameters[i].Type, openParameterType, symbolicArgs) {
                    return false
                }
            }
            return true
        }

        /// Issue #949: a type argument is "symbolic" (preserved rather than erased
        /// to `object`) when it is a user-defined G# type, a generic type
        /// parameter, or a constructed generic mentioning one of those. Mirrors the
        /// emitter's `ArgIsSymbolicUserDefined` so binding and emit agree on
        /// which arguments survive erasure.
        /// @param arg The type argument to classify.
        /// @returns `true` when the argument is symbolic.
        func IsSymbolicTypeArgument(arg TypeSymbol) bool {
            switch arg {
                case StructSymbol, InterfaceSymbol, EnumSymbol, DelegateTypeSymbol, TypeParameterSymbol {
                    return true
                }
                case nested is ImportedTypeSymbol when nested.OpenDefinition != nil &&
                    !nested
                    .TypeArguments
                    .IsDefaultOrEmpty &&
                    nested
                    .TypeArguments
                    .Any(IsSymbolicTypeArgument) {
                    return true
                }
                case arr is ArrayTypeSymbol {
                    return IsSymbolicTypeArgument(arr.ElementType)
                }
                case rectangular is RectangularArrayTypeSymbol {
                    return IsSymbolicTypeArgument(rectangular.ElementType)
                }
                case slice is SliceTypeSymbol {
                    return IsSymbolicTypeArgument(slice.ElementType)
                }
                case nullable is NullableTypeSymbol when nullable.UnderlyingType != nil {
                    return IsSymbolicTypeArgument(nullable.UnderlyingType)
                }
                case tuple is TupleTypeSymbol {
                    return tuple.ElementTypes.Any(IsSymbolicTypeArgument)
                }
                default {
                    return false
                }
            }
        }

        /// Looks up a user-declared property on [`structSymbol`](paramref)
        /// whose name and CLR-projected type match [`clrProp`](paramref).
        /// @param structSymbol The user struct symbol to inspect.
        /// @param slotOwner The constructed interface that owns the property slot.
        /// @param clrProp The CLR property to match.
        /// @returns The matching (cref:PropertySymbol), or
        /// `null` when no match exists.
        func FindMatchingProperty(
            structSymbol StructSymbol,
            slotOwner TypeSymbol,
            clrProp PropertyInfo
        ) PropertySymbol? {
            for implProp in structSymbol.Properties {
                if IsImplicitInterfaceImplementationCandidate(implProp) &&
                    PropertyMatchesClrInterfaceSignature(implProp, slotOwner, clrProp) {
                    return implProp
                }
            }
            return nil
        }

        /// Tests a property against a CLR interface property using the complete signature.
        /// @param property The candidate G# property.
        /// @param slotOwner The constructed interface that owns the property slot.
        /// @param clrProperty The CLR interface property.
        /// @returns `true` when the complete property signature matches.
        func PropertyMatchesClrInterfaceSignature(
            property PropertySymbol,
            slotOwner TypeSymbol,
            clrProperty PropertyInfo
        ) bool {
            var slotType = GetClrPropertyTypeSymbol(slotOwner, clrProperty)
            if slotType is ByRefTypeSymbol byRef {
                slotType = byRef.PointeeType
            }
            if property.Name != clrProperty.Name || property.ReturnRefKind != RefCapabilities.GetReturnRefKind(
                clrProperty
            ) ||
                !SameTypeSymbol(property.Type, slotType) {
                return false
            }
            let clrParameters = clrProperty.GetIndexParameters()
            if property.Parameters.Length != clrParameters.Length {
                return false
            }
            for var i = 0; i < clrParameters.Length; i++ {
                if property.Parameters[i].RefKind != RefCapabilities.GetParameterRefKind(clrParameters[i]) ||
                    !SameTypeSymbol(
                    property.Parameters[i].Type,
                    GetIndexerParameterTypeSymbol(slotOwner, clrProperty, i)
                ) {
                    return false
                }
            }
            return true
        }

        /// Returns whether a method may satisfy an interface slot implicitly.
        /// @param method The candidate method.
        /// @returns `true` when the method has no explicit interface linkage.
        func IsImplicitInterfaceImplementationCandidate(
            method FunctionSymbol
        ) bool -> !method.HasExplicitInterfaceClause &&
            method.ExplicitInterfaceMember == nil &&
            method.ExplicitInterfaceSlot == nil

        /// Returns whether a property may satisfy an interface slot implicitly.
        /// @param property The candidate property.
        /// @returns `true` when the property has no explicit interface linkage.
        func IsImplicitInterfaceImplementationCandidate(
            property PropertySymbol
        ) bool -> !property.HasExplicitInterfaceClause &&
            property.ExplicitInterfaceMember == nil &&
            property.ExplicitInterfaceGetterSlot == nil &&
            property.ExplicitInterfaceSetterSlot == nil

        /// Returns whether an event may satisfy an interface slot implicitly.
        /// @param ev The candidate event.
        /// @returns `true` when the event has no explicit interface linkage.
        func IsImplicitInterfaceImplementationCandidate(ev EventSymbol) bool -> !ev.HasExplicitInterfaceClause &&
            ev.ExplicitInterfaceMember == nil &&
            ev.ExplicitInterfaceAddSlot == nil &&
            ev.ExplicitInterfaceRemoveSlot == nil

        /// A C# static class is a sealed abstract class. Detected structurally
        /// so it works under (cref:System.Reflection.MetadataLoadContext).
        /// @param type The candidate type.
        /// @returns `true` when the type is a static class.
        func IsStaticClass(type Type) bool -> type.IsClass && type.IsAbstract && type.IsSealed

        /// Robustly detects `[System.Runtime.CompilerServices.ExtensionAttribute]`
        /// via (cref:CustomAttributeData) (never runtime
        /// `GetCustomAttribute`, which throws under
        /// (cref:System.Reflection.MetadataLoadContext)).
        /// @param member The type or method to inspect.
        /// @returns `true` when the member carries the
        /// extension attribute.
        func HasExtensionAttribute(member MemberInfo) bool {
            try {
                for attribute in member.GetCustomAttributesData() {
                    if string.Equals(
                        attribute.AttributeType?.FullName,
                        "System.Runtime.CompilerServices.ExtensionAttribute",
                        StringComparison.Ordinal
                    ) {
                        return true
                    }
                }
            } catch {
                // Reflection failures (notably in MLC) — treat as "no attribute".

            }
            return false
        }

        /// Recognizes only the natural Action/Func backing of an exact structural
        /// function signature; unrelated named delegates remain nominal.
        /// @param source The structural source.
        /// @param target The expected delegate.
        /// @returns Whether both spellings denote the same natural delegate.
        internal func IsNaturalStructuralDelegateTarget(source TypeSymbol, target TypeSymbol) bool {
            var source = source
            var target = target
            source = if source is NullableTypeSymbol sourceNullable {
                sourceNullable.UnderlyingType
            } else {
                source
            }
            target = if target is NullableTypeSymbol targetNullable {
                targetNullable.UnderlyingType
            } else {
                target
            }
            target = if target is NullabilityAnnotatedTypeSymbol annotated {
                annotated.BaseType
            } else {
                target
            }
            if source is not FunctionTypeSymbol sourceFunction ||
                !TryCanonicalizeStructuralFunctionType(sourceFunction, target, out _) ||
                target.ClrType == nil ||
                sourceFunction.Arity > 16 {
                return false
            }
            let naturalFullName = if FunctionTypeSymbol.IsVoidReturn(sourceFunction.ReturnType) {
                (
                    if sourceFunction.Arity == 0 {
                        "System.Action"
                    } else {
                        "System.Action`" + sourceFunction.Arity.ToString(CultureInfo.InvariantCulture)
                    }
                )
            } else {
                "System.Func`" + (sourceFunction.Arity + 1).ToString(CultureInfo.InvariantCulture)
            }
            let targetDefinition = if target.ClrType!!.IsGenericType {
                target.ClrType!!.GetGenericTypeDefinition()
            } else {
                target.ClrType!!
            }
            let baseType Type? = targetDefinition.BaseType
            return string.Equals(targetDefinition.FullName, naturalFullName, StringComparison.Ordinal) &&
                baseType != nil &&
                string.Equals(baseType.FullName, "System.MulticastDelegate", StringComparison.Ordinal) && string.Equals(
                targetDefinition.Assembly.FullName,
                baseType.Assembly.FullName,
                StringComparison.Ordinal
            )
        }

        /// Removes every entry from the method cache.
        /// Called by (cref:ReferenceResolver.Dispose) (#1678, mirroring #1622)
        /// alongside (cref:ClrTypeUtilities.ClearCache).
        internal func ClearCache() -> methodsIncludingSelfAndInterfacesCache = ConditionalWeakTable[
            Type,
            ConcurrentDictionary[string, IReadOnlyList[MethodInfo]]
        ]()

        /// ADR-0193 §3: (cref:MapOpenClrTypeToSymbolic(Type, ImportedTypeSymbol))
        /// for an audited, nullability-free position — the projection twin of
        /// (cref:TypeSymbol.FromClrTypeWithoutNullability). It substitutes
        /// the receiver's symbolic arguments exactly as the door does (so a
        /// `string?` argument stays `string?`); what it states is that
        /// the open CLR type is not a member signature position, so there is no
        /// declaration `[Nullable]` to merge. GSA0007 reports it when its
        /// argument is a signature accessor.
        /// @param openClr The open CLR type to map.
        /// @param openImp The receiver carrying symbolic type arguments.
        /// @param reason Why no declaration nullability applies.
        /// @returns The symbolic projection.
        @NullabilityFunnel
        internal func MapOpenClrTypeToSymbolicWithoutNullability(
            openClr Type?,
            openImp ImportedTypeSymbol?,
            reason NullabilityFreeReason
        ) TypeSymbol {
            return MapOpenClrTypeToSymbolic(openClr, openImp)
        }

        /// ADR-0193 §3: the open-definition overload of
        /// (cref:MapOpenClrTypeToSymbolicWithoutNullability(Type, ImportedTypeSymbol, NullabilityFreeReason)).
        /// @param openClr The open CLR type to map.
        /// @param openDefinition The open generic definition the parameters bind against.
        /// @param typeArguments The symbolic arguments.
        /// @param reason Why no declaration nullability applies.
        /// @returns The symbolic projection.
        @NullabilityFunnel
        internal func MapOpenClrTypeToSymbolicWithoutNullability(
            openClr Type?,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol],
            reason NullabilityFreeReason
        ) TypeSymbol {
            return MapOpenClrTypeToSymbolic(openClr, openDefinition, typeArguments)
        }

        @NullabilityFunnel
        internal func GetIndexerParameterTypeSymbol(
            targetType TypeSymbol,
            closedIndexer PropertyInfo,
            parameterIndex int32
        ) TypeSymbol {
            let closedParameter = closedIndexer.GetIndexParameters()[parameterIndex]
            if GetProjectionReceiverImportedType(targetType) is ImportedTypeSymbol imported &&
                TryGetSymbolicDeclaringContext(
                imported,
                closedIndexer.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments
            ) &&
                openDefinition != nil {
                let openIndexer = FindOpenIndexerDefinition(openDefinition, closedIndexer)
                let openParameters[]?ParameterInfo = openIndexer?.GetIndexParameters()
                if openParameters != nil && parameterIndex < openParameters.Length {
                    let openParameter = openParameters[parameterIndex]
                    return NullableFlagsBuilder.MergeDeclarationNullability(
                        MapOpenClrTypeToSymbolic(openParameter.ParameterType, openDefinition, declaringTypeArguments),
                        openParameter.ParameterType,
                        ClrNullability.ReadNullableFlags(openParameter, openIndexer)
                    )
                }
            }
            let closedParameterType = closedParameter.ParameterType
            if closedParameterType.IsConstructedGenericType {
                return ImportedTypeSymbol.GetConstructed(
                    closedParameterType,
                    closedParameterType.GetGenericTypeDefinition(),
                    closedParameterType.GetGenericArguments().Select(TypeSymbol.FromClrType).ToImmutableArray()
                )
            }
            return ClrNullability.GetParameterTypeSymbol(closedParameter)
        }

        /// Resolves a CLR property's type through a symbolic imported receiver,
        /// including properties declared on inherited generic interfaces.
        /// @param targetType The symbolic imported receiver type.
        /// @param closedProperty The reflected property selected from the erased receiver.
        /// @param projectOnlyWhenSymbolicallyRequired Whether to use closed-property nullability unless
        /// receiver substitution carries
        /// information that CLR metadata cannot represent.
        /// @returns The property type after symbolic receiver substitution.
        @NullabilityFunnel
        internal func GetClrPropertyTypeSymbol(
            targetType TypeSymbol,
            closedProperty PropertyInfo,
            projectOnlyWhenSymbolicallyRequired bool = false
        ) TypeSymbol {
            if GetProjectionReceiverImportedType(targetType) is ImportedTypeSymbol imported &&
                TryGetSymbolicDeclaringContext(
                imported,
                closedProperty.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments
            ) &&
                openDefinition != nil {
                let openProperty PropertyInfo? = FindOpenIndexerDefinition(openDefinition, closedProperty)
                if openProperty != nil {
                    let openPropertyType = openProperty.PropertyType
                    let projectionType = if openPropertyType.IsByRef {
                        Invariant.Required(
                            openPropertyType.GetElementType(),
                            "a by-ref property has an element type",
                            expression: "openPropertyType.GetElementType()"
                        )
                    } else {
                        openPropertyType
                    }
                    let mapped = MapOpenClrTypeToSymbolic(projectionType, openDefinition, declaringTypeArguments)
                    // Issue #3415: reflection erases reference nullability from a
                    // constructed receiver such as AsyncLocal<string?>. Keep the
                    // receiver-projected property type when CLR metadata cannot
                    // represent its symbolic shape.
                    //
                    // Issue #4033: "cannot represent its symbolic shape" is true of
                    // EVERY position that is a type parameter of the declaring
                    // type, not only of the shapes the two probes below recognise.
                    // A declaration-site byte at a parameter position is a
                    // placeholder — `Dictionary<,>.Values` carries
                    // `[Nullable({1, 0, 0})]`, whose two zeroes stand for "whatever
                    // TKey/TValue are substituted with", because the declarer
                    // cannot know. Reading them as concrete positions applies
                    // #1354's "oblivious means `T?`" rule to a slot that has no
                    // annotation to be oblivious ABOUT, so a closed
                    // `Dictionary[string, string]` surfaced `.Keys`/`.Values` with
                    // a `string?` element while the very same dictionary's
                    // indexer, `for k, v in m` and `TryGetValue` all surfaced
                    // `string` — and `for v in m.Values { v.Length }` then lost the
                    // whole CLR property/field surface (GS0158, or GS9998 when the
                    // element was a constructed generic). Measured, the old
                    // reading was not even faithful to a declaration that DID
                    // annotate: a `Dictionary<string, string?>` and a
                    // `Dictionary<string, string>` handed over from the same
                    // nullable-enabled assembly both surfaced `string?` here,
                    // because both read the same placeholder.
                    // MergeDeclarationNullability below already carves parameter
                    // positions out of the #1354 rule and takes their nullability
                    // from the receiver's argument, which is why the OPEN
                    // `map[K, V].Keys` spelling was right all along; the gate
                    // simply never let a closed receiver reach it. Project whenever
                    // the open property type mentions a parameter at all, and let
                    // the merge keep deciding concrete positions.
                    if !projectOnlyWhenSymbolicallyRequired ||
                        projectionType.IsGenericParameter ||
                        projectionType
                        .ContainsGenericParameters {
                        // Issue #3705 (family 2): this branch returned the
                        // receiver-substituted type RAW, exactly as
                        // GetClrMethodReturnTypeSymbol's did before #3741 — and
                        // #3741 fixed the return and parameter branches but not this
                        // one. Substitution recovers the member's shape and silently
                        // discards the declaration's `[Nullable]`, so an imported
                        // `string?` property or indexer read through a constrained
                        // generic receiver bound as non-null `string` with no
                        // diagnostic: the unsound direction. Fold the declaration
                        // flags back in like every sibling reader.
                        let declarationFlags = ClrNullability.ReadNullableFlags(
                            openProperty,
                            openProperty.DeclaringType
                        )
                        let result = NullableFlagsBuilder.MergeDeclarationNullability(
                            mapped,
                            projectionType,
                            declarationFlags
                        )
                        return if openPropertyType.IsByRef {
                            cast[TypeSymbol](ByRefTypeSymbol.Get(result))
                        } else {
                            result
                        }
                    }
                }
            }
            return ClrNullability.GetPropertyTypeSymbol(closedProperty)
        }

        internal func GetDeclaredAccessPathType(path AccessPath, fallback TypeSymbol) TypeSymbol {
            let FindSourceFieldType = func (receiver TypeSymbol, selected FieldSymbol) TypeSymbol? {
                if receiver is not StructSymbol structType {
                    return nil
                }
                for owner in structType.GetHierarchy() {
                    for candidate in owner.Definition!!.Fields {
                        if object.ReferenceEquals(candidate, selected) ||
                            (
                            selected.Declaration != nil && object.ReferenceEquals(
                                candidate.Declaration,
                                selected.Declaration
                            )
                        ) {
                            return owner.SubstituteMemberType(candidate.Type)!!
                        }
                    }
                }
                return nil
            }
            let FindSourcePropertyType = func (receiver TypeSymbol, selected PropertySymbol) TypeSymbol? {
                if receiver is StructSymbol structType {
                    for owner in structType.GetHierarchy() {
                        for candidate in owner.Definition!!.Properties {
                            if object.ReferenceEquals(candidate, selected) ||
                                (
                                selected.Declaration != nil && object.ReferenceEquals(
                                    candidate.Declaration,
                                    selected.Declaration
                                )
                            ) {
                                return owner.SubstituteMemberType(candidate.Type)!!
                            }
                        }
                    }
                } else if receiver is InterfaceSymbol interfaceType {
                    for owner in interfaceType.SelfAndAllBaseInterfaces() {
                        owner.EnsureMembersResolved()
                        for candidate in owner.Definition!!.Properties {
                            if object.ReferenceEquals(candidate, selected) ||
                                (
                                selected.Declaration != nil && object.ReferenceEquals(
                                    candidate.Declaration,
                                    selected.Declaration
                                )
                            ) {
                                return owner.SubstituteMemberType(candidate.Type)
                            }
                        }
                    }
                }
                return nil
            }
            var receiverType = path.Root.Type
            for member in path.Members {
                receiverType = if receiverType is NullableTypeSymbol nullable {
                    nullable.UnderlyingType
                } else {
                    receiverType
                }
                receiverType = switch member.SourceSymbol {
                    case field is FieldSymbol: FindSourceFieldType(receiverType, field) ?? field.Type
                    case property is PropertySymbol: FindSourcePropertyType(receiverType, property) ?? property.Type
                    case variable is VariableSymbol: variable.Type
                    default: switch member.ClrMember {
                        case field is FieldInfo: GetClrFieldTypeSymbol(receiverType, field)
                        case property is PropertyInfo: GetClrPropertyTypeSymbol(receiverType, property)
                        default: fallback
                    }
                }
            }
            return receiverType
        }

        /// Resolves a CLR field type through receiver-carried generic nullability.
        /// @param targetType Imported receiver type.
        /// @param closedField Reflected field on the closed receiver.
        /// @returns Field type with receiver generic-argument nullability.
        @NullabilityFunnel
        internal func GetClrFieldTypeSymbol(targetType TypeSymbol, closedField FieldInfo) TypeSymbol {
            const AllFields = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            let imported ImportedTypeSymbol? = GetProjectionReceiverImportedType(targetType)
            if imported != nil &&
                TryGetSymbolicDeclaringContext(
                imported,
                closedField.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments
            ) &&
                openDefinition != nil {
                let openField FieldInfo? = openDefinition.GetField(closedField.Name, AllFields)
                if openField != nil {
                    let mapped = MapOpenClrTypeToSymbolic(openField.FieldType, openDefinition, declaringTypeArguments)
                    let declarationFlags = ClrNullability.ReadNullableFlags(openField, openDefinition)
                    return NullableFlagsBuilder.MergeDeclarationNullability(
                        mapped,
                        openField.FieldType,
                        declarationFlags
                    )
                }
            }
            return ClrNullability.GetFieldTypeSymbol(closedField)
        }

        /// ADR-0193 Phase 2: the value type of a pattern member (an enumerator's
        /// `Current` property or field) declared on an OPEN generic
        /// definition, projected through the receiver's symbolic arguments with
        /// the declaration's `[Nullable]` merged — the same projection-plus-merge
        /// every `GetClr*` sibling does. The pattern probes used to project
        /// the position raw, so a `T? Current` bound its loop variable as
        /// `T`.
        /// @param openMember The property or field on the open definition.
        /// @param openDefinition The open definition the member's generic parameters bind against.
        /// @param typeArguments The receiver's symbolic arguments.
        /// @returns The projected, merged value type; (cref:TypeSymbol.Error) for another member kind.
        @NullabilityFunnel
        internal func GetClrMemberValueTypeSymbol(
            openMember MemberInfo,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol]
        ) TypeSymbol {
            var valueType Type
            switch openMember {
                case property is PropertyInfo {
                    valueType = property.PropertyType
                }
                case field is FieldInfo {
                    valueType = field.FieldType
                }
                default {
                    return TypeSymbol.Error
                }
            }
            let layout = if valueType.IsByRef {
                Invariant.Required(
                    valueType.GetElementType(),
                    "a by-ref member type has an element type",
                    expression: "valueType.GetElementType()"
                )
            } else {
                valueType
            }
            let merged = NullableFlagsBuilder.MergeDeclarationNullability(
                MapOpenClrTypeToSymbolic(layout, openDefinition, typeArguments),
                layout,
                ClrNullability.ReadNullableFlags(openMember, openMember.DeclaringType)
            )
            return if valueType.IsByRef {
                cast[TypeSymbol](ByRefTypeSymbol.Get(merged))
            } else {
                merged
            }
        }

        /// ADR-0193 Phase 2: the closed-member counterpart of
        /// (cref:GetClrMemberValueTypeSymbol(MemberInfo, Type, ImmutableArray{TypeSymbol})):
        /// a reflected pattern member's value type read through the direct
        /// reader, so its declaration nullability is applied.
        /// @param member The reflected property or field.
        /// @returns The value type; (cref:TypeSymbol.Error) for another member kind.
        internal func GetClrMemberValueTypeSymbol(member MemberInfo) TypeSymbol -> switch member {
            case property is PropertyInfo: ClrNullability.GetPropertyTypeSymbol(property)
            case field is FieldInfo: ClrNullability.GetFieldTypeSymbol(field)
            default: TypeSymbol.Error
        }

        /// Resolves an imported event handler type through a symbolic receiver/interface hierarchy.
        /// @param targetType The symbolic imported receiver type.
        /// @param closedEvent The reflected event selected from the erased receiver.
        /// @returns The event handler type after symbolic receiver substitution.
        @NullabilityFunnel
        internal func GetClrEventHandlerTypeSymbol(targetType TypeSymbol, closedEvent EventInfo) TypeSymbol {
            if GetProjectionReceiverImportedType(targetType) is ImportedTypeSymbol imported &&
                TryGetSymbolicDeclaringContext(
                imported,
                closedEvent.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments
            ) &&
                openDefinition != nil {
                var openEvent EventInfo? = nil
                // ADR-0193 §4: static events too, as for static properties.
                for candidate in ClrTypeUtilities.SafeGetEvents(
                    openDefinition,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
                ) {
                    if candidate.Name == closedEvent.Name {
                        openEvent = candidate
                        break
                    }
                }
                if openEvent?.EventHandlerType != nil {
                    let mapped = MapOpenClrTypeToSymbolic(
                        openEvent!!.EventHandlerType,
                        openDefinition,
                        declaringTypeArguments
                    )
                    if mapped.ClrType?.ContainsGenericParameters != true {
                        return ApplyEventDeclarationNullability(mapped, openEvent!!, openDefinition)
                    }
                }
            }
            return GetClrEventHandlerTypeSymbol(closedEvent)
        }

        /// Issue #3695: the reflected handler type of an event reached WITHOUT a
        /// symbolic receiver (an imported static event, say), with the event
        /// declaration's `[Nullable]` metadata applied.
        /// @param closedEvent The reflected event.
        /// @returns The handler type with declaration-site nullability applied.
        @NullabilityFunnel
        internal func GetClrEventHandlerTypeSymbol(closedEvent EventInfo) TypeSymbol {
            let handlerType = TypeSymbol.FromClrType(closedEvent.EventHandlerType)
            if closedEvent.DeclaringType is not{} declaringType {
                return handlerType
            }
            if !declaringType.IsConstructedGenericType {
                return ApplyEventDeclarationNullability(handlerType, closedEvent, declaringType)
            }
            // ADR-0193 §4: a constructed generic declaring type needs its flags
            // projected through the substitution first. This used to leave those
            // alone, which returned the handler with no declared nullability at
            // all — the reader-agreement test found it disagreeing with every
            // sibling reader. The projection reader does exactly the alignment
            // that was missing, against the open event's handler type.
            let openDefinition = declaringType.GetGenericTypeDefinition()
            var openEvent EventInfo? = nil
            for candidate in ClrTypeUtilities.SafeGetEvents(
                openDefinition,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            ) {
                if candidate.MetadataToken == closedEvent.MetadataToken {
                    openEvent = candidate
                    break
                }
            }
            if openEvent?.EventHandlerType is not Type handlerLayout ||
                closedEvent.EventHandlerType is not Type closedHandler {
                return handlerType
            }
            let projected = ClrNullability.SymbolFromLayoutFlags(
                closedHandler,
                handlerLayout,
                ClrNullability.ReadNullableFlags(openEvent!!, openDefinition)
            )
            return if projected is NullableTypeSymbol nullableHandler {
                nullableHandler.UnderlyingType
            } else {
                projected
            }
        }

        /// Reconstructs the symbolic imported interface that actually declares a
        /// reflected member reached through a possibly derived constraint.
        /// @param targetType The symbolic imported receiver type.
        /// @param member The reflected member reached through the receiver.
        /// @returns The symbolic declaring interface used to parent the emitted member reference.
        @NullabilityFunnel
        internal func GetClrMemberDeclaringTypeSymbol(targetType TypeSymbol, member MemberInfo) TypeSymbol {
            if GetImportedTypeSymbol(targetType) is ImportedTypeSymbol imported &&
                member.DeclaringType is Type memberDeclaringType &&
                TryGetSymbolicDeclaringContext(
                imported,
                memberDeclaringType,
                out var openDefinition,
                out var declaringTypeArguments
            ) &&
                openDefinition != nil {
                return if openDefinition.IsGenericTypeDefinition {
                    ImportedTypeSymbol.GetConstructed(memberDeclaringType, openDefinition, declaringTypeArguments)
                } else {
                    ImportedTypeSymbol.Get(openDefinition)
                }
            }
            return targetType
        }

        internal func GetClrFieldReferenceContainer(receiverType TypeSymbol?, member MemberInfo) TypeSymbol? {
            return if receiverType != nil && member is FieldInfo && GetImportedTypeSymbol(receiverType) != nil {
                GetClrMemberDeclaringTypeSymbol(receiverType, member)
            } else {
                default(TypeSymbol?)
            }
        }

        /// Resolves an imported method return through a symbolic receiver/interface hierarchy.
        /// @param targetType The symbolic imported receiver type.
        /// @param closedMethod The reflected method selected from the erased receiver.
        /// @returns The method return type after symbolic receiver substitution.
        @NullabilityFunnel
        internal func GetClrMethodReturnTypeSymbol(targetType TypeSymbol, closedMethod MethodInfo) TypeSymbol {
            if GetProjectionReceiverImportedType(targetType) is ImportedTypeSymbol imported &&
                TryGetSymbolicDeclaringContext(
                imported,
                closedMethod.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments
            ) &&
                openDefinition != nil {
                let openMethod MethodInfo? = TryGetOpenMethodOnDeclaringType(openDefinition, closedMethod)
                if openMethod != nil {
                    // Issue #3705 (family 2): the symbolic branch returned the
                    // receiver-substituted type RAW. Substitution recovers the
                    // shape but not the declaration's `[Nullable]` metadata, so an
                    // imported `string?` return reached the binder as non-null
                    // `string`. GetClrFieldTypeSymbol's symbolic branch folds the
                    // declaration flags back in; this one now does the same.
                    //
                    // ADR-0193 §4: a `ref T` return is peeled before the merge and
                    // re-wrapped after it, exactly as the parameter branch below
                    // and `ClrNullability.GetReturnTypeSymbol` do — `[Nullable]` on
                    // a by-ref annotates the pointee. Merging against the by-ref
                    // type itself read it as a reference position and produced a
                    // platform-wrapped by-ref for `GetPinnableReference()`, which
                    // the reader-agreement test found disagreeing with every
                    // sibling reader.
                    let openReturnType = openMethod.ReturnType
                    let returnLayout = if openReturnType.IsByRef {
                        Invariant.Required(
                            openReturnType.GetElementType(),
                            "a by-ref return type has an element type",
                            expression: "openReturnType.GetElementType()"
                        )
                    } else {
                        openReturnType
                    }
                    let mapped = MapOpenClrTypeToSymbolic(returnLayout, openDefinition, declaringTypeArguments)
                    let declarationFlags = ClrNullability.ReadNullableFlags(openMethod.ReturnParameter, openMethod)
                    let merged = NullableFlagsBuilder.MergeDeclarationNullability(
                        mapped,
                        returnLayout,
                        declarationFlags
                    )
                    return if openReturnType.IsByRef {
                        cast[TypeSymbol](ByRefTypeSymbol.Get(merged))
                    } else {
                        merged
                    }
                }
            }
            // Issue #3705 (family 2, the #3703 shape): the reflected fallback slot
            // of the three sibling helpers above — GetClrPropertyTypeSymbol,
            // GetClrFieldTypeSymbol and GetClrIndexerParameterTypeSymbol — each end
            // in a `ClrNullability` read. This one ended in a bare `FromClrType`,
            // which drops the declaration's `[Nullable]` metadata and binds an
            // imported `string?` return as non-null `string` — the unsound
            // direction. Route it through the same reader the siblings use.
            return ClrNullability.GetReturnTypeSymbol(closedMethod)
        }

        /// Reads base and interface signatures through their declaring receiver.
        /// @param targetType The symbolic imported receiver.
        /// @returns Annotated direct relationships in metadata order.
        @NullabilityFunnel
        internal func GetClrRelationshipTypeSymbols(targetType TypeSymbol) ImmutableArray[TypeSymbol] {
            if GetProjectionReceiverImportedType(targetType) is not{} imported ||
                !TryGetSymbolicDeclaringContext(imported, imported.ClrType, out var definition, out var arguments) ||
                definition == nil {
                return ImmutableArray[TypeSymbol].Empty
            }
            let project = (layout Type) -> MapOpenClrTypeToSymbolic(layout, definition, arguments)
            let result = ImmutableArray.CreateBuilder[TypeSymbol]()
            if ClrNullability.GetBaseTypeSymbol(definition, project) is {} baseType {
                result.Add(baseType)
            }
            result.AddRange(ClrNullability.GetInterfaceTypeSymbols(definition, project))
            return result.ToImmutable()
        }

        /// Reads generic bounds through their declaring receiver.
        /// @param targetType The symbolic imported receiver.
        /// @param parameter The reflected type or method parameter.
        /// @returns Receiver-projected annotated constraints.
        @NullabilityFunnel
        internal func GetClrGenericParameterConstraintTypeSymbols(targetType TypeSymbol, parameter Type) ImmutableArray[
            TypeSymbol
        ] {
            if GetProjectionReceiverImportedType(targetType) is {} imported &&
                TryGetSymbolicDeclaringContext(
                imported,
                parameter.DeclaringType,
                out var definition,
                out var arguments
            ) &&
                definition != nil {
                let method = parameter.DeclaringMethod as MethodInfo
                let openMethod = if method != nil {
                    TryGetOpenMethodOnDeclaringType(definition, method)
                } else {
                    nil
                }
                let openParameter = if openMethod != nil {
                    openMethod.GetGenericArguments()[parameter.GenericParameterPosition]
                } else {
                    if method == nil {
                        definition.GetGenericArguments()[parameter.GenericParameterPosition]
                    } else {
                        parameter
                    }
                }
                let methodArguments = (method?.GetGenericArguments() ?? []Type{}).Select(
                    (argument Type) -> cast[TypeSymbol?](
                        TypeSymbol.FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure)
                    )
                )
                    .ToImmutableArray()
                return ClrNullability.GetGenericParameterConstraintTypeSymbols(
                    openParameter,
                    (layout Type) -> MapOpenClrTypeToSymbolic(
                        layout,
                        definition,
                        arguments,
                        openMethod,
                        methodArguments
                    )
                )
            }
            return ClrNullability.GetGenericParameterConstraintTypeSymbols(parameter)
        }

        /// Resolves an imported method parameter through a symbolic receiver.
        /// @param targetType The symbolic imported receiver type.
        /// @param closedMethod The reflected method selected from the erased receiver.
        /// @param parameterIndex The zero-based parameter index.
        /// @returns The parameter type after symbolic receiver substitution.
        @NullabilityFunnel
        internal func GetClrMethodParameterTypeSymbol(
            targetType TypeSymbol,
            closedMethod MethodBase,
            parameterIndex int32
        ) TypeSymbol {
            if GetProjectionReceiverImportedType(targetType) is ImportedTypeSymbol imported &&
                TryGetSymbolicDeclaringContext(
                imported,
                closedMethod.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments
            ) &&
                openDefinition != nil {
                let openMethod MethodBase? = if closedMethod is MethodInfo methodInfo {
                    TryGetOpenMethodOnDeclaringType(openDefinition, methodInfo)
                } else {
                    ClrTypeUtilities.FindMetadataDefinition(
                        openDefinition,
                        closedMethod,
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
                    ) as MethodBase
                }
                let openParameters[]?ParameterInfo = openMethod?.GetParameters()
                if openParameters != nil && uint32(parameterIndex) < uint32(openParameters.Length) {
                    // Issue #3705 (family 2): as with the return slot above, the
                    // receiver substitution recovers the shape but drops the
                    // declaration's `[Nullable]` metadata. `[Nullable]` on a by-ref
                    // parameter annotates the POINTEE (by-ref contributes no
                    // nullability byte), which is why the flags are merged after
                    // peeling and before re-wrapping.
                    let openParameter = openParameters[parameterIndex]
                    let openParameterType = openParameter.ParameterType
                    let parameterFlags = ClrNullability.ReadNullableFlags(openParameter, openMethod)
                    if openParameterType.IsByRef {
                        let pointeeType = Invariant.Required(
                            openParameterType.GetElementType(),
                            "a by-ref parameter type has an element type",
                            expression: "openParameterType.GetElementType()"
                        )
                        return ByRefTypeSymbol.Get(
                            NullableFlagsBuilder.MergeDeclarationNullability(
                                MapOpenClrTypeToSymbolic(pointeeType, openDefinition, declaringTypeArguments),
                                pointeeType,
                                parameterFlags
                            )
                        )
                    }
                    return NullableFlagsBuilder.MergeDeclarationNullability(
                        MapOpenClrTypeToSymbolic(openParameterType, openDefinition, declaringTypeArguments),
                        openParameterType,
                        parameterFlags
                    )
                }
            }
            // Issue #3705 (family 2): same omission as GetClrMethodReturnTypeSymbol,
            // compounded — the bare `FromClrType` also failed to peel `ByRef`, so an
            // `out T` parameter reached callers as an `ImportedTypeSymbol` wrapping
            // `T&` rather than the `ByRefTypeSymbol` the symbolic branch above
            // returns. Callers that switch on `ByRefTypeSymbol` therefore took the
            // wrong arm on the reflected path only.
            let reflectedParameter = closedMethod.GetParameters()[parameterIndex]
            let reflectedType = ClrNullability.GetParameterTypeSymbol(reflectedParameter)
            return if reflectedParameter.ParameterType.IsByRef {
                cast[TypeSymbol](ByRefTypeSymbol.Get(reflectedType))
            } else {
                reflectedType
            }
        }

        /// Resolves an imported method parameter as a call-argument conversion
        /// target through both the receiver and method type arguments.
        /// @param targetType The symbolic imported receiver type.
        /// @param closedMethod The reflected method selected by overload resolution.
        /// @param parameterIndex The zero-based parameter index.
        /// @param methodTypeArguments The method's symbolic type arguments.
        /// @returns The projected, declaration-merged conversion target, or `null`
        /// when no receiver/method generic slot is substituted.
        @NullabilityFunnel
        internal func GetClrMethodParameterConversionTargetTypeSymbol(
            targetType TypeSymbol?,
            closedMethod MethodInfo,
            parameterIndex int32,
            methodTypeArguments ImmutableArray[TypeSymbol?]
        ) TypeSymbol? {
            var openDefinition Type? = nil
            var declaringTypeArguments = default(ImmutableArray[TypeSymbol])
            var openMethod MethodInfo? = nil
            let isExtension = HasExtensionAttribute(closedMethod)
            if isExtension {
                openMethod = if closedMethod.IsGenericMethod {
                    closedMethod.GetGenericMethodDefinition()
                } else {
                    closedMethod
                }
            } else if targetType != nil &&
                GetProjectionReceiverImportedType(targetType) is ImportedTypeSymbol imported &&
                TryGetSymbolicDeclaringContext(
                imported,
                closedMethod.DeclaringType,
                out openDefinition,
                out declaringTypeArguments
            ) &&
                openDefinition != nil {
                openMethod = TryGetOpenMethodOnDeclaringType(openDefinition, closedMethod)
            } else if closedMethod.IsGenericMethod {
                openMethod = if closedMethod.IsGenericMethodDefinition {
                    closedMethod
                } else {
                    closedMethod.GetGenericMethodDefinition()
                }
            } else {
                return nil
            }
            if openMethod != nil &&
                openMethod.IsGenericMethod == true &&
                openMethod.IsGenericMethodDefinition == false {
                openMethod = openMethod.GetGenericMethodDefinition()
            }
            let openParameters[]?ParameterInfo = openMethod?.GetParameters()
            if openMethod == nil || openParameters == nil || uint32(parameterIndex) >= uint32(openParameters.Length) {
                return nil
            }
            let openParameter = openParameters[parameterIndex]
            let openParameterType = openParameter.ParameterType
            let layout = if openParameterType.IsByRef {
                Invariant.Required(
                    openParameterType.GetElementType(),
                    "a by-ref parameter type has an element type",
                    expression: "openParameterType.GetElementType()"
                )
            } else {
                openParameterType
            }
            if !layout.ContainsGenericParameters {
                return nil
            }
            var effectiveMethodTypeArguments = methodTypeArguments
            if isExtension && targetType != nil && openMethod.IsGenericMethod {
                let receiverTypeArguments = InferSymbolicMethodTypeArguments(
                    openMethod,
                    ImmutableArray.Create[TypeSymbol?](targetType)
                )
                let methodTypeArgumentCount = if effectiveMethodTypeArguments.IsDefault {
                    0
                } else {
                    effectiveMethodTypeArguments.Length
                }
                let merged = ImmutableArray.CreateBuilder[TypeSymbol?](receiverTypeArguments.Length)
                for var i = 0; i < receiverTypeArguments.Length; i++ {
                    let methodTypeArgument TypeSymbol? = if i < methodTypeArgumentCount {
                        effectiveMethodTypeArguments[i]
                    } else {
                        default(TypeSymbol?)
                    }
                    merged.Add(
                        if methodTypeArgument != nil && methodTypeArgument != TypeSymbol.Error {
                            methodTypeArgument
                        } else {
                            receiverTypeArguments[i]
                        }
                    )
                }
                effectiveMethodTypeArguments = merged.MoveToImmutable()
            }
            // A CLR-inferred closure carries runtime types, not caller annotations.
            // Only the recovered symbolic argument for this slot supplies its contract.
            if layout.IsGenericParameter && layout.DeclaringMethod != nil {
                let slot = layout.GenericParameterPosition
                if effectiveMethodTypeArguments.IsDefaultOrEmpty ||
                    uint32(slot) >= uint32(effectiveMethodTypeArguments.Length) ||
                    effectiveMethodTypeArguments[slot] == nil ||
                    effectiveMethodTypeArguments[slot] == TypeSymbol.Error {
                    return nil
                }
            }
            if (
                effectiveMethodTypeArguments.IsDefaultOrEmpty || effectiveMethodTypeArguments.Any(
                    (type TypeSymbol?) -> type == nil || type == TypeSymbol.Error
                )
            ) &&
                !closedMethod
                .IsGenericMethodDefinition {
                let closedTypeArguments = BuildMethodTypeArgSymbolsFromClosedMethod(closedMethod)
                let effectiveCount = if effectiveMethodTypeArguments.IsDefault {
                    0
                } else {
                    effectiveMethodTypeArguments.Length
                }
                let closedCount = if closedTypeArguments.IsDefault {
                    0
                } else {
                    closedTypeArguments.Length
                }
                let count = Math.Max(effectiveCount, closedCount)
                let merged = ImmutableArray.CreateBuilder[TypeSymbol?](count)
                for var i = 0; i < count; i++ {
                    let symbolicType TypeSymbol? = if i < effectiveCount {
                        effectiveMethodTypeArguments[i]
                    } else {
                        default(TypeSymbol?)
                    }
                    merged.Add(
                        if symbolicType != nil && symbolicType != TypeSymbol.Error {
                            symbolicType
                        } else {
                            (
                                if i < closedCount {
                                    closedTypeArguments[i]
                                } else {
                                    default(TypeSymbol?)
                                }
                            )
                        }
                    )
                }
                effectiveMethodTypeArguments = merged.MoveToImmutable()
            }
            return GetClrOpenParameterPointeeTypeSymbol(
                openParameter,
                openDefinition,
                declaringTypeArguments,
                openMethod,
                effectiveMethodTypeArguments
            )
        }

        /// Issue #794 / ADR-0193 Phase 2: the receiver-projected return accessor
        /// (formerly `ExpressionBinder.ResolveInstanceReturnTypeFromReceiver`,
        /// moved into this family so every signature-position producer lives in
        /// one place). When an instance call is dispatched against a receiver
        /// whose (cref:ImportedTypeSymbol) carries symbolic type arguments
        /// (e.g. `List[T]`, `Dictionary[K, V]`) — including the open
        /// in-scope type-parameter case from #313/#671 — substitute the open
        /// declaring type's return type using the receiver's symbolic arguments.
        /// Without this override the call's return type comes from the
        /// type-erased closed shape (`List<object>.ToArray()` →
        /// `object[]`), losing the symbolic projection (`T[]`).
        /// Returns `null` when no override is needed so callers
        /// keep their existing return-type derivation.
        /// @param receiverType The receiver's static type symbol.
        /// @param closedMethod The closed method selected by overload resolution.
        /// @returns The override return type symbol, or `null`.
        @NullabilityFunnel
        internal func GetClrReceiverProjectedReturnTypeSymbol(
            receiverType TypeSymbol,
            closedMethod MethodInfo?
        ) TypeSymbol? {
            if GetProjectionReceiverImportedType(receiverType) is not ImportedTypeSymbol imp ||
                imp.OpenDefinition == nil ||
                imp
                .TypeArguments
                .IsDefaultOrEmpty ||
                closedMethod == nil {
                return nil
            }
            let openMethod MethodInfo? = TryGetOpenInstanceMethod(imp.OpenDefinition, closedMethod)
            if openMethod == nil {
                return nil
            }
            let openReturn Type? = openMethod.ReturnType
            if openReturn == nil || openReturn.IsSameAs(typeof(Void)) {
                return nil
            }
            // Issue #3712 follow-up: the receiver only closes the DECLARING TYPE's
            // parameters. When the selected method is itself generic its own
            // (method-level) parameters must be substituted from the closed method,
            // or the projection returns the open shape — `List<TOutput>` for
            // `List[Token].ConvertAll(...)` — and, because this override is
            // consulted BEFORE the plain CLR return type, that open shape became
            // the call's bound type and every use of it reported GS0156.
            return GetClrOpenMethodReturnTypeSymbol(
                openMethod,
                imp.OpenDefinition,
                imp.TypeArguments,
                BuildMethodTypeArgSymbolsFromClosedMethod(closedMethod)
            )
        }

        /// Issue #1107: the by-ref-parameter counterpart of
        /// (cref:GetClrReceiverProjectedReturnTypeSymbol). When a call is
        /// dispatched against a receiver whose (cref:ImportedTypeSymbol)
        /// carries symbolic type arguments (e.g. `Dictionary[K, V]`),
        /// substitute the open declaring type's parameter pointee type using the
        /// receiver's symbolic arguments. Without this an inline `out var`
        /// argument against a generic by-ref parameter (e.g. the `out TValue`
        /// of `Dictionary<K, V>.TryGetValue`) would bind from the
        /// type-erased closed shape (`out object`), losing the symbolic
        /// projection (the same-compilation user element type) and reporting
        /// `GS0158` on a subsequent member access of the out-var local.
        /// Returns `null` when no override is needed so callers keep
        /// their existing pointee derivation.
        /// @param receiverType The receiver's static type symbol.
        /// @param closedMethod The closed method selected by overload resolution.
        /// @param paramIndex The zero-based parameter position to recover.
        /// @returns The override pointee type symbol, or `null`.
        @NullabilityFunnel
        internal func GetClrReceiverProjectedParameterPointeeTypeSymbol(
            receiverType TypeSymbol?,
            closedMethod MethodInfo?,
            paramIndex int32
        ) TypeSymbol? {
            if receiverType == nil ||
                GetProjectionReceiverImportedType(receiverType) is not ImportedTypeSymbol imp ||
                imp.OpenDefinition == nil ||
                imp
                .TypeArguments
                .IsDefaultOrEmpty ||
                closedMethod == nil ||
                paramIndex < 0 {
                return nil
            }
            let openMethod MethodInfo? = TryGetOpenInstanceMethod(imp.OpenDefinition, closedMethod)
            if openMethod == nil {
                return nil
            }
            let openParameters = openMethod.GetParameters()
            if paramIndex >= openParameters.Length {
                return nil
            }
            // Issue #3712 follow-up (sibling of the return accessor above, #3705):
            // substitute the method's OWN generic parameters too, so an `out`
            // parameter of a generic method on a symbolically-constructed receiver
            // (e.g. `Dictionary[K, V].TryAdd`-shaped generic members) does not
            // project to the open method type parameter.
            return GetClrOpenParameterPointeeTypeSymbol(
                openParameters[paramIndex],
                imp.OpenDefinition,
                imp.TypeArguments,
                openMethod,
                BuildMethodTypeArgSymbolsFromClosedMethod(closedMethod)
            )
        }

        /// ADR-0193 Phase 2: an OPEN method's return type projected through
        /// symbolic type arguments with the declaration's `[Nullable]`
        /// merged — the projection-plus-merge every receiver-projected return
        /// reader shares. A `ref T` return is peeled before the merge and
        /// re-wrapped after it: `[Nullable]` on a by-ref annotates the
        /// pointee (the ADR-0193 §4 finding on `GetClrMethodReturnTypeSymbol`).
        /// @param openMethod The method on the open definition.
        /// @param openDefinition The open declaring type the type-level parameters bind against.
        /// @param typeArguments The declaring type's symbolic arguments.
        /// @param methodTypeArguments The method's own symbolic arguments; default when it is not generic.
        /// @returns The projected, merged return type.
        @NullabilityFunnel
        internal func GetClrOpenMethodReturnTypeSymbol(
            openMethod MethodInfo,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol],
            methodTypeArguments ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
        ) TypeSymbol {
            let openReturn = openMethod.ReturnType
            let layout = if openReturn.IsByRef {
                Invariant.Required(
                    openReturn.GetElementType(),
                    "a by-ref return type has an element type",
                    expression: "openReturn.GetElementType()"
                )
            } else {
                openReturn
            }
            let merged = NullableFlagsBuilder.MergeDeclarationNullability(
                MapOpenClrTypeToSymbolic(
                    layout,
                    openDefinition,
                    typeArguments,
                    if methodTypeArguments.IsDefault {
                        default(MethodInfo?)
                    } else {
                        openMethod
                    },
                    methodTypeArguments
                ),
                layout,
                ClrNullability.ReadNullableFlags(openMethod.ReturnParameter, openMethod)
            )
            return if openReturn.IsByRef {
                cast[TypeSymbol](ByRefTypeSymbol.Get(merged))
            } else {
                merged
            }
        }

        /// ADR-0193 Phase 2: an OPEN parameter's value (pointee) type projected
        /// through symbolic type arguments with the declaration's `[Nullable]`
        /// merged. A by-ref parameter is peeled, as
        /// the projection peels it — G# keeps the
        /// pointee and the (cref:RefKind) apart — and `[Nullable]` on a
        /// by-ref annotates the pointee.
        /// @param openParameter The parameter on the open method.
        /// @param openDefinition The open declaring type the type-level parameters bind against.
        /// @param typeArguments The declaring type's symbolic arguments.
        /// @param openMethod The open generic method, when its own parameters are substituted.
        /// @param methodTypeArguments The method's own symbolic arguments; default when none.
        /// @returns The projected, merged parameter value type.
        @NullabilityFunnel
        internal func GetClrOpenParameterPointeeTypeSymbol(
            openParameter ParameterInfo,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol],
            openMethod MethodInfo? = nil,
            methodTypeArguments ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
        ) TypeSymbol {
            let openType = openParameter.ParameterType
            let layout = if openType.IsByRef {
                Invariant.Required(
                    openType.GetElementType(),
                    "a by-ref parameter type has an element type",
                    expression: "openType.GetElementType()"
                )
            } else {
                openType
            }
            return NullableFlagsBuilder.MergeDeclarationNullability(
                MapOpenClrTypeToSymbolic(layout, openDefinition, typeArguments, openMethod, methodTypeArguments),
                layout,
                ClrNullability.ReadNullableFlags(openParameter, openParameter.Member)
            )
        }

        /// ADR-0193 Phase 2: (cref:GetClrOpenParameterPointeeTypeSymbol)
        /// with a by-ref parameter re-wrapped as a (cref:ByRefTypeSymbol),
        /// the shape (cref:MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}))
        /// gives a by-ref type.
        /// @param openParameter The parameter on the open method.
        /// @param openDefinition The open declaring type the type-level parameters bind against.
        /// @param typeArguments The declaring type's symbolic arguments.
        /// @returns The projected, merged parameter type.
        internal func GetClrOpenParameterTypeSymbol(
            openParameter ParameterInfo,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol]
        ) TypeSymbol {
            let pointee = GetClrOpenParameterPointeeTypeSymbol(openParameter, openDefinition, typeArguments)
            return if openParameter.ParameterType.IsByRef {
                cast[TypeSymbol](ByRefTypeSymbol.Get(pointee))
            } else {
                pointee
            }
        }

        /// ADR-0193 Phase 2: an OPEN parameter projected as an argument's
        /// conversion target (formerly the projection in
        /// `ConversionClassifier.TrySubstituteParameterType*` plus
        /// `ConversionClassifier.PreserveParameterTopLevelNullability`, moved
        /// inside the funnel). The by-ref pointee is projected through the
        /// symbolic arguments, and only a delegate-typed parameter's top-level
        /// `?` is merged from the declaration, so an argument may convert to
        /// a stated-nullable callback slot.
        ///
        /// This is deliberately <b>not</b> the full merge
        /// (cref:GetClrOpenParameterPointeeTypeSymbol) does. The full merge
        /// would also stamp a concrete oblivious position's `!` onto a
        /// projection with symbolic method type arguments, which the projection's
        /// consumers do not peel yet — the same blocker as
        /// (cref:ResolveCallReturnTypeFromSymbolicTypeArgs), lifted by
        /// ADR-0193 Phase 3 and closed in Phase 4.
        /// @param openParameter The parameter on the open method or constructor.
        /// @param openDefinition The open declaring type the type-level parameters bind against.
        /// @param typeArguments The declaring type's symbolic arguments.
        /// @param openMethod The open generic method, when its own parameters are substituted.
        /// @param methodTypeArguments The method's own symbolic arguments; default when none.
        /// @returns The projected conversion target.
        @NullabilityFunnel
        internal func GetClrOpenParameterConversionTargetTypeSymbol(
            openParameter ParameterInfo,
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol],
            openMethod MethodInfo? = nil,
            methodTypeArguments ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
        ) TypeSymbol {
            let openType = openParameter.ParameterType
            let layout = if openType.IsByRef {
                Invariant.Required(
                    openType.GetElementType(),
                    "a by-ref parameter type has an element type",
                    expression: "openType.GetElementType()"
                )
            } else {
                openType
            }
            let mapped = MapOpenClrTypeToSymbolic(
                layout,
                openDefinition,
                typeArguments,
                openMethod,
                methodTypeArguments
            )
            if mapped == TypeSymbol.Error || mapped is NullableTypeSymbol || !ClrTypeUtilities.IsDelegateType(
                openType
            ) {
                return mapped
            }
            // ADR-0193 Phase 1: classify, never compare bytes by hand. An empty
            // array classifies as Oblivious.
            let state = ClrNullability.ClassifyPosition(
                ClrNullability.ReadNullableFlags(openParameter, openParameter.Member),
                0
            )
            return if state == ClrNullabilityState.Annotated {
                NullabilityImportRule.ApplyConcrete(mapped, state)
            } else {
                mapped
            }
        }

        internal func GetImportedMethodForEmission(
            method MethodInfo
        ) MethodInfo -> if OpenMethodsByMappedMethod.TryGetValue(method, out var openMethod) {
            openMethod
        } else {
            method
        }

        /// Finds the symbolic generic context for a reflected declaring type.
        /// @param imported The symbolic imported receiver.
        /// @param declaringType The reflected member's declaring type.
        /// @param openDefinition The open declaring type definition.
        /// @param typeArguments The receiver-projected declaring type arguments.
        /// @returns `true` when a symbolic declaring context was found.
        @NullabilityFunnel
        internal func TryGetSymbolicDeclaringContext(
            imported ImportedTypeSymbol,
            declaringType Type?,
            out openDefinition Type?,
            out typeArguments ImmutableArray[TypeSymbol]
        ) bool -> TryGetSymbolicDeclaringContextCore(imported, declaringType, out openDefinition, out typeArguments, 0)

        @NullabilityFunnel
        private func TryGetSymbolicDeclaringContextCore(
            imported ImportedTypeSymbol,
            declaringType Type?,
            out openDefinition Type?,
            out typeArguments ImmutableArray[TypeSymbol],
            depth int32,
            unsuccessful HashSet[(Type, string)]? = nil
        ) bool {
            openDefinition = nil
            typeArguments = default(ImmutableArray[TypeSymbol])
            if imported?.ClrType == nil || declaringType == nil {
                return false
            }
            if depth >= 256 {
                throw System.IO.InvalidDataException("CLR declaring hierarchy exceeds the metadata complexity limit")
            }
            let receiverOpenDefinition = imported.OpenDefinition ??
                (
                if imported.ClrType!!.IsGenericType {
                    imported.ClrType!!.GetGenericTypeDefinition()
                } else {
                    imported.ClrType!!
                }
            )
            let receiverTypeArguments = if !imported.TypeArguments.IsDefaultOrEmpty {
                imported.TypeArguments
            } else {
                (
                    if imported.ClrType!!.IsGenericType {
                        imported.ClrType!!
                            .GetGenericArguments()
                            .Select(
                            (argument Type) -> TypeSymbol.FromClrTypeWithoutNullability(
                                argument,
                                NullabilityFreeReason.TypeStructure
                            )
                        )
                            .ToImmutableArray()
                    } else {
                        ImmutableArray[TypeSymbol].Empty
                    }
                )
            }
            openDefinition = if declaringType.IsGenericType {
                declaringType.GetGenericTypeDefinition()
            } else {
                declaringType
            }
            if HaveSameDeclaringIdentity(receiverOpenDefinition, openDefinition) {
                // Root members can retain the receiver's cached erasure. Ancestor paths must match the current constructed identity.
                if declaringType.IsGenericType &&
                    !declaringType.IsGenericTypeDefinition &&
                    !HaveSameDeclaringIdentity(imported.ReifyClosedClrType(), declaringType) &&
                    (depth != 0 || !HaveSameDeclaringIdentity(imported.ClrType, declaringType)) {
                    return false
                }
                CompilationMeasurements.Count("metadata.receiver-context-visits")
                typeArguments = receiverTypeArguments
                return true
            }
            let misses = unsuccessful ?? HashSet[(Type, string)]()
            let key = (imported.ClrType!!, Convert.ToBase64String(NullableFlagsBuilder.Build(imported).ToArray()))
            if misses.Contains(key) {
                return false
            }
            CompilationMeasurements.Count("metadata.receiver-context-visits")
            {
                let symbolicBase = ClrNullability.GetBaseTypeSymbol(
                    receiverOpenDefinition,
                    (layout Type) -> MapOpenClrTypeToSymbolic(layout, receiverOpenDefinition, receiverTypeArguments)
                )
                if symbolicBase != nil &&
                    GetProjectionReceiverImportedType(symbolicBase) is {} baseReceiver &&
                    TryGetSymbolicDeclaringContextCore(
                    baseReceiver,
                    declaringType,
                    out var baseDefinition,
                    out var baseArguments,
                    depth + 1,
                    misses
                ) {
                    openDefinition = baseDefinition
                    typeArguments = baseArguments
                    return true
                }
            }
            if declaringType.IsInterface {
                var interfaces = ImmutableArray[TypeSymbol].Empty
                try {
                    interfaces = ClrNullability.GetInterfaceTypeSymbols(
                        receiverOpenDefinition,
                        (layout Type) -> MapOpenClrTypeToSymbolic(layout, receiverOpenDefinition, receiverTypeArguments)
                    )
                } catch (error Exception) when error is System
                    .IO
                    .InvalidDataException ||
                    error is System
                    .IO
                    .IOException ||
                    error is BadImageFormatException ||
                    error is NotSupportedException {
                    // Marked contracts diagnose unreadable relationship metadata during import preflight.
                    ClrNullability.RecordMetadataReadFailure()
                }
                for signature in interfaces {
                    if GetProjectionReceiverImportedType(signature) is {} interfaceReceiver &&
                        TryGetSymbolicDeclaringContextCore(
                        interfaceReceiver,
                        declaringType,
                        out var interfaceDefinition,
                        out var interfaceArguments,
                        depth + 1,
                        misses
                    ) {
                        openDefinition = interfaceDefinition
                        typeArguments = interfaceArguments
                        return true
                    }
                }
            }
            if depth > 0 {
                // Cache only misses; successful projections retain their own symbolic arguments.
                misses.Add(key)
                return false
            }
            if imported.OpenDefinition != nil &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty &&
                TryMapThroughImplemented(imported, openDefinition!!, out typeArguments) {
                return true
            }
            if declaringType.IsGenericType {
                typeArguments = declaringType
                    .GetGenericArguments()
                    .Select(
                    (argument Type) -> TypeSymbol.FromClrTypeWithoutNullability(
                        argument,
                        NullabilityFreeReason.TypeStructure
                    )
                )
                    .ToImmutableArray()
                return true
            }
            typeArguments = ImmutableArray[TypeSymbol].Empty
            return true
        }

        private func HaveSameDeclaringIdentity(left Type?, right Type?) bool {
            if object.ReferenceEquals(left, right) {
                return true
            }
            if left == nil || right == nil {
                return false
            }
            if (!left.ContainsGenericParameters && !right.ContainsGenericParameters) ||
                (left.IsGenericTypeDefinition && right.IsGenericTypeDefinition) {
                return TypeIdentityComparer.Instance.Equals(left, right)
            }
            // Open constructions have no qualified name. Compare their structure without using a name-only fallback.
            if left.HasElementType || right.HasElementType {
                return left.IsArray == right.IsArray &&
                    left.IsByRef == right.IsByRef &&
                    left.IsPointer == right.IsPointer &&
                    (
                    !left.IsArray || (left.IsSZArray == right.IsSZArray && left.GetArrayRank() == right.GetArrayRank())
                ) &&
                    HaveSameDeclaringIdentity(left.GetElementType(), right.GetElementType())
            }
            if !left.IsGenericType ||
                !right.IsGenericType ||
                left.IsGenericTypeDefinition ||
                right.IsGenericTypeDefinition {
                return false
            }
            if !TypeIdentityComparer.Instance.Equals(
                left.GetGenericTypeDefinition(),
                right.GetGenericTypeDefinition()
            ) {
                return false
            }
            let leftArguments = left.GetGenericArguments()
            let rightArguments = right.GetGenericArguments()
            if leftArguments.Length != rightArguments.Length {
                return false
            }
            for var index = 0; index < leftArguments.Length; index++ {
                if !HaveSameDeclaringIdentity(leftArguments[index], rightArguments[index]) {
                    return false
                }
            }
            return true
        }

        /// Unwraps an imported type from an optional CLR nullability annotation.
        /// @param type The type symbol to unwrap.
        /// @returns The imported type symbol, or `null` for another symbol kind.
        internal func GetImportedTypeSymbol(type TypeSymbol) ImportedTypeSymbol? -> switch type {
            case imported is ImportedTypeSymbol: imported
            case NullabilityAnnotatedTypeSymbol{BaseType: ImportedTypeSymbol imported}: imported
            default: default(ImportedTypeSymbol?)
        }

        /// Issue #3815: the imported type whose generic arguments a member read
        /// through [`type`](paramref) must be projected with.
        ///
        /// For an imported receiver that is just (cref:GetImportedTypeSymbol).
        /// A USER class deriving from an imported generic base
        /// (`class Wrap[T] : Channel[T]`) inherits that base's members, and the
        /// base's own type arguments are carried SYMBOLICALLY on
        /// (cref:StructSymbol.ImportedBaseType) — the base's
        /// reflected `ClrType` is the erased
        /// `Channel<object>`. Reflecting the inherited member off that
        /// erased type and reading its type straight from metadata therefore bound
        /// `Reader` as `ChannelReader[object]` instead of
        /// `ChannelReader[T]`. Walking to the nearest imported base lets the
        /// existing symbolic-projection machinery substitute the real arguments,
        /// exactly as it already does when the receiver IS the imported type.
        ///
        /// Issue #4066: a (cref:NullabilityAnnotatedTypeSymbol) receiver
        /// carries the per-argument nullable flags that its imported base cannot
        /// represent. Rebuild the same symbolic construction the field path used
        /// to build locally, so every member kind projects through one faithful
        /// receiver instead of the erased closed CLR type.
        /// @param type The receiver type a member was reflected through.
        /// @returns The imported type carrying the symbolic arguments, or `null`.
        internal func GetProjectionReceiverImportedType(type TypeSymbol) ImportedTypeSymbol? {
            if type is PlatformTypeSymbol platform {
                return GetProjectionReceiverImportedType(platform.UnderlyingType)
            }
            let imported ImportedTypeSymbol? = GetImportedTypeSymbol(type)
            let receiverClr Type? = imported?.ClrType
            if type is NullabilityAnnotatedTypeSymbol annotated &&
                receiverClr != nil &&
                receiverClr.IsGenericType &&
                !receiverClr
                .IsGenericTypeDefinition {
                let receiverArguments = receiverClr
                    .GetGenericArguments()
                    .Select((_ Type, index int32) -> annotated.GetTypeArgumentSymbol(index))
                    .ToImmutableArray()
                return ImportedTypeSymbol.GetConstructed(
                    receiverClr,
                    imported?.OpenDefinition ?? receiverClr.GetGenericTypeDefinition(),
                    receiverArguments
                )
            }
            return imported ??
                TryGetClosedMapProjectionView(type) ??
                (
                if type is StructSymbol userClass {
                    TypeMemberModel.GetNearestImportedBase(userClass) as ImportedTypeSymbol
                } else {
                    default(ImportedTypeSymbol?)
                }
            )
        }

        /// Issue #4033: the `Dictionary[K, V]` view of a CLOSED
        /// `map[K, V]`, so a member read through the map spelling projects
        /// through the receiver's symbolic arguments exactly as the
        /// `Dictionary[K, V]` spelling of the SAME type does (ADR-0104 says
        /// they ARE one type).
        /// @remarks (cref:TryGetSymbolicOpenMapReceiverView) is the OPEN twin
        /// and deliberately refuses a map with a CLR type, because an open map has
        /// no other way to reach the dictionary surface. A closed map does reach
        /// it — by reflection off its own `ClrType` — but arrives as a
        /// (cref:MapTypeSymbol), which is neither an
        /// (cref:ImportedTypeSymbol) nor a (cref:StructSymbol), so
        /// every projector above answered `null` and the member's
        /// type was read straight from declaration metadata. For
        /// `.Keys`/`.Values` that metadata is a placeholder at the
        /// TKey/TValue positions, so `for v in m.Values { v.Length }` lost the
        /// element's property surface for the map spelling alone, after the
        /// `Dictionary` spelling had already been fixed.
        ///
        /// The open definition comes from the map's OWN `ClrType` rather
        /// than the host `typeof(Dictionary<,>)`: issue #4023 gave a map
        /// over an imported key or value a backing dictionary built inside that
        /// key/value's `MetadataLoadContext`, and a member reflected off a
        /// context type must be described by that same context's open definition —
        /// mixing the two is what #4023 was about.
        /// @param type The receiver type a member was reflected through.
        /// @returns The symbolic dictionary view, or `null`.
        internal func TryGetClosedMapProjectionView(type TypeSymbol) ImportedTypeSymbol? {
            if type is not MapTypeSymbol map_ ||
                map_.ClrType is not{IsGenericType: true, IsGenericTypeDefinition: false} mapClr {
                return nil
            }
            return ImportedTypeSymbol.GetConstructed(
                mapClr,
                mapClr.GetGenericTypeDefinition(),
                ImmutableArray.Create(map_.KeyType, map_.ValueType)
            )
        }

        internal func FindOpenIndexerDefinition(openDefinition Type?, closedIndexer PropertyInfo) PropertyInfo? {
            if openDefinition == nil {
                return nil
            }
            // ADR-0193 §4: static properties too. `Comparer[string?].Default` and
            // `ImmutableArray[string?].Empty` are reached through a symbolic
            // receiver like any instance property, and without the open
            // definition they fell back to the ERASED read and lost the receiver's
            // `?` — the reader-agreement test found every static property of a
            // generic type disagreeing with the merge this way.
            let candidates = ClrTypeUtilities.SafeGetProperties(
                openDefinition,
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static
            )
            let token = closedIndexer.MetadataToken
            for candidate in candidates {
                if candidate.MetadataToken == token {
                    return candidate
                }
            }
            let closedParameters = closedIndexer.GetIndexParameters()
            for candidate in candidates {
                if !string.Equals(candidate.Name, closedIndexer.Name, StringComparison.Ordinal) {
                    continue
                }
                let openParameters = candidate.GetIndexParameters()
                if openParameters.Length != closedParameters.Length {
                    continue
                }
                var matches = true
                for var i = 0; i < openParameters.Length; i++ {
                    let openType = openParameters[i].ParameterType
                    let closedType = closedParameters[i].ParameterType
                    if !openType.IsGenericParameter && !ClrTypeUtilities.AreSame(openType, closedType) {
                        matches = false
                        break
                    }
                }
                if matches {
                    return candidate
                }
            }
            return nil
        }

        internal func MergeInferredTypeArgument(
            existing TypeSymbol?,
            incoming TypeSymbol?
        ) TypeSymbol? -> MergeRecoveredTypeArgument(existing, incoming)

        internal func InferSourceTypeArgument(
            substitution Dictionary[TypeParameterSymbol, TypeSymbol],
            parameter TypeParameterSymbol,
            argument TypeSymbol,
            kind SymbolicInferenceBoundKind
        ) {
            let state = sourceInferenceBounds.GetValue(
                substitution,
                (seed Dictionary[TypeParameterSymbol, TypeSymbol]) -> SourceInferenceState(seed)
            )
            // Owner and receiver bindings precede inference. Only newly inferred
            // parameters may receive bounds, keyed by symbol identity.
            if state.FixedParameters.Contains(parameter) {
                return
            }
            let byParameter = state.Bounds
            if !byParameter.TryGetValue(parameter, out var bounds) {
                bounds = SourceInferenceBounds()
                byParameter[parameter] = bounds
            }
            switch kind {
                case SymbolicInferenceBoundKind.Exact {
                    bounds.Exact = MergeRecoveredTypeArgument(bounds.Exact, argument, allowBaseWidening: false)
                }
                case SymbolicInferenceBoundKind.Upper {
                    bounds.Upper.Add(argument)
                }
                case SymbolicInferenceBoundKind.MethodGroupUpper {
                    return
                }
                default {
                    bounds.Lower = MergeRecoveredTypeArgument(bounds.Lower, argument)
                }
            }
            // Each summary retains the ordered fold without replaying earlier bounds.
            // Upper evidence cannot widen lower evidence or replace an exact bound.
            var fixedType = bounds.Exact ?? bounds.Lower
            // Keep the earlier binding when lower and exact evidence conflict.
            // Applicability must diagnose the conflicting argument, not an earlier valid argument.
            if bounds.Exact is {} exact &&
                bounds.Lower is {} lower &&
                !HasImplicitSymbolicConversion(lower, exact) &&
                substitution.TryGetValue(parameter, out var previous) {
                fixedType = previous
            }
            if fixedType == nil && bounds.Upper.Count > 0 {
                fixedType = FindSymbolicInferenceCandidate(nil, bounds.Upper) ?? bounds.Upper[0]
            }
            if fixedType != nil {
                substitution[parameter] = fixedType
            }
        }

        internal func IsSymbolicInferenceConflict(type TypeSymbol?) bool -> object.ReferenceEquals(
            type,
            SymbolicInferenceConflict
        )

        internal func TryMapConstructedTypeArgumentsThroughHierarchy(
            source ImportedTypeSymbol,
            targetOpenDefinition Type,
            out mappedArguments ImmutableArray[TypeSymbol]
        ) bool -> TryMapThroughImplemented(source, targetOpenDefinition, out mappedArguments)

        /// Maps every occurrence of [`targetOpenDefinition`](paramref) in a
        /// CLR-backed type's base/interface closure and succeeds only when all
        /// occurrences project the same symbolic type arguments. The source's
        /// positions come from (cref:TypeSymbol.GetElementPositions), so
        /// metadata nullability survives the hierarchy walk. This is the
        /// inference-specific counterpart to
        /// (cref:TryMapConstructedTypeArgumentsThroughHierarchy): conversions
        /// may select a particular closed interface, while inference must not choose
        /// arbitrarily between conflicting projections.
        /// @param source CLR-backed source type.
        /// @param targetOpenDefinition Open generic type being inferred against.
        /// @param mappedArguments Unique projected symbolic arguments on success.
        /// @param foundProjection Whether at least one matching projection was found, including conflicting
        /// matches.
        /// @returns `true` when one or more matching projections agree.
        internal func TryMapUniqueConstructedTypeArgumentsThroughHierarchy(
            source TypeSymbol,
            targetOpenDefinition Type,
            out mappedArguments ImmutableArray[TypeSymbol],
            out foundProjection bool
        ) bool {
            mappedArguments = default(ImmutableArray[TypeSymbol])
            foundProjection = false
            if source.ClrType is {IsArray: true} sourceArray && sourceArray.GetArrayRank() == 1 &&
                Conversion
                .IsArrayElementInterface(targetOpenDefinition) {
                let positions = source.GetElementPositions()
                if positions.Length == 1 {
                    mappedArguments = positions
                    foundProjection = true
                    return true
                }
            }
            var sourceOpenDefinition Type?
            var sourceArguments ImmutableArray[TypeSymbol]
            if source is ImportedTypeSymbol{OpenDefinition: {} importedOpen} imported {
                sourceOpenDefinition = importedOpen
                sourceArguments = imported.TypeArguments
            } else if source.ClrType is {} sourceClr {
                sourceOpenDefinition = if sourceClr.IsGenericType && !sourceClr.IsGenericTypeDefinition {
                    sourceClr.GetGenericTypeDefinition()
                } else {
                    sourceClr
                }
                sourceArguments = source.GetElementPositions()
            } else {
                return false
            }
            let VectorsEquivalent = func (left ImmutableArray[TypeSymbol], right ImmutableArray[TypeSymbol]) bool {
                if left.Length != right.Length {
                    return false
                }
                for var i = 0; i < left.Length; i++ {
                    if !DeclarationBinder.TypeSignaturesEquivalent(left[i], right[i]) {
                        return false
                    }
                }
                return true
            }
            for candidate in EnumerateOpenInterfacesAndBases(sourceOpenDefinition!!) {
                var candidateDefinition Type
                try {
                    if !candidate.IsGenericType {
                        continue
                    }
                    candidateDefinition = if candidate.IsGenericTypeDefinition {
                        candidate
                    } else {
                        candidate.GetGenericTypeDefinition()
                    }
                } catch (Exception) {
                    continue
                }
                if !ClrTypeUtilities.AreSame(candidateDefinition, targetOpenDefinition) {
                    continue
                }
                var candidateArguments[]Type
                try {
                    candidateArguments = candidate.GetGenericArguments()
                } catch (Exception) {
                    continue
                }
                let builder = ImmutableArray.CreateBuilder[TypeSymbol](candidateArguments.Length)
                for argument in candidateArguments {
                    builder.Add(
                        MapOpenClrTypeToSymbolicWithoutNullability(
                            argument,
                            sourceOpenDefinition,
                            sourceArguments,
                            NullabilityFreeReason.TypeStructure
                        )
                    )
                }
                let projectedArguments = builder.MoveToImmutable()
                if !foundProjection {
                    mappedArguments = projectedArguments
                    foundProjection = true
                    continue
                }
                if !VectorsEquivalent(mappedArguments, projectedArguments) {
                    mappedArguments = default(ImmutableArray[TypeSymbol])
                    return false
                }
            }
            return foundProjection
        }

        internal func TryProjectConstructedHierarchyClrType(
            source ImportedTypeSymbol?,
            targetOpenDefinition Type?,
            out projectedType Type?
        ) bool {
            projectedType = nil
            if source == nil ||
                targetOpenDefinition == nil ||
                !targetOpenDefinition.IsGenericTypeDefinition ||
                !TryMapThroughImplemented(source, targetOpenDefinition, out var mappedArguments) {
                return false
            }
            let projectedArguments = [mappedArguments.Length]Type
            let contextObject = ResolveErasedObjectInContext(targetOpenDefinition)
            for var i = 0; i < mappedArguments.Length; i++ {
                if !TryProjectErasedClrType(mappedArguments[i], out var projectedArgument) || projectedArgument == nil {
                    return false
                }
                projectedArguments[i] = projectedArgument
                if projectedArgument.IsSameAs(typeof(object)) {
                    projectedArguments[i] = contextObject
                }
            }
            if ClrTypeUtilities.MakeGenericTypeIsRejectedAcrossContexts(targetOpenDefinition, projectedArguments) {
                return false
            }
            try {
                projectedType = targetOpenDefinition.MakeGenericType(projectedArguments)
                return !projectedType!!.ContainsGenericParameters
            } catch {
                projectedType = nil
                return false
            }
        }

        /// Issue #4036 (review finding): maps each SOURCE argument index to the
        /// parameter position it actually binds to on [`candidate`](paramref),
        /// so a caller holding arguments in source order can compare them against
        /// parameters in declaration order.
        /// @remarks This is the exact hazard #4026 hit one inference over
        /// (`BuildSymbolicMethodTypeArgs` zipped open parameters with symbolic
        /// arguments positionally, and a named call defeated it), and it is
        /// resolved the same way: through
        /// `ClrOverloadResolution.TryBuildNamedArgumentReordering`, the
        /// resolver's own mapping, so no second implementation can drift from
        /// it.
        ///
        /// Three outcomes, and the middle one is the reason this is a helper
        /// rather than a call to the reordering directly. `true` with a null
        /// mapping means "nothing to reorder" — the call named no argument, so
        /// source order IS parameter order. `true` with a mapping means the
        /// names bound. `false` means the call DID name an argument and the
        /// names do not bind against this candidate, which is not a licence to fall
        /// back on positional order — it means this candidate cannot take this
        /// call at all.
        /// @param candidate The candidate whose parameter names the argument names bind against.
        /// @param argumentCount The number of source arguments.
        /// @param argumentNames The per-source-index names; null entries are positional.
        /// @param mapping The source-index to parameter-position mapping, or null when none is needed.
        /// @returns Whether the arguments bind to this candidate's parameters at all.
        private func TryMapSourceArgumentsToParameters(
            candidate MethodInfo,
            argumentCount int32,
            argumentNames IReadOnlyList[string?]?,
            out mapping[]?int32
        ) bool {
            mapping = nil
            if argumentNames == nil {
                return true
            }
            if ClrOverloadResolution.TryBuildNamedArgumentReordering(
                candidate,
                argumentCount,
                argumentNames,
                out var built
            ) {
                mapping = built
                return true
            }
            // The reordering answers false both for "no named argument at all" and
            // for "the names do not bind here". Only the first is benign.
            for var i = 0; i < argumentNames.Count; i++ {
                if argumentNames[i] != nil {
                    return false
                }
            }
            return true
        }

        /// Issue #2859: resolves the element type of an imported (CLR) enumerator
        /// such as `IEnumerator[T]` or `List[T].Enumerator`. Prefers the
        /// symbolic type argument over the reflected `Current` property
        /// because a constructed generic closed over a same-compilation type is
        /// deliberately erased to the `<object>` shape on
        /// (cref:TypeSymbol.ClrType) (#313/#939).
        /// @param enumeratorType The enumerator type returned by `GetEnumerator()`.
        /// @param elementType The element (cref:TypeSymbol), on success.
        /// @returns `true` when the enumerator shape matches.
        private func TryGetClrEnumeratorElementType(enumeratorType TypeSymbol, out elementType TypeSymbol?) bool {
            elementType = nil
            let enumeratorClr Type? = enumeratorType.ClrType
            if enumeratorClr == nil {
                return false
            }
            let moveNext MethodInfo? = SafeGetMethodIncludingSelfAndInterfaces(
                enumeratorClr,
                "MoveNext",
                Type.EmptyTypes
            )
            let current PropertyInfo? = SafeGetPropertyIncludingSelfAndInterfaces(enumeratorClr, "Current")
            if moveNext == nil || current == nil {
                return false
            }
            if enumeratorType is ImportedTypeSymbol imported &&
                imported.HasSubstitutableTypeArgument &&
                imported.OpenDefinition != nil &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                let openCurrent PropertyInfo? = SafeGetPropertyIncludingSelfAndInterfaces(
                    imported.OpenDefinition,
                    "Current"
                )
                if openCurrent != nil {
                    let mapped TypeSymbol? = GetClrMemberValueTypeSymbol(
                        openCurrent,
                        imported.OpenDefinition,
                        imported.TypeArguments
                    )
                    if mapped != nil && mapped != TypeSymbol.Error {
                        elementType = mapped
                        return true
                    }
                }
            }
            elementType = GetClrMemberValueTypeSymbol(current)
            return elementType != nil && elementType != TypeSymbol.Error
        }

        private func IsMoreDerivedClrType(derived Type?, baseType Type?) bool {
            if derived == nil || baseType == nil || ClrTypeUtilities.AreSame(derived, baseType) {
                return false
            }
            if baseType.IsInterface {
                for candidate in ClrTypeUtilities.SafeGetInterfaces(derived) {
                    if ClrTypeUtilities.AreSame(candidate, baseType) {
                        return true
                    }
                }
                return false
            }
            for var current Type? = derived.BaseType; current != nil; current = current!!.BaseType {
                if ClrTypeUtilities.AreSame(current, baseType) {
                    return true
                }
            }
            return false
        }

        private func HaveSameIndexerSignature(targetType TypeSymbol, first PropertyInfo, second PropertyInfo) bool {
            let firstParameters = first.GetIndexParameters()
            let secondParameters = second.GetIndexParameters()
            if firstParameters.Length != secondParameters.Length {
                return false
            }
            for var i = 0; i < firstParameters.Length; i++ {
                if !SameTypeSymbol(
                    GetIndexerParameterTypeSymbol(targetType, first, i),
                    GetIndexerParameterTypeSymbol(targetType, second, i)
                ) {
                    return false
                }
            }
            return true
        }

        private func IsBetterSymbolicIndexerCandidate(
            candidate ImmutableArray[TypeSymbol],
            other ImmutableArray[TypeSymbol],
            arguments ImmutableArray[BoundExpression]
        ) bool {
            var hasBetterConversion = false
            for var i = 0; i < arguments.Length; i++ {
                let candidateConversion = ClassifySymbolicIndexerConversion(arguments[i], candidate[i])
                let otherConversion = ClassifySymbolicIndexerConversion(arguments[i], other[i])
                if candidateConversion.IsIdentity != otherConversion.IsIdentity {
                    if !candidateConversion.IsIdentity {
                        return false
                    }
                    hasBetterConversion = true
                    continue
                }
                let candidateToOther = ClassifySymbolicIndexerConversion(candidate[i], other[i]).IsImplicit
                let otherToCandidate = ClassifySymbolicIndexerConversion(other[i], candidate[i]).IsImplicit
                if candidateToOther == otherToCandidate {
                    continue
                }
                if !candidateToOther {
                    return false
                }
                hasBetterConversion = true
            }
            return hasBetterConversion
        }

        private func ClassifySymbolicIndexerConversion(source BoundExpression, target TypeSymbol)(
            IsImplicit bool,
            IsIdentity bool
        ) {
            let conversion = ClassifySymbolicIndexerConversion(source.Type, target)
            return if !conversion.IsImplicit && ExpressionBinder.IsImplicitConstantNarrowingArgument(source, target) {
                (true, false)
            } else {
                conversion
            }
        }

        private func ClassifySymbolicIndexerConversion(source TypeSymbol, target TypeSymbol)(
            IsImplicit bool,
            IsIdentity bool
        ) {
            // ADR-0186 §3, asked BEFORE the same-type fast path, because that
            // path is what the rule has to override.
            //
            // `SameTypeSymbol` unwraps a platform wrapper recursively — it answers
            // the runtime-SIGNATURE question, which member hiding needs (see its
            // own comment) — so it reports plain identity for
            // `List[string!]` against `List[string]`. Left first, it therefore
            // returned `(implicit, identity)` and the rule-3 guard further down in
            // `TryClassifyConstructedGenericConversion` was never reached at all;
            // it also ranked `List[string!] -> List[string?]` as identity, when
            // rule 2 makes that a permitted NON-identity widening and the
            // overload ranker prefers identity over implicit.
            //
            // Copilot review finding on the flip PR, and the third time this pair
            // of questions has had to be pulled apart: the fix is always to ask
            // the platform relation FIRST and let the same-type helper keep its
            // own meaning, never to change what it means.
            //
            // Asked through `TryRelatePlatformContainer` — the same guarded entry
            // `ClassifyNonStructural` uses on the fall-through below — and NOT
            // through the per-argument `IsPlatformArgumentIllegal` /
            // `IsPlatformArgumentWidening` pair used one method down. Those two
            // answer about a single ARGUMENT position whose container has already
            // been matched; asked about the containers themselves they have no
            // shape guard, so `[]string! -> object` (an ordinary upcast, where the
            // two sides have no corresponding argument positions at all) comes
            // back `Illegal` and an indexer taking `object` stops accepting an
            // oblivious string array. The container entry declines for such a
            // pair instead, and speaks only for rule 3's three illegal directions
            // and rule 2's one permitted widening.
            //
            // So this is a hoist, not a new rule: the same question the classifier
            // on the last line already asks, moved above the fast path that was
            // pre-empting it.
            if Conversion.TryRelatePlatformContainer(source, target, out var platformImplicit) {
                return (platformImplicit, false)
            }
            // …and the question that entry deliberately does NOT answer: a
            // NILABLE source reaching a non-null destination.
            //
            // `TryClassifyPlatformTypeArgumentMismatch` declines such a pair on
            // purpose — its own comment says so — so that the ordinary
            // outer-nullability rule can reject it, and
            // `TheContainerRule_Does_Not_Decide_OuterNullability` pins that. But
            // "declined" and "unrelated" arrive here as the same `false`, and the
            // fast path below strips a top-level reference `?` from EITHER side
            // (it answers the runtime-signature question, which is why). So
            // `List[string!]?` against a `List[string?]` parameter came back
            // IDENTICAL — the best possible match — and a nilable container was
            // preferred where a non-null one was required.
            //
            // Copilot review finding on the flip PR, and real. Measured with a
            // legal `this[object?]` competitor present, which is what makes a
            // wrong *identity* verdict observable rather than merely wrong: the
            // mis-ranked candidate won the ranking and the whole access then
            // failed with GS0156, rather than `this[object?]` binding.
            //
            // <b>Not platform-specific, and not new here.</b> The identical
            // mis-selection reproduces under `--nullability=enabled` with no
            // platform type anywhere in the program — the fast path has always
            // erased outer reference nullability. It is fixed rather than filed
            // because this method is the one now being asked the question, and
            // because a rule that holds in `Conversion` but not at applicability
            // is exactly the drift this ADR's §5a exists to prevent.
            //
            // Only the FAST PATH is skipped, not the whole method: the pair falls
            // through to the constructed-generic arm and then to the general
            // classifier, which already answer it correctly. Value-type nullables
            // are excluded exactly as they are in `SameTypeSymbol` — `int?` is a
            // different type, not a nullability annotation on `int`.
            let outerNilabilityDiffers = source is NullableTypeSymbol sourceNilable &&
                !NullableLifting.IsAnyValueTypeNullable(sourceNilable) && !(target is NullableTypeSymbol)
            if !outerNilabilityDiffers && SameTypeSymbol(source, target) {
                return (true, true)
            }
            if TryClassifyConstructedGenericConversion(source, target, out var constructedImplicit) {
                return (constructedImplicit, false)
            }
            let conversion = Conversion.ClassifyNonStructural(source, target)
            return (conversion.IsImplicit, conversion.IsIdentity)
        }

        private func TryClassifyConstructedGenericConversion(
            source TypeSymbol,
            target TypeSymbol,
            out isImplicit bool
        ) bool {
            isImplicit = false
            if source is not ImportedTypeSymbol sourceImported ||
                target is not ImportedTypeSymbol targetImported ||
                sourceImported.OpenDefinition == nil ||
                targetImported.OpenDefinition == nil ||
                sourceImported
                .TypeArguments
                .IsDefaultOrEmpty ||
                targetImported
                .TypeArguments
                .IsDefaultOrEmpty {
                return false
            }
            var sourceArguments ImmutableArray[TypeSymbol]
            if ClrTypeUtilities.AreSame(sourceImported.OpenDefinition, targetImported.OpenDefinition) {
                sourceArguments = sourceImported.TypeArguments
            } else if !TryMapThroughImplemented(sourceImported, targetImported.OpenDefinition, out sourceArguments) {
                return false
            }
            if sourceArguments.Length != targetImported.TypeArguments.Length {
                return true
            }
            let genericParameters = targetImported.OpenDefinition!!.GetGenericArguments()
            for var i = 0; i < sourceArguments.Length; i++ {
                let variance = genericParameters[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
                let compatible = switch variance {
                    case GenericParameterAttributes.Covariant: Binder.IsReferenceTypeForConstraint(
                        sourceArguments[i]
                    ) &&
                        Binder.IsReferenceTypeForConstraint(targetImported.TypeArguments[i]) &&
                        ClassifySymbolicIndexerConversion(
                        sourceArguments[i],
                        targetImported.TypeArguments[i]
                    ).IsImplicit
                    case GenericParameterAttributes.Contravariant: Binder.IsReferenceTypeForConstraint(
                        sourceArguments[i]
                    ) &&
                        Binder.IsReferenceTypeForConstraint(targetImported.TypeArguments[i]) &&
                        ClassifySymbolicIndexerConversion(
                        targetImported.TypeArguments[i],
                        sourceArguments[i]
                    ).IsImplicit
                    default: !Conversion.IsPlatformArgumentIllegal(
                        sourceArguments[i],
                        targetImported.TypeArguments[i]
                    ) &&
                        (
                        SameTypeSymbol(sourceArguments[i], targetImported.TypeArguments[i]) ||
                            Conversion.IsPlatformArgumentWidening(sourceArguments[i], targetImported.TypeArguments[i])
                    )
                }
                if !compatible {
                    return true
                }
            }
            isImplicit = true
            return true
        }

        /// Issue #2375: builds the (cref:FunctionTypeSymbol) shape of a
        /// constructed delegate (`Func`N`/`Action`N`/a named delegate)
        /// directly from its open CLR generic definition and the symbolic type
        /// arguments it was constructed with ((cref:ImportedTypeSymbol.OpenDefinition)
        /// / (cref:ImportedTypeSymbol.TypeArguments)), instead of
        /// reflecting over the (possibly type-erased) closed
        /// (cref:TypeSymbol.ClrType). The delegate's complete `Invoke`
        /// signature is projected through
        /// (cref:MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo,
        /// ImmutableArray{TypeSymbol})).
        /// This preserves fixed parameters and recursively substitutes nested
        /// generic shapes such as the `Action<Conversion>` callback in
        /// `ConvertDelegate<T>`, instead of falling back to the
        /// delegate's object-erased closed CLR type.
        /// @param openDefinition The delegate's open CLR generic definition (e.g. `typeof(Func<,>)`).
        /// @param typeArguments The symbolic type arguments the delegate was constructed with.
        /// @param functionType The matching function-type symbol, on success.
        /// @returns `true` when every Invoke parameter/return slot could be mapped symbolically.
        private func TryGetDelegateFunctionTypeFromOpenDefinition(
            openDefinition Type?,
            typeArguments ImmutableArray[TypeSymbol],
            @NotNullWhen(true) out functionType FunctionTypeSymbol?
        ) bool {
            functionType = nil
            if openDefinition == nil ||
                typeArguments.IsDefaultOrEmpty ||
                !openDefinition.IsGenericTypeDefinition ||
                (
                !ClrTypeUtilities.IsDelegateType(openDefinition) && !string.Equals(
                    openDefinition.BaseType?.FullName,
                    "System.MulticastDelegate",
                    StringComparison.Ordinal
                ) &&
                    !(openDefinition.FullName?.StartsWith("System.Func`", StringComparison.Ordinal) == true) &&
                    !(openDefinition.FullName?.StartsWith("System.Action`", StringComparison.Ordinal) == true)
            ) {
                return false
            }
            let openGenericParams = openDefinition.GetGenericArguments()
            if openGenericParams.Length != typeArguments.Length {
                return false
            }
            var invoke MethodInfo?
            try {
                invoke = openDefinition.GetMethod("Invoke")
            } catch (ex Exception) when ex is AmbiguousMatchException || ex is NotSupportedException {
                return false
            }
            if invoke == nil {
                return false
            }
            let parameters = invoke.GetParameters()
            let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](parameters.Length)
            let variadicBuilder = ImmutableArray.CreateBuilder[bool](parameters.Length)
            var anyVariadic = false
            for parameter in parameters {
                // ADR-0193 Phase 2: merged like every other signature position.
                // This projected the Invoke signature raw, so a delegate declared
                // `string? F<T>(T x)` read as returning `string` here while the
                // closed path read `string?`.
                let mappedParam TypeSymbol? = GetClrOpenParameterPointeeTypeSymbol(
                    parameter,
                    openDefinition,
                    typeArguments
                )
                if mappedParam == nil || mappedParam == TypeSymbol.Error {
                    return false
                }
                parameterTypes.Add(mappedParam)
                // ADR-0102 follow-up / issue #818: mirror TryGetDelegateFunctionType's
                // variadic-flag handling so a params-shaped named delegate keeps
                // its call-site pack/pass-through behavior through this path too.
                let paramArray = HasParamArrayAttribute(parameter)
                variadicBuilder.Add(paramArray)
                anyVariadic |= paramArray
            }
            var returnType TypeSymbol?
            if invoke.ReturnType.IsSameAs(typeof(Void)) {
                returnType = TypeSymbol.Void
            } else {
                returnType = GetClrOpenMethodReturnTypeSymbol(invoke, openDefinition, typeArguments)
                if returnType == nil || returnType == TypeSymbol.Error {
                    return false
                }
            }
            let variadicFlags = if anyVariadic {
                variadicBuilder.ToImmutable()
            } else {
                default(ImmutableArray[bool])
            }
            functionType = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), variadicFlags, returnType)
            return true
        }

        private func HasParamArrayAttribute(parameter ParameterInfo) bool {
            for attribute in parameter.GetCustomAttributesData() {
                if string.Equals(
                    attribute.AttributeType.FullName,
                    "System.ParamArrayAttribute",
                    StringComparison.Ordinal
                ) {
                    return true
                }
            }
            return false
        }

        /// Returns the callable parameter slice of [`method`](paramref) —
        /// dropping the synthetic receiver slot used by extension methods so
        /// signature-matching against a CLR contract sees only the
        /// explicitly-declared parameters. Mirrors
        /// `Binder.GetCallableParameters` byte-for-byte (kept duplicated
        /// rather than widening the binder's helper to `internal`; the
        /// implementation is a one-liner).
        /// @param method The user function symbol.
        /// @returns The parameters visible to a non-extension caller.
        private func GetCallableParameters(method FunctionSymbol) ImmutableArray[
            ParameterSymbol
        ] -> if method.ExplicitReceiverParameter == nil {
            method.Parameters
        } else {
            method.Parameters.RemoveAt(0)
        }

        /// Issue #1305 / #821: resolves the `System.Object` used to erase the
        /// type arguments when closing [`openDef`](paramref) via
        /// (cref:Type.MakeGenericType). When [`openDef`](paramref) was
        /// loaded by the references' `MetadataLoadContext` (reference-pack
        /// assemblies), passing a live `typeof(object)` raises an
        /// (cref:ArgumentException) ("type was not loaded by the
        /// MetadataLoadContext that loaded the generic type or method"). A generic
        /// parameter's effective base type is `System.Object` in that same
        /// context, so reuse it. Falls back to the host `typeof(object)` when
        /// [`openDef`](paramref) lives in the host runtime or no
        /// `System.Object` base can be recovered.
        /// @param openDef The open generic type definition being closed.
        /// @returns An `object` (cref:Type) loaded in the same context as [`openDef`](paramref).
        private func ResolveErasedObjectInContext(openDef Type?) Type {
            let hostObject = typeof(object)
            if openDef == nil || openDef.Assembly == hostObject.Assembly {
                return hostObject
            }
            for p in openDef.GetGenericArguments() {
                let baseType Type? = p.BaseType
                if baseType != nil && baseType.FullName == "System.Object" {
                    return baseType
                }
            }
            return hostObject
        }

        /// Issue #1422: builds the type-erased closed shape for a constructed
        /// generic whose symbolic arguments may themselves be constructed generics
        /// (e.g. `IEnumerable<IEnumerator<T>>`). Each top-level
        /// argument's <em>nested</em> generic structure is preserved by recursing
        /// through its open definition. Symbolic leaves collapse to the context's
        /// `object` placeholder while concrete leaves retain their CLR identity,
        /// matching selector/lambda erasure so generic inference recovers the right
        /// element type for a chained extension call. Falls back
        /// to a flat all-`object` erasure, then to `null`, when
        /// the richer construction is rejected (e.g. cross-context or constraint
        /// violations).
        /// @param openDef The open generic type definition being closed.
        /// @param openParams The open definition's generic parameters.
        /// @param symbolicArgs The symbolic type arguments, aligned with [`openParams`](paramref).
        /// @param contextObject The `object` placeholder resolved in [`openDef`](paramref)'s context.
        /// @returns The erased closed CLR type, or `null` when no valid closure could be formed.
        private func TryBuildErasedClosedGeneric(
            openDef Type,
            openParams[]Type,
            symbolicArgs ImmutableArray[TypeSymbol],
            contextObject Type
        ) Type? {
            let richArgs = [openParams.Length]Type
            var anyRich = false
            for var i = 0; i < openParams.Length; i++ {
                let projected Type? = if i < symbolicArgs.Length {
                    ProjectSymbolicArgToErasedClr(symbolicArgs[i], contextObject)
                } else {
                    default(Type?)
                }
                if projected != nil && !projected.IsSameAs(contextObject) {
                    anyRich = true
                }
                richArgs[i] = projected ?? contextObject
            }
            if anyRich && !ClrTypeUtilities.MakeGenericTypeIsRejectedAcrossContexts(openDef, richArgs) {
                try {
                    return openDef.MakeGenericType(richArgs)
                } catch {
                    // Fall through to the flat erasure below.

                }
            }
            let flatArgs = [openParams.Length]Type
            for var i = 0; i < openParams.Length; i++ {
                flatArgs[i] = contextObject
            }
            if ClrTypeUtilities.MakeGenericTypeIsRejectedAcrossContexts(openDef, flatArgs) {
                return nil
            }
            try {
                return openDef.MakeGenericType(flatArgs)
            } catch {
                // Constraint or cross-context failure — caller falls back to the
                // open shape; downstream emit still encodes correctly via the
                // OpenDefinition + TypeArguments.
                return nil
            }
        }

        /// Issue #1422: projects a single symbolic type argument onto an erased CLR
        /// type in [`contextObject`](paramref)'s load context. Nested
        /// constructed generics (carrying an (cref:ImportedTypeSymbol.OpenDefinition))
        /// are rebuilt recursively so their generic shape survives; symbolic leaves
        /// collapse to [`contextObject`](paramref), while concrete leaves retain
        /// their CLR identity.
        /// Returns `null` when no useful erasure could be formed.
        /// @param symbolicArg The symbolic type argument.
        /// @param contextObject The `object` placeholder for the target context.
        /// @returns The erased CLR type, or `null`.
        private func ProjectSymbolicArgToErasedClr(symbolicArg TypeSymbol, contextObject Type) Type? {
            switch symbolicArg {
                case nil, TypeParameterSymbol {
                    return contextObject
                }
                case EnumSymbol {
                    // Issue #2391: same-compilation enums already use Int32 as
                    // their overload-resolution ride-through. Use that same
                    // surrogate when closing an imported generic receiver so a
                    // struct-constrained interface such as IRepo<Color> can expose
                    // a closed Echo(Nullable<Int32>) candidate instead of falling
                    // back to the unusable open Echo(Nullable<T>) signature.
                    return if contextObject.Assembly == typeof(object).Assembly {
                        typeof(int32)
                    } else {
                        contextObject.Assembly.GetType(typeof(int32).FullName ?? "System.Int32", throwOnError: false)
                    }
                }
                case imp is ImportedTypeSymbol when imp.OpenDefinition != nil && !imp.TypeArguments.IsDefaultOrEmpty {
                    return TryBuildErasedClosedGeneric(
                        imp.OpenDefinition!!,
                        imp.OpenDefinition!!.GetGenericArguments(),
                        imp.TypeArguments,
                        contextObject
                    )
                }
                case NullableTypeSymbol{UnderlyingType: {ClrType: {IsValueType: true}}} nullableValue {
                    // Issue #4035: a `NullableTypeSymbol` answers its UNDERLYING
                    // type's `ClrType`, so the `default` arm below would erase
                    // `int32?` to a bare `System.Int32` and close
                    // `Dictionary<,>.ValueCollection` over `int32` while the map's
                    // own backing dictionary is `Dictionary<string,
                    // Nullable<int32>>`. `for v in m.Values` then loaded a
                    // `ValueCollection<string, Nullable<int32>>.Enumerator` where
                    // the IL claimed `ValueCollection<string, int32>.Enumerator`
                    // and ilverify rejected it with `StackUnexpected` — the same
                    // dropped-`Nullable<>` defect as the map's construction, one
                    // erasure further out. Build the wrapper in `contextObject`'s
                    // own load context for the reason `BuildErasedTupleInContext`
                    // and `ResolveErasedObjectInContext` exist: a host
                    // `typeof(Nullable<>)` cannot close over an MLC-loaded
                    // underlying.
                    return BuildErasedNullableInContext(nullableValue, contextObject)
                }
                case tuple is TupleTypeSymbol {
                    // Issue #1902: a positional tuple carrying a same-compilation
                    // user element (e.g. the `(Owner, Pet)` transparent identifier
                    // a Join's result-selector returns) has a null ClrType —
                    // `TupleTypeSymbol.BuildClrType` refuses to build
                    // `ValueTuple<...>` when any element's own ClrType is null.
                    // Flattening it to the bare `contextObject` placeholder (the
                    // `default` arm below) would still satisfy *this* call's own
                    // generic constraints, but the erased closed generic loses the
                    // tuple shape entirely (`IEnumerable<object>` instead of
                    // `IEnumerable<ValueTuple<object, object>>`), so the *next*
                    // chained call (`.Select(t => …)`) can no longer structurally
                    // match its own tuple-typed delegate parameter and dead-ends
                    // at GS0159. Build the erased `ValueTuple<...>` shape in
                    // `contextObject`'s own load context (see
                    // <see cref="BuildErasedTupleInContext"/>) — a host-context
                    // `typeof(ValueTuple<,>)` (what `TryProjectErasedClrType` would
                    // build) cannot close over an MLC-loaded `contextObject`
                    // (cross-context `MakeGenericType` throws), the same reason
                    // `ResolveErasedObjectInContext` exists for the plain-object
                    // case above.
                    return BuildErasedTupleInContext(tuple, contextObject)
                }
                default {
                    let concrete Type? = symbolicArg.ClrType
                    if concrete == nil {
                        return contextObject
                    }
                    return if concrete.Assembly == typeof(object).Assembly && concrete.FullName is {} fullName {
                        contextObject.Assembly.GetType(fullName, throwOnError: false) ?? concrete
                    } else {
                        concrete
                    }
                }
            }
        }

        /// Issue #1902: builds the erased `ValueTuple<...>` shape for a
        /// (cref:TupleTypeSymbol) element-by-element, staying in
        /// [`contextObject`](paramref)'s load context throughout (both the
        /// `ValueTuple`N` open definition and every element are resolved from
        /// that context, recursing via (cref:ProjectSymbolicArgToErasedClr)
        /// so a nested generic/tuple element keeps its own structure too).
        /// @param tuple The symbolic tuple type.
        /// @param contextObject The `object` placeholder resolved in the target context.
        /// @returns The erased closed tuple CLR type, or `null` when none could be built.
        private func BuildErasedTupleInContext(tuple TupleTypeSymbol, contextObject Type) Type? {
            let erasedElements = [tuple.ElementTypes.Length]Type
            for var i = 0; i < tuple.ElementTypes.Length; i++ {
                erasedElements[i] = ProjectSymbolicArgToErasedClr(tuple.ElementTypes[i], contextObject) ?? contextObject
            }
            return BuildErasedTupleInContext(erasedElements, 0, erasedElements.Length, contextObject)
        }

        /// Issue #4035: the `Nullable<T>` analogue of
        /// (cref:BuildErasedTupleInContext(TupleTypeSymbol, Type)) — closes
        /// [`contextObject`](paramref)'s own `System.Nullable`1` over the
        /// erased underlying so a nullable VALUE type keeps its wrapper through
        /// erasure instead of collapsing to the bare underlying that
        /// (cref:TypeSymbol.ClrType) answers.
        /// @param nullable The nullable value type symbol.
        /// @param contextObject The `object` placeholder resolved in the target context.
        /// @returns The erased `Nullable<T>`, or the bare underlying when the context cannot name it.
        private func BuildErasedNullableInContext(nullable NullableTypeSymbol, contextObject Type) Type? {
            let underlying Type? = ProjectSymbolicArgToErasedClr(nullable.UnderlyingType, contextObject)
            if underlying == nil || !underlying.IsValueType {
                // The underlying erased to the `object` placeholder (or to a
                // reference type); `Nullable<>` cannot close over it, and the bare
                // erasure is the shape every other reader already expects.
                return underlying
            }
            let openNullable Type? = if contextObject.Assembly == typeof(object).Assembly {
                typeof(Nullable[_])
            } else {
                contextObject.Assembly.GetType("System.Nullable`1", throwOnError: false)
            }
            if openNullable == nil {
                return underlying
            }
            try {
                return openNullable.MakeGenericType(underlying)
            } catch (e Exception) when e is ArgumentException ||
                e is InvalidOperationException ||
                e is NotSupportedException ||
                e is TypeLoadException {
                return underlying
            }
        }

        private func BuildErasedTupleInContext(elementTypes[]Type, start int32, count int32, contextObject Type) Type? {
            let tupleOpenDefinition Type? = ResolveErasedValueTupleOpenDefinition(
                contextObject,
                if count <= 7 {
                    count
                } else {
                    8
                }
            )
            if tupleOpenDefinition == nil {
                return nil
            }
            let arguments = [Math.Min(count, 8)]Type
            let directCount = Math.Min(count, 7)
            Array.Copy(elementTypes, start, arguments, 0, directCount)
            if count > 7 {
                let nestedTuple Type? = BuildErasedTupleInContext(elementTypes, start + 7, count - 7, contextObject)
                if nestedTuple == nil {
                    return nil
                }
                arguments[7] = nestedTuple
            }
            try {
                return tupleOpenDefinition.MakeGenericType(arguments)
            } catch {
                return nil
            }
        }

        /// Issue #1902: resolves the open `System.ValueTuple`N` generic type
        /// definition for the given arity, in the same load context as
        /// [`contextObject`](paramref). `System.ValueTuple` lives in the
        /// same core assembly as `System.Object`, so when
        /// [`contextObject`](paramref) is not the host `typeof(object)`
        /// (i.e. it was resolved in an isolated `MetadataLoadContext` per
        /// (cref:ResolveErasedObjectInContext)), the matching
        /// `ValueTuple`N` is looked up from that same assembly rather than
        /// using the host BCL's `typeof(ValueTuple<,>)` (which
        /// `MakeGenericType` would reject with a cross-context
        /// (cref:ArgumentException)).
        /// @param contextObject The `object` placeholder resolved in the target context.
        /// @param arity The CLR tuple-node arity (1–8).
        /// @returns The open `ValueTuple`N` definition, or `null` when unsupported/unresolvable.
        /// @remarks Issue #4591: delegates to the rule (cref:TupleTypeSymbol) uses for its own CLR backing.
        private func ResolveErasedValueTupleOpenDefinition(contextObject Type, arity int32) Type? -> if arity < 1 ||
            arity > 8 {
            default(Type?)
        } else {
            TupleTypeSymbol.GetOpenClrType(arity, contextObject)
        }

        /// Issue #4614: pairs a generic slot's method-owned type parameters with
        /// the candidate's own, positionally. The arities must agree (a generic
        /// slot is never implemented by a non-generic method, nor the reverse).
        /// @param candidate The candidate G# method.
        /// @param slot The interface slot.
        /// @param methodTypeArgs The candidate's type parameters, or default for a non-generic slot.
        /// @returns `false` when the arities differ.
        private func TryGetMethodTypeArguments(
            candidate FunctionSymbol,
            slot MethodInfo,
            out methodTypeArgs ImmutableArray[TypeSymbol]
        ) bool {
            let slotArity = if slot.IsGenericMethodDefinition {
                slot.GetGenericArguments().Length
            } else {
                0
            }
            let candidateArity = if candidate.TypeParameters.IsDefaultOrEmpty {
                0
            } else {
                candidate.TypeParameters.Length
            }
            methodTypeArgs = default(ImmutableArray[TypeSymbol])
            if slotArity == 0 || slotArity != candidateArity {
                return slotArity == candidateArity
            }
            // Built element by element rather than with `ImmutableArray.CastUp`,
            // which does not survive the cs2gs self-migration of this file.
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](candidateArity)
            for typeParameter in candidate.TypeParameters {
                builder.Add(typeParameter)
            }
            methodTypeArgs = builder.MoveToImmutable()
            return true
        }

        private func ReturnTypeMatchesSubstituted(
            candidateReturn TypeSymbol,
            openReturn Type,
            symbolicArgs ImmutableArray[TypeSymbol]
        ) bool -> ReturnTypeMatchesSubstituted(
            candidateReturn,
            openReturn,
            symbolicArgs,
            default(ImmutableArray[TypeSymbol])
        )

        private func ReturnTypeMatchesSubstituted(
            candidateReturn TypeSymbol,
            openReturn Type,
            symbolicArgs ImmutableArray[TypeSymbol],
            methodTypeArgs ImmutableArray[TypeSymbol]
        ) bool {
            if openReturn.IsSameAs(typeof(Void)) {
                return candidateReturn == TypeSymbol.Void
            }
            return ParameterTypeMatchesSubstituted(candidateReturn, openReturn, symbolicArgs, methodTypeArgs)
        }

        private func ParameterTypeMatchesSubstituted(
            candidate TypeSymbol,
            openType Type?,
            symbolicArgs ImmutableArray[TypeSymbol]
        ) bool -> ParameterTypeMatchesSubstituted(
            candidate,
            openType,
            symbolicArgs,
            default(ImmutableArray[TypeSymbol])
        )

        /// Whether the candidate's type at one signature position matches the
        /// contract's, with the interface's generic parameters substituted.
        /// @param candidate The candidate's type at this position.
        /// @param openType The contract's type at this position, over the open definition.
        /// @param symbolicArgs The interface's symbolic type arguments, by the interface's generic-parameter
        /// position.
        /// @param methodTypeArgs Issue #4614: the candidate method's own type parameters, matched by a
        /// METHOD-owned generic parameter's position (`U` in
        /// `I<T>.M<U>(T x, U y)`); default when the slot is not a
        /// generic method. A method-owned parameter's position is NOT an index
        /// into [`symbolicArgs`](paramref).
        /// @returns `true` when the position matches.
        private func ParameterTypeMatchesSubstituted(
            candidate TypeSymbol,
            openType Type?,
            symbolicArgs ImmutableArray[TypeSymbol],
            methodTypeArgs ImmutableArray[TypeSymbol]
        ) bool {
            var candidate = candidate
            if openType == nil {
                return false
            }
            // ADR-0186: implementing an interface slot is a signature relation,
            // and `T!` has `T`'s runtime signature (§1). A member declared in an
            // ADR-0186 §9 oblivious scope (`func GetEnumerator() IEnumerator[Item]`
            // there is `IEnumerator[Item]!`) must still be recognised as the
            // implementation — declining it left the slot without a MethodImpl,
            // which the binder did not diagnose and the runtime reported as a
            // TypeLoadException. (That the relation performs no nil check is
            // ADR-0186 open question 13, unchanged.)
            candidate = PlatformTypeSymbol.StripTopLevel(candidate)
            if openType.IsGenericParameter {
                let position = openType.GenericParameterPosition
                let owners = if openType.DeclaringMethod != nil {
                    methodTypeArgs
                } else {
                    symbolicArgs
                }
                if owners.IsDefault || position < 0 || position >= owners.Length {
                    return false
                }
                return SameTypeSymbol(candidate, owners[position])
            }
            // Issue #2380 follow-up: a contract position of `Nullable<T>` (e.g.
            // `T? Find()` on `IRepo<T> where T : struct`) is a constructed
            // generic whose single type argument is the interface's OWN generic
            // parameter, not an `ImportedTypeSymbol`'s type argument. A G#
            // candidate satisfying this via `Color?` projects as a
            // `NullableTypeSymbol`, which the `ImportedTypeSymbol` branch below
            // does not recognize — it would fall through to the erased
            // CLR-projected comparison, which fails for same-compilation
            // `UnderlyingType`s (their `ClrType` is always null). Unwrap both
            // sides structurally instead.
            if openType.IsConstructedGenericType && openType.GetGenericTypeDefinition().IsSameAs(typeof(Nullable[_])) &&
                candidate is NullableTypeSymbol nullableCandidate {
                return ParameterTypeMatchesSubstituted(
                    nullableCandidate.UnderlyingType,
                    openType.GetGenericArguments()[0],
                    symbolicArgs,
                    methodTypeArgs
                )
            }
            // Issue #4614: an array position that mentions a generic parameter
            // (`T[] xs`, or a method's own `U[] us`) is matched element-wise
            // with the same substitutions; the erased CLR comparison below can
            // never succeed for it (a G# slice over a same-compilation or
            // type-parameter element has no CLR type). Concrete arrays keep that
            // comparison.
            if openType.IsArray && openType.ContainsGenericParameters {
                let openElement = openType.GetElementType()
                return switch candidate {
                    case slice is SliceTypeSymbol when openType.IsSZArray: ParameterTypeMatchesSubstituted(
                        slice.ElementType,
                        openElement,
                        symbolicArgs,
                        methodTypeArgs
                    )
                    case fixedArray is ArrayTypeSymbol when openType.IsSZArray: ParameterTypeMatchesSubstituted(
                        fixedArray.ElementType,
                        openElement,
                        symbolicArgs,
                        methodTypeArgs
                    )
                    case rectangular is RectangularArrayTypeSymbol when !openType.IsSZArray &&
                        rectangular.Rank == openType.GetArrayRank(): ParameterTypeMatchesSubstituted(
                        rectangular.ElementType,
                        openElement,
                        symbolicArgs,
                        methodTypeArgs
                    )
                    default: false
                }
            }
            // Issue #985: the contract position may itself be a *constructed
            // generic* that mentions the interface's generic parameters — e.g.
            // `IEnumerable<T>.GetEnumerator()` returns `IEnumerator<T>`. The erased
            // CLR-projection comparison below would demand `IEnumerator<object>`
            // and wrongly reject a candidate returning `IEnumerator[T]`. Recurse
            // structurally instead, substituting the interface's generic parameters
            // with the symbolic arguments at each nested position (mirrors the
            // #974 `InterfaceSymbol.SubstituteType` recursion on the G# path).
            if openType.IsConstructedGenericType &&
                TryGetSymbolicConstructedGenericShape(
                candidate,
                out var candidateOpenDefinition,
                out var candidateTypeArguments
            ) {
                let openDefinition = openType.GetGenericTypeDefinition()
                if candidateOpenDefinition.IsSameAs(openDefinition) {
                    let openArgs = openType.GetGenericArguments()
                    if openArgs.Length == candidateTypeArguments.Length {
                        for var i = 0; i < openArgs.Length; i++ {
                            if !ParameterTypeMatchesSubstituted(
                                candidateTypeArguments[i],
                                openArgs[i],
                                symbolicArgs,
                                methodTypeArgs
                            ) {
                                return false
                            }
                        }
                        return true
                    }
                }
                return false
            }
            // Non-generic contract position — compare against the CLR-projected
            // effective type, exactly as the erased path does.
            return ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(candidate), openType)
        }

        private func TryGetSymbolicConstructedGenericShape(
            candidate TypeSymbol,
            out openDefinition Type?,
            out typeArguments ImmutableArray[TypeSymbol]
        ) bool {
            if candidate is ImportedTypeSymbol imported &&
                imported.OpenDefinition != nil &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                openDefinition = imported.OpenDefinition
                typeArguments = imported.TypeArguments
                return true
            }
            if SequenceTypeSymbol.TryGetEnumerableInterfaceShape(candidate, out openDefinition, out var elementType) {
                typeArguments = ImmutableArray.Create(elementType)
                return true
            }
            openDefinition = nil
            typeArguments = default(ImmutableArray[TypeSymbol])
            return false
        }

        private func SameTypeSymbol(a TypeSymbol?, b TypeSymbol?) bool {
            if object.ReferenceEquals(a, b) {
                return true
            }
            if a == nil || b == nil {
                return false
            }
            if a is ImportedTypeSymbol importedA &&
                b is ImportedTypeSymbol importedB &&
                importedA.OpenDefinition != nil &&
                importedB.OpenDefinition != nil &&
                (!importedA.TypeArguments.IsDefaultOrEmpty || !importedB.TypeArguments.IsDefaultOrEmpty) {
                if !ClrTypeUtilities.AreSame(importedA.OpenDefinition, importedB.OpenDefinition) ||
                    importedA
                    .TypeArguments
                    .Length != importedB
                    .TypeArguments
                    .Length {
                    return false
                }
                for var i = 0; i < importedA.TypeArguments.Length; i++ {
                    if !SameTypeSymbol(importedA.TypeArguments[i], importedB.TypeArguments[i]) {
                        return false
                    }
                }
                return true
            }
            if a is SliceTypeSymbol sliceA && b is SliceTypeSymbol sliceB {
                return SameTypeSymbol(sliceA.ElementType, sliceB.ElementType)
            }
            // Issue #3907: two tuples are the same type when their SHAPES agree.
            // Element names are deliberately not compared — ADR-0172 (as amended
            // by #3643) makes same-shape tuples differing only in element names
            // identity-convertible, which is also the CLR's answer, since both
            // erase to the same `ValueTuple` instantiation.
            //
            // Without this arm the comparison fell through to the ClrType probe at
            // the bottom, and a tuple containing a same-compilation or open type
            // (`(T, bool)`) has no ClrType at all while binding — see
            // `TupleTypeSymbol.BuildClrType`, which returns null as soon as one
            // element cannot be projected (the #3748/#3910 hole, here on the
            // interface-conformance side). So `class Node[T] :
            // IValueTaskSource[(T, bool)]` could not satisfy its own
            // `GetResult` slot, while the identical declaration over concrete
            // element types (`(string, bool)`) always could.
            if a is TupleTypeSymbol tupleA && b is TupleTypeSymbol tupleB {
                if tupleA.Arity != tupleB.Arity {
                    return false
                }
                for var i = 0; i < tupleA.Arity; i++ {
                    if !SameTypeSymbol(tupleA.ElementTypes[i], tupleB.ElementTypes[i]) {
                        return false
                    }
                }
                return true
            }
            if a is NullableTypeSymbol nullableA && b is NullableTypeSymbol nullableB {
                return SameTypeSymbol(nullableA.UnderlyingType, nullableB.UnderlyingType)
            }
            if a is NullableTypeSymbol nullableReferenceA && !NullableLifting.IsAnyValueTypeNullable(
                nullableReferenceA
            ) {
                return SameTypeSymbol(nullableReferenceA.UnderlyingType, b)
            }
            if b is NullableTypeSymbol nullableReferenceB && !NullableLifting.IsAnyValueTypeNullable(
                nullableReferenceB
            ) {
                return SameTypeSymbol(a, nullableReferenceB.UnderlyingType)
            }
            // ADR-0186 §1: `T!` and `T` are ONE runtime type, so this helper —
            // which answers "is this the same TYPE?" — sees through the platform
            // wrapper exactly as the reference-`T?` arms above do. §2 excludes
            // value types, so there is no `IsAnyValueTypeNullable`-style guard to
            // mirror.
            //
            // <b>This helper answers a runtime-signature question, and that is
            // why it unwraps.</b> It is also consulted for member HIDING, where a
            // `new string this[string key]` in a derived interface must be
            // recognised as covering the base slot whether the base's parameter
            // was read as `string` or `string!` — they are one CLR signature.
            // Making a mixed pair simply "not the same type" broke exactly that:
            // `Issue2525ImportedIndexerHidingEmitTests`' diamond stopped
            // collapsing and every access reported GS0266 "ambiguous between
            // multiple overloads".
            //
            // The conversion side needs the OPPOSITE answer — §3 rule 3 rejects
            // `C[T!] -> C[T]`, so an invariant type-argument position must NOT
            // treat them as interchangeable. That is a different question and it
            // is asked separately, at the one caller that needs it:
            // `TryClassifyConstructedGenericConversion` pairs this test with
            // `Conversion.IsPlatformArgumentIllegal` /
            // `IsPlatformArgumentWidening`. Overloading this helper with both
            // meanings is what produced two review rounds of finding-and-
            // counter-finding; splitting them is the fix.
            //
            // Measured for the case the arm was added for: without any platform
            // arm at all, `SameTypeSymbol(Payload2471, object!)` fell through to
            // the `ClrType` probe at the bottom — where a same-compilation
            // `Payload2471` erases to `System.Object`, which is the platform
            // wrapper's own relayed `ClrType` — and answered YES, so
            // `NestedKeyBox[T]`'s `this[List[object]]` beat `this[IEnumerable[T]]`
            // (`Issue2471DictionaryIndexerSameCompilationTypeTests`). With the
            // unwrap it answers `SameTypeSymbol(Payload2471, object)`, which is
            // `false` — the same answer `--nullability=enabled` gives through its
            // own `T?` unwrap one arm up.
            if a is PlatformTypeSymbol platformA && b is PlatformTypeSymbol platformB {
                return SameTypeSymbol(platformA.UnderlyingType, platformB.UnderlyingType)
            }
            if a is PlatformTypeSymbol platformReferenceA {
                return SameTypeSymbol(platformReferenceA.UnderlyingType, b)
            }
            if b is PlatformTypeSymbol platformReferenceB {
                return SameTypeSymbol(a, platformReferenceB.UnderlyingType)
            }
            // Constructed user generics are interned (StructSymbol.Construct uses a
            // cache), so reference identity usually holds; fall back to a
            // structural comparison by definition + ordered type arguments.
            if a is StructSymbol sa && b is StructSymbol sb {
                if !object.ReferenceEquals(sa.Definition, sb.Definition) {
                    return false
                }
                if sa.EnclosingTypeArguments.Length != sb.EnclosingTypeArguments.Length {
                    return false
                }
                for var i = 0; i < sa.EnclosingTypeArguments.Length; i++ {
                    if !SameTypeSymbol(sa.EnclosingTypeArguments[i], sb.EnclosingTypeArguments[i]) {
                        return false
                    }
                }
                if sa.TypeArguments.Length != sb.TypeArguments.Length {
                    return false
                }
                for var i = 0; i < sa.TypeArguments.Length; i++ {
                    if !SameTypeSymbol(sa.TypeArguments[i], sb.TypeArguments[i]) {
                        return false
                    }
                }
                return true
            }
            if a.ClrType != nil && b.ClrType != nil {
                return ClrTypeUtilities.AreSame(a.ClrType, b.ClrType)
            }
            return false
        }

        private func ReturnTypeSignaturesEqual(a TypeSymbol?, b TypeSymbol?) bool {
            if object.ReferenceEquals(a, b) {
                return true
            }
            if a == nil || b == nil {
                return false
            }
            if SameTypeSymbol(a, b) {
                return true
            }
            let ca Type? = NullableLifting.GetEffectiveClrType(a)
            let cb Type? = NullableLifting.GetEffectiveClrType(b)
            return ca != nil && cb != nil && ClrTypeUtilities.AreSame(ca, cb)
        }

        /// Returns whether [`candidate`](paramref) is hidden by any method
        /// already in [`existing`](paramref). Same-name-and-parameter-types
        /// hiding mirrors C# semantics.
        private func IsMethodHiddenByExisting(existing List[MethodInfo], candidate MethodInfo) bool {
            for m in existing {
                if !string.Equals(m.Name, candidate.Name, StringComparison.Ordinal) {
                    continue
                }
                if m.GetGenericArguments().Length != candidate.GetGenericArguments().Length {
                    continue
                }
                let existingParams = m.GetParameters()
                let candidateParams = candidate.GetParameters()
                if existingParams.Length != candidateParams.Length {
                    continue
                }
                var match = true
                for var i = 0; i < existingParams.Length; i++ {
                    if !ClrTypeUtilities.AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType) {
                        match = false
                        break
                    }
                }
                if match {
                    return true
                }
            }
            return false
        }

        /// Issue #2375: locates the counterpart of [`genericMethod`](paramref)
        /// (a method already opened at its OWN generic-method-parameter level, e.g.
        /// via `MethodInfo.GetGenericMethodDefinition()`) on
        /// [`openDeclaringType`](paramref) — the receiver's fully open
        /// declaring type (all of ITS OWN type parameters unbound too). This
        /// matters because `GetGenericMethodDefinition()` only opens the
        /// method's own type parameters; if the method's DECLARING type was
        /// already closed (e.g. erased to `object` by overload resolution),
        /// the declaring type's arguments remain closed on the result, silently
        /// corrupting any reference to the declaring type's own type parameter
        /// inside the method's signature (e.g. a return type like
        /// `DependentBuilder<TRelated, TEntity>` would keep `TEntity`
        /// erased to `object` even after re-opening `TRelated`). Match is by
        /// metadata token + module, which is stable for methods on a constructed
        /// generic type.
        /// @param openDeclaringType The receiver's open generic type definition.
        /// @param genericMethod The method to re-project onto [`openDeclaringType`](paramref).
        /// @returns The fully open method, or `null` when no match is found.
        private func TryGetOpenMethodOnDeclaringType(openDeclaringType Type?, genericMethod MethodInfo?) MethodInfo? {
            if openDeclaringType == nil || genericMethod == nil {
                return nil
            }
            if OpenMethodsByMappedMethod.TryGetValue(genericMethod, out var mappedOpenMethod) &&
                ClrTypeUtilities.AreSame(mappedOpenMethod.DeclaringType, openDeclaringType) {
                return mappedOpenMethod
            }
            if ClrTypeUtilities.AreSame(genericMethod.DeclaringType, openDeclaringType) {
                return genericMethod
            }
            const bindingFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            let candidate = ClrTypeUtilities.FindMetadataDefinition(
                openDeclaringType,
                genericMethod,
                bindingFlags
            ) as MethodInfo
            if candidate != nil {
                return if candidate.IsGenericMethodDefinition || !candidate.IsGenericMethod {
                    candidate
                } else {
                    candidate.GetGenericMethodDefinition()
                }
            }
            return nil
        }

        private func ReopenForSymbolicProjection(
            closed MethodInfo,
            receiverType TypeSymbol?,
            out receiverOpenDef Type?,
            out receiverTypeArgs ImmutableArray[TypeSymbol]
        ) MethodInfo {
            var openMethod = if closed.IsGenericMethodDefinition {
                closed
            } else {
                closed.GetGenericMethodDefinition()
            }
            receiverOpenDef = nil
            receiverTypeArgs = default(ImmutableArray[TypeSymbol])
            if receiverType != nil &&
                GetProjectionReceiverImportedType(receiverType) is ImportedTypeSymbol imp &&
                TryGetSymbolicDeclaringContext(imp, closed.DeclaringType, out receiverOpenDef, out receiverTypeArgs) {
                // Issue #2375: `closed.GetGenericMethodDefinition()` only opens the
                // METHOD's own generic parameters — it leaves the DECLARING TYPE's
                // type arguments exactly as closed on `closed` (e.g. `object` when
                // the receiver's own type argument was erased during overload
                // resolution). For an instance method whose return type references
                // BOTH a method-level parameter (e.g. `TRelated`) and the
                // declaring type's own parameter (e.g. `TEntity`, as in
                // `Builder<TEntity>.WithOne<TRelated>() : DependentBuilder<TRelated,
                // TEntity>`), this left the second slot permanently erased to
                // `object` even though the method-level slot recovered correctly.
                // Issue #4785: source-derived receivers carry those arguments on
                // their nearest imported base. Use the actual declaring owner's
                // projected vector, including reordered/nested inherited arguments,
                // then reopen both levels by metadata token and module.
                let reopened MethodInfo? = TryGetOpenMethodOnDeclaringType(receiverOpenDef, openMethod)
                if reopened != nil {
                    openMethod = reopened
                }
            }
            return openMethod
        }

        private func InferSymbolicMethodTypeArgumentsCore(
            openMethod MethodInfo,
            symbolicArgTypes ImmutableArray[TypeSymbol?],
            isExpanded bool,
            out requiresRecoveredInference bool
        )[]TypeSymbol? -> InferSymbolicMethodTypeArgumentsCore(
            openMethod,
            symbolicArgTypes,
            isExpanded,
            methodGroupArgumentSlots: default(ImmutableArray[bool]),
            out requiresRecoveredInference
        )

        /// Issue #4133 (hot-core translation guard finding): overload that also
        /// accepts, parallel to [`symbolicArgTypes`](paramref), which
        /// argument slots were recovered from a bare method group (see
        /// `RefineSymbolicArgsForMethodGroups`'s method-group-slots
        /// overload). Those slots unify with
        /// (cref:SymbolicInferenceBoundKind.MethodGroupSource) instead of
        /// the default (cref:SymbolicInferenceBoundKind.Lower), so a
        /// contravariant bound recovered from the method group's OWN parameter
        /// type — which C#'s method-type inference never treats as an input
        /// bound (§12.6.3.7), not even as a last-resort fallback when no other
        /// bound exists — is discarded outright by
        /// (cref:SymbolicInferenceBounds.Add) rather than landing in
        /// `bounds.Upper`.
        private func InferSymbolicMethodTypeArgumentsCore(
            openMethod MethodInfo?,
            symbolicArgTypes ImmutableArray[TypeSymbol?],
            isExpanded bool,
            methodGroupArgumentSlots ImmutableArray[bool],
            out requiresRecoveredInference bool
        )[]TypeSymbol? {
            requiresRecoveredInference = false
            if openMethod == nil || !openMethod.IsGenericMethodDefinition {
                return Array.Empty[TypeSymbol?]()
            }
            let arity = openMethod.GetGenericArguments().Length
            let bounds = SymbolicInferenceBounds(arity)
            let ArgumentBoundKind = func (i int32) SymbolicInferenceBoundKind {
                return if !methodGroupArgumentSlots.IsDefault &&
                    i < methodGroupArgumentSlots.Length &&
                    methodGroupArgumentSlots[i] {
                    SymbolicInferenceBoundKind.MethodGroupSource
                } else {
                    SymbolicInferenceBoundKind.Lower
                }
            }
            let openParams = openMethod.GetParameters()
            let argumentCount = if symbolicArgTypes.IsDefault {
                0
            } else {
                symbolicArgTypes.Length
            }
            // ADR-0186 §3 (as amended by #4443): a platform-typed argument
            // contributes its underlying `T`, never `T!`; the call coerces it
            // `T! → T` and §4 checks that. Only the argument's top level is
            // stripped (a nested `List[string!]` element still infers
            // `string!`). This mirrors `Binder.InferTypeArguments` for the
            // imported-method path, with two slots that keep the argument exact:
            // - a by-reference slot, since a `ref` argument has no coercion to
            //   carry the check;
            // - a slot the declaration leaves oblivious. That slot reads as `T!`
            //   after substitution, so the argument would cross into it with no
            //   check, while the method's other positions (an oblivious
            //   `List<T>` return, say) read the stripped `T` as non-null. A nil
            //   would then reach a `List[string]` unchecked. Keeping `T!` there
            //   keeps the result `List[string!]`, as before.
            let ArgumentForInference = func (parameter ParameterInfo, paramsElement bool, i int32) TypeSymbol? {
                if symbolicArgTypes[i] is not PlatformTypeSymbol platform || parameter.ParameterType.IsByRef {
                    return symbolicArgTypes[i]
                }
                var slot = ClrNullability.GetParameterTypeSymbol(parameter)
                if paramsElement {
                    // The carrier's element through the shared position reader:
                    // an oblivious `params T[]` reads as a platform wrapper over a
                    // flags-annotated array, whose element a symbolic
                    // array/slice test does not reach.
                    let elements = slot.GetElementPositions()
                    slot = if elements.Length == 1 {
                        elements[0]
                    } else {
                        slot
                    }
                }
                return if slot is PlatformTypeSymbol {
                    cast[TypeSymbol](platform)
                } else {
                    platform.UnderlyingType
                }
            }
            if isExpanded && openParams.Length > 0 && ClrOverloadResolution.IsParamsArrayParameter(openParams[^1]) &&
                openParams[^1]
                .ParameterType
                .GetElementType() is Type paramsElementType {
                let paramsIndex = openParams.Length - 1
                let fixedPairs = Math.Min(paramsIndex, argumentCount)
                for var i = 0; i < fixedPairs; i++ {
                    UnifyForMethodTypeArgs(
                        openParams[i].ParameterType,
                        OpenSlotInferenceArgument(
                            openParams[i],
                            ArgumentForInference(openParams[i], paramsElement: false, i)
                        ),
                        openMethod,
                        bounds,
                        ArgumentBoundKind(i)
                    )
                }
                for var i = paramsIndex; i < argumentCount; i++ {
                    UnifyForMethodTypeArgs(
                        paramsElementType,
                        ArgumentForInference(openParams[^1], paramsElement: true, i),
                        openMethod,
                        bounds,
                        ArgumentBoundKind(i)
                    )
                }
            } else {
                let pairs = Math.Min(openParams.Length, argumentCount)
                for var i = 0; i < pairs; i++ {
                    UnifyForMethodTypeArgs(
                        openParams[i].ParameterType,
                        OpenSlotInferenceArgument(
                            openParams[i],
                            ArgumentForInference(openParams[i], paramsElement: false, i)
                        ),
                        openMethod,
                        bounds,
                        ArgumentBoundKind(i)
                    )
                }
            }
            return FixSymbolicMethodTypeArguments(bounds, out requiresRecoveredInference)
        }

        /// The argument a top-level parameter contributes to method type-argument
        /// inference. When the parameter is a bare method type parameter the
        /// declaration annotates (`T? value`), a `X?` argument infers
        /// `T := X`, as in C#, rather than `T := X?`, which would make
        /// `Invariant.Required(p.DeclaringType, …)` return `Type?`.
        /// (cref:NullabilityImportRule.InferOpenSlotArgument) decides it, as
        /// the inverse of the rule that widens the same slot on the way in. A
        /// source method's parameter is already typed `T?` and unifies
        /// through the nullable wrapper, so only imported methods need this.
        /// @param openParameter The open definition's parameter.
        /// @param argument The argument's symbolic type.
        /// @returns The type to unify against the parameter's CLR type.
        private func OpenSlotInferenceArgument(openParameter ParameterInfo, argument TypeSymbol?) TypeSymbol? {
            if !(argument is NullableTypeSymbol) ||
                openParameter.ParameterType is not{IsGenericParameter: true, DeclaringMethod: not nil} {
                return argument
            }
            // The slot as DECLARED: GetParameterTypeSymbol also widens a parameter
            // with a null default, and `T value = default` must not strip `?`.
            return NullabilityImportRule.InferOpenSlotArgument(
                argument,
                ClrNullability.GetParameterDeclaredState(openParameter)
            )
        }

        private func FixSymbolicMethodTypeArguments(
            bounds SymbolicInferenceBounds,
            out requiresRecoveredInference bool
        )[]TypeSymbol? {
            requiresRecoveredInference = false
            let result = [bounds.Arity]TypeSymbol?
            for var slot = 0; slot < bounds.Arity; slot++ {
                let exact = bounds.Exact[slot]
                let lower = bounds.Lower[slot]
                let upper = bounds.Upper[slot]
                requiresRecoveredInference |= HasDistinctSymbolicInferenceBounds(exact, lower, upper)
                var fixedType TypeSymbol?
                if exact != nil && exact.Count > 0 {
                    fixedType = exact[0]
                    for var i = 1; i < exact.Count; i++ {
                        // Exact bounds are non-null, and MergeRecoveredTypeArgument preserves a non-null existing bound.
                        if !DeclarationBinder.TypeSignaturesEquivalent(fixedType, exact[i]) &&
                            !TypeSymbol
                            .AreRuntimeEquivalentIgnoringReferenceNullability(fixedType!!, exact[i]) {
                            fixedType = SymbolicInferenceConflict
                            break
                        }
                        fixedType = MergeRecoveredTypeArgument(fixedType, exact[i], allowBaseWidening: false)
                    }
                } else if lower != nil && lower.Count > 0 || upper != nil && upper.Count > 0 {
                    // Issue #4133: build the candidate set from BOTH categories
                    // together, not from `lower` alone when both are present. A
                    // contravariant argument (`Action<T>`, `IComparer<T>`, ...)
                    // contributes an upper bound that must be able to RAISE the
                    // fixed type past a lower bound contributed by an ordinary
                    // (covariant/invariant) argument — mirroring csc, which lets
                    // `Action<object>` push a `T : DisposableBase` lower bound up
                    // to `object`. The previous `else if` chain here fixed from
                    // `lower` whenever any lower bound existed and only
                    // considered `upper` as a post-hoc validity check
                    // (`SatisfiesSymbolicInferenceBounds` below), never as a
                    // candidate that could WIN — so the upper bound could
                    // validate a narrower answer without ever being allowed to
                    // replace it.
                    fixedType = FindSymbolicInferenceCandidate(lower, upper)
                } else {
                    if (bounds.AmbiguousProjection[slot]) {
                        result[slot] = SymbolicInferenceConflict
                    }
                    continue
                }
                if fixedType == nil {
                    result[slot] = if exact != nil && exact.Count > 0 || upper != nil && upper.Count > 0 {
                        SymbolicInferenceConflict
                    } else {
                        default(TypeSymbol?)
                    }
                    continue
                }
                if IsSymbolicInferenceConflict(fixedType) ||
                    !SatisfiesSymbolicInferenceBounds(fixedType, lower, upper) {
                    result[slot] = SymbolicInferenceConflict
                    continue
                }
                result[slot] = fixedType
            }
            return result
        }

        private func HasDistinctSymbolicInferenceBounds(
            exact IReadOnlyList[TypeSymbol]?,
            lower IReadOnlyList[TypeSymbol]?,
            upper IReadOnlyList[TypeSymbol]?
        ) bool {
            var first TypeSymbol? = nil
            for bounds in[]IReadOnlyList[TypeSymbol]? {exact, lower, upper} {
                if bounds == nil {
                    continue
                }
                for bound in bounds {
                    if first == nil {
                        first = bound
                    } else if !DeclarationBinder.TypeSignaturesEquivalent(first, bound) {
                        return true
                    }
                }
            }
            return false
        }

        /// Issue #4133: picks the fixed type for one type parameter's non-exact
        /// bounds, C# fixing style (§12.6.3.13): the candidate set is the union
        /// of BOTH [`lower`](paramref) and [`upper`](paramref) bounds
        /// together, not [`lower`](paramref) alone when both are present.
        /// A contravariant argument (`Action<T>`,
        /// `IComparer<T>`, ...) contributes an upper bound that must
        /// be able to RAISE the fixed type past a lower bound contributed by an
        /// ordinary (covariant/invariant) argument — mirroring `csc`, which
        /// lets `Action<object>` push a `T : DisposableBase`
        /// lower bound up to `object`. The prior version of this routine
        /// only ever considered ONE category as a candidate SOURCE (the caller
        /// picked [`lower`](paramref) whenever it was non-empty) and used
        /// the other category solely to validate that pick afterwards
        /// ((cref:SatisfiesSymbolicInferenceBounds)), so an upper bound
        /// could confirm a narrower answer without ever being allowed to win.
        private func FindSymbolicInferenceCandidate(
            lower IReadOnlyList[TypeSymbol]?,
            upper IReadOnlyList[TypeSymbol]?
        ) TypeSymbol? {
            // Issue #4133 (review finding): every bound is a candidate, including
            // a signature-equivalent duplicate — the merge branch just below
            // (`TypeSignaturesEquivalent` + `MergeRecoveredTypeArgument`)
            // combines those, and dropping one here first (as an earlier version
            // of this method did) would silently discard whichever of two
            // equivalent bounds differed only in reference nullability or tuple
            // element names, and would make which one survives depend on
            // argument order.
            let candidates = List[TypeSymbol]()
            if lower != nil {
                candidates.AddRange(lower)
            }
            if upper != nil {
                candidates.AddRange(upper)
            }
            var best TypeSymbol? = nil
            for candidate in candidates {
                if !SatisfiesSymbolicInferenceBounds(candidate, lower, upper) {
                    continue
                }
                if best == nil {
                    best = candidate
                    continue
                }
                if DeclarationBinder.TypeSignaturesEquivalent(best, candidate) {
                    best = MergeRecoveredTypeArgument(best, candidate, allowBaseWidening: false)
                    continue
                }
                // Issue #4133 (review finding, hot-core translation guard):
                // a pure reference-nullable-annotation difference (top-level or
                // nested inside a tuple element) is never a real type
                // relationship — the underlying CLR shape is identical, nullable
                // annotations are compile-time-only, and C#'s own fixing
                // (§12.6.3.13) computes nullability separately, AFTER a
                // candidate is picked, never as grounds to eliminate or "raise"
                // one. This check must run BEFORE the directional widening logic
                // below, not only when both directions of
                // `HasImplicitSymbolicConversion` hold: e.g. `string -> string?`
                // is a one-directional, non-structural conversion (`string? ->
                // string` is not implicit — you cannot drop nullability for
                // free), so without this early check an EXPLICITLY-typed lambda
                // parameter whose tuple-element nullability differs from the
                // receiver's element type — `xs.Select((s (Id Guid, Text
                // string?)) -> s.Text)` against `List[(Id Guid, Text string)]`
                // — would "win" through the ordinary one-directional widening
                // branch below exactly the way a genuine base-class upper bound
                // is meant to, resolving `TResult` to the nullable tuple shape.
                // (A BARE METHOD GROUP argument's own parameter type no longer
                // reaches this merge at all for the analogous case — see
                // `SymbolicInferenceBoundKind.MethodGroupUpper`, which
                // `SymbolicInferenceBounds.Add` discards outright rather than
                // routing into any bound list, per C# §12.6.3.7: a method group
                // is never an input inference source, not even as a fallback.
                // Before that fix, this same branch is what
                // let a cs2gs oblivious-nullability method-group parameter
                // cascade a spurious `?` forward into a later call, producing a
                // false ambiguity and a real GS0159
                // (`tools/cs2gs/Cs2Gs.Pipeline/DeclaredProjectItem.cs`); that
                // path no longer reaches here because the group's parameter
                // type is demoted before bound-merging ever sees it.)
                // Resolving to the non-nullable, stripped form deterministically
                // keeps the pre-#4133 default (the lower bound's shape, when it
                // is the non-nullable one) without reintroducing the
                // true-ambiguity failure the merge branch further below exists
                // to close for every OTHER annotation-only difference (a tuple
                // element name, or a nullable difference the directional checks
                // do treat as mutual — see that branch's own comment). Note this
                // is a knowing deviation from C#: given `string` (lower) and
                // `string?` (upper) bounds, C#'s own fixing (§12.6.3.13) would
                // resolve to the exact/upper-compatible annotation (`string?`)
                // and let flow analysis warn separately; gsc instead prefers the
                // non-nullable shape here because it is deterministic without
                // needing flow-sensitive nullable warnings on the inferred type
                // argument itself.
                let strippedBest = StripReferenceNullableAnnotations(best!!)
                let strippedCandidate = StripReferenceNullableAnnotations(candidate)
                if (
                    !object.ReferenceEquals(strippedBest, best) || !object.ReferenceEquals(strippedCandidate, candidate)
                ) &&
                    DeclarationBinder.TypeSignaturesEquivalent(strippedBest, strippedCandidate) {
                    best = strippedBest
                    continue
                }
                // The winner is the unique survivor every OTHER survivor
                // converts into — regardless of which bound category (lower or
                // upper) either one came from. Two survivors sourced from the
                // same category are always mutually convertible (each already
                // had to satisfy "every bound in that category converts into
                // it"), so `bestToCandidate == candidateToBest` there and this
                // falls through to the ambiguous branch exactly as the
                // single-category version did. A lower-sourced survivor paired
                // with a wider upper-sourced one is the new case: only
                // `best -> candidate` holds, so `candidate` (the upper bound)
                // must replace `best` (the lower bound) — the direction the
                // pre-fix code never took.
                let candidateToBest = HasImplicitSymbolicConversion(candidate, best!!)
                let bestToCandidate = HasImplicitSymbolicConversion(best!!, candidate)
                if bestToCandidate && !candidateToBest {
                    best = candidate
                } else if candidateToBest && !bestToCandidate {
                    // `best` already absorbs `candidate`; keep it.

                } else if candidateToBest && bestToCandidate {
                    // Issue #4133 (review finding): mutually convertible in BOTH
                    // directions under `HasImplicitSymbolicConversion`
                    // (identity/reference/boxing/numeric only — no structural
                    // projection) but not `TypeSignaturesEquivalent`, and NOT a
                    // pure nullable-annotation difference (that was handled
                    // above) means the two bounds differ only by a tuple element
                    // name. Merge, using the same ADR-0172 name-reconciliation
                    // logic the equivalent-bounds branch above already applies.
                    // Before this fix ever consulted both bound categories
                    // together (see the dispatch above), a lower-only and an
                    // upper-only bound could never reach this branch in the
                    // first place, so this case is new with #4133.
                    best = MergeRecoveredTypeArgument(best, candidate, allowBaseWidening: false)
                } else {
                    return nil
                }
            }
            return best
        }

        /// Recursively strips reference-nullable annotations — a top-level
        /// (cref:NullableTypeSymbol) wrapping a non-nullable-VALUE-type
        /// underlying type (a real `Nullable<T>` wrapper is left
        /// alone, matching `MergeRecoveredTypeArgument`'s own
        /// `existingNullable`/`incomingNullable` check), and the same
        /// check applied to each element of a (cref:TupleTypeSymbol) —
        /// so two candidates that differ only by nullable annotation, however
        /// deeply nested, compare equal once stripped. Returns the original
        /// instance, unchanged, when nothing needed stripping, so a caller can
        /// tell "no annotation difference here" from a reference comparison
        /// alone.
        private func StripReferenceNullableAnnotations(type TypeSymbol) TypeSymbol {
            if type is NullableTypeSymbol nullable && !NullableLifting.IsAnyValueTypeNullable(nullable) {
                return StripReferenceNullableAnnotations(nullable.UnderlyingType)
            }
            if type is TupleTypeSymbol tuple {
                var changed = false
                let stripped = ImmutableArray.CreateBuilder[TypeSymbol](tuple.ElementTypes.Length)
                for element in tuple.ElementTypes {
                    let strippedElement = StripReferenceNullableAnnotations(element)
                    changed |= !object.ReferenceEquals(strippedElement, element)
                    stripped.Add(strippedElement)
                }
                return if changed {
                    cast[TypeSymbol](TupleTypeSymbol.Get(stripped.MoveToImmutable(), tuple.ElementNames))
                } else {
                    type
                }
            }
            return type
        }

        private func SatisfiesSymbolicInferenceBounds(
            candidate TypeSymbol,
            lower IReadOnlyList[TypeSymbol]?,
            upper IReadOnlyList[TypeSymbol]?
        ) bool -> (lower == nil || lower.All((bound TypeSymbol) -> HasImplicitSymbolicConversion(bound, candidate))) &&
            (upper == nil || upper.All((bound TypeSymbol) -> HasImplicitSymbolicConversion(candidate, bound)))

        /// Issue #4133 (review finding): only the STANDARD implicit conversions
        /// (identity, reference, boxing, numeric widening) participate in
        /// generic-bound elimination/fixing — mirroring
        /// `ClrOverloadResolution.IsInferenceBoundPromotion`'s own comment
        /// on the CLR side. (cref:Conversion.Classify) also admits ADR-0148
        /// structural projection (constructing a new, unrelated user class
        /// through its public constructor/member surface), which is a VALUE
        /// conversion, not a type relationship, and must never let one bound
        /// "satisfy" another — e.g. two structurally-identical but unrelated
        /// classes (a homonym `Item` imported from two different packages) are
        /// not implicitly convertible for inference purposes just because a new
        /// instance of one could be projected from the other. Using
        /// (cref:Conversion.ClassifyNonStructural) here keeps that
        /// projection available for ordinary argument conversions while refusing
        /// to let it decide which upper/lower bound wins.
        ///
        /// Issue #4133 (Copilot review finding, hot-core translation guard PR):
        /// a PURE reference-nullable-annotation difference is treated as
        /// mutually satisfying here too, not only inside
        /// (cref:FindSymbolicInferenceCandidate)'s own merge branch. That
        /// merge branch only ever runs for a bound pair that both independently
        /// pass (cref:SatisfiesSymbolicInferenceBounds) first — this
        /// method IS that gate — so without this check here, a bound PAIR whose
        /// only relationship in the "wrong" direction is a nullable annotation
        /// (e.g. a nullable LOWER bound against a non-nullable UPPER bound, the
        /// mirror image of the shape the merge branch's own comment documents)
        /// was eliminated before ever reaching the merge branch that exists to
        /// resolve it, silently reporting a symbolic-inference conflict instead.
        private func HasImplicitSymbolicConversion(source TypeSymbol, target TypeSymbol) bool {
            if DeclarationBinder.TypeSignaturesEquivalent(source, target) {
                return true
            }
            let strippedSource = StripReferenceNullableAnnotations(source)
            let strippedTarget = StripReferenceNullableAnnotations(target)
            if (!object.ReferenceEquals(strippedSource, source) || !object.ReferenceEquals(strippedTarget, target)) &&
                DeclarationBinder.TypeSignaturesEquivalent(strippedSource, strippedTarget) {
                return true
            }
            return Conversion.ClassifyNonStructural(source, target).IsImplicit
        }

        internal func GetNestedInferenceBoundKind(
            openDefinition Type,
            typeArgumentIndex int32,
            outerKind SymbolicInferenceBoundKind
        ) SymbolicInferenceBoundKind {
            let typeParameters = openDefinition.GetGenericArguments()
            if uint32(typeArgumentIndex) >= uint32(typeParameters.Length) {
                return SymbolicInferenceBoundKind.Exact
            }
            let variance = switch (
                typeParameters[typeArgumentIndex].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            ) {
                case GenericParameterAttributes.Covariant: TypeParameterVariance.Out
                case GenericParameterAttributes.Contravariant: TypeParameterVariance.In
                default: TypeParameterVariance.None
            }
            return GetNestedInferenceBoundKind(variance, outerKind)
        }

        internal func GetNestedInferenceBoundKind(
            variance TypeParameterVariance,
            outerKind SymbolicInferenceBoundKind
        ) SymbolicInferenceBoundKind -> switch variance {
            case TypeParameterVariance.Out: outerKind
            case TypeParameterVariance.In: ReverseInferenceBoundKind(outerKind)
            default: SymbolicInferenceBoundKind.Exact
        }

        /// Issue #4133 (Copilot review finding, hot-core translation guard PR):
        /// unlike ordinary (cref:SymbolicInferenceBoundKind.Lower) /
        /// (cref:SymbolicInferenceBoundKind.Upper), which correctly
        /// toggle back and forth as nested generic-argument variance recurses
        /// (two contravariant levels cancel out, matching real variance),
        /// reversing (cref:SymbolicInferenceBoundKind.MethodGroupUpper)
        /// stays `MethodGroupUpper` rather than cycling back to
        /// (cref:SymbolicInferenceBoundKind.MethodGroupSource). A method
        /// group's own parameter type is discarded (never input-inference
        /// evidence, §12.6.3.7) at ANY nesting depth beneath its own top-level
        /// parameter position, not only at the first level: for
        /// `M[T](items IEnumerable[T], handler Action[Action[T]])` called
        /// with a bare method group `Handler(x Action[object])`, the outer
        /// contravariant position (`Action[Action[T]]`'s own parameter) demotes
        /// once to `MethodGroupUpper`, and the inner one — `Action[T]`'s
        /// own contravariant type argument — recurses a SECOND time. Cycling
        /// back to `MethodGroupSource` there would fall through to an
        /// ordinary (cref:SymbolicInferenceBoundKind.Lower) bound in
        /// (cref:SymbolicInferenceBounds.Add) — reintroducing the method
        /// group's parameter type as genuine evidence through a second
        /// contravariant level, exactly the shape this fix demotes at the
        /// first level. `MethodGroupSource` (unreversed) is produced only
        /// once, directly by the top-level argument's own bound kind — never by
        /// a reversal — so staying sticky here cannot affect the group's own
        /// legitimate top-level OUTPUT (return-type) contribution.
        internal func ReverseInferenceBoundKind(
            kind SymbolicInferenceBoundKind
        ) SymbolicInferenceBoundKind -> switch kind {
            case SymbolicInferenceBoundKind.Lower: SymbolicInferenceBoundKind.Upper
            case SymbolicInferenceBoundKind.Upper: SymbolicInferenceBoundKind.Lower
            case SymbolicInferenceBoundKind.MethodGroupSource: SymbolicInferenceBoundKind.MethodGroupUpper
            case SymbolicInferenceBoundKind.MethodGroupUpper: SymbolicInferenceBoundKind.MethodGroupUpper
            default: SymbolicInferenceBoundKind.Exact
        }

        private func UnifyForMethodTypeArgs(
            openClr Type?,
            actual TypeSymbol?,
            openMethod MethodInfo,
            bounds SymbolicInferenceBounds,
            boundKind SymbolicInferenceBoundKind = SymbolicInferenceBoundKind.Lower
        ) {
            var actual = actual
            if openClr == nil || actual == nil {
                return
            }
            if object.ReferenceEquals(actual, TypeSymbol.Error) {
                return
            }
            var actualForHierarchyProjection = actual
            while actualForHierarchyProjection is NullableTypeSymbol nullableProjectionActual &&
                !NullableLifting
                .IsAnyValueTypeNullable(nullableProjectionActual) {
                actualForHierarchyProjection = nullableProjectionActual.UnderlyingType
            }
            let annotatedActualForProjection NullabilityAnnotatedTypeSymbol? = actualForHierarchyProjection as NullabilityAnnotatedTypeSymbol
            // A direct MVar match must observe the complete symbolic actual before
            // nullable-reference wrappers are removed for outer structural
            // matching. Multiple inference sources join compatible nullable
            // evidence instead of depending on argument order.
            if openClr.IsGenericParameter && openClr.DeclaringMethod != nil {
                if TypeSymbol.ContainsNullLiteralType(actual) {
                    return
                }
                if object.ReferenceEquals(openClr.DeclaringMethod, openMethod) ||
                    openClr.DeclaringMethod!!.MetadataToken == openMethod
                    .MetadataToken {
                    let pos = openClr.GenericParameterPosition
                    if uint32(pos) < uint32(bounds.Arity) {
                        bounds.Add(pos, NormalizeRecoveredNullability(actual), boundKind)
                    }
                }
                return
            }
            // Reference-type nullability is a source annotation and does not add a
            // CLR wrapper. Unify through it so a nullable reference receiver such as
            // IEnumerable<Choice>? still recovers TSource = Choice. Preserve real
            // Nullable<T> value shapes (including same-compilation enums/structs).
            if actual is NullableTypeSymbol nullableActual && !NullableLifting.IsAnyValueTypeNullable(nullableActual) {
                actual = nullableActual.UnderlyingType
            }
            // Issue #2839: the very same annotation arrives as a
            // NullabilityAnnotatedTypeSymbol — not a NullableTypeSymbol — when its
            // provenance is metadata ([NullableAttribute] on an imported member)
            // rather than a source `?`. It is a pure annotation wrapper carrying the
            // imported type's nullable-flag bytes, so structurally it must unify
            // exactly like the source-annotated case above. Without this unwrap an
            // imported nullable collection navigation property (for example
            // `ICollection<Child>?` declared in a referenced assembly) matched none
            // of the structural patterns below, so the element type was never
            // recovered and EF Core's collection `ThenInclude` overload was
            // silently dropped in favour of the scalar one.
            while actual is NullabilityAnnotatedTypeSymbol annotatedActual {
                actual = annotatedActual.BaseType
            }
            if openClr.IsArray && openClr.GetArrayRank() > 1 {
                if actual is RectangularArrayTypeSymbol actualRectangular &&
                    actualRectangular.Rank == openClr
                    .GetArrayRank() {
                    UnifyForMethodTypeArgs(
                        openClr.GetElementType(),
                        actualRectangular.ElementType,
                        openMethod,
                        bounds,
                        boundKind
                    )
                }
                return
            }
            // T[] / []T (open array element).
            if openClr.IsArray && openClr.GetArrayRank() == 1 {
                if actual is RectangularArrayTypeSymbol {
                    return
                }
                let openElement = openClr.GetElementType()
                let actualElement TypeSymbol? = TryGetElementType(actual!!)
                if actualElement != nil {
                    UnifyForMethodTypeArgs(openElement, actualElement, openMethod, bounds, boundKind)
                }
                return
            }
            if openClr.IsByRef {
                let openPointee = openClr.GetElementType()
                if actual is ByRefTypeSymbol bf {
                    UnifyForMethodTypeArgs(
                        openPointee,
                        bf.PointeeType,
                        openMethod,
                        bounds,
                        SymbolicInferenceBoundKind.Exact
                    )
                } else {
                    UnifyForMethodTypeArgs(openPointee, actual, openMethod, bounds, SymbolicInferenceBoundKind.Exact)
                }
                return
            }
            if openClr.IsPointer {
                // Issue #2838: `Vector256.Load[T](*T source)` called with a `*T`
                // argument. Without this case an open pointer parameter matched
                // none of the structural forms above, so `T` was never recovered
                // and the MethodSpec fell back to the erased `object` — emitting
                // `Vector256::Load<System.Object>`, which is not even a
                // constructible instantiation. Mirrors the by-ref case: unify
                // through the pointee, tolerating an actual that is already the
                // pointee rather than a pointer.
                let openPointerPointee = openClr.GetElementType()
                UnifyForMethodTypeArgs(
                    openPointerPointee,
                    if actual is PointerTypeSymbol actualPointer {
                        actualPointer.PointeeType
                    } else {
                        actual
                    },
                    openMethod,
                    bounds,
                    SymbolicInferenceBoundKind.Exact
                )
                return
            }
            if openClr.IsGenericType && !openClr.IsGenericTypeDefinition {
                let openDef = openClr.GetGenericTypeDefinition()
                let openArgs = openClr.GetGenericArguments()
                var foundHierarchyProjection = false
                if (annotatedActualForProjection != nil || actual is ImportedTypeSymbol) &&
                    TryMapUniqueConstructedTypeArgumentsThroughHierarchy(
                    (annotatedActualForProjection ?? actual)!!,
                    openDef,
                    out var hierarchyProjection,
                    out foundHierarchyProjection
                ) {
                    for var i = 0; i < openArgs.Length && i < hierarchyProjection.Length; i++ {
                        UnifyForMethodTypeArgs(
                            openArgs[i],
                            hierarchyProjection[i],
                            openMethod,
                            bounds,
                            GetNestedInferenceBoundKind(openDef, i, boundKind)
                        )
                    }
                    return
                }
                if foundHierarchyProjection {
                    for openArgument in openArgs {
                        MarkAmbiguousInferenceSlots(openArgument, openMethod, bounds)
                    }
                    return
                }
                if actual is TupleTypeSymbol tuple && openDef.FullName?.StartsWith(
                    "System.ValueTuple`",
                    StringComparison.Ordinal
                ) == true &&
                    openArgs.Length == tuple
                    .ElementTypes
                    .Length {
                    for var i = 0; i < openArgs.Length; i++ {
                        UnifyForMethodTypeArgs(
                            openArgs[i],
                            tuple.ElementTypes[i],
                            openMethod,
                            bounds,
                            SymbolicInferenceBoundKind.Exact
                        )
                    }
                    return
                }
                // Pattern A: actual is an imported constructed generic whose open
                // definition matches exactly. Issue #2523 extends this from
                // explicitly-symbolic constructions to ordinary fully-closed CLR
                // returns as well: a non-nullable Include result can legitimately
                // surface as plain IIncludableQueryable<Book, List<Component>>,
                // and a following ThenInclude must still recover TEntity=Book from
                // that receiver before a nullable selector result forces the next
                // return back into symbolic form.
                // ADR-0174 D2: a `chan[T]` / `in chan[T]` / `out chan[T]` actual
                // unifies against an open `Channel<T>` / `ChannelReader<T>` /
                // `ChannelWriter<T>` formal on its element — this is what lets
                // `ch.Close()` on a `chan[Pair]` (same-compilation element, no CLR
                // type) recover T=Pair for the `ChannelExtensions.Close<T>` MethodSpec
                // instead of erasing it to object.
                //
                // Issue #3982: this arm used to demand that the actual be a
                // `ChannelTypeSymbol` — a channel type CLAUSE written in this
                // compilation — AND that its direction name the formal's open
                // definition EXACTLY. Both halves are the spelling-dependence
                // #3976 removed from the conversion lattice and #3877 removed from
                // `ClrOverloadResolution.UnifyForInference`, whose channel arm this
                // one is the symbolic twin of: errata 3 gives `let ch = chan[T](n)`
                // the static type of the runtime class `Chan[T]`, which is not a
                // `ChannelTypeSymbol` at all, and a `chan[T]` receiver reaching a
                // `ChannelReader[T]` formal is the ordinary D2 view rather than a
                // direction mismatch. Recognising every channel-shaped actual
                // through `TryGetChannelShape` and staying direction-BLIND matches
                // its CLR twin word for word: inference produces a bound,
                // `Conversion` owns the lattice and still refuses an `out chan[T]`
                // source against a `ChannelReader[T]` formal at applicability.
                if openArgs.Length == 1 && ChannelTypeSymbol.IsChannelClrDefinitionName(openDef.FullName) &&
                    ChannelTypeSymbol
                    .TryGetChannelShape(actual, out var channelActualElement, out _, out _) {
                    UnifyForMethodTypeArgs(
                        openArgs[0],
                        channelActualElement,
                        openMethod,
                        bounds,
                        GetNestedInferenceBoundKind(openDef, 0, boundKind)
                    )
                    return
                }
                // Issue #4026: a `map[K, V]` is its own symbol kind, so none of the
                // patterns below ever matched a `Dictionary[K, V]` formal and K/V
                // were never recovered symbolically. The MethodSpec then closed over
                // whatever the ERASURE presented — `ImportedBase` for a
                // same-compilation class with an imported base, `object` for one
                // without — while the value pushed was the real
                // `Dictionary<string, Derived>`: ILVerify `StackUnexpected`, on the
                // INFERRED path, with no unusual source at all
                // (`Probes.CountAnyMap(entries)`). Restate the actual as the
                // constructed `Dictionary[K, V]` it IS (ADR-0104) and let Pattern A
                // and Pattern C do the rest, so `IDictionary[K, V]`,
                // `IReadOnlyDictionary[K, V]` and `IEnumerable[KeyValuePair[K, V]]`
                // formals are covered by the same restatement rather than by an arm
                // each. This is why the `List` spelling never had the bug: it is an
                // `ImportedTypeSymbol` already and reached Pattern A on its own.
                if actual is MapTypeSymbol mapActual &&
                    TryProjectErasedClrType(mapActual, out var erasedMapClr) &&
                    erasedMapClr!!
                    .IsGenericType {
                    actual = ImportedTypeSymbol.GetConstructed(
                        erasedMapClr,
                        erasedMapClr!!.GetGenericTypeDefinition(),
                        ImmutableArray.Create(mapActual.KeyType, mapActual.ValueType)
                    )
                }
                if actual is ImportedTypeSymbol imp &&
                    TryGetConstructedImportedProjection(imp, out var projectedImp) &&
                    projectedImp != nil &&
                    ClrTypeUtilities.AreSame(projectedImp.OpenDefinition, openDef) &&
                    projectedImp
                    .TypeArguments
                    .Length == openArgs
                    .Length {
                    for var j = 0; j < openArgs.Length; j++ {
                        UnifyForMethodTypeArgs(
                            openArgs[j],
                            projectedImp.TypeArguments[j],
                            openMethod,
                            bounds,
                            GetNestedInferenceBoundKind(openDef, j, boundKind)
                        )
                    }
                    return
                }
                // Issue #2375: open formal is `Expression<TDelegate>` and actual is a
                // G# arrow/lambda (FunctionTypeSymbol) — i.e. a deferred lambda
                // argument being matched against an expression-tree-wrapped
                // parameter such as `HasOne<TRelated>(Expression<Func<TEntity,
                // TRelated>>)`. A lambda literal's bound type is always its bare
                // `FunctionTypeSymbol` shape (Expression<> wrapping only happens via
                // a later argument CONVERSION, never as the lambda's own natural
                // type), so without this unwrap the outer `openArgs.Length == 1`
                // (Expression`1's own single type argument, the `Func<...>` shape)
                // never matches the FunctionTypeSymbol pattern below (which expects
                // `openArgs.Length` to equal the delegate's own parameter/return
                // arity). Unwrapping one level lets the existing #1334 pattern unify
                // the inner `Func<TEntity, TRelated>` shape against the lambda's
                // parameter/return types directly, recovering `TRelated` for a
                // fully-inferred call (no explicit type argument) whose only
                // occurrence is the delegate's return position.
                if openArgs.Length == 1 && actual is FunctionTypeSymbol && string.Equals(
                    openDef.FullName,
                    "System.Linq.Expressions.Expression`1",
                    StringComparison.Ordinal
                ) {
                    UnifyForMethodTypeArgs(openArgs[0], actual, openMethod, bounds, boundKind)
                    return
                }
                // Issue #2643: infer through the Invoke signature rather than
                // assuming a delegate's generic arguments are its parameters plus
                // return. Named delegates such as ConvertDelegate<T> can mix fixed,
                // nested-generic, and type-parameter slots in an unrelated order.
                if actual is FunctionTypeSymbol namedDelegateFunction && ClrTypeUtilities.IsDelegateType(openClr) {
                    let invoke MethodInfo? = openClr.GetMethodSafe("Invoke")
                    let invokeParameters[]?ParameterInfo = invoke?.GetParameters()
                    if invoke != nil &&
                        invokeParameters != nil &&
                        invokeParameters.Length == namedDelegateFunction
                        .ParameterTypes
                        .Length {
                        for var j = 0; j < invokeParameters.Length; j++ {
                            UnifyForMethodTypeArgs(
                                invokeParameters[j].ParameterType,
                                namedDelegateFunction.ParameterTypes[j],
                                openMethod,
                                bounds,
                                ReverseInferenceBoundKind(boundKind)
                            )
                        }
                        if !FunctionTypeSymbol.IsVoidReturn(namedDelegateFunction.ReturnType) &&
                            !invoke
                            .ReturnType
                            .IsSameAs(typeof(Void)) {
                            UnifyForMethodTypeArgs(
                                invoke.ReturnType,
                                namedDelegateFunction.ReturnType,
                                openMethod,
                                bounds,
                                boundKind
                            )
                        }
                    }
                    return
                }
                // Issue #1334: open formal is a delegate shape (Func<…, TResult> /
                // Action<…>) and actual is a G# arrow/lambda (FunctionTypeSymbol).
                // Unify each delegate parameter with the lambda's parameter type and
                // — for Func — the trailing return slot with the lambda's return
                // type. This recovers a method type parameter that only appears in
                // the projection result (e.g. the `TResult` of
                // `Select<TSource, TResult>(this IEnumerable<TSource>,
                // Func<TSource, TResult>)`) when that result is a same-compilation
                // user type whose CLR backing is still erased to `object` during
                // binding. Without this, `dict.Values.Select((e Entry) -> e.Member)`
                // surfaces `IEnumerable<object>` and the loop variable loses the
                // user element identity (GS0159). The receiver still supplies
                // `TSource` via Pattern C.
                if actual is FunctionTypeSymbol fn {
                    let fnVoid = FunctionTypeSymbol.IsVoidReturn(fn.ReturnType)
                    let expectedArgs = if fnVoid {
                        fn.ParameterTypes.Length
                    } else {
                        fn.ParameterTypes.Length + 1
                    }
                    if openArgs.Length == expectedArgs {
                        for var j = 0; j < fn.ParameterTypes.Length; j++ {
                            UnifyForMethodTypeArgs(
                                openArgs[j],
                                fn.ParameterTypes[j],
                                openMethod,
                                bounds,
                                ReverseInferenceBoundKind(boundKind)
                            )
                        }
                        if !fnVoid {
                            UnifyForMethodTypeArgs(
                                openArgs[openArgs.Length - 1],
                                fn.ReturnType,
                                openMethod,
                                bounds,
                                boundKind
                            )
                        }
                    }
                    return
                }
                // Pattern B: open formal is IEnumerable<T> / IEnumerable<...> and
                // actual is a slice/array/sequence — the element type lifts as the
                // single substitution.
                if openArgs.Length == 1 {
                    let actualElement TypeSymbol? = TryGetElementType(actual!!)
                    if actualElement != nil {
                        UnifyForMethodTypeArgs(
                            openArgs[0],
                            actualElement,
                            openMethod,
                            bounds,
                            GetNestedInferenceBoundKind(openDef, 0, boundKind)
                        )
                        return
                    }
                }
                // Pattern C: actual is an ImportedTypeSymbol whose OpenDefinition is
                // a derived/implementing shape (e.g. List<T> formal-matched against
                // IEnumerable<TSource>). Walk the actual's interfaces/base.
                if actual is ImportedTypeSymbol imp2 &&
                    TryGetConstructedImportedProjection(imp2, out var projectedImp2) &&
                    projectedImp2 != nil {
                    if TryMapThroughImplemented(projectedImp2, openDef, out var liftedArgs) {
                        for var j = 0; j < openArgs.Length && j < liftedArgs.Length; j++ {
                            UnifyForMethodTypeArgs(
                                openArgs[j],
                                liftedArgs[j],
                                openMethod,
                                bounds,
                                GetNestedInferenceBoundKind(openDef, j, boundKind)
                            )
                        }
                    }
                }
            }
        }

        private func MarkAmbiguousInferenceSlots(openClr Type, openMethod MethodInfo, bounds SymbolicInferenceBounds) {
            if openClr.IsGenericParameter && openClr.DeclaringMethod != nil {
                if (
                    object.ReferenceEquals(openClr.DeclaringMethod, openMethod) ||
                        openClr.DeclaringMethod!!.MetadataToken == openMethod.MetadataToken
                ) &&
                    uint32(openClr.GenericParameterPosition) < uint32(bounds.Arity) {
                    // Multiple closed interfaces supply no unique inference bound.
                    // Other arguments may still fix this slot; applicability checks
                    // the resulting closed interface against the actual argument.
                    bounds.AmbiguousProjection[openClr.GenericParameterPosition] = true
                }
                return
            }
            if openClr.HasElementType {
                let element Type? = openClr.GetElementType()
                if element != nil {
                    MarkAmbiguousInferenceSlots(element, openMethod, bounds)
                }
                return
            }
            if openClr.IsGenericType {
                for argument in openClr.GetGenericArguments() {
                    MarkAmbiguousInferenceSlots(argument, openMethod, bounds)
                }
            }
        }

        private func TryGetConstructedImportedProjection(
            imported ImportedTypeSymbol,
            out projected ImportedTypeSymbol?
        ) bool {
            projected = nil
            if imported?.OpenDefinition != nil && !imported.TypeArguments.IsDefaultOrEmpty {
                projected = imported
                return true
            }
            let clr Type? = imported?.ClrType
            if clr == nil || !clr.IsGenericType || clr.IsGenericTypeDefinition {
                return false
            }
            projected = ImportedTypeSymbol.GetConstructed(
                clr,
                clr.GetGenericTypeDefinition(),
                clr
                    .GetGenericArguments()
                    .Select(
                    (argument Type) -> TypeSymbol.FromClrTypeWithoutNullability(
                        argument,
                        NullabilityFreeReason.TypeStructure
                    )
                )
                    .ToImmutableArray()
            )
            return true
        }

        /// Issue #1428: normalizes a symbolic type argument recovered while unifying
        /// a method type parameter (e.g. the `TResult` of `Select`) against
        /// the actual argument shape. A <em>reference</em>-typed nullable (e.g.
        /// `IEnumerator[T]?`) keeps its nullable annotation so the projected
        /// result element (`IEnumerable[IEnumerator[T]?]` → `IEnumerator[T]?[]`)
        /// remains nullable — its CLR backing is identical to the underlying type, so
        /// emit and overload resolution are unaffected by carrying the annotation.
        /// A <em>value</em>-typed nullable (`int?` = `Nullable<int>`) is
        /// still stripped to its underlying type, preserving the pre-existing CLR
        /// encoding expectations for value-type projections.
        private func NormalizeRecoveredNullability(t TypeSymbol) TypeSymbol {
            if t is NullableTypeSymbol nn && nn.UnderlyingType?.ClrType is {IsValueType: true} {
                return nn.UnderlyingType
            }
            return t
        }

        private func MergeRecoveredTypeArgument(
            existing TypeSymbol?,
            incoming TypeSymbol?,
            allowBaseWidening bool = true
        ) TypeSymbol? {
            if existing == nil {
                return incoming
            }
            if incoming == nil || object.ReferenceEquals(existing, incoming) {
                return existing
            }
            if existing.ClrType?.IsSameAs(typeof(object)) == true && TypeSymbol.RequiresSymbolicProjection(incoming) {
                return incoming
            }
            let existingNullable = existing is NullableTypeSymbol en && !NullableLifting.IsAnyValueTypeNullable(en)
            let incomingNullable = incoming is NullableTypeSymbol inn && !NullableLifting.IsAnyValueTypeNullable(inn)
            if existingNullable || incomingNullable {
                let existingUnderlying = if existingNullable {
                    (cast[NullableTypeSymbol](existing)).UnderlyingType
                } else {
                    existing
                }
                let incomingUnderlying = if incomingNullable {
                    (cast[NullableTypeSymbol](incoming)).UnderlyingType
                } else {
                    incoming
                }
                if DeclarationBinder.TypeSignaturesEquivalent(existingUnderlying, incomingUnderlying) {
                    return NullableTypeSymbol.Get(
                        Invariant.Required(
                            MergeRecoveredTypeArgument(existingUnderlying, incomingUnderlying),
                            "equivalent nullable type arguments merge to a type",
                            expression: "MergeRecoveredTypeArgument(existingUnderlying, incomingUnderlying)"
                        )
                    )
                }
            }
            if existing is ImportedTypeSymbol existingImported &&
                incoming is ImportedTypeSymbol incomingImported &&
                existingImported.OpenDefinition != nil &&
                incomingImported.OpenDefinition != nil &&
                ClrTypeUtilities.AreSame(existingImported.OpenDefinition, incomingImported.OpenDefinition) &&
                existingImported
                .TypeArguments
                .Length == incomingImported
                .TypeArguments
                .Length {
                let merged = ImmutableArray.CreateBuilder[TypeSymbol](existingImported.TypeArguments.Length)
                var changed = false
                for var i = 0; i < existingImported.TypeArguments.Length; i++ {
                    let left = existingImported.TypeArguments[i]
                    let right = incomingImported.TypeArguments[i]
                    if !DeclarationBinder.TypeSignaturesEquivalent(left, right) {
                        return existing
                    }
                    let item TypeSymbol? = MergeRecoveredTypeArgument(left, right)
                    if item == nil {
                        return existing
                    }
                    changed |= !object.ReferenceEquals(item, left)
                    merged.Add(item)
                }
                if changed {
                    return ImportedTypeSymbol.GetConstructed(
                        Invariant.Required(
                            existingImported.ClrType,
                            "a constructed imported type has a CLR representation",
                            expression: "existingImported.ClrType"
                        ),
                        existingImported.OpenDefinition,
                        merged.MoveToImmutable()
                    )
                }
            }
            if existing is SliceTypeSymbol existingSlice &&
                incoming is SliceTypeSymbol incomingSlice &&
                DeclarationBinder
                .TypeSignaturesEquivalent(existingSlice.ElementType, incomingSlice.ElementType) {
                return SliceTypeSymbol.Get(
                    Invariant.Required(
                        MergeRecoveredTypeArgument(existingSlice.ElementType, incomingSlice.ElementType),
                        "equivalent slice type arguments merge to an element type",
                        expression: "MergeRecoveredTypeArgument(existingSlice.ElementType, incomingSlice.ElementType)"
                    )
                )
            }
            if existing is ArrayTypeSymbol existingArray &&
                incoming is ArrayTypeSymbol incomingArray &&
                existingArray.Length == incomingArray.Length &&
                DeclarationBinder
                .TypeSignaturesEquivalent(existingArray.ElementType, incomingArray.ElementType) {
                return ArrayTypeSymbol.Get(
                    Invariant.Required(
                        MergeRecoveredTypeArgument(existingArray.ElementType, incomingArray.ElementType),
                        "equivalent array type arguments merge to an element type",
                        expression: "MergeRecoveredTypeArgument(existingArray.ElementType, incomingArray.ElementType)"
                    ),
                    existingArray.Length
                )
            }
            if existing is RectangularArrayTypeSymbol existingRectangular &&
                incoming is RectangularArrayTypeSymbol incomingRectangular &&
                existingRectangular.Rank == incomingRectangular.Rank &&
                DeclarationBinder
                .TypeSignaturesEquivalent(existingRectangular.ElementType, incomingRectangular.ElementType) {
                return RectangularArrayTypeSymbol.Get(
                    Invariant.Required(
                        MergeRecoveredTypeArgument(existingRectangular.ElementType, incomingRectangular.ElementType),
                        "equivalent rectangular-array type arguments merge to an element type",
                        expression: `MergeRecoveredTypeArgument(
                        existingRectangular.ElementType,
                        incomingRectangular.ElementType)`
                    ),
                    existingRectangular.Rank
                )
            }
            if existing is TupleTypeSymbol existingTuple &&
                incoming is TupleTypeSymbol incomingTuple &&
                existingTuple
                .ElementTypes
                .Length == incomingTuple
                .ElementTypes
                .Length {
                let merged = ImmutableArray.CreateBuilder[TypeSymbol](existingTuple.ElementTypes.Length)
                for var i = 0; i < existingTuple.ElementTypes.Length; i++ {
                    if !DeclarationBinder.TypeSignaturesEquivalent(
                        existingTuple.ElementTypes[i],
                        incomingTuple.ElementTypes[i]
                    ) {
                        return existing
                    }
                    let item TypeSymbol? = MergeRecoveredTypeArgument(
                        existingTuple.ElementTypes[i],
                        incomingTuple.ElementTypes[i]
                    )
                    if item == nil {
                        return existing
                    }
                    merged.Add(item)
                }
                // ADR-0172: keep element names the two sides agree on; drop the
                // rest (the C# common-type rule for tuple names).
                var mergedNames = ImmutableArray[string?].Empty
                if existingTuple.HasNames || incomingTuple.HasNames {
                    let namesBuilder = ImmutableArray.CreateBuilder[string?](existingTuple.ElementTypes.Length)
                    for var i = 0; i < existingTuple.ElementTypes.Length; i++ {
                        let existingName = if existingTuple.HasNames {
                            existingTuple.ElementNames[i]
                        } else {
                            default(string?)
                        }
                        let incomingName = if incomingTuple.HasNames {
                            incomingTuple.ElementNames[i]
                        } else {
                            default(string?)
                        }
                        namesBuilder.Add(
                            if string.Equals(existingName, incomingName, StringComparison.Ordinal) {
                                existingName
                            } else {
                                default(string?)
                            }
                        )
                    }
                    mergedNames = namesBuilder.MoveToImmutable()
                }
                return TupleTypeSymbol.Get(merged.MoveToImmutable(), mergedNames)
            }
            // Issue #3896: C# type-argument fixing (§12.6.3.11) resolves a type
            // parameter to the bound every other bound converts to. The CLR-side
            // unification already does that ("promote toward the common base: keep
            // the more general type when one is assignable from the other", in
            // ClrOverloadResolution.UnifyForInference), but a SAME-COMPILATION
            // class is erased to `object` in the closed CLR method, so its bounds
            // only ever meet here — and this merge kept whichever bound arrived
            // first. `ImmutableArray.Create(BoundLiteralExpression(…), boundExpr)`
            // therefore recovered `ImmutableArray[BoundLiteralExpression]` while
            // the same call with the arguments swapped recovered
            // `ImmutableArray[BoundExpression]`: an argument-ORDER-dependent
            // inference that made a correct call unbindable (GS0154). Promote
            // toward the base class, matching the CLR path.
            // <para>Only bounds from covariant (value) positions widen —
            // <paramref name="allowBaseWidening"/> is false for a bound recovered
            // from a DELEGATE PARAMETER, which is an upper bound, not a lower one.
            // `interfaces.Where(isUserNested)` over an `ImmutableArray[Interface&#173;Symbol]`
            // whose predicate is a `func(TypeSymbol) bool` must stay
            // `Where[InterfaceSymbol]`; widening it to `TypeSymbol` binds fine and
            // emits a MethodSpec whose receiver no longer matches — IL that gsc
            // accepts and ILVerify rejects (StackUnexpected).</para>
            // `object` is excluded on both sides: it is what CLR erasure produces
            // for a same-compilation type, not evidence of a real `object` bound.
            // The rule at the top of this method already prefers the symbolic side
            // in the mirror-image order, and widening to `object` here would undo
            // it.
            if allowBaseWidening && existing.ClrType?.IsSameAs(typeof(object)) != true && incoming.ClrType?.IsSameAs(
                typeof(object)
            ) != true {
                if IsBaseTypeOf(existing, incoming) {
                    return existing
                }
                if IsBaseTypeOf(incoming, existing) {
                    return incoming
                }
            }
            return if !TypeSymbol.ContainsReferenceNullableAnnotation(existing) &&
                TypeSymbol.ContainsReferenceNullableAnnotation(incoming) && DeclarationBinder.TypeSignaturesEquivalent(
                existing,
                incoming
            ) {
                incoming
            } else {
                existing
            }
        }

        /// Issue #3896: whether [`candidateBase`](paramref) is a (transitive)
        /// base type of [`derived`](paramref). Used by inference-bound merging
        /// to fix a type parameter at the more general of two class bounds, the way
        /// C# fixing does. Only base CLASSES are walked: an interface bound is not a
        /// unique fixing candidate (a type may implement several), so widening to
        /// one would be an arbitrary choice.
        /// @param candidateBase The candidate base type.
        /// @param derived The candidate derived type.
        /// @returns `true` when the chain reaches the candidate base.
        private func IsBaseTypeOf(candidateBase TypeSymbol?, derived TypeSymbol?) bool {
            if candidateBase == nil || derived == nil {
                return false
            }
            // A malformed hierarchy must not hang the binder; the depth cap is far
            // above any real inheritance chain.
            const MaxDepth = 64
            var current TypeSymbol? = derived.BaseType
            {
                var depth = 0
                while current != nil && depth < MaxDepth {
                    if DeclarationBinder.TypeSignaturesEquivalent(current, candidateBase) {
                        return true
                    }
                    depth++
                    current = current.BaseType
                }
            }
            return false
        }

        private func TryGetElementType(t TypeSymbol) TypeSymbol? {
            let direct TypeSymbol? = switch t {
                case s is SliceTypeSymbol: s.ElementType
                case a is ArrayTypeSymbol: a.ElementType
                case a is RectangularArrayTypeSymbol: a.ElementType
                case seq is SequenceTypeSymbol: seq.ElementType
                case aseq is AsyncSequenceTypeSymbol: aseq.ElementType
                default: default(TypeSymbol?)
            }
            if direct != nil || t is not StructSymbol sourceType {
                return direct
            }
            for implemented in sourceType.ImplementedClrInterfaces {
                if implemented is ImportedTypeSymbol imported &&
                    TryGetConstructedImportedProjection(imported, out var projected) &&
                    projected != nil &&
                    TryMapThroughImplemented(projected, typeof(IEnumerable[_]), out var arguments) &&
                    arguments.Length == 1 {
                    return arguments[0]
                }
            }
            return nil
        }

        private func TryMapThroughImplemented(
            imp ImportedTypeSymbol,
            targetOpenDef Type,
            out liftedArgs ImmutableArray[TypeSymbol]
        ) bool {
            liftedArgs = default(ImmutableArray[TypeSymbol])
            if imp.OpenDefinition == nil {
                return false
            }
            // Walk the open definition's interfaces/base for an instantiation of
            // targetOpenDef, then substitute the symbolic args back through.
            for iface in EnumerateOpenInterfacesAndBases(imp.OpenDefinition) {
                if !iface.IsGenericType || !ClrTypeUtilities.AreSame(iface.GetGenericTypeDefinition(), targetOpenDef) {
                    continue
                }
                let openArgs = iface.GetGenericArguments()
                let lifted = ImmutableArray.CreateBuilder[TypeSymbol](openArgs.Length)
                for oa in openArgs {
                    lifted.Add(
                        MapOpenClrTypeToSymbolicWithoutNullability(
                            oa,
                            imp.OpenDefinition,
                            imp.TypeArguments,
                            NullabilityFreeReason.TypeStructure
                        )
                    )
                }
                liftedArgs = lifted.MoveToImmutable()
                return true
            }
            return false
        }

        private func EnumerateOpenInterfacesAndBases(openDef Type) sequence[Type] {
            // Issue #4559: sparse InterfaceImpl metadata (as G# emits it) lists only
            // the DIRECT interfaces of a type, so GetInterfaces() on a class or
            // interface omits interfaces inherited through them (IReadOnlyCollection<T>
            // -> IEnumerable<T>). Close the set transitively, through every base type
            // as well, so generic inference sees the same hierarchy it sees for a
            // C#-emitted assembly. A constructed interface's GetInterfaces() already
            // substitutes its type arguments.
            let seen = HashSet[Type]()
            let pending = Stack[Type]()
            yield openDef
            // Seed in reverse so popping visits the type's own interfaces first,
            // in metadata order, then those of its base types.
            let roots = List[Type](openDef.GetInterfaces())
            for var baseType Type? = openDef.BaseType; baseType != nil && !baseType.IsSameAs(typeof(object));
                baseType = baseType!!.BaseType {
                roots.AddRange(baseType.GetInterfaces())
            }
            for var i = roots.Count - 1; i >= 0; i-- {
                pending.Push(roots[i])
            }
            while pending.Count > 0 {
                let iface = pending.Pop()
                if !seen.Add(iface) {
                    continue
                }
                yield iface
                let inherited = iface.GetInterfaces()
                for var i = inherited.Length - 1; i >= 0; i-- {
                    pending.Push(inherited[i])
                }
            }
            for var baseType Type? = openDef.BaseType; baseType != nil && !baseType.IsSameAs(typeof(object));
                baseType = baseType!!.BaseType {
                yield baseType
            }
        }

        /// Issue #932: builds an erased CLR `System.Func<...>` /
        /// `System.Action<...>` delegate type for a
        /// (cref:FunctionTypeSymbol) whose natural `ClrType` is null
        /// because one of its parameter / return types is symbolic (a
        /// same-compilation user class, enum, or open type parameter). Each
        /// component is erased through (cref:TryEraseDelegateComponentClrType)
        /// so the result matches the erasure the surrounding generic call applies to
        /// its other arguments.
        /// @param functionType The literal's bound function type.
        /// @param erased On success, the erased delegate CLR type.
        /// @returns `true` when an erased delegate type was built.
        private func TryProjectErasedDelegateClrType(functionType FunctionTypeSymbol?, out erased Type?) bool {
            erased = nil
            if functionType == nil {
                return false
            }
            let paramClr = [functionType.ParameterTypes.Length]Type
            for var i = 0; i < paramClr.Length; i++ {
                if !TryEraseDelegateComponentClrType(functionType.ParameterTypes[i], out var parameterClr) ||
                    parameterClr == nil {
                    return false
                }
                paramClr[i] = parameterClr
            }
            // Issue #3646: a throw-expression lambda's natural return is the bottom
            // (`never`) type, which has no CLR erasure but satisfies every result
            // slot (issue #2716) — erase it like `void` so the Action<...> shape
            // gates applicability; conversion re-shapes the literal downstream.
            let isVoid = FunctionTypeSymbol.IsVoidReturn(functionType.ReturnType) ||
                functionType.ReturnType == TypeSymbol.Never
            var returnClr Type? = nil
            if !isVoid && !TryEraseDelegateComponentClrType(functionType.ReturnType, out returnClr) {
                return false
            }
            if !isVoid && returnClr == nil {
                return false
            }
            erased = if isVoid {
                BuildActionClrType(paramClr)
            } else {
                BuildFuncClrType(paramClr, returnClr)
            }
            return erased != nil
        }

        /// Issue #932: erases a single delegate parameter / return
        /// (cref:TypeSymbol) to a CLR (cref:System.Type), mapping
        /// symbolic shapes the same way (cref:ImportedClassSymbol)'s
        /// argument-type erasure does (user class → its imported base or
        /// `object`, enum → `int32`); non-symbolic and other erasable
        /// shapes fall back to (cref:TryProjectErasedClrType).
        /// @param t The component type to erase.
        /// @param clr On success, the erased CLR type.
        /// @returns `true` when an erasure exists.
        private func TryEraseDelegateComponentClrType(t TypeSymbol?, out clr Type?) bool {
            clr = nil
            if t == nil {
                return false
            }
            if t.ClrType != nil {
                clr = t.ClrType
                return true
            }
            switch t {
                case StructSymbol{IsClass: true} userClass {
                    clr = TypeMemberModel.GetNearestImportedBase(userClass)?.ClrType ?? typeof(object)
                    return true
                }
                case EnumSymbol {
                    clr = typeof(int32)
                    return true
                }
                default {
                    return TryProjectErasedClrType(t, out clr)
                }
            }
        }

        private func BuildActionClrType(paramClr[]Type) Type? -> switch paramClr.Length {
            case 0: typeof(() -> void)
            case 1: typeof(Action[_]).MakeGenericType(paramClr)
            case 2: typeof(Action[_, _]).MakeGenericType(paramClr)
            case 3: typeof(Action[_, _, _]).MakeGenericType(paramClr)
            case 4: typeof(Action[_, _, _, _]).MakeGenericType(paramClr)
            case 5: typeof(Action[_, _, _, _, _]).MakeGenericType(paramClr)
            case 6: typeof(Action[_, _, _, _, _, _]).MakeGenericType(paramClr)
            case 7: typeof(Action[_, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 8: typeof(Action[_, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 9: typeof(Action[_, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 10: typeof(Action[_, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 11: typeof(Action[_, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 12: typeof(Action[_, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 13: typeof(Action[_, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 14: typeof(Action[_, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 15: typeof(Action[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            case 16: typeof(Action[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(paramClr)
            default: default(Type?)
        }

        private func BuildFuncClrType(paramClr[]Type, returnClr Type?) Type? {
            if returnClr == nil {
                return nil
            }
            let args = [paramClr.Length + 1]Type
            Array.Copy(paramClr, args, paramClr.Length)
            args[paramClr.Length] = returnClr
            return switch paramClr.Length {
                case 0: typeof(Func[_]).MakeGenericType(args)
                case 1: typeof(Func[_, _]).MakeGenericType(args)
                case 2: typeof(Func[_, _, _]).MakeGenericType(args)
                case 3: typeof(Func[_, _, _, _]).MakeGenericType(args)
                case 4: typeof(Func[_, _, _, _, _]).MakeGenericType(args)
                case 5: typeof(Func[_, _, _, _, _, _]).MakeGenericType(args)
                case 6: typeof(Func[_, _, _, _, _, _, _]).MakeGenericType(args)
                case 7: typeof(Func[_, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 8: typeof(Func[_, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 9: typeof(Func[_, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 10: typeof(Func[_, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 11: typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 12: typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 13: typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 14: typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 15: typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                case 16: typeof(Func[_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _]).MakeGenericType(args)
                default: default(Type?)
            }
        }

        /// Issue #2230: compares a candidate implementer's parameter/return
        /// (cref:TypeSymbol) against a CLR contract position that may
        /// reference an imported (metadata) interface METHOD's own generic
        /// parameter (e.g. the `TState` in `ILogger.BeginScope<TState>`
        /// / `ILogger.Log<TState>`), either directly or nested inside ANY
        /// constructed generic shape — a delegate (e.g.
        /// `Func<TState, Exception, string>`), an array (`TState[]`),
        /// or any other constructed generic type (`IEnumerable<TState>`,
        /// `IComparer<TState>`, `Nullable<TState>`, a custom
        /// generic, etc.), at any nesting depth (e.g.
        /// `IEnumerable<IEnumerable<TState>>`).
        /// Falls back to the existing erased-`ClrType` comparison
        /// ((cref:FindMatchingMethodForClrSignature)'s comparison) for
        /// every other position, so ordinary non-generic contract members are
        /// unaffected.
        /// @param candidate The implementer's parameter or return type.
        /// @param openType The corresponding CLR contract type (from the open generic method definition).
        /// @param methodGenericParams The interface method's own generic-parameter (cref:Type)s, positionally.
        /// @param candidateTypeParams The implementer method's own type parameters, positionally.
        /// @returns `true` when the positions match.
        private func ClrParamTypeMatchesGenericMethodParam(
            candidate TypeSymbol?,
            openType Type?,
            methodGenericParams[]Type,
            candidateTypeParams ImmutableArray[TypeParameterSymbol]
        ) bool {
            if candidate == nil || openType == nil {
                return false
            }
            // Direct method-type-parameter position (e.g. `TState state`):
            // match by position against the implementer's own method type
            // parameter — an unbound G# type parameter has no ClrType, so the
            // erased comparison below can never succeed for it.
            if openType.IsGenericMethodParameter {
                let position = Array.IndexOf(methodGenericParams, openType)
                return position >= 0 && position < candidateTypeParams.Length && object.ReferenceEquals(
                    candidate,
                    candidateTypeParams[position]
                )
            }
            // Fast path: no method type parameter involved at or below this
            // position — the pre-existing erased-ClrType comparison works
            // (covers the overwhelming majority of contract positions,
            // including non-generic methods entirely).
            let effectiveClr Type? = NullableLifting.GetEffectiveClrType(candidate)
            if effectiveClr != nil && ClrTypeUtilities.AreSame(effectiveClr, openType) {
                return true
            }
            // Issue #3088: reference-nullable tuple elements make the tuple's
            // direct ClrType unavailable even when every element has an exact CLR
            // identity. Reuse the structural tuple/nullable projection before
            // falling back to method-type-parameter matching.
            if effectiveClr == nil &&
                (
                candidate is TupleTypeSymbol ||
                    candidate is NullableTypeSymbol &&
                    candidate.UnderlyingType is TupleTypeSymbol
            ) &&
                !TypeSymbol.ContainsTypeParameter(candidate) && !TypeSymbol.ContainsSameCompilationUserType(
                candidate
            ) &&
                TryProjectErasedClrType(candidate, out var projectedClr) &&
                ClrTypeUtilities.AreSame(projectedClr, openType) {
                return true
            }
            // Slow path: a constructed generic contract position nests the
            // method's own type parameter (e.g. `Func<TState, Exception, string>`
            // in `Log<TState>(..., Func<TState, Exception, string> formatter)`),
            // which erases to a null ClrType (FunctionTypeSymbol.BuildClrType
            // bails when any parameter has no ClrType). Recurse structurally
            // through the delegate's `Invoke` shape instead.
            if candidate is FunctionTypeSymbol fn && openType.IsConstructedGenericType {
                let invoke MethodInfo? = openType.GetMethodSafe("Invoke")
                if invoke == nil {
                    return false
                }
                let invokeParams = invoke.GetParameters()
                if invokeParams.Length != fn.ParameterTypes.Length {
                    return false
                }
                for var i = 0; i < invokeParams.Length; i++ {
                    if !ClrParamTypeMatchesGenericMethodParam(
                        fn.ParameterTypes[i],
                        invokeParams[i].ParameterType,
                        methodGenericParams,
                        candidateTypeParams
                    ) {
                        return false
                    }
                }
                if invoke.ReturnType.IsSameAs(typeof(Void)) {
                    return FunctionTypeSymbol.IsVoidReturn(fn.ReturnType)
                }
                return ClrParamTypeMatchesGenericMethodParam(
                    fn.ReturnType,
                    invoke.ReturnType,
                    methodGenericParams,
                    candidateTypeParams
                )
            }
            // Slow path: an array contract position nests the method's own type
            // parameter (e.g. `TState[]` in `CopyTo<TState>(TState[] items)`).
            // C#/CLR arrays aren't "generic types" in the reflection sense
            // (`IsConstructedGenericType` is false), so they need their own
            // element-wise recursion against the G# array-of-T shapes.
            if openType.IsArray {
                let openElementType = openType.GetElementType()
                let (candidateElementType, candidateRank) = switch candidate {
                    case arr is ArrayTypeSymbol: (arr.ElementType, 1)
                    case slice is SliceTypeSymbol: (slice.ElementType, 1)
                    case rectangular is RectangularArrayTypeSymbol: (rectangular.ElementType, rectangular.Rank)
                    default: (nil, 0)
                }
                return candidateElementType != nil && candidateRank == openType.GetArrayRank() &&
                    ClrParamTypeMatchesGenericMethodParam(
                    candidateElementType,
                    openElementType,
                    methodGenericParams,
                    candidateTypeParams
                )
            }
            // Slow path: any other constructed generic contract position nests
            // the method's own type parameter (e.g. `IEnumerable<TState>`,
            // `IComparer<TState>`, `Nullable<TState>`, or a custom imported/
            // source generic, at any nesting depth). Recurse positionally
            // through the CLR open type's generic arguments against the G#
            // symbol's own symbolic type arguments — the same pattern as the
            // delegate-Invoke-shape branch above, generalized to any generic
            // type rather than just delegates.
            if openType.IsConstructedGenericType &&
                TryGetSymbolicConstructedGenericShape(
                candidate,
                out var candidateOpenDefinition,
                out var candidateTypeArguments
            ) &&
                ClrTypeUtilities
                .AreSame(openType.GetGenericTypeDefinition(), candidateOpenDefinition) {
                let openArgs = openType.GetGenericArguments()
                if openArgs.Length != candidateTypeArguments.Length {
                    return false
                }
                for var i = 0; i < openArgs.Length; i++ {
                    if !ClrParamTypeMatchesGenericMethodParam(
                        candidateTypeArguments[i],
                        openArgs[i],
                        methodGenericParams,
                        candidateTypeParams
                    ) {
                        return false
                    }
                }
                return true
            }
            return false
        }

        /// Issue #3695: folds an event declaration's `[Nullable]` metadata
        /// into the symbolic handler type, mirroring the field path's
        /// (cref:NullableFlagsBuilder.MergeDeclarationNullability) call.
        /// Without it a handler declared `Func<…, Assembly?>` presented
        /// a non-null `Assembly` return to lambda target typing, so an arrow
        /// lambda subscribing to the event could not `return nil`.
        /// The event slot's own top-level nullability is deliberately dropped: it
        /// describes the delegate field, not the handler shape a lambda is
        /// converted to (and a nullable target suppresses lambda target typing).
        /// @param mapped The symbolically-substituted handler type.
        /// @param openEvent The event as declared on the open definition.
        /// @param openDefinition The open declaring type, for `[NullableContext]` lookup.
        /// @returns The handler type with declaration-site nullability applied.
        @NullabilityFunnel
        private func ApplyEventDeclarationNullability(
            mapped TypeSymbol,
            openEvent EventInfo,
            openDefinition Type
        ) TypeSymbol {
            if openEvent.EventHandlerType is not Type handlerLayout {
                return mapped
            }
            let declarationFlags = ClrNullability.ReadNullableFlags(openEvent, openDefinition)
            let merged = NullableFlagsBuilder.MergeDeclarationNullability(mapped, handlerLayout, declarationFlags)
            return if merged is NullableTypeSymbol nullableHandler {
                nullableHandler.UnderlyingType
            } else {
                merged
            }
        }

        /// Issue #3712 follow-up: projects a closed generic method's own CLR type
        /// arguments onto symbols, for use as the method-level substitution vector
        /// of (cref:MapOpenClrTypeToSymbolic(Type, Type, ImmutableArray{TypeSymbol}, MethodInfo,
        /// ImmutableArray{TypeSymbol})).
        /// Returns `default` for a non-generic (or still open)
        /// method, which leaves the method-level substitution disabled exactly as
        /// before.
        /// @param closedMethod The closed method selected by overload resolution.
        /// @returns The per-MVar symbol vector, or default when there is nothing to substitute.
        private func BuildMethodTypeArgSymbolsFromClosedMethod(closedMethod MethodInfo?) ImmutableArray[TypeSymbol?] {
            if closedMethod == nil || !closedMethod.IsGenericMethod || closedMethod.IsGenericMethodDefinition {
                return default(ImmutableArray[TypeSymbol?])
            }
            let closedTypeArgs = closedMethod.GetGenericArguments()
            let builder = ImmutableArray.CreateBuilder[TypeSymbol?](closedTypeArgs.Length)
            for closedTypeArg in closedTypeArgs {
                // A closed method's type argument is a component of the closed
                // MethodInfo, not a signature position: no nullability was ever
                // recorded on the CLR Type.
                builder.Add(
                    MapOpenClrTypeToSymbolicWithoutNullability(
                        closedTypeArg,
                        openDefinition: nil,
                        typeArguments: default(ImmutableArray[TypeSymbol]),
                        NullabilityFreeReason.TypeStructure
                    )
                )
            }
            return builder.MoveToImmutable()
        }

        /// Locates the open-generic-definition counterpart of [`closedMethod`](paramref)
        /// on [`openDefinition`](paramref). Match is by metadata token + module,
        /// which is stable for methods on a constructed generic type (the
        /// reflection layer reports the open token regardless of the closing).
        /// @param openDefinition The open generic type definition.
        /// @param closedMethod The closed method to project.
        /// @returns The open method, or `null` when no match.
        private func TryGetOpenInstanceMethod(openDefinition Type?, closedMethod MethodInfo?) MethodInfo? {
            if openDefinition == nil || closedMethod == nil {
                return nil
            }
            if ClrTypeUtilities.AreSame(closedMethod.DeclaringType, openDefinition) {
                return closedMethod
            }
            let token = closedMethod.MetadataToken
            let module = closedMethod.Module
            let bindingFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            for candidate in openDefinition.GetMethods(bindingFlags) {
                if candidate.MetadataToken == token && object.ReferenceEquals(candidate.Module, module) {
                    return candidate
                }
            }
            return nil
        }
    }
}
