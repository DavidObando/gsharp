// <copyright file="CSharpToGSharpTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

/// <summary>
/// The C#→G# translation entry point (ADR-0115 §A). It walks a bound C#
/// document and builds a <see cref="CompilationUnit"/> of the
/// <see cref="Cs2Gs.CodeModel"/> emit AST that the canonical pretty-printer
/// consumes.
/// <para>
/// This is the <b>step-6</b> declaration mapper: it fully maps namespaces,
/// imports, type declarations (class/struct/data-class/data-struct/interface/
/// enum), and member <i>signatures</i> + fields (ADR-0115 §B.1, §B.3–§B.12).
/// Method / property / constructor <i>bodies</i> are routed through the single
/// <see cref="DeclarationVisitor.TranslateBody"/> seam, which emits a minimal,
/// parseable placeholder block today; step 7 replaces that implementation with
/// real statement / expression translation. Every construct with no canonical
/// G# form is recorded as a structured <see cref="TranslationDiagnostic"/>
/// rather than being silently dropped (ADR-0115 §B/§D).
/// </para>
/// </summary>
public sealed partial class CSharpToGSharpTranslator
{
    // A subclass can only ever be declared in source, never synthesized from a
    // referenced assembly's metadata, so the set of "is this base type ever
    // subclassed" facts is a pure function of the *source* assembly's symbol
    // tree and is invariant across every document translated from the same
    // `Compilation`. `Compilation.GlobalNamespace` is the merged namespace
    // across every metadata reference too, so scanning it (as the previous
    // implementation did) forces materialization of the entire BCL symbol
    // tree — tens of thousands of `INamedTypeSymbol`s — on every single
    // document. Caching per `Compilation` (keyed by reference identity via
    // `ConditionalWeakTable`, so a new/edited `Compilation` naturally gets a
    // fresh entry and stale ones are collectible) plus restricting the walk to
    // `compilation.Assembly.GlobalNamespace` (the source assembly only) turns
    // an O(assemblies × types × documents) cost into a single O(source types)
    // pass per compilation.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Compilation, HashSet<INamedTypeSymbol>> SubclassedBaseTypesCache = new();

    // Issue #1910: a `partial` class/struct/interface/record has ONE symbol but
    // MULTIPLE `TypeDeclarationSyntax` parts (one per file/declaration). Each
    // part used to be translated independently, emitting a complete, duplicate
    // G# type declaration per part (GS0102) instead of one merged declaration.
    // Cached per `Compilation` for the same reason as `SubclassedBaseTypesCache`
    // above: it is a pure function of the source symbol tree, invariant across
    // every document translated from the same compilation.
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Compilation, Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>>> PartialTypePartsCache = new();

    // Issue #2821: classic C# extension methods whose receiver type is declared
    // in the same source compilation and namespace belong to that output
    // package. Collect them once per compilation so the receiver's declaration
    // can absorb them even when the extension and target live in different
    // files (including partial target declarations).
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Compilation, OwnedExtensionRegistry> OwnedExtensionsCache = new();

    // ADR-0145 (§C/§D) / issue #3410: preserve each C# `partial` declaration as
    // a standalone G# `partial` part by default. This keeps members in the G#
    // file corresponding to their declaring C# file and lets the G# compiler's
    // partial-type merger combine the parts. The legacy issue #1910 translation
    // shape remains available when false: all parts merge into one non-partial
    // G# declaration emitted in the primary file.
    private readonly bool preservePartialParts;

    // Issue #2215: when the legacy merge path (`!preservePartialParts`) is used,
    // the MERGED result keeps a `partial` modifier when the
    // C# source itself was `partial` — so gsc's own `/analyzer:`-triggered
    // gsgen run can later add a real, additional generated `partial` part
    // (ADR-0145) that merges into this type instead of colliding with it
    // (GS0475/GS0102). Set by the caller only for a project that actually has
    // analyzer references; every other translation is byte-for-byte unchanged.
    private readonly bool markMergedTypePartial;

    // Issue #2610: generator-produced nullable-oblivious reference fields
    // (Avalonia x:Name fields are the common case) must remain nullable when
    // back-translated. This is generator-host behavior, not a consequence of
    // preserving ordinary source partial declarations (issue #3410).
    private readonly bool widenObliviousReferenceFields;

    // Issue #2215: when set, restricts the "other partial parts to merge in"
    // set (`CollectPartialTypeParts`, built from `INamedTypeSymbol.
    // DeclaringSyntaxReferences` across the WHOLE compilation) to only the
    // documents the caller actually kept for translation. Without this, a
    // generator-produced partial part that `CSharpProjectLoader.BuildDocuments`
    // correctly excludes as generated (so it is NOT translated on its own)
    // still gets its members silently merged into the primary part here —
    // duplicating what gsc's own `/analyzer:`-triggered gsgen run later adds
    // (GS0102). Null (default) preserves the exact prior no-filter behavior.
    private readonly HashSet<string> retainedFilePaths;
    private readonly string packageFilter;
    private readonly bool includeFileAttributes;

    // One registry per resolved G# package deduplicates declarations across
    // documents (#2292). Synthetic names themselves are derived from the full
    // ordered shape (#2598), so distinct shapes cannot reuse a simple name
    // across imported packages or independently translated projects.
    private readonly Dictionary<string, AnonymousTypeRegistry> anonymousTypeRegistriesByPackage =
        new(StringComparer.Ordinal);

    /// <summary>
    /// Initializes a new instance of the <see cref="CSharpToGSharpTranslator"/> class.
    /// </summary>
    /// <param name="preservePartialParts">
    /// When <see langword="true"/> (default), each C# <c>partial</c>
    /// declaration is translated as a standalone G# <c>partial</c> part with
    /// no cross-part merge, preserving source-file member ownership (issue
    /// #3410). When <see langword="false"/>, all parts are merged into one
    /// non-partial G# type (legacy issue #1910 behavior).
    /// </param>
    /// <param name="markMergedTypePartial">
    /// When <see langword="true"/>, the merged type produced by the legacy
    /// (<paramref name="preservePartialParts"/> <see langword="false"/>) path
    /// keeps a G# <c>partial</c> modifier if the C# source declared the type
    /// <c>partial</c> (issue #2215: the project has analyzer/generator
    /// references, so gsc's own gsgen run will add another real partial part
    /// afterward). Ignored when <paramref name="preservePartialParts"/> is
    /// <see langword="true"/> (that mode already always carries the modifier).
    /// </param>
    /// <param name="retainedFilePaths">
    /// The caller's own file set considered eligible for translation (issue
    /// #2215). When supplied, partial declarations outside this set (i.e.
    /// excluded as generated) do not participate in legacy merging or
    /// source-part ownership selection. Pass <see langword="null"/> (default)
    /// to keep every part regardless of file.
    /// </param>
    /// <param name="packageFilter">
    /// When supplied, emits only declarations whose containing namespace
    /// matches this package.
    /// </param>
    /// <param name="includeFileAttributes">
    /// When <see langword="false"/>, omits compilation-unit assembly/module
    /// attributes. Used for secondary package-split outputs so file-level
    /// metadata is emitted once.
    /// </param>
    /// <param name="widenObliviousReferenceFields">
    /// When <see langword="true"/>, nullable-oblivious reference fields are
    /// emitted as nullable. Used by the source-generator host for generated
    /// partial parts (issue #2610); ordinary source translation leaves this
    /// <see langword="false"/>.
    /// </param>
    public CSharpToGSharpTranslator(
        bool preservePartialParts = true,
        bool markMergedTypePartial = false,
        IReadOnlyCollection<string> retainedFilePaths = null,
        string packageFilter = null,
        bool includeFileAttributes = true,
        bool widenObliviousReferenceFields = false)
    {
        this.preservePartialParts = preservePartialParts;
        this.markMergedTypePartial = markMergedTypePartial;
        this.widenObliviousReferenceFields = widenObliviousReferenceFields;
        this.retainedFilePaths = retainedFilePaths is null
            ? null
            : new HashSet<string>(retainedFilePaths, StringComparer.Ordinal);
        this.packageFilter = packageFilter;
        this.includeFileAttributes = includeFileAttributes;
    }

