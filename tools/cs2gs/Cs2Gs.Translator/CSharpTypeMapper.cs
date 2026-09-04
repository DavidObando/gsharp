// <copyright file="CSharpTypeMapper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection.Metadata;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.Translator.Coverage;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Cs2Gs.Translator;

/// <summary>
/// Converts a Roslyn <see cref="ITypeSymbol"/> into the canonical G# type
/// reference (<see cref="GTypeReference"/>) following ADR-0115 §B.7, §B.8, and
/// §B.12. The mapper is driven by the bound <see cref="ITypeSymbol"/> (not the
/// raw syntax) so width-bearing primitive names, generic instantiations,
/// delegate arrow forms, and nullability are resolved semantically.
/// <para>
/// A C# type with no established canonical G# form (e.g. a value tuple /
/// named-tuple type) is <b>never</b> approximated with non-parsing text: the
/// mapper records a structured <see cref="TranslationSeverity.Unsupported"/>
/// <see cref="TranslationDiagnostic"/> and emits the nearest parseable
/// placeholder (<see cref="UnsupportedPlaceholderType"/>) so the file still
/// round-trips while the gap is surfaced for triage (ADR-0115 §B/§D).
/// </para>
/// </summary>
public sealed class CSharpTypeMapper
{
    /// <summary>
    /// The parseable placeholder type name emitted when a C# type has no
    /// canonical G# form. <c>object</c> is the universal upper bound (spec
    /// §Object) so the emitted file always re-parses; the real gap is carried by
    /// the accompanying <see cref="TranslationSeverity.Unsupported"/> diagnostic.
    /// </summary>
    public const string UnsupportedPlaceholderType = "object";

    /// <summary>
    /// Public top-level type names exposed by every namespace analyzer-mode
    /// rewrites may synthesize, cached from the G# core assembly.
    /// </summary>
    private static readonly System.Lazy<IReadOnlyDictionary<string, List<string>>> AnalyzerTargetTypeNames =
        new(BuildAnalyzerTargetTypeNames);

    /// <summary>
    /// Issue #3805: the linked-source index (see <see cref="LinkedDocumentIndex"/>)
    /// per repository compilation set, cached weakly so it is built once per
    /// migration run instead of once per translated document.
    /// </summary>
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<
        object,
        Dictionary<string, List<(CSharpCompilation Compilation, SyntaxTree Tree)>>> LinkedDocumentIndexes = new();

    /// <summary>
    /// Issue #2211: every namespace this mapper has shortened a type reference
    /// into (via <see cref="QualifiedTypeName"/>), collected so the translator
    /// can synthesize a matching <c>import</c> for a namespace with no
    /// corresponding <c>using</c> directive in the source file — the shape
    /// Roslyn source generators emit (fully-qualified references, no
    /// <c>using</c>s at all). Without this, a short-named reference to a type
    /// whose namespace has no <c>using</c> directive round-trips to unresolvable
    /// G# (GS0113/GS0157). The translator filters out the file's own package
    /// and any namespace already covered by an explicit <c>using</c> before
    /// emitting the rest as synthesized imports.
    /// </summary>
    private readonly HashSet<string> shortenedNamespaces = new();

    /// <summary>
    /// Issue #2282: every distinct anonymous-type SHAPE (an ordered list of
    /// member name + fully-qualified type) already mapped to a synthesized
    /// <c>data class</c>, keyed structurally so two syntactically-identical
    /// anonymous types declared at different source locations share one
    /// synthesized declaration instead of each minting its own (which would
    /// combinatorially explode across a large file). See
    /// <see cref="GetOrCreateAnonymousDataClass"/>.
    /// <para>
    /// The <see cref="AnonymousTypeRegistry"/> is shared by every mapper for a
    /// package so identical shapes are declared once (#2292). Names are derived
    /// from the complete ordered shape rather than a translation-local counter,
    /// keeping distinct declarations unambiguous across packages and projects
    /// even when one package imports another (#2598).
    /// </para>
    /// </summary>
    private readonly AnonymousTypeRegistry anonymousTypeRegistry;
    private readonly EmittedNameAllocator nameAllocator;

    /// <summary>
    /// Issue #2282: the synthesized anonymous-type <c>data class</c>
    /// declarations first minted by THIS mapper (i.e. this source file),
    /// in first-seen order, collected here (rather than emitted inline)
    /// because <see cref="Map"/> is called from many contexts (a
    /// parameter type, a field type, a generic argument, ...) that have no
    /// direct way to append a new top-level type declaration to the
    /// compilation unit being built. <c>CSharpToGSharpTranslator.TranslateDocument</c>
    /// drains this list into the compilation unit's members once, after every
    /// member has been translated (mirroring how <see cref="ShortenedNamespaces"/>
    /// is drained into synthesized imports).
    /// <para>
    /// Issue #2292: a shape already declared by an EARLIER file sharing this
    /// mapper's <see cref="anonymousTypeRegistry"/> is intentionally NOT
    /// re-added here (see <see cref="GetOrCreateAnonymousDataClass"/>) so the
    /// data class is declared exactly once per package, in the first file
    /// that needed it, instead of once per file (which would itself be a
    /// GS0102 duplicate-declaration collision even for an IDENTICAL shape).
    /// </para>
    /// </summary>
    private readonly List<TypeDeclaration> pendingAnonymousDataClasses = new();

    private readonly Dictionary<string, string> synthesizedTypeAliases =
        new(System.StringComparer.Ordinal);

    private readonly Dictionary<string, HashSet<string>> reservedTypeAliases =
        new(System.StringComparer.Ordinal);

    private readonly HashSet<string> reservedImportedTypeNames =
        new(System.StringComparer.Ordinal);

    private readonly HashSet<string> reservedTypeParameterNames =
        new(System.StringComparer.Ordinal);

    private readonly HashSet<string> reservedInvokedLocalNames =
        new(System.StringComparer.Ordinal);

    // Issue #3471: static member simple names declared by source aggregates in
    // the contributing trees. Sibling static references print bare inside
    // their declaring aggregate, and a file-scope import alias shadows class
    // members in gsc scope resolution, so a synthesized readable alias must
    // never take one of these names.
    private readonly HashSet<string> reservedSiblingStaticMemberNames =
        new(System.StringComparer.Ordinal);

    /// <summary>
    /// Issue #1174: cached per-compilation census of source-declared top-level
    /// type simple names (built lazily on first use), used to decide whether a
    /// bare type name is ambiguous and must be emitted in qualified form.
    /// Nested declarations are excluded because they are not imported by their
    /// simple names.
    /// </summary>
    private Dictionary<CSharpCompilation, Dictionary<string, HashSet<string>>> sourceTopLevelSimpleNames;

    private Dictionary<CSharpCompilation, Dictionary<string, HashSet<string>>> sourceNestedSimpleNames;

    /// <summary>
    /// Issue #3841: the constructed delegate types whose CLR identity is
    /// load-bearing in the compilation currently being translated, computed
    /// once per compilation by <see cref="CollectIdentityCriticalDelegates(Compilation)"/>.
    /// </summary>
    private HashSet<INamedTypeSymbol> identityCriticalDelegates;

    /// <summary>
    /// Issue #3841: the compilation <see cref="identityCriticalDelegates"/> was
    /// computed for; a different one recomputes the set.
    /// </summary>
    private Compilation identityCriticalDelegatesCompilation;

    private HashSet<string> sourceDeclaredTypeNames;

    /// <summary>
    /// Issue #2222: the current file's imported namespace names (`using`
    /// directives plus its own declared namespace), cached lazily since every
    /// top-level-type reference in a file shares the same import set. Used to
    /// detect a same-simple-name collision reachable via THIS file's imports,
    /// including one that lives in a referenced assembly (a translated sibling
    /// project) rather than in source.
    /// </summary>
    private HashSet<string> importedNamespaceNames;

    /// <summary>
    /// Issue #3805: the semantic models of the file being translated, one per
    /// repository compilation that COMPILES that file. For an ordinary file
    /// that is just <see cref="TranslationContext.SemanticModel"/>; for a
    /// LINKED source (<c>&lt;Compile Include="..\Shared\X.cs" /&gt;</c> in
    /// several projects) it is one model per linking project. See
    /// <see cref="LinkedDocumentModels(TranslationContext)"/>.
    /// </summary>
    private Dictionary<SyntaxTree, IReadOnlyList<SemanticModel>> linkedDocumentModels;

    /// <summary>
    /// Issue #2509: constraint slots must disambiguate metadata/metadata
    /// homonyms as well as source collisions. Ordinary type positions retain
    /// the existing source-authored collision policy to avoid gratuitously
    /// qualifying framework types that share a name across BCL namespaces.
    /// </summary>
    private bool qualifyMetadataImportCollisions;

    /// <summary>
    /// Initializes a new instance of the <see cref="CSharpTypeMapper"/> class
    /// with a private, unshared anonymous-type registry (every prior call
    /// site's behavior — used by standalone/single-file callers such as
    /// existing tests that never span multiple documents in the same
    /// package).
    /// </summary>
    public CSharpTypeMapper()
        : this(new AnonymousTypeRegistry())
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="CSharpTypeMapper"/> class
    /// sharing <paramref name="anonymousTypeRegistry"/> with every other
    /// mapper translating a document into the same G# package (issue #2292).
    /// </summary>
    /// <param name="anonymousTypeRegistry">
    /// The package-scoped registry of already-synthesized anonymous-type shapes.
    /// </param>
    public CSharpTypeMapper(AnonymousTypeRegistry anonymousTypeRegistry)
        : this(anonymousTypeRegistry, nameAllocator: null)
    {
    }

    internal CSharpTypeMapper(
        AnonymousTypeRegistry anonymousTypeRegistry,
        EmittedNameAllocator nameAllocator)
    {
        this.anonymousTypeRegistry = anonymousTypeRegistry ?? new AnonymousTypeRegistry();
        this.nameAllocator = nameAllocator;
    }

    /// <summary>
    /// Gets or sets a value indicating whether ADR-0169 analyzer translation
    /// mode is active: Microsoft.CodeAnalysis types are rewritten to the G#
    /// analyzer API via <see cref="Analyzers.RoslynAnalyzerApiMap"/> instead
    /// of passing through as imported CLR types.
    /// </summary>
    public bool AnalyzerApiMode { get; set; }

    /// <summary>
    /// Gets every namespace shortened into a bare/qualified-nested type name by
    /// this mapper so far (see <see cref="shortenedNamespaces"/>).
    /// </summary>
    public IReadOnlyCollection<string> ShortenedNamespaces => this.shortenedNamespaces;

    /// <summary>
    /// Gets type aliases synthesized to preserve unambiguous source or CLR type
    /// identity.
    /// </summary>
    public IReadOnlyDictionary<string, string> SynthesizedTypeAliases =>
        this.synthesizedTypeAliases;

    /// <summary>
    /// Gets the synthesized anonymous-type <c>data class</c> declarations
    /// collected so far by <see cref="GetOrCreateAnonymousDataClass"/>, in
    /// first-seen (deterministic) order.
    /// </summary>
    public IReadOnlyList<TypeDeclaration> PendingAnonymousDataClasses => this.pendingAnonymousDataClasses;

    /// <summary>
    /// Records a G# namespace substituted for a Roslyn API namespace in
    /// analyzer translation mode (ADR-0169), so the compilation-unit import
    /// synthesis emits it even though no C# symbol carries it.
    /// </summary>
    /// <param name="gsNamespace">The G# namespace to import.</param>
    public void TrackSubstitutedNamespace(string gsNamespace)
    {
        if (!string.IsNullOrEmpty(gsNamespace))
        {
            this.shortenedNamespaces.Add(gsNamespace);
        }
    }

    /// <summary>
    /// Records a translated attribute type's containing namespace and any
    /// source alias so the compilation-unit import synthesis can resolve the
    /// attribute without changing its source spelling.
    /// </summary>
    /// <param name="attributeType">The semantically resolved attribute type.</param>
    /// <param name="alias">The alias used by the attribute name, if any.</param>
    public void TrackAttributeType(INamedTypeSymbol attributeType, IAliasSymbol alias)
    {
        if (attributeType != null)
        {
            this.TrackShortenedNamespace(attributeType);
        }

        string aliasTarget = alias?.Target switch
        {
            INamespaceSymbol ns when !ns.IsGlobalNamespace =>
                this.nameAllocator?.GetNamespaceName(ns) ?? ns.ToDisplayString(),
            INamedTypeSymbol type => this.QualifiedAliasTarget(type),
            _ => null,
        };
        if (!string.IsNullOrEmpty(aliasTarget))
        {
            string aliasName = this.nameAllocator?.GetName(alias)
                ?? GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts.GetEmittedIdentifier(
                    alias.Name,
                    GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Type);
            this.synthesizedTypeAliases[aliasName] = aliasTarget;
        }
    }

    /// <summary>
    /// Records the declaring namespace of a resolved extension-method
    /// invocation or method-group reference into the same shortened-namespace
    /// tracking set used for type imports (see <see cref="shortenedNamespaces"/>),
    /// so that an import is synthesized for it even though the call site
    /// itself names no type. Extension-method calls (reduced instance form,
    /// unreduced static form, or a bare method-group reference) never flow
    /// through <see cref="TrackShortenedNamespace"/> because they don't
    /// reference a type name directly, so without this tracking a file that
    /// relies on a project-wide or implicit <c>using</c> for the extension's
    /// namespace (e.g. <c>&lt;ImplicitUsings&gt;enable&lt;/ImplicitUsings&gt;</c>
    /// providing <c>System.Linq</c>) would translate to G# with no import for
    /// that namespace at all.
    /// </summary>
    /// <param name="method">The resolved extension method symbol.</param>
    public void TrackExtensionMethodNamespace(IMethodSymbol method)
    {
        INamespaceSymbol ns = GetExtensionMethodNamespace(method);
        if (ns is null)
        {
            return;
        }

        this.shortenedNamespaces.Add(
            this.nameAllocator?.GetNamespaceName(ns) ?? ns.ToDisplayString());
    }

