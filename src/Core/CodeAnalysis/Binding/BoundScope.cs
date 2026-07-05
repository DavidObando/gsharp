// <copyright file="BoundScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound scope.
/// </summary>
public sealed class BoundScope
{
    private ImmutableDictionary<string, Symbol>.Builder symbols;
    private ImmutableArray<string>.Builder symbolKeys;
    private ImmutableDictionary<string, ImmutableArray<FunctionSymbol>.Builder>.Builder functions;
    private ImmutableArray<string>.Builder functionKeys;
    private ImmutableArray<ImportSymbol>.Builder imports;
    private ImmutableDictionary<string, TypeSymbol>.Builder typeAliases;
    private ImmutableArray<string>.Builder typeAliasKeys;
    private ImmutableArray<FunctionSymbol>.Builder extensionFunctions;

    // Issue #1680: name-keyed index over extensionFunctions. Extension lookup is a
    // per-call-site hot path run for every member call that doesn't resolve as an
    // instance member, so a flat per-scope list forced an O(callsites x extensions)
    // scan (plus an O(E^2) inner pass in ReceiverConvertibilitySpecificity). Every
    // extension is bucketed by name here as it's declared; lookups probe the bucket
    // for the call-site name instead of the full list, then run the exact same
    // receiver-matching (identity/CLR, generic-unification, subtype-convertibility)
    // logic as before over the narrowed candidate set. This changes only how
    // candidates are FOUND, never which one wins: same receiver-matching rules, same
    // scope/shadowing order, so resolution and diagnostics are unchanged.
    private ImmutableDictionary<string, ImmutableArray<FunctionSymbol>.Builder>.Builder extensionFunctionsByName;

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundScope"/> class.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    public BoundScope(BoundScope parent)
        : this(parent, references: null, preprocessorSymbols: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundScope"/> class with
    /// an explicit reference resolver. Child scopes inherit the parent's
    /// resolver when one is not supplied.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    /// <param name="references">The reference resolver; defaults to the parent's resolver, or <see cref="ReferenceResolver.Default"/> if none.</param>
    public BoundScope(BoundScope parent, ReferenceResolver references)
        : this(parent, references, preprocessorSymbols: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundScope"/> class with
    /// an explicit reference resolver and an active preprocessor-symbol set
    /// (ADR-0047 §6 / issue #176). Child scopes inherit both from the parent
    /// when not supplied.
    /// </summary>
    /// <param name="parent">The parent scope.</param>
    /// <param name="references">The reference resolver; defaults to the parent's resolver, or <see cref="ReferenceResolver.Default"/> if none.</param>
    /// <param name="preprocessorSymbols">The active preprocessor symbol set; defaults to the parent's set, or an empty set if none.</param>
    public BoundScope(BoundScope parent, ReferenceResolver references, ImmutableHashSet<string> preprocessorSymbols)
    {
        // Issue #1647: symbolKeys/functionKeys/imports/typeAliases/typeAliasKeys
        // are kept PER-SCOPE only (declared-here entries), just like the
        // `symbols`/`functions` dictionaries already were. Resolution walks
        // the Parent chain lazily instead of eagerly duplicating the parent's
        // entire state into every child scope (every block/loop/switch arm
        // created a BoundScope, making the old eager copy O(scopes x entries)).
        Parent = parent;
        References = references ?? parent?.References ?? ReferenceResolver.Default();
        PreprocessorSymbols = preprocessorSymbols ?? parent?.PreprocessorSymbols ?? ImmutableHashSet<string>.Empty;
    }

    /// <summary>
    /// Gets the parent scope.
    /// </summary>
    public BoundScope Parent { get; }

    /// <summary>
    /// Gets the reference resolver used to look up imported CLR types.
    /// </summary>
    public ReferenceResolver References { get; }

    /// <summary>
    /// Gets the active preprocessor symbol set (ADR-0047 §6 / issue #176).
    /// Empty by default. <c>[Conditional("SYMBOL")]</c> call-site elision
    /// keys off this set: a call is elided when *none* of the symbols named
    /// by the function's <c>[Conditional]</c> applications is in this set.
    /// </summary>
    public ImmutableHashSet<string> PreprocessorSymbols { get; }

    /// <summary>
    /// Tries to add an import to this scope.
    /// </summary>
    /// <param name="import">The import.</param>
    /// <returns>Whether the import was registered or not.</returns>
    public bool TryImport(ImportSymbol import)
    {
        imports ??= ImmutableArray.CreateBuilder<ImportSymbol>();
        imports.Add(import);
        return true;
    }

    /// <summary>
    /// Tries to declare a variable in this scope.
    /// </summary>
    /// <param name="variable">The variable to declare.</param>
    /// <returns>Wherther the variable was declared or not.</returns>
    public bool TryDeclareVariable(VariableSymbol variable)
        => TryDeclareSymbol(variable);

    /// <summary>
    /// Tries to declare a function in this scope.
    /// </summary>
    /// <param name="function">The function to declare.</param>
    /// <returns>Whether the function was declared or not.</returns>
    public bool TryDeclareFunction(FunctionSymbol function)
    {
        if (function?.Name == null)
        {
            return false;
        }

        // ADR-0063 §11: user-defined callable storage is name → overload set.
        // A name conflict with a non-function symbol (variable, etc.) is still a
        // hard duplicate. A second function with the same name is allowed if and
        // only if its signature differs from every existing overload.
        if (symbols != null && symbols.TryGetValue(function.Name, out var existing) && existing is not FunctionSymbol)
        {
            return false;
        }

        functions ??= ImmutableDictionary.CreateBuilder<string, ImmutableArray<FunctionSymbol>.Builder>();
        if (!functions.TryGetValue(function.Name, out var bucket))
        {
            bucket = ImmutableArray.CreateBuilder<FunctionSymbol>();
            functions.Add(function.Name, bucket);
            functionKeys ??= ImmutableArray.CreateBuilder<string>();
            functionKeys.Add(function.Name);
        }
        else
        {
            foreach (var f in bucket)
            {
                if (FunctionSignaturesEqual(f, function))
                {
                    return false;
                }
            }
        }

        bucket.Add(function);

        // Keep the first overload visible through the legacy `symbols` map so
        // existing TryLookupSymbol/Get*<FunctionSymbol> callers see the name.
        symbols ??= ImmutableDictionary.CreateBuilder<string, Symbol>();
        if (!symbols.ContainsKey(function.Name))
        {
            AddSymbol(function.Name, function);
        }

        return true;
    }

    /// <summary>
    /// ADR-0063 §11: returns every overload of the given function name visible
    /// from this scope (walks parent scopes). Empty when no function with that
    /// name is in scope.
    /// </summary>
    /// <param name="name">The function name.</param>
    /// <returns>The overload set in declaration order (innermost scope first).</returns>
    public ImmutableArray<FunctionSymbol> TryLookupFunctions(string name)
    {
        if (name == null)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        ImmutableArray<FunctionSymbol>.Builder builder = null;
        for (var s = this; s != null; s = s.Parent)
        {
            if (s.functions != null && s.functions.TryGetValue(name, out var bucket) && bucket.Count > 0)
            {
                builder ??= ImmutableArray.CreateBuilder<FunctionSymbol>();
                builder.AddRange(bucket);
            }
        }

        return builder == null ? ImmutableArray<FunctionSymbol>.Empty : builder.ToImmutable();
    }

    /// <summary>
    /// ADR-0063 §1: compares two function symbols for overload-identity equality —
    /// member name, callable parameter count, each parameter's type, and each
    /// parameter's ref-kind. Return type, parameter names, accessibility, and
    /// default values are deliberately not part of identity.
    /// </summary>
    /// <param name="a">First function symbol.</param>
    /// <param name="b">Second function symbol.</param>
    /// <returns>Whether the two functions share an overload signature.</returns>
    public static bool FunctionSignaturesEqual(FunctionSymbol a, FunctionSymbol b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        if (!string.Equals(a.Name, b.Name, StringComparison.Ordinal))
        {
            return false;
        }

        var ap = SigCallableParameters(a);
        var bp = SigCallableParameters(b);
        if (ap.Length != bp.Length)
        {
            return false;
        }

        var aTypeParams = a.TypeParameters.IsDefault ? 0 : a.TypeParameters.Length;
        var bTypeParams = b.TypeParameters.IsDefault ? 0 : b.TypeParameters.Length;
        if (aTypeParams != bTypeParams)
        {
            return false;
        }

        for (var i = 0; i < ap.Length; i++)
        {
            if (ap[i].RefKind != bp[i].RefKind)
            {
                return false;
            }

            if (!SigTypesEquivalent(ap[i].Type, bp[i].Type, a, b))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Tries to declare an extension function (Phase 3.B.6 / ADR-0019). Extension
    /// functions live outside the normal symbol table because their identity is
    /// the triple (receiverType, name, signature).
    /// </summary>
    /// <remarks>
    /// Issue #1188: extension functions support overloading exactly like ordinary
    /// methods and free functions. Two extensions that share a (receiver, name)
    /// pair but differ in parameter signature (by arity, parameter type, or
    /// generic arity) are legal overloads and both are registered. A collision is
    /// reported only when a candidate is overload-identical to an existing one
    /// (same name, same receiver type, same callable parameter signature). The
    /// receiver type participates in identity through the synthetic receiver slot
    /// at <c>Parameters[0]</c> (extension functions never set
    /// <see cref="FunctionSymbol.ExplicitReceiverParameter"/>, so
    /// <see cref="FunctionSignaturesEqual"/> compares the receiver type too): two
    /// extensions with the same name and parameter list but different receiver
    /// types remain independent.
    /// </remarks>
    /// <param name="function">The extension function symbol. Must have <see cref="FunctionSymbol.IsExtension"/> set.</param>
    /// <returns>True if the extension was registered; false if an overload-identical (receiver, name, signature) extension already exists in this scope.</returns>
    public bool TryDeclareExtensionFunction(FunctionSymbol function)
    {
        extensionFunctions ??= ImmutableArray.CreateBuilder<FunctionSymbol>();
        extensionFunctionsByName ??= ImmutableDictionary.CreateBuilder<string, ImmutableArray<FunctionSymbol>.Builder>();

        if (extensionFunctionsByName.TryGetValue(function.Name, out var bucket))
        {
            foreach (var existing in bucket)
            {
                if (FunctionSignaturesEqual(existing, function)
                    && ExtensionTypeParameterConstraintsEqual(existing, function))
                {
                    return false;
                }
            }
        }
        else
        {
            bucket = ImmutableArray.CreateBuilder<FunctionSymbol>();
            extensionFunctionsByName.Add(function.Name, bucket);
        }

        extensionFunctions.Add(function);
        bucket.Add(function);
        return true;
    }

    /// <summary>
    /// Tries to look up an extension function by receiver type and name (walks parent scopes).
    /// </summary>
    /// <remarks>
    /// Two lookup paths are tried, in order:
    /// <list type="number">
    /// <item><description><b>Exact-match fast path</b> — reference-equality on the
    /// declared receiver type. This is sufficient for non-generic receivers
    /// (<c>(self string)</c>, <c>(self int32)</c>) and for already-closed
    /// receiver spellings.</description></item>
    /// <item><description><b>Generic-receiver unification (issue #773)</b> —
    /// an extension whose receiver type references its own function-level
    /// type parameters (e.g. <c>func (self sequence[T]) FirstOrNil[T]() T?</c>
    /// or <c>func (self IEnumerable[T]) MyFirst[T any](fb T) T</c>) must
    /// dispatch when the call-site receiver type unifies with the open
    /// declared receiver. Inference is delegated to
    /// <see cref="Binder.InferTypeArguments"/>; the candidate qualifies when
    /// every type parameter mentioned in the receiver gets bound.</description></item>
    /// <item><description><b>Implicit-conversion (subtype) receivers (issue
    /// #1548)</b> — a declared receiver <c>R</c> is also applicable for a
    /// call-site receiver <c>S</c> when <c>S</c> is implicitly convertible to
    /// <c>R</c> (identity, implicit reference, or boxing conversion), matching
    /// C#/Kotlin extension-method semantics. Among several applicable
    /// convertible receivers the MOST specific (most-derived) one wins, so
    /// <c>(self string)</c> beats <c>(self object)</c> for a <c>string</c>
    /// receiver deterministically.</description></item>
    /// </list>
    /// </remarks>
    /// <param name="receiverType">The static type of the call receiver.</param>
    /// <param name="name">The method name at the call site.</param>
    /// <param name="function">The matching extension function, when found.</param>
    /// <returns>True when an extension function matches.</returns>
    public bool TryLookupExtensionFunction(TypeSymbol receiverType, string name, out FunctionSymbol function)
    {
        function = null;

        // Issue #1680: probe the name-keyed bucket instead of scanning every
        // extension declared in this scope. A scope with no extensions named
        // `name` is skipped in O(1) instead of an O(extensions) miss.
        if (extensionFunctionsByName != null
            && extensionFunctionsByName.TryGetValue(name, out var bucket))
        {
            foreach (var ext in bucket)
            {
                if (ReceiverMatches(ext.ExtensionReceiverType, receiverType))
                {
                    function = ext;
                    return true;
                }
            }

            // Issue #773 / ADR-0084 §L2 follow-up: an extension whose
            // receiver type carries one of the function's own type
            // parameters (e.g. `(self sequence[T])`, `(self IEnumerable[T])`,
            // `(self T?)`, `(self Dictionary[K, V])`) is never reference-
            // equal to a concrete call-site receiver. Fall back to receiver
            // inference: try to unify the declared open receiver with the
            // call-site type and accept the candidate when every type
            // parameter that appears in the receiver gets bound.
            //
            // ADR-0097 / issue #775: when multiple candidates unify against
            // the same receiver type (e.g. one carrying `[T class]` and one
            // carrying `[T struct]`), the constraint check decides the
            // winner. We collect every unifiable candidate, drop those
            // whose constraints are violated by the inferred substitution,
            // and prefer the most specific (struct > class > unconstrained)
            // surviving candidate. Mutually-incomparable cases fall through
            // to the first declared candidate so the call site is not
            // silently ambiguous (the existing GS0160 will surface from the
            // call-binding path if applicable).
            FunctionSymbol candidate = null;
            int candidateSpecificity = -1;
            foreach (var ext in bucket)
            {
                if (ext.TypeParameters.IsDefaultOrEmpty)
                {
                    continue;
                }

                if (ext.ExtensionReceiverType == null || ext.ExtensionReceiverType == TypeSymbol.Error)
                {
                    continue;
                }

                if (!ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters))
                {
                    continue;
                }

                if (!TryUnifyAndCheckConstraints(ext, receiverType, out var specificity))
                {
                    continue;
                }

                if (candidate == null || specificity > candidateSpecificity)
                {
                    candidate = ext;
                    candidateSpecificity = specificity;
                }
            }

            if (candidate != null)
            {
                function = candidate;
                return true;
            }

            // Issue #1548: no exact and no generic-unification match in this
            // scope. Broaden to implicitly-convertible (subtype) receivers: a
            // declared receiver `R` is applicable when the call-site receiver
            // `S` is implicitly convertible to `R` (identity/implicit-reference/
            // boxing). Among applicable candidates pick the MOST specific
            // (most-derived) declared receiver so this singular path stays
            // deterministic (e.g. `string` beats `object`); ties fall back to
            // declaration order.
            FunctionSymbol subtypeCandidate = null;
            var subtypeSpecificity = -1;
            foreach (var ext in bucket)
            {
                if (!ext.TypeParameters.IsDefaultOrEmpty
                    && ext.ExtensionReceiverType != null
                    && ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters))
                {
                    // Open receivers are handled by the unification pass above.
                    continue;
                }

                if (!ReceiverConvertible(ext.ExtensionReceiverType, receiverType))
                {
                    continue;
                }

                var specificity = ReceiverConvertibilitySpecificity(bucket, ext.ExtensionReceiverType);
                if (subtypeCandidate == null || specificity > subtypeSpecificity)
                {
                    subtypeCandidate = ext;
                    subtypeSpecificity = specificity;
                }
            }

            if (subtypeCandidate != null)
            {
                function = subtypeCandidate;
                return true;
            }
        }

        return Parent?.TryLookupExtensionFunction(receiverType, name, out function) ?? false;
    }

    /// <summary>
    /// Issue #1188: returns every extension-function overload visible from this
    /// scope (walking parent scopes) that matches the (receiverType, name) pair.
    /// Extension functions support overloading, so a single call site may have
    /// several candidates differing only by parameter signature; the caller runs
    /// these through normal overload resolution to pick the best one.
    /// </summary>
    /// <remarks>
    /// Both dispatch paths used by <see cref="TryLookupExtensionFunction"/> are
    /// honoured: the reference-equality receiver fast path (issue #1103), the
    /// generic-receiver unification fallback (issue #773 / #775) and the
    /// implicit-conversion (subtype) receiver broadening (issue #1548).
    /// Candidates are returned in declaration order, innermost scope first; the
    /// caller's overload resolution scores the receiver as parameter 0 and so
    /// selects the most specific applicable receiver.
    /// </remarks>
    /// <param name="receiverType">The static type of the call receiver.</param>
    /// <param name="name">The method name at the call site.</param>
    /// <returns>The matching extension overloads, or an empty array when none match.</returns>
    public ImmutableArray<FunctionSymbol> TryLookupExtensionFunctions(TypeSymbol receiverType, string name)
    {
        ImmutableArray<FunctionSymbol>.Builder builder = null;
        for (var s = this; s != null; s = s.Parent)
        {
            // Issue #1680: probe the name-keyed bucket instead of scanning every
            // extension declared in this scope; scopes with no extension named
            // `name` are skipped in O(1).
            if (s.extensionFunctionsByName == null
                || !s.extensionFunctionsByName.TryGetValue(name, out var bucket))
            {
                continue;
            }

            foreach (var ext in bucket)
            {
                var matches = ReceiverMatches(ext.ExtensionReceiverType, receiverType);
                if (!matches
                    && !ext.TypeParameters.IsDefaultOrEmpty
                    && ext.ExtensionReceiverType != null
                    && ext.ExtensionReceiverType != TypeSymbol.Error
                    && ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters)
                    && TryUnifyAndCheckConstraints(ext, receiverType, out _))
                {
                    matches = true;
                }

                // Issue #1548: broaden to implicitly-convertible (subtype)
                // receivers with a CONCRETE declared receiver type. Open
                // receivers (those mentioning the function's own type
                // parameters) are handled by the unification pass above; a
                // concrete `R` is applicable whenever the call-site receiver is
                // implicitly convertible to it. Every applicable candidate is
                // collected so the caller's overload resolution — which scores
                // the receiver as parameter 0 — picks the most specific one.
                if (!matches
                    && (ext.TypeParameters.IsDefaultOrEmpty
                        || ext.ExtensionReceiverType == null
                        || !ReceiverMentionsAnyTypeParameter(ext.ExtensionReceiverType, ext.TypeParameters))
                    && ReceiverConvertible(ext.ExtensionReceiverType, receiverType))
                {
                    matches = true;
                }

                if (matches)
                {
                    builder ??= ImmutableArray.CreateBuilder<FunctionSymbol>();
                    builder.Add(ext);
                }
            }
        }

        return builder == null ? ImmutableArray<FunctionSymbol>.Empty : builder.ToImmutable();
    }

    /// <summary>Gets the extension functions declared in this scope (Phase 3.B.6).</summary>
    /// <returns>An immutable array of extension functions.</returns>
    public ImmutableArray<FunctionSymbol> GetDeclaredExtensionFunctions()
        => extensionFunctions?.ToImmutableArray() ?? ImmutableArray<FunctionSymbol>.Empty;

    /// <summary>
    /// Tries to look up a symbol by its name in this scope.
    /// </summary>
    /// <param name="name">The symbol name.</param>
    /// <returns>The symbol.</returns>
    public Symbol TryLookupSymbol(string name)
    {
        if (name != null && symbols != null && symbols.TryGetValue(name, out var symbol))
        {
            return symbol;
        }

        return Parent?.TryLookupSymbol(name);
    }

    /// <summary>
    /// Tries to lookup an imported generic open type by simple name and arity (Phase 4.4 / ADR-0020).
    /// CLR generic types are stored under the mangled name <c>Name`N</c>; this overload
    /// searches each active import for <c>Target.Name`arity</c>.
    /// </summary>
    /// <param name="name">The simple type name as written in source (without the backtick suffix).</param>
    /// <param name="arity">The number of type parameters.</param>
    /// <param name="type">The resolved open generic <see cref="System.Type"/> on success.</param>
    /// <returns>Whether a matching open generic type was found.</returns>
    public bool TryLookupImportedGenericClass(string name, int arity, out System.Type type)
    {
        type = null;
        if (arity <= 0)
        {
            return false;
        }

        var mangled = name + "`" + arity;
        foreach (var import in EnumerateImports())
        {
            var typeName = import.Target + "." + mangled;
            if (References.TryResolveType(typeName, out var t))
            {
                type = t;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Tries to lookup an imported class.
    /// </summary>
    /// <param name="name">The class name.</param>
    /// <param name="declaration">The declaration.</param>
    /// <param name="importedClass">The result, if found.</param>
    /// <returns>Whether a class was found or not.</returns>
    public bool TryLookupImportedClass(string name, ExpressionSyntax declaration, out ImportedClassSymbol importedClass)
    {
        importedClass = null;

        foreach (var import in EnumerateImports())
        {
            var typeName = import.Target + "." + name;
            if (References.TryResolveType(typeName, out var type))
            {
                importedClass = new ImportedClassSymbol(type, declaration, references: References);
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Tries to look up an imported namespace by the name the user references it with
    /// (the alias if one was declared, otherwise the import path).
    /// </summary>
    /// <param name="name">The name as it appears in user code.</param>
    /// <param name="import">The matching import, when found.</param>
    /// <returns>Whether a matching import exists.</returns>
    public bool TryLookupImport(string name, out ImportSymbol import)
    {
        import = null;

        foreach (var candidate in EnumerateImports())
        {
            if (string.Equals(candidate.Name, name, System.StringComparison.Ordinal))
            {
                import = candidate;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Gets an immutable array of all the declared variables.
    /// </summary>
    /// <returns>The declared variables.</returns>
    public ImmutableArray<VariableSymbol> GetDeclaredVariables()
        => GetDeclaredSymbols<VariableSymbol>();

    /// <summary>
    /// Gets an immutable array of all the declared functions, including every
    /// overload registered via <see cref="TryDeclareFunction"/> (ADR-0063 §11).
    /// </summary>
    /// <returns>The declared functions in declaration order.</returns>
    public ImmutableArray<FunctionSymbol> GetDeclaredFunctions()
    {
        if (functions == null || functions.Count == 0)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var key in functionKeys)
        {
            if (functions.TryGetValue(key, out var bucket))
            {
                builder.AddRange(bucket);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Gets an immutable array of all the declared imports.
    /// </summary>
    /// <returns>The declared imports.</returns>
    public ImmutableArray<ImportSymbol> GetDeclaredImports()
        => EnumerateImports().ToImmutableArray();

    /// <summary>
    /// Gets the imports declared directly in <em>this</em> scope only — unlike
    /// <see cref="GetDeclaredImports"/>, this does not walk <see cref="Parent"/>.
    /// Used by <see cref="Binder.BindGlobalScope(BoundGlobalScope, ImmutableArray{SyntaxTree}, ReferenceResolver, bool, ImmutableHashSet{string}, bool)"/>
    /// to populate <see cref="BoundGlobalScope.Imports"/> with only the current
    /// submission's own imports (issue #2101): that field is later re-seeded,
    /// one historical <see cref="BoundGlobalScope"/> per chained REPL
    /// submission, into a fresh per-level <see cref="BoundScope"/> by
    /// <see cref="Binder.CreateParentScope"/>. Using the walking/cumulative
    /// <see cref="GetDeclaredImports"/> there previously made every submission
    /// re-import the ENTIRE flattened history of every prior submission into
    /// its own scope layer, which was then itself re-flattened on the next
    /// call — an <c>I(k) = sum(I(0..k-1))</c> recurrence that doubles the
    /// import count (and binding time) on every single REPL submission.
    /// </summary>
    /// <returns>This scope's own declared imports, in declaration order.</returns>
    public ImmutableArray<ImportSymbol> GetOwnDeclaredImports()
        => imports?.ToImmutable() ?? ImmutableArray<ImportSymbol>.Empty;

    /// <summary>
    /// Tries to declare a type alias.
    /// </summary>
    /// <param name="name">The alias name.</param>
    /// <param name="target">The underlying type.</param>
    /// <returns>Whether the alias was declared (false if the name was already taken).</returns>
    public bool TryDeclareTypeAlias(string name, TypeSymbol target)
    {
        if (name == null)
        {
            return false;
        }

        // Issue #1051: key by (simple name, generic arity) so that a type and a
        // same-named generic of different arity coexist. A genuine duplicate —
        // same name AND same arity — still collides and reports GS0102.
        var arity = GetTypeAliasArity(target);
        var key = MangleArity(name, arity);
        if (!TypeAliasVisible(key))
        {
            AddTypeAlias(key, target);
            return true;
        }

        // Issue #1080: a name clash on the simple (arity-bearing) key is only a
        // genuine duplicate — GS0102 — when both types live in the SAME
        // declaration scope (both top-level, or both nested in the SAME
        // enclosing type). A nested type must NOT collide with a package-level
        // type of the same simple name, nor with a nested type of a DIFFERENT
        // enclosing type. Such non-conflicting types coexist: the package-level
        // (top-level) type keeps the simple key so it stays resolvable by simple
        // name, while the nested "loser" is retained under its containing-type-
        // qualified key (so emit — which enumerates the stored values — still
        // produces its TypeDef).
        var existing = TryGetTypeAliasInChain(key, out var existingValue) ? existingValue : null;
        var targetEnclosing = TypeContainingType(target);
        var existingEnclosing = TypeContainingType(existing);
        if (IsSameDeclarationScope(existingEnclosing, targetEnclosing))
        {
            return false;
        }

        // Prefer the top-level type as the owner of the simple key. If a nested
        // type currently occupies the simple key but the incoming type is
        // top-level, evict the nested type to its qualified key and install the
        // top-level type under the simple key.
        if (targetEnclosing == null && existingEnclosing != null)
        {
            var existingQualifiedKey = MangleArity(QualifiedTypeName(existing), arity);
            if (TryGetTypeAliasInChain(existingQualifiedKey, out var occupant) && !ReferenceEquals(occupant, existing))
            {
                return false;
            }

            AddTypeAlias(existingQualifiedKey, existing);
            SetTypeAliasOverride(key, target);
            return true;
        }

        // The incoming type is nested and clashes with a differently-scoped type
        // already holding the simple key. Retain it under its qualified key. A
        // clash on the qualified key means a genuine duplicate within the SAME
        // enclosing type — report GS0102.
        var qualifiedKey = MangleArity(QualifiedTypeName(target), arity);
        if (TypeAliasVisible(qualifiedKey))
        {
            return false;
        }

        AddTypeAlias(qualifiedKey, target);
        return true;
    }

    /// <summary>
    /// Issue #1051: re-declares a type alias under its already-computed storage
    /// key (as returned by <see cref="GetDeclaredTypeAliases"/>) without
    /// re-deriving the arity suffix. Used when threading aliases from a previous
    /// submission's global scope into a fresh scope so generic keys are not
    /// double-mangled.
    /// </summary>
    /// <param name="key">The composite storage key.</param>
    /// <param name="target">The underlying type.</param>
    /// <returns>Whether the alias was declared (false if the key was already taken).</returns>
    public bool TryRedeclareTypeAlias(string key, TypeSymbol target)
    {
        if (key == null)
        {
            return false;
        }

        if (TypeAliasVisible(key))
        {
            return false;
        }

        AddTypeAlias(key, target);
        return true;
    }

    /// <summary>
    /// Tries to look up a type alias by name, preferring the arity-0 type.
    /// </summary>
    /// <param name="name">The alias name.</param>
    /// <param name="type">The aliased type, when found.</param>
    /// <returns>Whether an alias exists.</returns>
    public bool TryLookupTypeAlias(string name, out TypeSymbol type)
        => TryLookupTypeAlias(name, preferredArity: -1, out type);

    /// <summary>
    /// Issue #1051: tries to look up a type alias by (name, arity). When
    /// <paramref name="preferredArity"/> is non-negative, the type with exactly
    /// that generic arity is returned if present; otherwise the lookup falls
    /// back to the arity-0 type (plain name) and then to the lowest-arity
    /// same-name variant. A negative <paramref name="preferredArity"/> means
    /// "no arity preference" and resolves the arity-0 type first.
    /// </summary>
    /// <param name="name">The alias name.</param>
    /// <param name="preferredArity">The preferred generic arity, or -1 for none.</param>
    /// <param name="type">The aliased type, when found.</param>
    /// <returns>Whether an alias exists.</returns>
    public bool TryLookupTypeAlias(string name, int preferredArity, out TypeSymbol type)
    {
        type = null;
        if (name == null)
        {
            return false;
        }

        if (preferredArity > 0)
        {
            var key = MangleArity(name, preferredArity);
            if (TryGetTypeAliasInChain(key, out type))
            {
                return true;
            }
        }

        // Fall back to the arity-0 type (whose key is the plain simple name).
        if (TryGetTypeAliasInChain(name, out type))
        {
            return true;
        }

        // No arity-0 type: resolve the lowest-arity same-name generic variant
        // so a lone generic definition keeps resolving by simple name.
        TypeSymbol best = null;
        var bestArity = int.MaxValue;
        foreach (var pair in EnumerateTypeAliasesInChain())
        {
            if (TryParseAritySuffix(pair.Key, name, out var arity) && arity < bestArity)
            {
                best = pair.Value;
                bestArity = arity;
            }
        }

        if (best != null)
        {
            type = best;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1174: resolves a nested type by its enclosing <paramref name="container"/>
    /// and simple <paramref name="simpleName"/>, rather than by global simple
    /// name. This is required when a top-level type shares the nested type's
    /// simple name: per <see cref="TryDeclareTypeAlias"/>, the top-level homonym
    /// keeps the simple key while the nested type is retained under its
    /// containing-type-qualified key (e.g. <c>"C.E"</c>). A plain
    /// <see cref="TryLookupTypeAlias(string, out TypeSymbol)"/> of the simple
    /// name would return the top-level homonym, so a qualified reference
    /// <c>Container.Nested</c> must look the nested type up by (container,
    /// simpleName).
    /// </summary>
    /// <param name="container">The enclosing type the nested type must belong to.</param>
    /// <param name="simpleName">The nested type's simple name.</param>
    /// <param name="preferredArity">The preferred generic arity, or -1 for none.</param>
    /// <param name="type">The resolved nested type, when found.</param>
    /// <returns>Whether a nested type with that container and name exists.</returns>
    public bool TryLookupNestedTypeAlias(TypeSymbol container, string simpleName, int preferredArity, out TypeSymbol type)
    {
        type = null;
        if (container == null || string.IsNullOrEmpty(simpleName))
        {
            return false;
        }

        // The nested type is stored under its containing-type-qualified key
        // (e.g. `Outer.Inner` for a doubly-nested type), arity-mangled the same
        // way as in TryDeclareTypeAlias.
        var qualifiedName = QualifiedTypeName(container) + "." + simpleName;

        if (preferredArity > 0)
        {
            var arityKey = MangleArity(qualifiedName, preferredArity);
            if (TryGetTypeAliasInChain(arityKey, out var arityMatch)
                && IsNestedDirectlyIn(arityMatch, container))
            {
                type = arityMatch;
                return true;
            }
        }

        // Arity-0 (plain) qualified key.
        if (TryGetTypeAliasInChain(qualifiedName, out var exact)
            && IsNestedDirectlyIn(exact, container))
        {
            type = exact;
            return true;
        }

        // Lowest-arity same-name generic variant under the qualified key.
        TypeSymbol best = null;
        var bestArity = int.MaxValue;
        foreach (var pair in EnumerateTypeAliasesInChain())
        {
            if (TryParseAritySuffix(pair.Key, qualifiedName, out var arity)
                && arity < bestArity
                && IsNestedDirectlyIn(pair.Value, container))
            {
                best = pair.Value;
                bestArity = arity;
            }
        }

        if (best != null)
        {
            type = best;
            return true;
        }

        // No collision: when the nested type's simple name was free, it keeps
        // the simple key. Accept the simple-key holder when it is in fact a
        // nested type of `container`.
        if (preferredArity > 0)
        {
            var simpleArityKey = MangleArity(simpleName, preferredArity);
            if (TryGetTypeAliasInChain(simpleArityKey, out var simpleArityMatch)
                && IsNestedDirectlyIn(simpleArityMatch, container))
            {
                type = simpleArityMatch;
                return true;
            }
        }

        if (TryGetTypeAliasInChain(simpleName, out var simpleMatch)
            && IsNestedDirectlyIn(simpleMatch, container))
        {
            type = simpleMatch;
            return true;
        }

        foreach (var pair in EnumerateTypeAliasesInChain())
        {
            if (TryParseAritySuffix(pair.Key, simpleName, out var arity)
                && arity < bestArity
                && IsNestedDirectlyIn(pair.Value, container))
            {
                best = pair.Value;
                bestArity = arity;
            }
        }

        if (best != null)
        {
            type = best;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Gets the set of declared type aliases.
    /// </summary>
    /// <returns>The map of alias names to underlying types.</returns>
    public ImmutableDictionary<string, TypeSymbol> GetDeclaredTypeAliases()
    {
        var builder = ImmutableDictionary.CreateBuilder<string, TypeSymbol>();
        foreach (var pair in GetOrderedTypeAliases())
        {
            builder[pair.Key] = pair.Value;
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Gets the set of declared user-defined struct types in this scope chain.
    /// </summary>
    /// <returns>The structs in declaration order.</returns>
    public ImmutableArray<StructSymbol> GetDeclaredStructs()
        => GetDeclaredTypeSymbols<StructSymbol>();

    /// <summary>
    /// Gets the set of declared user-defined interface types in this scope chain (Phase 3.B.4).
    /// </summary>
    /// <returns>The interfaces in declaration order.</returns>
    public ImmutableArray<InterfaceSymbol> GetDeclaredInterfaces()
        => GetDeclaredTypeSymbols<InterfaceSymbol>();

    /// <summary>
    /// Gets the set of declared user-defined enum types in this scope chain (#193).
    /// </summary>
    /// <returns>The enums in declaration order.</returns>
    public ImmutableArray<EnumSymbol> GetDeclaredEnums()
        => GetDeclaredTypeSymbols<EnumSymbol>();

    /// <summary>
    /// Gets the set of declared user-defined named delegate types in this scope chain (ADR-0059 / issue #255).
    /// </summary>
    /// <returns>The named delegate types in declaration order.</returns>
    public ImmutableArray<DelegateTypeSymbol> GetDeclaredDelegates()
        => GetDeclaredTypeSymbols<DelegateTypeSymbol>();

    /// <summary>
    /// Adds a brand-new type-alias key, not previously visible anywhere in the
    /// scope chain. Records the key in this scope's own <see cref="typeAliasKeys"/>
    /// so its declaration-order position (root-first across the chain) is fixed
    /// the first time it is introduced.
    /// </summary>
    private void AddTypeAlias(string key, TypeSymbol target)
    {
        typeAliases ??= ImmutableDictionary.CreateBuilder<string, TypeSymbol>();
        typeAliases.Add(key, target);
        typeAliasKeys ??= ImmutableArray.CreateBuilder<string>();
        typeAliasKeys.Add(key);
    }

    /// <summary>
    /// Overrides the value of a type-alias key that already exists somewhere in
    /// the scope chain (the eviction/promotion case in <see cref="TryDeclareTypeAlias"/>).
    /// Only overwrites the value at this scope; it does not move the key's
    /// declaration-order position (which was fixed when the key was first
    /// introduced by <see cref="AddTypeAlias"/>) and does not mutate the
    /// ancestor scope that originally owns the key.
    /// </summary>
    private void SetTypeAliasOverride(string key, TypeSymbol target)
    {
        typeAliases ??= ImmutableDictionary.CreateBuilder<string, TypeSymbol>();
        typeAliases[key] = target;
    }

    /// <summary>Whether <paramref name="key"/> is visible anywhere in this scope chain.</summary>
    private bool TypeAliasVisible(string key)
    {
        for (var s = this; s != null; s = s.Parent)
        {
            if (s.typeAliases != null && s.typeAliases.ContainsKey(key))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Looks up <paramref name="key"/> from this scope outward through the
    /// Parent chain, so a nearer (child) scope's value shadows a farther
    /// (ancestor) scope's value for the same key.
    /// </summary>
    private bool TryGetTypeAliasInChain(string key, out TypeSymbol value)
    {
        for (var s = this; s != null; s = s.Parent)
        {
            if (s.typeAliases != null && s.typeAliases.TryGetValue(key, out value))
            {
                return true;
            }
        }

        value = null;
        return false;
    }

    /// <summary>
    /// Enumerates every (key, value) pair visible from this scope, nearest
    /// scope first, yielding each key only once (the nearest-scope value wins,
    /// matching <see cref="TryGetTypeAliasInChain"/>).
    /// </summary>
    private IEnumerable<KeyValuePair<string, TypeSymbol>> EnumerateTypeAliasesInChain()
    {
        var seen = new HashSet<string>();
        for (var s = this; s != null; s = s.Parent)
        {
            if (s.typeAliases == null)
            {
                continue;
            }

            foreach (var pair in s.typeAliases)
            {
                if (seen.Add(pair.Key))
                {
                    yield return pair;
                }
            }
        }
    }

    /// <summary>
    /// Builds the full set of type aliases visible from this scope, ordered the
    /// way the old eager parent-to-child copy produced them: each key keeps the
    /// position it had when FIRST introduced (root-most scope first), while its
    /// value reflects the nearest (most specific) scope that declared or
    /// overrode it.
    /// </summary>
    private List<KeyValuePair<string, TypeSymbol>> GetOrderedTypeAliases()
    {
        var merged = new Dictionary<string, TypeSymbol>();
        var order = new List<string>();
        CollectTypeAliasesInto(merged, order);

        var result = new List<KeyValuePair<string, TypeSymbol>>(order.Count);
        foreach (var key in order)
        {
            result.Add(new KeyValuePair<string, TypeSymbol>(key, merged[key]));
        }

        return result;
    }

    private void CollectTypeAliasesInto(Dictionary<string, TypeSymbol> merged, List<string> order)
    {
        Parent?.CollectTypeAliasesInto(merged, order);

        if (typeAliasKeys != null)
        {
            foreach (var key in typeAliasKeys)
            {
                if (!merged.ContainsKey(key))
                {
                    order.Add(key);
                }
            }
        }

        if (typeAliases != null)
        {
            foreach (var pair in typeAliases)
            {
                merged[pair.Key] = pair.Value;
            }
        }
    }

    private ImmutableArray<TSymbol> GetDeclaredTypeSymbols<TSymbol>()
        where TSymbol : TypeSymbol
    {
        var builder = ImmutableArray.CreateBuilder<TSymbol>();
        foreach (var pair in GetOrderedTypeAliases())
        {
            if (pair.Value is TSymbol typed)
            {
                builder.Add(typed);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Issue #1051: computes the generic arity (number of type parameters) of a
    /// type used as the storage-key discriminator. C#/CLR allow two types that
    /// share a simple name but differ by generic arity (e.g. <c>Foo</c> and
    /// <c>Foo[T]</c>, mirroring <c>Task</c>/<c>Task&lt;T&gt;</c>) to coexist as
    /// distinct types keyed by (name, arity). Only open generic DEFINITIONS
    /// carry an arity; constructed instances and plain aliases are arity 0.
    /// </summary>
    /// <param name="target">The type whose arity is requested.</param>
    /// <returns>The generic arity, or 0 for non-generic / constructed types.</returns>
    private static int GetTypeAliasArity(TypeSymbol target)
    {
        return target switch
        {
            StructSymbol s when s.IsGenericDefinition => s.TypeParameters.Length,
            InterfaceSymbol i when i.IsGenericDefinition => i.TypeParameters.Length,
            DelegateTypeSymbol d when d.IsGenericDefinition => d.TypeParameters.Length,
            _ => 0,
        };
    }

    /// <summary>
    /// Issue #1051: builds the storage key for a type alias keyed by
    /// (simple name, generic arity). Arity-0 types keep their plain simple name
    /// as the key (so existing simple-name lookups keep working), while generic
    /// definitions are suffixed with the CLR backtick-arity convention
    /// (e.g. <c>Foo`1</c>), letting <c>Foo</c> and <c>Foo[T]</c> coexist.
    /// </summary>
    /// <param name="name">The simple type name.</param>
    /// <param name="arity">The generic arity.</param>
    /// <returns>The composite storage key.</returns>
    private static string MangleArity(string name, int arity)
        => arity <= 0 ? name : name + "`" + arity.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// Determines whether an extension's declared receiver type matches the
    /// static type of the call receiver.
    /// </summary>
    /// <remarks>
    /// Package-owned user struct/class/interface receivers are interned, so
    /// reference equality matches them exactly (and must remain the primary
    /// check so two distinct user types never collide). Imported/BCL and
    /// primitive receivers, however, are not interned: the
    /// <see cref="FunctionSymbol.ExtensionReceiverType"/> captured at the
    /// extension declaration and the receiver's type symbol at the call site
    /// can be distinct <c>ImportedTypeSymbol</c> instances (or symbols
    /// materialised through a <see cref="System.Reflection.MetadataLoadContext"/>)
    /// that wrap the same logical CLR type (issue #1103). For those we fall
    /// back to an exact structural CLR-type identity comparison via
    /// <see cref="ClrTypeUtilities.IsSameAs"/> — exact identity, never
    /// assignability, so genuinely different types do not match.
    /// </remarks>
    /// <param name="declaredReceiverType">The extension's declared receiver type.</param>
    /// <param name="receiverType">The static type of the call receiver.</param>
    /// <returns><c>true</c> when the receiver types match.</returns>
    private static bool ReceiverMatches(TypeSymbol declaredReceiverType, TypeSymbol receiverType)
    {
        if (declaredReceiverType == receiverType)
        {
            return true;
        }

        if (declaredReceiverType?.ClrType is Type declaredClr
            && receiverType?.ClrType is Type receiverClr)
        {
            return declaredClr.IsSameAs(receiverClr);
        }

        return false;
    }

    /// <summary>
    /// Issue #1548: determines whether a CONCRETE declared extension receiver
    /// type <paramref name="declaredReceiverType"/> is applicable for a
    /// call-site receiver <paramref name="receiverType"/> that is not an exact
    /// (identity / same-CLR-type) match, by classifying the implicit
    /// convertibility of the call-site receiver TO the declared receiver.
    /// </summary>
    /// <remarks>
    /// Applicability requires an implicit conversion — identity, implicit
    /// reference (derived-to-base, class-to-implemented-interface,
    /// constructed-generic covariant reference), or boxing (value type to
    /// <c>object</c> / an implemented interface) — mirroring C#/Kotlin
    /// extension-method receiver semantics. Explicit (narrowing) conversions do
    /// NOT qualify, so a genuinely unrelated receiver still fails to bind. The
    /// exact/same-CLR fast path is checked by <see cref="ReceiverMatches"/>
    /// before this method, so this only needs the conversion classification.
    /// </remarks>
    /// <param name="declaredReceiverType">The extension's declared receiver type.</param>
    /// <param name="receiverType">The static type of the call receiver.</param>
    /// <returns><c>true</c> when the call receiver is implicitly convertible to the declared receiver.</returns>
    private static bool ReceiverConvertible(TypeSymbol declaredReceiverType, TypeSymbol receiverType)
    {
        if (declaredReceiverType == null
            || receiverType == null
            || declaredReceiverType == TypeSymbol.Error
            || receiverType == TypeSymbol.Error)
        {
            return false;
        }

        var conversion = Conversion.Classify(receiverType, declaredReceiverType);
        return conversion.Exists && conversion.IsImplicit;
    }

    /// <summary>
    /// Issue #1548: ranks the specificity of a convertible extension receiver
    /// among the same-named extension candidates declared in THIS scope. The
    /// score is the number of those candidates' declared receiver types that
    /// <paramref name="declaredReceiverType"/> is implicitly convertible to
    /// (counting itself). A more-derived receiver converts to more of its
    /// siblings' base/interface receivers, so it scores higher and wins on the
    /// singular deterministic lookup path (e.g. <c>string</c> beats
    /// <c>object</c> for a <c>string</c> receiver).
    /// </summary>
    /// <param name="extensionFunctions">The same-scope, same-name extension candidates to rank against.</param>
    /// <param name="declaredReceiverType">The candidate's declared receiver type.</param>
    /// <returns>The specificity score (higher is more specific).</returns>
    private static int ReceiverConvertibilitySpecificity(
        ImmutableArray<FunctionSymbol>.Builder extensionFunctions,
        TypeSymbol declaredReceiverType)
    {
        if (extensionFunctions == null || declaredReceiverType == null)
        {
            return 0;
        }

        var score = 0;
        foreach (var ext in extensionFunctions)
        {
            if (ext.ExtensionReceiverType == null)
            {
                continue;
            }

            if (declaredReceiverType == ext.ExtensionReceiverType)
            {
                score++;
                continue;
            }

            var conversion = Conversion.Classify(declaredReceiverType, ext.ExtensionReceiverType);
            if (conversion.Exists && conversion.IsImplicit)
            {
                score++;
            }
        }

        return score;
    }

    /// <summary>
    /// Issue #1080: returns the enclosing type of a (possibly nested) user type
    /// symbol — the value set via <c>SetContainingType</c> during declaration
    /// binding — or <c>null</c> for a top-level type or a non-aggregate symbol.
    /// </summary>
    private static TypeSymbol TypeContainingType(TypeSymbol type) => type switch
    {
        StructSymbol s => s.ContainingType,
        EnumSymbol e => e.ContainingType,
        InterfaceSymbol i => i.ContainingType,
        _ => null,
    };

    /// <summary>
    /// Issue #1174: whether <paramref name="type"/> is a user aggregate nested
    /// directly inside <paramref name="container"/>.
    /// </summary>
    private static bool IsNestedDirectlyIn(TypeSymbol type, TypeSymbol container)
        => ReferenceEquals(TypeContainingType(type), container);

    /// <summary>
    /// Issue #1080: two type declarations share a declaration scope when both
    /// are top-level (no enclosing type) or both are nested directly in the
    /// SAME enclosing type. Only same-scope same-name types are duplicates.
    /// </summary>
    private static bool IsSameDeclarationScope(TypeSymbol a, TypeSymbol b)
        => a == null ? b == null : ReferenceEquals(a, b);

    /// <summary>
    /// Issue #1080: builds the containing-type-qualified dotted name of a type
    /// (e.g. <c>Outer.Middle.Inner</c> for a doubly-nested type, or the plain
    /// simple name for a top-level type) by walking the enclosing-type chain.
    /// Used as the fallback storage key for a nested type whose simple name is
    /// already taken by a differently-scoped type, so it remains a distinct
    /// stored value without colliding.
    /// </summary>
    private static string QualifiedTypeName(TypeSymbol type)
    {
        var parts = new List<string>();
        for (var current = type; current != null; current = TypeContainingType(current))
        {
            parts.Add(current.Name);
        }

        parts.Reverse();
        return string.Join(".", parts);
    }

    /// <summary>
    /// Issue #1051: parses a composite storage key, reporting whether it names
    /// the requested simple name as a generic-arity variant and, if so, the
    /// arity it encodes.
    /// </summary>
    /// <param name="key">The composite storage key.</param>
    /// <param name="name">The simple type name to match.</param>
    /// <param name="arity">The parsed arity, when matched.</param>
    /// <returns>Whether the key encodes a generic variant of <paramref name="name"/>.</returns>
    private static bool TryParseAritySuffix(string key, string name, out int arity)
    {
        arity = 0;
        if (key == null || name == null || key.Length <= name.Length + 1)
        {
            return false;
        }

        if (!key.StartsWith(name, StringComparison.Ordinal) || key[name.Length] != '`')
        {
            return false;
        }

        return int.TryParse(
            key.Substring(name.Length + 1),
            System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture,
            out arity);
    }

    private static ImmutableArray<ParameterSymbol> SigCallableParameters(FunctionSymbol f)
        => f.ExplicitReceiverParameter == null ? f.Parameters : f.Parameters.RemoveAt(0);

    /// <summary>
    /// Issue #1188 / #775: compares the type-parameter constraints of two
    /// extension functions for overload-identity purposes. Two extensions that
    /// share a name, receiver type, and callable parameter signature are still
    /// distinct overloads when their generic type parameters carry different
    /// constraints (e.g. <c>FirstOrNil[T class]()</c> vs
    /// <c>FirstOrNil[T struct]()</c>), because receiver-constraint dispatch
    /// disambiguates them at the call site. Returns <see langword="true"/> only
    /// when every type parameter carries equivalent class/struct/new() and
    /// interface/base constraints.
    /// </summary>
    /// <param name="a">First extension function.</param>
    /// <param name="b">Second extension function.</param>
    /// <returns>Whether the two functions' type-parameter constraints match.</returns>
    private static bool ExtensionTypeParameterConstraintsEqual(FunctionSymbol a, FunctionSymbol b)
    {
        var aTp = a.TypeParameters.IsDefault ? ImmutableArray<TypeParameterSymbol>.Empty : a.TypeParameters;
        var bTp = b.TypeParameters.IsDefault ? ImmutableArray<TypeParameterSymbol>.Empty : b.TypeParameters;
        if (aTp.Length != bTp.Length)
        {
            return false;
        }

        for (var i = 0; i < aTp.Length; i++)
        {
            var x = aTp[i];
            var y = bTp[i];
            if (x.HasValueTypeConstraint != y.HasValueTypeConstraint
                || x.HasReferenceTypeConstraint != y.HasReferenceTypeConstraint
                || x.HasDefaultConstructorConstraint != y.HasDefaultConstructorConstraint
                || x.Constraint != y.Constraint)
            {
                return false;
            }

            var xRef = x.ConstraintReferenceType?.Name;
            var yRef = y.ConstraintReferenceType?.Name;
            if (!string.Equals(xRef, yRef, StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    private static bool SigTypesEquivalent(TypeSymbol x, TypeSymbol y, FunctionSymbol fx, FunctionSymbol fy)
    {
        if (ReferenceEquals(x, y))
        {
            return true;
        }

        if (x == null || y == null)
        {
            return false;
        }

        if (x is TypeParameterSymbol xtp && y is TypeParameterSymbol ytp)
        {
            var xi = SigIndexOfTypeParameter(fx, xtp);
            var yi = SigIndexOfTypeParameter(fy, ytp);
            return xi >= 0 && xi == yi;
        }

        return x.Name == y.Name;
    }

    private static int SigIndexOfTypeParameter(FunctionSymbol f, TypeParameterSymbol tp)
    {
        if (f.TypeParameters.IsDefault)
        {
            return -1;
        }

        for (var i = 0; i < f.TypeParameters.Length; i++)
        {
            if (ReferenceEquals(f.TypeParameters[i], tp))
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>
    /// Enumerates every import visible from this scope: ancestor scopes'
    /// imports first (outermost first), then this scope's own — matching the
    /// order the old eager parent-to-child copy produced.
    /// </summary>
    private IEnumerable<ImportSymbol> EnumerateImports()
    {
        if (Parent != null)
        {
            foreach (var import in Parent.EnumerateImports())
            {
                yield return import;
            }
        }

        if (imports != null)
        {
            foreach (var import in imports)
            {
                yield return import;
            }
        }
    }

    private void AddSymbol(string name, Symbol symbol)
    {
        symbols.Add(name, symbol);
        symbolKeys ??= ImmutableArray.CreateBuilder<string>();
        symbolKeys.Add(name);
    }

    private bool TryDeclareSymbol<TSymbol>(TSymbol symbol)
        where TSymbol : Symbol
    {
        if (symbol.Name == null)
        {
            return false;
        }

        symbols ??= ImmutableDictionary.CreateBuilder<string, Symbol>();
        if (symbols.ContainsKey(symbol.Name))
        {
            return false;
        }

        AddSymbol(symbol.Name, symbol);
        return true;
    }

    private ImmutableArray<TSymbol> GetDeclaredSymbols<TSymbol>()
        where TSymbol : Symbol
    {
        if (symbols == null)
        {
            return ImmutableArray<TSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<TSymbol>();
        foreach (var key in symbolKeys)
        {
            if (symbols.TryGetValue(key, out var symbol) && symbol is TSymbol typed)
            {
                builder.Add(typed);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// True when at least one of the extension's own type parameters
    /// (the ones declared on the extension function itself) occurs
    /// somewhere inside <paramref name="receiverType"/>.
    /// </summary>
    private static bool ReceiverMentionsAnyTypeParameter(TypeSymbol receiverType, ImmutableArray<TypeParameterSymbol> functionTypeParameters)
    {
        if (functionTypeParameters.IsDefaultOrEmpty || receiverType == null)
        {
            return false;
        }

        var collected = new HashSet<TypeParameterSymbol>();
        CollectTypeParameters(receiverType, collected, depth: 0);
        if (collected.Count == 0)
        {
            return false;
        }

        foreach (var tp in functionTypeParameters)
        {
            if (collected.Contains(tp))
            {
                return true;
            }
        }

        return false;
    }

    private static void CollectTypeParameters(TypeSymbol type, HashSet<TypeParameterSymbol> sink, int depth)
    {
        if (type == null || depth > 32)
        {
            return;
        }

        switch (type)
        {
            case TypeParameterSymbol tp:
                sink.Add(tp);
                return;
            case NullableTypeSymbol n:
                CollectTypeParameters(n.UnderlyingType, sink, depth + 1);
                return;
            case SliceTypeSymbol s:
                CollectTypeParameters(s.ElementType, sink, depth + 1);
                return;
            case ArrayTypeSymbol a:
                CollectTypeParameters(a.ElementType, sink, depth + 1);
                return;
            case SequenceTypeSymbol seq:
                CollectTypeParameters(seq.ElementType, sink, depth + 1);
                return;
            case AsyncSequenceTypeSymbol aseq:
                CollectTypeParameters(aseq.ElementType, sink, depth + 1);
                return;
            case FunctionTypeSymbol f:
                if (!f.ParameterTypes.IsDefaultOrEmpty)
                {
                    foreach (var p in f.ParameterTypes)
                    {
                        CollectTypeParameters(p, sink, depth + 1);
                    }
                }

                CollectTypeParameters(f.ReturnType, sink, depth + 1);
                return;
            case ImportedTypeSymbol it:
                if (!it.TypeArguments.IsDefaultOrEmpty)
                {
                    foreach (var arg in it.TypeArguments)
                    {
                        CollectTypeParameters(arg, sink, depth + 1);
                    }
                }

                return;
            case StructSymbol ss:
                if (!ss.TypeArguments.IsDefaultOrEmpty)
                {
                    foreach (var arg in ss.TypeArguments)
                    {
                        CollectTypeParameters(arg, sink, depth + 1);
                    }
                }

                return;
            default:
                return;
        }
    }

    /// <summary>
    /// ADR-0097 / issue #775: tries to unify the declared open receiver type
    /// with the call-site receiver and — when unification succeeds —
    /// validates that every receiver-mentioned type parameter's
    /// <c>class</c> / <c>struct</c> / <c>new()</c> constraint is satisfied
    /// by the inferred type argument. Returns the candidate's
    /// constraint-specificity score so the caller can prefer the most
    /// specific surviving overload.
    /// </summary>
    /// <param name="extension">The extension-method candidate.</param>
    /// <param name="receiverType">The call-site receiver type.</param>
    /// <param name="specificity">The cumulative specificity score (struct=2, class=1, none=0) summed across the receiver-mentioned type parameters.</param>
    /// <returns><see langword="true"/> when unification succeeds and every constraint is satisfied; otherwise <see langword="false"/>.</returns>
    private static bool TryUnifyAndCheckConstraints(FunctionSymbol extension, TypeSymbol receiverType, out int specificity)
    {
        specificity = 0;
        var substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        Binder.InferTypeArguments(extension.ExtensionReceiverType, receiverType, substitution);

        var mentioned = new HashSet<TypeParameterSymbol>();
        CollectTypeParameters(extension.ExtensionReceiverType, mentioned, depth: 0);
        foreach (var tp in mentioned)
        {
            if (!substitution.TryGetValue(tp, out var arg))
            {
                return false;
            }

            if (!Binder.SatisfiesConstraint(arg, tp))
            {
                return false;
            }

            if (tp.HasValueTypeConstraint)
            {
                specificity += 2;
            }
            else if (tp.HasReferenceTypeConstraint)
            {
                specificity += 1;
            }
        }

        return true;
    }
}