    /// <summary>
    /// Translates a loaded C# document into a G# <see cref="CompilationUnit"/>,
    /// recording any unsupported constructs on a fresh context. Use
    /// <see cref="TranslateDocument(LoadedDocument, TranslationContext)"/> when the
    /// caller needs to inspect the recorded diagnostics.
    /// </summary>
    /// <param name="document">The bound C# document to translate.</param>
    /// <returns>The G# compilation unit.</returns>
    public CompilationUnit TranslateDocument(LoadedDocument document)
    {
        var context = new TranslationContext(
            (CSharpCompilation)document.SemanticModel.Compilation,
            document.SemanticModel,
            document.FilePath);
        return this.TranslateDocument(document, context);
    }

    /// <summary>
    /// Translates a loaded C# document into a G# <see cref="CompilationUnit"/>,
    /// recording any unsupported constructs on the supplied context.
    /// </summary>
    /// <param name="document">The bound C# document to translate.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <returns>The G# compilation unit.</returns>
    public CompilationUnit TranslateDocument(LoadedDocument document, TranslationContext context)
    {
        CompilationUnitSyntax root = document.GetRoot();

        Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> partialTypeParts =
            GetOrCollectPartialTypeParts(context.Compilation);
        if (this.retainedFilePaths != null)
        {
            partialTypeParts = FilterPartialTypeParts(partialTypeParts, this.retainedFilePaths);
        }

        OwnedExtensionRegistry ownedExtensions =
            GetOrCollectOwnedExtensions(context.Compilation).Filter(this.retainedFilePaths);

        string package = this.packageFilter ?? this.ResolvePackage(root, context);

        // Issue #1910 (gap 3): a merged-in member from a non-primary partial
        // part (see `VisitAggregateCore`) is translated using ITS OWN file's
        // semantic model (`TranslationContext.UseSemanticModelFor`), so a short
        // type/member name it emits may only resolve under a `using` that
        // lives in that OTHER file, not this (primary) one. Union in the
        // `using` directives of every non-primary part whose primary part is
        // declared in THIS tree, so the merged output's import block covers
        // every name the merged-in bodies rely on.
        // ADR-0145 preserve mode: each part is a standalone declaration, so it
        // must NOT pull in sibling parts' `using` directives — its own imports
        // are all it needs (there is no cross-part member merge to resolve).
        IEnumerable<Microsoft.CodeAnalysis.SyntaxTree> extraUsingTrees =
            this.preservePartialParts
                ? Enumerable.Empty<Microsoft.CodeAnalysis.SyntaxTree>()
                : CollectExtraUsingTrees(root, partialTypeParts);
        extraUsingTrees = extraUsingTrees.Concat(
            CollectOwnedExtensionUsingTrees(root, context, ownedExtensions));
        IReadOnlyList<ImportDirective> imports = this.TranslateImports(root, extraUsingTrees, context);

        HashSet<INamedTypeSymbol> openBases = GetOrCollectSubclassedBaseTypes(context.Compilation);
        HashSet<INamedTypeSymbol> staticUsingTargets = CollectStaticUsingTargets(root, context);

        // T3 (ADR-0115 §B.1/§B.11): the C# program entry point and its enclosing
        // static class normally become top-level G#. When the entry class owns a
        // nested aggregate type, keep the class intact instead: G# supports class-scoped
        // static Main, and flattening would discard the nested type's owner and
        // private accessibility.
        //
        // Computed once here and threaded through so the visitor does not
        // recompute it (`Compilation.GetEntryPoint` re-walks the compilation).
        IMethodSymbol entryPoint = context.Compilation.GetEntryPoint(default);
        INamedTypeSymbol entryType = entryPoint?.ContainingType;
        bool preserveEntryType = entryType?.GetTypeMembers()
            .Any(type => type.TypeKind != TypeKind.Delegate) == true;

        // Share the anonymous-type registry with every other
        // document already translated (by this same translator instance)
        // into the same package, so distinct/identical shapes across FILES
        // never collide (see `anonymousTypeRegistriesByPackage`'s comment).
        // `package` is null for a file with no namespace declaration (the
        // global namespace, e.g. a top-level-statements `Program.cs`) — a
        // Dictionary key cannot be null, so the global namespace is keyed by
        // the empty string instead (still one shared registry for every
        // global-namespace file in this translator's project, exactly
        // mirroring the non-null-package case).
        string registryKey = package ?? string.Empty;
        if (!this.anonymousTypeRegistriesByPackage.TryGetValue(registryKey, out AnonymousTypeRegistry anonymousTypeRegistry))
        {
            anonymousTypeRegistry = new AnonymousTypeRegistry();
            this.anonymousTypeRegistriesByPackage[registryKey] = anonymousTypeRegistry;
        }

        var typeMapper = new CSharpTypeMapper(anonymousTypeRegistry);
        var visitor = new DeclarationVisitor(
            context,
            typeMapper,
            openBases,
            staticUsingTargets,
            preserveEntryType ? null : entryPoint,
            partialTypeParts,
            ownedExtensions,
            this.preservePartialParts,
            this.markMergedTypePartial,
            this.widenObliviousReferenceFields);

        IReadOnlyList<AttributeUse> fileAttributes = this.includeFileAttributes
            ? visitor.MapFileAttributes(
                root.AttributeLists.Where(list =>
                    list.Target?.Identifier.ValueText is "assembly" or "module"))
            : Array.Empty<AttributeUse>();

        // Issue #2382: a NATIVE C# top-level-statements program (`GlobalStatementSyntax`
        // members directly under the compilation unit — no enclosing class/method
        // syntax at all, unlike the explicit-`Main` case handled by `entryType`
        // below) is recognized by its synthesized entry point's declaring syntax
        // reference pointing at THIS file's `CompilationUnitSyntax` itself, rather
        // than at any real method/type declaration. At most one file in a
        // compilation may contribute top-level statements (ADR-0066 D1 / CS8802),
        // so this only ever matches one document.
        List<GlobalStatementSyntax> globalStatements = root.Members.OfType<GlobalStatementSyntax>().ToList();
        bool hasNativeTopLevelStatements = globalStatements.Count > 0
            && entryPoint != null
            && entryPoint.DeclaringSyntaxReferences.Length > 0
            && entryPoint.DeclaringSyntaxReferences[0].SyntaxTree == root.SyntaxTree
            && entryPoint.DeclaringSyntaxReferences[0].GetSyntax() is CompilationUnitSyntax;

        var members = new List<GNode>();
        var trailingStatements = new List<GNode>();

        if (hasNativeTopLevelStatements)
        {
            (IReadOnlyList<GNode> hoistedFuncs, IReadOnlyList<GNode> entryStatements) =
                visitor.TranslateTopLevelProgram(globalStatements, entryPoint);
            members.AddRange(hoistedFuncs);
            trailingStatements.AddRange(entryStatements);
        }

        foreach (MemberDeclarationSyntax member in EnumerateTopLevelDeclarations(root)
            .Where(member => this.packageFilter is null
                || DeclarationBelongsToPackage(member, context, this.packageFilter)))
        {
            if (member is GlobalStatementSyntax)
            {
                // Already handled in a single pass above (native top-level
                // statements are not visited one-by-one like an ordinary member —
                // the whole sequence is translated together so the local-function
                // capture/hoist analysis can see every sibling statement).
                continue;
            }

            if (!preserveEntryType
                && entryType != null
                && member is TypeDeclarationSyntax typeDecl
                && context.GetDeclaredSymbol(member) is INamedTypeSymbol declaredType
                && SymbolEqualityComparer.Default.Equals(declaredType.OriginalDefinition, entryType.OriginalDefinition))
            {
                (IReadOnlyList<GNode> hoistedFuncs, IReadOnlyList<GNode> entryStatements) =
                    visitor.TranslateEntryType(typeDecl, entryPoint);
                members.AddRange(hoistedFuncs);
                trailingStatements.AddRange(entryStatements);
                continue;
            }

            GMember translated = visitor.Visit(member);
            if (translated is not null)
            {
                members.Add(translated);
            }

            // Synthesized top-level receiver funcs/operators are emitted as
            // siblings immediately after their source aggregate.
            members.AddRange(visitor.DrainPendingTopLevel());
        }

        // Issue #2282: every anonymous type reached during translation has been
        // mapped, by now, to a synthesized `data class` (see
        // `CSharpTypeMapper.GetOrCreateAnonymousDataClass`); the mapper cannot
        // append these to the compilation unit itself (`Map` is called from
        // many contexts with no member list in scope), so they are drained
        // here, once, in first-seen (deterministic) order — before the trailing
        // top-level statements, so a program-entry statement that constructs
        // one can see it declared.
        members.AddRange(typeMapper.PendingAnonymousDataClasses);

        // Top-level statements are appended after every declaration so the program
        // entry runs with all package types and funcs already in scope.
        members.AddRange(trailingStatements);

        // Issue #2211: a Roslyn source generator (and other fully-qualified,
        // no-`using` C# input) can reference a BCL/external type by its
        // fully-qualified name with no matching `using` directive. The type
        // mapper still shortens such a reference to its bare name (§B.7/§B.12
        // qualification rules), so without a corresponding `import` the
        // shortened name is unresolvable in the emitted G# (GS0113/GS0157).
        // Synthesize the missing imports here, once every member is
        // translated (so every shortened reference has been recorded) —
        // skipping the file's own package (needs no import) and any namespace
        // an explicit `using` already covers.
        var allImports = imports is List<ImportDirective> list ? list : imports.ToList();
        var existingAliases = new HashSet<string>(
            allImports.Where(import => import.Alias != null).Select(import => import.Alias),
            StringComparer.Ordinal);
        foreach (var alias in typeMapper.SynthesizedTypeAliases.OrderBy(
            pair => pair.Key,
            StringComparer.Ordinal))
        {
            if (existingAliases.Add(alias.Key))
            {
                allImports.Add(new ImportDirective(alias.Value, alias.Key));
            }
        }

        var alreadyImported = new HashSet<string>(
            allImports.Where(import => import.Alias == null).Select(import => import.Name));
        foreach (string ns in typeMapper.ShortenedNamespaces.OrderBy(n => n, System.StringComparer.Ordinal))
        {
            if (ns != package && alreadyImported.Add(ns))
            {
                allImports.Add(new ImportDirective(ns));
            }
        }

        return new CompilationUnit(package, allImports, members, fileAttributes: fileAttributes);
    }

