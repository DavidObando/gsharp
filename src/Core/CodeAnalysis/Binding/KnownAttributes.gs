// <copyright file="KnownAttributes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.InteropServices

/// Type-identity recogniser for the closed set of compiler-recognised
/// attributes (ADR-0047 §6). All checks key off the resolved CLR
/// (cref:System.Type) on a (cref:BoundAttribute) rather
/// than a string name, so renaming an attribute type or shadowing it in
/// user code never breaks compiler semantics.
/// @remarks Issue #835 / ADR-0084 §L5: recognisers compare resolved metadata identity
/// rather than CLR reference identity (`clrType.IsSameAs(typeof(X))`).
/// The reference-identity form silently regresses on the BuildTask path, where
/// imported attribute types are materialised through a
/// (cref:System.Reflection.MetadataLoadContext) and therefore are
/// never reference-equal to the gsc host process's `typeof()` instances.
/// Safety-sensitive runtime attributes additionally require the runtime
/// assembly's simple name and public key token.
internal shared class KnownAttributes {
    // FullName strings instead of typeof(...) so MetadataLoadContext-loaded
    // attribute types match against the reserved set just like host-process
    // ones do (issue #835).
    private let ReservedForCompilerNames HashSet[string] = HashSet[string](StringComparer.Ordinal){
        "System.Runtime.CompilerServices.ExtensionAttribute",
        "System.Runtime.CompilerServices.AsyncStateMachineAttribute",
        "System.Runtime.CompilerServices.CompilerGeneratedAttribute",
        "System.Runtime.CompilerServices.NullableAttribute",
        "System.Runtime.CompilerServices.NullableContextAttribute"
    }

    /// Returns `true` when [`clrType`](paramref) is one of the
    /// attributes ADR-0047 §6 reserves for compiler synthesis. Users
    /// must not write these in source.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` if the attribute is reserved for the compiler.
    func IsReservedForCompiler(clrType Type?) bool {
        return clrType?.FullName != nil && ReservedForCompilerNames.Contains(clrType!!.FullName!!)
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.ObsoleteAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[Obsolete]`.
    func IsObsolete(attribute BoundAttribute?) bool {
        return attribute?.AttributeType?.ClrType.IsSameAs(typeof(ObsoleteAttribute)) == true
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.InteropServices.DllImportAttribute). ADR-0047 §6
    /// recognises `[DllImport]` but only on declarations whose body marker is
    /// `extern`, which is post-v1.0; for v1.0 the binder reports
    /// `GS0211` (`ERR_DllImportNotSupported`) on any use in source.
    /// Recognition is type-identity based so renaming or shadowing the
    /// source-level name cannot bypass the rule.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[DllImport]`.
    func IsDllImport(clrType Type?) bool {
        return clrType.IsSameAs(typeof(DllImportAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.InteropServices.DllImportAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[DllImport]`.
    func IsDllImport(attribute BoundAttribute?) bool {
        return IsDllImport(attribute?.AttributeType?.ClrType)
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.NotNullWhenAttribute).
    /// ADR-0047 §6 / issue #178: recognised on imported metadata and on
    /// user-written annotations alike; type-identity based so renaming or
    /// shadowing the source-level name cannot bypass the rule.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[NotNullWhen]`.
    func IsNotNullWhen(clrType Type?) bool {
        return clrType.IsSameAs(typeof(NotNullWhenAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.NotNullWhenAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[NotNullWhen]`.
    func IsNotNullWhen(attribute BoundAttribute?) bool {
        return IsNotNullWhen(attribute?.AttributeType?.ClrType)
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute).
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[MaybeNullWhen]`.
    func IsMaybeNullWhen(clrType Type?) bool {
        return clrType.IsSameAs(typeof(MaybeNullWhenAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[MaybeNullWhen]`.
    func IsMaybeNullWhen(attribute BoundAttribute?) bool {
        return IsMaybeNullWhen(attribute?.AttributeType?.ClrType)
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.MemberNotNullAttribute).
    /// Recognised so it round-trips through the attribute pipeline; field
    /// post-condition tracking is a follow-up.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[MemberNotNull]`.
    func IsMemberNotNull(clrType Type?) bool {
        return clrType.IsSameAs(typeof(MemberNotNullAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.MemberNotNullAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[MemberNotNull]`.
    func IsMemberNotNull(attribute BoundAttribute?) bool {
        return IsMemberNotNull(attribute?.AttributeType?.ClrType)
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.MemberNotNullWhenAttribute).
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[MemberNotNullWhen]`.
    func IsMemberNotNullWhen(clrType Type?) bool {
        return clrType.IsSameAs(typeof(MemberNotNullWhenAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Diagnostics.CodeAnalysis.MemberNotNullWhenAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[MemberNotNullWhen]`.
    func IsMemberNotNullWhen(attribute BoundAttribute?) bool {
        return IsMemberNotNullWhen(attribute?.AttributeType?.ClrType)
    }

    /// Extracts the `returnValue` boolean from a `[NotNullWhen(...)]`
    /// application. The single positional argument is the boolean trigger
    /// (issue #178 / ADR-0047 §6): when the method's `bool` return
    /// matches this value, the annotated parameter is known non-null in the
    /// caller's post-state.
    /// @param attribute A bound attribute application.
    /// @param returnValue Receives the `returnValue` argument.
    /// @returns `true` when [`attribute`](paramref) is `[NotNullWhen]` and the argument is a constant
    /// (cref:bool).
    func TryGetNotNullWhenReturnValue(attribute BoundAttribute, out returnValue bool) bool {
        returnValue = false
        return IsNotNullWhen(attribute) && TryGetSingleBoolArgument(attribute, out returnValue)
    }

    /// Extracts the `returnValue` boolean from a `[MaybeNullWhen(...)]`
    /// application — the inverse postcondition to (cref:TryGetNotNullWhenReturnValue).
    /// @param attribute A bound attribute application.
    /// @param returnValue Receives the `returnValue` argument.
    /// @returns `true` when [`attribute`](paramref) is `[MaybeNullWhen]` and the argument is a constant
    /// (cref:bool).
    func TryGetMaybeNullWhenReturnValue(attribute BoundAttribute, out returnValue bool) bool {
        returnValue = false
        return IsMaybeNullWhen(attribute) && TryGetSingleBoolArgument(attribute, out returnValue)
    }

    /// Collects all member names from every `[MemberNotNull("_f1", "_f2", …)]`
    /// attribute in [`attributes`](paramref). Issue #208: the post-call
    /// postcondition lists which fields are non-null after the annotated method
    /// returns. Multiple attributes and multiple string arguments per attribute
    /// are both supported.
    /// @param attributes The attribute list on a function symbol.
    /// @param members Receives the collected member names.
    /// @returns `true` when at least one name was collected.
    func TryGetMemberNotNullMembers(
        attributes ImmutableArray[BoundAttribute],
        out members ImmutableArray[string]
    ) bool {
        members = ImmutableArray[string].Empty
        if attributes.IsDefaultOrEmpty {
            return false
        }
        var builder ImmutableArray[string].Builder? = nil
        for attr in attributes {
            if !IsMemberNotNull(attr) || attr.PositionalArguments.IsDefaultOrEmpty {
                continue
            }
            for arg in attr.PositionalArguments {
                if arg.Value is string s && !string.IsNullOrEmpty(s) {
                    (
                        (
                            if builder == nil {
                                (builder = ImmutableArray.CreateBuilder[string]())
                            } else {
                                builder
                            }
                        )!!
                    ).Add(s)
                } else if arg.Value is Array values {
                    for value in values {
                        if value is string member && !string.IsNullOrEmpty(member) {
                            (
                                (
                                    if builder == nil {
                                        (builder = ImmutableArray.CreateBuilder[string]())
                                    } else {
                                        builder
                                    }
                                )!!
                            ).Add(member)
                        }
                    }
                }
            }
        }
        if builder == nil {
            return false
        }
        members = builder.ToImmutable()
        return true
    }

    /// Extracts the `returnValue` boolean and field names from a single
    /// `[MemberNotNullWhen(returnValue, "_f1", "_f2", …)]` attribute.
    /// Issue #208: on the arm where the call returns [`returnValue`](paramref)
    /// the named fields are guaranteed non-null.
    /// @param attribute A bound attribute application.
    /// @param returnValue Receives the `returnValue` argument.
    /// @param members Receives the member names.
    /// @returns `true` when [`attribute`](paramref) is a valid
    /// `[MemberNotNullWhen]` with at least one string member.
    func TryGetMemberNotNullWhenData(
        attribute BoundAttribute,
        out returnValue bool,
        out members ImmutableArray[string]
    ) bool {
        returnValue = false
        members = ImmutableArray[string].Empty
        let returnArgument = attribute.GetConstructorArgument(0, "returnValue")
        if !IsMemberNotNullWhen(attribute) || returnArgument?.Value is not bool rv {
            return false
        }
        let builder = ImmutableArray.CreateBuilder[string]()
        for argument in attribute.PositionalArguments {
            if object.ReferenceEquals(argument, returnArgument) {
                continue
            }
            if argument.Value is string s && !string.IsNullOrEmpty(s) {
                builder.Add(s)
            } else if argument.Value is Array values {
                for value in values {
                    if value is string member && !string.IsNullOrEmpty(member) {
                        builder.Add(member)
                    }
                }
            }
        }
        if builder.Count == 0 {
            return false
        }
        returnValue = rv
        members = builder.ToImmutable()
        return true
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.CompilerServices.EnumeratorCancellationAttribute).
    /// Recognition is type-identity based (ADR-0047 §6 / ADR-0040): the
    /// resolved CLR type — not the source name — selects the behaviour, so a
    /// renamed or shadowed alias cannot bypass the validation rules.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[EnumeratorCancellation]`.
    func IsEnumeratorCancellation(clrType Type?) bool {
        return clrType.IsSameAs(typeof(EnumeratorCancellationAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.CompilerServices.EnumeratorCancellationAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[EnumeratorCancellation]`.
    func IsEnumeratorCancellation(attribute BoundAttribute?) bool {
        return IsEnumeratorCancellation(attribute?.AttributeType?.ClrType)
    }

    /// Returns the first `[EnumeratorCancellation]` attribute in
    /// [`attributes`](paramref), or `null` if none is present.
    /// @param attributes The attribute list on a parameter symbol.
    /// @returns The matching attribute, or `null`.
    func FindEnumeratorCancellation(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsEnumeratorCancellation(attr) {
                return attr
            }
        }
        return nil
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Diagnostics.ConditionalAttribute). ADR-0047 §6 /
    /// issue #176: calls to a method carrying one or more
    /// `[Conditional("SYMBOL")]` applications are elided at every call
    /// site at which none of the named symbols is in the active preprocessor
    /// symbol set. Recognition is type-identity based so renaming or shadowing
    /// the source-level name cannot bypass the rule.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[Conditional]`.
    func IsConditional(clrType Type?) bool {
        return clrType.IsSameAs(typeof(ConditionalAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Diagnostics.ConditionalAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[Conditional]`.
    func IsConditional(attribute BoundAttribute?) bool {
        return IsConditional(attribute?.AttributeType?.ClrType)
    }

    /// Returns `true` when any attribute in [`attributes`](paramref)
    /// is (cref:System.Diagnostics.ConditionalAttribute). Used by the
    /// function-declaration binder to drive the void-return validation
    /// (ADR-0047 §6 / issue #176).
    /// @param attributes The attribute list on a function symbol.
    /// @returns `true` when at least one `[Conditional]` is present.
    func HasConditional(attributes ImmutableArray[BoundAttribute]) bool {
        if attributes.IsDefaultOrEmpty {
            return false
        }
        for attr in attributes {
            if IsConditional(attr) {
                return true
            }
        }
        return false
    }

    /// ADR-0184 / issue #376: returns `true` when [`clrType`](paramref)
    /// is (cref:System.Diagnostics.CodeAnalysis.UnscopedRefAttribute).
    /// Recognition is type-identity based (ADR-0084 §L5) — the string-matching
    /// recognition this replaces could be defeated by a same-named user
    /// attribute and could not see the attribute through an alias. Runtime
    /// identity compares the full type name, assembly simple name and public
    /// key token; assembly version and culture do not affect recognition.
    /// Issue #4584: any of the BCL identities that define the attribute
    /// (System.Private.CoreLib at run time, the System.Runtime reference
    /// assembly in an SDK build) is accepted, still by name and key.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[UnscopedRef]`.
    func IsUnscopedRef(clrType Type?) bool {
        return IsKnownRuntimeAttribute(clrType, typeof(UnscopedRefAttribute))
    }

    /// Returns whether [`clrType`](paramref) is the runtime `ScopedRefAttribute`.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute has the runtime type identity.
    func IsScopedRef(clrType Type?) bool {
        return IsKnownRuntimeAttribute(clrType, typeof(ScopedRefAttribute))
    }

    /// Returns whether [`clrType`](paramref) is the runtime `RefSafetyRulesAttribute`.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute has the runtime type identity.
    func IsRefSafetyRules(clrType Type?) bool {
        return IsKnownRuntimeAttribute(
            clrType,
            typeof(ScopedRefAttribute),
            "System.Runtime.CompilerServices.RefSafetyRulesAttribute"
        )
    }

    private func IsKnownRuntimeAttribute(candidate Type?, expected Type, expectedFullName string? = nil) bool {
        if candidate == nil || !string.Equals(
            candidate.FullName,
            expectedFullName ?? expected.FullName,
            StringComparison.Ordinal
        ) {
            return false
        }
        let candidateAssembly = candidate.Assembly.GetName()
        let expectedAssembly = expected.Assembly.GetName()
        let candidateToken = candidateAssembly.GetPublicKeyToken() ?? Array.Empty[uint8]()
        let expectedToken = expectedAssembly.GetPublicKeyToken() ?? Array.Empty[uint8]()
        return (
            string.Equals(candidateAssembly.Name, expectedAssembly.Name, StringComparison.OrdinalIgnoreCase) &&
                candidateToken
                .AsSpan().SequenceEqual(expectedToken)
        ) ||
            (
            IsPlatformAssemblyIdentity(candidateAssembly.Name, candidateToken) &&
                IsPlatformAssemblyIdentity(expectedAssembly.Name, expectedToken)
        )
    }

    // Issue #4584: the same BCL type has a different assembly identity
    // depending on where gsc loaded it from. The host runtime defines
    // `typeof(UnscopedRefAttribute)` in System.Private.CoreLib, but a project
    // built by the SDK binds against the reference assembly (System.Runtime,
    // a different name AND key), so a name-and-token comparison against the
    // host type rejected the genuine attribute and GS0589 fired on members
    // that carried `@UnscopedRef`. Platform identities are listed explicitly
    // rather than matched by name alone, so a same-named user assembly with a
    // different key is still not recognized (issue #835 / ADR-0084 section L5,
    // the metadata-identity rule this file follows; ADR-0184 section 1 for
    // UnscopedRef).
    // ReferenceResolver.WellKnownBclAssemblyNames is name-only, so it cannot
    // serve this token-checked identity test.
    private func IsPlatformAssemblyIdentity(name string?, publicKeyToken[]uint8) bool -> switch (
        name?.ToLowerInvariant(),
        Convert.ToHexString(publicKeyToken).ToLowerInvariant()
    ) {
        case {Item1: "system.private.corelib", Item2: "7cec85d7bea7798e"}: true
        case {Item1: "system.runtime", Item2: "b03f5f7f11d50a3a"}: true
        case {Item1: "mscorlib", Item2: "b77a5c561934e089"}: true
        case {Item1: "netstandard", Item2: "cc7b13ffcd2ddd51"}: true
        default: false
    }

    /// ADR-0184 / issue #376: returns `true` when [`attribute`](paramref)
    /// is (cref:System.Diagnostics.CodeAnalysis.UnscopedRefAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[UnscopedRef]`.
    func IsUnscopedRef(attribute BoundAttribute?) bool {
        return IsUnscopedRef(attribute?.AttributeType?.ClrType)
    }

    /// ADR-0184 / issue #376: returns `true` when the bound attribute list
    /// carries `@UnscopedRef`, which lifts the implicit `scoped` on a
    /// struct instance member's `this` so the member may return a
    /// reference into its own instance state.
    /// @param attributes The attribute list on a function or property symbol.
    /// @returns `true` when at least one `[UnscopedRef]` is present.
    func HasUnscopedRef(attributes ImmutableArray[BoundAttribute]) bool {
        if attributes.IsDefaultOrEmpty {
            return false
        }
        for attr in attributes {
            if IsUnscopedRef(attr) {
                return true
            }
        }
        return false
    }

    /// Returns `true` when [`attributes`](paramref) carries
    /// (cref:System.Diagnostics.CodeAnalysis.AllowNullAttribute)
    /// (issue #3907).
    /// @remarks `[AllowNull]` is the .NET-standard "this INPUT accepts
    /// `null` even though its type is not nullable" annotation. It is the
    /// one nullability contract G# cannot spell in a type, because ADR-0155
    /// gives a declaration a single nullability (Kotlin-style) while C# gives
    /// it separate input and output contracts. cs2gs widens a REFERENCE-typed
    /// `[AllowNull]` declaration to `T?` (issue #3694) — the two
    /// contracts then agree — but an UNCONSTRAINED type parameter has no such
    /// widening, so `[AllowNull] T value` translates verbatim to
    /// `@AllowNull value T` and only the annotation carries the
    /// contract.
    ///
    /// Consumed by `ConversionClassifier` to relax the ARGUMENT
    /// conversion at a call site — never the parameter's own type, which is
    /// exactly the asymmetry the attribute exists to express: reads inside the
    /// body still see a non-nullable `T` and still require the author's
    /// `!!`.
    /// @param attributes The attribute list on a parameter symbol.
    /// @returns `true` when at least one `[AllowNull]` is present.
    func HasAllowNull(attributes ImmutableArray[BoundAttribute]) bool {
        if attributes.IsDefaultOrEmpty {
            return false
        }
        for attr in attributes {
            if attr?.AttributeType?.ClrType.IsSameAs(typeof(AllowNullAttribute)) == true {
                return true
            }
        }
        return false
    }

    /// Returns `true` when [`attributes`](paramref) contains at
    /// least one `[Conditional("SYMBOL")]` application and *none* of the
    /// named symbols is present in [`preprocessorSymbols`](paramref). In
    /// that case the call site must be elided per ADR-0047 §6 / issue #176.
    /// Returns `false` when no `[Conditional]` attribute is present
    /// (so the caller emits the call normally) or when at least one named
    /// symbol is defined (the C# rule is "any defined symbol keeps the call").
    /// Attributes whose positional argument is missing or not a string are
    /// ignored for the purpose of elision; they were already reported as
    /// invalid by attribute argument binding.
    /// @param attributes The attribute list on the called function.
    /// @param preprocessorSymbols The active preprocessor symbol set; never `null`.
    /// @returns `true` when the call should be elided.
    func IsConditionallyElided(
        attributes ImmutableArray[BoundAttribute],
        preprocessorSymbols ICollection[string]?
    ) bool {
        if attributes.IsDefaultOrEmpty {
            return false
        }
        var sawConditional = false
        for attr in attributes {
            if !IsConditional(attr) {
                continue
            }
            sawConditional = true
            if attr.GetConstructorArgument(0, "conditionString")
                ?.Value is string symbol &&
                preprocessorSymbols != nil &&
                preprocessorSymbols.Contains(symbol) {
                return false
            }
        }
        return sawConditional
    }

    /// Looks for an `[Obsolete]` attribute in [`attributes`](paramref)
    /// and extracts its `message` and `isError` arguments.
    /// @param attributes The attribute list on the symbol.
    /// @param message The optional user-supplied message, or `null`.
    /// @param isError Whether the attribute's `error` flag is set.
    /// @returns `true` if any attribute in the list is `[Obsolete]`.
    func TryGetObsolete(attributes ImmutableArray[BoundAttribute], out message string?, out isError bool) bool {
        message = nil
        isError = false
        if attributes.IsDefaultOrEmpty {
            return false
        }
        for attr in attributes {
            if !IsObsolete(attr) {
                continue
            }
            if attr.GetConstructorArgument(0, "message")?.Value is string s {
                message = s
            }
            if attr.GetConstructorArgument(1, "error")?.Value is bool b {
                isError = b
            }
            return true
        }
        return false
    }

    /// Resolves the effective (cref:AttributeUsageAttribute) for the
    /// candidate attribute class [`attributeType`](paramref). ADR-0047
    /// §6 / issue #177: an `@AttributeUsage(...)` annotation on a
    /// user-declared `@Attribute` class supplies `ValidOn` and
    /// `AllowMultiple`; CLR-imported attribute types are read via
    /// (cref:System.Reflection.CustomAttributeData) so they work for
    /// types loaded through a `MetadataLoadContext`. When the attribute
    /// carries no `AttributeUsage` the
    /// C# defaults apply: (cref:AttributeTargets.All) /
    /// `AllowMultiple = false`.
    /// @param attributeType The resolved attribute type symbol.
    /// @param validOn Receives the `ValidOn` flag set.
    /// @param allowMultiple Receives the `AllowMultiple` flag.
    func GetAttributeUsage(attributeType TypeSymbol?, out validOn AttributeTargets, out allowMultiple bool) {
        validOn = AttributeTargets.All
        allowMultiple = false
        if attributeType == nil {
            return
        }
        if attributeType is StructSymbol structSym && structSym.DerivesFromSystemAttribute() {
            if TryReadAttributeUsageFromBound(structSym.Attributes, out var v, out var am) {
                validOn = v
                allowMultiple = am
            }
            return
        }
        let clr Type? = attributeType.ClrType
        if clr == nil {
            return
        }
        // Attribute types may be loaded through a MetadataLoadContext (reference
        // assemblies), where runtime-reflection Attribute.GetCustomAttribute(s)
        // throws InvalidOperationException. Read the [AttributeUsage] data via
        // CustomAttributeData instead, which works for both runtime and
        // metadata-loaded types. Walk the base-type chain to honour inherited
        // usage, matching Attribute.GetCustomAttribute(..., inherit: true).
        if TryReadAttributeUsageFromClr(clr, out var clrValidOn, out var clrAllowMultiple) {
            validOn = clrValidOn
            allowMultiple = clrAllowMultiple
        }
    }

    private func TryReadAttributeUsageFromClr(clr Type, out validOn AttributeTargets, out allowMultiple bool) bool {
        validOn = AttributeTargets.All
        allowMultiple = false
        var current Type? = clr
        var isSelf = true
        while current != nil && !current.IsSameAs(typeof(object)) {
            var data IList[CustomAttributeData]
            try {
                data = current.GetCustomAttributesData()
            } catch {
                return false
            }
            for cad in data {
                if cad.AttributeType?.FullName != typeof(AttributeUsageAttribute).FullName {
                    continue
                }
                var inheritedForBase = true
                var localValidOn = AttributeTargets.All
                var localAllowMultiple = false
                if cad.ConstructorArguments != nil &&
                    cad
                    .ConstructorArguments
                    .Count >= 1 &&
                    TryConvertToInt32(cad.ConstructorArguments[0].Value, out var raw) {
                    localValidOn = AttributeTargets(raw)
                }
                if cad.NamedArguments != nil {
                    for named in cad.NamedArguments {
                        if named.MemberName == "AllowMultiple" && named.TypedValue.Value is bool b {
                            localAllowMultiple = b
                        } else if named.MemberName == "Inherited" && named.TypedValue.Value is bool inh {
                            inheritedForBase = inh
                        }
                    }
                }
                // For the attribute type itself any usage applies. For an
                // ancestor the usage is only inherited when Inherited != false.
                if isSelf || inheritedForBase {
                    validOn = localValidOn
                    allowMultiple = localAllowMultiple
                    return true
                }
            }
            try {
                current = current.BaseType
            } catch {
                return false
            }
            isSelf = false
        }
        return false
    }

    private func TryReadAttributeUsageFromBound(
        attributes ImmutableArray[BoundAttribute],
        out validOn AttributeTargets,
        out allowMultiple bool
    ) bool {
        validOn = AttributeTargets.All
        allowMultiple = false
        if attributes.IsDefaultOrEmpty {
            return false
        }
        for attr in attributes {
            if attr?.AttributeType?.ClrType.IsSameAs(typeof(AttributeUsageAttribute)) != true {
                continue
            }
            if attr.GetConstructorArgument(0, "validOn") is {} validOnArgument &&
                TryConvertToInt32(validOnArgument.Value, out var raw) {
                validOn = AttributeTargets(raw)
            }
            if !attr.NamedArguments.IsDefaultOrEmpty {
                for named in attr.NamedArguments {
                    if named.Name == "AllowMultiple" && named.Value is bool b {
                        allowMultiple = b
                    }
                }
            }
            return true
        }
        return false
    }

    private func TryConvertToInt32(value object?, out result int32) bool {
        switch value {
            case i is int32 {
                result = i
                return true
            }
            case s is int16 {
                result = s
                return true
            }
            case by is uint8 {
                result = by
                return true
            }
            case sb is int8 {
                result = sb
                return true
            }
            case us is uint16 {
                result = us
                return true
            }
            case ui is uint32 {
                result = int32(ui)
                return true
            }
            case l is int64 {
                result = int32(l)
                return true
            }
            case at is AttributeTargets {
                result = int32(at)
                return true
            }
            case mio is MethodImplOptions {
                result = int32(mio)
                return true
            }
            default {
                result = 0
                return false
            }
        }
    }

    private func TryGetSingleBoolArgument(attribute BoundAttribute, out value bool) bool {
        value = false
        if attribute?.GetConstructorArgument(0, "returnValue")?.Value is not bool b {
            return false
        }
        value = b
        return true
    }

    /// Finds the first `@DllImport(...)` attribute on
    /// [`attributes`](paramref), or `null` when none is present.
    /// Recognition is type-identity based (ADR-0086 / issue #727).
    /// @param attributes The attributes attached to a function symbol.
    /// @returns The matching attribute, or `null`.
    func FindDllImport(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsDllImport(attr) {
                return attr
            }
        }
        return nil
    }

    /// Returns the resolved CLR enum value for a named argument whose
    /// declared property type is `TEnum`. The binder
    /// stores enum constants as their underlying primitive value, so we
    /// must convert by name lookup (when the source text is a member name)
    /// or by integer round-trip (when the value is a primitive constant).
    /// @typeparam TEnum The CLR enum type to convert to.
    /// @param value The bound constant value carried by the attribute argument.
    /// @param result Receives the resolved enum value on success.
    /// @returns `true` when conversion succeeded; `false` otherwise.
    func TryConvertAttributeEnum[TEnum Enum struct](value object?, out result TEnum) bool {
        result = default(TEnum)
        if value == nil {
            return false
        }
        if value is TEnum already {
            result = already
            return true
        }
        if value is string name && Enum.TryParse[TEnum](name, ignoreCase: false, out var parsed) {
            result = parsed
            return true
        }
        if TryConvertToInt32(value, out var asInt) {
            let underlying = TEnum(Enum.ToObject(typeof(TEnum), asInt))
            if Enum.IsDefined(typeof(TEnum), underlying) {
                result = underlying
                return true
            }
        }
        return false
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.InteropServices.LibraryImportAttribute).
    /// ADR-0092 / issue #758: `@LibraryImport(...)` is the modern
    /// source-generator-shaped P/Invoke attribute. Recognition is
    /// type-identity based so renaming or shadowing the source-level name
    /// cannot bypass the rule.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[LibraryImport]`.
    func IsLibraryImport(clrType Type?) bool {
        return clrType.IsSameAs(typeof(LibraryImportAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.InteropServices.LibraryImportAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[LibraryImport]`.
    func IsLibraryImport(attribute BoundAttribute?) bool {
        return IsLibraryImport(attribute?.AttributeType?.ClrType)
    }

    /// Returns `true` for a method attribute whose semantics belong on
    /// the hidden native entry point synthesized for `@LibraryImport`.
    /// The managed outer stub must not retain these attributes.
    /// @param attribute A bound method attribute.
    /// @returns `true` for an attribute forwarded to the inner P/Invoke.
    func IsLibraryImportInnerMethodAttribute(attribute BoundAttribute?) bool {
        let clrType Type? = attribute?.AttributeType?.ClrType
        return clrType.IsSameAs(typeof(SuppressGCTransitionAttribute)) || clrType.IsSameAs(
            typeof(DefaultDllImportSearchPathsAttribute)
        )
    }

    /// Finds the first `@LibraryImport(...)` attribute on
    /// [`attributes`](paramref), or `null` when none is present.
    /// Recognition is type-identity based (ADR-0092 / issue #758).
    /// @param attributes The attributes attached to a function symbol.
    /// @returns The matching attribute, or `null`.
    func FindLibraryImport(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsLibraryImport(attr) {
                return attr
            }
        }
        return nil
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.InteropServices.UnmanagedFunctionPointerAttribute).
    /// ADR-0095 / issue #761: delegate types passed to native callbacks
    /// must carry this attribute so the CLR records the unmanaged
    /// calling convention for the synthesized function-pointer thunk.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[UnmanagedFunctionPointer]`.
    func IsUnmanagedFunctionPointer(clrType Type?) bool {
        return clrType.IsSameAs(typeof(UnmanagedFunctionPointerAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.InteropServices.UnmanagedFunctionPointerAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[UnmanagedFunctionPointer]`.
    func IsUnmanagedFunctionPointer(attribute BoundAttribute?) bool {
        return IsUnmanagedFunctionPointer(attribute?.AttributeType?.ClrType)
    }

    /// Finds the first `@UnmanagedFunctionPointer(...)` attribute on
    /// [`attributes`](paramref), or `null` when none is
    /// present. ADR-0095 / issue #761.
    /// @param attributes The attributes attached to a symbol.
    /// @returns The matching attribute, or `null`.
    func FindUnmanagedFunctionPointer(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsUnmanagedFunctionPointer(attr) {
                return attr
            }
        }
        return nil
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.InteropServices.StructLayoutAttribute).
    /// ADR-0093 / issue #759: `@StructLayout(LayoutKind.…)` is a
    /// pseudo-custom attribute — the CLR consumes its arguments to set
    /// the `TypeAttributes` layout flag and to write a
    /// `ClassLayout` row, so the emitter must NOT also write it as
    /// a `CustomAttribute` row.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[StructLayout]`.
    func IsStructLayout(clrType Type?) bool {
        return clrType.IsSameAs(typeof(StructLayoutAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.InteropServices.StructLayoutAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[StructLayout]`.
    func IsStructLayout(attribute BoundAttribute?) bool {
        return IsStructLayout(attribute?.AttributeType?.ClrType)
    }

    /// Finds the first `@StructLayout(...)` attribute on
    /// [`attributes`](paramref), or `null` when none is present
    /// (ADR-0093 / issue #759).
    /// @param attributes The attributes attached to a struct or class symbol.
    /// @returns The matching attribute, or `null`.
    func FindStructLayout(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsStructLayout(attr) {
                return attr
            }
        }
        return nil
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.InteropServices.FieldOffsetAttribute).
    /// ADR-0093 / issue #759: `@FieldOffset(N)` is the per-field
    /// peer of `@StructLayout` — also a pseudo-custom attribute that
    /// the emitter encodes via `AddFieldLayout` rather than as a
    /// `CustomAttribute` row.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[FieldOffset]`.
    func IsFieldOffset(clrType Type?) bool {
        return clrType.IsSameAs(typeof(FieldOffsetAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.InteropServices.FieldOffsetAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[FieldOffset]`.
    func IsFieldOffset(attribute BoundAttribute?) bool {
        return IsFieldOffset(attribute?.AttributeType?.ClrType)
    }

    /// Finds the first `@FieldOffset(N)` attribute on
    /// [`attributes`](paramref), or `null` when none is present.
    /// @param attributes The attributes attached to a field symbol.
    /// @returns The matching attribute, or `null`.
    func FindFieldOffset(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsFieldOffset(attr) {
                return attr
            }
        }
        return nil
    }

    /// Returns `true` when [`attribute`](paramref) is a CLR
    /// pseudo-custom attribute whose state lives in dedicated metadata
    /// rows rather than a `CustomAttribute` row. The emitter elides
    /// these from the user-attribute pass to avoid producing a
    /// duplicate / misleading reflection view (ADR-0086 §6,
    /// ADR-0092 §6, ADR-0093 §5, ADR-0096 §5, ADR-0084 §L5).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is pseudo-custom.
    func IsPseudoCustomAttribute(attribute BoundAttribute?) bool {
        return IsDllImport(attribute) ||
            IsLibraryImport(attribute) ||
            IsStructLayout(attribute) ||
            IsFieldOffset(attribute) ||
            IsMarshalAs(attribute) ||
            IsMethodImpl(attribute)
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.CompilerServices.MethodImplAttribute).
    /// ADR-0084 §L5 / issue #806: `@MethodImpl(MethodImplOptions.…)`
    /// is a pseudo-custom attribute — its state encodes into the
    /// `MethodImpl` field of the MethodDef row (the bits read by
    /// (cref:System.Reflection.MethodBase.GetMethodImplementationFlags))
    /// rather than into a `CustomAttribute` row. Recognition is
    /// type-identity based so shadowing the source-level name cannot
    /// bypass the rule.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[MethodImpl]`.
    func IsMethodImpl(clrType Type?) bool {
        // Use FullName matching (not typeof identity) so the recognition
        // also fires when the attribute type comes from the consumer's
        // referenced assembly set via MetadataLoadContext rather than
        // the gsc host process. Issue #806: the production SDK build of
        // Gsharp.Extensions hit this gap — every `@MethodImpl(...)` on a
        // hot extension helper was being silently demoted to a regular
        // CustomAttribute row, leaving the MethodImpl field unchanged
        // (so AggressiveInlining never applied at runtime).
        return clrType?.FullName == "System.Runtime.CompilerServices.MethodImplAttribute"
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.CompilerServices.MethodImplAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[MethodImpl]`.
    func IsMethodImpl(attribute BoundAttribute?) bool {
        return IsMethodImpl(attribute?.AttributeType?.ClrType)
    }

    /// Finds the first `@MethodImpl(...)` attribute on
    /// [`attributes`](paramref), or `null` when none is present.
    /// Recognition is type-identity based (ADR-0084 §L5 / issue #806).
    /// @param attributes The attributes attached to a function symbol.
    /// @returns The matching attribute, or `null`.
    func FindMethodImpl(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsMethodImpl(attr) {
                return attr
            }
        }
        return nil
    }

    /// Extracts the (cref:System.Runtime.CompilerServices.MethodImplOptions)
    /// bits from a `@MethodImpl(...)` application. The recognised
    /// constructor shapes are `MethodImpl()`,
    /// `MethodImpl(MethodImplOptions options)`, and
    /// `MethodImpl(short value)` — all map to the same options
    /// bit-field at the metadata level.
    /// @param attribute A `@MethodImpl` attribute application; may be `null`.
    /// @returns The options bits (zero when absent or unrecognised).
    func GetMethodImplOptions(attribute BoundAttribute?) MethodImplOptions {
        let argument BoundAttributeArgument? = attribute?.GetConstructorArgument(0, "methodImplOptions") ??
            attribute?.GetConstructorArgument(0, "value")
        if argument == nil {
            return default(MethodImplOptions)
        }
        if TryConvertToInt32(argument.Value, out var raw) {
            return MethodImplOptions(raw)
        }
        if argument.Value is MethodImplOptions options {
            return options
        }
        return default(MethodImplOptions)
    }

    /// Returns `true` when [`clrType`](paramref) is
    /// (cref:System.Runtime.InteropServices.MarshalAsAttribute).
    /// ADR-0096 / issue #762: `@MarshalAs(UnmanagedType.…)` is a
    /// pseudo-custom attribute — its state is encoded into a
    /// `FieldMarshal` table row and the
    /// `ParameterAttributes.HasFieldMarshal` bit, so the emitter
    /// must NOT also write it as a `CustomAttribute` row.
    /// @param clrType The resolved attribute CLR type, or `null`.
    /// @returns `true` when the attribute is `[MarshalAs]`.
    func IsMarshalAs(clrType Type?) bool {
        return clrType.IsSameAs(typeof(MarshalAsAttribute))
    }

    /// Returns `true` when [`attribute`](paramref) is
    /// (cref:System.Runtime.InteropServices.MarshalAsAttribute).
    /// @param attribute A bound attribute application.
    /// @returns `true` when the attribute is `[MarshalAs]`.
    func IsMarshalAs(attribute BoundAttribute?) bool {
        return IsMarshalAs(attribute?.AttributeType?.ClrType)
    }

    /// Finds the first `@MarshalAs(...)` attribute on
    /// [`attributes`](paramref), or `null` when none is present
    /// (ADR-0096 / issue #762).
    /// @param attributes The attributes attached to a parameter symbol.
    /// @returns The matching attribute, or `null`.
    func FindMarshalAs(attributes ImmutableArray[BoundAttribute]) BoundAttribute? {
        if attributes.IsDefaultOrEmpty {
            return nil
        }
        for attr in attributes {
            if IsMarshalAs(attr) {
                return attr
            }
        }
        return nil
    }
}