    /// <summary>
    /// Maps a Roslyn type symbol to its canonical G# type reference, recording
    /// an unsupported-construct diagnostic on <paramref name="context"/> for any
    /// type with no canonical G# form.
    /// </summary>
    /// <param name="type">The bound C# type symbol.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>The canonical G# type reference (never <see langword="null"/>).</returns>
    public GTypeReference Map(ITypeSymbol type, TranslationContext context, Location location)
    {
        if (type == null || type.TypeKind == TypeKind.Error)
        {
            context.Report(new TranslationDiagnostic(
                type?.ToDisplayString() ?? "<unresolved-type>",
                "Could not resolve a C# type symbol; emitted the placeholder type.",
                location,
                TranslationSeverity.Unsupported));
            return new NamedTypeReference(UnsupportedPlaceholderType);
        }

        // C# `dynamic` has the same CLR representation as `object`; dynamic
        // dispatch is already resolved by Roslyn at the source call sites.
        if (type.TypeKind == TypeKind.Dynamic)
        {
            return new NamedTypeReference("object");
        }

        // Issue #1894: `System.Index`/`System.Range` have no canonical G# value
        // type. G#'s own `^n`/`a..b` syntax exists only as bracket-scoped index
        // sugar (gsc's Parser.ParseIndexBound) that lowers directly against the
        // collection it indexes — there is no reusable value carrying from-end
        // semantics. Mapping the type through as a bare name would let a local,
        // parameter, field, or return type of type Index/Range compile and then
        // silently misbehave at runtime (a stored `^n` re-parses elsewhere as
        // one's-complement, not from-end). Gap loudly instead.
        if (IsSystemIndexOrRange(type))
        {
            context.Report(new TranslationDiagnostic(
                type.Name,
                $"'System.{type.Name}' has no canonical G# type: G# has no reusable from-end index/range value, only bracket-scoped '^n'/'a..b' sugar, so a {type.Name}-typed local/parameter/field/return cannot carry from-end semantics correctly (issue #1894).",
                location,
                TranslationSeverity.Unsupported));
            return new NamedTypeReference(UnsupportedPlaceholderType);
        }

        // A C# unsafe pointer type (`T*`, `void*`) maps to the canonical G#
        // PREFIX pointer form `*T` (spec §"Byref/pointer syntax exists as
        // `*T`"; grammar `'*' TypeClause '?'?`). A `void*` (no element type)
        // maps to the faithful void-element pointer `*void` (ADR-0122 §3 /
        // issue #1033) — distinct from a byte pointer `*uint8`: it round-trips
        // through `nint`/`IntPtr` and casts to/from typed pointers, but cannot
        // be dereferenced/indexed/advanced without a cast. The emitted form
        // round-trips through the parser; the binder steers callers to
        // ref/out/in (GS0243) and rejects pointer fields (GS9006) on the
        // excepted unsafe Win32-interop surface (ADR-0115 §G). A FUNCTION
        // pointer has no canonical managed G# form and stays Unsupported.
        if (type is IPointerTypeSymbol pointer)
        {
            ITypeSymbol pointee = pointer.PointedAtType;
            GTypeReference element = pointee == null || pointee.SpecialType == SpecialType.System_Void
                ? new NamedTypeReference("void")
                : this.Map(pointee, context, location);
            context.Report(new TranslationDiagnostic(
                "PointerType",
                $"unsafe pointer type '{type.ToDisplayString()}' maps to the canonical G# prefix-pointer form; the binder steers callers to ref/out/in (GS0243) on the excepted unsafe Win32-interop surface (ADR-0115 §G).",
                location,
                TranslationSeverity.Info));
            return new PointerTypeReference(element);
        }

        // Issue #1906: a C# function pointer (`delegate*<...>`) maps to one of
        // G#'s two function-pointer forms — see MapFunctionPointer.
        if (type is IFunctionPointerTypeSymbol functionPointer)
        {
            return this.MapFunctionPointer(functionPointer, context, location);
        }

        // A nullable value type (Nullable<T>) carries its payload as the single
        // type argument; map the underlying type and mark the result nullable.
        if (type is INamedTypeSymbol nullableValue &&
            nullableValue.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
        {
            GTypeReference underlying = this.Map(nullableValue.TypeArguments[0], context, location);
            return WithNullable(underlying, true);
        }

        // A `T?`-annotated type also covers an annotated type parameter (`T?`
        // where `T : IFoo` / unconstrained). Such a parameter reports
        // `IsReferenceType == false` (an interface/unconstrained type parameter is
        // not provably a reference type), so it must be recognised explicitly or
        // the `?` is silently dropped and the nullable return/field no longer
        // type-checks against `== nil`. A `T : struct` parameter's `T?` is modelled
        // by Roslyn as `Nullable<T>` and is handled above, so an annotated
        // ITypeParameterSymbol here is always the nullable-reference-like form.
        bool nullableReference = type.NullableAnnotation == NullableAnnotation.Annotated
            && (type.IsReferenceType || type is ITypeParameterSymbol);

        // ADR-0169 analyzer mode: a declared INamespaceSymbol renders as G#'s
        // namespace display string, whose honest type is `string?` —
        // `Symbol.ContainingNamespace` is nil for symbols without a containing
        // namespace, while Roslyn annotates `INamespaceSymbol` members and
        // parameters non-nullable. Without the forced `?`, a null-tolerant C#
        // helper taking INamespaceSymbol translates to a non-nullable `string`
        // parameter and every `ContainingNamespace` argument gets bridged with
        // `!!` — an assert at a site where the C# never dereferences, i.e. a
        // runtime NRE the original could not produce (the migrated
        // EmitCacheKeyRemapScopeAnalyzer crashed exactly this way).
        bool analyzerNamespaceString = this.AnalyzerApiMode
            && Analyzers.RoslynAnalyzerApiMap.IsNamespaceSymbolType(type);
        GTypeReference mapped = this.MapCore(type, context, location);
        return nullableReference || analyzerNamespaceString ? WithNullable(mapped, true) : mapped;
    }

    /// <summary>
    /// Maps a type used in G#'s legacy generic-constraint slot. The slot uses
    /// the canonical semantic name/type arguments but does not accept an outer
    /// nullable marker, so a C# nullable constraint annotation is reported and
    /// dropped while nested nullable type arguments remain intact.
    /// </summary>
    /// <param name="type">The bound C# constraint type.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# constraint location.</param>
    /// <returns>The canonical G# constraint type reference.</returns>
    public GTypeReference MapConstraintType(
        ITypeSymbol type,
        TranslationContext context,
        Location location)
    {
        GTypeReference mapped = this.WithMetadataImportCollisionQualification(
            () => this.Map(type, context, location));

        if (!mapped.IsNullable)
        {
            return mapped;
        }

        string message = $"constraint type '{type.ToDisplayString()}' has a nullable annotation; " +
            "G#'s generic-constraint slot has no nullable form, so the outer annotation is dropped.";
        context.Report(new TranslationDiagnostic(
            nameof(SyntaxKind.TypeParameterConstraintClause),
            message,
            location,
            TranslationSeverity.Info));
        return WithNullable(mapped, false);
    }

    /// <summary>
    /// Maps an event's handler type without erasing its nominal delegate
    /// identity. Event metadata and add/remove signatures are ABI-sensitive:
    /// structurally equivalent delegates are not interchangeable in the CLR.
    /// </summary>
    /// <param name="type">The event's declared handler type.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>The canonical G# type reference for the event's handler type.</returns>
    public GTypeReference MapEventType(ITypeSymbol type, TranslationContext context, Location location)
    {
        if (type is INamedTypeSymbol { TypeKind: TypeKind.Delegate, DelegateInvokeMethod: not null } named)
        {
            if (named.IsGenericType)
            {
                List<GTypeReference> delegateArgs = named.TypeArguments
                    .Select(a => this.Map(a, context, location))
                    .ToList();
                return new NamedTypeReference(this.DelegateTypeName(named, context, location), delegateArgs);
            }

            return new NamedTypeReference(this.DelegateTypeName(named, context, location));
        }

        return this.Map(type, context, location);
    }

    /// <summary>
    /// Issue #2282: maps a C# anonymous type (<c>new { A = 1, B = "x" }</c>) to
    /// a synthesized G# <c>data class</c> whose primary-constructor parameters
    /// carry the SAME member names, instead of the earlier positional-tuple
    /// lowering (issue #1934) that discarded them (G# tuples have no
    /// named-element syntax — verified: no such syntax exists anywhere in the
    /// grammar/spec). The <c>object { }</c> anonymous-value literal (issue
    /// #2224) is not a substitute either: it is only a value-literal
    /// expression form with no corresponding TYPE-ANNOTATION spelling, so it
    /// cannot be written down as, say, a lambda parameter's type — which is
    /// exactly what issue #2282's repro needs (an EF-Core-style
    /// <c>CreateTable</c>/<c>PrimaryKey</c> pattern where the SAME anonymous
    /// type crosses from one lambda's inferred return type into another
    /// lambda's parameter type via generic inference). A synthesized data
    /// class is nameable at both the construction site and any type-position
    /// use, and supports named-member access (<c>x.A</c>) directly with no
    /// <c>.ItemN</c> rewrite. It is also legal inside an expression-tree
    /// lambda: a user-declared struct/class composite literal is explicitly
    /// permitted there (see <c>ExpressionTreeRestrictionValidator.ValidateExpression</c>,
    /// <c>BoundStructLiteralExpression</c> case), unlike the tuple literal the
    /// earlier lowering could have produced.
    /// <para>
    /// Every distinct anonymous-type SHAPE (the ordered list of member name +
    /// fully-qualified property type) reuses the same synthesized type across
    /// the whole PACKAGE (issue #2292; formerly just the document) — keyed
    /// structurally via <see cref="anonymousTypeRegistry"/>, not by Roslyn
    /// symbol identity — so two syntactically-identical anonymous types
    /// declared in different places (even different files of the same
    /// package) still share one declaration, avoiding a combinatorial
    /// explosion of synthesized types and, just as importantly, avoiding two
    /// DISTINCT shapes across files ever minting the same synthetic name.
    /// </para>
    /// </summary>
    /// <param name="anonymousType">The anonymous type symbol.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>A reference to the synthesized (or already-cached) data class.</returns>
    public NamedTypeReference GetOrCreateAnonymousDataClass(INamedTypeSymbol anonymousType, TranslationContext context, Location location) =>
        this.GetOrCreateAnonymousDataClassShape(anonymousType, context, location).Type;

    /// <summary>
    /// Reserves aliases and bare type names already present in the final
    /// translated import set.
    /// </summary>
    /// <param name="imports">Imports collected from the active and merged source trees.</param>
    /// <param name="contributingTrees">Source trees whose declarations contribute to the emitted document.</param>
    /// <param name="compilation">The source compilation.</param>
    internal void ReserveImportNames(
        IEnumerable<ImportDirective> imports,
        IEnumerable<SyntaxTree> contributingTrees,
        Compilation compilation)
    {
        EmittedNameAllocator names = this.nameAllocator
            ?? EmittedNameAllocator.For(compilation);
        var importedNamespaces = new HashSet<INamespaceSymbol>(
            SymbolEqualityComparer.Default);
        var mappedMethods = new HashSet<IMethodSymbol>(
            SymbolEqualityComparer.Default);
        var mappedTypes = new HashSet<ITypeSymbol>(
            SymbolEqualityComparer.Default);
        void AddImportedNamespace(string emittedNamespace)
        {
            INamespaceSymbol importedNamespace = ResolveEmittedNamespace(
                compilation,
                emittedNamespace,
                names);
            if (importedNamespace != null)
            {
                importedNamespaces.Add(importedNamespace);
            }
        }

        void AddSymbolNamespace(ISymbol symbol)
        {
            if (symbol is INamedTypeSymbol type)
            {
                while (type.ContainingType != null)
                {
                    type = type.ContainingType;
                }

                if (type.ContainingNamespace is { IsGlobalNamespace: false } ns)
                {
                    importedNamespaces.Add(ns);
                }
            }
            else if (symbol is IMethodSymbol method
                && GetExtensionMethodNamespace(method) is { } extensionNamespace)
            {
                importedNamespaces.Add(extensionNamespace);
            }
        }

        void AddMappedMethodSignatureNamespaces(IMethodSymbol method)
        {
            if (method == null || !mappedMethods.Add(method))
            {
                return;
            }

            if (!method.ReturnsVoid)
            {
                AddMappedTypeNamespaces(method.ReturnType);
            }

            foreach (IParameterSymbol parameter in method.Parameters)
            {
                AddMappedTypeNamespaces(parameter.Type);
            }

            foreach (ITypeSymbol typeArgument in method.TypeArguments)
            {
                AddMappedTypeNamespaces(typeArgument);
            }
        }

        void AddMappedTypeNamespaces(ITypeSymbol type)
        {
            if (type == null
                || type.TypeKind is TypeKind.Dynamic or TypeKind.Error
                || !mappedTypes.Add(type))
            {
                return;
            }

            switch (type)
            {
                case IArrayTypeSymbol array:
                    AddMappedTypeNamespaces(array.ElementType);
                    return;
                case IPointerTypeSymbol pointer:
                    AddMappedTypeNamespaces(pointer.PointedAtType);
                    return;
                case IFunctionPointerTypeSymbol functionPointer:
                    AddMappedMethodSignatureNamespaces(functionPointer.Signature);
                    return;
                case ITypeParameterSymbol:
                    return;
            }

            if (type is not INamedTypeSymbol named)
            {
                return;
            }

            if (MapPredefinedName(named.SpecialType) != null
                || IsSystemIndexOrRange(named))
            {
                return;
            }

            if (named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            {
                AddMappedTypeNamespaces(named.TypeArguments[0]);
                return;
            }

            if (named.IsTupleType)
            {
                foreach (IFieldSymbol element in named.TupleElements)
                {
                    AddMappedTypeNamespaces(element.Type);
                }

                return;
            }

            if (named.IsAnonymousType)
            {
                foreach (IPropertySymbol property in named.GetMembers().OfType<IPropertySymbol>())
                {
                    AddMappedTypeNamespaces(property.Type);
                }

                return;
            }

            if (named.TypeKind == TypeKind.Delegate
                && named.DelegateInvokeMethod is { } invoke
                && !IsSourceDeclaredDelegate(named))
            {
                AddMappedMethodSignatureNamespaces(invoke);
                return;
            }

            foreach (ITypeSymbol typeArgument in named.TypeArguments)
            {
                AddMappedTypeNamespaces(typeArgument);
            }

            if (named.ContainingType != null)
            {
                AddMappedTypeNamespaces(named.ContainingType);
            }

            if (!this.AnalyzerApiMode
                || !Analyzers.RoslynAnalyzerApiMap.IsRoslynNamespace(
                    named.ContainingNamespace?.ToDisplayString()))
            {
                AddSymbolNamespace(named);
            }
        }

        void AddMappedOperationTypeNamespaces(
            SyntaxNode node,
            IOperation operation,
            SemanticModel semanticModel)
        {
            AddMappedTypeNamespaces(operation?.Type);
            if (node is ExpressionSyntax expression)
            {
                TypeInfo typeInfo = semanticModel.GetTypeInfo(expression);
                AddMappedTypeNamespaces(typeInfo.Type);
                AddMappedTypeNamespaces(typeInfo.ConvertedType);
            }
        }

        foreach (ImportDirective import in imports)
        {
            if (import.Alias != null)
            {
                if (!this.reservedTypeAliases.TryGetValue(import.Alias, out var targets))
                {
                    targets = new HashSet<string>(System.StringComparer.Ordinal);
                    this.reservedTypeAliases.Add(import.Alias, targets);
                }

                targets.Add(import.Name);
                continue;
            }

            AddImportedNamespace(import.Name);
        }

        // Analyzer rewrites can synthesize imports from member/attribute
        // shapes that carry no mapped G# type symbol in the C# syntax. Reserve
        // every possible mapped target namespace up front so alias allocation
        // cannot depend on which declaration happens to translate first.
        if (this.AnalyzerApiMode)
        {
            foreach (var targetNamespace in AnalyzerTargetTypeNames.Value)
            {
                AddImportedNamespace(targetNamespace.Key);
                this.reservedImportedTypeNames.UnionWith(targetNamespace.Value);
            }
        }

        // Qualified references are shortened and synthesize namespace imports
        // after translation. Calls and selected operation-bound expressions can
        // also map types absent from syntax. Pre-scan only those emitted shapes
        // so future bare names reserve alias candidates before first use.
        foreach (SyntaxTree tree in contributingTrees)
        {
            SemanticModel semanticModel = compilation.GetSemanticModel(tree);
            foreach (SyntaxNode node in tree.GetRoot().DescendantNodes())
            {
                if (node is TypeParameterSyntax typeParameter
                    && semanticModel.GetDeclaredSymbol(typeParameter) is ITypeParameterSymbol typeParameterSymbol)
                {
                    this.reservedTypeParameterNames.Add(names.GetName(typeParameterSymbol));
                }

                if (node is TypeDeclarationSyntax memberCensusDeclaration
                    && semanticModel.GetDeclaredSymbol(memberCensusDeclaration) is INamedTypeSymbol
                        { TypeKind: TypeKind.Class or TypeKind.Struct } declaredAggregate)
                {
                    foreach (ISymbol member in declaredAggregate.GetMembers())
                    {
                        if (member.IsStatic
                            && member is IFieldSymbol or IPropertySymbol
                                or IMethodSymbol { MethodKind: MethodKind.Ordinary })
                        {
                            this.reservedSiblingStaticMemberNames.Add(names.GetName(member));
                        }
                    }
                }

                if (node is InvocationExpressionSyntax { Expression: SimpleNameSyntax invokedName })
                {
                    ISymbol invokedSymbol = semanticModel.GetSymbolInfo(invokedName).Symbol;
                    if (invokedSymbol is ILocalSymbol or IParameterSymbol or IRangeVariableSymbol
                        || invokedSymbol is IMethodSymbol { MethodKind: MethodKind.LocalFunction })
                    {
                        this.reservedInvokedLocalNames.Add(names.GetName(invokedSymbol));
                    }
                }

                if (node is AnonymousFunctionExpressionSyntax anonymousFunction)
                {
                    // Inferred lambda and anonymous-method signatures can emit
                    // target types that have no corresponding type syntax.
                    IMethodSymbol targetInvoke =
                        (semanticModel.GetTypeInfo(anonymousFunction).ConvertedType as INamedTypeSymbol)
                            ?.DelegateInvokeMethod
                        ?? (semanticModel.GetOperation(anonymousFunction) as IAnonymousFunctionOperation)
                            ?.Symbol;
                    AddMappedMethodSignatureNamespaces(targetInvoke);
                }

                // These lowerings emit operation/type-info types explicitly.
                // Ordinary expressions remain unreserved to avoid alias churn.
                bool mapsOperationType = node switch
                {
                    AnonymousObjectCreationExpressionSyntax
                        or ConditionalExpressionSyntax
                        or CollectionExpressionSyntax
                        or DefaultExpressionSyntax
                        or ImplicitArrayCreationExpressionSyntax
                        or ImplicitObjectCreationExpressionSyntax
                        or ImplicitStackAllocArrayCreationExpressionSyntax
                        or SwitchExpressionSyntax
                        or ThrowExpressionSyntax => true,
                    LiteralExpressionSyntax literal =>
                        literal.IsKind(SyntaxKind.DefaultLiteralExpression),
                    _ => false,
                };
                bool mapsSymbolNamespace = node is NameSyntax
                    or MemberAccessExpressionSyntax
                    or InvocationExpressionSyntax
                    or BaseObjectCreationExpressionSyntax;
                if (!mapsOperationType && !mapsSymbolNamespace)
                {
                    continue;
                }

                IOperation operation = semanticModel.GetOperation(node);
                if (mapsOperationType)
                {
                    AddMappedOperationTypeNamespaces(node, operation, semanticModel);
                }

                if (!mapsSymbolNamespace)
                {
                    continue;
                }

                SymbolInfo symbolInfo = semanticModel.GetSymbolInfo(node);
                AddSymbolNamespace(symbolInfo.Symbol);
                foreach (ISymbol candidate in symbolInfo.CandidateSymbols)
                {
                    AddSymbolNamespace(candidate);
                }

                switch (operation)
                {
                    case IInvocationOperation invocation:
                        AddSymbolNamespace(invocation.TargetMethod);
                        AddMappedMethodSignatureNamespaces(invocation.TargetMethod);
                        break;
                    case IObjectCreationOperation creation:
                        AddMappedTypeNamespaces(
                            creation.Constructor?.ContainingType ?? creation.Type);
                        AddMappedMethodSignatureNamespaces(creation.Constructor);
                        break;
                    case IDelegateCreationOperation delegateCreation:
                        AddMappedTypeNamespaces(delegateCreation.Type);
                        if (delegateCreation.Target is IMethodReferenceOperation delegateTarget)
                        {
                            AddSymbolNamespace(delegateTarget.Method);
                            AddMappedMethodSignatureNamespaces(delegateTarget.Method);
                        }

                        break;
                    case IMethodReferenceOperation methodReference:
                        AddSymbolNamespace(methodReference.Method);
                        AddMappedMethodSignatureNamespaces(methodReference.Method);
                        if (semanticModel.GetTypeInfo(node).ConvertedType
                            is INamedTypeSymbol { DelegateInvokeMethod: { } targetInvoke })
                        {
                            AddMappedMethodSignatureNamespaces(targetInvoke);
                        }

                        break;
                }
            }
        }

        foreach (INamespaceSymbol importedNamespace in importedNamespaces)
        {
            foreach (INamedTypeSymbol type in importedNamespace.GetTypeMembers())
            {
                this.reservedImportedTypeNames.Add(names.GetName(type));
            }
        }
    }

    /// <summary>
    /// Issue #3471: whether a bare identifier at file scope would bind to an
    /// import alias, an imported type, a synthesized type alias, or a
    /// source-declared top-level type of the same name. All of these shadow a
    /// sibling static member reference inside its declaring aggregate (imports
    /// and type names win over members in gsc scope resolution), so such
    /// members keep their type qualifier instead of printing bare.
    /// </summary>
    /// <param name="name">The emitted member simple name to probe.</param>
    /// <param name="context">The active translation context.</param>
    /// <returns><see langword="true"/> when the name is claimed at file scope.</returns>
    internal bool ClaimsDocumentScopeName(string name, TranslationContext context)
    {
        this.sourceDeclaredTypeNames ??= BuildSourceDeclaredTypeNames(
            context.Compilation,
            this.Names(context));
        return this.reservedTypeAliases.ContainsKey(name)
            || this.reservedImportedTypeNames.Contains(name)
            || this.synthesizedTypeAliases.ContainsKey(name)
            || this.sourceDeclaredTypeNames.Contains(name);
    }

    /// <summary>
    /// Maps an exact inferred contract while qualifying metadata homonyms
    /// reachable through the current file's imports.
    /// </summary>
    /// <typeparam name="T">The mapped result type.</typeparam>
    /// <param name="map">Mapping operation to run under collision qualification.</param>
    /// <returns>The mapped result.</returns>
    internal T WithMetadataImportCollisionQualification<T>(Func<T> map)
    {
        bool previous = this.qualifyMetadataImportCollisions;
        this.qualifyMetadataImportCollisions = true;
        try
        {
            return map();
        }
        finally
        {
            this.qualifyMetadataImportCollisions = previous;
        }
    }

    internal string GetOrCreateImportedTypeAlias(
        INamedTypeSymbol named,
        TranslationContext context,
        Location location)
        => this.GetOrCreateImportedTypeAlias(named, context, location, reuseOnly: false, precomputedTarget: null);

    internal string GetOrCreateImportedTypeAlias(
        INamedTypeSymbol named,
        TranslationContext context,
        Location location,
        bool reuseOnly,
        string precomputedTarget)
    {
        static bool HasVisibleSourceTypeName(
            string name,
            TranslationContext context,
            Location location)
        {
            if (location?.SourceTree == null)
            {
                return false;
            }

            int position = System.Math.Min(
                location.SourceSpan.Start,
                location.SourceTree.GetRoot().FullSpan.End - 1);
            SemanticModel semanticModel = ReferenceEquals(
                context.SemanticModel.SyntaxTree,
                location.SourceTree)
                    ? context.SemanticModel
                    : context.Compilation.GetSemanticModel(location.SourceTree);
            return semanticModel.LookupNamespacesAndTypes(position, name: name)
                .OfType<INamedTypeSymbol>()
                .Any(type => type.Locations.Any(candidate => candidate.IsInSource));
        }

        static bool HasVisibleCallableName(
            string name,
            TranslationContext context,
            Location location,
            EmittedNameAllocator names)
        {
            if (location?.SourceTree == null)
            {
                return false;
            }

            int position = System.Math.Min(
                location.SourceSpan.Start,
                location.SourceTree.GetRoot().FullSpan.End - 1);
            SemanticModel semanticModel = ReferenceEquals(
                context.SemanticModel.SyntaxTree,
                location.SourceTree)
                    ? context.SemanticModel
                    : context.Compilation.GetSemanticModel(location.SourceTree);
            return semanticModel.LookupSymbols(position)
                .OfType<IMethodSymbol>()
                .Any(method =>
                    method.MethodKind is MethodKind.Ordinary or MethodKind.ReducedExtension
                    && names.GetName(method) == name);
        }

        EmittedNameAllocator names = this.Names(context);
        string simpleName = this.Names(context).GetName(named);
        string namespaceName = named.ContainingNamespace is { IsGlobalNamespace: false } ns
            ? this.Names(context).GetNamespaceName(ns)
            : null;
        string target = precomputedTarget ?? (namespaceName != null
            ? $"{namespaceName}.{simpleName}"
            : simpleName);
        foreach (var reservedAlias in this.reservedTypeAliases)
        {
            if (reservedAlias.Value.Count == 1
                && reservedAlias.Value.Contains(target)
                && !this.reservedTypeParameterNames.Contains(reservedAlias.Key)
                && !this.reservedInvokedLocalNames.Contains(reservedAlias.Key)
                && !HasVisibleCallableName(reservedAlias.Key, context, location, names)
                && !HasVisibleSourceTypeName(reservedAlias.Key, context, location))
            {
                return reservedAlias.Key;
            }
        }

        foreach (var existing in this.synthesizedTypeAliases)
        {
            if (existing.Value == target
                && !this.reservedTypeParameterNames.Contains(existing.Key)
                && !this.reservedInvokedLocalNames.Contains(existing.Key)
                && !HasVisibleCallableName(existing.Key, context, location, names)
                && !HasVisibleSourceTypeName(existing.Key, context, location))
            {
                return existing.Key;
            }
        }

        if (reuseOnly)
        {
            return null;
        }

        this.sourceDeclaredTypeNames ??= BuildSourceDeclaredTypeNames(
            context.Compilation,
            this.Names(context));
        var reserved = new HashSet<string>(
            this.synthesizedTypeAliases.Keys,
            System.StringComparer.Ordinal);
        reserved.UnionWith(this.reservedTypeAliases.Keys);
        reserved.UnionWith(this.reservedImportedTypeNames);
        reserved.UnionWith(this.reservedTypeParameterNames);
        reserved.UnionWith(this.reservedInvokedLocalNames);
        reserved.UnionWith(this.sourceDeclaredTypeNames);
        reserved.UnionWith(this.reservedSiblingStaticMemberNames);

        string namespaceQualifier = namespaceName?.Split('.').Last() ?? "Global";
        string baseAlias = $"{namespaceQualifier}{simpleName}";
        string alias = baseAlias;
        for (var suffix = 2;
            reserved.Contains(alias)
                || HasVisibleCallableName(alias, context, location, names);
            suffix++)
        {
            alias = $"{baseAlias}_{suffix}";
        }

        this.synthesizedTypeAliases.Add(alias, target);
        return alias;
    }

    internal (NamedTypeReference Type, IReadOnlyList<IPropertySymbol> Properties) GetOrCreateAnonymousDataClassShape(
        INamedTypeSymbol anonymousType,
        TranslationContext context,
        Location location)
    {
        List<IPropertySymbol> properties = anonymousType.GetMembers().OfType<IPropertySymbol>().ToList();
        string shapeKey = string.Join(
            "|",
            properties.Select(p => p.Name + ":" + p.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));

        // A shape synthesized by an earlier file in the same package is reused
        // without redeclaration. A new shape gets the same deterministic name
        // in every document or project that translates it (#2598).
        if (this.anonymousTypeRegistry.TryGetExisting(shapeKey, out NamedTypeReference existing))
        {
            return (existing, properties);
        }

        string syntheticName = AnonymousTypeRegistry.SyntheticName(shapeKey, properties.Count);
        var parameters = properties
            .Select(p => new Cs2Gs.CodeModel.Ast.Parameter(
                this.Names(context).GetName(
                    p,
                    GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Parameter),
                this.Map(p.Type, context, location)))
            .ToList();

        context.Report(new TranslationDiagnostic(
            anonymousType.ToDisplayString(),
            $"C# anonymous type mapped to a synthesized G# 'data class {syntheticName}' preserving member names as primary-constructor parameters (issue #2282); supersedes the earlier name-dropping positional-tuple lowering (issue #1934) so named-member access ('x.{(properties.Count > 0 ? properties[0].Name : "Member")}') resolves.",
            location,
            TranslationSeverity.Info));

        var declaration = new TypeDeclaration(
            TypeDeclarationKind.DataClass,
            syntheticName,
            primaryConstructorParameters: parameters,
            visibility: Visibility.Internal);

        var reference = new NamedTypeReference(syntheticName);
        this.anonymousTypeRegistry.Register(shapeKey, reference);
        this.pendingAnonymousDataClasses.Add(declaration);
        return (reference, properties);
    }

    /// <summary>
    /// Issue #1894: whether <paramref name="type"/> is the BCL <c>System.Index</c>
    /// or <c>System.Range</c> struct — the two from-end-indexing value types that
    /// have no canonical G# representation (see <see cref="MapCore"/>).
    /// </summary>
    /// <param name="type">The C# type symbol to check.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> is <c>System.Index</c> or <c>System.Range</c>.</returns>
    internal static bool IsSystemIndexOrRange(ITypeSymbol type) =>
        type is INamedTypeSymbol { ContainingNamespace.Name: "System", ContainingNamespace.ContainingNamespace.IsGlobalNamespace: true } named
            && (named.Name == "Index" || named.Name == "Range");

    internal string LiftedNestedDelegateName(
        INamedTypeSymbol named,
        TranslationContext context)
    {
        var parts = new List<string>();
        for (INamedTypeSymbol current = named; current != null; current = current.ContainingType)
        {
            parts.Insert(0, this.Names(context).GetName(current));
        }

        return string.Join("_", parts);
    }

    /// <summary>
    /// Issue #2222: strips a leading `global::` alias-qualifier from a
    /// dotted namespace/type name (e.g. <c>using global::Foo.Bar;</c> yields
    /// <c>directive.Name.ToString()</c> == <c>"global::Foo.Bar"</c>).
    /// Splitting that text by <c>.</c> without stripping the prefix first
    /// silently fails to match any real namespace segment. Shared with
    /// <see cref="CSharpToGSharpTranslator.TranslateImports"/> so the
    /// synthesized `import` list and the homonym scan agree on the same
    /// name.
    /// </summary>
    /// <param name="name">The dotted namespace/type name text, possibly `global::`-prefixed.</param>
    /// <returns><paramref name="name"/> with any leading `global::` removed.</returns>
    internal static string StripGlobalPrefix(string name) =>
        name.StartsWith("global::", System.StringComparison.Ordinal) ? name.Substring("global::".Length) : name;

    internal GTypeReference MapTypeOf(ITypeSymbol type, TranslationContext context, Location location)
    {
        return IsSystemIndexOrRange(type)
            ? this.MapCore(type, context, location)
            : this.Map(type, context, location);
    }

    internal GTypeReference MapNominalDelegate(
        INamedTypeSymbol type,
        TranslationContext context,
        Location location)
    {
        return type.IsGenericType
            ? new NamedTypeReference(
                this.DelegateTypeName(type, context, location),
                type.TypeArguments.Select(argument => this.Map(argument, context, location)).ToList())
            : new NamedTypeReference(this.DelegateTypeName(type, context, location));
    }

    private static INamespaceSymbol GetExtensionMethodNamespace(IMethodSymbol method)
    {
        if (method is null)
        {
            return null;
        }

        // Reduced instance-form calls (key.All(predicate)) resolve to a
        // reduced symbol; unwrap it back to the original static-form method
        // so ContainingNamespace reflects the extension's declaring type.
        IMethodSymbol original = method.ReducedFrom ?? method;
        if (!original.IsExtensionMethod)
        {
            return null;
        }

        // C# 14 extension blocks compile their members onto a synthetic
        // marker type nested inside the containing type; unwrap to the
        // enclosing (real, declared) type so the namespace we record is the
        // one the user would actually need to import.
        INamedTypeSymbol containingType = original.ContainingType;
        if (containingType is { IsExtension: true } && containingType.ContainingType is { } declaringType)
        {
            containingType = declaringType;
        }

        return containingType?.ContainingNamespace is { IsGlobalNamespace: false } ns
            ? ns
            : null;
    }

    private static IReadOnlyDictionary<string, List<string>> BuildAnalyzerTargetTypeNames()
    {
        var targetNamespaces = new HashSet<string>(
            Analyzers.RoslynAnalyzerApiMap.EnumerateTargetNamespaces(),
            System.StringComparer.Ordinal);
        var result = targetNamespaces.ToDictionary(
            targetNamespace => targetNamespace,
            _ => new List<string>(),
            System.StringComparer.Ordinal);

        foreach (System.Type type in typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.GetTypes())
        {
            if (type.IsNested
                || !type.IsPublic
                || type.Namespace is not { } typeNamespace
                || !result.TryGetValue(typeNamespace, out var names))
            {
                continue;
            }

            string metadataName = type.Name;
            int arityMarker = metadataName.IndexOf('`');
            string simpleName = arityMarker >= 0
                ? metadataName.Substring(0, arityMarker)
                : metadataName;
            names.Add(
                GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts.GetEmittedIdentifier(
                    simpleName,
                    GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Type));
        }

        return result;
    }

    private string QualifiedAliasTarget(INamedTypeSymbol type)
    {
        if (this.nameAllocator is null)
        {
            return StripGlobalPrefix(
                type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));
        }

        var parts = new Stack<string>();
        INamedTypeSymbol outermost = type;
        for (INamedTypeSymbol current = type; current != null; current = current.ContainingType)
        {
            parts.Push(this.nameAllocator.GetName(current));
            outermost = current;
        }

        string typeName = string.Join(".", parts);
        return outermost.ContainingNamespace is { IsGlobalNamespace: false } ns
            ? $"{this.nameAllocator.GetNamespaceName(ns)}.{typeName}"
            : typeName;
    }

    private EmittedNameAllocator Names(TranslationContext context) =>
        this.nameAllocator ?? EmittedNameAllocator.For(context.Compilation);

    /// <summary>
    /// Issue #1906: maps a C# function-pointer type (<c>delegate*&lt;...&gt;</c>)
    /// to a G# function-pointer type. A plain <c>delegate*&lt;T, R&gt;</c> or an
    /// explicit <c>delegate* managed&lt;T, R&gt;</c> is the <b>default</b>
    /// (managed) calling convention (<see cref="SignatureCallingConvention.Default"/>)
    /// and maps to G#'s managed form <c>*func(T) R</c> (ADR-0122 §9). A
    /// <c>delegate* unmanaged[Cdecl]&lt;T, R&gt;</c> (and the three other named
    /// single conventions) maps to G#'s raw form <c>unmanaged[CC] (T) -&gt; R</c>
    /// (ADR-0095), whose <c>[CC]</c> slot only accepts one of the four fixed
    /// P/Invoke-style conventions. A bare <c>delegate* unmanaged&lt;T, R&gt;</c>
    /// (the platform-default ABI, which is Winapi/StdCall on Windows x86 and
    /// Cdecl elsewhere — genuinely platform-dependent, unlike the other four
    /// fixed conventions) and a combined/custom convention (e.g.
    /// <c>unmanaged[Cdecl, SuppressGCTransition]</c>) map to G#'s open
    /// calling-convention model (ADR-0095 v2 / issue #3611): bare
    /// <c>unmanaged (T) -&gt; R</c> and <c>unmanaged[Name, ...] (T) -&gt; R</c>
    /// respectively, with the <c>CallConv</c> short names in source order.
    /// </summary>
    /// <param name="type">The C# function-pointer type symbol.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>The mapped G# function-pointer type, or the placeholder for the two unrepresentable calling-convention sub-cases.</returns>
    private GTypeReference MapFunctionPointer(IFunctionPointerTypeSymbol type, TranslationContext context, Location location)
    {
        IMethodSymbol signature = type.Signature;
        var parameterTypes = signature.Parameters.Select(p => this.Map(p.Type, context, location)).ToList();
        GTypeReference returnType = signature.ReturnsVoid ? null : this.Map(signature.ReturnType, context, location);

        if (signature.CallingConvention == SignatureCallingConvention.Default)
        {
            return new FunctionPointerTypeReference(isManaged: true, default, parameterTypes, returnType);
        }

        CallingConvention? callingConvention = signature.CallingConvention switch
        {
            SignatureCallingConvention.CDecl => CallingConvention.Cdecl,
            SignatureCallingConvention.StdCall => CallingConvention.StdCall,
            SignatureCallingConvention.ThisCall => CallingConvention.ThisCall,
            SignatureCallingConvention.FastCall => CallingConvention.FastCall,
            SignatureCallingConvention.Unmanaged => MapSingleUnmanagedConvention(signature.UnmanagedCallingConventionTypes),
            _ => null,
        };

        if (callingConvention is { } resolved)
        {
            return new FunctionPointerTypeReference(isManaged: false, resolved, parameterTypes, returnType);
        }

        // ADR-0095 v2 / issue #3611: the two formerly by-design-gapped
        // shapes now map to G#'s open calling-convention model. A bare
        // `delegate* unmanaged<...>` (platform-default ABI, empty modopt
        // set) spells `unmanaged (T) -> R`; a combined or non-legacy
        // convention set spells `unmanaged[Name, ...] (T) -> R` with the
        // CallConv short names in source order — gsc encodes both
        // byte-identically to csc.
        if (signature.CallingConvention == SignatureCallingConvention.Unmanaged)
        {
            var conventionNames = signature.UnmanagedCallingConventionTypes
                .Select(conventionType => conventionType.Name.StartsWith("CallConv", StringComparison.Ordinal)
                    ? conventionType.Name.Substring("CallConv".Length)
                    : conventionType.Name)
                .ToList();
            return new FunctionPointerTypeReference(conventionNames, parameterTypes, returnType);
        }

        context.Report(new TranslationDiagnostic(
            "FunctionPointerType",
            $"unsafe function-pointer type '{type.ToDisplayString()}' has no canonical G# form: its calling convention '{signature.CallingConvention}' has no G# spelling (issue #1906).",
            location,
            TranslationSeverity.Unsupported)
        {
            Classification = UnsupportedClassification.ByDesign,
            Rationale = UnsupportedRationale.NoGsharpConstruct,
        });
        return new NamedTypeReference(UnsupportedPlaceholderType);
    }

    /// <summary>
    /// Resolves the single well-known unmanaged calling convention named in a
    /// generic <c>delegate* unmanaged[Name]&lt;...&gt;</c> modopt list (issue
    /// #1906), or <see langword="null"/> when the list is empty (bare
    /// <c>unmanaged</c>) or names anything other than exactly one of
    /// Cdecl/Stdcall/Thiscall/Fastcall.
    /// </summary>
    /// <param name="unmanagedCallingConventionTypes">The modopt types Roslyn resolved from the <c>[...]</c> list.</param>
    /// <returns>The matching <see cref="CallingConvention"/>, or <see langword="null"/> when none applies.</returns>
    private static CallingConvention? MapSingleUnmanagedConvention(ImmutableArray<INamedTypeSymbol> unmanagedCallingConventionTypes)
    {
        if (unmanagedCallingConventionTypes.Length != 1)
        {
            return null;
        }

        return unmanagedCallingConventionTypes[0].Name switch
        {
            "CallConvCdecl" => CallingConvention.Cdecl,
            "CallConvStdcall" => CallingConvention.StdCall,
            "CallConvThiscall" => CallingConvention.ThisCall,
            "CallConvFastcall" => CallingConvention.FastCall,
            _ => null,
        };
    }

    private static GTypeReference WithNullable(GTypeReference reference, bool isNullable)
    {
        switch (reference)
        {
            case NamedTypeReference named:
                return new NamedTypeReference(named.Name, named.TypeArguments, named.ContainingType)
                {
                    IsNullable = isNullable,
                };
            case ArrayTypeReference array:
                return new ArrayTypeReference(array.ElementType, array.Rank) { IsNullable = isNullable };
            case PointerTypeReference pointer:
                return new PointerTypeReference(pointer.ElementType) { IsNullable = isNullable };
            case TupleTypeReference tuple:
                return new TupleTypeReference(tuple.ElementTypes, tuple.ElementNames) { IsNullable = isNullable };
            case ArrowTypeReference arrow:
                return new ArrowTypeReference(arrow.ParameterTypes, arrow.ReturnTypes, arrow.IsAsync)
                {
                    IsNullable = isNullable,
                };
            default:
                return reference;
        }
    }

    private static string MapPredefinedName(SpecialType specialType)
    {
        switch (specialType)
        {
            case SpecialType.System_Boolean:
                return "bool";
            case SpecialType.System_Char:
                return "char";
            case SpecialType.System_SByte:
                return "int8";
            case SpecialType.System_Byte:
                return "uint8";
            case SpecialType.System_Int16:
                return "int16";
            case SpecialType.System_UInt16:
                return "uint16";
            case SpecialType.System_Int32:
                return "int32";
            case SpecialType.System_UInt32:
                return "uint32";
            case SpecialType.System_Int64:
                return "int64";
            case SpecialType.System_UInt64:
                return "uint64";
            case SpecialType.System_IntPtr:
                return "nint";
            case SpecialType.System_UIntPtr:
                return "nuint";
            case SpecialType.System_Single:
                return "float32";
            case SpecialType.System_Double:
                return "float64";
            case SpecialType.System_Decimal:
                return "decimal";
            case SpecialType.System_String:
                return "string";
            case SpecialType.System_Object:
                return "object";
            default:
                return null;
        }
    }

    private GTypeReference MapCore(ITypeSymbol type, TranslationContext context, Location location)
    {
        // Width-bearing primitive names (ADR-0115 §B.12).
        string predefined = MapPredefinedName(type.SpecialType);
        if (predefined != null)
        {
            return new NamedTypeReference(predefined);
        }

        if (type is IArrayTypeSymbol array)
        {
            return new ArrayTypeReference(this.Map(array.ElementType, context, location), array.Rank);
        }

        if (type is ITypeParameterSymbol typeParameter)
        {
            return new NamedTypeReference(this.Names(context).GetName(typeParameter));
        }

        if (type is INamedTypeSymbol named)
        {
            // Value tuples map to the native G# tuple type. ADR-0172: G#
            // now has named tuple elements, so C# element names are
            // PRESERVED name-first — `(int Line, int Column)` becomes
            // `(Line int32, Column int32)` — and named access stays by-name
            // at the use site (ADR-0115 §B.4 as amended). A default
            // positional name (`Item1` at position 1, …) counts as unnamed.
            if (named.IsTupleType)
            {
                List<GTypeReference> elementTypes = named.TupleElements
                    .Select(e => this.Map(e.Type, context, location))
                    .ToList();
                List<string> elementNames = named.TupleElements
                    .Select((e, i) => e.IsImplicitlyDeclared || e.Name == "Item" + (i + 1)
                        ? null
                        : e.Name)
                    .ToList();
                return new TupleTypeReference(elementTypes, elementNames);
            }

            // Issue #2282 (was #1934): an anonymous type (`new { A = 1, B = 2 }`)
            // maps to a synthesized, shape-deduplicated G# `data class` that
            // preserves member NAMES as primary-constructor parameters — see
            // <see cref="GetOrCreateAnonymousDataClass"/> for why the earlier
            // name-dropping positional-tuple lowering (issue #1934) was
            // insufficient (G# tuples have no named-element syntax) and why the
            // `object { }` anonymous-value literal (issue #2224) cannot replace
            // it either (no type-annotation spelling, so it cannot appear at a
            // TYPE position such as a lambda parameter whose type a generic
            // method infers from another lambda's anonymous-typed return
            // value).
            if (named.IsAnonymousType)
            {
                return this.GetOrCreateAnonymousDataClass(named, context, location);
            }

            // Delegate types (Func/Action/named delegates) render in arrow form
            // (ADR-0115 §B.8).
            //
            // Issue #2835: EXCEPT a delegate declared in the source being
            // translated. CLR delegates are nominally typed — structurally
            // equivalent delegates are not interchangeable — and cs2gs emits a
            // real `delegate X(…) ` declaration for every source;
            // delegate, so erasing its uses to `(string) -> void` (i.e.
            // `Action[string]`) makes the translated program fail at runtime the
            // moment a value crosses between the two spellings. This is the same
            // reasoning `MapEventType` already applies to an event's own handler
            // type, now extended to every type position. Imported/BCL delegates
            // keep the arrow form.
            //
            // Issue #3841: ALSO except an imported delegate whose identity is
            // load-bearing in this compilation — one that discriminates an
            // overload set the arrow form would collapse into a single G#
            // signature (`Add(Predicate<T>)` / `Add(Func<T, bool>)`, GS0264).
            // Scoped to the exact CONSTRUCTED delegate types involved, so every
            // other Func/Action keeps the arrow form. See
            // IsIdentityCriticalDelegate.
            if (named.TypeKind == TypeKind.Delegate && named.DelegateInvokeMethod != null)
            {
                if (IsSourceDeclaredDelegate(named) || this.IsIdentityCriticalDelegate(named, context))
                {
                    return named.IsGenericType
                        ? new NamedTypeReference(
                            this.DelegateTypeName(named, context, location),
                            named.TypeArguments.Select(a => this.Map(a, context, location)).ToList())
                        : new NamedTypeReference(this.DelegateTypeName(named, context, location));
                }

                return this.MapDelegate(named.DelegateInvokeMethod, context, location);
            }

            if (named.ContainingType != null
                && named.Name == "Builder"
                && named.ContainingType.OriginalDefinition.ToDisplayString()
                    == "System.Collections.Immutable.ImmutableArray<T>")
            {
                return new NamedTypeReference(
                    "Builder",
                    containingType: this.Map(
                        named.ContainingType,
                        context,
                        location));
            }

            if (HasGenericContainingType(named))
            {
                IReadOnlyList<ITypeSymbol> ownTypeArguments = named.Arity == 0
                    ? System.Array.Empty<ITypeSymbol>()
                    : named.TypeArguments.Skip(named.TypeArguments.Length - named.Arity).ToArray();
                List<GTypeReference> mappedOwnTypeArguments = ownTypeArguments
                    .Select(argument => this.Map(argument, context, location))
                    .ToList();

                // A source nested type used from inside its own generic
                // containing type remains directly in scope. Qualifying it
                // through Outer[T] makes gsc treat the inherited nested type
                // as an external constructed lookup and fail to resolve it.
                if (named.Locations.Any(candidate => candidate.IsInSource)
                    && !this.HasSourceHomonym(named, context)
                    && IsWithinContainingType(named, context, location))
                {
                    return new NamedTypeReference(
                        this.Names(context).GetName(named),
                        mappedOwnTypeArguments);
                }

                return new NamedTypeReference(
                    this.Names(context).GetName(named),
                    mappedOwnTypeArguments,
                    this.Map(named.ContainingType, context, location));
            }

            if (named.IsGenericType)
            {
                List<GTypeReference> args = named.TypeArguments
                    .Select(a => this.Map(a, context, location))
                    .ToList();
                return new NamedTypeReference(this.QualifiedTypeName(named, context, location), args);
            }

            return new NamedTypeReference(this.QualifiedTypeName(named, context, location));
        }

        return new NamedTypeReference(this.Names(context).GetName(type));
    }

    private string DelegateTypeName(
        INamedTypeSymbol named,
        TranslationContext context,
        Location location)
    {
        return IsSourceDeclaredDelegate(named) && named.ContainingType != null
            ? this.LiftedNestedDelegateName(named, context)
            : this.QualifiedTypeName(named, context, location);
    }

    private static bool HasGenericContainingType(INamedTypeSymbol named)
    {
        for (INamedTypeSymbol containing = named.ContainingType;
            containing != null;
            containing = containing.ContainingType)
        {
            if (containing.Arity > 0)
            {
                return true;
            }
        }

        return false;
    }

    // A nested type is referenced through its containing type(s)
    // (`ConfiguredTaskAwaitable.ConfiguredTaskAwaiter`); emitting the innermost
    // name alone makes the reference unresolvable. Walk the containing-type chain
    // and join with '.' so nested types stay qualified (ADR-0115 §B.12).
    //
    // Metadata (BCL/external) nested types are ALWAYS qualified. A source-declared
    // nested type is emitted by the translator as a directly-nested G# member and
    // is normally referenced by its simple name within the package. However, when
    // another source type shares its simple name (issue #1174 / #914: e.g. a
    // top-level `class SampleEntry` alongside `class SttsBox { data struct
    // SampleEntry(...) }`), the bare name binds to the homonym that holds the
    // simple key — so the nested type must be qualified `Container.Nested` to
    // resolve correctly. This is now safe to emit in every position (generic
    // arguments, type clauses, struct literals) thanks to the issue #1174
    // language fix, so the qualified form round-trips under gsc. Issue #2509
    // additionally prefixes the namespace when the OUTERMOST containing type
    // itself collides across imported packages.
    private string QualifiedTypeName(INamedTypeSymbol named, TranslationContext context, Location location)
    {
        // ADR-0169 analyzer translation mode: Microsoft.CodeAnalysis types are
        // rewritten to the G# analyzer API instead of passing through as
        // imported CLR types (the one place the passthrough rule is wrong).
        // Unmapped Roslyn types fail loudly as CS2GS-GAP; Adapted mappings
        // carry a CS2GS-ANALYZER-SHAPE review warning.
        if (this.AnalyzerApiMode
            && Analyzers.RoslynAnalyzerApiMap.IsRoslynNamespace(named.ContainingNamespace?.ToDisplayString()))
        {
            string roslynName = $"{named.ContainingNamespace.ToDisplayString()}.{named.Name}";
            if (Analyzers.RoslynAnalyzerApiMap.TryMapType(roslynName, out Analyzers.RoslynAnalyzerApiMap.Entry mapped))
            {
                if (!string.IsNullOrEmpty(mapped.GsNamespace))
                {
                    this.shortenedNamespaces.Add(mapped.GsNamespace);
                }

                if (mapped.AdaptationNote != null)
                {
                    context.Report(new TranslationDiagnostic(
                        "analyzer-api",
                        $"'{roslynName}' translated as '{mapped.GsNamespace}.{mapped.GsName}': {mapped.AdaptationNote}",
                        location,
                        TranslationSeverity.Warning)
                    {
                        DiagnosticId = "CS2GS-ANALYZER-SHAPE",
                    });
                }

                return mapped.GsName;
            }

            context.Report(new TranslationDiagnostic(
                "analyzer-api",
                $"Roslyn API type '{roslynName}' has no G# analyzer-API mapping (ADR-0169).",
                location));
            return this.Names(context).GetName(named);
        }

        if (named.ContainingType == null)
        {
            // Issue #3501: when the source file declares a `using Alias = …;`
            // for this exact type, render the ALIAS instead of shortening to
            // the bare name. The bare rendering forced a synthesized
            // whole-namespace import that could collide with another imported
            // namespace's simple names (EmittedNameAllocator's
            // `import GSharp.Core.CodeAnalysis.Syntax` made Roslyn's
            // `AssignmentExpressionSyntax`/`SyntaxKind` ambiguous, and gsc
            // silently bound the wrong one — surfacing as GS0532 on the
            // now-impossible patterns). The alias import is already emitted by
            // the ordinary using-directive translation, so the alias name
            // resolves without any synthesized namespace import.
            if (this.TryReuseSourceUsingAlias(named, context, location, out string sourceAlias))
            {
                return sourceAlias;
            }

            this.TrackShortenedNamespace(named);
            string simpleName = this.Names(context).GetName(named);
            bool visibleNestedHomonym = this.HasVisibleSourceNestedHomonym(
                named,
                context,
                location);
            if (IsDeclaredInContainingNamespace(named, context, location)
                && !visibleNestedHomonym)
            {
                return simpleName;
            }

            // Issue #2222: a bare top-level type name is ambiguous in G#'s flat
            // import scope when another top-level type of the SAME simple name
            // is reachable through this file's imports (a source homonym
            // anywhere in the compilation, per #1174's conservative census, OR a
            // distinct type of the same name sitting in one of the file's
            // actually-imported namespaces — including a referenced assembly,
            // i.e. a translated sibling project surfaced as a metadata
            // reference). Qualify source types with their namespace and alias
            // metadata types in that case so gsc binds the reference to the
            // right type instead of whichever homonym happens to resolve first.
            //
            // Issue #3554: the imported-namespace scan now runs for METADATA
            // types in ordinary positions too (previously constraint-mapping
            // only, #2509). The scan only fires when a DISTINCT same-named
            // type actually sits in another of this file's imported
            // namespaces, so common framework types still print bare; but a
            // genuine metadata/metadata collision — G#'s own
            // `GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts` referenced
            // fully-qualified in a file that also imports
            // `Microsoft.CodeAnalysis.CSharp` (Roslyn's `SyntaxFacts`) —
            // previously shortened to a bare name gsc silently bound to the
            // WRONG package (GS0159 "Cannot find function IsReservedIdentifier").
            bool isSourceType = named.Locations.Any(l => l.IsInSource);
            bool ambiguous = this.HasSourceHomonym(named, context)
                || visibleNestedHomonym
                || this.HasImportedNamespaceHomonym(named, context);
            if (!ambiguous)
            {
                return simpleName;
            }

            return this.AmbiguousTopLevelTypeName(
                named,
                simpleName,
                isSourceType,
                context,
                location);
        }

        // A source nested type may use its simple name only from inside its
        // containing type. External references still require `Outer.Nested`
        // even when no homonym exists.
        if (named.Locations.Any(l => l.IsInSource)
            && !this.HasSourceHomonym(named, context)
            && !this.HasSourceNestedHomonym(named, context)
            && !this.HasImportedNamespaceHomonym(named, context)
            && IsWithinContainingType(named, context, location))
        {
            return this.Names(context).GetName(named);
        }

        var parts = new List<string>();
        INamedTypeSymbol outermost = named;
        for (INamedTypeSymbol current = named; current != null; current = current.ContainingType)
        {
            parts.Insert(0, this.Names(context).GetName(current));
            outermost = current;
        }

        this.TrackShortenedNamespace(outermost);
        string nestedName = string.Join(".", parts);

        // Issue #3554: same unconditional imported-namespace scan as the
        // top-level branch above — the containing type of a nested reference
        // can collide across imported metadata namespaces just as easily.
        bool outermostAmbiguous = this.HasSourceHomonym(outermost, context)
            || this.HasVisibleSourceNestedHomonym(outermost, context, location)
            || this.HasImportedNamespaceHomonym(outermost, context);
        if (!outermostAmbiguous)
        {
            return nestedName;
        }

        parts[0] = this.AmbiguousTopLevelTypeName(
            outermost,
            parts[0],
            outermost.Locations.Any(candidate => candidate.IsInSource),
            context,
            location);
        return string.Join(".", parts);
    }

    private string AmbiguousTopLevelTypeName(
        INamedTypeSymbol named,
        string simpleName,
        bool isSourceType,
        TranslationContext context,
        Location location)
    {
        if ((!isSourceType && SupportsMetadataTypeAlias(named))
            || (isSourceType
                && named.ContainingNamespace is { IsGlobalNamespace: true }))
        {
            // ponytail: metadata aliases currently bind reliably for System.*;
            // source aliases also bind within the current compilation. Keep
            // other external metadata namespace-qualified until arbitrary CLR
            // alias imports bind.
            return this.GetOrCreateImportedTypeAlias(named, context, location);
        }

        return named.ContainingNamespace is { IsGlobalNamespace: false } containingNamespace
            ? $"{this.Names(context).GetNamespaceName(containingNamespace)}.{simpleName}"
            : simpleName;
    }

    private static bool IsDeclaredInContainingNamespace(
        INamedTypeSymbol named,
        TranslationContext context,
        Location location)
    {
        if (location?.SourceTree == null || named.ContainingNamespace is not { IsGlobalNamespace: false } containingNamespace)
        {
            return false;
        }

        int position = System.Math.Min(
            location.SourceSpan.Start,
            location.SourceTree.GetRoot().FullSpan.End - 1);
        INamespaceSymbol currentNamespace = context.SemanticModel
            .GetEnclosingSymbol(position)?
            .ContainingNamespace;
        return SymbolEqualityComparer.Default.Equals(currentNamespace, containingNamespace);
    }

    private static bool SupportsMetadataTypeAlias(INamedTypeSymbol named)
    {
        string namespaceName = named.ContainingNamespace?.ToDisplayString();
        return namespaceName == "System"
            || namespaceName?.StartsWith("System.", System.StringComparison.Ordinal) == true;
    }

    private static bool IsWithinContainingType(
        INamedTypeSymbol nestedType,
        TranslationContext context,
        Location location)
    {
        INamedTypeSymbol containingType = nestedType.ContainingType;
        if (containingType == null || location == null || !location.IsInSource)
        {
            return false;
        }

        ISymbol enclosing = context.SemanticModel.GetEnclosingSymbol(location.SourceSpan.Start);
        INamedTypeSymbol currentType = enclosing as INamedTypeSymbol ?? enclosing?.ContainingType;
        for (INamedTypeSymbol current = currentType; current != null; current = current.ContainingType)
        {
            if (SymbolEqualityComparer.Default.Equals(current, containingType))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2211: records <paramref name="outermostType"/>'s namespace as one
    /// this mapper shortened a reference into, so the translator can synthesize
    /// a matching <c>import</c> when no <c>using</c> directive already covers it
    /// (see <see cref="shortenedNamespaces"/>). The global namespace (no
    /// namespace at all) needs no import and is skipped.
    /// </summary>
    /// <param name="outermostType">The outermost containing type of the reference (itself, if not nested).</param>
    private void TrackShortenedNamespace(INamedTypeSymbol outermostType)
    {
        if (outermostType.ContainingNamespace is { IsGlobalNamespace: false } ns)
        {
            this.shortenedNamespaces.Add(
                this.nameAllocator?.GetNamespaceName(ns) ?? ns.ToDisplayString());
        }
    }

    /// <summary>
    /// Issue #1174: whether a source-declared top-level type shares the simple
    /// name of <paramref name="named"/>, making the bare name ambiguous in the
    /// flat G# package scope. Nested declarations are excluded from the census:
    /// they are reachable through their containing type, not through an import.
    /// The per-compilation simple-name census is built once and cached on this
    /// mapper instance.
    /// <para>
    /// Issue #3805: for a LINKED source the census runs over every compilation
    /// that compiles the file. The census counts PROJECT-REFERENCED types too
    /// (a project reference is a source-bearing compilation reference), so its
    /// answer follows the project's reference graph:
    /// <c>test/Interpreter.Tests</c> references the Repl and through it
    /// <c>GSharp.LanguageServer.Protocol.Diagnostic</c>, while
    /// <c>test/Core.Tests</c> and <c>tools/cs2gs/Cs2Gs.Tests</c> — which link
    /// the very same <c>test/Shared/EmittedOracle.cs</c> — do not. That made
    /// one lambda parameter print <c>GSharp.Core.CodeAnalysis.Diagnostic</c>
    /// in one project and <c>Diagnostic</c> in the others, and the repository
    /// mirror (one <c>.gs</c> per source file) rejected the divergence.
    /// </para>
    /// </summary>
    private bool HasSourceHomonym(INamedTypeSymbol named, TranslationContext context)
    {
        foreach (CSharpCompilation compilation in this.LinkedDocumentCompilations(context))
        {
            if (HasHomonym(
                this.SourceTopLevelSimpleNames(compilation),
                named,
                nested: false))
            {
                return true;
            }
        }

        return false;
    }

    private bool HasSourceNestedHomonym(INamedTypeSymbol named, TranslationContext context)
    {
        foreach (CSharpCompilation compilation in this.LinkedDocumentCompilations(context))
        {
            if (HasHomonym(
                this.SourceNestedSimpleNames(compilation),
                named,
                nested: true))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2307/#3805: whether <paramref name="census"/> holds a
    /// source-declared type of <paramref name="named"/>'s simple name that is
    /// not <paramref name="named"/> itself. Identity is compared by full name
    /// rather than by counting entries, so the answer is the same whichever
    /// compilation of a linked source asks it (symbols from two compilations
    /// are never reference-equal, and the same type is source-declared in one
    /// project's view and metadata in another's).
    /// </summary>
    /// <param name="census">One compilation's simple-name census.</param>
    /// <param name="named">The type whose bare name is being considered.</param>
    /// <param name="nested">Whether the census covers nested declarations.</param>
    /// <returns><see langword="true"/> when a distinct same-named declaration exists.</returns>
    private static bool HasHomonym(
        IReadOnlyDictionary<string, HashSet<string>> census,
        INamedTypeSymbol named,
        bool nested)
    {
        if (!census.TryGetValue(named.Name, out HashSet<string> declarations))
        {
            return false;
        }

        string self = (named.ContainingType != null) == nested
            ? named.OriginalDefinition.ToDisplayString()
            : null;
        foreach (string declaration in declarations)
        {
            if (declaration != self)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #3805: <paramref name="compilation"/>'s top-level source-declared
    /// type names, cached per compilation on this mapper (a linked source asks
    /// once per linking project, an ordinary file only once).
    /// </summary>
    /// <param name="compilation">The compilation to census.</param>
    /// <returns>Simple name to the full names declared under it.</returns>
    private IReadOnlyDictionary<string, HashSet<string>> SourceTopLevelSimpleNames(CSharpCompilation compilation)
    {
        this.sourceTopLevelSimpleNames ??= new Dictionary<CSharpCompilation, Dictionary<string, HashSet<string>>>();
        if (!this.sourceTopLevelSimpleNames.TryGetValue(compilation, out Dictionary<string, HashSet<string>> census))
        {
            census = BuildSourceSimpleNames(compilation, nested: false);
            this.sourceTopLevelSimpleNames[compilation] = census;
        }

        return census;
    }

    /// <summary>
    /// Issue #3805: <paramref name="compilation"/>'s NESTED source-declared
    /// type names, the nested-declaration counterpart of
    /// <see cref="SourceTopLevelSimpleNames"/>.
    /// </summary>
    /// <param name="compilation">The compilation to census.</param>
    /// <returns>Simple name to the full names declared under it.</returns>
    private IReadOnlyDictionary<string, HashSet<string>> SourceNestedSimpleNames(CSharpCompilation compilation)
    {
        this.sourceNestedSimpleNames ??= new Dictionary<CSharpCompilation, Dictionary<string, HashSet<string>>>();
        if (!this.sourceNestedSimpleNames.TryGetValue(compilation, out Dictionary<string, HashSet<string>> census))
        {
            census = BuildSourceSimpleNames(compilation, nested: true);
            this.sourceNestedSimpleNames[compilation] = census;
        }

        return census;
    }

    private bool HasVisibleSourceNestedHomonym(
        INamedTypeSymbol named,
        TranslationContext context,
        Location location)
    {
        if (location?.SourceTree == null)
        {
            return false;
        }

        int position = System.Math.Min(
            location.SourceSpan.Start,
            location.SourceTree.GetRoot().FullSpan.End - 1);

        // Issue #3805: for a LINKED source, ask every linking project's
        // semantic model — the same lexical position, its own parse of the
        // file — so the answer does not depend on which project is being
        // translated. A location in some OTHER file is only the current
        // compilation's business.
        foreach (SemanticModel semanticModel in this.LinkedDocumentModels(context, location.SourceTree))
        {
            foreach (ISymbol symbol in semanticModel.LookupNamespacesAndTypes(position, name: named.Name))
            {
                if (symbol is INamedTypeSymbol candidate
                    && candidate.Arity == named.Arity
                    && candidate.ContainingType != null
                    && candidate.Locations.Any(candidateLocation => candidateLocation.IsInSource)
                    && candidate.OriginalDefinition.ToDisplayString()
                        != named.OriginalDefinition.ToDisplayString())
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2222: whether a DIFFERENT top-level type sharing <paramref
    /// name="named"/>'s simple name is reachable through one of the current
    /// file's imported namespaces (its `using` directives plus its own
    /// declared namespace). Unlike <see cref="HasSourceHomonym"/>'s
    /// compilation-wide source-only census, this walks only the namespaces
    /// this file actually imports — cheap even when a referenced assembly
    /// (e.g. a translated sibling project) is huge — and covers a homonym
    /// declared in metadata rather than source. Issue #2509 extends this to a
    /// metadata type colliding with a different metadata type; symbols in the
    /// same namespace/package are not import collisions.
    /// </summary>
    private bool HasImportedNamespaceHomonym(INamedTypeSymbol named, TranslationContext context)
    {
        foreach (string namespaceName in this.GetImportedNamespaceNames(context))
        {
            // Issue #3805: for a LINKED source this scans every compilation
            // that compiles the file, not just the one being translated. The
            // mirror writes ONE .gs per source file, so the spelling chosen
            // here has to bind in every project that links it — and a rival
            // same-named type may sit in the reference set of only some of
            // them (`GSharp.LanguageServer.Protocol.Diagnostic` is visible to
            // test/Interpreter.Tests, which references the Repl, but not to
            // test/Compiler.Tests, which does not). Answering per-project made
            // test/Shared/EmittedOracle.cs translate two different ways and
            // fail the linked-source cross-check; answering over the union is
            // order-independent and safe in all of them.
            foreach (CSharpCompilation compilation in this.LinkedDocumentCompilations(context))
            {
                if (this.HasImportedNamespaceHomonym(named, compilation, namespaceName))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #3805: the single-compilation half of <see
    /// cref="HasImportedNamespaceHomonym(INamedTypeSymbol, TranslationContext)"/>
    /// — whether <paramref name="compilation"/> declares a DIFFERENT type of
    /// <paramref name="named"/>'s simple name in <paramref
    /// name="namespaceName"/>.
    /// </summary>
    /// <param name="named">The type whose bare name is being considered.</param>
    /// <param name="compilation">The compilation to resolve the namespace in.</param>
    /// <param name="namespaceName">An imported namespace name.</param>
    /// <returns><see langword="true"/> when a rival type of the same name and arity lives there.</returns>
    private bool HasImportedNamespaceHomonym(
        INamedTypeSymbol named,
        CSharpCompilation compilation,
        string namespaceName)
    {
        INamespaceSymbol candidateNamespace = ResolveNamespace(compilation, namespaceName);
        if (candidateNamespace is null)
        {
            return false;
        }

        // `named` may be a CONSTRUCTED generic (e.g. `Box<Label>`), while
        // `GetTypeMembers` always yields the unbound generic definition
        // (`Box<T>`). Comparing them directly makes every reference to a
        // constructed generic type look like a homonym of itself — compare
        // original definitions so `Box<Label>` correctly matches `Box<T>`.
        // Symbol identity only answers WITHIN one compilation; across the
        // linked-document set the namespace comparison below carries that
        // weight (the same type reached from two compilations has the same
        // containing namespace).
        foreach (INamedTypeSymbol candidate in candidateNamespace.GetTypeMembers(named.Name))
        {
            if (SymbolEqualityComparer.Default.Equals(candidate.OriginalDefinition, named.OriginalDefinition))
            {
                continue;
            }

            // Issue #3554 follow-up: an arity-differing pair
            // (System.Collections.IEnumerator vs
            // System.Collections.Generic.IEnumerator<T>) is not a G#
            // ambiguity — gsc disambiguates a bare name by its type-argument
            // count, exactly like the same-namespace
            // IComparable/IComparable<T> case filtered below.
            if (candidate.Arity != named.Arity)
            {
                continue;
            }

            // Types in the same namespace/package are not an import
            // collision. This also filters facade/implementation symbols
            // for the same forwarded metadata type, and same-namespace
            // generic-arity overloads such as IComparable/IComparable<T>
            // that the type arguments already disambiguate.
            if (candidate.ContainingNamespace?.ToDisplayString()
                == named.ContainingNamespace?.ToDisplayString())
            {
                continue;
            }

            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #2222: the namespace names in scope for the file backing <see
    /// cref="TranslationContext.SemanticModel"/> — every `using` directive
    /// (skipping aliased/`using static` ones, which do not bring a type's bare
    /// simple name into scope the same way), the file's own declared
    /// namespace, AND the namespace of every top-level type referenced
    /// anywhere in the file, even one reached only via full qualification
    /// with no matching `using`.
    /// <para>
    /// That last part fixes an ordering blindspot: <see
    /// cref="TrackShortenedNamespace"/> records EVERY top-level-type
    /// reference's namespace (not just qualified ones), and
    /// <c>CSharpToGSharpTranslator.Translate</c> synthesizes a matching
    /// `import` for any such namespace not already covered by an explicit
    /// `using`, once the WHOLE file has been visited. So a namespace reached
    /// only via full qualification (e.g. `new Oahu.Audible.Json.ChapterInfo()`
    /// with no `using Oahu.Audible.Json;`) still ends up in scope in the final
    /// G# output. But references are qualified in a single forward pass — an
    /// EARLIER reference (e.g. bare `book.ChapterInfo`) cannot see that a
    /// LATER reference's namespace will land in scope this way, so it would
    /// wrongly stay bare and become ambiguous. Pre-scanning the whole file's
    /// type references up front (this method) makes the ambiguity check see
    /// the same namespace set the file will actually end up importing,
    /// regardless of visit order.
    /// </para>
    /// <para>
    /// Issue #3725 closes the other half of that blindspot: a lambda parameter
    /// has NO name node at all in C#, yet cs2gs manufactures one, so its
    /// inferred type's namespaces are collected from the symbol instead of the
    /// syntax.
    /// </para>
    /// Cached per mapper instance: one mapper translates one file, so the
    /// import set never changes across calls.
    /// </summary>
    private HashSet<string> GetImportedNamespaceNames(TranslationContext context)
    {
        if (this.importedNamespaceNames != null)
        {
            return this.importedNamespaceNames;
        }

        // Issue #3805: a LINKED source is bound once per linking project, and
        // an inferred type (a lambda parameter, `var`) can name a namespace in
        // one project's binding that another project never sees. The import
        // set is therefore the UNION over the linking projects, so the
        // ambiguity answer — and the emitted spelling — is the same in all of
        // them.
        var names = new HashSet<string>();
        foreach (SemanticModel model in this.LinkedDocumentModels(context))
        {
            CollectImportedNamespaceNames(model, names);
        }

        this.importedNamespaceNames = names;
        return names;
    }

    /// <summary>
    /// Issue #2222: adds the namespace names in scope for <paramref
    /// name="semanticModel"/>'s file to <paramref name="names"/>. Split out of
    /// <see cref="GetImportedNamespaceNames"/> for issue #3805 so a linked
    /// source can union the answer over every project that compiles it.
    /// </summary>
    /// <param name="semanticModel">One project's semantic model for the file.</param>
    /// <param name="names">The namespace-name set to add to.</param>
    private static void CollectImportedNamespaceNames(SemanticModel semanticModel, HashSet<string> names)
    {
        if (semanticModel.SyntaxTree.GetRoot() is CompilationUnitSyntax root)
        {
            IEnumerable<UsingDirectiveSyntax> usings = root.Usings
                .Concat(root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>().SelectMany(n => n.Usings));
            foreach (UsingDirectiveSyntax directive in usings)
            {
                if (directive.Alias != null || !directive.StaticKeyword.IsKind(SyntaxKind.None) || directive.Name is null)
                {
                    continue;
                }

                names.Add(StripGlobalPrefix(directive.Name.ToString()));
            }

            foreach (BaseNamespaceDeclarationSyntax nsDecl in root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>())
            {
                names.Add(StripGlobalPrefix(nsDecl.Name.ToString()));
            }

            // Pre-scan every name/member-access node for a bound top-level-type
            // symbol, so a namespace reached only via full qualification (no
            // `using`) is already visible to the FIRST reference processed,
            // not just references processed after the synth-import-triggering
            // one (see the ordering note above).
            foreach (SyntaxNode node in root.DescendantNodes())
            {
                // Issue #3725: a lambda parameter is the one type position cs2gs
                // MANUFACTURES. C# infers it from the delegate target and writes
                // no name at all (`d => d.Message`), while the canonical G# arrow
                // lambda always spells it (ADR-0074), so `MapLambdaParameter`
                // maps the inferred symbol, `TrackShortenedNamespace` records its
                // namespace, and `Translate` synthesizes the matching `import` —
                // all without a single name node for the scan below to find.
                // Left out of this set, the homonym check cannot see that import:
                // two same-named types reached ONLY through inferred lambda
                // parameters both printed bare, and gsc's first-import-wins
                // resolution silently bound both to whichever landed first
                // (`GSharp.Core.CodeAnalysis.Diagnostic` shadowing
                // `GSharp.LanguageServer.Protocol.Diagnostic`, surfacing as
                // GS0159 on the enclosing generic call, never as an ambiguity).
                if (node is AnonymousFunctionExpressionSyntax lambda)
                {
                    foreach (ParameterSyntax parameter in EnumerateLambdaParameters(lambda))
                    {
                        if (semanticModel.GetDeclaredSymbol(parameter) is IParameterSymbol { Type: { } parameterType })
                        {
                            AddReferencedNamespaces(parameterType, names);
                        }
                    }

                    continue;
                }

                if (node is not (NameSyntax or MemberAccessExpressionSyntax))
                {
                    continue;
                }

                if (semanticModel.GetSymbolInfo(node).Symbol is not INamedTypeSymbol candidate)
                {
                    continue;
                }

                INamedTypeSymbol outermost = candidate;
                while (outermost.ContainingType != null)
                {
                    outermost = outermost.ContainingType;
                }

                if (outermost.ContainingNamespace is { IsGlobalNamespace: false } ns)
                {
                    names.Add(ns.ToDisplayString());
                }
            }
        }
    }

    /// <summary>
    /// Issue #3805: one semantic model of the file being translated per
    /// repository compilation that COMPILES it — normally just the context's
    /// own, but a LINKED source (<c>test/Shared/*.cs</c>, compiled into
    /// several projects) yields one per linking project.
    /// <para>
    /// The repository mirror writes ONE <c>.gs</c> per source file and
    /// cross-checks that every project translates a linked file identically,
    /// so any decision that can differ between those projects has to be
    /// answered over the WHOLE set, converged and order-independent — the same
    /// rule the shared-document nullability taint already follows (issue
    /// #3501). Trees are matched by file path because each compilation parses
    /// the linked file into its own <see cref="SyntaxTree"/> instance.
    /// </para>
    /// </summary>
    /// <param name="context">The translation context.</param>
    /// <returns>The semantic models, the context's own first.</returns>
    private IReadOnlyList<SemanticModel> LinkedDocumentModels(TranslationContext context)
        => this.LinkedDocumentModels(context, context.SemanticModel.SyntaxTree);

    /// <summary>
    /// Issue #3805: <see cref="LinkedDocumentModels(TranslationContext)"/> for
    /// a specific tree — a type reference's location is not always in the
    /// document the context currently points at.
    /// </summary>
    /// <param name="context">The translation context.</param>
    /// <param name="tree">The tree to find linking projects for.</param>
    /// <returns>The semantic models, this compilation's own first.</returns>
    private IReadOnlyList<SemanticModel> LinkedDocumentModels(TranslationContext context, SyntaxTree tree)
    {
        this.linkedDocumentModels ??= new Dictionary<SyntaxTree, IReadOnlyList<SemanticModel>>();
        if (this.linkedDocumentModels.TryGetValue(tree, out IReadOnlyList<SemanticModel> cached))
        {
            return cached;
        }

        var models = new List<SemanticModel>
        {
            ReferenceEquals(context.SemanticModel.SyntaxTree, tree)
                ? context.SemanticModel
                : context.Compilation.GetSemanticModel(tree),
        };
        string path = tree.FilePath;
        if (!string.IsNullOrEmpty(path)
            && context.RepositoryCompilations is { Count: > 1 } repository
            && LinkedDocumentIndex(repository).TryGetValue(path, out List<(CSharpCompilation Compilation, SyntaxTree Tree)> linking))
        {
            // The same path is not automatically the same FILE: a project can
            // feed a generated document, or a differently-preprocessed parse,
            // through a path another project also uses. Only an identical
            // parse is the same linked source, and only identical text keeps
            // the position-based lookups below meaningful across compilations.
            Microsoft.CodeAnalysis.Text.SourceText text = tree.GetText();
            foreach ((CSharpCompilation compilation, SyntaxTree linkedTree) in linking)
            {
                if (!ReferenceEquals(linkedTree, tree)
                    && !ReferenceEquals(compilation, context.Compilation)
                    && linkedTree.GetText().ContentEquals(text))
                {
                    models.Add(compilation.GetSemanticModel(linkedTree));
                }
            }
        }

        this.linkedDocumentModels[tree] = models;
        return models;
    }

    /// <summary>
    /// Issue #3805: the repository's linked sources — every file path parsed
    /// by MORE THAN ONE repository compilation, with the compilations (and
    /// their own parse of the file) that share it. Ordinary files are absent,
    /// which is what keeps the union lookup free for them.
    /// <para>
    /// Built once per repository compilation set rather than once per
    /// translated document: the index is a whole-run property, and one mapper
    /// exists per file.
    /// </para>
    /// </summary>
    /// <param name="repository">The run's repository compilations.</param>
    /// <returns>The linked-source index, keyed by file path.</returns>
    private static Dictionary<string, List<(CSharpCompilation Compilation, SyntaxTree Tree)>> LinkedDocumentIndex(
        IReadOnlyList<CSharpCompilation> repository)
        => LinkedDocumentIndexes.GetValue(repository, static key => BuildLinkedDocumentIndex((IReadOnlyList<CSharpCompilation>)key));

    private static Dictionary<string, List<(CSharpCompilation Compilation, SyntaxTree Tree)>> BuildLinkedDocumentIndex(
        IReadOnlyList<CSharpCompilation> repository)
    {
        var byPath = new Dictionary<string, List<(CSharpCompilation Compilation, SyntaxTree Tree)>>(
            System.StringComparer.OrdinalIgnoreCase);
        foreach (CSharpCompilation compilation in repository)
        {
            foreach (SyntaxTree tree in compilation.SyntaxTrees)
            {
                if (string.IsNullOrEmpty(tree.FilePath))
                {
                    continue;
                }

                if (!byPath.TryGetValue(tree.FilePath, out List<(CSharpCompilation, SyntaxTree)> linking))
                {
                    linking = new List<(CSharpCompilation, SyntaxTree)>();
                    byPath[tree.FilePath] = linking;
                }

                linking.Add((compilation, tree));
            }
        }

        foreach (string path in byPath.Where(entry => entry.Value.Count < 2).Select(entry => entry.Key).ToList())
        {
            byPath.Remove(path);
        }

        return byPath;
    }

    /// <summary>
    /// Issue #3805: the compilations behind <see cref="LinkedDocumentModels(TranslationContext)"/>.
    /// </summary>
    /// <param name="context">The translation context.</param>
    /// <returns>The compilations that compile the file being translated.</returns>
    private IEnumerable<CSharpCompilation> LinkedDocumentCompilations(TranslationContext context)
        => this.LinkedDocumentModels(context).Select(model => (CSharpCompilation)model.Compilation);

    /// <summary>
    /// Issue #3725: the parameters an anonymous function declares, whatever
    /// spelling it uses. A simple lambda (<c>d =&gt; …</c>) carries one bare
    /// parameter with no list; parenthesized lambdas and anonymous methods
    /// carry a (possibly absent) list.
    /// </summary>
    /// <param name="lambda">The anonymous function to inspect.</param>
    /// <returns>The declared parameter syntax nodes.</returns>
    private static IEnumerable<ParameterSyntax> EnumerateLambdaParameters(AnonymousFunctionExpressionSyntax lambda)
        => lambda switch
        {
            SimpleLambdaExpressionSyntax simple => new[] { simple.Parameter },
            ParenthesizedLambdaExpressionSyntax parenthesized =>
                (IEnumerable<ParameterSyntax>)parenthesized.ParameterList.Parameters,
            AnonymousMethodExpressionSyntax anonymousMethod when anonymousMethod.ParameterList != null =>
                anonymousMethod.ParameterList.Parameters,
            _ => System.Array.Empty<ParameterSyntax>(),
        };

    /// <summary>
    /// Issue #3725: records the namespace of every top-level named type
    /// <paramref name="type"/> is spelled out of — itself, its enclosing
    /// type chain, its type arguments, and the element type of an array or
    /// pointer. An inferred lambda-parameter type has no name nodes of its
    /// own, so its constituents are unreachable from the syntactic scan and
    /// have to be walked here instead.
    /// </summary>
    /// <param name="type">The type to walk.</param>
    /// <param name="names">The namespace-name set to add to.</param>
    private static void AddReferencedNamespaces(ITypeSymbol type, HashSet<string> names)
    {
        switch (type)
        {
            case IArrayTypeSymbol array:
                AddReferencedNamespaces(array.ElementType, names);
                return;

            case IPointerTypeSymbol pointer:
                AddReferencedNamespaces(pointer.PointedAtType, names);
                return;

            case INamedTypeSymbol named:
                INamedTypeSymbol outermost = named;
                while (outermost.ContainingType != null)
                {
                    outermost = outermost.ContainingType;
                }

                if (outermost.ContainingNamespace is { IsGlobalNamespace: false } ns)
                {
                    names.Add(ns.ToDisplayString());
                }

                foreach (ITypeSymbol argument in named.TypeArguments)
                {
                    AddReferencedNamespaces(argument, names);
                }

                return;

            default:
                return;
        }
    }

    private static INamespaceSymbol ResolveNamespace(Compilation compilation, string dottedName)
    {
        INamespaceSymbol current = compilation.GlobalNamespace;
        foreach (string part in StripGlobalPrefix(dottedName).Split('.'))
        {
            current = current.GetNamespaceMembers().FirstOrDefault(n => n.Name == part);
            if (current is null)
            {
                return null;
            }
        }

        return current;
    }

    private static INamespaceSymbol ResolveEmittedNamespace(
        Compilation compilation,
        string dottedName,
        EmittedNameAllocator names)
    {
        INamespaceSymbol current = compilation.GlobalNamespace;
        foreach (string part in StripGlobalPrefix(dottedName).Split('.'))
        {
            current = current.GetNamespaceMembers()
                .FirstOrDefault(candidate => names.GetName(candidate) == part);
            if (current is null)
            {
                return null;
            }
        }

        return current;
    }

    /// <summary>
    /// Issue #1174/#3805: <paramref name="compilation"/>'s source-declared
    /// type names, simple name to the set of full names declared under it.
    /// Recording full names rather than a count (the pre-#3805 shape) is what
    /// lets a linked source ask the same question of several compilations: a
    /// type is identified by what it IS, not by how many entries a particular
    /// compilation contributed.
    /// </summary>
    /// <param name="compilation">The compilation to census.</param>
    /// <param name="nested">Census nested declarations instead of top-level ones.</param>
    /// <returns>Simple name to the full names declared under it.</returns>
    private static Dictionary<string, HashSet<string>> BuildSourceSimpleNames(
        Compilation compilation,
        bool nested)
    {
        var names = new Dictionary<string, HashSet<string>>();
        foreach (INamedTypeSymbol type in EnumerateAllNamedTypes(compilation.GlobalNamespace))
        {
            if ((type.ContainingType != null) != nested
                || !type.Locations.Any(location => location.IsInSource))
            {
                continue;
            }

            if (!names.TryGetValue(type.Name, out HashSet<string> declarations))
            {
                declarations = new HashSet<string>(System.StringComparer.Ordinal);
                names[type.Name] = declarations;
            }

            declarations.Add(type.OriginalDefinition.ToDisplayString());
        }

        return names;
    }

    private static HashSet<string> BuildSourceDeclaredTypeNames(
        Compilation compilation,
        EmittedNameAllocator names) =>
        EnumerateAllNamedTypes(compilation.GlobalNamespace)
            .Where(type => type.Locations.Any(location => location.IsInSource))
            .Select(type => names.GetName(type))
            .ToHashSet(System.StringComparer.Ordinal);

    private static IEnumerable<INamedTypeSymbol> EnumerateAllNamedTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers())
        {
            if (member is INamespaceSymbol childNs)
            {
                foreach (var nested in EnumerateAllNamedTypes(childNs))
                {
                    yield return nested;
                }
            }
            else if (member is INamedTypeSymbol type)
            {
                foreach (var nested in EnumerateNamedTypeAndNested(type))
                {
                    yield return nested;
                }
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateNamedTypeAndNested(INamedTypeSymbol type)
    {
        yield return type;
        foreach (var nested in type.GetTypeMembers())
        {
            foreach (var deeper in EnumerateNamedTypeAndNested(nested))
            {
                yield return deeper;
            }
        }
    }

    /// <summary>
    /// Issue #2835: whether <paramref name="named"/> is a delegate type declared
    /// in the compilation being translated (as opposed to an imported/BCL
    /// delegate such as <c>Func</c>/<c>Action</c>). Source delegates are emitted
    /// by cs2gs as real <c>delegate X(…) </c> declarations, so their;
    /// uses must keep the nominal name to preserve CLR delegate identity.
    /// </summary>
    /// <param name="named">The candidate delegate type.</param>
    /// <returns><see langword="true"/> when the delegate is source-declared.</returns>
    private static bool IsSourceDeclaredDelegate(INamedTypeSymbol named)
    {
        INamedTypeSymbol definition = named.OriginalDefinition ?? named;
        return definition.Locations.Any(l => l.IsInSource);
    }

    /// <summary>
    /// Issue #3841: whether <paramref name="named"/> is a delegate type whose
    /// IDENTITY is load-bearing somewhere in the compilation being translated,
    /// i.e. it appears in a parameter position of an overload set that would
    /// otherwise erase to one G# signature (<c>Add(Predicate&lt;T&gt;)</c> /
    /// <c>Add(Func&lt;T, bool&gt;)</c>). Such a delegate keeps its nominal name
    /// in EVERY type position within that compilation.
    /// <para>
    /// The set is keyed on the CONSTRUCTED type, not the definition: a
    /// compilation with a colliding <c>Func&lt;int, bool&gt;</c> overload keeps
    /// <c>Func[int32, bool]</c> nominal, while every other <c>Func</c>
    /// instantiation in that same compilation still renders in ADR-0115 §B.8
    /// arrow form. That is what keeps this from being a corpus-wide
    /// readability regression.
    /// </para>
    /// <para>
    /// The whole compilation is in scope (not just the colliding declarations)
    /// because the identity has to survive on the VALUE side too. Fixing only
    /// the declarations turns "does not compile (GS0264)" into "compiles and
    /// reaches the wrong overload": a local written
    /// <c>Predicate&lt;int&gt; p = Always;</c> that erased to
    /// <c>(int32) -&gt; bool</c> makes gsc pick the <c>Func</c> member for both
    /// calls — verified by the executing regression test.
    /// </para>
    /// </summary>
    /// <param name="named">The candidate delegate type.</param>
    /// <param name="context">The translation context that owns the compilation.</param>
    /// <returns><see langword="true"/> when the delegate's identity is load-bearing.</returns>
    private bool IsIdentityCriticalDelegate(INamedTypeSymbol named, TranslationContext context)
    {
        if (context?.Compilation == null)
        {
            return false;
        }

        if (!ReferenceEquals(this.identityCriticalDelegatesCompilation, context.Compilation))
        {
            this.identityCriticalDelegatesCompilation = context.Compilation;
            this.identityCriticalDelegates = CollectIdentityCriticalDelegates(context.Compilation);
        }

        return this.identityCriticalDelegates.Contains(named);
    }

    /// <summary>
    /// Issue #3841: walks every type declared in <paramref name="compilation"/>
    /// and collects the delegate types that discriminate an otherwise-colliding
    /// overload set. See <see cref="IsIdentityCriticalDelegate"/>.
    /// </summary>
    /// <param name="compilation">The compilation being translated.</param>
    /// <returns>The constructed delegate types whose identity must be preserved.</returns>
    private static HashSet<INamedTypeSymbol> CollectIdentityCriticalDelegates(Compilation compilation)
    {
        var critical = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        var pending = new Stack<INamespaceOrTypeSymbol>();
        pending.Push(compilation.Assembly.GlobalNamespace);
        while (pending.Count > 0)
        {
            INamespaceOrTypeSymbol current = pending.Pop();
            foreach (ISymbol member in current.GetMembers())
            {
                if (member is INamespaceOrTypeSymbol nested and (INamespaceSymbol or INamedTypeSymbol))
                {
                    pending.Push(nested);
                }
            }

            if (current is INamedTypeSymbol type)
            {
                CollectIdentityCriticalDelegates(type, critical);
            }
        }

        return critical;
    }

    /// <summary>
    /// Issue #3841: adds <paramref name="type"/>'s erasure-colliding delegate
    /// parameter types to <paramref name="critical"/>.
    /// </summary>
    /// <param name="type">The declared type to inspect.</param>
    /// <param name="critical">The accumulating set.</param>
    private static void CollectIdentityCriticalDelegates(
        INamedTypeSymbol type,
        HashSet<INamedTypeSymbol> critical)
    {
        // Only same-name members can be an overload set, so the quadratic
        // comparison below runs per NAME rather than per type — a type with
        // hundreds of distinctly-named members costs nothing here.
        var byName = new Dictionary<string, List<IMethodSymbol>>(StringComparer.Ordinal);
        foreach (ISymbol member in type.GetMembers())
        {
            if (member is IMethodSymbol method && method.Parameters.Length > 0)
            {
                if (!byName.TryGetValue(method.Name, out List<IMethodSymbol> bucket))
                {
                    bucket = new List<IMethodSymbol>();
                    byName[method.Name] = bucket;
                }

                bucket.Add(method);
            }
        }

        foreach (List<IMethodSymbol> overloads in byName.Values)
        {
            if (overloads.Count < 2)
            {
                continue;
            }

            for (var i = 0; i < overloads.Count; i++)
            {
                for (var j = i + 1; j < overloads.Count; j++)
                {
                    IMethodSymbol left = overloads[i];
                    IMethodSymbol right = overloads[j];
                    if (left.MethodKind != right.MethodKind
                        || left.Arity != right.Arity
                        || left.Parameters.Length != right.Parameters.Length
                        || !ParametersEraseAlike(left, right))
                    {
                        continue;
                    }

                    for (var k = 0; k < left.Parameters.Length; k++)
                    {
                        AddIfDistinctDelegates(left.Parameters[k].Type, right.Parameters[k].Type, critical);
                    }
                }
            }
        }
    }

    /// <summary>
    /// Issue #3841: records a pair of DISTINCT delegate types that erase to the
    /// same arrow. Positions where the two overloads agree exactly carry no
    /// identity burden and are left alone.
    /// </summary>
    /// <param name="left">The first overload's parameter type.</param>
    /// <param name="right">The second overload's parameter type.</param>
    /// <param name="critical">The accumulating set.</param>
    private static void AddIfDistinctDelegates(
        ITypeSymbol left,
        ITypeSymbol right,
        HashSet<INamedTypeSymbol> critical)
    {
        if (SymbolEqualityComparer.Default.Equals(left, right)
            || left is not INamedTypeSymbol { TypeKind: TypeKind.Delegate } leftDelegate
            || right is not INamedTypeSymbol { TypeKind: TypeKind.Delegate } rightDelegate)
        {
            return;
        }

        critical.Add(leftDelegate);
        critical.Add(rightDelegate);
    }

    /// <summary>
    /// Issue #3841: whether two same-name, same-arity members' parameter lists
    /// print identically in G# once delegate types are erased to arrow form.
    /// </summary>
    /// <param name="left">The first member.</param>
    /// <param name="right">The second member.</param>
    /// <returns><see langword="true"/> when the two erase to one signature.</returns>
    private static bool ParametersEraseAlike(IMethodSymbol left, IMethodSymbol right)
    {
        var sawDelegateDifference = false;
        for (var i = 0; i < left.Parameters.Length; i++)
        {
            IParameterSymbol a = left.Parameters[i];
            IParameterSymbol b = right.Parameters[i];
            if (a.RefKind != b.RefKind
                || a.IsParams != b.IsParams
                || !TypesEraseAlike(a.Type, b.Type))
            {
                return false;
            }

            sawDelegateDifference |= !SymbolEqualityComparer.Default.Equals(a.Type, b.Type);
        }

        // Two members that agree at every position are not an overload set at
        // all (C# would have rejected them); only a difference that erasure
        // hides makes this collision cs2gs's to repair.
        return sawDelegateDifference;
    }

    /// <summary>
    /// Issue #3841: whether two C# types render as the SAME G# type once
    /// delegate types are erased to their arrow form. Identical types trivially
    /// qualify; two distinct delegate types qualify when their invoke
    /// signatures agree position by position (this is exactly what
    /// <see cref="MapDelegate"/> prints), which is how <c>Predicate&lt;T&gt;</c>
    /// and <c>Func&lt;T, bool&gt;</c> collide.
    /// </summary>
    /// <param name="left">The first type.</param>
    /// <param name="right">The second type.</param>
    /// <returns><see langword="true"/> when both erase to one G# spelling.</returns>
    private static bool TypesEraseAlike(ITypeSymbol left, ITypeSymbol right)
    {
        if (SymbolEqualityComparer.Default.Equals(left, right))
        {
            return true;
        }

        if (left is not INamedTypeSymbol { TypeKind: TypeKind.Delegate, DelegateInvokeMethod: not null } leftDelegate
            || right is not INamedTypeSymbol { TypeKind: TypeKind.Delegate, DelegateInvokeMethod: not null } rightDelegate)
        {
            return false;
        }

        IMethodSymbol leftInvoke = leftDelegate.DelegateInvokeMethod;
        IMethodSymbol rightInvoke = rightDelegate.DelegateInvokeMethod;
        if (leftInvoke.Parameters.Length != rightInvoke.Parameters.Length
            || !TypesEraseAlike(leftInvoke.ReturnType, rightInvoke.ReturnType))
        {
            return false;
        }

        for (var i = 0; i < leftInvoke.Parameters.Length; i++)
        {
            if (leftInvoke.Parameters[i].RefKind != rightInvoke.Parameters[i].RefKind
                || !TypesEraseAlike(leftInvoke.Parameters[i].Type, rightInvoke.Parameters[i].Type))
            {
                return false;
            }
        }

        return true;
    }

    private ArrowTypeReference MapDelegate(IMethodSymbol invoke, TranslationContext context, Location location)
    {
        List<GTypeReference> parameters = invoke.Parameters
            .Select(p => this.Map(p.Type, context, location))
            .ToList();

        ITypeSymbol declaredReturnType = invoke.ReturnType;
        ITypeSymbol returnType = declaredReturnType;
        bool isAsync = false;

        // A delegate returning Task / Task<T> maps to the async arrow form
        // (ADR-0115 §B.8): async () -> void / async () -> T.
        if (returnType is INamedTypeSymbol returnNamed &&
            returnNamed.Name == "Task" &&
            returnNamed.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
        {
            isAsync = true;
            returnType = returnNamed.IsGenericType ? returnNamed.TypeArguments[0] : null;
        }

        var returns = new List<GTypeReference>();
        if (returnType != null && returnType.SpecialType != SpecialType.System_Void)
        {
            GTypeReference mappedReturn = this.Map(returnType, context, location);

            // Issue #2504: every structural projection of a source named
            // delegate must consume the same Invoke-return taint as the named
            // declaration itself. Task<T> arrows expose the unwrapped T result;
            // ValueTask<T> remains an explicit envelope in the existing mapper,
            // so promote its inner result in place.
            if (declaredReturnType is INamedTypeSymbol { IsGenericType: true, TypeArguments.Length: 1 } taskLike
                && taskLike.Name == "ValueTask"
                && taskLike.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks"
                && mappedReturn is NamedTypeReference { TypeArguments.Count: 1 } valueTaskMapped)
            {
                GTypeReference promotedInner = this.PromoteDelegateReturnPosition(
                    valueTaskMapped.TypeArguments[0],
                    taskLike.TypeArguments[0],
                    invoke,
                    context,
                    new List<int>());
                mappedReturn = ReferenceEquals(promotedInner, valueTaskMapped.TypeArguments[0])
                    ? mappedReturn
                    : new NamedTypeReference(valueTaskMapped.Name, new[] { promotedInner });
            }
            else
            {
                mappedReturn = this.PromoteDelegateReturnPosition(
                    mappedReturn,
                    returnType,
                    invoke,
                    context,
                    new List<int>());
            }

            returns.Add(mappedReturn);
        }

        return new ArrowTypeReference(parameters, returns, isAsync);
    }

    private GTypeReference PromoteDelegateReturnPosition(
        GTypeReference mapped,
        ITypeSymbol returnType,
        IMethodSymbol invoke,
        TranslationContext context,
        List<int> tuplePath)
    {
        if (context.Compilation.Options.NullableContextOptions != NullableContextOptions.Disable)
        {
            return mapped;
        }

        if (mapped is TupleTypeReference mappedTuple
            && returnType is INamedTypeSymbol { IsTupleType: true } tupleType
            && mappedTuple.ElementTypes.Count == tupleType.TupleElements.Length)
        {
            bool changed = false;
            var elements = new List<GTypeReference>(mappedTuple.ElementTypes.Count);
            for (int index = 0; index < mappedTuple.ElementTypes.Count; index++)
            {
                tuplePath.Add(index);
                GTypeReference element = this.PromoteDelegateReturnPosition(
                    mappedTuple.ElementTypes[index],
                    tupleType.TupleElements[index].Type,
                    invoke,
                    context,
                    tuplePath);
                tuplePath.RemoveAt(tuplePath.Count - 1);
                changed |= !ReferenceEquals(element, mappedTuple.ElementTypes[index]);
                elements.Add(element);
            }

            return changed
                ? new TupleTypeReference(elements, mappedTuple.ElementNames) { IsNullable = mappedTuple.IsNullable }
                : mapped;
        }

        bool tainted = tuplePath.Count == 0
            ? ObliviousNullabilityAnalyzer.IsTainted(
                context.Compilation,
                invoke,
                context.SiblingCompilations)
            : ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                context.Compilation,
                invoke,
                tuplePath,
                context.SiblingCompilations);

        return tainted
            && !mapped.IsNullable
            && returnType is { IsReferenceType: true }
            && returnType.NullableAnnotation != NullableAnnotation.Annotated
                ? WithNullable(mapped, true)
                : mapped;
    }

    /// <summary>
    /// Issue #3501: when the source file declares a `using Alias = Type;` for
    /// the exact NON-GENERIC top-level type being rendered, reuse that alias
    /// instead of shortening to the bare name — the bare rendering forces a
    /// synthesized whole-namespace import that can make OTHER simple names
    /// ambiguous across imports (EmittedNameAllocator's synthesized
    /// `import GSharp.Core.CodeAnalysis.Syntax` made Roslyn's
    /// `AssignmentExpressionSyntax`/`SyntaxKind` resolve to the wrong package,
    /// surfacing as GS0532 on the now-impossible patterns). Reuses the same
    /// uniqueness and shadowing gates as <see cref="GetOrCreateImportedTypeAlias(INamedTypeSymbol, TranslationContext, Location)"/>
    /// (#3466), and generic targets are excluded so constructed spellings keep
    /// their explicit type arguments (#2500).
    /// </summary>
    /// <param name="named">The referenced top-level type.</param>
    /// <param name="context">The active translation context.</param>
    /// <param name="location">The reference location (shadowing probes).</param>
    /// <param name="aliasName">The reusable alias identifier, when one applies.</param>
    /// <returns><see langword="true"/> when a source alias can be reused.</returns>
    private bool TryReuseSourceUsingAlias(
        INamedTypeSymbol named,
        TranslationContext context,
        Location location,
        out string aliasName)
    {
        aliasName = null;

        // Constraint mapping (issue #2509, WithMetadataImportCollisionQualification)
        // demands the EXACT qualified semantic identity — a homonym-safe
        // `A.IContract` — never an alias spelling, so alias reuse is skipped
        // there.
        if (named.Arity != 0 || this.reservedTypeAliases.Count == 0 || this.qualifyMetadataImportCollisions)
        {
            return false;
        }

        string simpleName = this.Names(context).GetName(named);
        string namespaceName = named.ContainingNamespace is { IsGlobalNamespace: false } ns
            ? this.Names(context).GetNamespaceName(ns)
            : null;
        string target = namespaceName != null ? $"{namespaceName}.{simpleName}" : simpleName;
        string candidate = this.GetOrCreateImportedTypeAlias(named, context, location, reuseOnly: true, target);
        if (candidate is null)
        {
            return false;
        }

        aliasName = candidate;
        return true;
    }
}

/// <summary>
/// Stores the anonymous shapes already declared in one G# package. The
/// registry is shared across that package's documents for declaration
/// deduplication (#2292), while <see cref="SyntheticName"/> derives names from
/// complete ordered shapes so independent packages and projects agree (#2598).
/// </summary>
public sealed class AnonymousTypeRegistry
{
    private readonly Dictionary<string, NamedTypeReference> byShape = new(System.StringComparer.Ordinal);

    /// <summary>
    /// Looks up an already-synthesized data-class reference for
    /// <paramref name="shapeKey"/> (an anonymous type's ordered
    /// member-name+type shape), reused verbatim regardless of which file
    /// (sharing this registry) first synthesized it.
    /// </summary>
    /// <param name="shapeKey">The structural shape key.</param>
    /// <param name="existing">The reused reference, when found.</param>
    /// <returns><see langword="true"/> when a data class already exists for this shape.</returns>
    public bool TryGetExisting(string shapeKey, out NamedTypeReference existing) =>
        this.byShape.TryGetValue(shapeKey, out existing);

    /// <summary>
    /// Produces a deterministic synthetic name from the complete ordered shape.
    /// The name is therefore identical wherever the same shape is translated
    /// and different for unrelated shapes even when separate documents,
    /// packages, projects, or translator instances are involved.
    /// </summary>
    /// <param name="shapeKey">The ordered member-name/type shape.</param>
    /// <param name="arity">The number of members in the shape.</param>
    /// <returns>A stable shape-derived synthetic type name.</returns>
    public static string SyntheticName(string shapeKey, int arity)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(shapeKey));
        return $"AnonymousType{arity}_{System.Convert.ToHexString(hash, 0, 8)}";
    }

    /// <summary>
    /// Records that <paramref name="shapeKey"/> now resolves to
    /// <paramref name="reference"/>, so any later file sharing this registry
    /// reuses it instead of re-declaring an identical data class (which would
    /// itself be a same-name GS0102 collision even for an identical shape).
    /// </summary>
    /// <param name="shapeKey">The structural shape key.</param>
    /// <param name="reference">The synthesized data class's type reference.</param>
    public void Register(string shapeKey, NamedTypeReference reference) => this.byShape[shapeKey] = reference;
}