    /// <summary>Gets the distinct source namespaces declared by a document.</summary>
    /// <param name="document">The bound source document.</param>
    /// <returns>Declared namespaces in source order.</returns>
    public static IReadOnlyList<string> GetDeclaredPackages(LoadedDocument document) =>
        EnumerateTopLevelDeclarations(document.GetRoot())
            .Select(member => document.SemanticModel.GetDeclaredSymbol(member))
            .Where(symbol => symbol?.ContainingNamespace is { IsGlobalNamespace: false })
            .Select(symbol => symbol.ContainingNamespace.ToDisplayString())
            .Distinct(StringComparer.Ordinal)
            .ToList();

    // Forwards to the canonical identifier sanitizer implemented on the nested
    // declaration visitor, so callers outside the visitor (e.g.
    // <see cref="CSharpTypeMapper"/>) can route type-name references through the
    // exact same sanitizer used at every declaration and reference site inside
    // the visitor, keeping declared and referenced names in agreement (issue
    // #1734).
    internal static string SanitizeIdentifier(string name) => DeclarationVisitor.SanitizeIdentifier(name);

    private static IEnumerable<MemberDeclarationSyntax> EnumerateTopLevelDeclarations(CompilationUnitSyntax root)
    {
        foreach (MemberDeclarationSyntax member in root.Members)
        {
            foreach (MemberDeclarationSyntax flattened in FlattenNamespaceMembers(member))
            {
                yield return flattened;
            }
        }
    }

    private static bool DeclarationBelongsToPackage(
        MemberDeclarationSyntax member,
        TranslationContext context,
        string package) =>
        context.GetDeclaredSymbol(member)?.ContainingNamespace?.ToDisplayString() == package;

    private static IEnumerable<MemberDeclarationSyntax> FlattenNamespaceMembers(MemberDeclarationSyntax member)
    {
        // A namespace (block `namespace X { ... }` or file-scoped) maps to G#
        // package structure; its declarations are flattened. Namespaces nest
        // (`namespace X { namespace Y { ... } }`), so flatten recursively.
        if (member is BaseNamespaceDeclarationSyntax ns)
        {
            foreach (MemberDeclarationSyntax nested in ns.Members)
            {
                foreach (MemberDeclarationSyntax flattened in FlattenNamespaceMembers(nested))
                {
                    yield return flattened;
                }
            }
        }
        else
        {
            yield return member;
        }
    }

    private static HashSet<INamedTypeSymbol> GetOrCollectSubclassedBaseTypes(Compilation compilation)
    {
        return SubclassedBaseTypesCache.GetValue(compilation, CollectSubclassedBaseTypes);
    }

    /// <summary>
    /// Issue #1910: maps every <c>partial</c> type symbol declared with more
    /// than one <see cref="TypeDeclarationSyntax"/> part to its parts, ordered
    /// deterministically (file path, then position) so every document
    /// translated from this compilation agrees on which part is the "primary"
    /// one (parts[0]) — the one declaration point that actually emits the
    /// merged G# type. A partial record's part carrying the positional
    /// parameter list is preferred first: only that part can supply the G#
    /// primary-constructor parameters (<see cref="DeclarationVisitor.MapPrimaryConstructor"/>).
    /// </summary>
    private static Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> GetOrCollectPartialTypeParts(Compilation compilation)
    {
        return PartialTypePartsCache.GetValue(compilation, CollectPartialTypeParts);
    }

