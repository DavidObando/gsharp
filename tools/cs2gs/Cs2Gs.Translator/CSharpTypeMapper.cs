// <copyright file="CSharpTypeMapper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection.Metadata;
using System.Runtime.InteropServices;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.Translator.Coverage;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

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
    /// Issue #2292: this dictionary (and the synthetic-name counter) is now
    /// owned by an <see cref="AnonymousTypeRegistry"/> that is shared across
    /// EVERY <see cref="CSharpTypeMapper"/> instance translating documents
    /// into the SAME G# package (<c>CSharpToGSharpTranslator</c> creates one
    /// mapper per source file but keeps one registry per resolved package),
    /// rather than living directly on this per-file mapper. Two unrelated
    /// files in the same package used to each start their own private
    /// dictionary/counter at zero, so a distinct shape in file B could still
    /// mint the SAME synthetic name (<c>AnonymousType0</c>) as an unrelated
    /// shape already declared in file A — both top-level declarations landing
    /// in the same package caused GS0102 "already declared" even though
    /// per-file the mapper looked file-scoped. Sharing the registry across the
    /// whole package closes that gap while still deduplicating identical
    /// shapes package-wide (a shape already declared by an earlier file is
    /// reused, not re-declared, by a later one).
    /// </para>
    /// </summary>
    private readonly AnonymousTypeRegistry anonymousTypeRegistry;

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

    /// <summary>
    /// Issue #1174: cached per-compilation census of source-declared type simple
    /// names (built lazily on first use), used to decide whether a source nested
    /// type's simple name is ambiguous and must be emitted in qualified form.
    /// </summary>
    private Dictionary<string, int> sourceSimpleNameCounts;

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
    /// The package-scoped registry of already-synthesized anonymous-type
    /// shapes and the next available synthetic-name index.
    /// </param>
    public CSharpTypeMapper(AnonymousTypeRegistry anonymousTypeRegistry)
    {
        this.anonymousTypeRegistry = anonymousTypeRegistry ?? new AnonymousTypeRegistry();
    }

    /// <summary>
    /// Gets every namespace shortened into a bare/qualified-nested type name by
    /// this mapper so far (see <see cref="shortenedNamespaces"/>).
    /// </summary>
    public IReadOnlyCollection<string> ShortenedNamespaces => this.shortenedNamespaces;

    /// <summary>
    /// Gets the synthesized anonymous-type <c>data class</c> declarations
    /// collected so far by <see cref="GetOrCreateAnonymousDataClass"/>, in
    /// first-seen (deterministic) order.
    /// </summary>
    public IReadOnlyList<TypeDeclaration> PendingAnonymousDataClasses => this.pendingAnonymousDataClasses;

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
        if (method is null)
        {
            return;
        }

        // Reduced instance-form calls (key.All(predicate)) resolve to a
        // reduced symbol; unwrap it back to the original static-form method
        // so ContainingNamespace reflects the extension's declaring type.
        IMethodSymbol original = method.ReducedFrom ?? method;

        // C# 14 extension blocks compile their members onto a synthetic
        // marker type nested inside the containing type; unwrap to the
        // enclosing (real, declared) type so the namespace we record is the
        // one the user would actually need to import.
        INamedTypeSymbol containingType = original.ContainingType;
        if (containingType is { IsExtension: true } && containingType.ContainingType is { } declaringType)
        {
            containingType = declaringType;
        }

        INamespaceSymbol ns = containingType?.ContainingNamespace;
        if (ns is null || ns.IsGlobalNamespace)
        {
            return;
        }

        this.shortenedNamespaces.Add(ns.ToDisplayString());
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
        GTypeReference mapped = this.MapCore(type, context, location);
        return nullableReference ? WithNullable(mapped, true) : mapped;
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
        bool previous = this.qualifyMetadataImportCollisions;
        this.qualifyMetadataImportCollisions = true;
        GTypeReference mapped;
        try
        {
            mapped = this.Map(type, context, location);
        }
        finally
        {
            this.qualifyMetadataImportCollisions = previous;
        }

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
    /// Issue #1960 item 3: maps an event's handler type, preferring a
    /// SOURCE-DECLARED named delegate's own name over the structural
    /// <c>func(...)</c> arrow form that <see cref="Map"/> always uses for
    /// delegate types. An event declared as <c>event Ticked TickHandler;</c>
    /// round-trips higher-fidelity than the anonymous <c>event Ticked (int32)
    /// -&gt; void</c> shape, and it matches C#'s own event-type story (named
    /// delegates document the handler shape for consumers). Scoped to events
    /// only (not <see cref="Map"/> generally) — a plain local/field/parameter
    /// of a same-package named-delegate type still lowers through the arrow
    /// form, since referencing a named delegate type from outside its own
    /// declaration currently trips a gsc emitter bug ("Delegate 'X' has no
    /// emitted TypeDef") for those positions; only the event accessor shape
    /// has been verified to compile with the named form (see corpus
    /// G07-Members-Console).
    /// </summary>
    /// <param name="type">The event's declared handler type.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>The canonical G# type reference for the event's handler type.</returns>
    public GTypeReference MapEventType(ITypeSymbol type, TranslationContext context, Location location)
    {
        if (type is INamedTypeSymbol { TypeKind: TypeKind.Delegate, DelegateInvokeMethod: not null } named &&
            named.DeclaringSyntaxReferences.Length > 0)
        {
            if (named.IsGenericType)
            {
                List<GTypeReference> delegateArgs = named.TypeArguments
                    .Select(a => this.Map(a, context, location))
                    .ToList();
                return new NamedTypeReference(this.QualifiedTypeName(named, context), delegateArgs);
            }

            return new NamedTypeReference(this.QualifiedTypeName(named, context));
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
    public NamedTypeReference GetOrCreateAnonymousDataClass(INamedTypeSymbol anonymousType, TranslationContext context, Location location)
    {
        List<IPropertySymbol> properties = anonymousType.GetMembers().OfType<IPropertySymbol>().ToList();
        string shapeKey = string.Join(
            "|",
            properties.Select(p => p.Name + ":" + p.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));

        // Issue #2292: the shape->name dictionary and the synthetic-name
        // counter both live on the shared package-scoped `anonymousTypeRegistry`
        // (not on this per-file mapper), so a shape already synthesized by an
        // EARLIER file in the same package is reused here (no re-declaration,
        // avoiding a same-name GS0102 for an identical shape), and a shape
        // that is new to this file still draws its synthetic index from the
        // package-wide counter (so a distinct shape never collides with a
        // name already minted by another file in the same package).
        if (this.anonymousTypeRegistry.TryGetExisting(shapeKey, out NamedTypeReference existing))
        {
            return existing;
        }

        string syntheticName = this.anonymousTypeRegistry.NextSyntheticName();
        var parameters = properties
            .Select(p => new Cs2Gs.CodeModel.Ast.Parameter(CSharpToGSharpTranslator.SanitizeIdentifier(p.Name), this.Map(p.Type, context, location)))
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
        return reference;
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
    /// <c>unmanaged[Cdecl, SuppressGCTransition]</c>) have no single fixed G#
    /// <see cref="CallingConvention"/> to spell, so those two sub-cases stay a
    /// deliberate by-design gap.
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

        string reason = signature.CallingConvention == SignatureCallingConvention.Unmanaged
            && signature.UnmanagedCallingConventionTypes.Length == 0
            ? "the platform-default unmanaged convention ('delegate* unmanaged<...>' with no explicit '[CC]') is genuinely platform-dependent (Stdcall on Windows x86, Cdecl elsewhere) and has no single fixed G# CallingConvention to spell"
            : "a combined or custom unmanaged calling convention has no single fixed G# CallingConvention equivalent — G#'s '[CC]' slot only accepts one of Cdecl/Stdcall/Thiscall/Fastcall";
        context.Report(new TranslationDiagnostic(
            "FunctionPointerType",
            $"unsafe function-pointer type '{type.ToDisplayString()}' has no canonical G# form: {reason} (issue #1906).",
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
                return new NamedTypeReference(named.Name, named.TypeArguments) { IsNullable = isNullable };
            case ArrayTypeReference array:
                return new ArrayTypeReference(array.ElementType) { IsNullable = isNullable };
            case PointerTypeReference pointer:
                return new PointerTypeReference(pointer.ElementType) { IsNullable = isNullable };
            case TupleTypeReference tuple:
                return new TupleTypeReference(tuple.ElementTypes) { IsNullable = isNullable };
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
            if (array.Rank > 1)
            {
                // Issue #1893: gsc has no rectangular multi-dim array type (only
                // the fixed-length `[N]T`/slice `[]T`, both rank 1). A
                // multi-dim TYPE reached here (e.g. an explicit `T[,] x;` with
                // no initializer, a field/parameter/return type) has no symbol
                // for TranslateLocalDeclaration's flat-lowering to hang
                // per-dimension sizes on, so — rather than silently returning a
                // 1-D `ArrayTypeReference` that drops the rank (the original
                // bug) — report the gap loudly. A local declared AND
                // initialized in one statement from `new T[d0, d1, ...]` avoids
                // this path entirely: TranslateLocalDeclaration omits the type
                // clause and relies on inference over the already-flat-lowered
                // initializer.
                string multiDimTypeGapMessage =
                    $"multi-dimensional array type '{array}' (rank {array.Rank}) has no canonical G# type; " +
                    "only a local declared and initialized in the same statement from `new T[d0, d1, ...]` " +
                    "or a rectangular initializer is supported today.";
                context.Report(new TranslationDiagnostic(
                    "ArrayType", multiDimTypeGapMessage, location, TranslationSeverity.Unsupported));
            }

            return new ArrayTypeReference(this.Map(array.ElementType, context, location));
        }

        if (type is ITypeParameterSymbol typeParameter)
        {
            return new NamedTypeReference(CSharpToGSharpTranslator.SanitizeIdentifier(typeParameter.Name));
        }

        if (type is INamedTypeSymbol named)
        {
            // Value tuples / named tuples map to the canonical G# positional
            // tuple type `(T1, T2, …)` (spec §Type syntax). G# tuples are
            // positional, so C# element names are dropped here and named element
            // access lowers to `.Item1`/`.Item2` at the use site (ADR-0115 §B.4).
            if (named.IsTupleType)
            {
                List<GTypeReference> elementTypes = named.TupleElements
                    .Select(e => this.Map(e.Type, context, location))
                    .ToList();
                context.Report(new TranslationDiagnostic(
                    named.ToDisplayString(),
                    "C# value-tuple / named-tuple type mapped to the canonical G# positional tuple type; element names are dropped and named access lowers to '.ItemN' (ADR-0115 §B.4).",
                    location,
                    TranslationSeverity.Info));
                return new TupleTypeReference(elementTypes);
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
            if (named.TypeKind == TypeKind.Delegate && named.DelegateInvokeMethod != null)
            {
                return this.MapDelegate(named.DelegateInvokeMethod, context, location);
            }

            if (named.IsGenericType)
            {
                List<GTypeReference> args = named.TypeArguments
                    .Select(a => this.Map(a, context, location))
                    .ToList();
                return new NamedTypeReference(this.QualifiedTypeName(named, context), args);
            }

            return new NamedTypeReference(this.QualifiedTypeName(named, context));
        }

        return new NamedTypeReference(CSharpToGSharpTranslator.SanitizeIdentifier(type.Name));
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
    private string QualifiedTypeName(INamedTypeSymbol named, TranslationContext context)
    {
        if (named.ContainingType == null)
        {
            this.TrackShortenedNamespace(named);
            string simpleName = CSharpToGSharpTranslator.SanitizeIdentifier(named.Name);

            // Issue #2222: a bare top-level type name is ambiguous in G#'s flat
            // import scope when another top-level type of the SAME simple name
            // is reachable through this file's imports (a source homonym
            // anywhere in the compilation, per #1174's conservative census, OR a
            // distinct type of the same name sitting in one of the file's
            // actually-imported namespaces — including a referenced assembly,
            // i.e. a translated sibling project surfaced as a metadata
            // reference). Qualify with the namespace in that case so gsc binds
            // the reference to the right type instead of whichever homonym
            // happens to resolve first.
            //
            // Constraint mapping also enables this scan for metadata/metadata
            // collisions (issue #2509). Ordinary positions retain the
            // source-authored gate so common framework types are not qualified
            // spuriously.
            bool scanImportedNamespaces = named.Locations.Any(l => l.IsInSource)
                || this.qualifyMetadataImportCollisions;
            bool ambiguous = this.HasSourceHomonym(named, context)
                || (scanImportedNamespaces && this.HasImportedNamespaceHomonym(named, context));
            if (!ambiguous)
            {
                return simpleName;
            }

            return named.ContainingNamespace is { IsGlobalNamespace: false } containingNs
                ? $"{containingNs.ToDisplayString()}.{simpleName}"
                : simpleName;
        }

        // A source nested type only needs qualifying when its simple name is
        // ambiguous within the package (a same-named source homonym exists).
        if (named.Locations.Any(l => l.IsInSource) && !this.HasSourceHomonym(named, context))
        {
            return CSharpToGSharpTranslator.SanitizeIdentifier(named.Name);
        }

        var parts = new List<string>();
        INamedTypeSymbol outermost = named;
        for (INamedTypeSymbol current = named; current != null; current = current.ContainingType)
        {
            parts.Insert(0, CSharpToGSharpTranslator.SanitizeIdentifier(current.Name));
            outermost = current;
        }

        this.TrackShortenedNamespace(outermost);
        string nestedName = string.Join(".", parts);
        bool scanOutermostImports = outermost.Locations.Any(l => l.IsInSource)
            || this.qualifyMetadataImportCollisions;
        bool outermostAmbiguous = this.HasSourceHomonym(outermost, context)
            || (scanOutermostImports && this.HasImportedNamespaceHomonym(outermost, context));
        return outermostAmbiguous
            && outermost.ContainingNamespace is { IsGlobalNamespace: false } outerNamespace
                ? $"{outerNamespace.ToDisplayString()}.{nestedName}"
                : nestedName;
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
            this.shortenedNamespaces.Add(ns.ToDisplayString());
        }
    }

    /// <summary>
    /// Issue #1174: whether another source-declared type shares the simple name of
    /// <paramref name="named"/>, making the bare name ambiguous in the flat G#
    /// package scope. The per-compilation simple-name census is built once and
    /// cached on this mapper instance.
    /// </summary>
    private bool HasSourceHomonym(INamedTypeSymbol named, TranslationContext context)
    {
        this.sourceSimpleNameCounts ??= BuildSourceSimpleNameCounts(context.Compilation);
        if (!this.sourceSimpleNameCounts.TryGetValue(named.Name, out var count))
        {
            return false;
        }

        // Issue #2307: for a source symbol, one census entry is the symbol
        // itself, so ambiguity starts at two. A metadata symbol is not in the
        // source census at all, so even one same-named source declaration is a
        // distinct homonym and the metadata reference must stay qualified.
        int selfCount = named.Locations.Any(l => l.IsInSource) ? 1 : 0;
        return count > selfCount;
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
            INamespaceSymbol candidateNamespace = ResolveNamespace(context.Compilation, namespaceName);
            if (candidateNamespace is null)
            {
                continue;
            }

            // `named` may be a CONSTRUCTED generic (e.g. `Box<Label>`), while
            // `GetTypeMembers` always yields the unbound generic definition
            // (`Box<T>`). Comparing them directly makes every reference to a
            // constructed generic type look like a homonym of itself — compare
            // original definitions so `Box<Label>` correctly matches `Box<T>`.
            foreach (INamedTypeSymbol candidate in candidateNamespace.GetTypeMembers(named.Name))
            {
                if (SymbolEqualityComparer.Default.Equals(candidate.OriginalDefinition, named.OriginalDefinition))
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
    /// Cached per mapper instance: one mapper translates one file, so the
    /// import set never changes across calls.
    /// </summary>
    private HashSet<string> GetImportedNamespaceNames(TranslationContext context)
    {
        if (this.importedNamespaceNames != null)
        {
            return this.importedNamespaceNames;
        }

        var names = new HashSet<string>();
        if (context.SemanticModel.SyntaxTree.GetRoot() is CompilationUnitSyntax root)
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
                if (node is not (NameSyntax or MemberAccessExpressionSyntax))
                {
                    continue;
                }

                if (context.SemanticModel.GetSymbolInfo(node).Symbol is not INamedTypeSymbol candidate)
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

        this.importedNamespaceNames = names;
        return names;
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

    private static Dictionary<string, int> BuildSourceSimpleNameCounts(Compilation compilation)
    {
        var counts = new Dictionary<string, int>();
        foreach (var type in EnumerateAllNamedTypes(compilation.GlobalNamespace))
        {
            if (!type.Locations.Any(l => l.IsInSource))
            {
                continue;
            }

            counts.TryGetValue(type.Name, out var existing);
            counts[type.Name] = existing + 1;
        }

        return counts;
    }

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
                ? new TupleTypeReference(elements) { IsNullable = mappedTuple.IsNullable }
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
}

/// <summary>
/// Issue #2292: the shape-&gt;synthesized-type dictionary and synthetic-name
/// counter that <see cref="CSharpTypeMapper.GetOrCreateAnonymousDataClass"/>
/// uses, factored out of <see cref="CSharpTypeMapper"/> so it can be shared
/// across every mapper instance translating a document into the SAME G#
/// package. <c>CSharpToGSharpTranslator</c> creates one <see cref="CSharpTypeMapper"/>
/// per source file (so per-file state like <see cref="CSharpTypeMapper.ShortenedNamespaces"/>
/// stays file-scoped) but keeps exactly one <see cref="AnonymousTypeRegistry"/>
/// per resolved package name, keyed in a dictionary that outlives any single
/// <c>TranslateDocument</c> call. Without this, two unrelated files in the
/// same package each started counting from <c>AnonymousType0</c>, so a
/// DISTINCT shape in file B could mint the exact name already used by an
/// UNRELATED shape in file A — both top-level <c>data class</c> declarations
/// landing in the same package/namespace, which is a GS0102 "already
/// declared" collision at the gsc compile stage even though each file's own
/// translation looked internally consistent.
/// </summary>
public sealed class AnonymousTypeRegistry
{
    private readonly Dictionary<string, NamedTypeReference> byShape = new(System.StringComparer.Ordinal);
    private int nextIndex;

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
    /// Mints the next package-wide-unique synthetic name (<c>AnonymousType0</c>,
    /// <c>AnonymousType1</c>, ...). Drawing from a single counter shared by
    /// every file in the package (rather than each file counting from zero)
    /// is what prevents two distinct shapes in different files from
    /// colliding on the same name.
    /// </summary>
    /// <returns>The next unused synthetic type name.</returns>
    public string NextSyntheticName() => $"AnonymousType{this.nextIndex++}";

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