    private static OwnedExtensionRegistry GetOrCollectOwnedExtensions(Compilation compilation)
    {
        return OwnedExtensionsCache.GetValue(compilation, CollectOwnedExtensions);
    }

    private static OwnedExtensionRegistry CollectOwnedExtensions(Compilation compilation)
    {
        var result = new OwnedExtensionRegistry(compilation.Assembly);
        var candidates = new List<(INamedTypeSymbol Receiver, MethodDeclarationSyntax Syntax, IMethodSymbol Method)>();
        foreach (Microsoft.CodeAnalysis.SyntaxTree tree in compilation.SyntaxTrees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            foreach (MethodDeclarationSyntax methodDeclaration in tree.GetRoot()
                .DescendantNodes()
                .OfType<MethodDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(methodDeclaration) is not IMethodSymbol method ||
                    !method.IsExtensionMethod)
                {
                    continue;
                }

                // Issue #3413: a lifted receiver func is emitted on the synthetic
                // top-level <Program> type, which cannot legally access a private
                // nested aggregate retained on the source extension owner. Keep
                // every extension on such an owner as its CLR-native static method;
                // translated receiver calls already use the static-helper rewrite.
                if (RequiresOwnerScopedExtension(method))
                {
                    result.AddStaticHelper(methodDeclaration);
                    if (CanEmitOwnerScopedReceiverCompanion(method))
                    {
                        result.AddReceiverCompanion(methodDeclaration);
                    }

                    continue;
                }

                if (!TryGetOwnedExtensionReceiver(method, out INamedTypeSymbol receiverDefinition))
                {
                    continue;
                }

                candidates.Add((receiverDefinition, methodDeclaration, method));
            }
        }

        foreach ((INamedTypeSymbol receiver, MethodDeclarationSyntax syntax, IMethodSymbol method) in candidates)
        {
            bool crossContainerOverload = HasCrossContainerOwnedExtensionOverload(receiver, method);
            bool reducedCollision = HasReducedDeclarationCollision(receiver, method);
            bool byRefReceiver = method.Parameters[0].RefKind != RefKind.None;
            if (crossContainerOverload || reducedCollision || byRefReceiver)
            {
                result.AddStaticHelper(syntax);
                if (crossContainerOverload &&
                    !HasCrossContainerOwnedExtensionDuplicate(receiver, method) &&
                    !reducedCollision &&
                    !byRefReceiver)
                {
                    result.AddReceiverCompanion(syntax);
                }

                continue;
            }

            if (receiver.TypeKind is TypeKind.Class or TypeKind.Struct &&
                method.Parameters[0].NullableAnnotation != NullableAnnotation.Annotated &&
                method.Parameters[0].Type is INamedTypeSymbol receiverType &&
                !IsGenericReceiver(receiverType) &&
                !HasApplicableInstanceMember(receiver, method))
            {
                result.Add(receiver, syntax);
            }
        }

        return result;
    }

    private static bool TryGetOwnedExtensionReceiver(
        IMethodSymbol method,
        out INamedTypeSymbol receiverDefinition)
    {
        receiverDefinition = null;
        if (method == null ||
            !method.IsExtensionMethod ||
            method.Parameters.Length == 0 ||
            method.Parameters[0].Type is not INamedTypeSymbol receiverType)
        {
            return false;
        }

        receiverDefinition = receiverType.OriginalDefinition;
        if (receiverDefinition.TypeKind == TypeKind.Enum)
        {
            return true;
        }

        return receiverDefinition.TypeKind is TypeKind.Class or TypeKind.Struct &&
            SymbolEqualityComparer.Default.Equals(
                receiverDefinition.ContainingAssembly,
                method.ContainingAssembly) &&
            SymbolEqualityComparer.Default.Equals(
                receiverDefinition.ContainingNamespace,
                method.ContainingNamespace);
    }

    private static bool HasCrossContainerOwnedExtensionOverload(
        INamedTypeSymbol receiver,
        IMethodSymbol method)
    {
        foreach (INamedTypeSymbol type in method.ContainingNamespace.GetTypeMembers())
        {
            foreach (IMethodSymbol other in type.GetMembers(method.Name).OfType<IMethodSymbol>())
            {
                if (!SymbolEqualityComparer.Default.Equals(other.ContainingType, method.ContainingType) &&
                    TryGetOwnedExtensionReceiver(other, out INamedTypeSymbol otherReceiver) &&
                    SymbolEqualityComparer.Default.Equals(otherReceiver, receiver))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool HasCrossContainerOwnedExtensionDuplicate(
        INamedTypeSymbol receiver,
        IMethodSymbol method)
    {
        foreach (INamedTypeSymbol type in method.ContainingNamespace.GetTypeMembers())
        {
            foreach (IMethodSymbol other in type.GetMembers(method.Name).OfType<IMethodSymbol>())
            {
                if (!SymbolEqualityComparer.Default.Equals(other.ContainingType, method.ContainingType) &&
                    TryGetOwnedExtensionReceiver(other, out INamedTypeSymbol otherReceiver) &&
                    SymbolEqualityComparer.Default.Equals(otherReceiver, receiver) &&
                    HaveSameReducedSignature(method, other))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool IsReproducibleStaticHelper(IMethodSymbol method)
    {
        IMethodSymbol original = method?.ReducedFrom ?? method;
        return TryGetOwnedExtensionReceiver(original, out INamedTypeSymbol receiver) &&
            (HasCrossContainerOwnedExtensionOverload(receiver, original) ||
                HasReducedDeclarationCollision(receiver, original) ||
                original.Parameters[0].RefKind != RefKind.None);
    }

    private static bool RequiresOwnerScopedExtension(IMethodSymbol method)
    {
        IMethodSymbol original = method?.ReducedFrom ?? method;
        return original?.IsExtensionMethod == true &&
            HasPrivateNestedAggregate(original.ContainingType);
    }

    private static bool CanEmitOwnerScopedReceiverCompanion(IMethodSymbol method)
    {
        IMethodSymbol original = method?.ReducedFrom ?? method;
        if (original?.Parameters.Length is not > 0
            || original.DeclaredAccessibility == Accessibility.Private
            || original.Parameters[0].RefKind != RefKind.None
            || original.Parameters.Any(parameter => parameter.IsParams)
            || original.ReturnsByRef
            || original.ReturnsByRefReadonly
            || HasCrossContainerExtensionDuplicate(original))
        {
            return false;
        }

        return original.Parameters[0].Type is not INamedTypeSymbol receiver
            || !HasReducedDeclarationCollision(receiver.OriginalDefinition, original);
    }

    private static bool HasCrossContainerExtensionDuplicate(IMethodSymbol method)
    {
        IMethodSymbol original = method?.ReducedFrom ?? method;
        if (original?.IsExtensionMethod != true || original.Parameters.Length == 0)
        {
            return false;
        }

        foreach (INamedTypeSymbol type in original.ContainingNamespace.GetTypeMembers())
        {
            foreach (IMethodSymbol other in type.GetMembers(original.Name).OfType<IMethodSymbol>())
            {
                IMethodSymbol otherOriginal = other.ReducedFrom ?? other;
                if (otherOriginal.IsExtensionMethod
                    && !SymbolEqualityComparer.Default.Equals(
                        otherOriginal.ContainingType,
                        original.ContainingType)
                    && otherOriginal.Parameters.Length > 0
                    && SignatureType(otherOriginal.Parameters[0].Type)
                        == SignatureType(original.Parameters[0].Type)
                    && HaveSameReducedSignature(original, otherOriginal))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool HasPrivateNestedAggregate(INamedTypeSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        foreach (INamedTypeSymbol nested in type.GetTypeMembers())
        {
            if ((nested.TypeKind != TypeKind.Delegate &&
                    nested.DeclaredAccessibility == Accessibility.Private) ||
                HasPrivateNestedAggregate(nested))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsReproducibleReceiverCompanion(IMethodSymbol method)
    {
        IMethodSymbol original = method?.ReducedFrom ?? method;
        if (RequiresOwnerScopedExtension(original))
        {
            return CanEmitOwnerScopedReceiverCompanion(original);
        }

        return TryGetOwnedExtensionReceiver(original, out INamedTypeSymbol receiver) &&
            original.Parameters[0].RefKind == RefKind.None &&
            HasCrossContainerOwnedExtensionOverload(receiver, original) &&
            !HasCrossContainerOwnedExtensionDuplicate(receiver, original) &&
            !HasReducedDeclarationCollision(receiver, original);
    }

    private static bool IsGenericReceiver(INamedTypeSymbol type)
    {
        for (INamedTypeSymbol current = type; current != null; current = current.ContainingType)
        {
            if (current.IsGenericType)
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasReducedDeclarationCollision(INamedTypeSymbol type, IMethodSymbol extension)
    {
        for (INamedTypeSymbol current = type; current != null; current = current.BaseType)
        {
            foreach (ISymbol member in current.GetMembers(extension.Name))
            {
                if (member.IsStatic)
                {
                    continue;
                }

                if (member is not IMethodSymbol method ||
                    HaveSameReducedSignature(
                        extension,
                        method,
                        leftIsExtension: true,
                        rightIsExtension: false))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool HasApplicableInstanceMember(INamedTypeSymbol type, IMethodSymbol extension)
    {
        for (INamedTypeSymbol current = type; current != null; current = current.BaseType)
        {
            foreach (IMethodSymbol method in current.GetMembers(extension.Name).OfType<IMethodSymbol>())
            {
                if (!method.IsStatic &&
                    HasOverlappingApplicability(method, extension))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool HasOverlappingApplicability(IMethodSymbol instanceMethod, IMethodSymbol extension)
    {
        int instanceMinimum = MinimumArgumentCount(instanceMethod.Parameters, 0);
        int extensionMinimum = MinimumArgumentCount(extension.Parameters, 1);
        int instanceMaximum = MaximumArgumentCount(instanceMethod.Parameters, 0);
        int extensionMaximum = MaximumArgumentCount(extension.Parameters, 1);
        return Math.Max(instanceMinimum, extensionMinimum) <=
            Math.Min(instanceMaximum, extensionMaximum);
    }

    private static int MinimumArgumentCount(ImmutableArray<IParameterSymbol> parameters, int offset) =>
        parameters.Skip(offset).Count(parameter => !parameter.IsOptional && !parameter.IsParams);

    private static int MaximumArgumentCount(ImmutableArray<IParameterSymbol> parameters, int offset) =>
        parameters.Length > offset && parameters[parameters.Length - 1].IsParams
            ? int.MaxValue
            : parameters.Length - offset;

    private static bool HaveSameReducedSignature(
        IMethodSymbol left,
        IMethodSymbol right,
        bool leftIsExtension = true,
        bool rightIsExtension = true)
    {
        if (left.Name != right.Name ||
            left.TypeParameters.Length != right.TypeParameters.Length)
        {
            return false;
        }

        int leftOffset = leftIsExtension ? 1 : 0;
        int rightOffset = rightIsExtension ? 1 : 0;
        if (left.Parameters.Length - leftOffset != right.Parameters.Length - rightOffset)
        {
            return false;
        }

        for (int i = 0; i < left.Parameters.Length - leftOffset; i++)
        {
            IParameterSymbol leftParameter = left.Parameters[leftOffset + i];
            IParameterSymbol rightParameter = right.Parameters[rightOffset + i];
            if (leftParameter.RefKind != rightParameter.RefKind ||
                SignatureType(leftParameter.Type) != SignatureType(rightParameter.Type))
            {
                return false;
            }
        }

        return true;
    }

    private static string SignatureType(ITypeSymbol type) =>
        string.Concat(
            type.ToDisplayParts(SymbolDisplayFormat.FullyQualifiedFormat)
                .Select(part => part.Symbol is ITypeParameterSymbol
                    { TypeParameterKind: TypeParameterKind.Method } parameter
                        ? "!" + parameter.Ordinal.ToString(CultureInfo.InvariantCulture)
                        : part.ToString()));

    private static Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> CollectPartialTypeParts(Compilation compilation)
    {
        var result = new Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>>(SymbolEqualityComparer.Default);
        foreach (INamedTypeSymbol type in EnumerateNamedTypes(compilation.Assembly.GlobalNamespace))
        {
            if (type.DeclaringSyntaxReferences.Length <= 1)
            {
                continue;
            }

            List<TypeDeclarationSyntax> parts = type.DeclaringSyntaxReferences
                .Select(r => r.GetSyntax())
                .OfType<TypeDeclarationSyntax>()
                .OrderByDescending(p => p is RecordDeclarationSyntax record && record.ParameterList != null)
                .ThenBy(p => p.SyntaxTree.FilePath, StringComparer.Ordinal)
                .ThenBy(p => p.SpanStart)
                .ToList();

            if (parts.Count > 1)
            {
                result[type] = parts;
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #2215: re-derives the raw (cached, whole-compilation) partial-parts
    /// map to only the caller's own retained (translatable) files, dropping a
    /// type entirely once it has one or zero remaining parts (it is then no
    /// longer "partial" from the caller's point of view — its excluded part,
    /// e.g. generator output, is not this caller's concern).
    /// </summary>
    private static Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> FilterPartialTypeParts(
        Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> raw,
        HashSet<string> retainedFilePaths)
    {
        var result = new Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>>(SymbolEqualityComparer.Default);
        foreach (KeyValuePair<INamedTypeSymbol, List<TypeDeclarationSyntax>> entry in raw)
        {
            List<TypeDeclarationSyntax> kept = entry.Value
                .Where(p => retainedFilePaths.Contains(p.SyntaxTree.FilePath))
                .ToList();
            if (kept.Count > 1)
            {
                result[entry.Key] = kept;
            }
        }

        return result;
    }

    // Issue #1910 (gap 3): for every partial type whose PRIMARY part lives in
    // `root`, collect the distinct `SyntaxTree`s of its OTHER (non-primary)
    // parts. Those trees' `using` directives are unioned into `root`'s import
    // block by `TranslateImports`, because merged-in member bodies from those
    // parts are translated under their own file's semantic model and may rely
    // on a `using` that only exists there.
    private static HashSet<Microsoft.CodeAnalysis.SyntaxTree> CollectExtraUsingTrees(
        CompilationUnitSyntax root,
        Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> partialTypeParts)
    {
        var trees = new HashSet<Microsoft.CodeAnalysis.SyntaxTree>();
        foreach (List<TypeDeclarationSyntax> parts in partialTypeParts.Values)
        {
            if (parts[0].SyntaxTree != root.SyntaxTree)
            {
                continue;
            }

            foreach (TypeDeclarationSyntax part in parts.Skip(1))
            {
                if (part.SyntaxTree != root.SyntaxTree)
                {
                    trees.Add(part.SyntaxTree);
                }
            }
        }

        return trees;
    }

    private static HashSet<Microsoft.CodeAnalysis.SyntaxTree> CollectOwnedExtensionUsingTrees(
        CompilationUnitSyntax root,
        TranslationContext context,
        OwnedExtensionRegistry ownedExtensions)
    {
        var trees = new HashSet<Microsoft.CodeAnalysis.SyntaxTree>();
        foreach (TypeDeclarationSyntax declaration in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
        {
            if (context.GetDeclaredSymbol(declaration) is not INamedTypeSymbol type ||
                !ownedExtensions.TryGetMethods(type, out IReadOnlyList<MethodDeclarationSyntax> methods))
            {
                continue;
            }

            foreach (MethodDeclarationSyntax method in methods)
            {
                if (method.SyntaxTree != root.SyntaxTree)
                {
                    trees.Add(method.SyntaxTree);
                }
            }
        }

        return trees;
    }

    private static HashSet<INamedTypeSymbol> CollectSubclassedBaseTypes(Compilation compilation)
    {
        var bases = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        foreach (INamedTypeSymbol type in EnumerateNamedTypes(compilation.Assembly.GlobalNamespace))
        {
            INamedTypeSymbol baseType = type.BaseType;
            if (baseType != null &&
                baseType.SpecialType != SpecialType.System_Object &&
                baseType.TypeKind == TypeKind.Class)
            {
                bases.Add(baseType.OriginalDefinition);
            }
        }

        return bases;
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateNamedTypes(INamespaceSymbol ns)
    {
        foreach (INamedTypeSymbol type in ns.GetTypeMembers())
        {
            yield return type;
            foreach (INamedTypeSymbol nested in EnumerateNestedTypes(type))
            {
                yield return nested;
            }
        }

        foreach (INamespaceSymbol child in ns.GetNamespaceMembers())
        {
            foreach (INamedTypeSymbol type in EnumerateNamedTypes(child))
            {
                yield return type;
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateNestedTypes(INamedTypeSymbol type)
    {
        foreach (INamedTypeSymbol nested in type.GetTypeMembers())
        {
            yield return nested;
            foreach (INamedTypeSymbol deeper in EnumerateNestedTypes(nested))
            {
                yield return deeper;
            }
        }
    }

    private string ResolvePackage(CompilationUnitSyntax root, TranslationContext context)
    {
        List<(string Name, Location Location)> namespaces = EnumerateTopLevelDeclarations(root)
            .Select(member => (
                Symbol: context.GetDeclaredSymbol(member),
                Location: member.GetLocation()))
            .Where(item => item.Symbol?.ContainingNamespace is { IsGlobalNamespace: false })
            .Select(item => (
                item.Symbol.ContainingNamespace.ToDisplayString(),
                item.Location))
            .ToList();

        if (namespaces.Count == 0)
        {
            return null;
        }

        string dominant = namespaces[0].Name;
        IEnumerable<string> distinct = namespaces.Select(n => n.Name).Distinct();
        if (distinct.Count() > 1)
        {
            context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.NamespaceDeclaration),
                $"Multiple namespaces in one file; hoisting to the dominant namespace '{dominant}' (ADR-0115 §B.1).",
                namespaces[0].Location,
                TranslationSeverity.Warning));
        }

        return dominant;
    }

    private IReadOnlyList<ImportDirective> TranslateImports(
        CompilationUnitSyntax root,
        IEnumerable<Microsoft.CodeAnalysis.SyntaxTree> extraUsingTrees,
        TranslationContext context)
    {
        var imports = new List<ImportDirective>();
        var seen = new HashSet<(string Name, string Alias)>();
        IEnumerable<UsingDirectiveSyntax> usings = root.Usings
            .Concat(root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>().SelectMany(n => n.Usings));

        foreach (Microsoft.CodeAnalysis.SyntaxTree extraTree in extraUsingTrees)
        {
            CompilationUnitSyntax extraRoot = (CompilationUnitSyntax)extraTree.GetRoot();
            usings = usings.Concat(extraRoot.Usings)
                .Concat(extraRoot.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>().SelectMany(n => n.Usings));
        }

        foreach (UsingDirectiveSyntax directive in usings)
        {
            // C# 12 alias-any-type directives (`using X = (int, string);`,
            // arrays, pointers, nullable value types, ...) put a non-name
            // TypeSyntax where a plain dotted name used to be the only option;
            // `directive.Name` is null for those (issue #1914). `NamespaceOrType`
            // is the generalized property that covers both forms.
            TypeSyntax namespaceOrType = directive.NamespaceOrType;
            if (namespaceOrType is null)
            {
                context.ReportUnsupported(directive, "using directive without a resolvable name.");
                continue;
            }

            string alias = directive.Alias?.Name.Identifier.Text;

            if (namespaceOrType is not NameSyntax)
            {
                // G#'s `import` statement (ImportSyntax) only spells a
                // dotted-identifier path, so a tuple/array/pointer/nullable
                // alias target has no faithful import line to emit. That is
                // harmless: every USE of the alias resolves through the
                // semantic model straight to its underlying type (e.g. a
                // tuple-alias use-site maps to G#'s positional
                // TupleTypeReference the same as a written-out tuple type), so
                // the alias fully expands at each reference without needing an
                // import (issue #1914). Only array/pointer/nullable-value-type
                // RHS forms remain unexercised by the corpus; tuple RHS is the
                // one this issue asks for.
                if (alias != null)
                {
                    context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.UsingDirective),
                        $"'using {alias} = {namespaceOrType}' aliases a type G#'s import statement cannot spell; omitted from the import block, but every use of '{alias}' still expands to its underlying G# type (issue #1914).",
                        directive.GetLocation(),
                        TranslationSeverity.Warning));
                }

                continue;
            }

            // Issue #2222: strip a `global::` alias-qualifier prefix before
            // recording the import name — `using global::Foo.Bar;` must
            // become `import Foo.Bar`, not the unparseable `import
            // global::Foo.Bar` (G#'s import syntax has no alias-qualifier
            // form).
            string name = CSharpTypeMapper.StripGlobalPrefix(namespaceOrType.ToString());

            if (!directive.StaticKeyword.IsKind(SyntaxKind.None))
            {
                // Issue #1201 / ADR-0134: a C# `using static X` translates to a
                // bare type import `import X`, which gsc now hoists X's `shared`
                // (static) members into scope for unqualified reference — so the
                // member references are emitted bare (NOT qualified through X).
                // An alias on a `using static` has no unqualified-hoisting form
                // and degrades to a plain (alias) import.
                if (alias != null)
                {
                    context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.UsingDirective),
                        $"'using static {name}' with an alias has no G# member-hoisting form; emitted as a plain import (ADR-0134).",
                        directive.GetLocation(),
                        TranslationSeverity.Warning));
                }
            }

            // Issue #1910 (gap 3): dedup by (name, alias) once non-primary
            // parts' `using` directives are unioned in — the same directive
            // commonly appears in both files.
            if (seen.Add((name, alias)))
            {
                imports.Add(new ImportDirective(name, alias));
            }
        }

        return imports;
    }

    /// <summary>
    /// Issue #1201 / ADR-0134: collects the type symbols targeted by C#
    /// <c>using static X</c> directives in the document. Members referenced from
    /// such a directive are brought into unqualified scope in G# by the bare
    /// type import <c>import X</c>, so the translator must NOT qualify those
    /// references through the owning type (unlike a sibling static, which still
    /// needs qualification). Aliased <c>using static</c> directives are excluded:
    /// an alias does not hoist members. Original definitions are stored so the
    /// comparison is stable across constructed generics.
    /// </summary>
    private static HashSet<INamedTypeSymbol> CollectStaticUsingTargets(CompilationUnitSyntax root, TranslationContext context)
    {
        var targets = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        IEnumerable<UsingDirectiveSyntax> usings = root.Usings
            .Concat(root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>().SelectMany(n => n.Usings));

        foreach (UsingDirectiveSyntax directive in usings)
        {
            if (directive.StaticKeyword.IsKind(SyntaxKind.None)
                || directive.Name is null
                || directive.Alias != null)
            {
                continue;
            }

            if (context.GetSymbolInfo(directive.Name).Symbol is INamedTypeSymbol typeSymbol)
            {
                targets.Add(typeSymbol.OriginalDefinition);
            }
        }

        return targets;
    }

    /// <summary>
    /// The step-6 declaration dispatcher: a <see cref="CSharpSyntaxVisitor{TResult}"/>
    /// that maps each type declaration (kind, name, visibility, generics, base
    /// clause) and its member signatures + fields. Method / property /
    /// constructor bodies are routed through <see cref="TranslateBody"/>, which
    /// emits a parseable placeholder block today (step 7 replaces it). Every
    /// construct with no canonical G# form is recorded as a structured
    /// <see cref="TranslationDiagnostic"/> rather than dropped.
    /// </summary>
    private sealed partial class DeclarationVisitor : CSharpSyntaxVisitor<GMember>
    {
        private readonly TranslationContext context;
        private readonly CSharpTypeMapper typeMapper;
        private readonly HashSet<INamedTypeSymbol> subclassedBases;

        // Issue #1910: every `partial` type symbol with more than one
        // declaration part, mapped to its parts in canonical (deterministic)
        // order — see `CSharpToGSharpTranslator.CollectPartialTypeParts`. Only
        // `parts[0]` (the "primary" part) is translated into a G# type
        // declaration; every other part's members are merged into it.
        private readonly Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> partialTypeParts;

        // Issue #2821: same-package source extension methods are emitted as
        // members of their owned receiver type, not as top-level receiver funcs.
        private readonly OwnedExtensionRegistry ownedExtensions;

        // ADR-0145 (§C/§D): when true, `partial` parts are NOT merged — every
        // part is emitted as its own standalone G# `partial` declaration (using
        // only its own members), so a generated part augments the user's real G#
        // type (ADR-0144). See `CSharpToGSharpTranslator.preservePartialParts`.
        private readonly bool preservePartialParts;

        // Issue #2215: see `CSharpToGSharpTranslator.markMergedTypePartial`.
        private readonly bool markMergedTypePartial;

        // Issue #2610: see
        // `CSharpToGSharpTranslator.widenObliviousReferenceFields`.
        private readonly bool widenObliviousReferenceFields;

        // Issue #1201 / ADR-0134: the types targeted by `using static X` in this
        // document. A bare reference to one of their static members is left
        // UNQUALIFIED (gsc resolves it through `import X`), unlike a sibling
        // static, which is qualified through its owning type.
        private readonly HashSet<INamedTypeSymbol> staticUsingTargets;

        // The set of hard G# keywords (Cs2Gs.Compiler SyntaxFacts.GetKeywordKind).
        // A C# identifier that collides with one of these cannot be emitted bare; it
        // is suffixed with `_` consistently at every declaration and reference site.
        private static readonly HashSet<string> GSharpReservedWords = new HashSet<string>(System.StringComparer.Ordinal)
        {
            "as", "async", "await", "break", "case", "catch", "chan", "class", "const",
            "continue", "default", "defer", "do", "else", "enum", "false", "fallthrough",
            "finally", "for", "func", "go", "goto", "guard", "if", "import", "interface",
            "internal", "is", "let", "lock", "map", "nil", "open", "operator", "override",
            "package", "private", "protected", "public", "range", "return", "scope",
            "sealed", "select", "sequence", "struct", "switch", "throw", "true", "try",
            "type", "using", "var", "while",
        };

        // gsc's ADR-0044 implicit numeric widening lattice (mirrors
        // Conversion.NumericWideningTargets), keyed on the C# SpecialType of the
        // source → set of widening targets. `char` widens like an unsigned 16-bit
        // integer; `decimal` is a widening target of every integral source. Used by
        // the call-site argument coercion (issue #1281) to drop a redundant explicit
        // conversion when gsc already widens the operand implicitly.
        private static readonly Dictionary<SpecialType, HashSet<SpecialType>> NumericWideningTargets = new()
        {
            [SpecialType.System_SByte] = new() { SpecialType.System_Int16, SpecialType.System_Int32, SpecialType.System_Int64, SpecialType.System_IntPtr, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_Byte] = new() { SpecialType.System_Int16, SpecialType.System_UInt16, SpecialType.System_Int32, SpecialType.System_UInt32, SpecialType.System_Int64, SpecialType.System_UInt64, SpecialType.System_IntPtr, SpecialType.System_UIntPtr, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_Int16] = new() { SpecialType.System_Int32, SpecialType.System_Int64, SpecialType.System_IntPtr, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_UInt16] = new() { SpecialType.System_Int32, SpecialType.System_UInt32, SpecialType.System_Int64, SpecialType.System_UInt64, SpecialType.System_IntPtr, SpecialType.System_UIntPtr, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_Int32] = new() { SpecialType.System_Int64, SpecialType.System_IntPtr, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_UInt32] = new() { SpecialType.System_Int64, SpecialType.System_UInt64, SpecialType.System_UIntPtr, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_Int64] = new() { SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_UInt64] = new() { SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_IntPtr] = new() { SpecialType.System_Int64, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_UIntPtr] = new() { SpecialType.System_UInt64, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_Char] = new() { SpecialType.System_UInt16, SpecialType.System_Int32, SpecialType.System_UInt32, SpecialType.System_Int64, SpecialType.System_UInt64, SpecialType.System_IntPtr, SpecialType.System_UIntPtr, SpecialType.System_Single, SpecialType.System_Double, SpecialType.System_Decimal },
            [SpecialType.System_Single] = new() { SpecialType.System_Double },
        };

        // The C# program entry type (the static class containing `Main`). Its
        // members are flattened to top-level G# funcs (never a `shared { }`
        // block), so a sibling static call inside it must stay bare rather than
        // be qualified through a non-existent type (ADR-0115 §B.1/§B.18).
        private readonly INamedTypeSymbol entryType;
        private readonly HashSet<INamedTypeSymbol> efEntityTypes;

        // The per-document MUTABLE working state (caches, suppression/pending
        // sets, per-scope scalars set-and-restored around nested scopes, and
        // the monotonic name counters). Extracted into its own object (#1361
        // Wave 2, T-1) so "where state lives" is decoupled from "where behavior
        // lives"; the visitor methods reference `this.state.X`. Created here,
        // one instance per document, matching the previous per-document field
        // lifetime exactly.
        private readonly DocumentTranslationState state = new DocumentTranslationState();

        public DeclarationVisitor(
            TranslationContext context,
            CSharpTypeMapper typeMapper,
            HashSet<INamedTypeSymbol> subclassedBases,
            HashSet<INamedTypeSymbol> staticUsingTargets,
            IMethodSymbol entryPoint,
            Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>> partialTypeParts,
            OwnedExtensionRegistry ownedExtensions,
            bool preservePartialParts = false,
            bool markMergedTypePartial = false,
            bool widenObliviousReferenceFields = false)
        {
            this.context = context;
            this.typeMapper = typeMapper;
            this.subclassedBases = subclassedBases;
            this.staticUsingTargets = staticUsingTargets ?? new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            this.partialTypeParts = partialTypeParts ?? new Dictionary<INamedTypeSymbol, List<TypeDeclarationSyntax>>(SymbolEqualityComparer.Default);
            this.ownedExtensions = ownedExtensions ?? new OwnedExtensionRegistry(context.Compilation.Assembly);
            this.preservePartialParts = preservePartialParts;
            this.markMergedTypePartial = markMergedTypePartial;
            this.widenObliviousReferenceFields = widenObliviousReferenceFields;
            this.efEntityTypes = ObliviousNullabilityAnalyzer.CollectEfEntityTypes(context.Compilation);

            // `entryPoint` is threaded in by the caller (`TranslateDocument`)
            // instead of being recomputed here: `Compilation.GetEntryPoint`
            // re-walks the compilation and was otherwise called twice per
            // document (once by the caller, once here).
            this.entryType = entryPoint?.ContainingType;
        }

        public IReadOnlyList<AttributeUse> MapFileAttributes(IEnumerable<AttributeListSyntax> attributeLists) =>
            this.MapAttributes(attributeLists);

        public override GMember VisitClassDeclaration(ClassDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitStructDeclaration(StructDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitRecordDeclaration(RecordDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitInterfaceDeclaration(InterfaceDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitDelegateDeclaration(DelegateDeclarationSyntax node) =>
            this.TranslateDelegateDeclaration(node);
    }

    private sealed class OwnedExtensionRegistry
    {
        private readonly IAssemblySymbol assembly;

        private readonly Dictionary<INamedTypeSymbol, List<MethodDeclarationSyntax>> methodsByReceiver =
            new(SymbolEqualityComparer.Default);

        private readonly Dictionary<MethodDeclarationSyntax, INamedTypeSymbol> receiversByMethod =
            new();

        private readonly HashSet<(Microsoft.CodeAnalysis.SyntaxTree Tree, int Start, int Length)> staticHelpers =
            new();

        private readonly HashSet<(Microsoft.CodeAnalysis.SyntaxTree Tree, int Start, int Length)> receiverCompanions =
            new();

        public OwnedExtensionRegistry(IAssemblySymbol assembly = null)
        {
            this.assembly = assembly;
        }

        public void Add(INamedTypeSymbol receiver, MethodDeclarationSyntax method)
        {
            if (!this.methodsByReceiver.TryGetValue(receiver, out List<MethodDeclarationSyntax> methods))
            {
                methods = new List<MethodDeclarationSyntax>();
                this.methodsByReceiver.Add(receiver, methods);
            }

            methods.Add(method);
            this.receiversByMethod.Add(method, receiver);
        }

        public bool Contains(MethodDeclarationSyntax method) =>
            this.receiversByMethod.ContainsKey(method);

        public void AddStaticHelper(MethodDeclarationSyntax method) =>
            this.staticHelpers.Add((method.SyntaxTree, method.SpanStart, method.Span.Length));

        public void AddReceiverCompanion(MethodDeclarationSyntax method) =>
            this.receiverCompanions.Add((method.SyntaxTree, method.SpanStart, method.Span.Length));

        public bool IsStaticHelper(IMethodSymbol method)
        {
            IMethodSymbol original = method?.ReducedFrom ?? method;
            if (original == null)
            {
                return false;
            }

            if (original.DeclaringSyntaxReferences.Any(
                    reference => this.staticHelpers.Contains(
                        (reference.SyntaxTree, reference.Span.Start, reference.Span.Length))))
            {
                return true;
            }

            // Referenced projects do not share this compilation's syntax-keyed
            // registry. Re-run the declaration-only rule on metadata symbols.
            return !SymbolEqualityComparer.Default.Equals(original.ContainingAssembly, this.assembly) &&
                IsReproducibleStaticHelper(original);
        }

        public bool HasReceiverCompanion(MethodDeclarationSyntax method) =>
            method != null &&
            this.receiverCompanions.Contains((method.SyntaxTree, method.SpanStart, method.Span.Length));

        public bool HasReceiverCompanion(IMethodSymbol method)
        {
            IMethodSymbol original = method?.ReducedFrom ?? method;
            if (original == null)
            {
                return false;
            }

            if (original.DeclaringSyntaxReferences.Any(
                    reference => this.receiverCompanions.Contains(
                        (reference.SyntaxTree, reference.Span.Start, reference.Span.Length))))
            {
                return true;
            }

            return !SymbolEqualityComparer.Default.Equals(original.ContainingAssembly, this.assembly) &&
                IsReproducibleReceiverCompanion(original);
        }

        public bool TryGetMethods(
            INamedTypeSymbol receiver,
            out IReadOnlyList<MethodDeclarationSyntax> methods)
        {
            if (receiver != null &&
                this.methodsByReceiver.TryGetValue(receiver.OriginalDefinition, out List<MethodDeclarationSyntax> found))
            {
                methods = found;
                return true;
            }

            methods = Array.Empty<MethodDeclarationSyntax>();
            return false;
        }

        public OwnedExtensionRegistry Filter(HashSet<string> retainedFilePaths)
        {
            if (retainedFilePaths is null)
            {
                return this;
            }

            var filtered = new OwnedExtensionRegistry(this.assembly);
            foreach (KeyValuePair<INamedTypeSymbol, List<MethodDeclarationSyntax>> entry in this.methodsByReceiver)
            {
                bool targetIsRetained = entry.Key.DeclaringSyntaxReferences.Any(
                    r => retainedFilePaths.Contains(r.SyntaxTree.FilePath));
                if (!targetIsRetained)
                {
                    continue;
                }

                foreach (MethodDeclarationSyntax method in entry.Value)
                {
                    if (retainedFilePaths.Contains(method.SyntaxTree.FilePath))
                    {
                        filtered.Add(entry.Key, method);
                    }
                }
            }

            foreach ((Microsoft.CodeAnalysis.SyntaxTree tree, int start, int length) in this.staticHelpers)
            {
                if (retainedFilePaths.Contains(tree.FilePath))
                {
                    filtered.staticHelpers.Add((tree, start, length));
                }
            }

            foreach ((Microsoft.CodeAnalysis.SyntaxTree tree, int start, int length) in this.receiverCompanions)
            {
                if (retainedFilePaths.Contains(tree.FilePath))
                {
                    filtered.receiverCompanions.Add((tree, start, length));
                }
            }

            return filtered;
        }
    }
}
