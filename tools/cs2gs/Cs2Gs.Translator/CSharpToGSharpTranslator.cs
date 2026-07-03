// <copyright file="CSharpToGSharpTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

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
public sealed class CSharpToGSharpTranslator
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

        string package = this.ResolvePackage(root, context);
        IReadOnlyList<ImportDirective> imports = this.TranslateImports(root, context);

        HashSet<INamedTypeSymbol> openBases = GetOrCollectSubclassedBaseTypes(context.Compilation);
        HashSet<INamedTypeSymbol> staticUsingTargets = CollectStaticUsingTargets(root, context);

        // T3 (ADR-0115 §B.1/§B.11): the C# program entry point and its enclosing
        // static class become top-level G#. The entry `Main` body translates to
        // top-level statements (the program entry in G# is top-level statements,
        // not a `Main` method) and the sibling static methods become top-level
        // `func`s — never a `shared { }` block.
        //
        // Computed once here and threaded through so the visitor does not
        // recompute it (`Compilation.GetEntryPoint` re-walks the compilation).
        IMethodSymbol entryPoint = context.Compilation.GetEntryPoint(default);
        INamedTypeSymbol entryType = entryPoint?.ContainingType;

        var visitor = new DeclarationVisitor(context, new CSharpTypeMapper(), openBases, staticUsingTargets, entryPoint);

        var members = new List<GNode>();
        var trailingStatements = new List<GNode>();
        foreach (MemberDeclarationSyntax member in EnumerateTopLevelDeclarations(root))
        {
            if (entryType != null
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

            // Owned-struct receiver methods (issue #938) are emitted as siblings
            // immediately after their owning type so they read together.
            members.AddRange(visitor.DrainPendingTopLevel());
        }

        // Top-level statements are appended after every declaration so the program
        // entry runs with all package types and funcs already in scope.
        members.AddRange(trailingStatements);

        return new CompilationUnit(package, imports, members);
    }

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
        List<BaseNamespaceDeclarationSyntax> namespaces = root.DescendantNodes()
            .OfType<BaseNamespaceDeclarationSyntax>()
            .ToList();

        if (namespaces.Count == 0)
        {
            return null;
        }

        string dominant = namespaces[0].Name.ToString();
        IEnumerable<string> distinct = namespaces.Select(n => n.Name.ToString()).Distinct();
        if (distinct.Count() > 1)
        {
            context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.NamespaceDeclaration),
                $"Multiple namespaces in one file; hoisting to the dominant namespace '{dominant}' (ADR-0115 §B.1).",
                namespaces[0].Name.GetLocation(),
                TranslationSeverity.Warning));
        }

        return dominant;
    }

    private IReadOnlyList<ImportDirective> TranslateImports(CompilationUnitSyntax root, TranslationContext context)
    {
        var imports = new List<ImportDirective>();
        IEnumerable<UsingDirectiveSyntax> usings = root.Usings
            .Concat(root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>().SelectMany(n => n.Usings));

        foreach (UsingDirectiveSyntax directive in usings)
        {
            if (directive.Name is null)
            {
                context.ReportUnsupported(directive, "using directive without a resolvable name.");
                continue;
            }

            string name = directive.Name.ToString();
            string alias = directive.Alias?.Name.Identifier.Text;

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

            imports.Add(new ImportDirective(name, alias));
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
    private sealed class DeclarationVisitor : CSharpSyntaxVisitor<GMember>
    {
        private readonly TranslationContext context;
        private readonly CSharpTypeMapper typeMapper;
        private readonly HashSet<INamedTypeSymbol> subclassedBases;

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
            "internal", "is", "let", "map", "nil", "open", "operator", "override",
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

        // Owned struct / data-struct instance methods cannot live in the type
        // body (the parser rejects an in-body `func`); they are lifted to
        // top-level receiver-clause `func`s emitted as siblings of the type
        // (issue #938, ADR-0115 §B.5). Collected here per aggregate and drained
        // by the document translator.
        private readonly List<GMember> pendingTopLevelDeclarations = new List<GMember>();

        // While translating a switch-expression arm whose C# pattern bound a
        // variable through a property subpattern (`Circle { Radius: var r }`), the
        // bound variable has no G# pattern equivalent; it is rewritten to a member
        // access on the arm's type-pattern designator (`circle.Radius`). The map
        // from the bound local symbol to its replacement expression is consulted
        // by reference-translation (ADR-0115 §B switch lowering).
        private readonly Dictionary<ISymbol, GExpression> patternBindings =
            new Dictionary<ISymbol, GExpression>(SymbolEqualityComparer.Default);

        // Pattern variables (`x is T t`) that <see cref="TryBuildPositiveGuardHoist"/>
        // materialised as a *nullable* G# local (`var t T? = scrutinee as T`). gsc
        // flow-narrows such a local for reads inside the `if t != nil { … }` guard,
        // but NOT for an assignment-LHS receiver (`t.Member = v`), so those writes
        // need an explicit `t!!`. Tracked because the C# semantic model reports the
        // pattern variable as the non-null `T`, which the read-side null-forgiveness
        // predicate would otherwise treat as not needing an assertion.
        private readonly HashSet<ISymbol> hoistedNullableGuardLocals =
            new HashSet<ISymbol>(SymbolEqualityComparer.Default);

        // C# post-increment/decrement (`i++`, `i--`) sub-expressions that the
        // surrounding statement seam has hoisted into trailing `i++` statements
        // (G# models inc/dec as statements, not expressions; spec §Statements).
        // While a node is in this set, `TranslateExpression` renders it as a bare
        // read of its operand (the pre-increment value).
        private readonly HashSet<SyntaxNode> suppressedPostfix =
            new HashSet<SyntaxNode>();

        // C# assignment-expressions used in VALUE position (`while ((line =
        // r.ReadLine()) != null)`, `M(x = 5)`, `if ((x = f()) > 0)`) that the
        // surrounding statement/condition seam has hoisted into a preceding
        // assignment statement (G# assignment is a statement, not a
        // value-yielding expression; spec §Statements). While a node is in this
        // set, `TranslateExpression` renders it as a bare read of its already-
        // written target rather than dropping the write (issue #1723).
        private readonly HashSet<SyntaxNode> suppressedAssignments =
            new HashSet<SyntaxNode>();

        // Static-field initializers lifted out of a `static` constructor body
        // (`static T() { Field = value; }`). G# has no static constructor, so a
        // simple static ctor is folded into the corresponding `shared { }` field
        // initializers and the ctor itself is dropped (ADR-0115 §B.11).
        private readonly Dictionary<ISymbol, GExpression> staticFieldInitializers =
            new Dictionary<ISymbol, GExpression>(SymbolEqualityComparer.Default);

        // The syntax node whose body is currently being translated. It bounds the
        // data-flow scan that decides whether a local is mutable (var) or
        // immutable (let) per ADR-0115 §B.3.
        private SyntaxNode currentBodyScope;

        // Monotonic counter for synthesizing unique temporaries when lowering
        // tuple-deconstruction assignments (`(a, b) = (x, y)`); ADR-0115 §B.
        private int deconCounter;

        // Monotonic counter for synthesizing the hoist local when a loop condition
        // carries a binder-less side-effecting `is`-pattern clause (issue #914).
        private int loopHoistCounter;

        // The active statement-seam prologue (issue #1731): several lowerings
        // (lock targets, chained-assignment link targets, non-trivial pattern
        // scrutinees, range-slice start operands) must embed the SAME translated
        // operand at more than one output position; naively reusing the operand's
        // node would print — and so re-evaluate — it once per embed. `SpillOperand`
        // hoists such an operand into a fresh `let` appended here, evaluated
        // exactly once immediately before the statement currently being
        // translated (see <see cref="WithSpillSeam"/>). Null outside any
        // statement seam and across a lambda/local-function boundary (its body is
        // a distinct evaluation scope; see <see cref="TranslateLambda"/> and
        // <see cref="TranslateLocalFunction"/>) so a hoist can never leak into an
        // unrelated enclosing scope — in that case `SpillOperand` conservatively
        // leaves the operand embedded as-is.
        private List<GStatement> pendingSpillPrologue;

        // Monotonic counter for synthesizing spill temporaries (issue #1731).
        private int spillCounter;

        // When translating the body of a lifted owned-value-aggregate receiver
        // method (issue #938), the implicit `this.` of a bare instance-member
        // reference must be made explicit through the receiver name (`self.`),
        // because a top-level receiver-clause `func` has no implicit receiver.
        private string currentReceiverName;

        // The exception variable bound by the innermost enclosing `catch` clause,
        // used to translate a C# re-throw (`throw;`) — which has no bare G# form —
        // to `throw <caughtVar>` (ADR-0115 §B).
        private string currentCatchVariable;

        public DeclarationVisitor(
            TranslationContext context,
            CSharpTypeMapper typeMapper,
            HashSet<INamedTypeSymbol> subclassedBases,
            HashSet<INamedTypeSymbol> staticUsingTargets,
            IMethodSymbol entryPoint)
        {
            this.context = context;
            this.typeMapper = typeMapper;
            this.subclassedBases = subclassedBases;
            this.staticUsingTargets = staticUsingTargets ?? new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);

            // `entryPoint` is threaded in by the caller (`TranslateDocument`)
            // instead of being recomputed here: `Compilation.GetEntryPoint`
            // re-walks the compilation and was otherwise called twice per
            // document (once by the caller, once here).
            this.entryType = entryPoint?.ContainingType;
        }

        public override GMember VisitClassDeclaration(ClassDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitStructDeclaration(StructDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitRecordDeclaration(RecordDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitInterfaceDeclaration(InterfaceDeclarationSyntax node) => this.VisitAggregate(node);

        /// <summary>
        /// Removes and returns the top-level declarations (lifted owned-struct
        /// receiver methods, issue #938) collected while translating the most
        /// recent aggregate, so the document translator can emit them as siblings.
        /// </summary>
        /// <returns>The collected top-level declarations (possibly empty).</returns>
        public IReadOnlyList<GMember> DrainPendingTopLevel()
        {
            if (this.pendingTopLevelDeclarations.Count == 0)
            {
                return System.Array.Empty<GMember>();
            }

            var drained = new List<GMember>(this.pendingTopLevelDeclarations);
            this.pendingTopLevelDeclarations.Clear();
            return drained;
        }

        public override GMember VisitEnumDeclaration(EnumDeclarationSyntax node)
        {
            ISymbol symbol = this.context.GetDeclaredSymbol(node);
            var cases = new List<EnumCase>();
            foreach (EnumMemberDeclarationSyntax member in node.Members)
            {
                if (member.EqualsValue != null)
                {
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.EnumMemberDeclaration),
                        $"enum case '{member.Identifier.Text}' has an explicit value; the value is dropped (ADR-0115 §B.11 maps enum cases by name).",
                        member.GetLocation(),
                        TranslationSeverity.Info));
                }

                cases.Add(new EnumCase(SanitizeIdentifier(member.Identifier.Text)));
            }

            return new EnumDeclaration(SanitizeIdentifier(node.Identifier.Text), cases, MapVisibility(symbol, this.context, node));
        }

        public override GMember DefaultVisit(SyntaxNode node)
        {
            this.context.ReportUnsupported(
                node,
                $"'{node.Kind()}' has no canonical G# declaration mapping; recorded for triage (ADR-0115 §B).");
            return null;
        }

        /// <summary>
        /// T3 (ADR-0115 §B.1/§B.11): translates the C# program entry point's
        /// enclosing static class into top-level G#. The entry method's body
        /// becomes top-level statements (the G# program entry), and every other
        /// static method becomes a top-level <c>func</c>. The class itself — and
        /// any <c>shared { }</c> wrapping — is dropped.
        /// </summary>
        /// <param name="node">The entry point's enclosing type declaration.</param>
        /// <param name="entryPoint">The bound entry-point method symbol.</param>
        /// <returns>The hoisted top-level funcs and the entry top-level statements.</returns>
        public (IReadOnlyList<GNode> Funcs, IReadOnlyList<GNode> Statements) TranslateEntryType(
            TypeDeclarationSyntax node,
            IMethodSymbol entryPoint)
        {
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.ClassDeclaration),
                $"C# entry point '{entryPoint.ContainingType.Name}.{entryPoint.Name}' and its enclosing static class are hoisted to top level: the entry body becomes top-level statements and sibling static methods become top-level 'func's (no 'shared {{ }}' block) (ADR-0115 §B.1/§B.11 / T3).",
                node.GetLocation(),
                TranslationSeverity.Info));

            var funcs = new List<GNode>();
            var statements = new List<GNode>();

            foreach (MemberDeclarationSyntax member in node.Members)
            {
                switch (member)
                {
                    case MethodDeclarationSyntax method
                        when SymbolEqualityComparer.Default.Equals(
                            this.context.GetDeclaredSymbol(method), entryPoint):
                        BlockStatement body = this.TranslateBody(method, $"entry point '{entryPoint.Name}'");
                        statements.AddRange(body.Statements);
                        break;

                    case MethodDeclarationSyntax method:
                        (GMember func, _) = this.TranslateMethod(method, TypeDeclarationKind.Class);
                        funcs.Add(func);
                        break;

                    default:
                        this.context.ReportUnsupported(
                            member,
                            $"member '{member.Kind()}' of the entry class has no top-level G# mapping yet (ADR-0115 §B.11 / T3).");
                        break;
                }
            }

            return (funcs, statements);
        }

        // The set of hard G# keywords (Cs2Gs.Compiler SyntaxFacts.GetKeywordKind).
        // A C# identifier that collides with one of these cannot be emitted bare; it
        // is suffixed with `_` consistently at every declaration and reference site.
        // Internal (not private) so the outer <see cref="CSharpToGSharpTranslator"/>
        // forwarding method can expose it to <see cref="CSharpTypeMapper"/>, which
        // routes type-name references through this exact sanitizer too (issue
        // #1734).
        internal static string SanitizeIdentifier(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }

            // C# verbatim identifiers (`@default`, `@class`) carry a leading `@`
            // in their syntax text; G# has no verbatim-identifier escape, so strip
            // it before the reserved-word check (the bare name is then suffixed if
            // it still collides with a G# keyword).
            if (name[0] == '@')
            {
                name = name.Substring(1);
            }

            return GSharpReservedWords.Contains(name) ? name + "_" : name;
        }

        /// <summary>
        /// Issue #1201 / ADR-0134: whether <paramref name="owner"/> is a type
        /// brought into unqualified static scope by a <c>using static</c>
        /// directive in this document. Bare references to such a type's static
        /// members are emitted unqualified (gsc hoists them through the bare
        /// type import) rather than qualified through the owning type name.
        /// </summary>
        /// <param name="owner">The static member's containing type.</param>
        /// <returns><c>true</c> when the owner is a <c>using static</c> target.</returns>
        private bool IsStaticUsingTarget(INamedTypeSymbol owner)
            => owner != null && this.staticUsingTargets.Contains(owner.OriginalDefinition);

        private static Visibility MapVisibility(ISymbol symbol, TranslationContext context, SyntaxNode node)
        {
            if (symbol is null)
            {
                return Visibility.Default;
            }

            switch (symbol.DeclaredAccessibility)
            {
                case Accessibility.Public:
                    // public is the canonical default for both top-level and member
                    // positions, so it is omitted (ADR-0115 §B.10).
                    return Visibility.Default;
                case Accessibility.Private:
                    return Visibility.Private;
                case Accessibility.Internal:
                    return Visibility.Internal;
                case Accessibility.Protected:
                    // Issue #950: G# now has a first-class `protected` modifier
                    // (CIL family). It is only valid on members of an `open`
                    // class; the translator emits `open` on translatable
                    // non-sealed classes so this maps cleanly.
                    return Visibility.Protected;
                case Accessibility.ProtectedOrInternal:
                case Accessibility.ProtectedAndInternal:
                    // `protected internal` (family-or-assembly) and
                    // `private protected` (family-and-assembly) have no single
                    // G# spelling; map to the nearest accessibility 'internal'.
                    context.Report(new TranslationDiagnostic(
                        symbol.DeclaredAccessibility.ToString(),
                        $"'{symbol.Name}' is '{symbol.DeclaredAccessibility}'; G# has no combined 'protected internal'/'private protected' spelling, mapped to the nearest accessibility 'internal' (ADR-0115 §B.10).",
                        node?.GetLocation(),
                        TranslationSeverity.Warning));
                    return Visibility.Internal;
                default:
                    return Visibility.Default;
            }
        }

        /// <summary>
        /// Issue #950: returns <see langword="true"/> when <paramref name="type"/>
        /// declares any member with a <c>protected</c>-family accessibility.
        /// Such a class is intended for inheritance, so it must be emitted as an
        /// <c>open class</c> for the G# <c>protected</c> modifier to be valid.
        /// </summary>
        private static bool HasProtectedMember(INamedTypeSymbol type)
        {
            foreach (var member in type.GetMembers())
            {
                switch (member.DeclaredAccessibility)
                {
                    case Accessibility.Protected:
                    case Accessibility.ProtectedOrInternal:
                    case Accessibility.ProtectedAndInternal:
                        return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Determines whether <paramref name="type"/> will be emitted as an
        /// <c>open class</c> in G#. Mirrors the class-declaration openness logic in
        /// <see cref="VisitAggregate"/> so member-level <c>open</c> is only emitted
        /// when the enclosing class is itself open (otherwise GS0190).
        /// </summary>
        private bool IsTypeEmittedOpen(INamedTypeSymbol type)
        {
            if (type == null || type.TypeKind != TypeKind.Class || type.IsStatic)
            {
                return false;
            }

            if (type.IsAbstract || HasProtectedMember(type))
            {
                return true;
            }

            return !type.IsSealed && this.subclassedBases.Contains(type.OriginalDefinition);
        }

        /// <summary>
        /// Issue #1745: whether a method/property/indexer <paramref name="symbol"/>
        /// is emitted with the G# <c>open</c> modifier. Extracted from three
        /// byte-identical copies (method, property, and indexer translation) so a
        /// change to the openness rule only needs to be made once.
        /// </summary>
        /// <param name="symbol">The member symbol, or <see langword="null"/> when translating without semantic info.</param>
        /// <param name="isOverride">Whether the member is emitted with the G# <c>override</c> modifier.</param>
        /// <returns><c>true</c> when the member should carry <c>open</c>.</returns>
        private bool IsMemberEmittedOpen(ISymbol symbol, bool isOverride)
        {
            bool inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface;
            return symbol != null && !inInterface && !symbol.IsSealed &&
                (symbol.IsVirtual || symbol.IsAbstract || isOverride) &&
                this.IsTypeEmittedOpen(symbol.ContainingType);
        }

        private static TypeDeclarationKind? MapAggregateKind(BaseTypeDeclarationSyntax node)
        {
            switch (node)
            {
                case ClassDeclarationSyntax:
                    return TypeDeclarationKind.Class;
                case StructDeclarationSyntax:
                    return TypeDeclarationKind.Struct;
                case InterfaceDeclarationSyntax:
                    return TypeDeclarationKind.Interface;
                case RecordDeclarationSyntax record:
                    return record.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword)
                        ? TypeDeclarationKind.DataStruct
                        : TypeDeclarationKind.DataClass;
                default:
                    return null;
            }
        }

        private static bool IsValueAggregate(TypeDeclarationKind kind) =>
            kind == TypeDeclarationKind.Struct || kind == TypeDeclarationKind.DataStruct;

        private static bool IsFieldlessRecord(RecordDeclarationSyntax record)
        {
            bool hasPositional = record.ParameterList != null && record.ParameterList.Parameters.Count > 0;
            bool hasDataMember = record.Members.Any(m =>
                (m is FieldDeclarationSyntax field && !field.Modifiers.Any(SyntaxKind.StaticKeyword) && !field.Modifiers.Any(SyntaxKind.ConstKeyword)) ||
                (m is PropertyDeclarationSyntax property && !property.Modifiers.Any(SyntaxKind.StaticKeyword)));
            return !hasPositional && !hasDataMember;
        }

        /// <summary>
        /// Determines whether a C# record declares an instance auto-property data
        /// member in its body (e.g. <c>public string Title { get; }</c> or
        /// <c>{ get; init; }</c>). A G# <c>data</c> type's fields come exclusively
        /// from its positional primary-constructor parameters; auto-properties are
        /// rejected (GS0189) and a body-only record has no <c>data</c> fields at all
        /// (GS0104). Such records therefore map to a plain <c>class</c>/<c>struct</c>
        /// (OD-T5).
        /// </summary>
        private static bool RecordHasAutoPropertyDataMember(RecordDeclarationSyntax record)
        {
            return record.Members.OfType<PropertyDeclarationSyntax>().Any(p =>
                !p.Modifiers.Any(SyntaxKind.StaticKeyword) &&
                p.ExpressionBody == null &&
                p.AccessorList != null &&
                p.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null) &&
                p.AccessorList.Accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration)));
        }

        /// <summary>
        /// Determines whether a property participates in a contract that requires it
        /// to remain a real property in G# — it implements an interface property or
        /// is part of an override chain (virtual/abstract/override). Such a property
        /// cannot be lifted into a primary-constructor parameter (G# primary-ctor
        /// parameters are not properties), or the contract breaks (GS0187). OD-T1.
        /// </summary>
        private static bool IsContractProperty(IPropertySymbol property)
        {
            if (property.IsVirtual || property.IsAbstract || property.IsOverride)
            {
                return true;
            }

            INamedTypeSymbol containing = property.ContainingType;
            if (containing == null)
            {
                return false;
            }

            foreach (INamedTypeSymbol iface in containing.AllInterfaces)
            {
                foreach (IPropertySymbol ifaceProperty in iface.GetMembers().OfType<IPropertySymbol>())
                {
                    ISymbol implementation = containing.FindImplementationForInterfaceMember(ifaceProperty);
                    if (SymbolEqualityComparer.Default.Equals(implementation, property))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool IsIntegral(object value) =>
            value is byte or sbyte or short or ushort or int or uint or long or ulong;

        /// <summary>
        /// Determines whether a C# property is a get-only auto-property
        /// (<c>{ get; }</c>, body-less, no <c>set</c>/<c>init</c> accessor). Such a
        /// property has a backing field and is settable in the declaring type's
        /// constructor; it maps to an init-only G# auto-property (OD-T1).
        /// </summary>
        private static bool IsGetOnlyAutoProperty(PropertyDeclarationSyntax prop)
        {
            if (prop.ExpressionBody != null || prop.AccessorList == null)
            {
                return false;
            }

            IReadOnlyList<AccessorDeclarationSyntax> accessors = prop.AccessorList.Accessors;
            if (accessors.Any(a => a.Body != null || a.ExpressionBody != null))
            {
                return false;
            }

            bool hasGet = accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
            bool hasSet = accessors.Any(a => a.IsKind(SyntaxKind.SetAccessorDeclaration));
            bool hasInit = accessors.Any(a => a.IsKind(SyntaxKind.InitAccessorDeclaration));
            return hasGet && !hasSet && !hasInit;
        }

        /// <summary>
        /// Collects the inline initializers of get-only auto-properties
        /// (<c>public List&lt;T&gt; Items { get; } = new();</c>). G# has no property
        /// member initializer, so the initialization is moved into the type's
        /// <c>init(...)</c> constructor body (OD-T1). Only meaningful for a plain
        /// class/struct that keeps an explicit constructor (not a lifted primary
        /// constructor, not a record).
        /// </summary>
        private List<(string Name, GExpression Value)> CollectGetOnlyAutoPropertyInitializers(
            TypeDeclarationSyntax node)
        {
            var result = new List<(string Name, GExpression Value)>();
            foreach (PropertyDeclarationSyntax prop in node.Members.OfType<PropertyDeclarationSyntax>())
            {
                if (prop.Modifiers.Any(SyntaxKind.StaticKeyword) ||
                    prop.Initializer == null ||
                    !IsGetOnlyAutoProperty(prop))
                {
                    continue;
                }

                var symbol = this.context.GetDeclaredSymbol(prop) as IPropertySymbol;
                if (symbol != null &&
                    (symbol.IsAbstract || symbol.ContainingType?.TypeKind == TypeKind.Interface))
                {
                    continue;
                }

                result.Add((SanitizeIdentifier(prop.Identifier.Text), this.TranslateExpression(prop.Initializer.Value)));
            }

            return result;
        }

        /// <summary>
        /// Determines whether a type declares a designated instance constructor —
        /// one that is non-static and does not delegate to another constructor of
        /// the same type via <c>: this(...)</c>. Such a constructor is the place
        /// into which get-only auto-property initializers are injected (OD-T1).
        /// </summary>
        private static bool HasDesignatedInstanceConstructor(TypeDeclarationSyntax node)
        {
            return node.Members
                .OfType<ConstructorDeclarationSyntax>()
                .Any(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword) &&
                    (c.Initializer == null || c.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.BaseKeyword)));
        }

        private GExpression MapConstantDefault(IParameterSymbol symbol, SyntaxNode fallbackNode)
        {
            object value = symbol.ExplicitDefaultValue;

            // Issue #1733: an enum-typed default (`Color c = Color.Blue`) must
            // resolve to the member reference, not `symbol.ExplicitDefaultValue`'s
            // boxed underlying integer — see the remarks on
            // <see cref="MapEnumConstant"/>.
            if (value != null && symbol.Type?.TypeKind == TypeKind.Enum && IsIntegral(value))
            {
                // A parameter symbol declared in a REFERENCED assembly (e.g. a
                // base-class/interface method whose parameters are enumerated via
                // `IMethodSymbol.Parameters` rather than parsed from local syntax)
                // has no `DeclaringSyntaxReferences` — fall back to the call-site
                // node already in hand so the Unsupported diagnostic still fires
                // instead of the default being dropped silently.
                SyntaxNode node = symbol.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() ?? fallbackNode;
                return this.MapEnumConstant(symbol.Type, value, node, $"parameter '{symbol.Name}''s default value");
            }

            switch (value)
            {
                case null:
                    return null;
                case bool b:
                    return new IdentifierExpression(b ? "true" : "false");
                case string s:
                    return LiteralExpression.String(s);
                case char c:
                    return LiteralExpression.Char(c.ToString());
                case double d:
                    return MapSpecialFloatConstant(d, isDouble: true) ??
                        LiteralExpression.Float(d.ToString(CultureInfo.InvariantCulture));
                case float f:
                    return MapSpecialFloatConstant(f, isDouble: false) ??
                        LiteralExpression.Float(f.ToString(CultureInfo.InvariantCulture));
                default:
                    return IsIntegral(value)
                        ? LiteralExpression.Int(System.Convert.ToString(value, CultureInfo.InvariantCulture))
                        : null;
            }
        }

        /// <summary>
        /// Issue #1733: <c>double</c>/<c>float</c>'s special non-finite values
        /// (<c>NaN</c>, <c>PositiveInfinity</c>, <c>NegativeInfinity</c>) have no
        /// numeric-literal spelling — <c>d.ToString(CultureInfo.InvariantCulture)</c>
        /// renders them as the bare words <c>"NaN"</c>/<c>"Infinity"</c>/
        /// <c>"-Infinity"</c>, which G# reads as unresolved identifiers. G# exposes
        /// the BCL fields directly (`System.Double.NaN`, `System.Single.NaN`, …;
        /// see <c>Issue1616FloatNaNOperatorEmitTests</c>/<c>Issue1617…</c>), so those
        /// are emitted as a fully-qualified member reference instead — qualified so
        /// the reference resolves even when the C# source has no <c>using
        /// System;</c> (a bare <c>double</c>/<c>float</c> default never requires
        /// one).
        /// </summary>
        /// <param name="value">The floating-point value.</param>
        /// <param name="isDouble">Whether <paramref name="value"/> is a <c>double</c> (vs. <c>float</c>).</param>
        /// <returns>The qualified BCL member reference, or <see langword="null"/> when <paramref name="value"/> is an ordinary finite value.</returns>
        private static GExpression MapSpecialFloatConstant(double value, bool isDouble)
        {
            string owner = isDouble ? "System.Double" : "System.Single";
            if (double.IsNaN(value))
            {
                return new MemberAccessExpression(new IdentifierExpression(owner), "NaN");
            }

            if (double.IsPositiveInfinity(value))
            {
                return new MemberAccessExpression(new IdentifierExpression(owner), "PositiveInfinity");
            }

            if (double.IsNegativeInfinity(value))
            {
                return new MemberAccessExpression(new IdentifierExpression(owner), "NegativeInfinity");
            }

            return null;
        }

        /// <summary>
        /// Issue #1733: resolves an enum-typed constant's boxed underlying integral
        /// value to the qualified enum-member reference(s) it represents
        /// (<c>EnumType.Member</c>), rather than the raw integer. <see
        /// cref="VisitEnumDeclaration"/> drops the C# explicit case values, so
        /// translated enums are renumbered by declaration order; emitting the bare
        /// underlying int (as <c>IParameterSymbol.ExplicitDefaultValue</c> /
        /// <c>SemanticModel.GetConstantValue</c> box it) would silently bind to
        /// whichever member happens to hold that ordinal under the NEW numbering —
        /// wrong, and worse than a compile error because it is silent. Resolving to
        /// the member NAME instead lets it track the renumbering correctly.
        /// A <c>[Flags]</c> combination (`A | B`) with no single matching member is
        /// decomposed into the OR of the matching member names; a value that
        /// matches no member (and no flag combination) has no safe G# spelling and
        /// is reported as unsupported rather than emitting a raw int that
        /// renumbering would silently corrupt.
        /// </summary>
        /// <param name="enumType">The parameter/attribute-argument's enum type.</param>
        /// <param name="rawValue">The boxed underlying integral constant value.</param>
        /// <param name="node">The C# node to anchor an unsupported diagnostic to, or <see langword="null"/> to suppress the diagnostic.</param>
        /// <param name="constructDescription">A human-readable description of the constant's origin, for the diagnostic message.</param>
        /// <returns>The member reference (or OR'd flag combination) expression, or <see langword="null"/> when no member/combination matches.</returns>
        private GExpression MapEnumConstant(ITypeSymbol enumType, object rawValue, SyntaxNode node, string constructDescription)
        {
            if (enumType is not INamedTypeSymbol { TypeKind: TypeKind.Enum } namedEnum)
            {
                return null;
            }

            string enumTypeName = this.typeMapper.Map(namedEnum, this.context, node?.GetLocation()) is NamedTypeReference typeRef
                ? typeRef.Name
                : SanitizeIdentifier(namedEnum.Name);

            // Issue #1733 N2: comparing/decomposing the constant as `long` throws
            // `OverflowException` (crashing the translator on otherwise-valid input)
            // for a `ulong`-backed enum member whose value exceeds `long.MaxValue`
            // (e.g. `[Flags] enum X : ulong { Big = 0x8000000000000000 }`).
            // Every C# enum underlying type's bit pattern fits in 64 bits, so
            // reinterpreting the raw bits as `ulong` (via <see cref="ToEnumBitPattern"/>)
            // makes equality and the [Flags] bitwise math below overflow-free for
            // every underlying type (byte/sbyte/short/ushort/int/uint/long/ulong)
            // without needing to special-case each one beyond picking the
            // reinterpretation rule.
            SpecialType underlyingType = namedEnum.EnumUnderlyingType?.SpecialType ?? SpecialType.System_Int32;
            ulong target = ToEnumBitPattern(rawValue, underlyingType);

            List<IFieldSymbol> members = namedEnum.GetMembers()
                .OfType<IFieldSymbol>()
                .Where(m => m.HasConstantValue)
                .ToList();

            foreach (IFieldSymbol member in members)
            {
                if (ToEnumBitPattern(member.ConstantValue, underlyingType) == target)
                {
                    return new MemberAccessExpression(new IdentifierExpression(enumTypeName), SanitizeIdentifier(member.Name));
                }
            }

            bool isFlags = namedEnum.GetAttributes()
                .Any(a => a.AttributeClass?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.FlagsAttribute");
            if (isFlags && target != 0)
            {
                ulong remaining = target;
                GExpression combined = null;
                foreach (IFieldSymbol member in members.OrderByDescending(
                    m => ToEnumBitPattern(m.ConstantValue, underlyingType)))
                {
                    ulong memberValue = ToEnumBitPattern(member.ConstantValue, underlyingType);
                    if (memberValue == 0 || (remaining & memberValue) != memberValue)
                    {
                        continue;
                    }

                    GExpression memberExpr = new MemberAccessExpression(new IdentifierExpression(enumTypeName), SanitizeIdentifier(member.Name));
                    combined = combined == null ? memberExpr : new BinaryExpression(combined, "|", memberExpr);
                    remaining &= ~memberValue;
                }

                if (remaining == 0 && combined != null)
                {
                    return combined;
                }
            }

            if (node != null)
            {
                this.context.ReportUnsupported(
                    node,
                    $"{constructDescription} is the enum value '{System.Convert.ToString(rawValue, CultureInfo.InvariantCulture)}' of '{namedEnum.Name}', which matches no member or [Flags] combination; G# renumbers enum members by declaration order so the raw underlying integer cannot be emitted safely.");
            }

            return null;
        }

        /// <summary>
        /// Issue #1733 N2: reinterprets a boxed enum-underlying-type value as its
        /// raw 64-bit pattern so equality/bitwise comparisons never throw
        /// <see cref="System.OverflowException"/> — <c>Convert.ToInt64</c> throws for
        /// any <c>ulong</c> value above <c>long.MaxValue</c>, and a naive
        /// <c>Convert.ToUInt64</c> throws for any negative signed value. Unsigned
        /// underlying types (<c>byte</c>/<c>ushort</c>/<c>uint</c>/<c>ulong</c>)
        /// convert straight to <c>ulong</c>; signed types (<c>sbyte</c>/<c>short</c>/
        /// <c>int</c>/<c>long</c>, and any other/unknown underlying type) go through
        /// <c>long</c> first and reinterpret its two's-complement bits as
        /// <c>ulong</c> — equality and bitwise AND/OR/NOT are bit-pattern operations,
        /// so this reinterpretation is exact for both comparisons and [Flags]
        /// decomposition regardless of signedness.
        /// </summary>
        private static ulong ToEnumBitPattern(object value, SpecialType underlyingType)
        {
            return underlyingType switch
            {
                SpecialType.System_Byte or
                SpecialType.System_UInt16 or
                SpecialType.System_UInt32 or
                SpecialType.System_UInt64 => System.Convert.ToUInt64(value, CultureInfo.InvariantCulture),
                _ => unchecked((ulong)System.Convert.ToInt64(value, CultureInfo.InvariantCulture)),
            };
        }

        private GMember VisitAggregate(TypeDeclarationSyntax node)
        {
            TypeDeclarationKind? kind = MapAggregateKind(node);
            if (kind is null)
            {
                this.context.ReportUnsupported(node, $"unsupported aggregate kind '{node.Kind()}'.");
                return null;
            }

            var symbol = this.context.GetDeclaredSymbol(node) as INamedTypeSymbol;

            // A `data class`/`data struct` requires at least one field (GS0104) and
            // derives those fields from positional/primary-constructor parameters,
            // not from auto-properties (GS0189). A fieldless record, or a record
            // whose data lives in body auto-properties that cannot be lifted to a
            // primary constructor, therefore maps to a plain `class`/`struct`
            // (ADR-0115 §B.4 / OD-T5). A record *struct* with an explicit
            // parameter-copy constructor is the exception: it lifts to a primary
            // `data struct` (handled by AnalyzeConstructorLift), so it is left alone
            // — a plain G# `struct` cannot carry an explicit `init` constructor.
            if ((kind == TypeDeclarationKind.DataClass || kind == TypeDeclarationKind.DataStruct) &&
                node is RecordDeclarationSyntax record)
            {
                bool fieldless = IsFieldlessRecord(record);
                bool hasAutoPropData = RecordHasAutoPropertyDataMember(record);
                bool hasExplicitInstanceCtor = record.Members
                    .OfType<ConstructorDeclarationSyntax>()
                    .Any(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword));

                bool downgrade = kind == TypeDeclarationKind.DataClass
                    ? fieldless || hasAutoPropData
                    : fieldless || (hasAutoPropData && !hasExplicitInstanceCtor);

                if (downgrade)
                {
                    kind = kind == TypeDeclarationKind.DataStruct
                        ? TypeDeclarationKind.Struct
                        : TypeDeclarationKind.Class;
                    string reason = fieldless
                        ? "a G# 'data' type requires at least one field (GS0104, ADR-0115 §B.4)"
                        : "a G# 'data' type derives its fields from positional parameters and rejects auto-property members (GS0104/GS0189, ADR-0115 §B.4)";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.RecordDeclaration),
                        $"record '{node.Identifier.Text}' maps to a plain '{(kind == TypeDeclarationKind.Struct ? "struct" : "class")}' because {reason}.",
                        node.GetLocation(),
                        TranslationSeverity.Info));
                }
            }

            bool isStaticClass = symbol != null && symbol.IsStatic && kind == TypeDeclarationKind.Class;

            if (isStaticClass)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.ClassDeclaration),
                    $"C# 'static class {node.Identifier.Text}' has no direct G# form; mapped to a class whose members are all wrapped in a 'shared {{ }}' block (ADR-0115 §B.11 / ADR-0053).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
            }

            // T2 (ADR-0115 §B.3): canonicalize immutable-field initialization.
            // A `let` field is read-only after construction but — like a C#
            // `readonly` field (issue #947) — is assignable inside the declaring
            // type's `init(...)` constructor. The lift below still prefers the
            // idiomatic primary-constructor / field-initializer form when the
            // constructor is a simple parameter-to-member copy; non-liftable
            // constructors keep their explicit `init` and assign the `let`
            // fields directly, which is now valid G#.
            ConstructorLift lift = this.AnalyzeConstructorLift(node, symbol, kind.Value);

            // OD-T1: when the explicit constructor is kept (not lifted to a primary
            // constructor) and the type is a plain class/struct, get-only
            // auto-property inline initializers (`{ get; } = new();`) must move into
            // the constructor body — G# has no property member initializer.
            List<(string Name, GExpression Value)> propertyCtorInits =
                !lift.DropConstructor &&
                    (kind == TypeDeclarationKind.Class || kind == TypeDeclarationKind.Struct)
                    ? this.CollectGetOnlyAutoPropertyInitializers(node)
                    : new List<(string Name, GExpression Value)>();

            // Issue #1729 (mode 4): staticFieldInitializers is one shared dictionary
            // reused across the whole recursive VisitAggregate walk. Snapshot the
            // keys already present (belonging to an enclosing type still being
            // processed) so that when this invocation's own entries are cleared
            // below — including after recursing into a nested type declaration,
            // which runs this same method again — only the entries this
            // invocation itself added are removed. Without this, a nested type's
            // exit would wipe the outer type's not-yet-consumed folded fields.
            var staticFieldInitializersSnapshot = new HashSet<ISymbol>(
                this.staticFieldInitializers.Keys, SymbolEqualityComparer.Default);
            this.CollectStaticFieldInitializers(node, symbol);

            var instanceMembers = new List<GMember>();
            var sharedMembers = new List<GMember>();
            foreach (MemberDeclarationSyntax member in node.Members)
            {
                foreach ((GMember translated, bool isStatic) in this.TranslateMember(member, kind.Value, lift, propertyCtorInits))
                {
                    // A C# operator overload translates to a receiver-clause
                    // `func (a T) operator <op>(...)`; like every receiver-clause
                    // func it only binds at top level, so it is lifted out as a
                    // sibling regardless of whether the owning type is a value or
                    // reference aggregate (ADR-0035, sample Operators.gs; §B.5).
                    if (translated is MethodDeclaration { Receiver: not null } opMethod &&
                        opMethod.Name.StartsWith("operator ", System.StringComparison.Ordinal))
                    {
                        this.pendingTopLevelDeclarations.Add(translated);
                        continue;
                    }

                    // A lifted owned-value-aggregate instance method (it carries a
                    // receiver clause) cannot live in the struct body; collect it
                    // as a top-level sibling declaration (issue #938).
                    if (IsValueAggregate(kind.Value) &&
                        !isStatic &&
                        translated is MethodDeclaration { Receiver: not null })
                    {
                        this.pendingTopLevelDeclarations.Add(translated);
                        continue;
                    }

                    // A C# extension method (`this T self`) on a `static class`
                    // translates to a receiver-clause `func`; a receiver-clause
                    // func only binds at top level (its receiver is not in scope
                    // inside a `shared { }` block), so it is lifted out and the
                    // enclosing static class is dropped if nothing else remains
                    // (ADR-0115 §B.5).
                    if (isStaticClass &&
                        translated is MethodDeclaration { Receiver: not null })
                    {
                        this.pendingTopLevelDeclarations.Add(translated);
                        continue;
                    }

                    // A nested type declaration (`class`/`struct`/`enum`/...) maps
                    // to a directly-nested G# type member; the parser does not allow
                    // a type declaration inside a `shared { }` block, so it is always
                    // placed in the enclosing type body regardless of staticness.
                    if (translated is TypeDeclaration or EnumDeclaration or NamedDelegateDeclaration)
                    {
                        instanceMembers.Add(translated);
                        continue;
                    }

                    if (isStatic || isStaticClass)
                    {
                        sharedMembers.Add(translated);
                    }
                    else
                    {
                        instanceMembers.Add(translated);
                    }
                }
            }

            // OD-T1: if get-only auto-property initializers needed to move into a
            // constructor but the type declares no designated instance constructor,
            // synthesize a parameterless `init()` to carry them (G# has no property
            // member initializer). Reference types only — a class is the case that
            // arises in practice.
            if (propertyCtorInits.Count > 0 &&
                kind == TypeDeclarationKind.Class &&
                !HasDesignatedInstanceConstructor(node))
            {
                var initStatements = propertyCtorInits
                    .Select(p => (GStatement)new AssignmentStatement(new IdentifierExpression(p.Name), p.Value))
                    .ToList();
                instanceMembers.Insert(0, new ConstructorDeclaration(
                    new List<Parameter>(),
                    new BlockStatement(initStatements)));
            }

            var members = new List<GMember>(instanceMembers);
            if (sharedMembers.Count > 0)
            {
                members.Add(new SharedBlock(sharedMembers));
            }

            // Issue #1729 (mode 4): remove only the entries this invocation added
            // (see snapshot above), not the whole shared dictionary — an enclosing
            // type may still have not-yet-consumed folded fields pending.
            foreach (ISymbol key in this.staticFieldInitializers.Keys.ToList())
            {
                if (!staticFieldInitializersSnapshot.Contains(key))
                {
                    this.staticFieldInitializers.Remove(key);
                }
            }

            // A `static class` whose every member was an extension method lifted to
            // top level has no remaining body; drop the class entirely (ADR-0115 §B.5).
            if (isStaticClass && members.Count == 0)
            {
                return null;
            }

            (GTypeReference baseType, List<GTypeReference> interfaces) = this.MapBaseClause(symbol, node, kind.Value);
            List<TypeParameter> typeParameters = this.MapTypeParameters(symbol);
            IReadOnlyList<Parameter> primaryCtor = lift.DropConstructor
                ? lift.PrimaryParameters
                : this.MapPrimaryConstructor(node);

            // A class with `protected` members must be an `open class` in G#
            // (GS0380) — `protected` is meaningless on a non-inheritable type. A C#
            // `sealed` class that carries `protected override` members (it overrides
            // an abstract/virtual protected base) therefore still maps to `open`;
            // G# has no `sealed` modifier so the sealedness is dropped (ADR-0115 §B.4).
            // A C# `record` (G# `data class`) is reference-typed and may be
            // subclassed (e.g. `record Derived : Base`); like a plain class it must
            // be declared `open` in G# to permit subclassing (GS0181) or to carry a
            // `protected` member (GS0380). `data struct`/`struct`/`interface` are
            // excluded (value types are not subclassable; interfaces are open by
            // nature).
            bool isOpenableKind = kind == TypeDeclarationKind.Class
                || kind == TypeDeclarationKind.DataClass;
            bool isOpen = symbol != null &&
                isOpenableKind &&
                !symbol.IsStatic &&
                ((!symbol.IsSealed && this.subclassedBases.Contains(symbol.OriginalDefinition))
                    || HasProtectedMember(symbol));

            // G# has no `abstract` class modifier (the keyword is not recognized by
            // the parser); a C# `abstract class`/`abstract record` therefore maps to
            // an `open class`/`open data class` — subclassable but without enforced
            // non-instantiation (ADR-0115 §B.4). The abstractness is intentionally
            // dropped.
            bool wasAbstract = symbol != null && symbol.IsAbstract && isOpenableKind;
            if (wasAbstract)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.ClassDeclaration),
                    $"C# 'abstract' on '{node.Identifier.Text}' is dropped; G# has no abstract-class modifier, so the type maps to an 'open class' (ADR-0115 §B.4).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
            }

            return new TypeDeclaration(
                kind.Value,
                SanitizeIdentifier(node.Identifier.Text),
                typeParameters: typeParameters,
                primaryConstructorParameters: primaryCtor,
                baseType: baseType,
                interfaces: interfaces,
                members: members,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen || wasAbstract,
                isAbstract: false,
                attributes: this.MapAttributes(node.AttributeLists),
                isUnsafe: node.Modifiers.Any(SyntaxKind.UnsafeKeyword));
        }

        /// <summary>
        /// Analyzes a type's single instance constructor to decide the canonical
        /// G# immutable-field initialization form (ADR-0115 §B.3 / T2). A field
        /// assigned directly from a constructor parameter is lifted to a primary
        /// constructor parameter; a field assigned an expression independent of the
        /// constructor parameters becomes a field initializer; when every
        /// statement and parameter is consumed this way the explicit
        /// <c>init</c> constructor is dropped. Anything that does not fit the
        /// pattern leaves the constructor untouched (<see cref="ConstructorLift.None"/>).
        /// </summary>
        private ConstructorLift AnalyzeConstructorLift(
            TypeDeclarationSyntax node,
            INamedTypeSymbol symbol,
            TypeDeclarationKind kind)
        {
            // A C# `record struct` with an explicit (non-positional) constructor
            // cannot keep an in-body `init` member: the G# parser only accepts a
            // primary constructor on a `data struct`. Such a record-struct
            // constructor is therefore lifted to the primary constructor just like
            // a plain struct/class (ADR-0115 §B.3 / issue #1024 follow-up).
            bool isRecordStructLift = kind == TypeDeclarationKind.DataStruct
                && node is RecordDeclarationSyntax { ParameterList: null };

            if (symbol == null ||
                (kind != TypeDeclarationKind.Class
                    && kind != TypeDeclarationKind.Struct
                    && !isRecordStructLift))
            {
                return ConstructorLift.None;
            }

            List<ConstructorDeclarationSyntax> instanceCtors = node.Members
                .OfType<ConstructorDeclarationSyntax>()
                .Where(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword))
                .ToList();

            // A record already owns a primary constructor, and zero or many
            // instance constructors are out of scope for the L1 canonicalization.
            // The record-struct lift above is the sole exception: it has no
            // positional primary constructor and exactly one explicit one.
            if (instanceCtors.Count != 1 || (node is RecordDeclarationSyntax && !isRecordStructLift))
            {
                return ConstructorLift.None;
            }

            ConstructorDeclarationSyntax ctor = instanceCtors[0];
            if (ctor.Body == null || ctor.Initializer != null)
            {
                return ConstructorLift.None;
            }

            var ctorSymbol = this.context.GetDeclaredSymbol(ctor) as IMethodSymbol;
            if (ctorSymbol == null)
            {
                return ConstructorLift.None;
            }

            var paramToTarget = new Dictionary<IParameterSymbol, (string Name, ITypeSymbol Type, bool IsProperty)>(SymbolEqualityComparer.Default);
            var fieldInitializers = new Dictionary<string, GExpression>();
            var residualInitStatements = new List<GStatement>();

            SyntaxNode previousScope = this.currentBodyScope;
            this.currentBodyScope = ctor;
            try
            {
                foreach (StatementSyntax statement in ctor.Body.Statements)
                {
                    if (statement is not ExpressionStatementSyntax exprStatement
                        || exprStatement.Expression is not AssignmentExpressionSyntax assignment
                        || !assignment.OperatorToken.IsKind(SyntaxKind.EqualsToken))
                    {
                        return ConstructorLift.None;
                    }

                    // The assignment target is either a backing field or an
                    // auto-property (`Width = width`); both lift to a primary
                    // constructor parameter named after the member.
                    string targetName;
                    ITypeSymbol targetType;
                    bool targetIsProperty;
                    ISymbol leftSymbol = this.context.GetSymbolInfo(assignment.Left).Symbol;
                    if (leftSymbol is IFieldSymbol fieldSymbol &&
                        !fieldSymbol.IsStatic &&
                        SymbolEqualityComparer.Default.Equals(fieldSymbol.ContainingType, symbol))
                    {
                        targetName = fieldSymbol.Name;
                        targetType = fieldSymbol.Type;
                        targetIsProperty = false;
                    }
                    else if (leftSymbol is IPropertySymbol propertySymbol &&
                        !propertySymbol.IsStatic &&
                        SymbolEqualityComparer.Default.Equals(propertySymbol.ContainingType, symbol))
                    {
                        targetName = propertySymbol.Name;
                        targetType = propertySymbol.Type;
                        targetIsProperty = true;

                        // OD-T1: G# primary-constructor parameters are NOT
                        // properties, so a *class* that copies a constructor
                        // parameter into a property which satisfies an interface or
                        // overridden-member contract cannot lift — dropping the
                        // property member would break the contract (GS0187) and
                        // cascade to GS0214/GS0183 on derived/override members. Keep
                        // the explicit `init(...)` so the get-only auto-property
                        // survives (emitted as init-only `{ get; init; }`). A
                        // property that is *not* a contract member is still lifted to
                        // the primary constructor (the L1 canonical form). Value
                        // types always lift: a G# `struct`/`data struct` cannot carry
                        // an in-body `init` (ADR-0115 §B.3 / B.6 / T2).
                        if (kind == TypeDeclarationKind.Class &&
                            IsContractProperty(propertySymbol))
                        {
                            return ConstructorLift.None;
                        }
                    }
                    else
                    {
                        return ConstructorLift.None;
                    }

                    // `target = ctorParam` → lift to a primary-constructor parameter.
                    if (assignment.Right is IdentifierNameSyntax rightId
                        && this.context.GetSymbolInfo(rightId).Symbol is IParameterSymbol paramSymbol
                        && SymbolEqualityComparer.Default.Equals(paramSymbol.ContainingSymbol, ctorSymbol))
                    {
                        if (paramToTarget.ContainsKey(paramSymbol))
                        {
                            return ConstructorLift.None;
                        }

                        paramToTarget[paramSymbol] = (targetName, targetType, targetIsProperty);
                        continue;
                    }

                    // Otherwise the RHS must be independent of the constructor
                    // parameters to become a field initializer.
                    if (this.ReferencesAnyParameter(assignment.Right, ctorSymbol))
                    {
                        return ConstructorLift.None;
                    }

                    // A G# field initializer is evaluated before the object is fully
                    // constructed, so it cannot reference any instance member of the
                    // type (an instance field/property/method, or `this`/`base`). Such
                    // an assignment must remain in the constructor body — keep it as a
                    // residual `init(...)` statement instead of hoisting it to a field
                    // initializer (defect: GS0125 'Variable doesn't exist' + cascade
                    // GS0159; e.g. `buffer = [InputBufferSize]T` where
                    // `InputBufferSize` is an abstract instance property). Static /
                    // constant RHS assignments still hoist normally.
                    if (this.ReferencesInstanceMember(assignment.Right, symbol))
                    {
                        residualInitStatements.Add(this.TranslateExpressionStatement(assignment));
                        continue;
                    }

                    // G# supports a field member initializer (`var Name T = expr`)
                    // but has no property member initializer (`prop Name T = expr`
                    // is rejected). A constant assignment to a property therefore
                    // cannot be lifted to a member initializer; keep the explicit
                    // 'init' so its body faithfully assigns the property.
                    if (targetIsProperty)
                    {
                        return ConstructorLift.None;
                    }

                    // Issue #1729 (mode 5): hoisting a field initializer reorders it
                    // to the field's declaration position, ahead of every ctor
                    // statement that follows it in source. That is only safe when
                    // the assigned target is written exactly once (a repeat write
                    // would silently discard the first RHS's side effect via the
                    // dictionary overwrite below) and the RHS cannot itself run
                    // observable side effects (a call, object creation, or property
                    // getter) whose relative order versus other field initializers
                    // would then change. Either condition bails the whole lift so
                    // the explicit constructor — and its true evaluation order — is
                    // kept intact instead of silently reordered.
                    if (fieldInitializers.ContainsKey(targetName) ||
                        this.ContainsPotentialSideEffect(assignment.Right))
                    {
                        return ConstructorLift.None;
                    }

                    fieldInitializers[targetName] = this.TranslateExpression(assignment.Right);
                }
            }
            finally
            {
                this.currentBodyScope = previousScope;
            }

            // Every constructor parameter must be consumed by exactly one direct
            // member assignment for the constructor to drop cleanly.
            if (ctorSymbol.Parameters.Any(p => !paramToTarget.ContainsKey(p)))
            {
                return ConstructorLift.None;
            }

            // An instance-member-dependent assignment must stay in the constructor
            // body (see above). It is emitted as a synthesized parameterless
            // `init() { ... }`, which cannot coexist with a primary constructor that
            // carries parameters. When the constructor also copies parameters into
            // members, leave the whole explicit constructor intact rather than emit a
            // conflicting primary-ctor + init pair (still valid G#).
            if (residualInitStatements.Count > 0 && ctorSymbol.Parameters.Length > 0)
            {
                return ConstructorLift.None;
            }

            var primaryParameters = new List<Parameter>();
            var fieldsAsParams = new HashSet<string>();
            var propertiesAsParams = new HashSet<string>();
            foreach (IParameterSymbol param in ctorSymbol.Parameters)
            {
                (string Name, ITypeSymbol Type, bool IsProperty) target = paramToTarget[param];
                GTypeReference type = this.typeMapper.Map(target.Type, this.context, param.Locations.FirstOrDefault());
                GExpression liftedDefault = this.BuildOptionalParameterDefault(param, type, node);
                primaryParameters.Add(new Parameter(SanitizeIdentifier(target.Name), type, defaultValue: liftedDefault));
                if (target.IsProperty)
                {
                    propertiesAsParams.Add(target.Name);
                }
                else
                {
                    fieldsAsParams.Add(target.Name);
                }
            }

            var allParamNames = fieldsAsParams.Concat(propertiesAsParams).OrderBy(n => n).ToList();
            if (allParamNames.Count > 0)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.ConstructorDeclaration),
                    $"constructor on '{node.Identifier.Text}' is canonicalized to a primary constructor: parameter-sourced member(s) {string.Join(", ", allParamNames)} become primary-constructor parameter fields (now public) and the explicit 'init' is dropped (ADR-0115 §B.3 / T2).",
                    ctor.GetLocation(),
                    TranslationSeverity.Info));
            }

            return new ConstructorLift
            {
                Constructor = ctor,
                DropConstructor = true,
                PrimaryParameters = primaryParameters,
                FieldsAsPrimaryParameters = fieldsAsParams,
                PropertiesAsPrimaryParameters = propertiesAsParams,
                FieldInitializers = fieldInitializers,
                ResidualInitStatements = residualInitStatements,
            };
        }

        private bool ReferencesAnyParameter(ExpressionSyntax expression, IMethodSymbol ctorSymbol)
        {
            foreach (IdentifierNameSyntax id in expression.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            {
                if (this.context.GetSymbolInfo(id).Symbol is IParameterSymbol p
                    && SymbolEqualityComparer.Default.Equals(p.ContainingSymbol, ctorSymbol))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Determines whether <paramref name="expression"/> reads any instance
        /// member of the type under construction — an instance field, property,
        /// method or event accessed without a static qualifier, or an explicit
        /// <c>this</c>/<c>base</c> expression. Such an expression cannot be lifted
        /// into a G# field initializer (it would reference object state before the
        /// instance exists, GS0125) and must stay in the constructor body.
        /// </summary>
        private bool ReferencesInstanceMember(ExpressionSyntax expression, INamedTypeSymbol containingType)
        {
            foreach (SyntaxNode node in expression.DescendantNodesAndSelf())
            {
                if (node is ThisExpressionSyntax or BaseExpressionSyntax)
                {
                    return true;
                }

                if (node is not SimpleNameSyntax name)
                {
                    continue;
                }

                // Only the leftmost name of a member-access chain (`a.B.C`) binds to
                // a member/local in the current scope; the trailing names resolve
                // against another receiver's type, so skip them.
                if (node.Parent is MemberAccessExpressionSyntax memberAccess &&
                    memberAccess.Name == node)
                {
                    continue;
                }

                ISymbol symbol = this.context.GetSymbolInfo(name).Symbol;
                if (symbol is { IsStatic: false } &&
                    symbol.Kind is SymbolKind.Field or SymbolKind.Property
                        or SymbolKind.Method or SymbolKind.Event &&
                    symbol.ContainingType != null &&
                    InheritsFromOrEquals(containingType, symbol.ContainingType))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Issue #1729 (mode 5): determines whether hoisting <paramref name="expression"/>
        /// to a field's declaration position could change observable behavior versus
        /// leaving it in the constructor body — a method/delegate invocation or
        /// property-getter access may run arbitrary code (I/O, mutation, logging)
        /// whose order relative to other field initializers would then differ from
        /// C#'s constructor-body order. Plain reads of fields, locals, parameters,
        /// constants, and object construction (the idiomatic
        /// <c>_field = new T(...)</c> field-initializer shape, ADR-0115 §B.3 / T2)
        /// are treated as side-effect-free and remain safe to hoist.
        /// </summary>
        private bool ContainsPotentialSideEffect(ExpressionSyntax expression)
        {
            foreach (SyntaxNode node in expression.DescendantNodesAndSelf())
            {
                switch (node)
                {
                    case InvocationExpressionSyntax:
                    case AwaitExpressionSyntax:
                    case AssignmentExpressionSyntax:
                    case PostfixUnaryExpressionSyntax:
                        return true;
                    case PrefixUnaryExpressionSyntax prefix
                        when prefix.IsKind(SyntaxKind.PreIncrementExpression) ||
                            prefix.IsKind(SyntaxKind.PreDecrementExpression):
                        return true;
                }

                if (node is SimpleNameSyntax name &&
                    this.context.GetSymbolInfo(name).Symbol is IPropertySymbol)
                {
                    // A property access may run an arbitrary getter body.
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Issue #1729 (mode 3): determines whether <paramref name="expression"/>
        /// reads any static member of <paramref name="containingType"/> (or a base
        /// of it) — a static field, property, method, or event. A folded static
        /// constructor assignment whose RHS depends on the type's own static state
        /// cannot be hoisted to its field's declaration position without risking a
        /// change to C#'s field-initializers-then-cctor evaluation order.
        /// </summary>
        private bool ReferencesStaticMemberOfType(ExpressionSyntax expression, INamedTypeSymbol containingType)
        {
            foreach (SyntaxNode node in expression.DescendantNodesAndSelf())
            {
                if (node is not SimpleNameSyntax name)
                {
                    continue;
                }

                ISymbol symbol = this.context.GetSymbolInfo(name).Symbol;
                if (symbol is { IsStatic: true } &&
                    symbol.Kind is SymbolKind.Field or SymbolKind.Property
                        or SymbolKind.Method or SymbolKind.Event &&
                    symbol.ContainingType != null &&
                    InheritsFromOrEquals(containingType, symbol.ContainingType))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool InheritsFromOrEquals(INamedTypeSymbol type, INamedTypeSymbol candidateBase)
        {
            for (INamedTypeSymbol current = type; current != null; current = current.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(current.OriginalDefinition, candidateBase.OriginalDefinition))
                {
                    return true;
                }
            }

            return false;
        }

        private IEnumerable<(GMember Member, bool IsStatic)> TranslateMember(
            MemberDeclarationSyntax member,
            TypeDeclarationKind ownerKind,
            ConstructorLift lift,
            IReadOnlyList<(string Name, GExpression Value)> propertyCtorInits)
        {
            switch (member)
            {
                case FieldDeclarationSyntax field:
                    foreach ((GMember m, bool s) in this.TranslateField(field, lift))
                    {
                        yield return (m, s);
                    }

                    break;

                case MethodDeclarationSyntax method:
                    yield return this.TranslateMethod(method, ownerKind);
                    break;

                case OperatorDeclarationSyntax op:
                    yield return this.TranslateOperator(op);
                    break;

                case EventFieldDeclarationSyntax eventField:
                    foreach ((GMember m, bool s) in this.TranslateEventField(eventField))
                    {
                        yield return (m, s);
                    }

                    break;

                case PropertyDeclarationSyntax property:
                    if (lift.PropertiesAsPrimaryParameters.Contains(property.Identifier.Text))
                    {
                        break;
                    }

                    // Issue #1190: a static auto-property with an inline initializer
                    // maps to a static backing field in the `shared { }` block, since
                    // a static G# `prop` cannot carry an `init` accessor (GS0374) and
                    // there is no instance constructor to receive the initializer.
                    if (this.TryTranslateStaticAutoPropertyField(property, out FieldDeclaration staticField))
                    {
                        yield return (staticField, true);
                        break;
                    }

                    yield return this.TranslateProperty(property);
                    break;

                case IndexerDeclarationSyntax indexer:
                    yield return this.TranslateIndexer(indexer);
                    break;

                case ConstructorDeclarationSyntax ctor:
                    // T2: a fully-lifted constructor is dropped entirely; its field
                    // initialization moved to field initializers / primary-ctor
                    // parameters (ADR-0115 §B.3). Assignments whose RHS reads an
                    // instance member cannot become field initializers, so they are
                    // re-emitted here as a synthesized parameterless `init() { ... }`.
                    if (lift.DropConstructor && lift.Constructor == ctor)
                    {
                        if (lift.ResidualInitStatements.Count > 0)
                        {
                            yield return (
                                new ConstructorDeclaration(
                                    new List<Parameter>(),
                                    new BlockStatement(new List<GStatement>(lift.ResidualInitStatements))),
                                false);
                        }

                        break;
                    }

                    GMember built = this.TranslateConstructor(ctor, propertyCtorInits);
                    if (built != null)
                    {
                        yield return (built, ctor.Modifiers.Any(SyntaxKind.StaticKeyword));
                    }

                    break;

                case DestructorDeclarationSyntax destructor:
                    // A C# finalizer `~T()` maps to the G# `deinit { ... }` block
                    // (ADR-0068, reference types only).
                    yield return (
                        new DestructorDeclaration(this.TranslateBody(destructor, $"finalizer on '{destructor.Identifier.Text}'")),
                        false);
                    break;

                case BaseTypeDeclarationSyntax nestedType:
                    GMember nested = this.Visit(nestedType);
                    if (nested != null)
                    {
                        yield return (nested, true);
                    }

                    break;

                case ConversionOperatorDeclarationSyntax conversion:
                    // gsc issue #1017: a C# user-defined conversion operator
                    // (`public static implicit/explicit operator T(U x)`) maps to
                    // the canonical G# `func operator implicit/explicit (x U) T`
                    // in-body member. `implicit`/`explicit` are contextual keywords
                    // right after `operator`; the single C# parameter is the
                    // conversion source and the C# target type becomes the return
                    // type (ADR-0115 §B).
                    yield return this.TranslateConversionOperator(conversion);
                    break;

                default:
                    this.context.ReportUnsupported(
                        member,
                        $"member '{member.Kind()}' has no canonical G# mapping yet (ADR-0115 §B.11).");
                    break;
            }
        }

        private IEnumerable<(GMember Member, bool IsStatic)> TranslateEventField(
            EventFieldDeclarationSyntax node)
        {
            // `public event EventHandler<T>? X;` → G# `public event X EventHandler[T]`
            // (name-then-type; the nullable annotation is dropped because a
            // field-like event is nil-initialized; ADR-0115 §B).
            foreach (VariableDeclaratorSyntax declarator in node.Declaration.Variables)
            {
                var symbol = this.context.GetDeclaredSymbol(declarator) as IEventSymbol;

                GTypeReference type = symbol != null
                    ? this.typeMapper.Map(
                        symbol.Type.WithNullableAnnotation(NullableAnnotation.NotAnnotated),
                        this.context,
                        declarator.GetLocation())
                    : this.MapTypeSyntax(node.Declaration.Type);

                var declaration = new EventDeclaration(
                    SanitizeIdentifier(declarator.Identifier.Text),
                    type,
                    MapVisibility(symbol, this.context, node));

                yield return (declaration, symbol != null && symbol.IsStatic);
            }
        }

        /// <summary>
        /// Wraps a translated constant expression in an explicit G# cast when the
        /// C# semantic model implicitly converts a signed-integer constant to an
        /// unsigned-integer target (<c>uint x = 0</c>, <c>const byte b = 31</c>).
        /// G# requires the conversion to be explicit (OD-T2, otherwise GS0156
        /// "Cannot convert int32 to uintN").
        /// </summary>
        private GExpression CoerceConstantToUnsigned(ExpressionSyntax expression, GExpression translated)
        {
            TypeInfo info = this.context.GetTypeInfo(expression);
            ITypeSymbol source = info.Type;
            ITypeSymbol target = info.ConvertedType;
            if (source != null &&
                target != null &&
                !SymbolEqualityComparer.Default.Equals(source, target) &&
                IsSignedIntegerSpecialType(source.SpecialType) &&
                IsUnsignedIntegerSpecialType(target.SpecialType))
            {
                GTypeReference targetRef = this.typeMapper.Map(target, this.context, expression.GetLocation());
                return new ConversionExpression(targetRef, translated);
            }

            return translated;
        }

        private static bool IsSignedIntegerSpecialType(SpecialType type) =>
            type is SpecialType.System_SByte or SpecialType.System_Int16
                or SpecialType.System_Int32 or SpecialType.System_Int64;

        private static bool IsUnsignedIntegerSpecialType(SpecialType type) =>
            type is SpecialType.System_Byte or SpecialType.System_UInt16
                or SpecialType.System_UInt32 or SpecialType.System_UInt64;

        /// <summary>
        /// Determines whether a C# method override ultimately overrides a base
        /// method that is defined outside the translated source (e.g. an
        /// <see cref="object"/> virtual such as <c>ToString</c>, or a framework
        /// base like <c>System.IO.Stream.Read</c>). G# does not treat the virtual
        /// members of metadata (non-source) types as <c>open</c>, so re-declaring
        /// them must omit the <c>override</c> modifier (OD-T5; otherwise
        /// GS0183/GS0184). The plain <c>func</c> form binds as the override.
        /// </summary>
        private static bool OverridesExternalBaseMethod(IMethodSymbol method)
        {
            IMethodSymbol baseMethod = method.OverriddenMethod;
            if (baseMethod == null)
            {
                return false;
            }

            while (baseMethod.OverriddenMethod != null)
            {
                baseMethod = baseMethod.OverriddenMethod;
            }

            return baseMethod.DeclaringSyntaxReferences.IsEmpty;
        }

        /// <summary>
        /// Property counterpart of <see cref="OverridesExternalBaseMethod"/>: a C#
        /// property override (e.g. <c>Stream.CanRead</c>) whose root base property
        /// is defined outside the translated source must drop <c>override</c>.
        /// </summary>
        private static bool OverridesExternalBaseProperty(IPropertySymbol property)
        {
            IPropertySymbol baseProperty = property.OverriddenProperty;
            if (baseProperty == null)
            {
                return false;
            }

            while (baseProperty.OverriddenProperty != null)
            {
                baseProperty = baseProperty.OverriddenProperty;
            }

            return baseProperty.DeclaringSyntaxReferences.IsEmpty;
        }

        private IEnumerable<(GMember Member, bool IsStatic)> TranslateField(
            FieldDeclarationSyntax field,
            ConstructorLift lift)
        {
            foreach (VariableDeclaratorSyntax declarator in field.Declaration.Variables)
            {
                var symbol = this.context.GetDeclaredSymbol(declarator) as IFieldSymbol;

                // T2: a field that became a primary-constructor parameter is no
                // longer a standalone member (the parameter declares the field).
                if (lift.FieldsAsPrimaryParameters.Contains(declarator.Identifier.Text))
                {
                    continue;
                }

                BindingKind binding = symbol switch
                {
                    { IsConst: true } => BindingKind.Const,
                    { IsReadOnly: true } => BindingKind.Let,
                    _ => BindingKind.Var,
                };

                GTypeReference type = symbol != null
                    ? this.typeMapper.Map(symbol.Type, this.context, declarator.GetLocation())
                    : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

                // Issue #1072: a non-nullable reference/array field that is
                // null-checked or null-assigned anywhere in the declaring type is
                // really nullable; render it `T?` so the `== nil` guard type-checks.
                if (symbol != null)
                {
                    type = this.PromoteIfUsedAsNullable(type, symbol);
                }

                // T2: a field initializer (ADR-0115 §B.3) comes either from a
                // constructor assignment independent of the constructor parameters
                // (lifted out of the dropped `init`) or from a C# field initializer.
                GExpression initializer = null;
                if (lift.FieldInitializers.TryGetValue(declarator.Identifier.Text, out GExpression lifted))
                {
                    initializer = lifted;
                }
                else if (symbol != null &&
                    this.staticFieldInitializers.TryGetValue(symbol, out GExpression staticLifted))
                {
                    // Issue #1729 (mode 1): a folded `static` constructor
                    // (`static T() { Field = value; }`) runs *after* the field's own
                    // inline initializer in C#, so its assigned value — not the
                    // inline initializer — is the field's true final value. Prefer
                    // it over `declarator.Initializer` even when both are present.
                    //
                    // Issue #1729 (N1): dropping `declarator.Initializer` this way is
                    // only safe when its RHS is side-effect-free (a constant/literal/
                    // `new T()` shape). If it can run observable side effects (e.g.
                    // `static int X = Log(1);`), C# still runs them before the cctor
                    // overwrites the field, and silently folding to just the cctor
                    // value would drop that side effect. Report instead of folding.
                    if (declarator.Initializer != null &&
                        this.ContainsPotentialSideEffect(declarator.Initializer.Value))
                    {
                        string message =
                            $"field '{declarator.Identifier.Text}' has a side-effecting inline " +
                            "initializer that a static constructor overwrites; folding would " +
                            "silently drop the initializer's side effect (ADR-0115 §B.11).";
                        this.context.ReportUnsupported(declarator, message);
                        continue;
                    }

                    initializer = staticLifted;
                }
                else if (declarator.Initializer != null)
                {
                    initializer = this.CoerceConstantToUnsigned(
                        declarator.Initializer.Value,
                        this.TranslateExpression(declarator.Initializer.Value));

                    // Issue #1072: a non-nullable reference field whose initializer
                    // is nullable (e.g. `?.`-access) is rendered `T?`.
                    if (symbol != null)
                    {
                        type = this.PromoteIfInitializerNullable(
                            type, symbol.Type, declarator.Initializer.Value);
                    }
                }

                var declaration = new FieldDeclaration(
                    binding,
                    SanitizeIdentifier(declarator.Identifier.Text),
                    type,
                    initializer: initializer,
                    visibility: MapVisibility(symbol, this.context, field),
                    attributes: this.MapAttributes(field.AttributeLists));

                yield return (declaration, symbol != null && symbol.IsStatic);
            }
        }

        private (GMember Member, bool IsStatic) TranslateMethod(
            MethodDeclarationSyntax node,
            TypeDeclarationKind ownerKind)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            bool isStatic = symbol != null && symbol.IsStatic;

            Receiver receiver = null;
            bool skipFirstParameter = false;
            bool selfQualifyBody = false;

            if (symbol != null && symbol.IsExtensionMethod)
            {
                // C# extension methods translate to the receiver-clause form on a
                // non-owned type (ADR-0115 §B.5). A receiver clause is only valid
                // on a struct/class (ADR-0079); an extension on an enum receiver
                // is rejected by gsc (GS0103 "must be a struct or class"), so it
                // stays a plain static helper and its call sites are rewritten to
                // the positional form `Owner.Method(receiver, …)`.
                IParameterSymbol self = symbol.Parameters.FirstOrDefault();
                if (self != null && self.Type.TypeKind != TypeKind.Enum)
                {
                    // Issue #1072/#1535: an extension receiver that is null-compared
                    // or null-assigned in the body is really nullable (common in
                    // nullable-oblivious sources, e.g. `this object o => o == null`),
                    // so promote it to `T?` exactly as an ordinary parameter would be
                    // — the receiver path bypasses MapParameters, so the promotion
                    // must be applied here too.
                    GTypeReference receiverType = this.typeMapper.Map(self.Type, this.context, node.GetLocation());
                    receiverType = this.PromoteIfUsedAsNullable(receiverType, self);
                    receiver = new Receiver(
                        SanitizeIdentifier(self.Name),
                        receiverType);
                    skipFirstParameter = true;
                    isStatic = false;
                }
            }
            else if (!isStatic && IsValueAggregate(ownerKind))
            {
                // Owned-struct instance method: the parser rejects an in-body
                // 'func' inside a struct body (GS0005) and the binder flags the
                // receiver-clause form with GS0314, so no warning-free spelling
                // exists today. Emit the only form that parses and record the
                // known gap (issue #938, ADR-0115 §B.5).
                receiver = new Receiver(
                    "self",
                    new NamedTypeReference(symbol?.ContainingType?.Name ?? node.Identifier.Text));
                selfQualifyBody = true;
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.MethodDeclaration),
                    $"instance method '{node.Identifier.Text}' on owned struct/data-struct emits the receiver-clause form (the only form that parses); the binder will flag GS0314 — expected, known compiler gap (issue #938, ADR-0115 §B.5).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
            }

            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirstParameter);
            GTypeReference returnType = this.MapReturnType(symbol, node);
            List<TypeParameter> typeParameters = this.MapMethodTypeParameters(symbol);

            bool hasBody = node.Body != null || node.ExpressionBody != null;
            string previousReceiver = this.currentReceiverName;
            if (selfQualifyBody)
            {
                this.currentReceiverName = receiver.Name;
            }

            BlockStatement body;
            try
            {
                body = hasBody
                    ? this.TranslateBody(node, $"method '{node.Identifier.Text}'")
                    : null;
            }
            finally
            {
                this.currentReceiverName = previousReceiver;
            }

            // ADR-0122 / issue #1014: a C# `unsafe` method body is an unsafe
            // context. The G# member-level `unsafe func` modifier does not combine
            // with an accessibility keyword in the grammar, so — unless the whole
            // owning type is already `unsafe` — the body is wrapped in an
            // `unsafe { … }` block, which round-trips with any visibility and gives
            // the same unsafe context.
            if (body != null &&
                node.Modifiers.Any(SyntaxKind.UnsafeKeyword) &&
                !node.Ancestors().OfType<TypeDeclarationSyntax>().Any(t => t.Modifiers.Any(SyntaxKind.UnsafeKeyword)))
            {
                body = new BlockStatement(new GStatement[]
                {
                    new BlockStatement(body.Statements, isUnsafe: true),
                });
            }

            bool isOverride = symbol != null && symbol.IsOverride && !OverridesExternalBaseMethod(symbol);

            // Interface members are implicitly abstract in C#; in canonical G# the
            // members of an `interface` carry no modifier (the `open` keyword is for
            // virtual/abstract members of a class). Suppress `open` for them so the
            // emitted G# round-trips (ADR-0115 §B.6).
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            // A method lifted to the top-level receiver-clause form (an owned-value
            // aggregate method or an extension method) has no `open`/`override`:
            // those modifiers are only valid on in-body class members, and the
            // parser rejects `override func (...)` (GS0005). Drop them so the
            // emitted G# round-trips (ADR-0115 §B.5/§B.14).
            if (receiver != null)
            {
                isOpen = false;
                isOverride = false;
            }

            // Generic interface methods are supported by the G# parser since
            // issue #1007 (`func F[T](...) R;`); the printer emits the
            // type-parameter list via the same path as a class method or free
            // func, so the `[T]` clause is retained on interface methods.
            // Issue #1278 / ADR-0131: a C# expression-bodied method (`=> expr`)
            // renders as the idiomatic G# arrow form `func F(...) T -> expr`
            // when the translated body folds to a single inline statement.
            GStatement arrowBody = node.ExpressionBody != null ? TryFoldArrowBody(body) : null;
            if (arrowBody != null)
            {
                body = null;
            }

            var method = new MethodDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                parameters: parameters,
                returnType: returnType,
                body: body,
                typeParameters: typeParameters,
                receiver: receiver,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen,
                isOverride: isOverride,
                isAsync: symbol != null && symbol.IsAsync,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);

            return (method, isStatic);
        }

        /// <summary>
        /// Translates a C# operator overload (<c>public static X operator +(X a, X b)</c>)
        /// to the canonical G# receiver-clause operator form
        /// <c>func (a X) operator +(b X) X</c> (ADR-0035, sample <c>Operators.gs</c>;
        /// ADR-0115 §B.5). The first operand becomes the receiver; remaining
        /// operands become parameters (a unary operator has no parameters). The
        /// declaration is lifted to a top-level sibling because a receiver-clause
        /// <c>func</c> only binds at top level.
        /// </summary>
        private (GMember Member, bool IsStatic) TranslateOperator(OperatorDeclarationSyntax node)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            string operatorToken = node.OperatorToken.Text;

            List<Parameter> allParameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);
            Receiver receiver;
            List<Parameter> parameters;
            if (allParameters.Count > 0)
            {
                Parameter first = allParameters[0];
                receiver = new Receiver(first.Name, first.Type);
                parameters = allParameters.Skip(1).ToList();
            }
            else
            {
                receiver = new Receiver(
                    "self",
                    new NamedTypeReference(symbol?.ContainingType?.Name ?? "object"));
                parameters = new List<Parameter>();
            }

            GTypeReference returnType = symbol != null
                ? this.typeMapper.Map(symbol.ReturnType, this.context, node.ReturnType.GetLocation())
                : null;

            BlockStatement body = (node.Body != null || node.ExpressionBody != null)
                ? this.TranslateBody(node, $"operator '{operatorToken}'")
                : null;

            GStatement arrowBody = node.ExpressionBody != null ? TryFoldArrowBody(body) : null;
            if (arrowBody != null)
            {
                body = null;
            }

            var method = new MethodDeclaration(
                $"operator {operatorToken}",
                parameters: parameters,
                returnType: returnType,
                body: body,
                typeParameters: null,
                receiver: receiver,
                visibility: Visibility.Default,
                isOpen: false,
                isOverride: false,
                isAsync: false,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);

            // Operators carry the receiver-clause form and are lifted to a top-level
            // sibling; returning IsStatic=false routes them through the existing
            // receiver-clause lift in VisitAggregate.
            return (method, false);
        }

        private (GMember Member, bool IsStatic) TranslateConversionOperator(ConversionOperatorDeclarationSyntax node)
        {
            // gsc issue #1017: `public static implicit operator T(U x)` →
            // `func operator implicit (x U) T { ... }` (and `explicit` likewise).
            // The single C# parameter is the conversion source; the C# target type
            // (`node.Type`) becomes the G# return type. `implicit`/`explicit` is a
            // contextual keyword that forms the operator name.
            string kindKeyword = node.ImplicitOrExplicitKeyword.IsKind(SyntaxKind.ImplicitKeyword)
                ? "implicit"
                : "explicit";

            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);

            GTypeReference returnType = symbol != null
                ? this.typeMapper.Map(symbol.ReturnType, this.context, node.Type.GetLocation())
                : this.MapTypeSyntax(node.Type);

            BlockStatement body = (node.Body != null || node.ExpressionBody != null)
                ? this.TranslateBody(node, $"conversion operator '{kindKeyword}'")
                : null;

            GStatement arrowBody = node.ExpressionBody != null ? TryFoldArrowBody(body) : null;
            if (arrowBody != null)
            {
                body = null;
            }

            var method = new MethodDeclaration(
                $"operator {kindKeyword}",
                parameters: parameters,
                returnType: returnType,
                body: body,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);

            // The conversion operator has no receiver clause, so it stays an
            // in-body member of the owning type (returning IsStatic=false routes it
            // to the instance-member list in VisitAggregate, which the parser
            // accepts directly in the type body).
            return (method, false);
        }

        /// <summary>
        /// Issue #1190: a C# <c>static</c> auto-property with an inline initializer
        /// (<c>public static Version OSVersion { get; } = GetOsVersion();</c>) has no
        /// instance constructor to carry the initializer into (the OD-T1 path only
        /// services instance properties), and a static G# <c>prop</c> cannot declare
        /// an <c>init</c> accessor (GS0374). Such a property therefore maps to a
        /// static read-only/mutable backing field inside the <c>shared { }</c> block,
        /// preserving the initializer expression: a get-only property becomes a
        /// <c>shared let NAME T = expr</c> field, and a mutable
        /// (<c>{ get; private set; }</c> / <c>{ get; set; }</c>) property becomes a
        /// <c>shared var NAME T = expr</c> field. It is accessed identically
        /// (<c>Type.NAME</c>). A static auto-property without an initializer, or one
        /// with a getter body, keeps its existing handling.
        /// </summary>
        private bool TryTranslateStaticAutoPropertyField(
            PropertyDeclarationSyntax node,
            out FieldDeclaration field)
        {
            field = null;

            if (!node.Modifiers.Any(SyntaxKind.StaticKeyword) || node.Initializer == null)
            {
                return false;
            }

            // Auto-property: body-less, all accessors body-less, no expression body.
            if (node.ExpressionBody != null || node.AccessorList == null)
            {
                return false;
            }

            IReadOnlyList<AccessorDeclarationSyntax> accessors = node.AccessorList.Accessors;
            if (accessors.Any(a => a.Body != null || a.ExpressionBody != null))
            {
                return false;
            }

            bool hasGet = accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
            if (!hasGet)
            {
                return false;
            }

            bool hasSet = accessors.Any(a => a.IsKind(SyntaxKind.SetAccessorDeclaration));

            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            GExpression initializer = this.CoerceConstantToUnsigned(
                node.Initializer.Value,
                this.TranslateExpression(node.Initializer.Value));

            // Issue #1072: a non-nullable reference static auto-property whose
            // initializer is nullable (e.g. `GetAttribute<...>()?.Member`) is
            // rendered `T?` so the initializer assignment type-checks.
            if (symbol != null)
            {
                type = this.PromoteIfInitializerNullable(
                    type, symbol.Type, node.Initializer.Value);
            }

            // A mutable static auto-property (`{ get; set; }` / `{ get; private set; }`)
            // becomes a `var` field; an immutable get-only one becomes a `let` field.
            BindingKind binding = hasSet ? BindingKind.Var : BindingKind.Let;

            field = new FieldDeclaration(
                binding,
                SanitizeIdentifier(node.Identifier.Text),
                type,
                initializer: initializer,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists));

            return true;
        }

        private (GMember Member, bool IsStatic) TranslateProperty(PropertyDeclarationSyntax node)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            bool isStatic = symbol != null && symbol.IsStatic;

            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            // Issue #1354 / #1072: a non-nullable reference property that is
            // null-checked or null-assigned anywhere in the declaring type is
            // really nullable; render it `T?` so the `== nil`/`is null` guard
            // type-checks (gsc rejects `== nil` on a non-null operand, GS0129).
            if (symbol != null)
            {
                type = this.PromoteIfUsedAsNullable(type, symbol);
            }

            List<PropertyAccessor> accessors = this.MapAccessors(node);

            // Issue #1278 / ADR-0131: a C# expression-bodied read-only property
            // (`string Name => expr;`) renders as the idiomatic G# property-level
            // arrow `prop Name T -> expr` when its get body folds to a single
            // inline statement.
            GStatement arrowBody = TryFoldComputedPropertyArrow(node.ExpressionBody, accessors);
            if (arrowBody != null)
            {
                accessors = new List<PropertyAccessor>();
            }

            bool isOverride = symbol != null && symbol.IsOverride && !OverridesExternalBaseProperty(symbol);

            // Interface members are implicitly abstract; canonical G# interface
            // members carry no `open` modifier (ADR-0115 §B.6).
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            var property = new PropertyDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                type,
                accessors: accessors,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);

            return (property, isStatic);
        }

        private List<PropertyAccessor> MapAccessors(PropertyDeclarationSyntax node)
        {
            return this.MapAccessors(node, $"property '{node.Identifier.Text}'");
        }

        // Issue #1278 / ADR-0131: fold a C# expression-bodied property/indexer
        // into a property-level G# arrow `prop Name T -> expr`. Returns the
        // foldable single statement when the C# member used `=> expr` and its
        // translated get accessor is a single inline statement; otherwise null
        // (the caller keeps the get-only block accessor list).
        private static GStatement TryFoldComputedPropertyArrow(
            ArrowExpressionClauseSyntax csExpressionBody,
            List<PropertyAccessor> accessors)
        {
            if (csExpressionBody == null
                || accessors.Count != 1
                || accessors[0].Kind != AccessorKind.Get
                || accessors[0].Body == null)
            {
                return null;
            }

            return TryFoldArrowBody(accessors[0].Body);
        }

        private (GMember Member, bool IsStatic) TranslateIndexer(IndexerDeclarationSyntax node)
        {
            // ADR-0118 / issue #944: a C# indexer (`public T this[int i] => ...`)
            // maps to the canonical G# indexer member (`prop this[i int32] T`).
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            bool isStatic = symbol != null && symbol.IsStatic;

            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            List<Parameter> indexParameters = symbol != null
                ? symbol.Parameters.Select(p => this.MapParameter(p, node)).ToList()
                : this.MapParameterList(node.ParameterList);

            List<PropertyAccessor> accessors = this.MapAccessors(node, "indexer 'this[]'");

            // Issue #1278 / ADR-0131: a C# expression-bodied indexer
            // (`public T this[int i] => expr;`) renders as the idiomatic G#
            // indexer-level arrow `prop this[i T] U -> expr`.
            GStatement arrowBody = TryFoldComputedPropertyArrow(node.ExpressionBody, accessors);
            if (arrowBody != null)
            {
                accessors = new List<PropertyAccessor>();
            }

            bool isOverride = symbol != null && symbol.IsOverride && !OverridesExternalBaseProperty(symbol);
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            var property = new PropertyDeclaration(
                "this",
                type,
                accessors: accessors,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapAttributes(node.AttributeLists),
                indexerParameters: indexParameters,
                expressionBody: arrowBody);

            return (property, isStatic);
        }

        private List<PropertyAccessor> MapAccessors(BasePropertyDeclarationSyntax node, string displayName)
        {
            // An expression-bodied property (=> expr) is a get-only computed
            // property; its body is deferred to step 7 (ADR-0115 §B.11).
            ArrowExpressionClauseSyntax expressionBody = node switch
            {
                PropertyDeclarationSyntax p => p.ExpressionBody,
                IndexerDeclarationSyntax i => i.ExpressionBody,
                _ => null,
            };

            if (expressionBody != null)
            {
                return new List<PropertyAccessor>
                {
                    new PropertyAccessor(
                        AccessorKind.Get,
                        this.TranslateBody(node, $"{displayName} getter")),
                };
            }

            if (node.AccessorList == null)
            {
                return new List<PropertyAccessor>();
            }

            IReadOnlyList<AccessorDeclarationSyntax> declared = node.AccessorList.Accessors;
            bool anyBodied = declared.Any(a => a.Body != null || a.ExpressionBody != null);
            bool hasSet = declared.Any(a => a.IsKind(SyntaxKind.SetAccessorDeclaration));
            bool hasGet = declared.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
            bool hasInit = declared.Any(a => a.IsKind(SyntaxKind.InitAccessorDeclaration));

            // A read-write auto-property (all accessors body-less, has get + set)
            // maps to the canonical auto form `prop Name T` (ADR-0115 §B.11). An
            // init-only auto-property (get + init) keeps its explicit accessors so
            // the init-only semantics are preserved (issue #946).
            if (!anyBodied && hasGet && hasSet)
            {
                return new List<PropertyAccessor>();
            }

            // OD-T1: a C# get-only auto-property (`{ get; }`, body-less, no set/init)
            // is settable in the declaring type's constructor. G# `{ get; }` alone
            // is read-only (assigning it gives GS0127), so emit it as an init-only
            // auto-property `{ get; init; }`. Interface/abstract contract members
            // carry no backing field and remain read-only contracts.
            if (!anyBodied && hasGet && !hasSet && !hasInit)
            {
                var propSymbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
                bool isContract = propSymbol != null &&
                    (propSymbol.IsAbstract ||
                        propSymbol.ContainingType?.TypeKind == TypeKind.Interface);
                if (!isContract)
                {
                    return new List<PropertyAccessor>
                    {
                        new PropertyAccessor(AccessorKind.Get, null),
                        new PropertyAccessor(AccessorKind.Init, null),
                    };
                }
            }

            var accessors = new List<PropertyAccessor>();
            foreach (AccessorDeclarationSyntax accessor in declared)
            {
                AccessorKind kind;
                if (accessor.IsKind(SyntaxKind.GetAccessorDeclaration))
                {
                    kind = AccessorKind.Get;
                }
                else if (accessor.IsKind(SyntaxKind.InitAccessorDeclaration))
                {
                    // Issue #946: G# now supports a first-class 'init' accessor.
                    kind = AccessorKind.Init;
                }
                else
                {
                    kind = AccessorKind.Set;
                }

                bool bodied = accessor.Body != null || accessor.ExpressionBody != null;
                BlockStatement body = bodied
                    ? this.TranslateBody(
                        accessor,
                        $"{displayName} {kind.ToString().ToLowerInvariant()}ter")
                    : null;

                // Issue #1278 / ADR-0131: a C# expression-bodied accessor
                // (`get => e` / `set => e`) renders as the idiomatic G# arrow
                // accessor `get -> e` / `set -> e` when its body folds to a
                // single inline statement.
                GStatement arrowBody = accessor.ExpressionBody != null ? TryFoldArrowBody(body) : null;
                if (arrowBody != null)
                {
                    body = null;
                }

                accessors.Add(new PropertyAccessor(kind, body, expressionBody: arrowBody));
            }

            return accessors;
        }

        private GMember TranslateConstructor(
            ConstructorDeclarationSyntax node,
            IReadOnlyList<(string Name, GExpression Value)> propertyCtorInits)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            if (node.Modifiers.Any(SyntaxKind.StaticKeyword))
            {
                // A `static` constructor has no G# form. When it only initializes
                // static fields with simple `Field = value;` assignments, those are
                // folded into the corresponding `shared { }` field initializers
                // (see CollectStaticFieldInitializers / TranslateField) and the
                // constructor is dropped. Anything more complex is unsupported.
                if (this.IsFoldableStaticConstructor(node, symbol?.ContainingType))
                {
                    return null;
                }

                this.context.ReportUnsupported(
                    node,
                    "a non-trivial static constructor has no canonical G# form yet (ADR-0115 §B.11).");
                return null;
            }

            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);

            List<GExpression> baseArguments = null;
            bool isConvenience = false;
            if (node.Initializer != null)
            {
                if (node.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.BaseKeyword))
                {
                    // A `: base(args)` chain maps to the canonical G# explicit-base
                    // form `init(params) : base(args) { ... }` (sample
                    // ExplicitConstructor.gs; ADR-0115 §B.13). This is how a custom
                    // exception forwards its message to System.Exception's ctor.
                    baseArguments = this.TranslateArguments(node.Initializer.ArgumentList.Arguments);
                }
                else
                {
                    // `: this(args)` (constructor delegation) maps to a G#
                    // `convenience init(params) { init(args); ... }`: the delegated
                    // `init(args)` call is the first body statement (ADR-0065).
                    isConvenience = true;
                }
            }

            BlockStatement body = this.TranslateBody(node, $"constructor on '{node.Identifier.Text}'");

            if (isConvenience)
            {
                var delegated = new ExpressionStatement(new InvocationExpression(
                    new IdentifierExpression("init"),
                    this.TranslateArguments(node.Initializer.ArgumentList.Arguments)));
                var statements = new List<GStatement> { delegated };
                statements.AddRange(body.Statements);
                body = new BlockStatement(statements);
            }
            else if (propertyCtorInits != null && propertyCtorInits.Count > 0)
            {
                // OD-T1: move get-only auto-property inline initializers into the
                // designated constructor body (G# has no property member
                // initializer). Prepend them so the property is initialized before
                // the original constructor body runs, matching C# member-initializer
                // ordering. Delegating (`: this(...)`) constructors are skipped — the
                // designated target already runs the initializers.
                var statements = propertyCtorInits
                    .Select(p => (GStatement)new AssignmentStatement(new IdentifierExpression(p.Name), p.Value))
                    .ToList();
                statements.AddRange(body.Statements);
                body = new BlockStatement(statements);
            }

            return new ConstructorDeclaration(
                parameters,
                body,
                baseArguments: baseArguments,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists),
                isConvenience: isConvenience);
        }

        /// <summary>
        /// Collects the static-field initializers of a foldable <c>static</c>
        /// constructor so they can be re-attached to the corresponding fields
        /// (G# has no static-constructor form; ADR-0115 §B.11).
        /// </summary>
        private void CollectStaticFieldInitializers(TypeDeclarationSyntax node, INamedTypeSymbol typeSymbol)
        {
            foreach (MemberDeclarationSyntax member in node.Members)
            {
                if (member is not ConstructorDeclarationSyntax ctor ||
                    !ctor.Modifiers.Any(SyntaxKind.StaticKeyword) ||
                    !this.IsFoldableStaticConstructor(ctor, typeSymbol) ||
                    ctor.Body == null)
                {
                    continue;
                }

                foreach (StatementSyntax statement in ctor.Body.Statements)
                {
                    if (statement is ExpressionStatementSyntax expressionStatement &&
                        expressionStatement.Expression is AssignmentExpressionSyntax assignment &&
                        assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                        this.context.GetSymbolInfo(assignment.Left).Symbol is IFieldSymbol field)
                    {
                        this.staticFieldInitializers[field] = this.TranslateExpression(assignment.Right);
                    }
                }
            }
        }

        /// <summary>
        /// Issue #1729: a static constructor folds cleanly only when every
        /// statement is a simple <c>Field = expr;</c> assignment where (mode 2)
        /// the assigned field belongs to the type declaring the constructor — an
        /// assignment to another type's static field would be silently dropped,
        /// since the folded entry is keyed by that other field and never consumed
        /// — and (mode 3) the RHS does not depend on the type's own static state,
        /// since hoisting it to the field's declaration position could change
        /// C#'s field-initializers-then-cctor evaluation order. Anything else is
        /// reported as unsupported instead of silently folded.
        /// </summary>
        private bool IsFoldableStaticConstructor(ConstructorDeclarationSyntax node, INamedTypeSymbol typeSymbol)
        {
            if (node.Body == null)
            {
                return node.ExpressionBody == null;
            }

            if (typeSymbol == null)
            {
                return false;
            }

            foreach (StatementSyntax statement in node.Body.Statements)
            {
                if (statement is not ExpressionStatementSyntax expressionStatement ||
                    expressionStatement.Expression is not AssignmentExpressionSyntax assignment ||
                    !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) ||
                    this.context.GetSymbolInfo(assignment.Left).Symbol is not IFieldSymbol { IsStatic: true } field ||
                    !SymbolEqualityComparer.Default.Equals(field.ContainingType, typeSymbol) ||
                    this.ReferencesStaticMemberOfType(assignment.Right, typeSymbol))
                {
                    return false;
                }
            }

            return true;
        }

        private (GTypeReference BaseType, List<GTypeReference> Interfaces) MapBaseClause(
            INamedTypeSymbol symbol,
            SyntaxNode node,
            TypeDeclarationKind kind)
        {
            var interfaces = new List<GTypeReference>();
            GTypeReference baseType = null;

            if (symbol == null)
            {
                return (null, interfaces);
            }

            Location location = node.GetLocation();
            INamedTypeSymbol csBase = symbol.BaseType;
            if (csBase != null &&
                csBase.SpecialType != SpecialType.System_Object &&
                csBase.SpecialType != SpecialType.System_ValueType &&
                csBase.TypeKind == TypeKind.Class &&
                csBase.Name != "Enum")
            {
                baseType = this.typeMapper.Map(csBase, this.context, location);
            }

            // A `data class` / `data struct` (C# record / record struct) synthesizes
            // structural equality in G#, exactly as the C# record auto-implements
            // `IEquatable<Self>`. Re-stating the synthesized `IEquatable[Self]` base
            // clause is redundant for a `data` type (equality comes from the `data`
            // modifier) and would be unimplemented on a fieldless record mapped to a
            // plain `class` (no synthesized `Equals`), so it is dropped here.
            // (Naming the enclosing type as a base-clause type ARGUMENT is itself
            // legal since issue #949 — `open class Shape : IEquatable[Shape]` now
            // compiles; the drop is a semantic redundancy filter, not a syntax
            // limitation.) See ADR-0115 §B.4.
            bool isRecord = symbol.IsRecord;
            foreach (INamedTypeSymbol iface in symbol.Interfaces)
            {
                if (isRecord && IsIEquatableOf(iface, symbol))
                {
                    continue;
                }

                // Interface inheritance is supported by the G# parser since
                // issue #1006 (`interface B : A, C { ... }`); the printer emits
                // base interfaces via the same base-clause path as a class, so
                // a base interface is added to the interface's base list.
                interfaces.Add(this.typeMapper.Map(iface, this.context, location));
            }

            return (baseType, interfaces);
        }

        private static bool IsIEquatableOf(INamedTypeSymbol iface, INamedTypeSymbol self)
        {
            return iface.IsGenericType &&
                iface.Name == "IEquatable" &&
                iface.ContainingNamespace?.ToDisplayString() == "System" &&
                iface.TypeArguments.Length == 1 &&
                SymbolEqualityComparer.Default.Equals(iface.TypeArguments[0], self);
        }

        private List<TypeParameter> MapTypeParameters(INamedTypeSymbol symbol)
        {
            if (symbol == null || symbol.TypeParameters.Length == 0)
            {
                return new List<TypeParameter>();
            }

            return symbol.TypeParameters.Select(this.MapTypeParameter).ToList();
        }

        private List<TypeParameter> MapMethodTypeParameters(IMethodSymbol symbol)
        {
            if (symbol == null || symbol.TypeParameters.Length == 0)
            {
                return new List<TypeParameter>();
            }

            return symbol.TypeParameters.Select(this.MapTypeParameter).ToList();
        }

        private TypeParameter MapTypeParameter(ITypeParameterSymbol tp)
        {
            var flags = new List<string>();
            if (tp.HasReferenceTypeConstraint)
            {
                flags.Add("class");
            }

            if (tp.HasUnmanagedTypeConstraint)
            {
                // Issue #1336: C# `where T : unmanaged` maps to the G# `unmanaged`
                // flag constraint. It subsumes `struct` (gsc reports a conflict if
                // both are spelled), so the value-type flag is intentionally omitted.
                flags.Add("unmanaged");
            }
            else if (tp.HasValueTypeConstraint)
            {
                flags.Add("struct");
            }

            if (tp.HasConstructorConstraint)
            {
                flags.Add("init()");
            }

            // C# `where T : notnull` has no precise G# constraint keyword; it is
            // dropped (the closest forms `comparable`/`any` change semantics), and
            // the loss is recorded (ADR-0115 §B.7 gap).
            if (tp.HasNotNullConstraint)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.TypeParameterConstraintClause),
                    $"type parameter '{tp.Name}' has a 'notnull' constraint; G# has no equivalent constraint keyword, so it is dropped (ADR-0115 §B.7 gap).",
                    tp.Locations.FirstOrDefault(),
                    TranslationSeverity.Info));
            }

            string legacy = null;
            if (tp.ConstraintTypes.Length > 0)
            {
                ITypeSymbol primary = tp.ConstraintTypes[0];

                // Issue #943: a constructed generic-interface constraint
                // (`where T : IComparable<T>`) now has a canonical G# form —
                // `[T IComparable[T]]` — which parses, binds, emits verifiable
                // IL, and is enforced. Render the constraint type (including its
                // type arguments, e.g. the self-referential `T`) into the legacy
                // constraint slot via the type mapper + printer.
                if (primary is INamedTypeSymbol { IsGenericType: true })
                {
                    GTypeReference constraintRef = this.typeMapper.Map(primary, this.context, tp.Locations.FirstOrDefault());
                    legacy = GSharpPrinter.RenderTypeReference(constraintRef);
                }
                else
                {
                    legacy = primary.Name;
                }

                if (tp.ConstraintTypes.Length > 1)
                {
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.TypeParameterConstraintClause),
                        $"type parameter '{tp.Name}' has multiple constraint types; only the first ('{legacy}') is carried into the G# legacy-constraint slot (ADR-0115 §B.7).",
                        tp.Locations.FirstOrDefault(),
                        TranslationSeverity.Info));
                }
            }

            Variance variance = tp.Variance switch
            {
                VarianceKind.Out => Variance.Out,
                VarianceKind.In => Variance.In,
                _ => Variance.None,
            };

            return new TypeParameter(SanitizeIdentifier(tp.Name), legacy, flags, variance);
        }

        private IReadOnlyList<Parameter> MapPrimaryConstructor(TypeDeclarationSyntax node)
        {
            if (node is RecordDeclarationSyntax record && record.ParameterList != null)
            {
                return this.MapParameterList(record.ParameterList);
            }

            return null;
        }

        private List<Parameter> MapParameters(IMethodSymbol symbol, ParameterListSyntax syntax, bool skipFirst)
        {
            if (symbol != null)
            {
                IEnumerable<IParameterSymbol> source = symbol.Parameters;
                if (skipFirst)
                {
                    source = source.Skip(1);
                }

                // Fall back to the parameter LIST's syntax as the diagnostic anchor
                // for each parameter symbol here: when `symbol` overrides/implements
                // a member from a REFERENCED assembly, its `IParameterSymbol`s have
                // no `DeclaringSyntaxReferences` of their own (see
                // <see cref="MapConstantDefault"/> remarks).
                return source.Select(p => this.MapParameter(p, syntax)).ToList();
            }

            return syntax == null ? new List<Parameter>() : this.MapParameterList(syntax);
        }

        private List<Parameter> MapParameterList(BaseParameterListSyntax syntax)
        {
            var parameters = new List<Parameter>();
            foreach (ParameterSyntax parameter in syntax.Parameters)
            {
                if (this.context.GetDeclaredSymbol(parameter) is IParameterSymbol symbol)
                {
                    parameters.Add(this.MapParameter(symbol, parameter));
                }
            }

            return parameters;
        }

        private Parameter MapParameter(IParameterSymbol symbol, SyntaxNode fallbackNode)
        {
            string refKind = symbol.RefKind switch
            {
                RefKind.Ref => "ref",
                RefKind.Out => "out",
                RefKind.In => "in",
                _ => null,
            };

            bool variadic = symbol.IsParams;
            ITypeSymbol parameterType = symbol.Type;
            if (variadic && parameterType is IArrayTypeSymbol arrayType)
            {
                parameterType = arrayType.ElementType;
            }

            GTypeReference type = this.typeMapper.Map(parameterType, this.context, symbol.Locations.FirstOrDefault());

            // Issue #1072: a non-nullable reference/array parameter that is
            // null-checked or null-assigned in the method body is really nullable;
            // render it `T?` so the `== nil` guard type-checks (variadic params are
            // never null-compared as a whole, so they are excluded).
            if (!variadic)
            {
                type = this.PromoteIfUsedAsNullable(type, symbol);
            }

            GExpression defaultValue = this.BuildOptionalParameterDefault(symbol, type, fallbackNode);

            return new Parameter(SanitizeIdentifier(symbol.Name), type, variadic, refKind, defaultValue);
        }

        /// <summary>
        /// Computes the G# default-value expression for an optional C# parameter,
        /// or <c>null</c> when the parameter is required or its default cannot be
        /// represented as a simple literal. An optional parameter whose default is
        /// the zero value (<c>= default</c>, <c>= default(T)</c>, or <c>= null</c>)
        /// must never be dropped — doing so makes the parameter required and triggers
        /// GS0144 at call sites. A non-nullable value type emits <c>default(T)</c>
        /// (gsc rejects a bare <c>default</c> with GS0265); a reference or nullable
        /// value type emits <c>nil</c>.
        /// </summary>
        /// <remarks>
        /// Issue #1731 N1: a C# optional-parameter default must itself be a
        /// compile-time constant, so this method (and <see cref="MapConstantDefault"/>)
        /// only ever reads <c>symbol.ExplicitDefaultValue</c> — it never calls
        /// <c>TranslateExpression</c>/<c>TranslatePatternTest</c>/
        /// <c>TranslateRangeSlice</c> on the source syntax at all. A non-constant
        /// default (which could theoretically embed an `is`-pattern or a
        /// range-slice, except neither of those is itself a constant expression
        /// either) falls through to the "not a simple literal" diagnostic below
        /// and is omitted, never translated. So `SpillOperand`'s no-seam
        /// fallback can never be reached from here.
        /// </remarks>
        private GExpression BuildOptionalParameterDefault(IParameterSymbol symbol, GTypeReference type, SyntaxNode fallbackNode)
        {
            if (!symbol.HasExplicitDefaultValue)
            {
                return null;
            }

            GExpression defaultValue = this.MapConstantDefault(symbol, fallbackNode);
            if (defaultValue != null)
            {
                return defaultValue;
            }

            if (symbol.ExplicitDefaultValue == null)
            {
                bool nullableValueType =
                    symbol.Type.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T;
                bool nonNullableValueType = symbol.Type.IsValueType
                    && !nullableValueType
                    && symbol.Type.NullableAnnotation != NullableAnnotation.Annotated;
                return nonNullableValueType
                    ? new DefaultValueExpression(type)
                    : new IdentifierExpression("nil");
            }

            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.EqualsValueClause),
                $"parameter '{symbol.Name}' has a default value that is not a simple literal; the default is omitted for now (deferred to step 7).",
                symbol.Locations.FirstOrDefault(),
                TranslationSeverity.Info));
            return null;
        }

        private GTypeReference MapReturnType(IMethodSymbol symbol, MethodDeclarationSyntax node)
        {
            if (symbol != null)
            {
                if (symbol.ReturnsVoid)
                {
                    return null;
                }

                ITypeSymbol returnType = symbol.ReturnType;

                // An iterator `func` (its body contains a `yield`) that DECLARES a
                // C# `IEnumerable[T]` envelope maps to the G# `sequence[T]` element
                // type, not the envelope itself (spec §Iterators; sample
                // TupleSequenceIterators.gs). The element type is the single type
                // argument of the C# IEnumerable<T> return.
                //
                // An iterator whose declared return type is `IEnumerator[T]` is the
                // class-level `GetEnumerator()` member of an `IEnumerable[T]`
                // implementation: it must keep the `IEnumerator[T]` return type so it
                // satisfies `IEnumerable[T].GetEnumerator` and forms the dual
                // GetEnumerator bridge pair with the non-generic
                // `func GetEnumerator() IEnumerator` (issue #985). A G# generator may
                // return `IEnumerator[T]`, so the `yield` body is unaffected — only
                // `IEnumerable[T]` returns are rewritten to `sequence[T]`.
                if (IsIteratorBody(node) &&
                    returnType is INamedTypeSymbol { IsGenericType: true } enumerable &&
                    enumerable.Name is "IEnumerable")
                {
                    GTypeReference element = this.typeMapper.Map(
                        enumerable.TypeArguments[0], this.context, node.ReturnType.GetLocation());
                    return new NamedTypeReference("sequence", new[] { element });
                }

                // A G# `async func` declares the UNWRAPPED result type; the `async`
                // modifier synthesizes the `Task`/`Task<T>` envelope (samples
                // AsyncTask.gs, AsyncValueReturns.gs). C# `async Task` → no return
                // type; `async Task<int>` → `int32` (ADR-0115 §B async).
                if (symbol.IsAsync &&
                    returnType is INamedTypeSymbol { Name: "Task" } task &&
                    task.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
                {
                    return task.IsGenericType
                        ? this.typeMapper.Map(task.TypeArguments[0], this.context, node.ReturnType.GetLocation())
                        : null;
                }

                return this.typeMapper.Map(returnType, this.context, node.ReturnType.GetLocation());
            }

            return node.ReturnType is PredefinedTypeSyntax predefined &&
                predefined.Keyword.IsKind(SyntaxKind.VoidKeyword)
                    ? null
                    : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
        }

        private static bool IsIteratorBody(MethodDeclarationSyntax node)
        {
            SyntaxNode body = (SyntaxNode)node.Body ?? node.ExpressionBody;
            if (body == null)
            {
                return false;
            }

            // A `yield` inside a nested local function belongs to that function, not
            // to this method, so descendants under a local-function boundary are
            // excluded from the iterator test.
            return body.DescendantNodes(n => n is not LocalFunctionStatementSyntax)
                .OfType<YieldStatementSyntax>()
                .Any();
        }

        private List<AttributeUse> MapAttributes(SyntaxList<AttributeListSyntax> attributeLists)
        {
            var attributes = new List<AttributeUse>();
            foreach (AttributeListSyntax list in attributeLists)
            {
                string target = list.Target?.Identifier.Text;
                foreach (AttributeSyntax attribute in list.Attributes)
                {
                    var arguments = new List<AttributeArgument>();
                    if (attribute.ArgumentList != null)
                    {
                        foreach (AttributeArgumentSyntax argument in attribute.ArgumentList.Arguments)
                        {
                            GExpression value = this.MapAttributeArgumentValue(argument);
                            string name = argument.NameEquals?.Name.Identifier.Text
                                ?? argument.NameColon?.Name.Identifier.Text;
                            arguments.Add(new AttributeArgument(value, name));
                        }
                    }

                    string attributeName = attribute.Name.ToString();
                    int aliasSeparator = attributeName.IndexOf("::", System.StringComparison.Ordinal);
                    if (aliasSeparator >= 0)
                    {
                        // Strip a `global::` (or extern-alias) qualifier; G# has no
                        // alias-qualified name syntax.
                        attributeName = attributeName.Substring(aliasSeparator + 2);
                    }

                    attributes.Add(new AttributeUse(attributeName, arguments, target));
                }
            }

            return attributes;
        }

        // Issue #1731 N1: attribute-argument expressions here can never be an
        // `is`-pattern or a range-slice (i.e. can never reach `SpillOperand`'s
        // no-seam fallback) — C# requires every attribute argument to be a
        // compile-time constant (or a `typeof`/array of constants), and
        // neither an `is` pattern-match nor a `x[a..b]` range-slice is ever a
        // constant expression. So the double-evaluation gap this file
        // otherwise guards against has no way to reach this call site.
        private GExpression MapAttributeArgumentValue(AttributeArgumentSyntax argument)
        {
            Optional<object> constant = this.context.SemanticModel.GetConstantValue(argument.Expression);
            if (constant.HasValue)
            {
                // Issue #1733: an enum-typed attribute argument (e.g.
                // `[Kind(Color.Blue)]`) constant-folds to its boxed underlying
                // integer just like an enum-typed parameter default; resolve it to
                // the member reference via the same helper used for
                // <see cref="MapConstantDefault"/> rather than emit the raw int
                // (see <see cref="MapEnumConstant"/> remarks on renumbering).
                ITypeSymbol argumentType = this.context.GetTypeInfo(argument.Expression).ConvertedType;
                if (constant.Value != null && argumentType?.TypeKind == TypeKind.Enum && IsIntegral(constant.Value))
                {
                    GExpression enumValue = this.MapEnumConstant(
                        argumentType, constant.Value, argument, "attribute argument");
                    if (enumValue != null)
                    {
                        return enumValue;
                    }
                }

                switch (constant.Value)
                {
                    case null:
                        return new IdentifierExpression("nil");
                    case string s:
                        return LiteralExpression.String(s);
                    case bool b:
                        return new IdentifierExpression(b ? "true" : "false");
                    case char c:
                        return LiteralExpression.Char(c.ToString());
                    case double d when MapSpecialFloatConstant(d, isDouble: true) is { } specialD:
                        return specialD;
                    case float f when MapSpecialFloatConstant(f, isDouble: false) is { } specialF:
                        return specialF;
                    default:
                        if (IsIntegral(constant.Value))
                        {
                            return LiteralExpression.Int(
                                System.Convert.ToString(constant.Value, CultureInfo.InvariantCulture));
                        }

                        break;
                }
            }

            // Fall back to the verbatim C# text for non-constant attribute
            // arguments; these are rare and re-reviewed in triage.
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.AttributeArgument),
                "attribute argument is not a simple constant; emitted its verbatim text (ADR-0115 §B.11).",
                argument.GetLocation(),
                TranslationSeverity.Info));
            return new IdentifierExpression(argument.Expression.ToString());
        }

        /// <summary>
        /// The single body-translation seam (ADR-0115 §B): a recursive statement /
        /// expression translator over the C# body that produces a parseable G#
        /// <see cref="BlockStatement"/>. Constructs with no canonical G# form are
        /// recorded as structured <see cref="TranslationDiagnostic"/> records and
        /// emit the nearest parseable placeholder — never non-parsing text.
        /// </summary>
        /// <param name="bodyOwner">The C# node that owns the body.</param>
        /// <param name="description">A human-readable label for the body.</param>
        /// <returns>The translated block.</returns>
        private BlockStatement TranslateBody(SyntaxNode bodyOwner, string description)
        {
            SyntaxNode previousScope = this.currentBodyScope;
            this.currentBodyScope = bodyOwner;
            try
            {
                BlockStatement body = this.TranslateBodyCore(bodyOwner, description);
                return this.WithParameterShadows(bodyOwner, body);
            }
            finally
            {
                this.currentBodyScope = previousScope;
            }
        }

        // Issue #1278 / ADR-0131: a C# expression-bodied member (`=> expr`)
        // translates to the idiomatic G# arrow form (`-> expr`) when the
        // translated body folds to a single, inline-renderable statement. A
        // value-returning body is `{ return expr }`; a void body is a single
        // expression or assignment statement. Bodies that needed extra
        // statements (parameter shadows, hoisted temporaries, a bare `throw`
        // expression, or an `unsafe { }` wrap) do not fold and keep their block
        // body so the emitted G# stays correct.
        private static GStatement TryFoldArrowBody(BlockStatement block)
        {
            if (block == null || block.IsUnsafe || block.Statements.Count != 1)
            {
                return null;
            }

            GStatement only = block.Statements[0];
            return only switch
            {
                ReturnStatement r when r.Expression != null => r,
                ExpressionStatement => only,
                AssignmentStatement => only,
                _ => null,
            };
        }

        // G# function parameters are read-only (Kotlin-style); a C# method that
        // reassigns a value parameter must shadow it with a mutable local at the top
        // of the body (`var p = p`) so the later writes are legal. Parameters that
        // are never reassigned, or that are already `ref`/`out`/`in`, are left alone.
        private BlockStatement WithParameterShadows(SyntaxNode bodyOwner, BlockStatement body)
        {
            BaseParameterListSyntax parameterList = bodyOwner switch
            {
                MethodDeclarationSyntax method => method.ParameterList,
                OperatorDeclarationSyntax op => op.ParameterList,
                ConversionOperatorDeclarationSyntax conversion => conversion.ParameterList,
                ConstructorDeclarationSyntax ctor => ctor.ParameterList,
                LocalFunctionStatementSyntax localFunction => localFunction.ParameterList,
                _ => null,
            };

            if (parameterList == null || parameterList.Parameters.Count == 0)
            {
                return body;
            }

            var shadows = new List<GStatement>();
            foreach (ParameterSyntax parameter in parameterList.Parameters)
            {
                if (this.context.GetDeclaredSymbol(parameter) is not IParameterSymbol symbol
                    || symbol.RefKind != RefKind.None
                    || !this.IsSymbolReassigned(symbol, bodyOwner))
                {
                    continue;
                }

                string name = SanitizeIdentifier(parameter.Identifier.Text);
                shadows.Add(new LocalDeclarationStatement(
                    BindingKind.Var, name, type: null, new IdentifierExpression(name)));
            }

            if (shadows.Count == 0)
            {
                return body;
            }

            shadows.AddRange(body.Statements);
            return new BlockStatement(shadows, body.IsUnsafe);
        }

        private BlockStatement TranslateBodyCore(SyntaxNode bodyOwner, string description)
        {
            switch (bodyOwner)
            {
                case MethodDeclarationSyntax method:
                    if (method.Body != null)
                    {
                        return this.TranslateBlock(method.Body);
                    }

                    if (method.ExpressionBody != null)
                    {
                        bool returnsVoid =
                            (this.context.GetDeclaredSymbol(method) as IMethodSymbol)?.ReturnsVoid ?? false;
                        return this.WrapExpressionBody(method.ExpressionBody.Expression, returnsVoid);
                    }

                    break;

                case OperatorDeclarationSyntax op:
                    if (op.Body != null)
                    {
                        return this.TranslateBlock(op.Body);
                    }

                    if (op.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(op.ExpressionBody.Expression, isVoid: false);
                    }

                    break;

                case ConversionOperatorDeclarationSyntax conversion:
                    if (conversion.Body != null)
                    {
                        return this.TranslateBlock(conversion.Body);
                    }

                    if (conversion.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(conversion.ExpressionBody.Expression, isVoid: false);
                    }

                    break;

                case ConstructorDeclarationSyntax ctor:

                    if (ctor.Body != null)
                    {
                        return this.TranslateBlock(ctor.Body);
                    }

                    if (ctor.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(ctor.ExpressionBody.Expression, isVoid: true);
                    }

                    break;

                case AccessorDeclarationSyntax accessor:
                    if (accessor.Body != null)
                    {
                        return this.TranslateBlock(accessor.Body);
                    }

                    if (accessor.ExpressionBody != null)
                    {
                        bool isGetter = accessor.IsKind(SyntaxKind.GetAccessorDeclaration);
                        return this.WrapExpressionBody(accessor.ExpressionBody.Expression, isVoid: !isGetter);
                    }

                    break;

                case PropertyDeclarationSyntax property when property.ExpressionBody != null:
                    // An expression-bodied property is a get-only computed property.
                    return this.WrapExpressionBody(property.ExpressionBody.Expression, isVoid: false);

                case IndexerDeclarationSyntax indexer when indexer.ExpressionBody != null:
                    // An expression-bodied indexer is a get-only computed indexer.
                    return this.WrapExpressionBody(indexer.ExpressionBody.Expression, isVoid: false);

                case DestructorDeclarationSyntax destructor:
                    if (destructor.Body != null)
                    {
                        return this.TranslateBlock(destructor.Body);
                    }

                    if (destructor.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(destructor.ExpressionBody.Expression, isVoid: true);
                    }

                    break;
            }

            // No recognizable body; emit an empty parseable block.
            return new BlockStatement(new List<GStatement>());
        }

        private BlockStatement WrapExpressionBody(ExpressionSyntax expression, bool isVoid)
        {
            if (expression is ThrowExpressionSyntax bareThrow)
            {
                // `=> throw e` is a diverging body; G# `throw` is a statement, so
                // emit it directly rather than wrapping a value (ADR-0115 §B).
                return new BlockStatement(new List<GStatement>
                {
                    new ThrowStatement(this.TranslateExpression(bareThrow.Expression)),
                });
            }

            if (isVoid)
            {
                // A void expression body is an executed statement (often an
                // assignment, which is statement-only in G#), so route it through
                // the statement seam rather than wrapping the value. It behaves
                // like `TranslateStatement` for spill-hoisting purposes (issue
                // #1731): it has no OUTER statement of its own, so it opens its
                // own seam via <see cref="WithSpillSeam"/>.
                return new BlockStatement(this.WithSpillSeam(
                    () => this.TranslateExpressionStatements(expression).ToList()).ToList());
            }

            return new BlockStatement(this.WithSpillSeam(() => this.WithHoistedPostfix(
                expression,
                () => new GStatement[] { new ReturnStatement(this.TranslateExpression(expression)) }).ToList()).ToList());
        }

        private BlockStatement TranslateBlock(BlockSyntax block)
        {
            var statements = new List<GStatement>();
            foreach (StatementSyntax statement in this.HoistCallBeforeDeclLocalFunctions(block))
            {
                statements.AddRange(this.TranslateStatement(statement));
            }

            return new BlockStatement(statements);
        }

        // C# local functions are hoisted (callable before their lexical
        // declaration), but G# renders them as `let name = func(...)` bindings,
        // which are NOT hoisted and cannot be forward-referenced (GS0130/GS0125).
        // When a local function is called before its declaration within a block,
        // move its declaration to the top of the block — but only when it is safe
        // to do so (it must not capture a sibling local declared in the same
        // block, since G# closures require captured locals to already be in scope
        // at the binding point).
        private IReadOnlyList<StatementSyntax> HoistCallBeforeDeclLocalFunctions(BlockSyntax block)
        {
            SyntaxList<StatementSyntax> statements = block.Statements;
            var localFunctions = statements.OfType<LocalFunctionStatementSyntax>().ToList();
            if (localFunctions.Count == 0)
            {
                return statements;
            }

            var toHoist = new List<LocalFunctionStatementSyntax>();
            foreach (LocalFunctionStatementSyntax localFunction in localFunctions)
            {
                int declIndex = statements.IndexOf(localFunction);
                if (this.context.GetDeclaredSymbol(localFunction) is not IMethodSymbol funcSymbol)
                {
                    continue;
                }

                bool usedBeforeDeclaration = false;
                for (int i = 0; i < declIndex && !usedBeforeDeclaration; i++)
                {
                    usedBeforeDeclaration = statements[i]
                        .DescendantNodes()
                        .OfType<IdentifierNameSyntax>()
                        .Any(id => id.Identifier.Text == localFunction.Identifier.Text
                            && SymbolEqualityComparer.Default.Equals(
                                this.context.GetSymbolInfo(id).Symbol, funcSymbol));
                }

                if (!usedBeforeDeclaration)
                {
                    continue;
                }

                if (this.CapturesSiblingBlockLocal(localFunction, block))
                {
                    continue;
                }

                toHoist.Add(localFunction);
            }

            if (toHoist.Count == 0)
            {
                return statements;
            }

            var reordered = new List<StatementSyntax>(toHoist);
            foreach (StatementSyntax statement in statements)
            {
                if (!toHoist.Contains(statement))
                {
                    reordered.Add(statement);
                }
            }

            return reordered;
        }

        // Returns true when the local function references a local variable that is
        // declared directly within the given block (a sibling), which would make
        // hoisting the function to the top of that block unsafe. References to the
        // enclosing method's parameters, outer-scope locals, or the function's own
        // locals/parameters are fine — those remain in scope at the top.
        private bool CapturesSiblingBlockLocal(LocalFunctionStatementSyntax localFunction, BlockSyntax block)
        {
            foreach (IdentifierNameSyntax id in localFunction.DescendantNodes().OfType<IdentifierNameSyntax>())
            {
                if (this.context.GetSymbolInfo(id).Symbol is not ILocalSymbol local)
                {
                    continue;
                }

                foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
                {
                    SyntaxNode declaration = reference.GetSyntax();

                    // A local declared inside the function's own body is safe.
                    if (localFunction.Span.Contains(declaration.Span))
                    {
                        continue;
                    }

                    // A local declared (directly or nested) within this block but
                    // outside the function is a sibling capture — unsafe to hoist.
                    if (block.Span.Contains(declaration.Span))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private IEnumerable<GStatement> TranslateFixedStatement(FixedStatementSyntax node)
        {
            // Translate the innermost body once; multiple declarators nest as
            // successive `fixed` blocks (`fixed a … { fixed b … { body } }`).
            BlockStatement body = this.TranslateStatementAsBlock(node.Statement);

            VariableDeclarationSyntax declaration = node.Declaration;
            GTypeReference pointerType = this.MapTypeSyntax(declaration.Type);

            for (int i = declaration.Variables.Count - 1; i >= 0; i--)
            {
                VariableDeclaratorSyntax declarator = declaration.Variables[i];
                GExpression source = declarator.Initializer != null
                    ? this.TranslateExpression(declarator.Initializer.Value)
                    : new IdentifierExpression("nil");
                body = new BlockStatement(new GStatement[]
                {
                    new FixedStatement(
                        SanitizeIdentifier(declarator.Identifier.Text),
                        pointerType,
                        source,
                        body),
                });
            }

            // Unwrap the single outer wrapper block so the caller receives the
            // `fixed` statement(s) directly.
            return body.Statements;
        }

        private BlockStatement TranslateStatementAsBlock(StatementSyntax statement)
        {
            if (statement is BlockSyntax block)
            {
                return this.TranslateBlock(block);
            }

            return new BlockStatement(this.TranslateStatement(statement).ToList());
        }

        // Establishes a fresh statement seam (issue #1731) around each statement's
        // translation: any spill hoisted while translating `statement` (see
        // <see cref="SpillOperand"/>) is collected into its own prologue and
        // emitted immediately ahead of `statement`'s own output, then the ambient
        // seam is restored — so a nested statement (e.g. a block's own children)
        // always gets its own independent seam rather than sharing this one.
        private IEnumerable<GStatement> TranslateStatement(StatementSyntax statement)
        {
            List<GStatement> outerSpillPrologue = this.pendingSpillPrologue;
            var spillPrologue = new List<GStatement>();
            this.pendingSpillPrologue = spillPrologue;
            try
            {
                List<GStatement> core = this.TranslateStatementCore(statement).ToList();
                if (spillPrologue.Count == 0)
                {
                    return core;
                }

                var combined = new List<GStatement>(spillPrologue);
                combined.AddRange(core);
                return combined;
            }
            finally
            {
                this.pendingSpillPrologue = outerSpillPrologue;
            }
        }

        private IEnumerable<GStatement> TranslateStatementCore(StatementSyntax statement)
        {
            switch (statement)
            {
                case LocalDeclarationStatementSyntax local:
                    return this.TranslateLocalDeclaration(
                        local.Declaration,
                        local.IsConst,
                        isUsing: local.UsingKeyword != default);

                case ExpressionStatementSyntax expressionStatement:
                    return this.TranslateExpressionStatements(expressionStatement.Expression);

                case BreakStatementSyntax:
                    return new[] { (GStatement)new BreakStatement() };

                case ContinueStatementSyntax:
                    return new[] { (GStatement)new ContinueStatement() };

                case DoStatementSyntax doStatement:
                    if (this.TryTranslateLoopWithConditionHoist(
                            doStatement.Condition,
                            doStatement.Statement,
                            isDoWhile: true,
                            out IReadOnlyList<GStatement> doHoisted))
                    {
                        return doHoisted;
                    }

                    return new[]
                    {
                        (GStatement)new DoWhileStatement(
                            this.TranslateStatementAsBlock(doStatement.Statement),
                            this.TranslateExpression(doStatement.Condition)),
                    };

                case LockStatementSyntax lockStatement:
                    return new[] { this.TranslateLock(lockStatement) };

                case LocalFunctionStatementSyntax localFunction:
                    return new[] { this.TranslateLocalFunction(localFunction) };

                case CheckedStatementSyntax checkedStatement:
                    // G# arithmetic is unchecked by default and has no
                    // `checked`/`unchecked` block keyword; emit the inner block.
                    return new[] { (GStatement)this.TranslateBlock(checkedStatement.Block) };

                case UnsafeStatementSyntax unsafeStatement:
                    // ADR-0122 / issue #1014: a C# `unsafe { … }` block maps to the
                    // G# `unsafe { … }` block, introducing an unsafe context.
                    return new[]
                    {
                        (GStatement)new BlockStatement(
                            this.TranslateBlock(unsafeStatement.Block).Statements,
                            isUnsafe: true),
                    };

                case FixedStatementSyntax fixedStatement:
                    // gsc issue #1026: a C# `fixed (T* p = src) { … }` pins a managed
                    // array/string and exposes a raw pointer, mapping to the G#
                    // `fixed p *T = src { … }` form (only legal inside `unsafe`).
                    return this.TranslateFixedStatement(fixedStatement);

                case ReturnStatementSyntax ret:
                {
                    if (ret.Expression == null)
                    {
                        return new[] { (GStatement)new ReturnStatement(null) };
                    }

                    // `return (x = M());` — a value-position assignment in the
                    // return expression is hoisted into a preceding assignment
                    // statement; it runs once, exactly where C# would evaluate it
                    // (issue #1723).
                    var returnPrologue = new List<GStatement>();
                    List<AssignmentExpressionSyntax> returnEmbedded =
                        this.CollectEmbeddedAssignments(ret.Expression, includeSelf: true);
                    foreach (AssignmentExpressionSyntax node in returnEmbedded)
                    {
                        returnPrologue.AddRange(this.FlattenChainedAssignment(node));
                    }

                    foreach (AssignmentExpressionSyntax node in returnEmbedded)
                    {
                        this.suppressedAssignments.Add(node);
                    }

                    GExpression returnValue;
                    try
                    {
                        returnValue = this.TranslateValueWithNullForgiveness(ret.Expression);
                    }
                    finally
                    {
                        foreach (AssignmentExpressionSyntax node in returnEmbedded)
                        {
                            this.suppressedAssignments.Remove(node);
                        }
                    }

                    returnPrologue.Add(new ReturnStatement(returnValue));
                    return returnPrologue;
                }

                case IfStatementSyntax ifStatement:
                    return this.TranslateIfStatements(ifStatement).ToArray();

                case WhileStatementSyntax whileStatement:
                    if (this.TryTranslateLoopWithConditionHoist(
                            whileStatement.Condition,
                            whileStatement.Statement,
                            isDoWhile: false,
                            out IReadOnlyList<GStatement> whileHoisted))
                    {
                        return whileHoisted;
                    }

                    return new[]
                    {
                        (GStatement)new WhileStatement(
                            GuardBlockCondition(this.TranslateExpression(whileStatement.Condition)),
                            this.TranslateStatementAsBlock(whileStatement.Statement)),
                    };

                case ForStatementSyntax forStatement:
                    return new[] { this.TranslateForStatement(forStatement) };

                case ForEachStatementSyntax forEach:
                    // The iterable receiver gets the same nullable-narrowing `!!`
                    // treatment as a member/element-access receiver: a declared-
                    // nullable (or #1072-promoted) field/property iterated inside a
                    // null guard is flow-proven non-null in C#, but G# smart-casts
                    // narrow only locals, so `for x in field` over a `T?` field is
                    // rejected (GS0116 "not indexable") without an explicit
                    // `field!!`.
                    //
                    // A C# `await foreach` carries a non-empty `await` keyword; it
                    // lowers to G#'s async-iteration form `await for x in seq`
                    // (spec AwaitForRangeStmt). Without it, iterating an
                    // `IAsyncEnumerable<T>` with a plain `for` is rejected (GS0116).
                    return new[]
                    {
                        (GStatement)new ForInStatement(
                            SanitizeIdentifier(forEach.Identifier.Text),
                            this.TranslateReceiverWithNullForgiveness(forEach.Expression),
                            this.TranslateStatementAsBlock(forEach.Statement),
                            isAwait: !forEach.AwaitKeyword.IsKind(SyntaxKind.None)),
                    };

                case ForEachVariableStatementSyntax forEachVariable:
                    return new[] { this.TranslateForEachVariable(forEachVariable) };

                case ThrowStatementSyntax throwStatement:
                    return new[] { this.TranslateThrow(throwStatement) };

                case TryStatementSyntax tryStatement:
                    return new[] { this.TranslateTry(tryStatement) };

                case UsingStatementSyntax usingStatement:
                    return new[] { this.TranslateUsingStatement(usingStatement) };

                case BlockSyntax block:
                    return new[] { (GStatement)this.TranslateBlock(block) };

                case SwitchStatementSyntax switchStatement:
                    return new[] { this.TranslateSwitchStatement(switchStatement) };

                case YieldStatementSyntax yieldStatement:
                    return this.TranslateYieldStatement(yieldStatement);

                case EmptyStatementSyntax:
                    return System.Array.Empty<GStatement>();

                default:
                    this.context.ReportUnsupported(
                        statement,
                        $"statement '{statement.Kind()}' has no canonical G# form yet; emitted a placeholder comment (ADR-0115 §B).");
                    return new[] { (GStatement)new RawStatement($"// unsupported: {statement.Kind()}") };
            }
        }

        private IEnumerable<GStatement> TranslateLocalDeclaration(VariableDeclarationSyntax declaration, bool isConst, bool isUsing = false)
        {
            var results = new List<GStatement>();
            bool hasExplicitType = !declaration.Type.IsVar;

            foreach (VariableDeclaratorSyntax declarator in declaration.Variables)
            {
                GExpression initializer;
                if (declarator.Initializer == null)
                {
                    initializer = null;
                }
                else
                {
                    // `int y = (x = 5) + 1;` — a value-position assignment nested in
                    // the initializer is hoisted into a preceding assignment
                    // statement; it runs once, exactly where C# would evaluate it
                    // (issue #1723).
                    List<AssignmentExpressionSyntax> initializerEmbedded =
                        this.CollectEmbeddedAssignments(declarator.Initializer.Value, includeSelf: true);
                    foreach (AssignmentExpressionSyntax node in initializerEmbedded)
                    {
                        results.AddRange(this.FlattenChainedAssignment(node));
                    }

                    foreach (AssignmentExpressionSyntax node in initializerEmbedded)
                    {
                        this.suppressedAssignments.Add(node);
                    }

                    try
                    {
                        initializer = this.CoerceConstantToUnsigned(
                            declarator.Initializer.Value,
                            this.TranslateExpression(declarator.Initializer.Value));
                    }
                    finally
                    {
                        foreach (AssignmentExpressionSyntax node in initializerEmbedded)
                        {
                            this.suppressedAssignments.Remove(node);
                        }
                    }
                }

                BindingKind binding;
                if (isConst)
                {
                    binding = BindingKind.Const;
                }
                else if (isUsing)
                {
                    // A `using` resource is read-only after acquisition; it maps to
                    // the immutable `using let` form (sample Defer.gs).
                    binding = BindingKind.Let;
                }
                else
                {
                    var local = this.context.GetDeclaredSymbol(declarator) as ILocalSymbol;
                    binding = local != null && this.IsLocalReassigned(local)
                        ? BindingKind.Var
                        : BindingKind.Let;
                }

                // An immutable `let` requires an initializer; a declaration with no
                // initializer (e.g. a pre-declared `out` target, `int x;`) must bind
                // as mutable `var <name> <type>` so the zero value is named and the
                // subsequent assignment is legal (spec §Bindings, ADR-0115 §B.3).
                if (declarator.Initializer == null && binding == BindingKind.Let)
                {
                    binding = BindingKind.Var;
                }

                // A type clause is required when there is no initializer (it names
                // the zero/default value, spec §Bindings). With an initializer the
                // type is normally inferred (ADR-0115 §B.3) — but when the C#
                // developer wrote an explicit type that differs from the
                // initializer's natural type (an implicit conversion, e.g.
                // `long startSample = 0;` where `0` is `int`), G# would re-infer
                // the narrower natural type and later operations (e.g. `+=` with an
                // `int64` value) fail with GS0129. In that case preserve the
                // developer's declared type so the binding keeps the intended type.
                GTypeReference type = null;
                if (hasExplicitType)
                {
                    bool emitType = initializer == null;

                    // Prefer the local symbol's type: it carries the flow
                    // nullable annotation (`SttsBox?`), whereas
                    // `GetTypeInfo(declaration.Type)` reports the bare type and
                    // silently drops the `?`, so a nullable-enabled local would
                    // be rendered non-nullable and later `= nil`/`== nil` fail.
                    ITypeSymbol declaredType =
                        (this.context.GetDeclaredSymbol(declarator) as ILocalSymbol)?.Type
                        ?? this.context.GetTypeInfo(declaration.Type).Type;

                    if (!emitType && initializer != null && declaredType != null)
                    {
                        // Preserve the explicit type only when it differs from the
                        // initializer's natural type (an implicit conversion). When
                        // they match, omit the clause and rely on inference — the
                        // idiomatic common case. A declared nullable reference
                        // (`Box?`) whose initializer is non-null would infer the
                        // narrower non-null type, so always emit it to keep the `?`.
                        ITypeSymbol naturalType =
                            this.context.GetTypeInfo(declarator.Initializer.Value).Type;
                        if (naturalType == null
                            || !SymbolEqualityComparer.Default.Equals(declaredType, naturalType)
                            || IsAnnotatedNullableReference(declaredType))
                        {
                            emitType = true;
                        }
                        else if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol equalTypeLocal
                            && this.IsPromotedToNullableReference(equalTypeLocal))
                        {
                            // Issue #1737: the explicit-type-equals-initializer-type
                            // shape above bypasses the type clause entirely (relying
                            // on inference), which would also silently drop the
                            // #1072 nullable promotion below. Route it through the
                            // same emitType=true path as every other explicit-typed
                            // shape so `var x = e;` and `T x = e;` (declared type ==
                            // natural type) promote identically.
                            emitType = true;
                        }
                    }

                    if (emitType)
                    {
                        type = declaredType != null
                            ? this.typeMapper.Map(declaredType, this.context, declaration.Type.GetLocation())
                            : null;

                        // Issue #1072: a non-nullable reference/array local that is
                        // null-checked or null-assigned in its scope is really nullable.
                        if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol localSymbol)
                        {
                            type = this.PromoteIfUsedAsNullable(type, localSymbol);
                        }
                    }
                }
                else if (initializer != null &&
                    this.context.GetDeclaredSymbol(declarator) is ILocalSymbol inferredLocal &&
                    this.IsPromotedToNullableReference(inferredLocal))
                {
                    // Issue #1072 (inferred-type form): a `var x = e` local with no
                    // explicit type whose initializer is a non-nullable reference but
                    // which is compared to `nil` / assigned `nil` in scope is really
                    // nullable. Type inference over the non-null initializer would
                    // pick the non-nullable type, so the `== nil` / `!= nil` guard
                    // fails (GS0129) or a later `= nil` fails (GS0156). Emit an
                    // explicit `T?` annotation so the binding is nullable.
                    type = MakeNullable(this.typeMapper.Map(
                        inferredLocal.Type, this.context, declaration.Type.GetLocation()));
                }

                results.Add(new LocalDeclarationStatement(
                    binding,
                    SanitizeIdentifier(declarator.Identifier.Text),
                    type,
                    initializer,
                    isUsing: isUsing));
            }

            return results;
        }

        /// <summary>
        /// Translates a C# binary expression, inserting an explicit numeric
        /// conversion when C#'s implicit numeric promotion bridged two operands of
        /// different numeric types. G# has no implicit cross-type numeric promotion:
        /// an operator such as <c>==</c>/<c>&lt;</c>/<c>+</c> is per-primitive-type,
        /// so <c>uint16 == int32</c> (and the lifted <c>uint16? == int32</c>) is
        /// <c>GS0129</c>. The faithful fix mirrors C#: when one operand is a constant
        /// literal, retype the literal to the other operand's G# type; otherwise
        /// convert each C#-promoted operand to the common (promoted) type.
        /// </summary>
        private GExpression TranslateBinaryExpression(BinaryExpressionSyntax binary)
        {
            GExpression left = this.TranslateExpression(binary.Left);
            string op = binary.OperatorToken.Text;
            GExpression right = this.TranslateExpression(binary.Right);

            // C# string concatenation `a + b`: when the `+` operator binds to
            // `string`, C# implicitly converts each non-string operand to a string
            // (via `String.Concat`/`ToString`). G# has no implicit conversion, so a
            // `+` whose operands are not both `string` is GS0129 (`operator '+' is
            // not defined for 'Indent' and 'string'`). Rewrite each non-string
            // operand to an explicit `operand.ToString()` so the concatenation
            // type-checks, matching C#'s displayed value.
            if (binary.IsKind(SyntaxKind.AddExpression)
                && this.context.GetTypeInfo(binary).Type?.SpecialType == SpecialType.System_String)
            {
                left = this.CoerceConcatOperand(binary.Left, left);
                right = this.CoerceConcatOperand(binary.Right, right);
                return new BinaryExpression(left, op, right);
            }

            // C# null-coalescing `a ?? b`: the left is a nullable numeric, the
            // right must match the left's *underlying* (non-nullable) numeric type
            // (a `??` is not a symmetric arithmetic promotion of both sides). Only
            // apply this when both sides are numeric; mixed reference cases such as
            // `Task<T>? ?? Task` flow through unchanged.
            if (op == "??")
            {
                return this.TranslateNullCoalescing(binary, left, right);
            }

            // Issue #1232: G# now matches C#'s shift-count ergonomics — gsc
            // implicitly widens a narrower-order integer shift count to int32 —
            // so `<<` / `>>` translate straight through with no count coercion.
            // (`<<` / `>>` are not numeric-promotion operators, so they fall
            // through to the plain binary form below.)
            if (!IsNumericPromotionOperator(op))
            {
                return new BinaryExpression(left, op, right);
            }

            ITypeSymbol leftType = this.context.GetTypeInfo(binary.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(binary.Right).Type;

            if (!TryGetNumericKind(leftType, out SpecialType leftUnderlying) ||
                !TryGetNumericKind(rightType, out SpecialType rightUnderlying))
            {
                return new BinaryExpression(left, op, right);
            }

            // Operand types already share an underlying numeric type (only the
            // nullability may differ, e.g. `int32? == 2`); G# accepts those directly,
            // so leave the expression untouched.
            if (leftUnderlying == rightUnderlying)
            {
                return new BinaryExpression(left, op, right);
            }

            bool leftConst = this.context.SemanticModel.GetConstantValue(binary.Left).HasValue;
            bool rightConst = this.context.SemanticModel.GetConstantValue(binary.Right).HasValue;

            // Prefer the minimal, faithful form: a constant literal is retyped to the
            // other (non-constant) operand's G# type so both operands share a type
            // (e.g. `channelCount == (2 as uint16?)`).
            if (rightConst && !leftConst)
            {
                right = this.CoerceOperandTo(right, leftType);
                return new BinaryExpression(left, op, right);
            }

            if (leftConst && !rightConst)
            {
                left = this.CoerceOperandTo(left, rightType);
                return new BinaryExpression(left, op, right);
            }

            // Neither (or both) operand is a constant literal: convert each operand
            // that C# promoted (its declared type differs from the common converted
            // type) to that common type.
            ITypeSymbol leftConverted = this.context.GetTypeInfo(binary.Left).ConvertedType;
            ITypeSymbol rightConverted = this.context.GetTypeInfo(binary.Right).ConvertedType;

            if (TryGetNumericKind(leftConverted, out SpecialType leftConvUnderlying) &&
                leftConvUnderlying != leftUnderlying)
            {
                left = this.CoerceOperandTo(left, leftConverted);
            }

            if (TryGetNumericKind(rightConverted, out SpecialType rightConvUnderlying) &&
                rightConvUnderlying != rightUnderlying)
            {
                right = this.CoerceOperandTo(right, rightConverted);
            }

            return new BinaryExpression(left, op, right);
        }

        // For a string-concatenation `+` operand: if the operand's C# type is not
        // already `string`, wrap the translated operand in an explicit
        // `operand.ToString()` call so G# (which has no implicit string conversion)
        // type-checks the concatenation. A string operand (including a nested
        // string `+` sub-expression, whose type is also `string`) is returned
        // unchanged, as is a bare `null` literal (`null.ToString()` would throw;
        // C# renders it as the empty string, and a translated `nil` keeps that
        // intent while remaining assignable to a `string` slot). The operand is
        // parenthesized when needed so member access binds to the whole operand.
        private GExpression CoerceConcatOperand(ExpressionSyntax operandSyntax, GExpression translated)
        {
            ITypeSymbol operandType = this.context.GetTypeInfo(operandSyntax).Type;
            if (operandType?.SpecialType == SpecialType.System_String)
            {
                return translated;
            }

            if (IsNullOrSuppressedNull(operandSyntax))
            {
                return translated;
            }

            GExpression receiver = translated is BinaryExpression or IfExpression
                ? new ParenthesizedExpression(translated)
                : translated;

            return new InvocationExpression(new MemberAccessExpression(receiver, "ToString"));
        }

        // For a compound numeric assignment `x OP= y` (`+= -= *= /= %= &= |= ^=`),
        // G# requires the RHS to share the LHS's numeric type; a mismatched RHS is
        // coerced to the LHS type via the conversion-call form (e.g. `x += int64(y)`).
        // A nullable RHS is coerced through the LHS's underlying numeric type.
        private GExpression CoerceCompoundAssignmentRhs(
            AssignmentExpressionSyntax assignment, GExpression rhs)
        {
            if (assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                return rhs;
            }

            // Issue #1232: compound shift (`<<=` / `>>=`). The RHS is a shift
            // count, NOT the LHS numeric type — gsc now implicitly widens a
            // narrower-order integer count to int32, so the count needs no
            // coercion. Return it unchanged (and, crucially, skip the LHS-type
            // numeric promotion below, which would wrongly coerce the count to
            // the LHS type, e.g. `uint32(count)` → GS0129).
            if (assignment.IsKind(SyntaxKind.LeftShiftAssignmentExpression) ||
                assignment.IsKind(SyntaxKind.RightShiftAssignmentExpression))
            {
                return rhs;
            }

            ITypeSymbol leftType = this.context.GetTypeInfo(assignment.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(assignment.Right).Type;

            if (TryGetNumericKind(leftType, out SpecialType leftUnderlying) &&
                TryGetNumericKind(rightType, out SpecialType rightUnderlying) &&
                leftUnderlying != rightUnderlying)
            {
                return this.CoerceOperandTo(rhs, UnwrapNullable(leftType));
            }

            return rhs;
        }

        // C# array-creation lengths accept any integral type (`new T[uint]`,
        // `new T[long]`, …), but the native G# allocation form `[n]T` (issue
        // #1272) takes an `int32`. Coerce a non-`int32` numeric length to int32
        // via the conversion-call form so the allocation binds. A nullable or
        // non-numeric length is left unchanged.
        private GExpression CoerceLengthToInt32(
            ExpressionSyntax lengthSyntax, GExpression length)
        {
            ITypeSymbol lengthType = this.context.GetTypeInfo(lengthSyntax).Type;
            if (lengthType != null &&
                IsNonNullableValueType(lengthType) &&
                TryGetNumericKind(lengthType, out SpecialType underlying) &&
                underlying != SpecialType.System_Int32)
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(length, int32Type);
            }

            return length;
        }

        // G# array/indexer element access. Issue #1279: gsc now accepts ANY
        // C#-supported integer type as an array/slice element index (it converts
        // the wider/unsigned kinds — `uint`, `long`, `ulong`, `nint`, `nuint` —
        // to native int), so an ARRAY index needs no `int32(...)` coercion and is
        // emitted idiomatically. A user/CLR indexer (`List<T>`, `Span<T>`,
        // `IReadOnlyList<T>`, ...) whose single parameter is `int32` still binds
        // its argument to `int32` via normal conversion rules in gsc, so a wide
        // index against such an indexer is still wrapped in `int32(<index>)`.
        // Dictionary/other indexers keyed by a non-`int32` type, `System.Index`/
        // `System.Range` indices, and indices already `int`/narrower are left
        // untouched.
        private GExpression CoerceIndexToInt32(
            ElementAccessExpressionSyntax elementAccess, GExpression index)
        {
            if (elementAccess.ArgumentList.Arguments.Count != 1)
            {
                return index;
            }

            // Issue #1279: arrays accept any integer index in gsc — no coercion.
            if (this.context.GetTypeInfo(elementAccess.Expression).Type is IArrayTypeSymbol)
            {
                return index;
            }

            if (!this.IndexerTargetTypeIsInt32(elementAccess))
            {
                return index;
            }

            ExpressionSyntax indexSyntax = elementAccess.ArgumentList.Arguments[0].Expression;
            ITypeSymbol indexType = this.context.GetTypeInfo(indexSyntax).Type;
            if (indexType != null &&
                IsNonNullableValueType(indexType) &&
                IsIntegerNotWideningToInt32(indexType))
            {
                ITypeSymbol int32Type =
                    this.context.Compilation.GetSpecialType(SpecialType.System_Int32);
                return this.CoerceOperandTo(index, int32Type);
            }

            return index;
        }

        // Reports whether the element-access target indexes by `int32`: a C# array,
        // or a type whose bound indexer takes a single `int32` parameter (such as
        // `List<T>`, `Span<T>`, `IReadOnlyList<T>`). A `Dictionary<TKey, T>` or any
        // other indexer keyed by a non-`int32` type returns false.
        private bool IndexerTargetTypeIsInt32(ElementAccessExpressionSyntax elementAccess)
        {
            ITypeSymbol receiverType = this.context.GetTypeInfo(elementAccess.Expression).Type;
            if (receiverType is IArrayTypeSymbol)
            {
                return true;
            }

            if (this.context.GetSymbolInfo(elementAccess).Symbol is IPropertySymbol
                    { IsIndexer: true, Parameters.Length: 1 } indexer)
            {
                return indexer.Parameters[0].Type.SpecialType == SpecialType.System_Int32;
            }

            return false;
        }

        // Reports whether `type` is an integral type that does NOT implicitly widen
        // to `int32` in C# — `uint`/`uint32`, `long`/`int64`, `ulong`/`uint64`,
        // `nint`, and `nuint`. The narrow integrals (`byte`, `sbyte`, `short`,
        // `ushort`, `char`) and `int` itself widen to/are `int32` and return false.
        private static bool IsIntegerNotWideningToInt32(ITypeSymbol type)
        {
            switch (type.SpecialType)
            {
                case SpecialType.System_UInt32:
                case SpecialType.System_Int64:
                case SpecialType.System_UInt64:
                case SpecialType.System_IntPtr:
                case SpecialType.System_UIntPtr:
                    return true;
                default:
                    return false;
            }
        }

        // C# `a ?? b` where `a` is a nullable numeric and the operands' numeric
        // kinds differ: the coercion target is the *result* type of the whole
        // `??` expression — C#'s best-common-type computation (§12.15), exactly
        // as `GetTypeInfo(binary).Type` already reports it — not unconditionally
        // the left operand's type (issue #1725). When the right operand is
        // *wider* than the left (e.g. `long r = nullableInt ?? longDefault;`),
        // C# types the whole expression as the right operand's (wider) type and
        // converts the LEFT's non-null value instead; the old code coerced the
        // right operand DOWN to the left's narrower type, silently truncating
        // it (or truncating a `double` fallback to the left's integral type).
        //
        // gsc's own `??` binder (issue #1239) already performs this same
        // C#-faithful best-common-type widening and auto-converts the left
        // operand's non-null value whenever the left is the narrower side —
        // verified directly against gsc for int32?/int64, int32?/double,
        // int64?/int32 (left wider), float?/double, uint32?/int64, and
        // int32?/decimal (see Issue1725NullCoalescingNumericWideningEmitTests
        // for the runtime locks of each combo). The one gap gsc does not
        // fill on its own is a *constant* right operand whose natural
        // numeric kind differs
        // from the result (e.g. `x ?? 0` for `uint32? x`: the literal `0`'s
        // natural type `int32` differs from the `uint32` result C# computed
        // via its constant-literal conversion rule, which gsc's type-only
        // conversion lattice does not special-case) — only in that direction
        // is an explicit coercion required, and it always targets the
        // *result* type, never the left type. Coercing the right operand when
        // it already matches the result type is a no-op (skipped below), so
        // this also covers left-wider-than-right (right coerced up, as
        // before) and equal-kind operands (no coercion, unchanged).
        // Non-numeric coalescing (reference types, tasks) is left untouched.
        private GExpression TranslateNullCoalescing(
            BinaryExpressionSyntax binary, GExpression left, GExpression right)
        {
            ITypeSymbol leftType = this.context.GetTypeInfo(binary.Left).Type;
            ITypeSymbol rightType = this.context.GetTypeInfo(binary.Right).Type;

            if (TryGetNumericKind(leftType, out SpecialType leftUnderlying) &&
                TryGetNumericKind(rightType, out SpecialType rightUnderlying) &&
                leftUnderlying != rightUnderlying)
            {
                // `.Type` (not `.ConvertedType`) is the `??` expression's own
                // best-common-type per C# §12.15 — the value we need here.
                // `.ConvertedType` instead reflects an ENCLOSING conversion
                // (e.g. an assignment's target type), which would let an
                // outer context over-coerce this operand to the wrong type
                // (S1). `.Type` is only null for an unresolved/erroneous
                // expression; both operands already passed `TryGetNumericKind`
                // above, meaning the semantic model fully resolved this `??`,
                // so `.Type` is guaranteed non-null here.
                ITypeSymbol resultType = this.context.GetTypeInfo(binary).Type;

                if (TryGetNumericKind(resultType, out SpecialType resultUnderlying) &&
                    rightUnderlying != resultUnderlying)
                {
                    right = this.CoerceOperandTo(right, UnwrapNullable(resultType));
                }
            }

            return new BinaryExpression(left, "??", right);
        }

        // C# ternary `cond ? a : b` lowers to the G# value-position `if` expression.
        // Issue #1232: gsc now matches C#'s numeric ergonomics for conditional arms
        // — it adapts an in-range constant integer literal arm and implicitly widens
        // a narrower typed arm to the other arm's type. So a coercion is only needed
        // for the residual case G# still cannot unify on its own: when C#'s common
        // result type is STRICTLY WIDER than BOTH arm types (e.g. `cond ? u16 : i16`
        // whose C# common type is `int`, which equals neither arm). There we coerce
        // both diverging arms to the result type via the conversion-call form. The
        // idiomatic `cond ? 1u : 0` now translates to `if cond { 1u } else { 0 }`
        // (no cast on the `0`), letting gsc adapt the literal.
        private GExpression TranslateConditionalExpression(
            ConditionalExpressionSyntax conditional)
        {
            GExpression condition = this.TranslateExpression(conditional.Condition);
            GExpression whenTrue = this.TranslateValueWithNullForgiveness(conditional.WhenTrue);
            GExpression whenFalse = this.TranslateValueWithNullForgiveness(conditional.WhenFalse);

            ITypeSymbol resultType = this.context.GetTypeInfo(conditional).Type;
            ITypeSymbol trueType = this.context.GetTypeInfo(conditional.WhenTrue).Type;
            ITypeSymbol falseType = this.context.GetTypeInfo(conditional.WhenFalse).Type;

            // When C# computed a single numeric conditional type but an arm has a
            // different numeric type (e.g. `cond ? 1u : 0`, whose `0` is `int32`
            // while the result is `uint32`), coerce each mismatched arm to the
            // result type: G# requires both arms to share a type (GS0263) and does
            // no implicit promotion. Each arm is coerced independently so a ternary
            // with only one mismatched arm is still aligned.
            if (resultType != null &&
                IsNonNullableValueType(resultType) &&
                TryGetNumericKind(resultType, out SpecialType resultUnderlying))
            {
                if (TryGetNumericKind(trueType, out SpecialType trueUnderlying) &&
                    trueUnderlying != resultUnderlying)
                {
                    whenTrue = this.CoerceOperandTo(whenTrue, resultType);
                }

                if (TryGetNumericKind(falseType, out SpecialType falseUnderlying) &&
                    falseUnderlying != resultUnderlying)
                {
                    whenFalse = this.CoerceOperandTo(whenFalse, resultType);
                }
            }

            // A `null` arm (`cond ? value : null`) carries no type of its own, so
            // G# infers the conditional's type purely from the non-null arm — the
            // bare `nil` then fails to unify (GS0155 "cannot convert nil to T", and
            // the surrounding call cascades GS0159). C#'s common type already
            // records the nullable union (e.g. `IEnumerator<T>?`); re-emit the null
            // arm as `default(T?)` carrying that mapped nullable type so gsc unifies
            // the branches into the nullable type instead of guessing the non-null
            // one. Restricted to reference-type results (a `Nullable<V>` value
            // result is handled by C#'s own lifting / numeric paths above).
            if (resultType is { IsReferenceType: true })
            {
                GTypeReference nullableResult = MakeNullable(
                    this.typeMapper.Map(resultType, this.context, conditional.GetLocation()));

                if (IsNullLiteral(conditional.WhenTrue))
                {
                    whenTrue = new DefaultValueExpression(nullableResult);
                }

                if (IsNullLiteral(conditional.WhenFalse))
                {
                    whenFalse = new DefaultValueExpression(nullableResult);
                }
            }

            return new IfExpression(condition, whenTrue, whenFalse);
        }

        // Unwraps `System.Nullable<T>` to its underlying `T`; other types pass
        // through unchanged.
        private static ITypeSymbol UnwrapNullable(ITypeSymbol type)
        {
            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T &&
                named.TypeArguments.Length == 1)
            {
                return named.TypeArguments[0];
            }

            return type;
        }

        // non-nullable value type target (e.g. `uint8`, `int32`) G# rejects
        // `(expr as T)` with GS0270 ("the 'as' operator requires the target type to
        // be a reference type or a nullable value type"); the canonical G# form is
        // the width-bearing conversion-call `T(expr)`. Only a reference type or a
        // nullable value type target (where `as` is valid) keeps the `as` form.
        private GExpression CoerceOperandTo(GExpression expression, ITypeSymbol targetType)
        {
            if (IsNonNullableValueType(targetType))
            {
                GTypeReference conversionTarget = this.typeMapper.Map(
                    targetType, this.context, Location.None);
                return new ConversionExpression(conversionTarget, expression);
            }

            GTypeReference target = this.typeMapper.Map(targetType, this.context, Location.None);
            return new ParenthesizedExpression(
                new BinaryExpression(expression, "as", new TypeExpression(target)));
        }

        // Reports whether `type` is a value type that is not `System.Nullable<T>`,
        // i.e. a target for which G#'s `as` operator is invalid (GS0270) and the
        // conversion-call form must be used instead.
        private static bool IsNonNullableValueType(ITypeSymbol type)
        {
            if (type == null || !type.IsValueType)
            {
                return false;
            }

            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
            {
                return false;
            }

            return true;
        }

        private static bool IsNumericPromotionOperator(string op)
        {
            switch (op)
            {
                case "==":
                case "!=":
                case "<":
                case "<=":
                case ">":
                case ">=":
                case "+":
                case "-":
                case "*":
                case "/":
                case "%":
                case "&":
                case "|":
                case "^":
                    return true;
                default:
                    return false;
            }
        }

        // Reports whether `type` is a numeric primitive (unwrapping Nullable<T>) and
        // yields its underlying special type. `char` is included because C# promotes
        // it to `int` in arithmetic/comparison/bitwise contexts, so a mismatched
        // `uint8 == 'A'` needs a G# conversion here. `bool`/`string` are excluded.
        private static bool TryGetNumericKind(ITypeSymbol type, out SpecialType underlying)
        {
            underlying = SpecialType.None;
            if (type == null)
            {
                return false;
            }

            if (type is INamedTypeSymbol named &&
                named.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T &&
                named.TypeArguments.Length == 1)
            {
                type = named.TypeArguments[0];
            }

            switch (type.SpecialType)
            {
                case SpecialType.System_Char:
                case SpecialType.System_SByte:
                case SpecialType.System_Byte:
                case SpecialType.System_Int16:
                case SpecialType.System_UInt16:
                case SpecialType.System_Int32:
                case SpecialType.System_UInt32:
                case SpecialType.System_Int64:
                case SpecialType.System_UInt64:
                case SpecialType.System_Single:
                case SpecialType.System_Double:
                case SpecialType.System_Decimal:
                    underlying = type.SpecialType;
                    return true;
                default:
                    return false;
            }
        }

        private GStatement TranslateThrow(ThrowStatementSyntax throwStatement)
        {
            // C# `throw;` (re-throw) has no bare G# form (`throw` alone is GS0005);
            // re-emit the innermost caught exception variable, which reproduces the
            // exception type and message (ADR-0115 §B).
            if (throwStatement.Expression == null)
            {
                if (this.currentCatchVariable != null)
                {
                    return new ThrowStatement(new IdentifierExpression(this.currentCatchVariable));
                }

                this.context.ReportUnsupported(
                    throwStatement,
                    "a bare re-throw outside a named catch has no canonical G# form (G# has no bare 'throw'; ADR-0115 §B).");
                return new ThrowStatement(new IdentifierExpression("nil"));
            }

            return new ThrowStatement(this.TranslateExpression(throwStatement.Expression));
        }

        private GStatement TranslateTry(TryStatementSyntax node)
        {
            BlockStatement tryBlock = this.TranslateBlock(node.Block);

            // Per-clause exception type symbols, gathered up front so the
            // rethrow-lowering below (for `when` filters) can look ahead at
            // *sibling* catch types (issue #1724 follow-up / PR #1821 review).
            // Rationale: in C#, catch clauses are matched top-to-bottom by type;
            // when a clause's type matches but its `when` filter is false,
            // matching CONTINUES to the next sibling clause instead of leaving
            // the try. The per-catch `if !(filter) { throw ex }` lowering makes a
            // false filter escape the *whole* try, so a later sibling that would
            // have caught it in C# never runs. That is only faithful when no
            // later sibling could plausibly receive the same exception, so we
            // detect the unsafe shape below and diagnose it instead of silently
            // emitting wrong control flow.
            var catchTypeSymbols = new ITypeSymbol[node.Catches.Count];
            for (int i = 0; i < node.Catches.Count; i++)
            {
                CatchClauseSyntax c = node.Catches[i];
                catchTypeSymbols[i] = c.Declaration != null
                    ? this.context.GetTypeInfo(c.Declaration.Type).Type
                    : this.context.Compilation.GetTypeByMetadataName("System.Exception");
            }

            var catches = new List<CatchClause>();
            for (int catchIndex = 0; catchIndex < node.Catches.Count; catchIndex++)
            {
                CatchClauseSyntax catchClause = node.Catches[catchIndex];
                string variableName = null;
                GTypeReference exceptionType = null;
                if (catchClause.Declaration != null)
                {
                    ITypeSymbol typeSymbol = catchTypeSymbols[catchIndex];
                    exceptionType = typeSymbol != null
                        ? this.typeMapper.Map(typeSymbol, this.context, catchClause.Declaration.Type.GetLocation())
                        : new NamedTypeReference(catchClause.Declaration.Type.ToString());
                    variableName = SanitizeIdentifier(catchClause.Declaration.Identifier.Text);
                    if (string.IsNullOrEmpty(variableName))
                    {
                        // `catch (Exception)` with no binding: synthesize one so the
                        // G# typed-catch form (which requires a binder) is well-formed.
                        variableName = "ex";
                    }
                }
                else
                {
                    // A bare C# `catch { }` (catch-all, no declaration) has no G#
                    // equivalent: the parser requires the parenthesized typed-binder
                    // form `catch (e Exception) { }`. Synthesize a binder over the
                    // root `System.Exception` so the catch-all round-trips (ADR-0115).
                    variableName = "ex";
                    exceptionType = new NamedTypeReference("Exception");
                }

                string previousCatch = this.currentCatchVariable;
                this.currentCatchVariable = variableName;
                try
                {
                    BlockStatement body = this.TranslateBlock(catchClause.Block);
                    if (catchClause.Filter != null)
                    {
                        if (this.HasOverlappingLaterSibling(catchTypeSymbols, catchIndex))
                        {
                            // A later sibling catch could still receive this
                            // exception when the filter is false (e.g. it is, or
                            // is a supertype of, this clause's type, or the
                            // relationship can't be proven disjoint). Rethrow-
                            // lowering would make the false-filter case escape the
                            // whole try instead of falling through to that
                            // sibling, silently diverging from C#. Report instead
                            // of emitting the wrong control flow (ADR-0115 §B).
                            string message = "a 'when' filter on a catch clause that has a later sibling catch whose type could "
                                + "also receive the exception (e.g. a supertype such as 'Exception', or a type not "
                                + "provably disjoint) has no faithful G# lowering: a false filter must fall through "
                                + "to that sibling in C#, but G#'s rethrow-lowering would make it escape the whole "
                                + "try instead (ADR-0115 §B / issue #1724).";
                            this.context.ReportUnsupported(catchClause, message);
                        }
                        else
                        {
                            // G# has no native `catch ... when (filter)` (no Filter on
                            // CatchClauseSyntax/TryStatementSyntax; grammar has no `when`
                            // on catch). Lower it faithfully: evaluate the filter first and
                            // rethrow the caught exception when it is false, so the
                            // exception propagates exactly as it would in C# instead of
                            // being silently swallowed (issue #1724). Note: unlike a real
                            // CLR exception filter, this runs after the stack has already
                            // unwound into the handler.
                            GExpression filter = this.TranslateExpression(catchClause.Filter.FilterExpression);
                            var rethrowIfFalse = new IfStatement(
                                new UnaryExpression("!", filter),
                                new BlockStatement(new List<GStatement> { new ThrowStatement(new IdentifierExpression(variableName)) }));
                            var statements = new List<GStatement> { rethrowIfFalse };
                            statements.AddRange(body.Statements);
                            body = new BlockStatement(statements, body.IsUnsafe);
                        }
                    }

                    catches.Add(new CatchClause(variableName, exceptionType, body));
                }
                finally
                {
                    this.currentCatchVariable = previousCatch;
                }
            }

            BlockStatement finallyBlock = node.Finally != null
                ? this.TranslateBlock(node.Finally.Block)
                : null;

            return new TryStatement(tryBlock, catches, finallyBlock);
        }

        /// <summary>
        /// Whether any catch clause after <paramref name="filteredIndex"/> could
        /// still receive the same exception once the filtered clause's `when`
        /// is false — i.e. whether rethrow-lowering the filter at
        /// <paramref name="filteredIndex"/> would diverge from C#'s top-to-bottom,
        /// fall-through-on-false-filter matching (issue #1724 follow-up).
        /// </summary>
        /// <param name="catchTypeSymbols">The resolved exception type per catch clause, in source order.</param>
        /// <param name="filteredIndex">The index of the `when`-filtered clause being lowered.</param>
        /// <returns><see langword="true"/> when a later sibling could plausibly match.</returns>
        private bool HasOverlappingLaterSibling(ITypeSymbol[] catchTypeSymbols, int filteredIndex)
        {
            ITypeSymbol filteredType = catchTypeSymbols[filteredIndex];
            for (int i = filteredIndex + 1; i < catchTypeSymbols.Length; i++)
            {
                if (!AreDisjointExceptionTypes(filteredType, catchTypeSymbols[i]))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Whether two exception types can be <em>proven</em> disjoint — no
        /// runtime exception object can be an instance of both. Only single-
        /// inheritance class types can be proven disjoint this way (neither
        /// derives from the other); anything else (unresolved types, interfaces,
        /// or an equal/derived relationship) is treated conservatively as
        /// possibly-overlapping, per the "when in doubt, don't silently diverge"
        /// rule this method exists to serve.
        /// </summary>
        /// <param name="left">The first exception type, or <see langword="null"/> if unresolved.</param>
        /// <param name="right">The second exception type, or <see langword="null"/> if unresolved.</param>
        /// <returns><see langword="true"/> only when the types are provably disjoint.</returns>
        private static bool AreDisjointExceptionTypes(ITypeSymbol left, ITypeSymbol right)
        {
            if (left == null || right == null)
            {
                return false;
            }

            if (left.TypeKind != TypeKind.Class || right.TypeKind != TypeKind.Class)
            {
                return false;
            }

            if (SymbolEqualityComparer.Default.Equals(left, right))
            {
                return false;
            }

            return !DerivesFromOrEquals(left, right) && !DerivesFromOrEquals(right, left);
        }

        private static bool DerivesFromOrEquals(ITypeSymbol type, ITypeSymbol potentialBaseOrSelf)
        {
            for (ITypeSymbol t = type; t != null; t = t.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(t, potentialBaseOrSelf))
                {
                    return true;
                }
            }

            return false;
        }

        private GStatement TranslateUsingStatement(UsingStatementSyntax node)
        {
            // C# `using (var r = e) body` has no `using (...)` block form in G#
            // (it is GS0005); it maps to a scoped block holding a `using let`
            // resource declaration followed by the body, so the resource is
            // disposed at the end of that block (sample Defer.gs; ADR-0115 §B).
            var statements = new List<GStatement>();
            if (node.Declaration != null)
            {
                statements.AddRange(this.TranslateLocalDeclaration(node.Declaration, isConst: false, isUsing: true));
            }
            else if (node.Expression != null)
            {
                // `using (expr) body` (no declaration): the resource is the
                // expression value; bind it to a fresh `using let` so disposal
                // is scoped to the block.
                statements.Add(new LocalDeclarationStatement(
                    BindingKind.Let,
                    "__using",
                    type: null,
                    initializer: this.TranslateExpression(node.Expression),
                    isUsing: true));
            }

            BlockStatement bodyBlock = this.TranslateStatementAsBlock(node.Statement);
            statements.AddRange(bodyBlock.Statements);
            return new BlockStatement(statements);
        }

        private GStatement TranslateExpressionStatement(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case AssignmentExpressionSyntax assignment:
                    string op = assignment.OperatorToken.Text;
                    GExpression assignRhs = this.CoerceConstantToUnsigned(
                        assignment.Right,
                        this.TranslateExpression(assignment.Right));
                    assignRhs = this.CoerceCompoundAssignmentRhs(assignment, assignRhs);
                    return new AssignmentStatement(
                        this.TranslateAssignmentTarget(assignment.Left),
                        assignRhs,
                        op);

                case PostfixUnaryExpressionSyntax postfix
                    when postfix.IsKind(SyntaxKind.PostIncrementExpression)
                        || postfix.IsKind(SyntaxKind.PostDecrementExpression):
                    return new IncrementDecrementStatement(
                        this.TranslateExpression(postfix.Operand),
                        postfix.OperatorToken.Text);

                case PrefixUnaryExpressionSyntax prefix
                    when prefix.IsKind(SyntaxKind.PreIncrementExpression)
                        || prefix.IsKind(SyntaxKind.PreDecrementExpression):
                    // G# has no prefix ++/--; both forms are statements with the
                    // same effect, so emit the canonical postfix increment.
                    return new IncrementDecrementStatement(
                        this.TranslateExpression(prefix.Operand),
                        prefix.OperatorToken.Text);

                default:
                    return new ExpressionStatement(this.TranslateExpression(expression));
            }
        }

        // Translates the target (left-hand side) of an assignment. Two member-access
        // LHS shapes that gsc cannot bind through the usual receiver path are fixed
        // up here:
        //
        //   • `Prop.Member = v` where `Prop` is an *implicit-this* instance
        //     property/field of the enclosing type. gsc resolves a bare-identifier
        //     assignment receiver as a variable/parameter; an implicit-this property
        //     receiver has no local slot, so the member write fails (GS0158 /
        //     GS9998). Qualifying it as `this.Prop.Member = v` (or `self.Prop.Member
        //     = v` inside a lifted receiver-clause func, issue #938 — see
        //     <paramref name="left"/>'s <see cref="currentReceiverName"/>) routes the
        //     write through the expression-receiver path, which binds correctly.
        //     When `Prop` is itself declared-nullable (or promoted, issue #1072),
        //     the same `!!` the read path applies is inserted on the qualified
        //     receiver (`this.Prop!!.Member = v`) — the qualification and the
        //     null-forgiveness are independent fixes and compose.
        //
        //   • `recv.Member = v` where `recv` is a declared-nullable receiver that
        //     Roslyn flow-proved non-null (or was promoted to nullable, #1072).
        //     gsc does not flow-narrow an *assignment* receiver (only reads), so the
        //     bare nullable receiver fails to bind the setter (GS0158). A
        //     `recv!!.Member = v` re-establishes the non-null fact (mirrors the
        //     read-side <see cref="TranslateReceiverWithNullForgiveness"/> and its
        //     flow-independent <see cref="ReceiverIsNullableReferenceFieldOrProperty"/>
        //     companion, so nullable-oblivious corpora get the same assertion the
        //     read path does).
        private GExpression TranslateAssignmentTarget(ExpressionSyntax left)
        {
            if (left is MemberAccessExpressionSyntax member)
            {
                if (member.Expression is IdentifierNameSyntax receiverId &&
                    this.context.GetSymbolInfo(receiverId).Symbol is { IsStatic: false } receiverSymbol &&
                    receiverSymbol.Kind is SymbolKind.Property or SymbolKind.Field)
                {
                    GExpression qualifier = this.currentReceiverName != null
                        ? new IdentifierExpression(this.currentReceiverName)
                        : new ThisExpression();
                    GExpression qualifiedReceiver = new MemberAccessExpression(
                        qualifier, SanitizeIdentifier(receiverId.Identifier.Text));

                    if (this.ReceiverNeedsNullForgiveness(receiverId) ||
                        this.ReceiverIsNullableReferenceFieldOrProperty(receiverId))
                    {
                        qualifiedReceiver = new NonNullAssertionExpression(qualifiedReceiver);
                    }

                    return new MemberAccessExpression(
                        qualifiedReceiver, SanitizeIdentifier(member.Name.Identifier.Text));
                }

                if (this.ReceiverNeedsNullForgiveness(member.Expression) ||
                    this.ReceiverIsNullableReferenceFieldOrProperty(member.Expression) ||
                    (member.Expression is IdentifierNameSyntax hoistedId &&
                     this.context.GetSymbolInfo(hoistedId).Symbol is { } hoistedSymbol &&
                     this.hoistedNullableGuardLocals.Contains(hoistedSymbol)))
                {
                    return new MemberAccessExpression(
                        new NonNullAssertionExpression(this.TranslateExpression(member.Expression)),
                        SanitizeIdentifier(member.Name.Identifier.Text));
                }
            }

            return this.TranslateExpression(left);
        }

        /// <summary>
        /// Translates an expression-statement that may expand into several G#
        /// statements: a tuple deconstruction (<c>var (a, b) = e</c>) or a chained
        /// assignment (<c>a = b = c</c>), neither of which has a single-statement G#
        /// form. Everything else delegates to <see cref="TranslateExpressionStatement"/>.
        /// </summary>
        private IEnumerable<GStatement> TranslateExpressionStatements(ExpressionSyntax expression)
        {
            if (expression is AssignmentExpressionSyntax assignment &&
                assignment.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                if (assignment.Left is IdentifierNameSyntax { Identifier.ValueText: "_" })
                {
                    // C# statement-level discard `_ = e` (Roslyn parses the `_`
                    // target as an IdentifierNameSyntax). G# has no discard target
                    // (`_ = e` → GS0125), so drop the assignment and emit just the
                    // RHS as statement(s); `_ = a = b`, `_ = x ?? throw E`, and
                    // `_ = await ...` flow through the RHS translation (issue #914).
                    return this.TranslateExpressionStatements(assignment.Right);
                }

                if (this.TryGetDeconstructionTargets(assignment.Left, out BindingKind binding, out IReadOnlyList<string> names))
                {
                    // `var (a, b) = e` → `let (a, b) = e` (spec §Tuples).
                    return new[]
                    {
                        (GStatement)new TupleDeconstructionStatement(
                            binding,
                            names,
                            this.TranslateExpression(assignment.Right)),
                    };
                }

                // `(a, b) = (x, y)` deconstruction *assignment* to existing
                // variables. G# has no tuple-assignment form, so lower to
                // element-wise assignments. RHS elements are captured into temps
                // first to preserve C#'s evaluate-all-then-assign semantics
                // (handles aliasing such as `(a, b) = (b, a)`); ADR-0115 §B.
                if (assignment.Left is TupleExpressionSyntax leftTuple &&
                    assignment.Right is TupleExpressionSyntax rightTuple &&
                    leftTuple.Arguments.Count == rightTuple.Arguments.Count &&
                    leftTuple.Arguments.All(a => a.Expression is not DeclarationExpressionSyntax))
                {
                    return this.LowerTupleAssignment(leftTuple, rightTuple);
                }
            }

            // `a = b = c`, `a = b += c`, `a += b = c`, … — any assignment whose
            // RHS is itself an assignment (any operator, optionally parenthesized)
            // has no single-statement G# form; flatten innermost-first so every
            // link's write is preserved (issue #1723).
            if (expression is AssignmentExpressionSyntax outerAssignment &&
                Unwrap(outerAssignment.Right) is AssignmentExpressionSyntax)
            {
                return this.FlattenChainedAssignment(outerAssignment);
            }

            return this.WithHoistedAssignments(
                expression,
                includeSelf: false,
                () => this.WithHoistedPostfix(
                    expression,
                    () => new[] { this.TranslateExpressionStatement(expression) }).ToList());
        }

        // Strips parentheses so chain/assignment detection is parenthesis-transparent.
        private static ExpressionSyntax Unwrap(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax paren)
            {
                expression = paren.Expression;
            }

            return expression;
        }

        /// <summary>
        /// Translates an expression in statement position, hoisting any embedded
        /// post-increment/decrement (`a[i++] = x`, `M(i--)`, `x = y++`) into
        /// trailing `i++` / `i--` statements. G# models inc/dec as statements, so
        /// the sub-expression is suppressed (read as its pre-increment value) and
        /// the mutation is appended after the main statement (ADR-0115 §B).
        /// </summary>
        private IEnumerable<GStatement> WithHoistedPostfix(
            ExpressionSyntax expression,
            Func<IEnumerable<GStatement>> buildMain)
        {
            List<PostfixUnaryExpressionSyntax> embedded = CollectEmbeddedPostfix(expression);
            if (embedded.Count == 0)
            {
                return buildMain();
            }

            foreach (PostfixUnaryExpressionSyntax node in embedded)
            {
                this.suppressedPostfix.Add(node);
            }

            List<GStatement> statements;
            try
            {
                statements = buildMain().ToList();
            }
            finally
            {
                foreach (PostfixUnaryExpressionSyntax node in embedded)
                {
                    this.suppressedPostfix.Remove(node);
                }
            }

            foreach (PostfixUnaryExpressionSyntax node in embedded)
            {
                statements.Add(new IncrementDecrementStatement(
                    this.TranslateExpression(node.Operand),
                    node.OperatorToken.Text));
            }

            return statements;
        }

        /// <summary>
        /// Translates an expression that may embed VALUE-POSITION assignments
        /// (`M(x = 5)`, `while ((line = r.ReadLine()) != null)`, `if ((x = f()) >
        /// 0)`), hoisting each into a preceding assignment statement. G# models
        /// assignment as a statement, not a value-yielding expression, so a
        /// naive translation drops the write and keeps only the read (issue
        /// #1723). <paramref name="includeSelf"/> controls whether
        /// <paramref name="expression"/> ITSELF counts as a hoist candidate when
        /// it is an assignment: statement-position callers (where the whole
        /// expression already IS the statement, e.g. `a += 5;`) pass <c>false</c>
        /// so only assignments NESTED inside it (e.g. `a += (b = c);`) are
        /// hoisted; condition callers (`if`/`while`/`for`, where the whole
        /// condition can itself be a bare assignment, e.g. `if (x = f())`) pass
        /// <c>true</c>.
        /// </summary>
        private IEnumerable<GStatement> WithHoistedAssignments(
            ExpressionSyntax expression,
            bool includeSelf,
            Func<List<GStatement>> buildMain)
        {
            List<AssignmentExpressionSyntax> embedded = this.CollectEmbeddedAssignments(expression, includeSelf);
            if (embedded.Count == 0)
            {
                return buildMain();
            }

            var hoisted = new List<GStatement>();
            foreach (AssignmentExpressionSyntax node in embedded)
            {
                hoisted.AddRange(this.FlattenChainedAssignment(node));
            }

            foreach (AssignmentExpressionSyntax node in embedded)
            {
                this.suppressedAssignments.Add(node);
            }

            List<GStatement> main;
            try
            {
                main = buildMain();
            }
            finally
            {
                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    this.suppressedAssignments.Remove(node);
                }
            }

            hoisted.AddRange(main);
            return hoisted;
        }

        /// <summary>
        /// Translates <paramref name="expression"/> (typically a condition:
        /// `if`/`while`/`for`), hoisting any embedded value-position assignment
        /// into <paramref name="prologue"/> as a preceding assignment statement
        /// and returning the condition with each hoisted assignment read as its
        /// already-written target (issue #1723). The whole expression counts as
        /// a hoist candidate (a bare `if (x = f())` condition IS the assignment).
        /// </summary>
        private GExpression TranslateConditionWithHoist(ExpressionSyntax expression, List<GStatement> prologue)
        {
            // Any spill hoisted while translating `expression` (issue #1731) is
            // redirected into `prologue` — the SAME preceding-statement list an
            // embedded assignment hoists into below — rather than the enclosing
            // statement's own ambient prologue, so both kinds of hoist land in
            // the same list in evaluation order.
            List<GStatement> outerSpillPrologue = this.pendingSpillPrologue;
            this.pendingSpillPrologue = prologue;
            try
            {
                return this.TranslateConditionWithHoistCore(expression, prologue);
            }
            finally
            {
                this.pendingSpillPrologue = outerSpillPrologue;
            }
        }

        private GExpression TranslateConditionWithHoistCore(ExpressionSyntax expression, List<GStatement> prologue)
        {
            List<AssignmentExpressionSyntax> embedded = this.CollectEmbeddedAssignments(expression, includeSelf: true);
            if (embedded.Count == 0)
            {
                return this.TranslateExpression(expression);
            }

            foreach (AssignmentExpressionSyntax node in embedded)
            {
                prologue.AddRange(this.FlattenChainedAssignment(node));
            }

            foreach (AssignmentExpressionSyntax node in embedded)
            {
                this.suppressedAssignments.Add(node);
            }

            try
            {
                return this.TranslateExpression(expression);
            }
            finally
            {
                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    this.suppressedAssignments.Remove(node);
                }
            }
        }

        /// <summary>
        /// Finds the outermost value-position assignment nodes in
        /// <paramref name="expression"/> (in evaluation/document order),
        /// excluding ones inside a nested lambda/local function (their own
        /// statement seam) and — for chained links (`a = b = c`) — excluding the
        /// inner links of a chain already captured by the outer node (see
        /// <see cref="FlattenChainedAssignment"/>). An assignment hidden inside the
        /// short-circuited operand of `&amp;&amp;`/`||` or a `?:` branch would change
        /// evaluation COUNT/order if hoisted, so it is flagged unsupported instead
        /// (issue #1723).
        /// </summary>
        private List<AssignmentExpressionSyntax> CollectEmbeddedAssignments(ExpressionSyntax expression, bool includeSelf)
        {
            bool DescendGuard(SyntaxNode node) =>
                node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or AssignmentExpressionSyntax);

            IEnumerable<AssignmentExpressionSyntax> Scan(ExpressionSyntax root) =>
                root.DescendantNodesAndSelf(descendIntoChildren: DescendGuard).OfType<AssignmentExpressionSyntax>();

            IEnumerable<AssignmentExpressionSyntax> candidates = includeSelf || expression is not AssignmentExpressionSyntax rootAssignment
                ? Scan(expression)
                : Scan(rootAssignment.Left).Concat(Scan(rootAssignment.Right));

            var safe = new List<AssignmentExpressionSyntax>();
            foreach (AssignmentExpressionSyntax candidate in candidates)
            {
                if (IsInShortCircuitOrConditionalBranch(candidate, expression))
                {
                    this.context.ReportUnsupported(
                        candidate,
                        "assignment inside a short-circuited '&&'/'||' operand or a conditional ('?:') branch has no side-effect-preserving G# lowering yet (issue #1723).");
                    continue;
                }

                safe.Add(candidate);
            }

            return safe;
        }

        // True when `node` is reached only through a not-always-evaluated operand
        // inside `root`: the right operand of a `&&`/`||`, either branch of a
        // `?:`, the right operand of `??`, or the "when not null" side of a
        // `?.`/`?[...]` conditional-access chain (including any member/element
        // access further chained off it). Hoisting such an assignment out in
        // front of `root` would evaluate/mutate it unconditionally, changing C#
        // semantics.
        private static bool IsInShortCircuitOrConditionalBranch(SyntaxNode node, ExpressionSyntax root)
        {
            for (SyntaxNode current = node; current != null && current != root; current = current.Parent)
            {
                SyntaxNode parent = current.Parent;
                if (parent is BinaryExpressionSyntax binary &&
                    (binary.IsKind(SyntaxKind.LogicalAndExpression) || binary.IsKind(SyntaxKind.LogicalOrExpression) ||
                     binary.IsKind(SyntaxKind.CoalesceExpression)) &&
                    current == binary.Right)
                {
                    return true;
                }

                if (parent is ConditionalExpressionSyntax conditional &&
                    (current == conditional.WhenTrue || current == conditional.WhenFalse))
                {
                    return true;
                }

                if (parent is ConditionalAccessExpressionSyntax conditionalAccess &&
                    current == conditionalAccess.WhenNotNull)
                {
                    return true;
                }
            }

            return false;
        }

        private static List<PostfixUnaryExpressionSyntax> CollectEmbeddedPostfix(ExpressionSyntax expression)
        {
            // Collect `i++` / `i--` nodes nested inside `expression` (in document
            // order), excluding any that live inside a nested lambda / local
            // function (those belong to that body's own statement seam).
            return expression.DescendantNodes(descendIntoChildren: node =>
                    node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<PostfixUnaryExpressionSyntax>()
                .Where(p => p.IsKind(SyntaxKind.PostIncrementExpression) || p.IsKind(SyntaxKind.PostDecrementExpression))
                .ToList();
        }

        private IEnumerable<GStatement> FlattenChainedAssignment(AssignmentExpressionSyntax assignment)
        {
            // Follows the chain through ANY assignment operator (`=`, `+=`, …), not
            // just `=`: `a = b += c` is `a = (b += c)`, so the `+=` link must also be
            // captured or its mutation of `b` is silently dropped (issue #1723). The
            // walk is parenthesis-transparent (`a = (b = c)`) since a link's RHS may
            // be a parenthesized nested assignment.
            var lefts = new List<(GExpression Target, string Op)>();
            ExpressionSyntax current = assignment;
            while (true)
            {
                ExpressionSyntax unwrapped = current;
                while (unwrapped is ParenthesizedExpressionSyntax paren)
                {
                    unwrapped = paren.Expression;
                }

                if (unwrapped is not AssignmentExpressionSyntax link)
                {
                    break;
                }

                lefts.Add((this.TranslateExpression(link.Left), link.OperatorToken.Text));
                current = link.Right;
            }

            GExpression rhs = this.TranslateExpression(current);
            var statements = new List<GStatement>();
            for (int i = lefts.Count - 1; i >= 0; i--)
            {
                // A chained link's target is READ AGAIN as the value carried to
                // the next (outer) link — `a = b = c` lowers to `b = c; a = b`.
                // When the target is more than a bare identifier (e.g.
                // `buf[Next()]`), re-embedding the SAME translated target node at
                // both the write and the read-back would silently re-run any
                // side-effecting sub-expression (`Next()`) a second time (issue
                // #1731). The outermost link's target (`i == 0`) is never read
                // back — the chain ends there — so it is left untouched.
                GExpression target = i > 0
                    ? this.MakeDuplicationSafeTarget(lefts[i].Target, statements)
                    : lefts[i].Target;
                statements.Add(new AssignmentStatement(target, rhs, lefts[i].Op));
                rhs = target;
            }

            return statements;
        }

        private IEnumerable<GStatement> LowerTupleAssignment(
            TupleExpressionSyntax leftTuple,
            TupleExpressionSyntax rightTuple)
        {
            int count = leftTuple.Arguments.Count;
            var temps = new List<string>(count);
            var statements = new List<GStatement>();

            for (int i = 0; i < count; i++)
            {
                string temp = $"__decon{this.deconCounter++}";
                temps.Add(temp);
                statements.Add(new LocalDeclarationStatement(
                    BindingKind.Var,
                    temp,
                    type: null,
                    initializer: this.TranslateExpression(rightTuple.Arguments[i].Expression)));
            }

            for (int i = 0; i < count; i++)
            {
                statements.Add(new AssignmentStatement(
                    this.TranslateExpression(leftTuple.Arguments[i].Expression),
                    new IdentifierExpression(temps[i])));
            }

            return statements;
        }

        private bool TryGetDeconstructionTargets(
            ExpressionSyntax left,
            out BindingKind binding,
            out IReadOnlyList<string> names)
        {
            binding = BindingKind.Let;
            names = null;

            // `var (a, b) = e`.
            if (left is DeclarationExpressionSyntax { Designation: ParenthesizedVariableDesignationSyntax parenthesized })
            {
                var collected = new List<string>();
                foreach (VariableDesignationSyntax designation in parenthesized.Variables)
                {
                    collected.Add(designation switch
                    {
                        SingleVariableDesignationSyntax single => single.Identifier.Text,
                        _ => "_",
                    });
                }

                names = collected;
                return true;
            }

            // `(var a, var b) = e`.
            if (left is TupleExpressionSyntax tuple &&
                tuple.Arguments.All(a => a.Expression is DeclarationExpressionSyntax))
            {
                var collected = new List<string>();
                foreach (ArgumentSyntax argument in tuple.Arguments)
                {
                    var declaration = (DeclarationExpressionSyntax)argument.Expression;
                    collected.Add(declaration.Designation switch
                    {
                        SingleVariableDesignationSyntax single => single.Identifier.Text,
                        _ => "_",
                    });
                }

                names = collected;
                return true;
            }

            return false;
        }

        private GStatement TranslateLock(LockStatementSyntax lockStatement)
        {
            // G# has no `lock` keyword; the canonical lowering is the BCL
            // monitor pattern `Monitor.Enter(x)` followed by
            // `try { body } finally { Monitor.Exit(x) }` (ADR-0115 §B). The
            // translated target is embedded at BOTH the `Enter` and `Exit` call
            // sites; C# evaluates a `lock` operand exactly once, so a non-trivial
            // target (e.g. `GetSyncRoot()`) is spilled into a preceding local and
            // both calls reference that local instead (issue #1731) — `Enter` and
            // `Exit` then always agree on the same monitor.
            GExpression target = this.SpillOperand(this.TranslateExpression(lockStatement.Expression));

            GStatement enter = new ExpressionStatement(new InvocationExpression(
                new MemberAccessExpression(new IdentifierExpression("Monitor"), "Enter"),
                new List<GExpression> { target }));

            BlockStatement body = this.TranslateStatementAsBlock(lockStatement.Statement);

            var finallyBlock = new BlockStatement(new List<GStatement>
            {
                new ExpressionStatement(new InvocationExpression(
                    new MemberAccessExpression(new IdentifierExpression("Monitor"), "Exit"),
                    new List<GExpression> { target })),
            });

            var tryStatement = new TryStatement(body, new List<CatchClause>(), finallyBlock);

            return new BlockStatement(new List<GStatement> { enter, tryStatement });
        }

        // True when duplicating `expression` in the output has no observable
        // effect — a bare identifier, `this`, or a literal never has a side
        // effect and always reads the same value, so it is safe to embed at more
        // than one output position without spilling it to a temp first (issue
        // #1731). Anything else (a method/property/indexer read, an arithmetic
        // expression, …) may run a side effect or re-read a mutable value and
        // must be evaluated exactly once if it needs to appear more than once.
        private static bool IsTrivialOperand(GExpression expression) =>
            expression is IdentifierExpression or ThisExpression or LiteralExpression;

        // Spills `operand` into a fresh `let` in the active statement seam's
        // prologue (see <see cref="pendingSpillPrologue"/>/<see
        // cref="WithSpillSeam"/>) and returns a reference to that local, UNLESS
        // `operand` is already trivial (see <see cref="IsTrivialOperand"/>) — a
        // bare local/`this`/literal is safe to duplicate as-is, so spilling it
        // would only add clutter. When no statement seam is active (translating
        // outside any statement, or across a lambda/local-function boundary —
        // see <see cref="TranslateLambda"/>/<see cref="TranslateLocalFunction"/>)
        // the operand is conservatively left embedded as-is rather than spilled
        // into an unrelated scope.
        private GExpression SpillOperand(GExpression operand) => this.SpillOperand(operand, this.pendingSpillPrologue);

        // As above, but for a call site that CAN be reached from a "null-seam"
        // expression context — a field/property initializer or a
        // base(...)/this(...) constructor-initializer argument (issue #1731
        // N1) — where `this.pendingSpillPrologue` is null and G#'s grammar has
        // no expression-only way to host a spill `let`: a bare block-with-
        // trailing-expression is only legal directly inside a lambda arrow
        // body or an if/else branch (not a field initializer or a `base`/
        // `this` argument list), and G# has no "call an arbitrary parenthesized
        // expression" postfix form to smuggle one in as an immediately-invoked
        // lambda either (ParsePostfixChainCore has no open-paren/invocation
        // case for a non-name target). So when no seam is active AND `operand`
        // is non-trivial, silently embedding it (the old, wrong, behavior)
        // would double-evaluate it — instead this reports the shape as
        // unsupported so the gap is visible rather than silently wrong, and
        // still falls back to embedding the untouched operand so translation
        // keeps producing (compiling, if diagnostically-flagged) output.
        private GExpression SpillOperand(GExpression operand, SyntaxNode operandSyntaxForDiagnostic)
        {
            if (this.pendingSpillPrologue != null || IsTrivialOperand(operand))
            {
                return this.SpillOperand(operand);
            }

            string message =
                "a non-trivial pattern-scrutinee/range-slice operand here has no enclosing statement to host a " +
                "single-evaluation spill (a field/property initializer or a base(...)/this(...) constructor " +
                "argument has no G# lowering for this yet); it is embedded as-is, which re-evaluates it if it " +
                "is read more than once (issue #1731 N1).";
            this.context.ReportUnsupported(operandSyntaxForDiagnostic, message);
            return operand;
        }

        // As above, but appends the spill declaration directly to an explicit
        // `prologue` list rather than the ambient one — used by callers (e.g.
        // <see cref="FlattenChainedAssignment"/>) that already build their own
        // ordered statement list and know exactly where the spill must land,
        // independent of whatever statement seam happens to be active.
        private GExpression SpillOperand(GExpression operand, List<GStatement> prologue)
        {
            if (IsTrivialOperand(operand) || prologue == null)
            {
                return operand;
            }

            string temp = $"__spill{this.spillCounter++}";
            prologue.Add(new LocalDeclarationStatement(BindingKind.Let, temp, type: null, initializer: operand));
            return new IdentifierExpression(temp);
        }

        // Rebuilds an assignment TARGET (the left-hand side of a chained-
        // assignment link, `a = TARGET = c`) so it is safe to re-embed as a value
        // read for the enclosing link (`a = TARGET`) without re-evaluating any
        // side-effecting sub-expression twice — the receiver of a member access
        // and the index of an element access are each spilled at most once via
        // <see cref="SpillOperand(GExpression, List{GStatement})"/>, and the
        // target is rebuilt from those (now-trivial) pieces (issue #1731). A
        // target that is already an identifier/`this`/literal, or a member
        // access whose receiver needs no spilling, passes through untouched.
        private GExpression MakeDuplicationSafeTarget(GExpression target, List<GStatement> prologue)
        {
            switch (target)
            {
                case MemberAccessExpression member:
                    return new MemberAccessExpression(this.MakeDuplicationSafeTarget(member.Target, prologue), member.MemberName);

                case IndexExpression index:
                    return new IndexExpression(
                        this.MakeDuplicationSafeTarget(index.Target, prologue),
                        this.SpillOperand(index.Index, prologue));

                default:
                    return this.SpillOperand(target, prologue);
            }
        }

        // Establishes a fresh statement seam (issue #1731) around a single
        // value-producing translation that has no `TranslateStatement` seam of
        // its own — a member/lambda/local-function arrow body, which behaves
        // like an implicit `return expr;` statement. Any spill collected while
        // running `translate` is emitted immediately ahead of its result, then
        // the ambient seam is restored (mirrors <see cref="TranslateStatement"/>).
        private IReadOnlyList<GStatement> WithSpillSeam(Func<IReadOnlyList<GStatement>> translate)
        {
            List<GStatement> outerSpillPrologue = this.pendingSpillPrologue;
            var spillPrologue = new List<GStatement>();
            this.pendingSpillPrologue = spillPrologue;
            try
            {
                IReadOnlyList<GStatement> core = translate();
                if (spillPrologue.Count == 0)
                {
                    return core;
                }

                var combined = new List<GStatement>(spillPrologue);
                combined.AddRange(core);
                return combined;
            }
            finally
            {
                this.pendingSpillPrologue = outerSpillPrologue;
            }
        }

        private GStatement TranslateLocalFunction(LocalFunctionStatementSyntax localFunction)
        {
            // A C# local function maps to a G# local `let` bound to a function
            // literal `func (params) RetType { … }` (NOT an arrow lambda — a local
            // function may be recursive and needs an explicit return type).
            var parameters = new List<Parameter>();
            foreach (ParameterSyntax parameter in localFunction.ParameterList.Parameters)
            {
                parameters.Add(this.MapLambdaParameter(parameter));
            }

            bool isAsync = localFunction.Modifiers.Any(m => m.IsKind(SyntaxKind.AsyncKeyword));

            // A local function renders as a `func` literal (NOT an arrow lambda):
            // a value-returning one needs an explicit return type (else the literal
            // is inferred void and `return expr` is rejected), and the explicit type
            // also supports recursion. The declared symbol carries the real return
            // type / void-ness; the async unwrap mirrors method `func`s.
            GTypeReference returnType = this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol localSymbol
                ? this.MapDelegateLikeReturnType(localSymbol, isAsync, localFunction.ReturnType.GetLocation())
                : null;

            // A local function's body is its own evaluation scope: a spill hoisted
            // while translating it (issue #1731) must never leak into the
            // ENCLOSING statement's prologue (that would evaluate the operand once,
            // eagerly, at the local-function declaration instead of per call). The
            // ambient seam is suspended for the body's translation; each statement
            // inside a block body still opens its own fresh seam via
            // <see cref="TranslateStatement"/>.
            List<GStatement> outerSpillPrologue = this.pendingSpillPrologue;
            this.pendingSpillPrologue = null;
            LambdaExpression lambda;
            try
            {
                if (localFunction.Body != null)
                {
                    lambda = new LambdaExpression(parameters, blockBody: this.WithParameterShadows(localFunction, this.TranslateBlock(localFunction.Body)), isAsync: isAsync, returnType: returnType, isFunctionLiteral: true);
                }
                else if (localFunction.ExpressionBody != null)
                {
                    // The expression body has no per-statement seam of its own
                    // (unlike a block body — see below), so a nested spill (issue
                    // #1731) must open a fresh seam here via
                    // <see cref="WithSpillSeam"/> — evaluated per call, inside this
                    // very body, rather than being silently dropped by the
                    // enclosing null seam above.
                    lambda = new LambdaExpression(
                        parameters,
                        blockBody: new BlockStatement(this.WithSpillSeam(
                            () => this.TranslateExpressionStatements(localFunction.ExpressionBody.Expression).ToList()).ToList()),
                        isAsync: isAsync,
                        returnType: returnType,
                        isFunctionLiteral: true);
                }
                else
                {
                    lambda = new LambdaExpression(parameters, blockBody: new BlockStatement(new List<GStatement>()), isAsync: isAsync, returnType: returnType, isFunctionLiteral: true);
                }
            }
            finally
            {
                this.pendingSpillPrologue = outerSpillPrologue;
            }

            return new LocalFunctionStatement(SanitizeIdentifier(localFunction.Identifier.Text), lambda);
        }

        /// <summary>
        /// Parenthesizes a statement-condition whose printed form would otherwise be
        /// misparsed. A condition ending in an index expression (`… a[i]`) directly
        /// precedes the block's `{`, which the G# parser greedily reads as a
        /// composite-literal initializer (`a[i]{ … }`); wrapping the condition in
        /// parentheses disambiguates it (G# parser limitation; see PR notes).
        /// </summary>
        private static GExpression GuardBlockCondition(GExpression condition)
        {
            if (condition is ParenthesizedExpression)
            {
                return condition;
            }

            return EndsWithIndexExpression(condition)
                ? new ParenthesizedExpression(condition)
                : condition;
        }

        private static bool EndsWithIndexExpression(GExpression expression)
        {
            return expression switch
            {
                IndexExpression => true,
                BinaryExpression binary => EndsWithIndexExpression(binary.Right),
                _ => false,
            };
        }

        /// <summary>
        /// Lowers a <c>while</c>/<c>do-while</c> whose condition carries an
        /// <c>is</c>-pattern clause that would otherwise duplicate a side-effecting
        /// scrutinee or leak a binder the G# loop body cannot see (issue #914).
        /// <para>
        /// C# allows a loop condition such as
        /// <c>M(out var n) is Frame child and not EmptyFrame</c>, binding
        /// <c>child</c>/<c>n</c> for the loop body. G# has no <c>and</c>/<c>not</c>
        /// pattern combinators (only <c>&amp;&amp;</c>/<c>!</c>), so the combinator
        /// lowering re-emits the scrutinee per sub-test — re-running the call and
        /// re-declaring <c>out var n</c> (→ GS0102). Pattern/out-var bindings in a
        /// <c>while</c> condition are also invisible in the body (GS0125), and G#
        /// narrows locals in <c>if</c> bodies but not <c>while</c> bodies.
        /// </para>
        /// <para>
        /// The condition is split on its top-level <c>&amp;&amp;</c> clauses. The
        /// leading side-effect-free clauses stay the real loop condition; from the
        /// first clause that binds or duplicates a side-effecting scrutinee onward,
        /// each clause is hoisted to the top of the loop body — the scrutinee
        /// evaluated once into a local, the remaining must-hold tests converted to
        /// <c>if !test { break }</c> guards:
        /// <code>
        /// while a &amp;&amp; b &amp;&amp; M(out var n) is Frame child and not EmptyFrame { … }
        /// // becomes
        /// while a &amp;&amp; b {
        ///     let child = M(out var n)
        ///     if child is EmptyFrame { break }
        ///     …
        /// }
        /// </code>
        /// Returns <see langword="false"/> (keep the plain <c>while cond { }</c>
        /// form) when no clause needs hoisting, so simple loops are unaffected.
        /// </para>
        /// </summary>
        private bool TryTranslateLoopWithConditionHoist(
            ExpressionSyntax condition,
            StatementSyntax bodyStatement,
            bool isDoWhile,
            out IReadOnlyList<GStatement> result)
        {
            result = null;

            if (!this.TryBuildHoistedLoopCondition(condition, out GExpression loopCondition, out List<GStatement> hoisted, out bool hoistsAssignment))
            {
                return false;
            }

            if (isDoWhile && hoistsAssignment && BodyContainsOwnLoopContinue(bodyStatement))
            {
                // The tail-appended hoist runs where C# evaluates `cond` — AFTER the
                // body. But G# `do`/`while` lowers `continue` to a goto that lands
                // right after the whole body (ADR-0070's continueLabel), which is
                // now past the hoisted tail too. A `continue` targeting this loop
                // would therefore skip the hoisted assignment/break-guard, silently
                // re-using a stale value instead of re-evaluating it (issue #1723).
                // Plain `while` is unaffected: its hoist leads the body, so
                // `continue` re-enters it on the next iteration.
                this.context.ReportUnsupported(
                    condition,
                    "assignment inside a short-circuited '&&'/'||' operand or a conditional ('?:') branch has no side-effect-preserving G# lowering yet (issue #1723).");
                return false;
            }

            BlockStatement originalBody = this.TranslateStatementAsBlock(bodyStatement);
            var bodyStatements = new List<GStatement>();
            if (isDoWhile)
            {
                // C# `do { body } while (cond)` evaluates `cond` AFTER the body runs,
                // so the hoisted assignment/break-guard must trail the body (not lead
                // it), or the first body iteration would observe a write that hasn't
                // happened yet (issue #1723).
                bodyStatements.AddRange(originalBody.Statements);
                bodyStatements.AddRange(hoisted);
            }
            else
            {
                bodyStatements.AddRange(hoisted);
                bodyStatements.AddRange(originalBody.Statements);
            }

            var body = new BlockStatement(bodyStatements);

            result = isDoWhile
                ? new GStatement[] { new DoWhileStatement(body, GuardBlockCondition(loopCondition)) }
                : new GStatement[] { new WhileStatement(GuardBlockCondition(loopCondition), body) };
            return true;
        }

        // True for a node that starts a NEW `continue` seam: a nested loop (its
        // own `continue` target) or a lambda/local function (C# forbids a jump
        // statement crossing that boundary at all). Shared by the do-while tail
        // hoist scan (issue #1723) and the for→while incrementor-on-continue fix
        // (issue #1732) so both agree on what "targets THIS loop" means. Note a
        // `switch` is NOT a boundary: `continue` (unlike `break`) passes through a
        // `switch` straight to the enclosing loop.
        private static bool IsOwnLoopContinueBoundary(SyntaxNode node) =>
            node is ForStatementSyntax or ForEachStatementSyntax or ForEachVariableStatementSyntax or
                WhileStatementSyntax or DoStatementSyntax or
                AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax;

        // True when `body` has a `continue` that targets THIS loop. Descent stops
        // at any nested loop/switch (its own `continue`/`break` seam) and at
        // nested lambdas/local functions (their own statement seam), so a
        // `continue` inside an inner `for`/`foreach`/`while`/`do`/`switch` does
        // NOT count — it never reaches this loop's do-while tail hoist (issue
        // #1723).
        private static bool BodyContainsOwnLoopContinue(StatementSyntax body)
        {
            bool DescendGuard(SyntaxNode node) => !IsOwnLoopContinueBoundary(node);

            return body.DescendantNodesAndSelf(descendIntoChildren: DescendGuard).OfType<ContinueStatementSyntax>().Any();
        }

        // True when an own-loop `continue` inside `body` sits under a `try` that
        // has a `finally` clause (reachable without crossing this loop's own
        // boundary). C# runs that `finally` on the way out of the `continue`
        // BEFORE the for-loop's incrementors re-run; duplicating the incrementors
        // right before the `continue` (see
        // <see cref="DuplicateIncrementorsBeforeOwnLoopContinue"/>) would instead
        // run them BEFORE the `finally`, reordering an observable side effect.
        // This shape has no faithful lowering here, so the caller reports it
        // instead of silently reordering (issue #1732).
        private static bool OwnLoopContinueCrossesFinally(StatementSyntax body)
        {
            bool DescendGuard(SyntaxNode node) => !IsOwnLoopContinueBoundary(node);

            foreach (ContinueStatementSyntax continueStatement in
                body.DescendantNodesAndSelf(descendIntoChildren: DescendGuard).OfType<ContinueStatementSyntax>())
            {
                for (SyntaxNode ancestor = continueStatement.Parent; ancestor != null; ancestor = ancestor.Parent)
                {
                    if (ancestor is TryStatementSyntax tryStatement && tryStatement.Finally != null)
                    {
                        return true;
                    }

                    if (ancestor == body)
                    {
                        break;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// Splits <paramref name="condition"/> into its top-level `&amp;&amp;` clauses and,
        /// if any clause needs hoisting (an `is`-pattern requiring a scrutinee
        /// local, or a value-position assignment), returns the leading
        /// side-effect-free clauses as <paramref name="loopCondition"/> and the
        /// rest as body-prologue <paramref name="hoisted"/> statements (a scrutinee
        /// local / hoisted assignment plus `if !test { break }` guards) — shared by
        /// `while`, `do`/`while`, and `for` loop translation (issue #914, #1723).
        /// Returns <c>false</c> (no hoisting needed) when every clause is plain.
        /// </summary>
        private bool TryBuildHoistedLoopCondition(
            ExpressionSyntax condition,
            out GExpression loopCondition,
            out List<GStatement> hoisted,
            out bool hoistsAssignment)
        {
            loopCondition = null;
            hoisted = null;
            hoistsAssignment = false;

            var clauses = new List<ExpressionSyntax>();
            FlattenAndClauses(condition, clauses);

            int firstHoist = -1;
            for (int i = 0; i < clauses.Count; i++)
            {
                if (this.ClauseRequiresConditionHoist(clauses[i]))
                {
                    firstHoist = i;
                    break;
                }
            }

            if (firstHoist < 0)
            {
                return false;
            }

            for (int i = firstHoist; i < clauses.Count; i++)
            {
                if (ClauseContainsAssignment(clauses[i]))
                {
                    hoistsAssignment = true;
                    break;
                }
            }

            // The leading side-effect-free clauses remain the real loop condition.
            GExpression combined = null;
            for (int i = 0; i < firstHoist; i++)
            {
                GExpression clause = this.TranslateExpression(clauses[i]);
                combined = combined == null
                    ? clause
                    : new BinaryExpression(combined, "&&", clause);
            }

            combined ??= LiteralExpression.Bool(true);

            // The remaining clauses hoist to the top of the loop body as a single
            // scrutinee evaluation / assignment plus `if !test { break }` guards.
            var prologue = new List<GStatement>();
            for (int i = firstHoist; i < clauses.Count; i++)
            {
                this.HoistLoopConditionClause(clauses[i], prologue);
            }

            loopCondition = combined;
            hoisted = prologue;
            return true;
        }

        // Flattens the left-to-right top-level `&&` operands of a condition into
        // `clauses`. Parentheses are transparent for the split.
        private static void FlattenAndClauses(ExpressionSyntax expression, List<ExpressionSyntax> clauses)
        {
            ExpressionSyntax expr = expression;
            while (expr is ParenthesizedExpressionSyntax paren)
            {
                expr = paren.Expression;
            }

            if (expr is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.LogicalAndExpression))
            {
                FlattenAndClauses(binary.Left, clauses);
                FlattenAndClauses(binary.Right, clauses);
            }
            else
            {
                clauses.Add(expr);
            }
        }

        // A loop-condition clause needs hoisting when it is an `is`-pattern whose
        // lowering would duplicate a side-effecting scrutinee (an `and`/`or`
        // combinator re-emits the receiver), declare an `out var` more than once
        // (GS0102), or bind a pattern variable the G# loop body cannot see
        // (GS0125); or when it contains a value-position assignment (`(line =
        // r.ReadLine()) != null`) — G# assignment is a statement, so the write
        // must be hoisted into the loop body, run once per iteration (issue
        // #1723).
        private bool ClauseRequiresConditionHoist(ExpressionSyntax clause)
        {
            return (clause is IsPatternExpressionSyntax isPattern &&
                (PatternIntroducesBinding(isPattern.Pattern) ||
                 PatternDuplicatesScrutinee(isPattern.Pattern) ||
                 ExpressionDeclaresOutVar(isPattern.Expression))) ||
                ClauseContainsAssignment(clause);
        }

        // Cheap presence check used only to decide whether a clause needs the
        // hoist path at all; the short-circuit/`?:` safety analysis and the
        // actual hoisting happen once, in HoistLoopConditionClause.
        private static bool ClauseContainsAssignment(ExpressionSyntax clause) =>
            clause.DescendantNodesAndSelf(descendIntoChildren: node =>
                    node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<AssignmentExpressionSyntax>()
                .Any();

        private static bool PatternIntroducesBinding(PatternSyntax pattern) =>
            pattern.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>().Any();

        private static bool PatternDuplicatesScrutinee(PatternSyntax pattern) =>
            pattern.DescendantNodesAndSelf().OfType<BinaryPatternSyntax>().Any();

        private static bool ExpressionDeclaresOutVar(ExpressionSyntax expression) =>
            expression.DescendantNodesAndSelf().OfType<DeclarationExpressionSyntax>().Any();

        // Emits the hoisted statements for a single loop-condition clause: a pure
        // clause becomes a negated `break` guard; a clause carrying a
        // value-position assignment (`(line = r.ReadLine()) != null`) hoists the
        // assignment(s) as preceding statement(s) — re-run every iteration, exactly
        // where C# would re-evaluate them — then becomes a negated `break` guard
        // over the now-hoisted read (issue #1723); an `is`-pattern clause evaluates
        // its scrutinee once into a local and turns the pattern's must-hold tests
        // into `break` guards (issue #914).
        private void HoistLoopConditionClause(ExpressionSyntax clause, List<GStatement> into)
        {
            // Any spill hoisted while translating `clause` (issue #1731 — e.g. a
            // non-trivial pattern scrutinee or range-slice start nested inside the
            // condition) must land in `into`, which runs at the START of each loop
            // iteration — NOT in the enclosing loop STATEMENT's own prologue (that
            // would evaluate the operand once, before the loop, instead of once
            // per iteration as C# does).
            List<GStatement> outerSpillPrologue = this.pendingSpillPrologue;
            this.pendingSpillPrologue = into;
            try
            {
                this.HoistLoopConditionClauseCore(clause, into);
            }
            finally
            {
                this.pendingSpillPrologue = outerSpillPrologue;
            }
        }

        private void HoistLoopConditionClauseCore(ExpressionSyntax clause, List<GStatement> into)
        {
            if (clause is not IsPatternExpressionSyntax isPattern)
            {
                List<AssignmentExpressionSyntax> embedded = this.CollectEmbeddedAssignments(clause, includeSelf: true);
                if (embedded.Count == 0)
                {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))));
                    return;
                }

                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    into.AddRange(this.FlattenChainedAssignment(node));
                }

                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    this.suppressedAssignments.Add(node);
                }

                try
                {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))));
                }
                finally
                {
                    foreach (AssignmentExpressionSyntax node in embedded)
                    {
                        this.suppressedAssignments.Remove(node);
                    }
                }

                return;
            }

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            ITypeSymbol scrutineeType = this.context.GetTypeInfo(isPattern.Expression).Type;

            // The hoist local reuses a top-level binder's name when present (so body
            // references to that binder print as the hoist local); otherwise a fresh
            // synthetic name is used.
            ILocalSymbol mainBinder = this.FindMainPatternBinder(isPattern.Pattern);
            string hoistName = mainBinder != null
                ? SanitizeIdentifier(mainBinder.Name)
                : $"__scrutinee{this.loopHoistCounter++}";

            BindingKind binding = mainBinder != null && this.IsLocalReassigned(mainBinder)
                ? BindingKind.Var
                : BindingKind.Let;

            into.Add(new LocalDeclarationStatement(binding, hoistName, type: null, initializer: receiver));

            var idExpr = new IdentifierExpression(hoistName);

            // Any secondary binder prints as the hoist local inside the body.
            foreach (ILocalSymbol binder in this.EnumeratePatternBinders(isPattern.Pattern))
            {
                if (!SymbolEqualityComparer.Default.Equals(binder, mainBinder))
                {
                    this.patternBindings[binder] = idExpr;
                }
            }

            this.EmitMustHoldGuards(idExpr, scrutineeType, isPattern.Pattern, mainBinder, into);
        }

        // Converts a must-hold pattern over the already-hoisted `idExpr` into a list
        // of `if !test { break }` guards. An `and` combinator splits into one guard
        // per side; a `not P` breaks when `P` matches; the main binder whose static
        // type already satisfies its type test is a bind-only (no guard).
        private void EmitMustHoldGuards(
            GExpression idExpr,
            ITypeSymbol scrutineeType,
            PatternSyntax pattern,
            ILocalSymbol mainBinder,
            List<GStatement> into)
        {
            switch (pattern)
            {
                case ParenthesizedPatternSyntax parenthesized:
                    this.EmitMustHoldGuards(idExpr, scrutineeType, parenthesized.Pattern, mainBinder, into);
                    return;

                case BinaryPatternSyntax andPattern when andPattern.OperatorToken.IsKind(SyntaxKind.AndKeyword):
                    this.EmitMustHoldGuards(idExpr, scrutineeType, andPattern.Left, mainBinder, into);
                    this.EmitMustHoldGuards(idExpr, scrutineeType, andPattern.Right, mainBinder, into);
                    return;

                case UnaryPatternSyntax notPattern when notPattern.IsKind(SyntaxKind.NotPattern):
                    // `not P` must hold → break when `P` matches.
                    into.Add(BreakIf(this.TranslatePatternTest(idExpr, notPattern.Pattern, scrutineeType)));
                    return;

                case DeclarationPatternSyntax declaration
                    when this.IsBindOnlyMainBinder(declaration, scrutineeType, mainBinder):
                    // The main binder whose static type already satisfies the test is
                    // a non-null bind (e.g. a method returning a non-null `Frame`); no
                    // guard is needed and the binder prints as the hoist local.
                    return;

                case DeclarationPatternSyntax declaration:
                    // A secondary type-binder: emit the type test as a break guard;
                    // references to the binder print as the hoist local (registered by
                    // HoistLoopConditionClause).
                    into.Add(BreakIf(Negate(new BinaryExpression(
                        idExpr, "is", new TypeExpression(this.MapTypeSyntax(declaration.Type))))));
                    return;

                default:
                    into.Add(BreakIf(Negate(this.TranslatePatternTest(idExpr, pattern, scrutineeType))));
                    return;
            }
        }

        // True when `declaration` binds the hoist local and the scrutinee's static
        // type already (non-nullably) satisfies the declared type — so the type test
        // is statically true and the pattern is a pure binding.
        private bool IsBindOnlyMainBinder(
            DeclarationPatternSyntax declaration, ITypeSymbol scrutineeType, ILocalSymbol mainBinder)
        {
            if (mainBinder == null ||
                declaration.Designation is not SingleVariableDesignationSyntax single ||
                this.context.GetDeclaredSymbol(single) is not ILocalSymbol symbol ||
                !SymbolEqualityComparer.Default.Equals(symbol, mainBinder))
            {
                return false;
            }

            ITypeSymbol target = this.context.GetTypeInfo(declaration.Type).Type;
            return IsAssignableNonNull(scrutineeType, target);
        }

        // True when `scrutineeType` is a non-nullable reference convertible to
        // `target` by identity or base/interface — i.e. `scrutinee is target` is
        // statically guaranteed.
        private static bool IsAssignableNonNull(ITypeSymbol scrutineeType, ITypeSymbol target)
        {
            if (scrutineeType == null || target == null ||
                scrutineeType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            for (ITypeSymbol t = scrutineeType; t != null; t = t.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(t, target))
                {
                    return true;
                }
            }

            return scrutineeType.AllInterfaces.Any(i => SymbolEqualityComparer.Default.Equals(i, target));
        }

        private ILocalSymbol FindMainPatternBinder(PatternSyntax pattern) =>
            this.EnumeratePatternBinders(pattern).FirstOrDefault();

        private IEnumerable<ILocalSymbol> EnumeratePatternBinders(PatternSyntax pattern)
        {
            foreach (SyntaxNode node in pattern.DescendantNodesAndSelf())
            {
                if (node is SingleVariableDesignationSyntax single &&
                    this.context.GetDeclaredSymbol(single) is ILocalSymbol symbol)
                {
                    yield return symbol;
                }
            }
        }

        private static GStatement BreakIf(GExpression condition) =>
            new IfStatement(condition, new BlockStatement(new GStatement[] { new BreakStatement() }));

        private static GExpression Negate(GExpression expression) =>
            new UnaryExpression("!", new ParenthesizedExpression(expression));

        /// <summary>
        /// Translates an <c>if</c> statement into one or more G# statements. A C#
        /// negated type-pattern guard with a designation (<c>if (x is not T t) {
        /// throw/return; }</c>) needs the binder <c>t</c> to remain in scope *after*
        /// the <c>if</c> (the then-block exits), and a property-path receiver cannot
        /// be smart-cast — so it is lowered to a hoisted nullable local plus a
        /// nil-guard (<see cref="TryBuildNegatedGuardHoist"/>). Every other form maps
        /// to the single-statement <see cref="TranslateIf"/>.
        /// </summary>
        private IEnumerable<GStatement> TranslateIfStatements(IfStatementSyntax ifStatement)
        {
            if (this.TryBuildNegatedGuardHoist(ifStatement, out IReadOnlyList<GStatement> hoisted))
            {
                return hoisted;
            }

            if (this.TryBuildPositiveGuardHoist(ifStatement, out IReadOnlyList<GStatement> positiveHoisted))
            {
                return positiveHoisted;
            }

            return new[] { this.TranslateIf(ifStatement) };
        }

        /// <summary>
        /// Lowers a C# positive type-pattern guard <c>if (receiver is T t) { … }</c>
        /// to the smart-cast-friendly G# form below, but only when the pattern
        /// variable <c>t</c> is referenced *outside* the then-block (C# leaks a
        /// positive declaration-pattern variable into the enclosing scope under
        /// definite-assignment rules, so later code reads or reassigns it).
        /// <code>
        /// var t T? = receiver as T   // 'let' when t is never reassigned
        /// if t != nil { … }          // t smart-casts to T inside the guard
        /// … later statements using t …
        /// </code>
        /// When <c>t</c> is used only inside the then-block the existing
        /// smart-cast binding (no hoist) is kept, so currently passing tests do not
        /// regress. Only applies over a reference (non-value) target type, where the
        /// <c>as T</c> + nil-guard form is valid.
        /// </summary>
        private bool TryBuildPositiveGuardHoist(
            IfStatementSyntax ifStatement, out IReadOnlyList<GStatement> result)
        {
            result = null;

            if (ifStatement.Condition is not IsPatternExpressionSyntax isPattern ||
                !TryExtractSingleVarTypePattern(
                    isPattern.Pattern, out TypeSyntax typeSyntax, out SingleVariableDesignationSyntax single))
            {
                return false;
            }

            // The hoisted `as T` + `!= nil` guard is only valid when T is a
            // reference type (or nullable value type); a non-nullable value-type
            // target keeps the existing then-block smart-cast binding.
            ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
            if (targetSymbol == null || targetSymbol.IsValueType)
            {
                return false;
            }

            // Hoist when EITHER the pattern variable escapes the then-block, OR the
            // scrutinee is a non-trivial expression that gsc cannot smart-cast. gsc
            // narrows only a bare local/parameter (ADR-0069); a method-call result,
            // member-access chain or field reference re-emitted at each use of `t`
            // would not smart-cast (→ GS0158) and, for a side-effecting scrutinee
            // such as `M(out var x)`, would be re-evaluated (→ GS0102). When the
            // scrutinee IS a smart-castable local and `t` is used solely inside the
            // guarded block, the existing smart cast (rewriting `t` to the receiver)
            // is correct and avoids an unnecessary local.
            if (this.context.GetDeclaredSymbol(single) is not ILocalSymbol patternSymbol)
            {
                return false;
            }

            GTypeReference targetType = this.MapTypeSyntax(typeSyntax);
            bool escapesThenBlock =
                this.IsSymbolReferencedOutside(patternSymbol, ifStatement.Statement);

            // The broadened "non-smart-castable scrutinee" hoist requires a
            // well-formed nullable local annotation. NamedTypeReference (`T?`) and
            // ArrayTypeReference (`[]?T`, incl. nullable jagged arrays `[]?[]T`,
            // issue #1351) both nullable-annotate and round-trip-parse in gsc; a
            // pointer/tuple target's nullable form does not yet, so for those keep
            // the existing smart cast when the binder does not escape.
            if (!escapesThenBlock &&
                (this.IsSmartCastableScrutinee(isPattern.Expression) ||
                 targetType is not (NamedTypeReference or ArrayTypeReference)))
            {
                return false;
            }

            string localName = SanitizeIdentifier(single.Identifier.Text);
            GExpression receiver = this.TranslateExpression(isPattern.Expression);

            // Record that this pattern variable is now a nullable G# local so an
            // assignment-LHS use inside the guard is null-forgiven (gsc narrows
            // reads but not write receivers).
            this.hoistedNullableGuardLocals.Add(patternSymbol);

            // `var t T? = receiver as T` when the leaked variable is reassigned
            // anywhere in the body (C# allows it); otherwise an immutable `let`.
            BindingKind binding = this.IsLocalReassigned(patternSymbol)
                ? BindingKind.Var
                : BindingKind.Let;

            var hoist = new LocalDeclarationStatement(
                binding,
                localName,
                MakeNullable(targetType),
                new BinaryExpression(receiver, "as", new TypeExpression(targetType)));

            // `if t != nil { <then> }` — the positive guard; the then-block runs on a
            // successful cast and `t` smart-casts to non-null T inside it. References
            // to `t` print as the hoisted local (no patternBindings entry registered).
            GExpression guard = new BinaryExpression(
                new IdentifierExpression(localName), "!=", LiteralExpression.Null());
            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = ifStatement.Else.Statement is IfStatementSyntax elseIf
                    ? this.TranslateIf(elseIf)
                    : this.TranslateStatementAsBlock(ifStatement.Else.Statement);
            }

            result = new GStatement[] { hoist, new IfStatement(guard, then, elseBranch) };
            return true;
        }

        /// <summary>
        /// A scrutinee is smart-castable by gsc only when it is a bare local or
        /// parameter reference; gsc narrows locals, not method-call results,
        /// member-access chains, or field references (ADR-0069). When the scrutinee
        /// is not smart-castable, an <c>x is T t</c> whose binder is used in the
        /// guarded block must hoist the scrutinee into a local (so the local
        /// smart-casts) rather than re-emit the expression at each use of <c>t</c>.
        /// </summary>
        private bool IsSmartCastableScrutinee(ExpressionSyntax expression)
        {
            if (expression is not IdentifierNameSyntax)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            return symbol is ILocalSymbol or IParameterSymbol;
        }

        // Extracts the target type and single-variable designation from a positive
        // declaration / recursive type-pattern (`x is T t`, `x is T { } t`). Returns
        // false for any other pattern shape (constant, relational, property
        // subpatterns, multi-variable designations).
        private static bool TryExtractSingleVarTypePattern(
            PatternSyntax pattern,
            out TypeSyntax typeSyntax,
            out SingleVariableDesignationSyntax single)
        {
            typeSyntax = null;
            single = null;

            VariableDesignationSyntax designation;
            switch (pattern)
            {
                case DeclarationPatternSyntax declaration:
                    typeSyntax = declaration.Type;
                    designation = declaration.Designation;
                    break;

                case RecursivePatternSyntax { Type: { } recursiveType } recursive
                    when recursive.PropertyPatternClause is null or { Subpatterns.Count: 0 }:
                    typeSyntax = recursiveType;
                    designation = recursive.Designation;
                    break;

                default:
                    return false;
            }

            single = designation as SingleVariableDesignationSyntax;
            return single != null;
        }

        // Returns true when <paramref name="symbol"/> is referenced anywhere in the
        // current body scope outside <paramref name="excludedSubtree"/> (e.g. a
        // pattern variable read or written after/around its `if`). Mirrors the
        // body-walk in <see cref="IsLocalReassigned"/>.
        private bool IsSymbolReferencedOutside(ISymbol symbol, SyntaxNode excludedSubtree)
        {
            SyntaxNode scope = this.currentBodyScope;
            if (scope == null)
            {
                return false;
            }

            foreach (SyntaxNode node in scope.DescendantNodes())
            {
                if (node is not IdentifierNameSyntax identifier)
                {
                    continue;
                }

                if (excludedSubtree != null && excludedSubtree.Contains(identifier))
                {
                    continue;
                }

                ISymbol referenced = this.context.GetSymbolInfo(identifier).Symbol;
                if (referenced != null && SymbolEqualityComparer.Default.Equals(referenced, symbol))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Lowers a C# negated type-pattern guard <c>if (receiver is not T t) {
        /// … }</c> to the smart-cast-friendly G# form below.
        /// <code>
        /// let t T? = receiver as T
        /// if t == nil { … }
        /// </code>
        /// The binder <c>t</c> becomes a real hoisted local that survives past the
        /// <c>if</c> (so later <c>t.Member</c> uses bind to it under G#'s Kotlin-style
        /// smart cast), and a property-path receiver (<c>child.Header</c>) is
        /// evaluated once into the local. Only applies when the whole condition is a
        /// negated declaration/recursive type-pattern with a single-variable
        /// designation over a reference (non-value) target type, where
        /// <c>as T</c> + nil-guard is valid.
        /// </summary>
        private bool TryBuildNegatedGuardHoist(
            IfStatementSyntax ifStatement, out IReadOnlyList<GStatement> result)
        {
            result = null;

            if (ifStatement.Condition is not IsPatternExpressionSyntax isPattern ||
                isPattern.Pattern is not UnaryPatternSyntax notPattern ||
                !notPattern.IsKind(SyntaxKind.NotPattern))
            {
                return false;
            }

            TypeSyntax typeSyntax;
            VariableDesignationSyntax designation;
            switch (notPattern.Pattern)
            {
                case DeclarationPatternSyntax declaration:
                    typeSyntax = declaration.Type;
                    designation = declaration.Designation;
                    break;

                case RecursivePatternSyntax { Type: { } recursiveType } recursive
                    when recursive.PropertyPatternClause is null or { Subpatterns.Count: 0 }:
                    typeSyntax = recursiveType;
                    designation = recursive.Designation;
                    break;

                default:
                    return false;
            }

            if (designation is not SingleVariableDesignationSyntax single)
            {
                return false;
            }

            // The hoisted `as T` + `== nil` guard is only valid when T is a
            // reference type (or nullable value type); a non-nullable value-type
            // target keeps the existing then-block binding behaviour.
            ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
            if (targetSymbol == null || targetSymbol.IsValueType)
            {
                return false;
            }

            string localName = SanitizeIdentifier(single.Identifier.Text);
            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            GTypeReference targetType = this.MapTypeSyntax(typeSyntax);

            // `let t T? = receiver as T` — the local is declared nullable so the
            // `== nil` guard and the subsequent smart cast both type-check, while the
            // `as` cast keeps its non-nullable reference target (a nullable `as T?`
            // target is rejected at emit time).
            var hoist = new LocalDeclarationStatement(
                BindingKind.Let,
                localName,
                MakeNullable(targetType),
                new BinaryExpression(receiver, "as", new TypeExpression(targetType)));

            // `if t == nil { <then> }` reproduces the negated guard: when the cast
            // fails the local is nil, so the original then-block runs.
            GExpression guard = new BinaryExpression(
                new IdentifierExpression(localName), "==", LiteralExpression.Null());
            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = ifStatement.Else.Statement is IfStatementSyntax elseIf
                    ? this.TranslateIf(elseIf)
                    : this.TranslateStatementAsBlock(ifStatement.Else.Statement);
            }

            result = new GStatement[] { hoist, new IfStatement(guard, then, elseBranch) };
            return true;
        }

        // Returns a nullable (`T?`) copy of a type reference, preserving the
        // concrete reference kind (named/array/pointer/tuple). Used when hoisting a
        // negated type-pattern guard local so the `== nil` test type-checks.
        private static GTypeReference MakeNullable(GTypeReference reference)
        {
            return reference switch
            {
                NamedTypeReference named =>
                    new NamedTypeReference(named.Name, named.TypeArguments) { IsNullable = true },
                ArrayTypeReference array =>
                    new ArrayTypeReference(array.ElementType) { IsNullable = true },
                PointerTypeReference pointer =>
                    new PointerTypeReference(pointer.ElementType) { IsNullable = true },
                TupleTypeReference tuple =>
                    new TupleTypeReference(tuple.ElementTypes) { IsNullable = true },
                ArrowTypeReference arrow =>
                    new ArrowTypeReference(arrow.ParameterTypes, arrow.ReturnTypes, arrow.IsAsync)
                    {
                        IsNullable = true,
                    },
                _ => reference,
            };
        }

        private GStatement TranslateIf(IfStatementSyntax ifStatement)
        {
            // Translate the condition first so any `x is T t` declaration pattern
            // registers its Kotlin-style smart-cast binding before the guarded
            // block is translated; the binding is scoped to the then-block only.
            // A value-position assignment in the condition (`if ((x = f()) > 0)`,
            // `if (x = f())`) is hoisted into a preceding assignment statement — it
            // runs once, exactly where C# would evaluate it (issue #1723).
            var bindingsBefore = new HashSet<ISymbol>(this.patternBindings.Keys, SymbolEqualityComparer.Default);
            var conditionPrologue = new List<GStatement>();
            GExpression condition = GuardBlockCondition(
                this.TranslateConditionWithHoist(ifStatement.Condition, conditionPrologue));

            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            foreach (ISymbol added in this.patternBindings.Keys.ToList())
            {
                if (!bindingsBefore.Contains(added))
                {
                    this.patternBindings.Remove(added);
                }
            }

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                if (ifStatement.Else.Statement is IfStatementSyntax elseIf)
                {
                    elseBranch = this.TranslateIf(elseIf);
                }
                else
                {
                    elseBranch = this.TranslateStatementAsBlock(ifStatement.Else.Statement);
                }
            }

            GStatement result = new IfStatement(condition, then, elseBranch);
            if (conditionPrologue.Count > 0)
            {
                conditionPrologue.Add(result);
                result = new BlockStatement(conditionPrologue);
            }

            return result;
        }

        private GStatement TranslateForStatement(ForStatementSyntax forStatement)
        {
            int declaratorCount = forStatement.Declaration?.Variables.Count ?? 0;

            // G#'s `for` carries a SINGLE init clause and a SINGLE incrementor, so
            // a C-style `for` with multiple declarators/initializers or multiple
            // incrementors cannot be represented directly. Lower those to a block
            // + `while` so every init runs once up front and every incrementor runs
            // at the end of each iteration (issue #914). A condition needing clause
            // hoisting (a value-position assignment, e.g. `for (…; (c = Next()) !=
            // -1; …)`, or an is-pattern requiring a scrutinee local) has the same
            // problem — G#'s single-expression `for` condition has nowhere to place
            // the hoisted statement — so it takes the same lowering (issue #1723).
            if (declaratorCount > 1 ||
                forStatement.Initializers.Count > 1 ||
                forStatement.Incrementors.Count > 1 ||
                this.ForConditionRequiresHoist(forStatement.Condition))
            {
                return this.LowerForToWhile(forStatement);
            }

            GStatement initializer = null;
            if (forStatement.Declaration != null)
            {
                initializer = this.TranslateLocalDeclaration(forStatement.Declaration, isConst: false)
                    .FirstOrDefault();
            }
            else if (forStatement.Initializers.Count > 0)
            {
                initializer = this.TranslateExpressionStatement(forStatement.Initializers[0]);
            }

            GExpression condition = forStatement.Condition == null
                ? null
                : this.TranslateExpression(forStatement.Condition);

            GStatement incrementor = forStatement.Incrementors.Count > 0
                ? this.TranslateExpressionStatement(forStatement.Incrementors[0])
                : null;

            return new ForStatement(
                initializer,
                condition,
                incrementor,
                this.TranslateStatementAsBlock(forStatement.Statement));
        }

        private bool ForConditionRequiresHoist(ExpressionSyntax condition)
        {
            if (condition == null)
            {
                return false;
            }

            var clauses = new List<ExpressionSyntax>();
            FlattenAndClauses(condition, clauses);
            return clauses.Any(this.ClauseRequiresConditionHoist);
        }

        /// <summary>
        /// Lowers a C-style <c>for</c> that has more than one initializer/declarator
        /// or more than one incrementor — neither of which fits G#'s single-init,
        /// single-incrementor <c>for</c> — into an equivalent block + <c>while</c>:
        /// all inits run once before the loop, the body runs each iteration, then
        /// every incrementor runs at the end of the body (issue #914). A condition
        /// needing clause hoisting places its prologue (hoisted assignment /
        /// scrutinee local plus `if !test { break }` guards) at the TOP of the body,
        /// re-run every iteration exactly where C# would re-test the condition
        /// (issue #1723).
        /// <para>
        /// In C# the incrementors also run when the body executes a loop-targeting
        /// <c>continue</c>, but a G# <c>continue</c> is a goto straight past the
        /// WHOLE lowered <c>while</c> body — so the trailing incrementors below
        /// would be silently skipped. When the body has such a <c>continue</c>, it
        /// is rewritten (<see cref="DuplicateIncrementorsBeforeOwnLoopContinue"/>) to duplicate the
        /// incrementors immediately ahead of every own-loop <c>continue</c>, so they
        /// still run before the condition re-test either way (issue #1732). The one
        /// shape that rewrite cannot do faithfully — the <c>continue</c> sits inside
        /// a <c>try</c>/<c>finally</c>, where C# runs <c>finally</c> before the
        /// incrementors — is reported via <c>ReportUnsupported</c> instead of
        /// silently reordering that side effect.
        /// </para>
        /// </summary>
        private GStatement LowerForToWhile(ForStatementSyntax forStatement)
        {
            var outer = new List<GStatement>();

            if (forStatement.Declaration != null)
            {
                outer.AddRange(this.TranslateLocalDeclaration(forStatement.Declaration, isConst: false));
            }

            foreach (ExpressionSyntax init in forStatement.Initializers)
            {
                outer.AddRange(this.TranslateExpressionStatements(init));
            }

            GExpression condition;
            List<GStatement> conditionPrologue;
            if (forStatement.Condition == null)
            {
                condition = LiteralExpression.Bool(true);
                conditionPrologue = new List<GStatement>();
            }
            else if (this.TryBuildHoistedLoopCondition(forStatement.Condition, out GExpression hoistedCondition, out List<GStatement> hoisted, out _))
            {
                condition = hoistedCondition;
                conditionPrologue = hoisted;
            }
            else
            {
                condition = this.TranslateExpression(forStatement.Condition);
                conditionPrologue = new List<GStatement>();
            }

            List<ExpressionSyntax> incrementorExpressions = forStatement.Incrementors.ToList();
            var incrementorStatements = new List<GStatement>();
            foreach (ExpressionSyntax inc in incrementorExpressions)
            {
                incrementorStatements.AddRange(this.TranslateExpressionStatements(inc));
            }

            BlockStatement translatedBody = this.TranslateStatementAsBlock(forStatement.Statement);
            if (incrementorStatements.Count > 0 && BodyContainsOwnLoopContinue(forStatement.Statement))
            {
                if (OwnLoopContinueCrossesFinally(forStatement.Statement))
                {
                    this.context.ReportUnsupported(
                        forStatement,
                        "a 'continue' inside a 'try'/'finally' within this 'for' loop has no side-effect-preserving G# lowering yet (issue #1732).");
                }
                else
                {
                    translatedBody = this.DuplicateIncrementorsBeforeOwnLoopContinue(forStatement, translatedBody, incrementorStatements);
                }
            }

            var bodyStatements = new List<GStatement>(conditionPrologue);
            bodyStatements.AddRange(translatedBody.Statements);
            bodyStatements.AddRange(incrementorStatements);

            outer.Add(new WhileStatement(GuardBlockCondition(condition), new BlockStatement(bodyStatements)));

            return new BlockStatement(outer);
        }

        /// <summary>
        /// Duplicates a <c>for</c> loop's already-translated incrementor
        /// statements immediately ahead of every <c>continue</c> that targets
        /// THIS loop. G#'s while-lowering (<see cref="LowerForToWhile"/>) appends
        /// the incrementors as trailing statements in the lowered <c>while</c>
        /// body, but a G# <c>continue</c> is a goto straight past the WHOLE body
        /// (ADR-0070's continueLabel) — so without this rewrite the trailing
        /// incrementors are silently skipped on <c>continue</c>, unlike C#'s
        /// <c>for</c>, which always runs them before re-testing the condition
        /// (issue #1732).
        /// <para>
        /// Operates on the TRANSLATED G# statement tree, not the C# syntax tree:
        /// rebuilding a Roslyn syntax subtree to splice in the incrementors would
        /// re-parent untouched sibling nodes onto a detached tree, breaking any
        /// later <c>SemanticModel.GetSymbolInfo</c> call on them
        /// (<see cref="ArgumentException"/> "Syntax node is not within syntax
        /// tree"). The G# AST has no such constraint, so the rewrite happens
        /// here, after translation.
        /// </para>
        /// <para>
        /// Descent stops at a nested loop (<see cref="WhileStatement"/>,
        /// <see cref="ForStatement"/>, <see cref="DoWhileStatement"/>,
        /// <see cref="ForInStatement"/>) or a nested
        /// <see cref="LocalFunctionStatement"/> — each is its own
        /// <c>continue</c> seam, mirroring <see cref="BodyContainsOwnLoopContinue"/>.
        /// A <c>finally</c> block is left untouched: C# forbids a jump statement
        /// leaving a <c>finally</c>, so it can never itself contain an own-loop
        /// <c>continue</c>.
        /// </para>
        /// </summary>
        private BlockStatement DuplicateIncrementorsBeforeOwnLoopContinue(
            ForStatementSyntax forStatement,
            BlockStatement body,
            IReadOnlyList<GStatement> incrementorStatements)
        {
            return (BlockStatement)this.RewriteOwnLoopContinue(forStatement, body, incrementorStatements);
        }

        // True when `statement` (a TRANSLATED G# node) transitively holds a
        // `ContinueStatement` that targets THIS loop, mirroring
        // <see cref="BodyContainsOwnLoopContinue"/> but walking the G# AST
        // instead of the C# syntax tree — used by <see
        // cref="RewriteOwnLoopContinue"/>'s `default` arm so an unhandled
        // body-carrying G# statement kind is reported (issue #1732) instead of
        // silently passing an unrewritten own-loop `continue` through (which
        // would skip the duplicated incrementors, reproducing the original
        // miscompile). Boundaries match <see cref="RewriteOwnLoopContinue"/>:
        // a nested loop or local function never contributes its own
        // `continue`s to this check.
        private static bool ContainsOwnLoopContinue(GStatement statement)
        {
            switch (statement)
            {
                case ContinueStatement:
                    return true;

                case BlockStatement block:
                    foreach (GStatement inner in block.Statements)
                    {
                        if (ContainsOwnLoopContinue(inner))
                        {
                            return true;
                        }
                    }

                    return false;

                case IfStatement ifStatement:
                    return ContainsOwnLoopContinue(ifStatement.Then)
                        || (ifStatement.ElseBranch != null && ContainsOwnLoopContinue(ifStatement.ElseBranch));

                case TryStatement tryStatement:
                    if (ContainsOwnLoopContinue(tryStatement.TryBlock))
                    {
                        return true;
                    }

                    foreach (CatchClause catchClause in tryStatement.CatchClauses)
                    {
                        if (ContainsOwnLoopContinue(catchClause.Body))
                        {
                            return true;
                        }
                    }

                    // FinallyBlock deliberately excluded: C# forbids a jump
                    // statement leaving a `finally`, so it can never itself
                    // hold an own-loop `continue`.
                    return false;

                case SwitchStatement switchStatement:
                    foreach (SwitchStatementCase switchCase in switchStatement.Cases)
                    {
                        if (ContainsOwnLoopContinue(switchCase.Body))
                        {
                            return true;
                        }
                    }

                    return false;

                case FixedStatement fixedStatement:
                    return ContainsOwnLoopContinue(fixedStatement.Body);

                // Boundaries: a nested loop's own continue seam, or a nested
                // local function (its own statement seam) — never counts.
                case WhileStatement:
                case ForStatement:
                case DoWhileStatement:
                case ForInStatement:
                case LocalFunctionStatement:
                    return false;

                default:
                    return false;
            }
        }

        private GStatement RewriteOwnLoopContinue(
            ForStatementSyntax forStatement,
            GStatement statement,
            IReadOnlyList<GStatement> incrementorStatements)
        {
            switch (statement)
            {
                case ContinueStatement:
                {
                    var replaced = new List<GStatement>(incrementorStatements) { statement };
                    return new BlockStatement(replaced);
                }

                case BlockStatement block:
                {
                    var rewritten = new List<GStatement>(block.Statements.Count);
                    foreach (GStatement inner in block.Statements)
                    {
                        rewritten.Add(this.RewriteOwnLoopContinue(forStatement, inner, incrementorStatements));
                    }

                    return new BlockStatement(rewritten, block.IsUnsafe);
                }

                case IfStatement ifStatement:
                {
                    GStatement elseBranch = ifStatement.ElseBranch == null
                        ? null
                        : this.RewriteOwnLoopContinue(forStatement, ifStatement.ElseBranch, incrementorStatements);
                    return new IfStatement(
                        ifStatement.Condition,
                        (BlockStatement)this.RewriteOwnLoopContinue(forStatement, ifStatement.Then, incrementorStatements),
                        elseBranch);
                }

                case TryStatement tryStatement:
                {
                    var catchClauses = new List<CatchClause>(tryStatement.CatchClauses.Count);
                    foreach (CatchClause catchClause in tryStatement.CatchClauses)
                    {
                        catchClauses.Add(new CatchClause(
                            catchClause.VariableName,
                            catchClause.ExceptionType,
                            (BlockStatement)this.RewriteOwnLoopContinue(forStatement, catchClause.Body, incrementorStatements)));
                    }

                    return new TryStatement(
                        (BlockStatement)this.RewriteOwnLoopContinue(forStatement, tryStatement.TryBlock, incrementorStatements),
                        catchClauses,
                        tryStatement.FinallyBlock);
                }

                case SwitchStatement switchStatement:
                {
                    var cases = new List<SwitchStatementCase>(switchStatement.Cases.Count);
                    foreach (SwitchStatementCase switchCase in switchStatement.Cases)
                    {
                        cases.Add(new SwitchStatementCase(
                            switchCase.Pattern,
                            (BlockStatement)this.RewriteOwnLoopContinue(forStatement, switchCase.Body, incrementorStatements),
                            switchCase.Guard));
                    }

                    return new SwitchStatement(switchStatement.Subject, cases);
                }

                case FixedStatement fixedStatement:
                {
                    return new FixedStatement(
                        fixedStatement.Name,
                        fixedStatement.PointerType,
                        fixedStatement.Source,
                        (BlockStatement)this.RewriteOwnLoopContinue(forStatement, fixedStatement.Body, incrementorStatements));
                }

                // Boundaries: a nested loop's own continue seam, or a nested
                // local function (its own statement seam) — never descend.
                case WhileStatement:
                case ForStatement:
                case DoWhileStatement:
                case ForInStatement:
                case LocalFunctionStatement:
                    return statement;

                default:
                    // Any other body-carrying G# statement kind that reaches
                    // here was missed by the cases above. Silently returning
                    // it unchanged would let an own-loop `continue` buried
                    // inside it skip the duplicated incrementors — the same
                    // silent miscompile this rewrite exists to fix (issue
                    // #1732). Report it instead of guessing a lowering.
                    if (ContainsOwnLoopContinue(statement))
                    {
                        this.context.ReportUnsupported(
                            forStatement,
                            $"a 'continue' inside a '{statement.GetType().Name}' within this 'for' loop has no incrementor-duplication lowering yet (issue #1732).");
                    }

                    return statement;
            }
        }

        private bool IsLocalReassigned(ILocalSymbol local)
        {
            // A local is mutable in G# (`var`) when it is assigned, incremented,
            // decremented, OR passed by `ref`/`out` (which cs2gs renders as an
            // address-of `&arg`): taking the address of an immutable `let` is
            // rejected by gsc with GS9005 ("Cannot take address of constant").
            // Delegate to the general symbol walk, which already covers the
            // `ref`/`out` argument case, so both paths stay consistent.
            return this.IsSymbolReassigned(local, this.currentBodyScope);
        }

        private bool BindsTo(ExpressionSyntax expression, ISymbol target)
        {
            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            return symbol != null && SymbolEqualityComparer.Default.Equals(symbol, target);
        }

        // Returns true when <paramref name="symbol"/> is assigned, incremented,
        // decremented, or passed by ref/out anywhere in <paramref name="scope"/>.
        // Generalises <see cref="IsLocalReassigned"/> to any symbol (used for
        // value parameters, which are read-only in G#).
        private bool IsSymbolReassigned(ISymbol symbol, SyntaxNode scope)
        {
            if (scope == null)
            {
                return false;
            }

            foreach (SyntaxNode node in scope.DescendantNodes())
            {
                switch (node)
                {
                    case AssignmentExpressionSyntax assignment
                        when this.BindsTo(assignment.Left, symbol):
                        return true;

                    case PostfixUnaryExpressionSyntax postfix
                        when (postfix.IsKind(SyntaxKind.PostIncrementExpression)
                                || postfix.IsKind(SyntaxKind.PostDecrementExpression))
                            && this.BindsTo(postfix.Operand, symbol):
                        return true;

                    case PrefixUnaryExpressionSyntax prefix
                        when (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                                || prefix.IsKind(SyntaxKind.PreDecrementExpression))
                            && this.BindsTo(prefix.Operand, symbol):
                        return true;

                    case ArgumentSyntax argument
                        when !argument.RefOrOutKeyword.IsKind(SyntaxKind.None)
                            && this.BindsTo(argument.Expression, symbol):
                        return true;

                    case PrefixUnaryExpressionSyntax addressOf
                        when addressOf.IsKind(SyntaxKind.AddressOfExpression)
                            && this.BindsTo(addressOf.Operand, symbol):
                        return true;
                }
            }

            return false;
        }

        // Issue #1072: G# follows Kotlin-style nullability, so `nil`-safety is
        // enforced by the static type, not by a `!!`-on-`nil` escape hatch. A C#
        // symbol DECLARED non-nullable (`T`) but defensively compared against
        // `null` (`== null` / `!= null`) or assigned `null` / `null!` is, in
        // truth, nullable: faithfully it must render `T?` so the `== nil`/`!= nil`
        // guard type-checks (gsc only permits `== nil` on a nullable operand,
        // otherwise GS0129). Returns true when <paramref name="symbol"/> is used
        // that way anywhere in <paramref name="scope"/>.
        private bool IsUsedAsNullable(ISymbol symbol, SyntaxNode scope)
        {
            if (symbol == null || scope == null)
            {
                return false;
            }

            // The scope is scanned with the current document's semantic model, so a
            // node from another syntax tree (e.g. an inherited field declared in a
            // different file) cannot be queried here — `GetSymbolInfo` would throw
            // "Syntax node is not within syntax tree". Such a symbol is promoted (if
            // applicable) while its own document is translated; skip it here.
            if (scope.SyntaxTree != this.context.SemanticModel.SyntaxTree)
            {
                return false;
            }

            foreach (SyntaxNode node in scope.DescendantNodes())
            {
                switch (node)
                {
                    case BinaryExpressionSyntax binary
                        when binary.IsKind(SyntaxKind.EqualsExpression)
                            || binary.IsKind(SyntaxKind.NotEqualsExpression):
                        if ((IsNullLiteral(binary.Right) && this.BindsTo(binary.Left, symbol))
                            || (IsNullLiteral(binary.Left) && this.BindsTo(binary.Right, symbol)))
                        {
                            return true;
                        }

                        break;

                    case AssignmentExpressionSyntax assignment
                        when assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                            && this.BindsTo(assignment.Left, symbol)
                            && IsNullOrSuppressedNull(assignment.Right):
                        return true;

                    case IsPatternExpressionSyntax isPattern
                        when this.BindsTo(isPattern.Expression, symbol)
                            && IsNullConstantPattern(isPattern.Pattern):
                        return true;

                    case VariableDeclaratorSyntax declarator
                        when declarator.Initializer != null
                            && IsNullOrSuppressedNull(declarator.Initializer.Value)
                            && SymbolEqualityComparer.Default.Equals(
                                this.context.GetDeclaredSymbol(declarator), symbol):
                        return true;
                }
            }

            return false;
        }

        // Promotes <paramref name="type"/> to its nullable (`T?`) form when the
        // symbol it renders is declared as a non-nullable reference/array type yet
        // is used as nullable in its scope (issue #1072). Value types and
        // already-nullable types are left untouched: this pass only covers
        // reference-type/array null-comparison and null-assignment.
        // True for a `T?`-annotated reference type, array, or (interface/
        // unconstrained) type parameter — the forms whose `?` the G# type mapper
        // preserves and which inference over a non-null initializer would drop.
        private static bool IsAnnotatedNullableReference(ITypeSymbol type) =>
            type is { NullableAnnotation: NullableAnnotation.Annotated }
                && (type.IsReferenceType || type is ITypeParameterSymbol);

        private GTypeReference PromoteIfUsedAsNullable(GTypeReference type, ISymbol symbol)
        {
            if (type == null || type.IsNullable)
            {
                return type;
            }

            return this.IsPromotedToNullableReference(symbol) ? MakeNullable(type) : type;
        }

        // Issue #1072 (field/property initializer form): when a field or property is
        // emitted with an explicit declared type plus an initializer whose
        // Roslyn-inferred type is nullable (e.g. the value comes from a `?.`
        // conditional access or a method returning `T?`), widen the emitted declared
        // type to `T?`. Otherwise gsc rejects the initializer with
        // `GS0156: Cannot convert type 'T?' to 'T'`. We always key off the Roslyn
        // `TypeInfo` of the FULL initializer expression (so a `?? nonNullFallback`
        // that Roslyn proves non-null stays `T`). Value types and already-nullable
        // declared types are left untouched.
        private GTypeReference PromoteIfInitializerNullable(
            GTypeReference type,
            ITypeSymbol declaredType,
            ExpressionSyntax initializer)
        {
            if (type == null || type.IsNullable || initializer == null)
            {
                return type;
            }

            if (declaredType is not { IsReferenceType: true }
                || declaredType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return type;
            }

            return this.IsNullableInitializer(initializer) ? MakeNullable(type) : type;
        }

        // Determines whether <paramref name="expression"/> (a field/property
        // initializer) yields a nullable reference value. Because the migrated
        // corpus typically compiles with the nullable context DISABLED, flow
        // nullability is unavailable, so this combines (a) syntactic forms that
        // introduce null (`a?.b`, `a ?? nullableFallback`, `cond ? a : b`) with
        // (b) the bound symbol's DECLARED nullable annotation, which survives in
        // BCL/source metadata regardless of the consuming nullable context
        // (e.g. `AssemblyName.Name` and `Path.GetFileNameWithoutExtension(...)`
        // are declared `string?`). `x!` suppresses nullability.
        private bool IsNullableInitializer(ExpressionSyntax expression)
        {
            if (expression == null)
            {
                return false;
            }

            switch (expression)
            {
                case ParenthesizedExpressionSyntax paren:
                    return this.IsNullableInitializer(paren.Expression);

                case PostfixUnaryExpressionSyntax suppress
                    when suppress.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    return false;

                // `a?.b` / `a?[i]`: conditional access yields a nullable result.
                case ConditionalAccessExpressionSyntax:
                    return true;

                // `a ?? b`: nullable iff the `b` fallback is itself nullable.
                case BinaryExpressionSyntax coalesce
                    when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                    return this.IsNullableInitializer(coalesce.Right);

                // `cond ? a : b`: nullable iff either branch is nullable.
                case ConditionalExpressionSyntax ternary:
                    return this.IsNullableInitializer(ternary.WhenTrue)
                        || this.IsNullableInitializer(ternary.WhenFalse);
            }

            // Flow nullability when the nullable context happens to be enabled.
            TypeInfo info = this.context.GetTypeInfo(expression);
            if (info.Nullability.Annotation == NullableAnnotation.Annotated)
            {
                return true;
            }

            // Otherwise consult the bound symbol's declared annotation.
            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            ITypeSymbol symbolType = symbol switch
            {
                IMethodSymbol m => m.ReturnType,
                IPropertySymbol p => p.Type,
                IFieldSymbol f => f.Type,
                ILocalSymbol l => l.Type,
                IParameterSymbol pr => pr.Type,
                _ => null,
            };

            return symbolType is { IsReferenceType: true }
                && symbolType.NullableAnnotation == NullableAnnotation.Annotated;
        }

        // Issue #1072: true when <paramref name="symbol"/> is a parameter/field/local
        // whose DECLARED type is a non-nullable reference (or array) but which is
        // null-checked or null-assigned in its scope, so the translator renders it
        // `T?`. This is the single source of truth shared by the type-rendering paths
        // (param/field/local) and the `!!` non-null-assertion pass
        // (<see cref="ReceiverNeedsNullForgiveness"/>) so a promoted receiver still
        // gets its flow-proven `recv!!.Member` assertion.
        private bool IsPromotedToNullableReference(ISymbol symbol)
        {
            ITypeSymbol declared = symbol switch
            {
                IFieldSymbol f => f.Type,
                IPropertySymbol pr => pr.Type,
                ILocalSymbol l => l.Type,
                IParameterSymbol p => p.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true }
                || declared.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            // A function-type (delegate) parameter with an explicit `= null`
            // default is nullable by construction: a non-nullable function type
            // cannot carry a `nil` default at all (gsc GS0265 at the declaration
            // itself), so it must render `((…) -> R)?`. This is scoped to delegate
            // types because promoting arbitrary reference parameters cascades
            // nullable-mismatch errors (GS0156) at pass-through call sites that
            // would each need their own flow-driven promotion.
            if (symbol is IParameterSymbol { HasExplicitDefaultValue: true } defaulted
                && defaulted.ExplicitDefaultValue is null
                && defaulted.Type.TypeKind == TypeKind.Delegate)
            {
                return true;
            }

            return this.IsUsedAsNullable(symbol, this.GetNullabilityScope(symbol));
        }

        // The syntax region a symbol's null usage is searched in: the whole
        // enclosing method for a parameter, the whole declaring type for a field,
        // and the enclosing method body block for a local.
        private SyntaxNode GetNullabilityScope(ISymbol symbol)
        {
            switch (symbol)
            {
                case IParameterSymbol parameter:
                    return parameter.ContainingSymbol?
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

                case IFieldSymbol field:
                    return field.ContainingType?
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

                case IPropertySymbol property:
                    return property.ContainingType?
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

                case ILocalSymbol local:
                    SyntaxNode declaration = local
                        .DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
                    return declaration?.Ancestors().LastOrDefault(a => a is BlockSyntax);

                default:
                    return null;
            }
        }

        // `x is null` / `x is not null` constant pattern (the C# pattern form of a
        // null comparison, which the translator lowers to `== nil` / `!= nil`).
        private static bool IsNullConstantPattern(PatternSyntax pattern)
        {
            if (pattern is UnaryPatternSyntax unary && unary.IsKind(SyntaxKind.NotPattern))
            {
                pattern = unary.Pattern;
            }

            return pattern is ConstantPatternSyntax constant && IsNullLiteral(constant.Expression);
        }

        private static bool IsNullLiteral(ExpressionSyntax expression) =>
            expression is LiteralExpressionSyntax literal
                && literal.IsKind(SyntaxKind.NullLiteralExpression);

        // `null` or `null!` (a SuppressNullableWarning over a null literal).
        private static bool IsNullOrSuppressedNull(ExpressionSyntax expression)
        {
            if (expression is PostfixUnaryExpressionSyntax suppress
                && suppress.IsKind(SyntaxKind.SuppressNullableWarningExpression))
            {
                expression = suppress.Operand;
            }

            return IsNullLiteral(expression);
        }

        private GExpression TranslateExpression(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case LiteralExpressionSyntax literal:
                    return this.TranslateLiteral(literal);

                case IdentifierNameSyntax identifier:
                    return this.TranslateIdentifierName(identifier);

                case GenericNameSyntax generic:
                    // A generic name used as an expression is most often a generic
                    // *method* group (`Method<T>(...)`), whose bracket type arguments
                    // are applied by the enclosing invocation — there the bare
                    // identifier is correct. But it can also be a constructed generic
                    // *type* used as the receiver of a static member access
                    // (`Mp4Operation<ChapterInfo?>.FromCompleted(...)`); dropping the
                    // type arguments there picks the wrong (non-generic) overload
                    // (GS0144). Render the type with its arguments as `T[args]` so the
                    // static member resolves on the constructed generic type.
                    if (this.context.GetSymbolInfo(generic).Symbol is INamedTypeSymbol genericType)
                    {
                        GTypeReference typeRef = this.typeMapper.Map(
                            genericType, this.context, generic.GetLocation());
                        return new TypeExpression(typeRef);
                    }

                    return new IdentifierExpression(SanitizeIdentifier(generic.Identifier.Text));

                case ThisExpressionSyntax:
                    return new ThisExpression();

                case BaseExpressionSyntax:
                    // Issue #986: C# `base.M(...)` maps directly to the G#
                    // base-class call form `base.M(...)`, which emits a
                    // non-virtual `call` into the base implementation. The
                    // `base` receiver is rendered as a bare identifier; the
                    // enclosing member-access / invocation supplies the `.M(...)`.
                    return new IdentifierExpression("base");

                case MemberAccessExpressionSyntax member:
                    return this.TranslateMemberAccess(member);

                case InvocationExpressionSyntax invocation:
                    return this.TranslateInvocation(invocation);

                case ObjectCreationExpressionSyntax creation:
                    return this.TranslateObjectCreation(creation);

                case CastExpressionSyntax cast:
                    return this.TranslateCast(cast);

                case WithExpressionSyntax with:
                    return this.TranslateWith(with);

                case BinaryExpressionSyntax binary
                    when binary.IsKind(SyntaxKind.AsExpression) || binary.IsKind(SyntaxKind.IsExpression):
                    // `e as T` / `e is T`: the right operand is a type. Render it as
                    // a type expression so array/qualified types map to canonical G#
                    // (e.g. `o as []object`, `o is []object`).
                    return new BinaryExpression(
                        this.TranslateExpression(binary.Left),
                        binary.OperatorToken.Text,
                        new TypeExpression(binary.Right is TypeSyntax typeOperand
                            ? this.MapTypeSyntax(typeOperand)
                            : new NamedTypeReference(binary.Right.ToString())));

                case BinaryExpressionSyntax binary:
                    // Issue #941: C# null-coalescing `a ?? b` now maps directly to
                    // G#'s `a ?? b` (the operator token text is identical), so it
                    // flows through the generic binary translation below.
                    return this.TranslateBinaryExpression(binary);

                case PrefixUnaryExpressionSyntax prefix:
                    // G# uses the Go-style `^` for bitwise complement; C# spells it
                    // `~`. Every other prefix operator token is identical.
                    string prefixOp = prefix.IsKind(SyntaxKind.BitwiseNotExpression)
                        ? "^"
                        : prefix.OperatorToken.Text;
                    return new UnaryExpression(
                        prefixOp,
                        this.TranslateExpression(prefix.Operand));

                case ParenthesizedExpressionSyntax parenthesized:
                    return new ParenthesizedExpression(this.TranslateExpression(parenthesized.Expression));

                case InterpolatedStringExpressionSyntax interpolated:
                    return this.TranslateInterpolatedString(interpolated);

                case TupleExpressionSyntax tuple:
                    return new TupleLiteralExpression(
                        tuple.Arguments.Select(a => this.TranslateValueWithNullForgiveness(a.Expression)).ToList());

                case ElementAccessExpressionSyntax elementAccess:
                    if (elementAccess.ArgumentList.Arguments.Count == 1 &&
                        elementAccess.ArgumentList.Arguments[0].Expression is RangeExpressionSyntax sliceRange)
                    {
                        // `span[a..b]` / `span[..n]` / `span[i..]`: G# has no range
                        // operator, so lower the System.Range indexer to the
                        // faithful `Slice(start, length)` / `Slice(start)` call the
                        // C# range indexer itself lowers to (ADR-0115 §B).
                        return this.TranslateRangeSlice(
                            this.TranslateReceiverWithNullForgiveness(elementAccess.Expression),
                            sliceRange);
                    }

                    GExpression index = elementAccess.ArgumentList.Arguments.Count > 0
                        ? this.CoerceIndexToInt32(
                            elementAccess,
                            this.TranslateExpression(elementAccess.ArgumentList.Arguments[0].Expression))
                        : new IdentifierExpression("nil");
                    return new IndexExpression(
                        this.TranslateReceiverWithNullForgiveness(elementAccess.Expression),
                        index);

                case SimpleLambdaExpressionSyntax simpleLambda:
                    return this.TranslateLambda(simpleLambda);

                case ParenthesizedLambdaExpressionSyntax parenLambda:
                    return this.TranslateLambda(parenLambda);

                case AwaitExpressionSyntax awaitExpression:
                    return new AwaitExpression(this.TranslateExpression(awaitExpression.Expression));

                case SwitchExpressionSyntax switchExpression:
                    return this.TranslateSwitchExpression(switchExpression);

                case ConditionalExpressionSyntax conditional:
                    // A C# ternary `cond ? a : b` maps to the canonical G#
                    // value-position `if` expression `if cond { a } else { b }`
                    // (ADR-0064, sample IfExpression.gs; ADR-0115 §B).
                    return this.TranslateConditionalExpression(conditional);

                case QueryExpressionSyntax query:
                    return this.TranslateQuery(query);

                case ImplicitObjectCreationExpressionSyntax implicitCreation:
                    return this.TranslateImplicitObjectCreation(implicitCreation);

                case PredefinedTypeSyntax predefinedType:
                    return this.TranslatePredefinedTypeExpression(predefinedType);

                case ConditionalAccessExpressionSyntax conditionalAccess:
                    if (this.TryTranslateNullConditionalEnumExtension(conditionalAccess, out GExpression enumExtResult))
                    {
                        return enumExtResult;
                    }

                    return new ConditionalAccessExpression(
                        this.TranslateExpression(conditionalAccess.Expression),
                        this.TranslateExpression(conditionalAccess.WhenNotNull));

                case MemberBindingExpressionSyntax memberBinding:
                    // The `.b` continuation of a null-conditional chain. Its
                    // receiver is the empty conditional-receiver placeholder, so it
                    // renders as the bare `.b` that follows the `?`.
                    return new MemberAccessExpression(
                        new ConditionalReceiverExpression(),
                        SanitizeIdentifier(memberBinding.Name.Identifier.Text));

                case ElementBindingExpressionSyntax elementBinding:
                    GExpression bindingIndex = elementBinding.ArgumentList.Arguments.Count > 0
                        ? this.TranslateExpression(elementBinding.ArgumentList.Arguments[0].Expression)
                        : new IdentifierExpression("nil");
                    return new IndexExpression(new ConditionalReceiverExpression(), bindingIndex);

                case TypeOfExpressionSyntax typeOf:
                    return new TypeOfExpression(this.MapTypeOfOperand(typeOf.Type));

                case DefaultExpressionSyntax explicitDefault:
                    return new DefaultValueExpression(this.MapTypeSyntax(explicitDefault.Type));

                case IsPatternExpressionSyntax isPattern:
                    return this.TranslateIsPattern(isPattern);

                case ArrayCreationExpressionSyntax arrayCreation:
                    return this.TranslateArrayCreation(arrayCreation);

                case ImplicitArrayCreationExpressionSyntax implicitArray:
                    return this.TranslateImplicitArrayCreation(implicitArray);

                case InitializerExpressionSyntax initializer:
                    return this.TranslateInitializerExpression(initializer);

                case SizeOfExpressionSyntax sizeOf:
                    return this.TranslateSizeOf(sizeOf);

                case AliasQualifiedNameSyntax aliasQualified:
                    // `global::System` → drop the `global::` alias and keep the name.
                    return new IdentifierExpression(aliasQualified.Name.Identifier.Text);

                case AssignmentExpressionSyntax nestedAssignment:
                    // An assignment used in value position (`a = b = c`, `M(x =
                    // 5)`, `while ((line = r.ReadLine()) != null)`). G# models
                    // assignment as a statement, not a value-yielding expression.
                    // The enclosing statement/condition seam (WithHoistedAssignments
                    // / TranslateConditionWithHoist / HoistLoopConditionClause)
                    // hoists the write into a preceding assignment statement and
                    // marks this node suppressed; reading it here means the write
                    // already happened, so the expression's value is just the
                    // (now up-to-date) target (issue #1723).
                    if (this.suppressedAssignments.Contains(nestedAssignment))
                    {
                        return this.TranslateExpression(nestedAssignment.Left);
                    }

                    // No enclosing seam claimed this node (e.g. it lives inside a
                    // short-circuited `&&`/`||` operand or a `?:` branch, already
                    // flagged unsupported at the point of detection): fall back to
                    // the RHS value so translation still completes.
                    return this.TranslateExpression(nestedAssignment.Right);

                case ThrowExpressionSyntax throwExpression:
                    // `a ?? throw e`, `cond ? a : throw e`, a `switch` arm value.
                    // G# supports throw-as-expression natively (issue #1153);
                    // map it directly to a G# throw-expression.
                    return new ThrowExpression(
                        this.TranslateExpression(throwExpression.Expression),
                        this.ResolveExpressionType(throwExpression));

                case PostfixUnaryExpressionSyntax suppressNullable
                    when suppressNullable.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    // The C# null-forgiving operator `expr!` maps to G#'s postfix
                    // non-null assertion `expr!!` (spec: "Postfix `!!` asserts
                    // non-null"), preserving the assertion (ADR-0115 §B).
                    //
                    // Exception: the C# null-forgiving null literal `null!` (used to
                    // pass null where a non-nullable reference is expected, e.g.
                    // `: base(header, null!)`). G# follows Kotlin-style nullability
                    // and rejects `nil!!` — the assertion keeps the operand's type
                    // `nil`, so it cannot satisfy a non-nullable target (GS0154 /
                    // GS0155 / a misleading GS0214 in base-initializer position,
                    // issue #1072). Emit `default(T)` for the expected (converted)
                    // type instead: this is null at runtime — behaviourally
                    // identical to C#'s `null!` — and is a native, non-nullable G#
                    // value (#914, #1072).
                    if (suppressNullable.Operand.IsKind(SyntaxKind.NullLiteralExpression))
                    {
                        return new DefaultValueExpression(this.ResolveExpressionType(suppressNullable));
                    }

                    return new NonNullAssertionExpression(
                        this.TranslateExpression(suppressNullable.Operand));

                case PostfixUnaryExpressionSyntax postfixValue
                    when postfixValue.IsKind(SyntaxKind.PostIncrementExpression)
                        || postfixValue.IsKind(SyntaxKind.PostDecrementExpression):
                    // A post-increment/decrement used in value position. When the
                    // enclosing statement seam already hoisted the mutation into a
                    // trailing statement, the node is suppressed here and reads as
                    // its pre-increment value (ADR-0115 §B).
                    if (this.suppressedPostfix.Contains(postfixValue))
                    {
                        return this.TranslateExpression(postfixValue.Operand);
                    }

                    // gsc issue #1027: G# now models inc/dec as value-producing
                    // expressions, so a postfix in a position with no statement seam
                    // (e.g. inside a short-circuit `&&` condition) emits the faithful
                    // inline `x++` / `x--` form.
                    return new IncrementDecrementExpression(
                        this.TranslateExpression(postfixValue.Operand),
                        postfixValue.OperatorToken.Text,
                        isPrefix: false);

                case StackAllocArrayCreationExpressionSyntax stackAlloc:
                    return this.TranslateStackAlloc(stackAlloc);

                case CollectionExpressionSyntax collectionExpression:
                    return this.TranslateCollectionExpression(collectionExpression);

                default:
                    this.context.ReportUnsupported(
                        expression,
                        $"expression '{expression.Kind()}' has no canonical G# form yet; emitted an identifier placeholder (ADR-0115 §B).");
                    return new IdentifierExpression("nil");
            }
        }

        // A constant pattern whose expression is actually a bare/qualified TYPE
        // reference (Roslyn parses `is T`/`not T` after a pattern combinator as a
        // ConstantPattern over an identifier, since it cannot tell at parse time
        // that the identifier names a type). Such a pattern is a type test, not an
        // equality, so it must lower to `x is T` rather than `x == T`.
        private bool IsTypeReferencePattern(ExpressionSyntax expression) =>
            expression is TypeSyntax
            && this.context.GetSymbolInfo(expression).Symbol is ITypeSymbol;

        private GExpression TranslateIsPattern(IsPatternExpressionSyntax isPattern)
        {
            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            ITypeSymbol receiverType = this.context.GetTypeInfo(isPattern.Expression).Type;

            // A pattern that binds a designation, or tests more than one
            // sub-pattern, reads the translated scrutinee more than once:
            // `BuildPatternNarrowingReplacement` substitutes it at every binder
            // reference, a recursive/property pattern re-embeds it per member
            // test, and `and`/`or`/parenthesized combinators re-embed it per
            // branch. A non-trivial scrutinee (anything beyond a bare
            // identifier/`this`/literal — e.g. a method call or a property read
            // with a side effect) must then be evaluated exactly once into a
            // local and reused, matching C# semantics (issue #1731). A pattern
            // that reads the scrutinee at most once (a bare type test, a
            // constant/relational pattern) is left untouched, avoiding an
            // unnecessary temp. Some shapes (a single escaping/non-smart-
            // castable declaration pattern over a reference type) are already
            // hoisted more precisely by <see cref="TryBuildPositiveGuardHoist"/>/
            // <see cref="TryBuildNegatedGuardHoist"/> before reaching here — for
            // those, `receiver` is already a bare local and this is a no-op.
            if (!PatternReadsScrutineeAtMostOnce(isPattern.Pattern))
            {
                receiver = this.SpillOperand(receiver, isPattern.Expression);
            }

            return this.TranslatePatternTest(receiver, isPattern.Pattern, receiverType, isPattern.Expression);
        }

        // See <see cref="TranslateIsPattern"/>: true when translating `pattern`
        // against its scrutinee embeds the scrutinee at MOST one time, so no
        // spill is needed regardless of whether the scrutinee is trivial.
        private static bool PatternReadsScrutineeAtMostOnce(PatternSyntax pattern) =>
            pattern switch
            {
                // `x is null` / `x is 0` / `x is > 0`: a single equality/relational
                // test against the receiver, no designation possible.
                ConstantPatternSyntax => true,
                RelationalPatternSyntax => true,

                // `x is not P` / `(P)`: reads the receiver exactly as many times as
                // the inner pattern does.
                UnaryPatternSyntax unary => PatternReadsScrutineeAtMostOnce(unary.Pattern),
                ParenthesizedPatternSyntax parenthesized => PatternReadsScrutineeAtMostOnce(parenthesized.Pattern),

                // `x is T t`: always binds a designation, narrowing-replacing the
                // receiver at every later reference to `t` — more than one read
                // whenever `t` is actually used.
                DeclarationPatternSyntax => false,

                // `x is Circle` (no designation/subpatterns) reads the receiver
                // once; `x is Circle c`, `x is { X: 1 }`, or `x is Circle(1, 2)`
                // each read it more than once (a designation narrowing-replaces
                // it, and each property/positional subpattern re-embeds it).
                RecursivePatternSyntax recursive =>
                    recursive.Designation == null
                    && recursive.PropertyPatternClause == null
                    && recursive.PositionalPatternClause == null,

                // `x is var v`: always binds a designation.
                VarPatternSyntax => false,

                // `x is A or B` / `x is A and B`: the receiver is re-embedded once
                // per branch.
                BinaryPatternSyntax => false,

                _ => false,
            };

        private GExpression TranslatePatternTest(
            GExpression receiver, PatternSyntax pattern, ITypeSymbol receiverType = null, ExpressionSyntax receiverSyntax = null)
        {
            switch (pattern)
            {
                case ConstantPatternSyntax constant
                    when constant.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                    // `x is null` → `x == nil`.
                    return new BinaryExpression(receiver, "==", LiteralExpression.Null());

                case ConstantPatternSyntax constant
                    when this.IsTypeReferencePattern(constant.Expression):
                    // Roslyn parses `x is T` where `T` is a bare type name after a
                    // combinator (e.g. `is Frame child and not EmptyFrame`) as a
                    // ConstantPattern over an identifier — but the identifier binds
                    // to a TYPE, so it is a type test, not an equality. `x is T`.
                    return new BinaryExpression(
                        receiver,
                        "is",
                        new TypeExpression(this.MapTypeSyntax((TypeSyntax)constant.Expression)));

                case ConstantPatternSyntax constant:
                    // `x is 0` / `x is "moov"` / `x is true`. G# `is` only tests a
                    // type, so a constant pattern lowers to an equality test
                    // (ADR-0115 §B). A numeric literal is retyped to the receiver's
                    // type so `uint8? is 11` → `b == (11 as uint8?)` (G# has no
                    // implicit numeric promotion: a bare `b == 11` is GS0129).
                    return new BinaryExpression(
                        receiver,
                        "==",
                        this.CoercePatternConstant(
                            constant.Expression,
                            this.TranslateExpression(constant.Expression),
                            receiverType));

                case RelationalPatternSyntax relational:
                    // `x is > 0` → `x > 0` (with the same numeric retyping).
                    return new BinaryExpression(
                        receiver,
                        relational.OperatorToken.Text,
                        this.CoercePatternConstant(
                            relational.Expression,
                            this.TranslateExpression(relational.Expression),
                            receiverType));

                case DeclarationPatternSyntax declaration:
                    // `x is T t` → the boolean test `x is T`; the binder `t` is a
                    // Kotlin-style smart cast of `x` inside the guarded block, so
                    // references to `t` are rewritten to the narrowed `x` (ADR-0069).
                    if (declaration.Designation is SingleVariableDesignationSyntax single &&
                        this.context.GetDeclaredSymbol(single) is { } boundSymbol)
                    {
                        this.patternBindings[boundSymbol] =
                            this.BuildPatternNarrowingReplacement(receiver, receiverSyntax, declaration.Type);
                    }

                    return new BinaryExpression(
                        receiver,
                        "is",
                        new TypeExpression(this.MapTypeSyntax(declaration.Type)));

                case TypePatternSyntax typePattern:
                    // `x is T` (no binder) → boolean test `x is T`.
                    return new BinaryExpression(
                        receiver,
                        "is",
                        new TypeExpression(this.MapTypeSyntax(typePattern.Type)));

                case RecursivePatternSyntax recursive:
                    return this.TranslateRecursivePatternTest(receiver, recursive, receiverSyntax);

                case UnaryPatternSyntax unary when unary.IsKind(SyntaxKind.NotPattern):
                    return this.TranslateNotPatternTest(receiver, unary.Pattern, receiverType);

                case BinaryPatternSyntax binaryPattern
                    when binaryPattern.OperatorToken.IsKind(SyntaxKind.OrKeyword)
                        || binaryPattern.OperatorToken.IsKind(SyntaxKind.AndKeyword):
                    // `x is 11 or 12` → `x == 11 || x == 12`;
                    // `x is A and B` → `(x is A) && (x is B)`.
                    bool isOr = binaryPattern.OperatorToken.IsKind(SyntaxKind.OrKeyword);
                    return new BinaryExpression(
                        this.TranslatePatternTest(receiver, binaryPattern.Left, receiverType, receiverSyntax),
                        isOr ? "||" : "&&",
                        this.TranslatePatternTest(receiver, binaryPattern.Right, receiverType, receiverSyntax));

                case ParenthesizedPatternSyntax parenthesized:
                    return new ParenthesizedExpression(
                        this.TranslatePatternTest(receiver, parenthesized.Pattern, receiverType, receiverSyntax));

                default:
                    this.context.ReportUnsupported(
                        pattern,
                        $"is-pattern '{pattern.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                    return new BinaryExpression(receiver, "!=", LiteralExpression.Null());
            }
        }

        private GExpression TranslateNotPatternTest(
            GExpression receiver, PatternSyntax inner, ITypeSymbol receiverType = null)
        {
            switch (inner)
            {
                case ConstantPatternSyntax constant
                    when constant.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                    // `x is not null` → `x != nil`.
                    return new BinaryExpression(receiver, "!=", LiteralExpression.Null());

                case ConstantPatternSyntax constant
                    when this.IsTypeReferencePattern(constant.Expression):
                    // `x is not T` where Roslyn parsed `T` as a ConstantPattern
                    // identifier that binds to a TYPE → `!(x is T)`.
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(new BinaryExpression(
                            receiver,
                            "is",
                            new TypeExpression(this.MapTypeSyntax((TypeSyntax)constant.Expression)))));

                case ConstantPatternSyntax constant:
                    // `x is not 6` → `x != 6` (with numeric retyping to the receiver).
                    return new BinaryExpression(
                        receiver,
                        "!=",
                        this.CoercePatternConstant(
                            constant.Expression,
                            this.TranslateExpression(constant.Expression),
                            receiverType));

                case RecursivePatternSyntax { Type: null } emptyRecursive
                    when emptyRecursive.PropertyPatternClause is null or { Subpatterns.Count: 0 }:
                    // `x is not { } d` → `x == nil`; the designator `d` is the
                    // non-null view (used on the matched side), bound to `x`.
                    BindPatternDesignation(emptyRecursive.Designation, receiver);
                    return new BinaryExpression(receiver, "==", LiteralExpression.Null());

                case TypePatternSyntax typePattern:
                    // `x is not T` → `!(x is T)`.
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(new BinaryExpression(
                            receiver,
                            "is",
                            new TypeExpression(this.MapTypeSyntax(typePattern.Type)))));

                case DeclarationPatternSyntax declaration:
                    // `x is not T t` → `!(x is T)`; `t` is the non-null `T` view,
                    // bound to `x` for use on the matched side.
                    BindPatternDesignation(declaration.Designation, receiver);
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(new BinaryExpression(
                            receiver,
                            "is",
                            new TypeExpression(this.MapTypeSyntax(declaration.Type)))));

                default:
                    // General negation: `!( <inner test> )`.
                    return new UnaryExpression(
                        "!",
                        new ParenthesizedExpression(
                            this.TranslatePatternTest(receiver, inner, receiverType)));
            }
        }

        // Retypes a constant/relational pattern's literal operand to the receiver's
        // numeric type so the lowered `==`/`!=`/`<`… comparison type-checks. G# has
        // no implicit numeric promotion, so `uint8? is 11` lowered to `b == 11`
        // (where `11` is `int32`) is GS0129; coercing the literal yields the
        // accepted `b == (11 as uint8?)`. Mirrors the constant branch of
        // <see cref="TranslateBinaryExpression"/>. Non-numeric receivers/literals
        // (string/enum/type tests) are left untouched.
        private GExpression CoercePatternConstant(
            ExpressionSyntax constantSyntax, GExpression constant, ITypeSymbol receiverType)
        {
            if (receiverType == null)
            {
                return constant;
            }

            ITypeSymbol constantType = this.context.GetTypeInfo(constantSyntax).Type;
            if (TryGetNumericKind(receiverType, out SpecialType receiverUnderlying) &&
                TryGetNumericKind(constantType, out SpecialType constantUnderlying) &&
                receiverUnderlying != constantUnderlying &&
                this.context.SemanticModel.GetConstantValue(constantSyntax).HasValue)
            {
                return this.CoerceOperandTo(constant, receiverType);
            }

            return constant;
        }

        private GExpression TranslateRecursivePatternTest(
            GExpression receiver, RecursivePatternSyntax recursive, ExpressionSyntax receiverSyntax = null)
        {
            // Bind the designator (`is { } x`, `is Circle c`) to the narrowed
            // receiver so later references read the matched value (ADR-0069 smart
            // cast). `is { } x` narrows away only nullability; `is Circle c`
            // additionally downcasts.
            if (recursive.Designation is SingleVariableDesignationSyntax recVar &&
                this.context.GetDeclaredSymbol(recVar) is { } recBound)
            {
                this.patternBindings[recBound] =
                    this.BuildPatternNarrowingReplacement(receiver, receiverSyntax, recursive.Type);
            }

            GExpression test = recursive.Type != null
                ? new BinaryExpression(receiver, "is", new TypeExpression(this.MapTypeSyntax(recursive.Type)))
                : new BinaryExpression(receiver, "!=", LiteralExpression.Null());

            if (recursive.PropertyPatternClause != null)
            {
                foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
                {
                    if (sub.NameColon == null && sub.ExpressionColon == null)
                    {
                        this.context.ReportUnsupported(sub, "positional subpattern has no canonical G# form yet (ADR-0115 §B).");
                        continue;
                    }

                    string memberName = sub.NameColon?.Name.Identifier.Text
                        ?? sub.ExpressionColon?.Expression.ToString();
                    GExpression memberAccess = new MemberAccessExpression(receiver, SanitizeIdentifier(memberName));
                    test = new BinaryExpression(test, "&&", this.TranslatePatternTest(memberAccess, sub.Pattern));
                }
            }

            return test;
        }

        private void BindPatternDesignation(VariableDesignationSyntax designation, GExpression receiver)
        {
            if (designation is SingleVariableDesignationSyntax variable &&
                this.context.GetDeclaredSymbol(variable) is { } boundSymbol)
            {
                this.patternBindings[boundSymbol] = receiver;
            }
        }

        // Builds the smart-cast replacement expression a pattern designator
        // (`x is T t`, `x is { } t`) is rewritten to inside the guarded region.
        // gsc flow-narrows only a bare local/parameter scrutinee (ADR-0069); when
        // the scrutinee is a member-access chain, indexer or method-call result it
        // is NOT narrowed, so re-emitting the bare receiver at each use of `t`
        // leaves it at its (often nullable / wider) declared type and a member
        // access then fails to bind (GS0158). For those non-smart-castable
        // receivers we materialise the narrowing explicitly:
        //   • reference target `T`  → `(receiver as T)!!` (downcast + non-null);
        //   • value target `T`      → `receiver!!`        (G# has no `as` for value
        //                                                  types; the match already
        //                                                  proved it non-null);
        //   • `is { } t` (no type)  → `receiver!!`        (non-null view only).
        // A smart-castable bare local keeps the existing bare-receiver binding so
        // currently passing translations are unchanged.
        private GExpression BuildPatternNarrowingReplacement(
            GExpression receiver, ExpressionSyntax receiverSyntax, TypeSyntax narrowedTypeSyntax)
        {
            if (receiverSyntax != null && this.IsSmartCastableScrutinee(receiverSyntax))
            {
                return receiver;
            }

            if (narrowedTypeSyntax == null)
            {
                return new NonNullAssertionExpression(receiver);
            }

            ITypeSymbol narrowedType = this.context.GetTypeInfo(narrowedTypeSyntax).Type;
            if (narrowedType != null && narrowedType.IsValueType)
            {
                return new NonNullAssertionExpression(receiver);
            }

            return new NonNullAssertionExpression(
                new ParenthesizedExpression(
                    new BinaryExpression(
                        receiver,
                        "as",
                        new TypeExpression(this.MapTypeSyntax(narrowedTypeSyntax)))));
        }

        private GExpression TranslateArrayCreation(ArrayCreationExpressionSyntax creation)
        {
            GTypeReference elementType = this.GetArrayElementType(creation, creation.Type.ElementType);

            if (creation.Initializer != null)
            {
                // `new T[]{a, b}` / `new T[0]` (with an explicit, possibly empty,
                // initializer) → the slice literal `[]T{a, b}`.
                return new ArrayLiteralExpression(
                    elementType,
                    creation.Initializer.Expressions.Select(this.TranslateExpression).ToList());
            }

            // `new T[n]` (runtime/constant length, no initializer) → the native
            // G# zero-initialised allocation form `[n]T` (issue #1272), which
            // yields a zero-initialised slice `[]T` of length `n`. C# accepts
            // any integral length (`uint`/`long`/…); gsc's `[n]T` requires an
            // `int32` length, so a non-`int32` numeric length is coerced via the
            // conversion-call form (`int32(n)`).
            GExpression length;
            if (creation.Type.RankSpecifiers.Count > 0 &&
                creation.Type.RankSpecifiers[0].Sizes.Count > 0 &&
                creation.Type.RankSpecifiers[0].Sizes[0] is { } sizeExpr &&
                !sizeExpr.IsKind(SyntaxKind.OmittedArraySizeExpression))
            {
                length = this.CoerceLengthToInt32(sizeExpr, this.TranslateExpression(sizeExpr));
            }
            else
            {
                length = LiteralExpression.Int("0");
            }

            return new ArrayAllocationExpression(elementType, length);
        }

        private GExpression TranslateStackAlloc(StackAllocArrayCreationExpressionSyntax node)
        {
            // gsc issues #1024, #1057, #1041: C# `stackalloc T[n]` → G#-style
            // `stackalloc [n]gT` (the bracketed count first, then the element
            // type). In a safe context this yields `Span[T]`; targeting a raw
            // pointer inside an `unsafe` context yields `*T`. The element type
            // is mapped through the standard C#→G# type mapper (`byte`→`uint8`).
            // A C# initializer (`stackalloc byte[] { 1, 2 }`) maps to the
            // faithful G# initializer (`stackalloc [2]uint8{1, 2}`); an omitted
            // size is inferred from the initializer length.
            GTypeReference elementType;
            GExpression count;
            if (node.Type is ArrayTypeSyntax arrayType)
            {
                elementType = this.MapTypeSyntax(arrayType.ElementType);
                count = arrayType.RankSpecifiers.Count > 0 &&
                    arrayType.RankSpecifiers[0].Sizes.Count > 0 &&
                    arrayType.RankSpecifiers[0].Sizes[0] is { } sizeExpr &&
                    !sizeExpr.IsKind(SyntaxKind.OmittedArraySizeExpression)
                    ? this.TranslateExpression(sizeExpr)
                    : null;
            }
            else
            {
                elementType = new NamedTypeReference("uint8");
                count = null;
            }

            List<GExpression> elements = null;
            if (node.Initializer != null)
            {
                elements = node.Initializer.Expressions.Select(this.TranslateExpression).ToList();
            }

            // An explicit initializer supplies the length; fall back to the
            // element count when no size is spelled.
            if (count == null && node.Initializer != null)
            {
                count = LiteralExpression.Int(
                    node.Initializer.Expressions.Count.ToString(CultureInfo.InvariantCulture));
            }

            return new StackAllocExpression(elementType, count ?? LiteralExpression.Int("0"), elements);
        }

        private GExpression TranslateImplicitArrayCreation(ImplicitArrayCreationExpressionSyntax creation)
        {
            GTypeReference elementType = this.GetArrayElementType(creation, null);
            return new ArrayLiteralExpression(
                elementType,
                creation.Initializer.Expressions.Select(this.TranslateExpression).ToList());
        }

        private GExpression TranslateInitializerExpression(InitializerExpressionSyntax initializer)
        {
            // A bare `{ a, b, c }` array initializer (a field/local of array type
            // initialised without `new T[]`) or a collection-initializer element
            // list reaching value position maps to the slice literal `[]T{ … }`,
            // using the bound (converted) element type.
            GTypeReference elementType = this.GetArrayElementType(initializer, null);
            return new ArrayLiteralExpression(
                elementType,
                initializer.Expressions.Select(this.TranslateExpression).ToList());
        }

        private GExpression TranslateSizeOf(SizeOfExpressionSyntax sizeOf)
        {
            // `sizeof(T)` for a primitive type is a compile-time constant; emit the
            // byte width directly (G# has no `sizeof` operator). For non-primitive
            // types fall back to the call-shaped form so the output still parses.
            ITypeSymbol type = this.context.GetTypeInfo(sizeOf.Type).Type;
            int? size = type?.SpecialType switch
            {
                SpecialType.System_Boolean or SpecialType.System_SByte or SpecialType.System_Byte => 1,
                SpecialType.System_Int16 or SpecialType.System_UInt16 or SpecialType.System_Char => 2,
                SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Single => 4,
                SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Double => 8,
                SpecialType.System_Decimal => 16,
                _ => null,
            };

            if (size.HasValue)
            {
                return LiteralExpression.Int(size.Value.ToString(CultureInfo.InvariantCulture));
            }

            return new InvocationExpression(
                new IdentifierExpression("sizeof"),
                new List<GExpression> { new TypeExpression(this.MapTypeSyntax(sizeOf.Type)) });
        }

        private GTypeReference GetArrayElementType(ExpressionSyntax arrayExpression, TypeSyntax elementTypeSyntax)
        {
            TypeInfo info = this.context.GetTypeInfo(arrayExpression);
            ITypeSymbol arrayType = info.Type ?? info.ConvertedType;
            if (arrayType is IArrayTypeSymbol array)
            {
                return this.typeMapper.Map(array.ElementType, this.context, arrayExpression.GetLocation());
            }

            if (arrayType is INamedTypeSymbol { IsGenericType: true } generic &&
                generic.TypeArguments.Length == 1)
            {
                return this.typeMapper.Map(generic.TypeArguments[0], this.context, arrayExpression.GetLocation());
            }

            if (elementTypeSyntax != null)
            {
                return this.MapTypeSyntax(elementTypeSyntax);
            }

            return new NamedTypeReference("object");
        }

        private GExpression TranslateCollectionExpression(CollectionExpressionSyntax collection)
        {
            // An empty collection expression (`[]`) targeting a concrete
            // constructible collection class (e.g. `Dictionary<,> d = []`,
            // `List<T> l = []`) maps to a constructor call of that type. The slice
            // literal `[]T{ … }` only models arrays/spans; a `Dictionary`'s element
            // type is `KeyValuePair<,>`, whose generic `[...]` would otherwise be
            // emitted into a malformed `[]KeyValuePair[…]{}` literal (ADR-0115 §B).
            ITypeSymbol target = this.context.GetTypeInfo(collection).ConvertedType
                ?? this.context.GetTypeInfo(collection).Type;
            if (collection.Elements.Count == 0 &&
                target is INamedTypeSymbol { TypeKind: TypeKind.Class } namedTarget &&
                this.typeMapper.Map(namedTarget, this.context, collection.GetLocation()) is NamedTypeReference targetRef)
            {
                return new InvocationExpression(
                    new IdentifierExpression(targetRef.Name),
                    new List<GExpression>(),
                    targetRef.TypeArguments.Count > 0 ? targetRef.TypeArguments : null);
            }

            // C# 12 collection expression `[a, b, c]`. The target type (array,
            // span, or any IEnumerable<T>) supplies the element type, so it maps to
            // the canonical G# slice literal `[]T{ … }` (ADR-0115 §B). Spread
            // elements `[..xs]` have no G# composite-literal form yet.
            GTypeReference elementType = this.GetCollectionElementType(collection);
            var elements = new List<GExpression>();
            foreach (CollectionElementSyntax element in collection.Elements)
            {
                if (element is ExpressionElementSyntax expressionElement)
                {
                    elements.Add(this.CoerceCollectionElement(expressionElement.Expression, elementType));
                }
                else
                {
                    this.context.ReportUnsupported(
                        element,
                        $"collection-expression element '{element.Kind()}' (spread) has no canonical G# composite-literal form yet (ADR-0115 §B).");
                }
            }

            return new ArrayLiteralExpression(elementType, elements);
        }

        private GExpression CoerceCollectionElement(ExpressionSyntax element, GTypeReference elementType)
        {
            // A bare integer literal in a typed-narrower array (`[0, 0]` into a
            // `byte[]`) needs an explicit G# conversion, since untyped numeric
            // literals do not auto-narrow. Wrap such elements in `T(elem)`.
            GExpression translated = this.TranslateExpression(element);
            ITypeSymbol elementSymbol = this.context.GetTypeInfo(element).Type;
            ITypeSymbol convertedSymbol = this.context.GetTypeInfo(element).ConvertedType;
            if (elementSymbol != null && convertedSymbol != null &&
                !SymbolEqualityComparer.Default.Equals(elementSymbol, convertedSymbol) &&
                IsPrimitiveNumeric(elementSymbol) && IsPrimitiveNumeric(convertedSymbol))
            {
                return new ConversionExpression(elementType, translated);
            }

            return translated;
        }

        private static bool IsPrimitiveNumeric(ITypeSymbol type) => type.SpecialType switch
        {
            SpecialType.System_SByte or SpecialType.System_Byte or
            SpecialType.System_Int16 or SpecialType.System_UInt16 or
            SpecialType.System_Int32 or SpecialType.System_UInt32 or
            SpecialType.System_Int64 or SpecialType.System_UInt64 or
            SpecialType.System_Single or SpecialType.System_Double or
            SpecialType.System_Decimal or SpecialType.System_Char => true,
            _ => false,
        };

        private GTypeReference GetCollectionElementType(CollectionExpressionSyntax collection)
        {
            ITypeSymbol target = this.context.GetTypeInfo(collection).ConvertedType
                ?? this.context.GetTypeInfo(collection).Type;
            ITypeSymbol elementType = GetEnumerableElementType(target);
            if (elementType != null)
            {
                return this.typeMapper.Map(elementType, this.context, collection.GetLocation());
            }

            // No bound target type: fall back to the natural element type of the
            // first element, or `object` for an empty literal.
            ExpressionSyntax firstExpression = collection.Elements
                .OfType<ExpressionElementSyntax>()
                .Select(e => e.Expression)
                .FirstOrDefault();
            if (firstExpression != null &&
                this.context.GetTypeInfo(firstExpression).Type is { } natural)
            {
                return this.typeMapper.Map(natural, this.context, collection.GetLocation());
            }

            return new NamedTypeReference("object");
        }

        private static ITypeSymbol GetEnumerableElementType(ITypeSymbol type)
        {
            switch (type)
            {
                case null:
                    return null;
                case IArrayTypeSymbol array:
                    return array.ElementType;
                case INamedTypeSymbol named:
                    if (named.IsGenericType && named.TypeArguments.Length == 1)
                    {
                        return named.TypeArguments[0];
                    }

                    foreach (INamedTypeSymbol iface in named.AllInterfaces)
                    {
                        if (iface.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T &&
                            iface.TypeArguments.Length == 1)
                        {
                            return iface.TypeArguments[0];
                        }
                    }

                    return null;
                default:
                    return null;
            }
        }

        private GExpression TranslateRangeSlice(GExpression receiver, RangeExpressionSyntax range)
        {
            // `recv[start..end]` → `recv.Slice(start, end - start)`;
            // `recv[start..]`    → `recv.Slice(start)`;
            // `recv[..end]`      → `recv.Slice(0, end)`.
            GExpression start = range.LeftOperand != null
                ? this.TranslateExpression(range.LeftOperand)
                : LiteralExpression.Int("0");

            var slice = new MemberAccessExpression(receiver, "Slice");

            if (range.RightOperand == null)
            {
                return new InvocationExpression(slice, new List<GExpression> { start });
            }

            // `start` is embedded both as the `Slice` start argument and inside
            // the `end - start` length below; a non-trivial left operand (e.g. a
            // side-effecting `Next()`) would otherwise be re-evaluated a second
            // time here — C# evaluates the range's start once (issue #1731).
            if (range.LeftOperand != null)
            {
                start = this.SpillOperand(start, range.LeftOperand);
            }

            GExpression end = this.TranslateExpression(range.RightOperand);
            GExpression length = range.LeftOperand == null
                ? end
                : new BinaryExpression(end, "-", start);

            return new InvocationExpression(slice, new List<GExpression> { start, length });
        }

        private GTypeReference ResolveExpressionType(ExpressionSyntax expression)
        {
            TypeInfo info = this.context.GetTypeInfo(expression);
            ITypeSymbol type = info.ConvertedType ?? info.Type;
            if (type == null || type.SpecialType == SpecialType.System_Void || type.TypeKind == TypeKind.Error)
            {
                return null;
            }

            return this.typeMapper.Map(type, this.context, expression.GetLocation());
        }

        private GExpression TranslateIdentifierName(IdentifierNameSyntax identifier)
        {
            // A switch-expression property-pattern binding (`Circle { Radius: var r }`)
            // has no G# equivalent; references to the bound local are rewritten to a
            // member access on the arm's type-pattern designator (`circle.Radius`).
            if (this.patternBindings.Count > 0 &&
                this.context.GetSymbolInfo(identifier).Symbol is { } boundSymbol &&
                this.patternBindings.TryGetValue(boundSymbol, out GExpression replacement))
            {
                return replacement;
            }

            // Inside a lifted owned-struct receiver method (issue #938) a bare
            // reference to an instance member carries an implicit C# `this`; a
            // top-level receiver-clause `func` has no implicit receiver, so the
            // reference must be made explicit through the receiver (`self.X`).
            if (this.currentReceiverName != null)
            {
                ISymbol symbol = this.context.GetSymbolInfo(identifier).Symbol;
                if (symbol is { IsStatic: false } &&
                    symbol.Kind is SymbolKind.Field or SymbolKind.Property or SymbolKind.Method)
                {
                    return new MemberAccessExpression(
                        new IdentifierExpression(this.currentReceiverName),
                        SanitizeIdentifier(identifier.Identifier.Text));
                }
            }

            // A C# bare sibling static field/property reference (`FfAc3ChannelsTab`)
            // carries an implicit type qualifier. A G# top-level `func` (e.g. a
            // lifted extension method whose former `static class` keeps the field
            // in a `shared { }` block) or `shared` body has no implicit type scope,
            // so the reference must be qualified through the owning type
            // (`Ec3Extensions.FfAc3ChannelsTab`) — the field/property analog of the
            // bare static-call rule (ADR-0115 §B.18). Without this the binder reports
            // GS0125 (the name is not in scope at top level).
            if (this.context.GetSymbolInfo(identifier).Symbol is
                    { IsStatic: true, Kind: SymbolKind.Field or SymbolKind.Property } staticMember &&
                staticMember.ContainingType is { TypeKind: TypeKind.Class or TypeKind.Struct } owner &&
                !owner.IsImplicitlyDeclared &&
                !this.IsStaticUsingTarget(owner) &&
                !SymbolEqualityComparer.Default.Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition))
            {
                return new MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, identifier.GetLocation()),
                    SanitizeIdentifier(identifier.Identifier.Text));
            }

            return new IdentifierExpression(SanitizeIdentifier(identifier.Identifier.Text));
        }

        // Builds the receiver expression used to qualify a bare sibling static
        // member reference through its owning type. For a non-generic owner this is
        // a plain identifier (`Owner`); for a GENERIC owner it must carry the type
        // arguments (`Owner[T]`) so it does not collide with a sibling non-generic
        // type of the same simple name (e.g. `static class TreeDecomposition` beside
        // `class TreeDecomposition<T>`), which would otherwise bind the arity-0 type
        // and report GS0158 for members that live only on the generic type.
        private GExpression StaticQualifierReceiver(INamedTypeSymbol owner, Location location)
        {
            if (owner.IsGenericType)
            {
                return new TypeExpression(this.typeMapper.Map(owner, this.context, location));
            }

            return new IdentifierExpression(owner.Name);
        }

        private GExpression TranslateLiteral(LiteralExpressionSyntax literal)
        {
            switch (literal.Kind())
            {
                case SyntaxKind.NumericLiteralExpression:
                    // Preserve the original literal spelling (ADR-0115 §B.12): G#
                    // has no implicit numeric promotion, so a C# `2.0` must stay
                    // `2.0` (not collapse to `2`, which would be int32 and fail
                    // `int32 * float64`); hex such as `0xFF0000` is likewise kept
                    // verbatim. The bound type still classifies the literal kind.
                    object value = literal.Token.Value;
                    if (value is float or double or decimal)
                    {
                        return LiteralExpression.Float(literal.Token.Text);
                    }

                    // C# applies an implicit int->double/float promotion at a
                    // call site (e.g. `M(30)` where the parameter is `double`).
                    // G# has no such implicit promotion, so the emitter would push
                    // an int32 where a float64 is expected and produce invalid IL
                    // (ilverify StackUnexpected). Honor the bound `ConvertedType`
                    // and emit a float literal so the value matches its target
                    // type (ADR-0115 §B.12).
                    if (this.IsConvertedToFloatingPoint(literal))
                    {
                        return LiteralExpression.Float(this.ToFloatLiteralText(literal.Token.Value));
                    }

                    return LiteralExpression.Int(this.NormalizeIntegerLiteralText(literal));

                case SyntaxKind.StringLiteralExpression:
                    return LiteralExpression.String(literal.Token.ValueText);

                case SyntaxKind.Utf8StringLiteralExpression:
                    // A UTF-8 string literal `"x"u8` is a `ReadOnlySpan<byte>` of
                    // the UTF-8 encoding of the text. G# has no `u8` suffix, so emit
                    // the canonical byte slice literal `[]uint8{ … }` (ADR-0115 §B).
                    return new ArrayLiteralExpression(
                        new NamedTypeReference("uint8"),
                        System.Text.Encoding.UTF8.GetBytes(literal.Token.ValueText)
                            .Select(b => (GExpression)LiteralExpression.Int($"0x{b:X2}"))
                            .ToList());

                case SyntaxKind.CharacterLiteralExpression:
                    return LiteralExpression.Char(literal.Token.ValueText);

                case SyntaxKind.TrueLiteralExpression:
                    return LiteralExpression.Bool(true);

                case SyntaxKind.FalseLiteralExpression:
                    return LiteralExpression.Bool(false);

                case SyntaxKind.NullLiteralExpression:
                    return LiteralExpression.Null();

                case SyntaxKind.DefaultLiteralExpression:
                    // The target-typed `default` literal maps to G# `default(T)`
                    // for the converted (target) type when that type is known, so
                    // the value is self-typed. A bare typeless `default` relies on
                    // surrounding context for its type, but common positions supply
                    // none: an inferred `var retval = default` (the C# type was
                    // erased to the initializer's natural type, which for `default`
                    // is the target type, so the local-declaration path omits the
                    // clause and infers — yet bare `default` has nothing to infer
                    // from) surfaces GS0362. Emitting `default(T)` keeps it valid
                    // everywhere (ADR-0100). Falls back to bare `default` only when
                    // the type is genuinely unavailable.
                    return new DefaultValueExpression(this.ResolveExpressionType(literal));

                default:
                    this.context.ReportUnsupported(
                        literal,
                        $"literal '{literal.Kind()}' has no canonical G# form yet; emitted nil (ADR-0115 §B.12).");
                    return LiteralExpression.Null();
            }
        }

        // C# infers the type of a suffix-less integer literal from its value: a
        // hex constant such as `0xD800000000000000` is implicitly `ulong`. G#'s
        // lexer instead defaults to int32/int64 and rejects an out-of-range
        // literal (GS0004), so when the bound value requires a wider/unsigned
        // type we append the matching G# suffix (`L`, `UL`, `U`).
        private string NormalizeIntegerLiteralText(LiteralExpressionSyntax literal)
        {
            string text = literal.Token.Text;
            object value = literal.Token.Value;

            // Respect an explicit suffix already present in the source spelling.
            if (text.Length > 0 && (text[text.Length - 1] is 'u' or 'U' or 'l' or 'L'))
            {
                return text;
            }

            switch (value)
            {
                case ulong:
                    return text + "UL";
                case long l when l > int.MaxValue || l < int.MinValue:
                    return text + "L";
                case uint u when u > int.MaxValue:
                    return text + "U";
                default:
                    return text;
            }
        }

        private bool IsConvertedToFloatingPoint(LiteralExpressionSyntax literal)
        {
            TypeInfo info = this.context.GetTypeInfo(literal);
            ITypeSymbol original = info.Type;
            ITypeSymbol converted = info.ConvertedType;
            if (converted is null || SymbolEqualityComparer.Default.Equals(original, converted))
            {
                return false;
            }

            bool originalIsIntegral = original is { SpecialType: SpecialType.System_SByte
                or SpecialType.System_Byte or SpecialType.System_Int16 or SpecialType.System_UInt16
                or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64
                or SpecialType.System_UInt64 };
            bool convertedIsFloat = converted.SpecialType is SpecialType.System_Single
                or SpecialType.System_Double;
            return originalIsIntegral && convertedIsFloat;
        }

        private string ToFloatLiteralText(object value)
        {
            // The token's *spelling* can be hex (`0xFF`), binary (`0b1010`),
            // digit-separated (`1_000`), or suffixed (`30L`); appending ".0" to
            // that raw text either produces an invalid G# float (`0xFF.0`,
            // `30L.0`) or silently misses cases that already contain a stray
            // 'e'/'E' hex digit (`0xAE`). Deriving the text from the token's
            // already-parsed *value* instead sidesteps spelling entirely: format
            // the numeric value as decimal and ensure it carries a fractional
            // part so the G# lexer classifies it as float64.
            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            string text = number.ToString("R", CultureInfo.InvariantCulture);
            return text.IndexOfAny(new[] { '.', 'e', 'E' }) >= 0 ? text : text + ".0";
        }

        private GExpression TranslateMemberAccess(MemberAccessExpressionSyntax member)
        {
            // Member access on a bare-identifier element access (`values[i].M`)
            // previously hit a G# parser ambiguity (#942); that gap is now fixed,
            // so the construct translates through the normal member-access path.
            //
            // When the member binds to an extension method whose `this` parameter
            // is itself nullable (`this T? x`), the method is *meant* to be invoked
            // on a possibly-null receiver and handles null internally (e.g.
            // `Ac4DsiV1.SampleRate()` over `static int? SampleRate(this Ac4DsiV1?)`).
            // Forgiving the receiver to non-null (`Ac4DsiV1!!`) changes its static
            // type to the non-null `Ac4DsiV1`, which gsc's extension-method lookup
            // does not match against the `Ac4DsiV1?` `this` slot (GS0159). Keep the
            // declared-nullable receiver so the extension resolves.
            // A C# nullable *value* type (`T?` lowering to `System.Nullable<T>`)
            // exposes `.Value` and `.HasValue`, but G# models a value-type `T?`
            // directly (no `Nullable<T>` member surface) and relies on Kotlin-style
            // smart-casts, so those members do not exist on the G# side. Rewrite
            // them to the idiomatic G# equivalents (#914):
            //   * `x.Value`    -> `x!!`      (assert non-null, matching C#'s throw-
            //                                 if-null semantics; harmless once the
            //                                 local is already smart-cast-narrowed).
            //   * `x.HasValue` -> `x != nil` (a plain null test on the raw receiver).
            // Guard on the receiver's *declared* type being `System.Nullable<T>` so
            // a user type with a member literally named `Value`/`HasValue` is
            // unaffected. Nullable *reference* types (`string?`) have a non-
            // `Nullable<T>` receiver type and are likewise left alone.
            if (this.context.GetTypeInfo(member.Expression).Type is { } receiverType
                && receiverType.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T)
            {
                switch (member.Name.Identifier.Text)
                {
                    case "Value":
                        return new NonNullAssertionExpression(this.TranslateExpression(member.Expression));
                    case "HasValue":
                        // Parenthesize the null test so it composes correctly
                        // under any surrounding operator. C# `!x.HasValue` would
                        // otherwise translate to `!x != nil`, which G# parses as
                        // `(!x) != nil` (GS0128); `!(x != nil)` is always correct.
                        return new ParenthesizedExpression(
                            new BinaryExpression(this.TranslateExpression(member.Expression), "!=", LiteralExpression.Null()));
                }
            }

            GExpression target = this.MemberBindsToNullableThisExtension(member)
                ? this.TranslateExpression(member.Expression)
                : this.TranslateReceiverWithNullForgiveness(member.Expression);
            string memberName = member.Name.Identifier.Text;

            // A C# tuple element access (`item.Name`, `item.Price`) lowers to the
            // positional G# tuple field `.Item1`/`.Item2`, because G# tuples are
            // positional and carry no element names (ADR-0115 §B.4). The default
            // `.ItemN` access already resolves; only named-element access needs the
            // rewrite, detected via the bound tuple-element field symbol.
            if (this.context.GetSymbolInfo(member).Symbol is IFieldSymbol field &&
                field.ContainingType is { IsTupleType: true })
            {
                IFieldSymbol positional = field.CorrespondingTupleField ?? field;
                memberName = positional.Name;
            }

            return new MemberAccessExpression(target, SanitizeIdentifier(memberName));
        }

        /// <summary>
        /// Translates a member- or element-access <paramref name="recv"/> receiver,
        /// wrapping it in G#'s postfix non-null assertion (<c>recv!!</c>) when the
        /// receiver is <em>declared</em> nullable (a <c>T?</c> reference type or
        /// nullable array) yet Roslyn's nullable <em>flow</em> analysis has proven
        /// it non-null at this site (e.g. after a guard such as
        /// <c>if (o.Child == null) return;</c>).
        /// </summary>
        /// <remarks>
        /// C# uses flow-sensitive null analysis, so a guarded nullable property or
        /// field chain reads as non-null afterwards. G# follows Kotlin-style
        /// smart-casts that narrow only <em>local</em> variables, never
        /// property/field-access chains, so emitting <c>Moov.TextTrack.Mdia</c>
        /// where <c>TextTrack</c> is <c>TrakBox?</c> is rejected with GS0158 (member
        /// access on a <c>T?</c> receiver) or GS0116 (indexing a <c>T?</c> receiver).
        /// Reusing Roslyn's own proof, the assertion <c>!!</c> re-establishes the
        /// non-null fact the guard already proved (#914). The assertion is harmless
        /// on an already-non-null receiver, but the predicate below stays precise to
        /// keep the output faithful.
        /// </remarks>
        /// <param name="recv">The immediate receiver expression (left of the
        /// <c>.</c> or <c>[</c>).</param>
        /// <returns>The translated receiver, wrapped in
        /// <see cref="NonNullAssertionExpression"/> when flow-proven non-null.</returns>
        private GExpression TranslateReceiverWithNullForgiveness(ExpressionSyntax recv)
        {
            GExpression translated = this.TranslateExpression(recv);

            if (this.ReceiverNeedsNullForgiveness(recv)
                || this.ReceiverIsNullableReferenceFieldOrProperty(recv))
            {
                return new NonNullAssertionExpression(translated);
            }

            return translated;
        }

        /// <summary>
        /// True when a member-/element-access <paramref name="recv"/> receiver is a
        /// nullable-reference <em>field</em> or <em>property</em> (declared <c>T?</c>
        /// or promoted to nullable, issue #1072) and therefore always needs a G#
        /// <c>!!</c> assertion — independent of Roslyn flow state.
        /// </summary>
        /// <remarks>
        /// Unlike a local variable, G#'s Kotlin-style smart-casts never narrow a
        /// property/field-access chain, so <c>field.Member</c> / <c>field[i]</c> on a
        /// <c>T?</c> field is rejected (GS0158/GS0116) no matter what null-guard
        /// precedes it. The Oahu corpus compiles nullable-<em>disabled</em>, so
        /// Roslyn's flow analysis reports these receivers as oblivious (never
        /// flow-state <c>NotNull</c>) and the flow-driven
        /// <see cref="ReceiverNeedsNullForgiveness"/> pass leaves them bare.
        /// Asserting <c>field!!.Member</c> both compiles and preserves C#'s
        /// throw-on-null semantics for the same access (a null field would
        /// <c>NullReferenceException</c> in C# too). Locals/parameters keep the
        /// flow-proven path, since G# does smart-cast them; comparison operands and
        /// <c>?.</c> receivers are routed elsewhere and never reach this pass.
        /// </remarks>
        private bool ReceiverIsNullableReferenceFieldOrProperty(ExpressionSyntax recv)
        {
            if (recv is PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                or ThisExpressionSyntax
                or BaseExpressionSyntax
                or LiteralExpressionSyntax
                or ConditionalAccessExpressionSyntax)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(recv).Symbol;

            ITypeSymbol declared = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            return declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.IsPromotedToNullableReference(symbol);
        }

        // True when <paramref name="member"/> binds to an extension method whose
        // (reduced) `this` parameter is nullable-annotated (`this T? x`). Such a
        // method is designed to accept a null receiver, so the translated call must
        // keep the declared-nullable receiver rather than forgive it to non-null.
        private bool MemberBindsToNullableThisExtension(MemberAccessExpressionSyntax member)
        {
            if (this.context.GetSymbolInfo(member).Symbol is not IMethodSymbol method)
            {
                return false;
            }

            IMethodSymbol unreduced = method.ReducedFrom ?? method;
            if (!unreduced.IsExtensionMethod || unreduced.Parameters.Length == 0)
            {
                return false;
            }

            IParameterSymbol thisParameter = unreduced.Parameters[0];
            return thisParameter.Type.IsReferenceType
                ? thisParameter.NullableAnnotation == NullableAnnotation.Annotated
                : thisParameter.Type.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T;
        }

        // Issue #1354: a value-position read (a `return` expression or a
        // conditional-expression arm) of a declared-`T?`/promoted-to-`T?` symbol
        // that Roslyn's flow analysis has narrowed to non-null needs a `!!`
        // assertion to satisfy a non-null target. G# does not smart-cast
        // property/field chains, so unlike the receiver pass this also covers
        // bare reads consumed as values (`return Continuation` /
        // `cond ? a : Continuation`). The shared <see cref="ReceiverNeedsNullForgiveness"/>
        // predicate already excludes null-comparison operands (flow there is not
        // NotNull), `?.` receivers, `this`/`base`, and literals.
        private GExpression TranslateValueWithNullForgiveness(ExpressionSyntax value)
        {
            GExpression translated = this.TranslateExpression(value);

            if (this.ReceiverNeedsNullForgiveness(value))
            {
                return new NonNullAssertionExpression(translated);
            }

            return translated;
        }

        /// <summary>
        /// Determines whether <paramref name="recv"/> is a declared-nullable
        /// reference receiver that Roslyn's flow analysis has narrowed to non-null,
        /// and therefore needs a G# <c>!!</c> assertion (see
        /// <see cref="TranslateReceiverWithNullForgiveness"/>).
        /// </summary>
        private bool ReceiverNeedsNullForgiveness(ExpressionSyntax recv)
        {
            // `expr!` already lowers to a `NonNullAssertionExpression`; never
            // double-assert. `this`/`base`, a null literal, and a `?.` conditional
            // access receiver are handled by their own paths and are not
            // declared-nullable property/field chains.
            if (recv is PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                or ThisExpressionSyntax
                or BaseExpressionSyntax
                or LiteralExpressionSyntax
                or ConditionalAccessExpressionSyntax)
            {
                return false;
            }

            // Flow analysis must have proven the receiver non-null at this site.
            if (this.context.GetTypeInfo(recv).Nullability.FlowState != NullableFlowState.NotNull)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(recv).Symbol;

            // Static member access (`Type.StaticMember`) and namespace-qualified
            // names carry a type/namespace receiver, not a value: never assert.
            if (symbol is ITypeSymbol or INamespaceSymbol or null)
            {
                return false;
            }

            // Inspect the receiver's *declared* type. The flow-collapsed
            // `Nullability.Annotation` reports NotAnnotated once flow proves
            // non-null, so it cannot distinguish a declared `T?` from a `T`; the
            // declaring symbol's type is the reliable source.
            ITypeSymbol declared = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IMethodSymbol method => method.ReturnType,
                _ => null,
            };

            // Focus on the GS0158/GS0116 cases: nullable reference types and
            // nullable arrays. Nullable value types (`int?`) take the `.Value`/
            // `.HasValue` path and are left untouched.
            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            // A declared-nullable receiver (`T?`) flow-proven non-null needs `!!`.
            // A declared non-null receiver that this pass PROMOTED to `T?`
            // (issue #1072: null-checked param/field/local) is rendered nullable
            // too, so its flow-proven uses need the same assertion for consistency.
            return declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.IsPromotedToNullableReference(symbol);
        }

        private GExpression TranslateInvocation(InvocationExpressionSyntax invocation)
        {
            GExpression target;
            IReadOnlyList<GTypeReference> typeArguments = null;

            // C# delegate/event invocation `d.Invoke(args)` / `d?.Invoke(args)` maps
            // to G#'s direct function-call form `d(args)` / `d?(args)`: G# invokes a
            // function-typed value (delegate field or event) directly and has no
            // `.Invoke` member (`.Invoke` would be GS0159). Detected via the
            // delegate's synthesized `Invoke` method (MethodKind.DelegateInvoke).
            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
                    { MethodKind: MethodKind.DelegateInvoke }
                && TryGetDelegateInvokeReceiver(invocation.Expression, out GExpression invokeTarget))
            {
                var invokeArguments = this.TranslateArguments(invocation.ArgumentList.Arguments);
                return new InvocationExpression(invokeTarget, invokeArguments, null);
            }

            // A C# extension method whose receiver is an enum is emitted as a
            // plain static helper (a receiver clause is rejected on enums,
            // GS0103). Rewrite the call `x.M(args)` to the positional form
            // `Owner.M(x, args)` so it binds to that helper.
            if (invocation.Expression is MemberAccessExpressionSyntax extMember
                && this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol extMethod
                && TryGetEnumExtension(extMethod, out string extOwner, out string extName))
            {
                var extArgs = new List<GExpression>
                {
                    this.TranslateExpression(extMember.Expression),
                };
                extArgs.AddRange(this.TranslateArguments(invocation.ArgumentList.Arguments));
                IReadOnlyList<GTypeReference> extTypeArgs = extMember.Name is GenericNameSyntax extGeneric
                    ? this.MapTypeArguments(extGeneric)
                    : null;
                return new InvocationExpression(
                    new MemberAccessExpression(new IdentifierExpression(extOwner), extName),
                    extArgs,
                    extTypeArgs);
            }

            // A generic call `Foo<T>(...)` carries its type arguments on the name;
            // lift them onto the G# bracket-type-argument form `Foo[T](...)`.
            if (invocation.Expression is GenericNameSyntax generic)
            {
                target = new IdentifierExpression(SanitizeIdentifier(generic.Identifier.Text));
                typeArguments = this.MapTypeArguments(generic);
            }
            else if (invocation.Expression is MemberAccessExpressionSyntax member
                && member.Name is GenericNameSyntax memberGeneric)
            {
                target = new MemberAccessExpression(
                    this.TranslateExpression(member.Expression),
                    SanitizeIdentifier(memberGeneric.Identifier.Text));
                typeArguments = this.MapTypeArguments(memberGeneric);
            }
            else if (invocation.Expression is MemberBindingExpressionSyntax memberBinding
                && memberBinding.Name is GenericNameSyntax memberBindingGeneric)
            {
                // A generic call chained after a null-conditional `?.`
                // (`x?.GetChild<HdlrBox>()`) reaches here as a member-binding
                // whose name carries the type arguments. Preserve them on the
                // bracket-type-argument form so the chained call keeps `[T...]`.
                target = new MemberAccessExpression(
                    new ConditionalReceiverExpression(),
                    SanitizeIdentifier(memberBindingGeneric.Identifier.Text));
                typeArguments = this.MapTypeArguments(memberBindingGeneric);
            }
            else if (invocation.Expression is IdentifierNameSyntax bareName &&
                this.context.GetSymbolInfo(bareName).Symbol is IMethodSymbol { IsStatic: true } staticMethod &&
                staticMethod.ContainingType is { TypeKind: TypeKind.Class or TypeKind.Struct } owner &&
                !owner.IsImplicitlyDeclared &&
                !this.IsStaticUsingTarget(owner) &&
                !SymbolEqualityComparer.Default.Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition))
            {
                // A C# bare sibling static call (`Round(value, 2)`) carries an
                // implicit type qualifier. A G# `shared` method body has no
                // implicit type scope, so the call must be qualified through the
                // owning type (`Geometry.Round(value, 2)`); see ADR-0115 §B.18.
                // A bare call to a `using static` member is the exception
                // (ADR-0134): gsc brings it into scope through `import Owner`,
                // so it is left unqualified above.
                target = new MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, bareName.GetLocation()),
                    staticMethod.Name);
            }
            else
            {
                target = this.TranslateExpression(invocation.Expression);
            }

            var arguments = this.TranslateArguments(invocation.ArgumentList.Arguments);

            // Directly invoking a nullable-reference delegate field/property
            // (`handler(args)` where `handler` is `((T) -> R)?`) needs a `!!`
            // assertion on the callee: G# smart-casts only locals, never a
            // field/property chain, so an unforgiven nullable delegate field is
            // "not a function" (GS0131) even inside an `if handler != nil` guard.
            // This is the invocation-callee analog of the receiver `!!` pass
            // (#1594); locals are excluded by the shared helper. It fires for any
            // nullable delegate field/property callee, not just this one shape.
            if (this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol
                    { MethodKind: MethodKind.DelegateInvoke }
                && this.ReceiverIsNullableReferenceFieldOrProperty(invocation.Expression))
            {
                target = new NonNullAssertionExpression(target);
            }

            return new InvocationExpression(target, arguments, typeArguments);
        }

        // Resolves the receiver of a delegate/event `.Invoke(...)` call to the value
        // that G# invokes directly. `d.Invoke(...)` → `d`; the null-conditional
        // `d?.Invoke(...)` form reaches here as a member-binding whose receiver is the
        // conditional-receiver placeholder (so the enclosing `?.` renders `d?(...)`).
        // The null-conditional rewrite is only applied when the conditional-access
        // receiver is a simple identifier/member/`this` expression: G# parses
        // `complexExpr?(args)` (e.g. a call or index receiver ending in `)`/`]`) as
        // the ternary operator (`expr ? a : b`), so those keep the explicit `.Invoke`.
        private bool TryGetDelegateInvokeReceiver(
            ExpressionSyntax callee, out GExpression receiver)
        {
            switch (callee)
            {
                case MemberAccessExpressionSyntax member
                    when member.Name.Identifier.Text == "Invoke":
                    // A nullable delegate/event receiver spelled `field.Invoke(...)`
                    // needs the same `!!` the direct-call spelling `field(...)` gets
                    // below (#1598): route through the shared receiver-forgiveness
                    // helper rather than a bare translate, or the `.Invoke` spelling
                    // bypasses the assertion and emits an unforgiven `field(...)`
                    // (GS0131).
                    receiver = this.TranslateReceiverWithNullForgiveness(member.Expression);
                    return true;

                case MemberBindingExpressionSyntax binding
                    when binding.Name.Identifier.Text == "Invoke"
                        && IsSimpleConditionalInvokeReceiver(binding):
                    receiver = new ConditionalReceiverExpression();
                    return true;

                default:
                    receiver = null;
                    return false;
            }
        }

        // Reports whether the conditional-access receiver enclosing a `?.Invoke(...)`
        // member-binding is a form G# can null-conditionally invoke as `recv?(args)`
        // without colliding with the ternary operator — i.e. an identifier, a member
        // access, or `this` (its last token is an identifier), but NOT a call/index/
        // parenthesized receiver (whose trailing `)`/`]` makes `recv?(` parse as a
        // ternary condition).
        private static bool IsSimpleConditionalInvokeReceiver(
            MemberBindingExpressionSyntax binding)
        {
            if (binding.Parent is not InvocationExpressionSyntax invocation ||
                invocation.Parent is not ConditionalAccessExpressionSyntax conditional)
            {
                return false;
            }

            return conditional.Expression is IdentifierNameSyntax
                or MemberAccessExpressionSyntax
                or ThisExpressionSyntax;
        }

        /// <summary>
        /// Rewrites a null-conditional call to an enum extension method
        /// (<c>recv?.M(args)</c> where <c>M</c> is <c>this EnumType</c>) into the
        /// ternary <c>if recv != nil { Owner.M(recv!!, args) } else { nil }</c>.
        /// An enum extension is emitted as a plain static helper (a G# receiver
        /// clause is rejected on enums, GS0103), so the <c>?.</c> member-binding
        /// form cannot bind to it; gsc reports GS0159. The receiver is a pure
        /// expression in practice, so the duplicated evaluation is safe.
        /// </summary>
        private bool TryTranslateNullConditionalEnumExtension(
            ConditionalAccessExpressionSyntax conditionalAccess,
            out GExpression result)
        {
            result = null;

            if (conditionalAccess.WhenNotNull is not InvocationExpressionSyntax invocation ||
                invocation.Expression is not MemberBindingExpressionSyntax binding)
            {
                return false;
            }

            if (this.context.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method ||
                !TryGetEnumExtension(method, out string owner, out string name))
            {
                return false;
            }

            GExpression receiver = this.TranslateExpression(conditionalAccess.Expression);

            var callArgs = new List<GExpression>
            {
                new NonNullAssertionExpression(receiver),
            };
            callArgs.AddRange(this.TranslateArguments(invocation.ArgumentList.Arguments));
            IReadOnlyList<GTypeReference> callTypeArgs = binding.Name is GenericNameSyntax generic
                ? this.MapTypeArguments(generic)
                : null;

            GExpression call = new InvocationExpression(
                new MemberAccessExpression(new IdentifierExpression(owner), name),
                callArgs,
                callTypeArgs);

            GExpression guard = new BinaryExpression(
                this.TranslateExpression(conditionalAccess.Expression),
                "!=",
                new IdentifierExpression("nil"));

            result = new ParenthesizedExpression(
                new IfExpression(guard, call, new IdentifierExpression("nil")));
            return true;
        }

        /// <summary>
        /// Determines whether <paramref name="method"/> is a C# extension method
        /// whose receiver (<c>this</c>) parameter is an enum. Such an extension
        /// cannot carry a G# receiver clause (ADR-0079; gsc reports GS0103), so it
        /// is emitted as a plain static helper and its call sites are rewritten to
        /// the positional form <c>Owner.Method(receiver, …)</c>.
        /// </summary>
        /// <param name="method">The bound (possibly reduced) call symbol.</param>
        /// <param name="ownerName">The declaring static class name when matched.</param>
        /// <param name="methodName">The helper method name when matched.</param>
        /// <returns><see langword="true"/> when the call targets an enum extension.</returns>
        private static bool TryGetEnumExtension(IMethodSymbol method, out string ownerName, out string methodName)
        {
            ownerName = null;
            methodName = null;
            if (method == null || !method.IsExtensionMethod)
            {
                return false;
            }

            ITypeSymbol receiverType = method.ReceiverType
                ?? method.Parameters.FirstOrDefault()?.Type;
            if (receiverType?.TypeKind != TypeKind.Enum)
            {
                return false;
            }

            IMethodSymbol original = method.ReducedFrom ?? method;
            ownerName = original.ContainingType?.Name is { } containingName ? SanitizeIdentifier(containingName) : null;
            methodName = SanitizeIdentifier(original.Name);
            return ownerName != null;
        }

        /// <summary>
        /// Translates a single C# call argument, honoring <c>out</c>/<c>ref</c>
        /// argument forms (ADR-0115 §B; sample <c>TryParseOutVar.gs</c>): an
        /// <c>out</c>/<c>ref</c> argument naming a pre-declared variable maps to
        /// the address-of form <c>&amp;x</c>, an inline <c>out var x</c> maps to
        /// <c>out var x</c>, and an <c>out _</c> discard maps to <c>out _</c>.
        /// </summary>
        // Issue #1727: G# has no named-argument call syntax, so a C# argument list
        // that uses `name:` must be translated into pure declaration-order
        // positional form. `Foo(b: 2, a: 1)` was previously emitted in SYNTAX order
        // (`Foo(2, 1)`) — silently swapping the arguments — and a skipped optional
        // parameter (`Foo(c: 5)` skipping `a`/`b`) bound the value to the FIRST
        // parameter instead of `c`. The fast path (no named arguments) is
        // untouched: it is the overwhelming majority of call sites and must not
        // change behavior or cost.
        private List<GExpression> TranslateArguments(SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            if (!arguments.Any(a => a.NameColon != null))
            {
                return arguments.Select(a => this.TranslateArgument(a)).ToList();
            }

            return this.TranslateNamedArguments(arguments);
        }

        // Reorders a named/mixed argument list into parameter DECLARATION order
        // (the only order a positional G# call can express), filling any optional
        // parameter skipped by the named arguments with its default value.
        //
        // C# evaluates call-site arguments in LEXICAL (source) order and binds by
        // name only afterward. Reordering into declaration order therefore changes
        // observable evaluation order when a moved argument may have a side effect
        // (a method call, object creation, assignment, increment, or await) — so
        // that case is reported unsupported instead of silently reordering side
        // effects (a source-order fallback is emitted so translation still
        // produces compiling, if diagnostically-flagged, output).
        private List<GExpression> TranslateNamedArguments(SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            var resolved = new List<(ArgumentSyntax Syntax, IParameterSymbol Parameter)>();
            foreach (ArgumentSyntax argument in arguments)
            {
                if (this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation operation ||
                    operation.Parameter == null)
                {
                    string message = "a named argument could not be resolved to a parameter via the semantic " +
                        "model; emitted in source order, which may mis-bind (issue #1727).";
                    this.context.ReportUnsupported(argument, message);
                    return arguments.Select(a => this.TranslateArgument(a)).ToList();
                }

                resolved.Add((argument, operation.Parameter));
            }

            for (int i = 0; i < resolved.Count; i++)
            {
                for (int j = i + 1; j < resolved.Count; j++)
                {
                    // resolved is in lexical (source) order by construction, so i < j
                    // is "before" lexically; declaration order disagrees whenever the
                    // ordinals are not increasing in the same direction.
                    bool declarationOrderAgrees = resolved[i].Parameter.Ordinal < resolved[j].Parameter.Ordinal;
                    if (!declarationOrderAgrees &&
                        (IsPotentiallySideEffecting(resolved[i].Syntax.Expression) ||
                            IsPotentiallySideEffecting(resolved[j].Syntax.Expression)))
                    {
                        string message = "named arguments reorder potentially side-effecting expressions " +
                            "relative to C#'s lexical evaluation order; no side-effect-preserving G# lowering " +
                            "yet (issue #1727).";
                        this.context.ReportUnsupported(resolved[i].Syntax, message);
                        return arguments.Select(a => this.TranslateArgument(a)).ToList();
                    }
                }
            }

            // A `params` parameter used in EXPANDED form (e.g. `Foo(x: 0, 1, 2, 3)`
            // for `Foo(int x, params int[] rest)`) makes several arguments share
            // the SAME `Parameter.Ordinal` (the params parameter's), which a plain
            // `ToDictionary` throws on. Source order already agrees with
            // declaration order whenever ordinals are non-decreasing in source
            // order (the common/legal case, since C# forbids a positional
            // argument from following a named one that skipped ahead) — that
            // needs no reordering at all, so just pass it through. Anything else
            // sharing an ordinal cannot be faithfully expressed as a dense
            // ordinal->argument map; report unsupported instead of crashing.
            bool ordinalsNonDecreasing = true;
            for (int i = 1; i < resolved.Count; i++)
            {
                if (resolved[i].Parameter.Ordinal < resolved[i - 1].Parameter.Ordinal)
                {
                    ordinalsNonDecreasing = false;
                    break;
                }
            }

            bool hasDuplicateOrdinal = resolved.Select(r => r.Parameter.Ordinal).Distinct().Count() != resolved.Count;
            if (hasDuplicateOrdinal)
            {
                if (ordinalsNonDecreasing)
                {
                    return arguments.Select(a => this.TranslateArgument(a)).ToList();
                }

                string message = "named arguments combined with a params argument in expanded form cannot be " +
                    "faithfully reordered (issue #1727).";
                this.context.ReportUnsupported(resolved[0].Syntax, message);
                return arguments.Select(a => this.TranslateArgument(a)).ToList();
            }

            Dictionary<int, ArgumentSyntax> byOrdinal = resolved.ToDictionary(r => r.Parameter.Ordinal, r => r.Syntax);
            int maxOrdinal = resolved.Max(r => r.Parameter.Ordinal);
            IMethodSymbol invokedMethod = resolved[0].Parameter.ContainingSymbol as IMethodSymbol;

            var result = new List<GExpression>();
            for (int ordinal = 0; ordinal <= maxOrdinal; ordinal++)
            {
                if (byOrdinal.TryGetValue(ordinal, out ArgumentSyntax explicitArgument))
                {
                    result.Add(this.TranslateArgument(explicitArgument));
                    continue;
                }

                IParameterSymbol skippedParameter = invokedMethod != null && ordinal < invokedMethod.Parameters.Length
                    ? invokedMethod.Parameters[ordinal]
                    : null;
                GExpression fillerDefault = this.BuildSkippedNamedArgumentDefault(skippedParameter, arguments);
                if (fillerDefault == null)
                {
                    return arguments.Select(a => this.TranslateArgument(a)).ToList();
                }

                result.Add(fillerDefault);
            }

            return result;
        }

        // Computes the positional filler for an optional parameter that a named
        // argument list skipped, or `null` (after reporting Unsupported) when no
        // faithful G# value can be emitted: a caller-info parameter
        // ([CallerMemberName]/[CallerLineNumber]/[CallerFilePath]/
        // [CallerArgumentExpression]) needs the value the C# compiler substitutes
        // at THIS call site, which the parameter's own default does not carry, and
        // a non-literal default (a `const` field, an enum member, etc.) has no
        // simple literal form (mirrors the declaration-side limitation already
        // accepted in BuildOptionalParameterDefault).
        private GExpression BuildSkippedNamedArgumentDefault(IParameterSymbol skippedParameter, SeparatedSyntaxList<ArgumentSyntax> arguments)
        {
            if (skippedParameter == null)
            {
                string message = "a named argument list skips a parameter that could not be resolved via the " +
                    "semantic model (issue #1727).";
                this.context.ReportUnsupported(arguments.First(), message);
                return null;
            }

            bool hasCallerInfo = skippedParameter.GetAttributes().Any(a => a.AttributeClass?.Name is
                "CallerMemberNameAttribute" or "CallerLineNumberAttribute" or
                "CallerFilePathAttribute" or "CallerArgumentExpressionAttribute");
            if (hasCallerInfo)
            {
                string message = $"named argument list skips caller-info parameter '{skippedParameter.Name}'; " +
                    "its call-site-substituted value has no faithful G# positional form yet (issue #1727).";
                this.context.ReportUnsupported(arguments.First(), message);
                return null;
            }

            GTypeReference parameterType = this.typeMapper.Map(
                skippedParameter.Type,
                this.context,
                skippedParameter.Locations.FirstOrDefault());
            GExpression fillerDefault = this.BuildOptionalParameterDefault(skippedParameter, parameterType, arguments.First());
            if (fillerDefault == null)
            {
                string message = $"named argument list skips parameter '{skippedParameter.Name}' whose default " +
                    "value is not a simple literal; no faithful G# positional form yet (issue #1727).";
                this.context.ReportUnsupported(arguments.First(), message);
            }

            return fillerDefault;
        }

        // Conservative "no observable side effect" check used only to decide
        // whether reordering a named argument into declaration position is safe
        // (issue #1727). A bare literal or a plain identifier/member-access chain
        // that never invokes anything reads state without changing it; everything
        // else (calls, object creation, assignment, increment/decrement, await,
        // and — conservatively — any operator, since it may be an overloaded
        // operator with side effects) is treated as potentially side-effecting.
        private static bool IsPotentiallySideEffecting(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case null:
                case LiteralExpressionSyntax:
                case IdentifierNameSyntax:
                case ThisExpressionSyntax:
                case PredefinedTypeSyntax:
                    return false;
                case ParenthesizedExpressionSyntax parenthesized:
                    return IsPotentiallySideEffecting(parenthesized.Expression);
                case MemberAccessExpressionSyntax memberAccess:
                    return IsPotentiallySideEffecting(memberAccess.Expression);
                case PrefixUnaryExpressionSyntax prefixUnary
                    when prefixUnary.IsKind(SyntaxKind.UnaryMinusExpression) || prefixUnary.IsKind(SyntaxKind.UnaryPlusExpression):
                    return IsPotentiallySideEffecting(prefixUnary.Operand);
                default:
                    return true;
            }
        }

        private GExpression TranslateArgument(ArgumentSyntax argument)
        {
            SyntaxKind refKind = argument.RefKindKeyword.Kind();
            if (refKind == SyntaxKind.OutKeyword)
            {
                if (argument.Expression is DeclarationExpressionSyntax declaration)
                {
                    return declaration.Designation switch
                    {
                        DiscardDesignationSyntax => new OutArgumentExpression("out", "_"),
                        SingleVariableDesignationSyntax single => new OutArgumentExpression("out var", SanitizeIdentifier(single.Identifier.Text)),
                        _ => new UnaryExpression("&", this.TranslateExpression(argument.Expression)),
                    };
                }

                if (argument.Expression is IdentifierNameSyntax { Identifier.Text: "_" })
                {
                    return new OutArgumentExpression("out", "_");
                }

                // `out existingVar` (pre-declared): pass by address (legacy form).
                return new UnaryExpression("&", this.TranslateExpression(argument.Expression));
            }

            if (refKind == SyntaxKind.RefKeyword)
            {
                return new UnaryExpression("&", this.TranslateExpression(argument.Expression));
            }

            // A declared-nullable reference argument that C# flow analysis has
            // narrowed to non-null (e.g. a `string?` field read inside an
            // `if (field == null) … else …` guard) is passed by value, but G#
            // smart-casts narrow only LOCALS — the field/property keeps its `T?`
            // type, so a non-null `T` parameter rejects it (GS0156). The existing
            // receiver null-forgiveness pass already gates on flow-proven non-null
            // AND a declared-nullable reference symbol, so asserting `!!` here is
            // always runtime-safe and widens cleanly to a `T?` parameter too.
            // `nameof(x)` takes a name reference, not a value, so `nameof(x!!)`
            // is rejected (GS0190) — never assert inside a `nameof` argument.
            if (!IsNameOfArgument(argument) && this.ReceiverNeedsNullForgiveness(argument.Expression))
            {
                return new NonNullAssertionExpression(this.TranslateExpression(argument.Expression));
            }

            // A C# argument whose declared numeric type differs from the type C#
            // implicitly converted it to at the call site (e.g. a `ushort` constant
            // passed where generic inference selected `int`, or a signed literal
            // passed to an unsigned parameter) may need that conversion made
            // explicit: gsc applies the implicit lossless-widening lattice and the
            // constant-expression narrowing at fixed parameters, but NOT a
            // non-constant narrowing/cross-sign value, nor a widening-only argument
            // to a generic CLR parameter (whose inference would fail — GS0159).
            // CoerceNumericArgumentToConverted (issue #1281) emits the bare operand
            // when gsc accepts the conversion on its own and keeps the explicit
            // `T(x)` wrap only where gsc still needs it.
            return this.CoerceNumericArgumentToConverted(
                argument,
                this.TranslateExpression(argument.Expression));
        }

        // Coerce an argument expression to the numeric type C# implicitly converted
        // it to at the call site, when that converted type differs from the
        // expression's own numeric type AND gsc would not perform that conversion
        // implicitly. Issue #1281: gsc already widens (ADR-0044) and constant-narrows
        // (C# §10.2.11) at a concrete numeric parameter, so the explicit G# wrap is
        // emitted only for the residual cases gsc still rejects — a non-constant
        // narrowing/cross-sign value, or a widening argument bound to a generic
        // (type-parameter) parameter.
        private GExpression CoerceNumericArgumentToConverted(ArgumentSyntax argument, GExpression translated)
        {
            ExpressionSyntax expression = argument.Expression;

            // gsc performs this implicit numeric conversion at the call site
            // itself — the explicit conversion would be redundant.
            if (this.GSharpAcceptsImplicitNumericArgument(argument))
            {
                return translated;
            }

            // A numeric literal is already retyped to its C# converted type by the
            // literal-translation path (a float-promoted literal becomes a float
            // literal `30.0`, ADR-0115 §B.12), so re-wrapping it here would double
            // up the conversion. Constant signed→unsigned literal retyping is still
            // applied below for integer targets.
            if (expression is LiteralExpressionSyntax literal &&
                literal.IsKind(SyntaxKind.NumericLiteralExpression))
            {
                return this.CoerceConstantToUnsigned(expression, translated);
            }

            TypeInfo info = this.context.GetTypeInfo(expression);
            if (TryGetNumericKind(info.Type, out SpecialType sourceUnderlying) &&
                TryGetNumericKind(info.ConvertedType, out SpecialType convertedUnderlying) &&
                sourceUnderlying != convertedUnderlying)
            {
                return this.CoerceOperandTo(translated, info.ConvertedType);
            }

            return translated;
        }

        // Issue #1281: reports whether gsc applies, on its own, the implicit numeric
        // conversion C# performed on this argument — so the explicit G# conversion
        // wrap is redundant. True only when the source and C#-converted types are
        // differing numeric primitives, the argument binds to a CONCRETE numeric
        // parameter (a generic/type-parameter target still needs the wrap because
        // CLR-method inference does not unify widening-only numeric args), and the
        // conversion is either a gsc lossless widening (ADR-0044) or a constant
        // integer LITERAL whose value C# already proved fits the target type
        // (matching gsc's literal-only call-site constant folding, ADR-0129).
        private bool GSharpAcceptsImplicitNumericArgument(ArgumentSyntax argument)
        {
            ExpressionSyntax expression = argument.Expression;
            TypeInfo info = this.context.GetTypeInfo(expression);
            if (!TryGetNumericKind(info.Type, out SpecialType source) ||
                !TryGetNumericKind(info.ConvertedType, out SpecialType converted) ||
                source == converted)
            {
                return false;
            }

            if (!this.TargetsConcreteNumericParameter(argument))
            {
                return false;
            }

            if (IsGSharpImplicitNumericWidening(source, converted))
            {
                return true;
            }

            // A non-widening (narrowing / cross-sign) conversion is implicit in gsc
            // only for a constant integer literal (or unary +/- over one); C# already
            // proved the value is in range by compiling the implicit conversion.
            return IsFoldableIntegerLiteral(expression);
        }

        // Reports whether the argument binds to a parameter whose ORIGINAL-definition
        // type is a concrete numeric primitive. For a generic method the constructed
        // parameter type is the inferred concrete type, but the original is the type
        // parameter `T` — which is excluded so a widening argument to a generic CLR
        // method keeps its explicit conversion (issue #1281).
        private bool TargetsConcreteNumericParameter(ArgumentSyntax argument)
        {
            if (this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation argumentOperation)
            {
                return false;
            }

            IParameterSymbol parameter = argumentOperation.Parameter;
            if (parameter == null)
            {
                return false;
            }

            return TryGetNumericKind(parameter.OriginalDefinition.Type, out _);
        }

        // Mirrors gsc's TryGetConstantIntegerValue (ExpressionBinder.Operators.cs):
        // a foldable constant integer expression is an integer numeric literal, or a
        // unary +/- applied (recursively) to one. Floating/decimal literals and any
        // other constant form (e.g. a `const` field or `ushort.MaxValue`) are NOT
        // folded by gsc and therefore keep their explicit call-site conversion.
        private static bool IsFoldableIntegerLiteral(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case LiteralExpressionSyntax literal when literal.IsKind(SyntaxKind.NumericLiteralExpression):
                    return literal.Token.Value is sbyte or byte or short or ushort or int or uint or long or ulong;
                case PrefixUnaryExpressionSyntax unary
                    when unary.IsKind(SyntaxKind.UnaryMinusExpression) || unary.IsKind(SyntaxKind.UnaryPlusExpression):
                    return IsFoldableIntegerLiteral(unary.Operand);
                default:
                    return false;
            }
        }

        // gsc's ADR-0044 implicit numeric widening lattice (mirrors
        // Conversion.NumericWideningTargets), keyed on the C# SpecialType of the
        // source → set of widening targets. `char` widens like an unsigned 16-bit
        // integer; `decimal` is a widening target of every integral source.
        private static bool IsGSharpImplicitNumericWidening(SpecialType source, SpecialType target)
        {
            return NumericWideningTargets.TryGetValue(source, out HashSet<SpecialType> targets) &&
                targets.Contains(target);
        }

        // `nameof(x)` takes a name reference, not a value, so its argument must
        // never be wrapped in a `!!` non-null assertion (GS0190).
        private static bool IsNameOfArgument(ArgumentSyntax argument)
        {
            return argument.Parent?.Parent is InvocationExpressionSyntax
            {
                Expression: IdentifierNameSyntax { Identifier.Text: "nameof" },
            };
        }

        private GExpression TranslateObjectCreation(ObjectCreationExpressionSyntax creation)
        {
            ITypeSymbol typeSymbol = this.context.GetTypeInfo(creation).Type;
            GTypeReference type = typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
                : new NamedTypeReference(creation.Type.ToString());

            var arguments = creation.ArgumentList == null
                ? new List<GExpression>()
                : this.TranslateArguments(creation.ArgumentList.Arguments);

            // A C# delegate creation `new SomeDelegate(target)` wraps a method
            // group, lambda, or another delegate in a named delegate type. G# has
            // no delegate wrapper type: a delegate value IS a function value
            // (ADR-0115 function types). The wrapping constructor is therefore
            // redundant — unwrap it to the sole target expression. Constructing the
            // mapped delegate type directly would fail because a delegate maps to an
            // `ArrowTypeReference` (a structural function type), not a callable named
            // type, and would otherwise leak the AST node's CLR type name.
            if (typeSymbol is INamedTypeSymbol { TypeKind: TypeKind.Delegate } &&
                arguments.Count == 1)
            {
                return arguments[0];
            }

            return this.BuildObjectCreationCore(typeSymbol, type, arguments, creation.Initializer);
        }

        /// <summary>
        /// Shared core for <see cref="TranslateObjectCreation"/> and
        /// <see cref="TranslateImplicitObjectCreation"/> (issue #1728): both entry
        /// points map the same C# constructor-call-plus-initializer shapes to the
        /// same G# forms, and had already drifted apart before this method
        /// existed (a struct-zip guard present on only one path; a verbatim
        /// re-inline of <see cref="BuildConstruction"/>). Routing both through
        /// one method makes that drift structurally impossible.
        /// </summary>
        private GExpression BuildObjectCreationCore(
            ITypeSymbol typeSymbol,
            GTypeReference type,
            IReadOnlyList<GExpression> arguments,
            InitializerExpressionSyntax initializer)
        {
            bool hasCtorArgs = arguments.Count > 0;

            // A C# collection initializer maps to the canonical G# collection
            // initializer `Target{ ... }` (ADR-0117, issue #479). This covers
            // `new List<int>{1, 2, 3}` (bare elements), `new Dictionary<K,V>{ {k, v} }`
            // (complex element initializers → `k: v` pairs), and
            // `new Dictionary<K,V>{ ["k"] = v }` (indexer entries). The construction
            // target carries any constructor arguments, matching
            // `new(StringComparer.OrdinalIgnoreCase){ ... }`.
            if (initializer != null &&
                this.TryTranslateCollectionInitializer(initializer, type, arguments, out GExpression collectionInitializer))
            {
                return collectionInitializer;
            }

            if (initializer != null && initializer.IsKind(SyntaxKind.ObjectInitializerExpression))
            {
                // An object initializer `new T { Field = value, ... }` with NO
                // constructor argument list maps to the canonical G# struct
                // literal `T{Field: value, ...}` (spec §Struct literals; ADR-0115
                // §B.11).
                if (!hasCtorArgs)
                {
                    return this.BuildObjectInitializerLiteral(initializer, type);
                }

                // Issue #1728: `new T(a, b) { Field = value, ... }` combines
                // constructor arguments WITH an object initializer. Neither the
                // colon struct literal above nor a bare construction call has a
                // slot for both a positional constructor call and member
                // assignments — falling through to a bare `BuildConstruction`
                // here (the original bug) silently drops every assignment. gsc's
                // construction-with-initializer-suffix form (issue #522,
                // `Target(args) { Field = value, ... }`) is built for exactly
                // this: it lowers to a synthetic local, the assignments, then a
                // trailing value, so it composes at any expression position —
                // no hoisted-temp workaround is needed.
                return this.BuildConstructionWithInitializerSuffix(initializer, type, arguments);
            }

            // A source-defined value aggregate (`struct` / `data struct`) has no
            // callable constructor surface in G#: it is constructed with a struct
            // literal `T{Field: value, ...}` (spec §Struct literals). Map the
            // positional C# `new T(a, b)` to that literal by zipping the arguments
            // with the type's settable instance members in declaration order
            // (ADR-0115 §B.4). Imported/BCL structs (e.g. `Guid`, `DateTime`,
            // `Span<T>` — all `SpecialType.None`) DO expose real constructors that
            // G# can call directly (`Guid(bytes, true)`), so they must fall through
            // to a constructor call rather than be zipped into a bogus literal over
            // the type's *properties*. An initializer here (reachable only when it
            // wasn't a plain object initializer, e.g. an unsupported collection
            // initializer shape) has no field to zip into either, so it must NOT
            // be silently absorbed into a bogus zip — skip straight to
            // `BuildConstruction` and let the initializer's own diagnostic stand.
            if (initializer == null &&
                typeSymbol is INamedTypeSymbol { TypeKind: TypeKind.Struct, SpecialType: SpecialType.None } valueType &&
                !valueType.IsTupleType &&
                !valueType.DeclaringSyntaxReferences.IsEmpty)
            {
                // A parameterless `new T()` on a source value struct has no callable
                // constructor surface in G# either; the default (zero-initialised)
                // value is the empty struct literal `T{}`. Emitting a `T()` call here
                // would surface as GS0130 ("function 'T' doesn't exist").
                if (arguments.Count == 0)
                {
                    return new CompositeLiteralExpression(type, new List<FieldInitializer>());
                }

                List<string> targetNames = OrderedValueMemberNames(valueType);
                if (targetNames.Count == arguments.Count)
                {
                    var fieldInitializers = new List<FieldInitializer>();
                    for (int i = 0; i < arguments.Count; i++)
                    {
                        fieldInitializers.Add(new FieldInitializer(targetNames[i], arguments[i]));
                    }

                    return new CompositeLiteralExpression(type, fieldInitializers);
                }
            }

            return BuildConstruction(type, arguments);
        }

        /// <summary>
        /// Builds the canonical G# construction expression for a C# <c>new</c>:
        /// a call on the type name carrying any bracket type arguments
        /// (<c>List[int32](...)</c>, ADR-0115 §B.7).
        /// </summary>
        private static GExpression BuildConstruction(GTypeReference type, IReadOnlyList<GExpression> arguments)
        {
            if (type is NamedTypeReference named)
            {
                IReadOnlyList<GTypeReference> typeArguments = named.TypeArguments.Count > 0
                    ? named.TypeArguments
                    : null;
                return new InvocationExpression(
                    new IdentifierExpression(ConstructionCalleeName(named.Name)),
                    arguments,
                    typeArguments);
            }

            return new InvocationExpression(new IdentifierExpression(type.ToString()), arguments);
        }

        /// <summary>
        /// Maps a constructed type's G# name to a callable construction callee.
        /// A G# primitive type keyword (<c>object</c>, <c>string</c>, <c>decimal</c>,
        /// …) is a language keyword, not a function, so constructing one
        /// (<c>new object()</c>, <c>new string(' ', n)</c>, target-typed <c>new()</c>)
        /// must spell the qualified CLR type name instead (e.g. <c>System.Object</c>,
        /// <c>System.String</c>) — otherwise gsc reports GS0130 ("Function 'string'
        /// doesn't exist"). Non-keyword type names are returned unchanged.
        /// </summary>
        private static string ConstructionCalleeName(string typeName) => typeName switch
        {
            "object" => "System.Object",
            "string" => "System.String",
            "bool" => "System.Boolean",
            "char" => "System.Char",
            "decimal" => "System.Decimal",
            "int8" => "System.SByte",
            "uint8" => "System.Byte",
            "int16" => "System.Int16",
            "uint16" => "System.UInt16",
            "int32" => "System.Int32",
            "uint32" => "System.UInt32",
            "int64" => "System.Int64",
            "uint64" => "System.UInt64",
            "float32" => "System.Single",
            "float64" => "System.Double",
            _ => typeName,
        };

        /// <summary>
        /// Builds the canonical G# struct literal <c>T{Field: value, ...}</c> from a
        /// C# object initializer (<c>{ Field = value, ... }</c>), used by both the
        /// explicit (<c>new T { ... }</c>) and target-typed (<c>new() { ... }</c>)
        /// construction paths (spec §Struct literals; ADR-0115 §B.11).
        /// </summary>
        private GExpression BuildObjectInitializerLiteral(InitializerExpressionSyntax initializer, GTypeReference type)
        {
            var fieldInitializers = new List<FieldInitializer>();
            foreach (ExpressionSyntax element in initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name)
                {
                    // Issue #1567: a nested collection/object initializer as the
                    // assignment RHS (`Prop = { a, b }` / `Prop = { ["k"] = v }`)
                    // is the C# collection-initializer-in-object-initializer
                    // pattern — it POPULATES a (typically get-only) collection
                    // property via `Add(...)` rather than ASSIGNING it. Emit the
                    // target-less member collection-initializer form
                    // `Prop: { … }` that gsc lowers to `receiver.Prop.Add(x)`,
                    // preserving the element shapes (bare / keyed / indexed). A
                    // plain array/object initializer would wrongly render as an
                    // assignment and hit GS0127 for a get-only property.
                    if (assignment.Right is InitializerExpressionSyntax nestedInit &&
                        (nestedInit.IsKind(SyntaxKind.CollectionInitializerExpression) ||
                         nestedInit.IsKind(SyntaxKind.ObjectInitializerExpression)))
                    {
                        List<CollectionInitializerElement> memberElements =
                            this.TranslateCollectionInitializerElements(nestedInit);
                        if (memberElements != null)
                        {
                            fieldInitializers.Add(new FieldInitializer(
                                SanitizeIdentifier(name.Identifier.Text),
                                new CollectionInitializerExpression(target: null, memberElements)));
                            continue;
                        }
                    }

                    fieldInitializers.Add(new FieldInitializer(
                        SanitizeIdentifier(name.Identifier.Text),
                        this.TranslateExpression(assignment.Right)));
                }
                else
                {
                    this.context.ReportUnsupported(
                        element,
                        "object-initializer element is not a simple `Field = value` assignment; no canonical G# struct-literal form yet (ADR-0115 §B.11).");
                }
            }

            return new CompositeLiteralExpression(type, fieldInitializers);
        }

        /// <summary>
        /// Builds the canonical G# construction-with-initializer-suffix
        /// <c>Target(args) { Name = value, ... }</c> (gsc issue #522) for a C#
        /// object initializer combined with constructor arguments (issue #1728):
        /// <c>new T(a, b) { Field = value, ... }</c>. Unlike
        /// <see cref="BuildObjectInitializerLiteral"/> (the colon struct-literal
        /// form, no ctor args), this suffix parses each member value as a plain
        /// expression (gsc's <c>ParseObjectInitializerList</c> → <c>ParseExpression</c>)
        /// — it has no target-less collection-initializer carve-out (issue #1567),
        /// so a nested <c>Prop = { a, b }</c> member has no canonical form here yet
        /// and is reported as unsupported instead of silently dropped.
        /// </summary>
        private GExpression BuildConstructionWithInitializerSuffix(
            InitializerExpressionSyntax initializer,
            GTypeReference type,
            IReadOnlyList<GExpression> arguments)
        {
            GExpression construction = BuildConstruction(type, arguments);
            var memberInitializers = new List<FieldInitializer>();
            foreach (ExpressionSyntax element in initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name)
                {
                    if (assignment.Right is InitializerExpressionSyntax nestedInit &&
                        (nestedInit.IsKind(SyntaxKind.CollectionInitializerExpression) ||
                         nestedInit.IsKind(SyntaxKind.ObjectInitializerExpression)))
                    {
                        this.context.ReportUnsupported(
                            assignment,
                            "nested collection/object initializer as a member value has no canonical G# form when the outer object creation also has constructor arguments; gsc's construction-with-initializer-suffix form (issue #522) has no target-less collection-initializer carve-out (issue #1728).");
                        continue;
                    }

                    memberInitializers.Add(new FieldInitializer(
                        SanitizeIdentifier(name.Identifier.Text),
                        this.TranslateExpression(assignment.Right)));
                }
                else
                {
                    this.context.ReportUnsupported(
                        element,
                        "object-initializer element is not a simple `Field = value` assignment; no canonical G# construction-with-initializer-suffix form yet (issue #1728).");
                }
            }

            return new ObjectCreationInitializerExpression(construction, memberInitializers);
        }

        /// <summary>
        /// Attempts to translate a C# collection initializer into a canonical G#
        /// collection initializer (ADR-0117). Returns <see langword="false"/> when
        /// the initializer is not a collection initializer (e.g. a plain object
        /// initializer), leaving the caller's other mappings to apply.
        /// </summary>
        private bool TryTranslateCollectionInitializer(
            InitializerExpressionSyntax initializer,
            GTypeReference type,
            IReadOnlyList<GExpression> arguments,
            out GExpression result)
        {
            result = null;

            bool isCollectionInitializer = initializer.IsKind(SyntaxKind.CollectionInitializerExpression);
            bool isIndexedObjectInitializer = initializer.IsKind(SyntaxKind.ObjectInitializerExpression) &&
                initializer.Expressions.Count > 0 &&
                initializer.Expressions.All(e =>
                    e is AssignmentExpressionSyntax { Left: ImplicitElementAccessSyntax });

            if (!isCollectionInitializer && !isIndexedObjectInitializer)
            {
                return false;
            }

            List<CollectionInitializerElement> elements = this.TranslateCollectionInitializerElements(initializer);
            if (elements == null)
            {
                return false;
            }

            GExpression construction = BuildConstruction(type, arguments);
            result = new CollectionInitializerExpression(construction, elements);
            return true;
        }

        /// <summary>
        /// Translates the elements of a C# collection initializer into canonical
        /// G# <see cref="CollectionInitializerElement"/>s (bare, keyed, or
        /// indexed). Returns <see langword="null"/> when an element has no
        /// canonical G# form (an unsupported diagnostic is reported). Shared by
        /// the standalone collection initializer (ADR-0117) and the member
        /// collection initializer used to populate a get-only collection property
        /// at construction (issue #1567, <c>Prop = { … }</c>).
        /// </summary>
        private List<CollectionInitializerElement> TranslateCollectionInitializerElements(
            InitializerExpressionSyntax initializer)
        {
            var elements = new List<CollectionInitializerElement>();
            foreach (ExpressionSyntax element in initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax { Left: ImplicitElementAccessSyntax indexAccess } indexedAssignment)
                {
                    // `["k"] = v` → indexed element.
                    if (indexAccess.ArgumentList.Arguments.Count != 1)
                    {
                        this.context.ReportUnsupported(
                            element,
                            "multi-argument indexer initializer has no canonical G# collection-initializer form (ADR-0117).");
                        return null;
                    }

                    elements.Add(new CollectionInitializerElement(
                        this.TranslateExpression(indexAccess.ArgumentList.Arguments[0].Expression),
                        this.TranslateExpression(indexedAssignment.Right),
                        indexed: true));
                }
                else if (element is InitializerExpressionSyntax { } complex &&
                    element.IsKind(SyntaxKind.ComplexElementInitializerExpression))
                {
                    // `{k, v}` → keyed element `k: v` (dictionary Add(k, v)).
                    if (complex.Expressions.Count != 2)
                    {
                        this.context.ReportUnsupported(
                            element,
                            "collection initializer element with other than two values has no canonical G# form (ADR-0117).");
                        return null;
                    }

                    elements.Add(new CollectionInitializerElement(
                        this.TranslateExpression(complex.Expressions[0]),
                        this.TranslateExpression(complex.Expressions[1]),
                        indexed: false));
                }
                else
                {
                    // Bare element `e` → `Add(e)`.
                    elements.Add(new CollectionInitializerElement(this.TranslateExpression(element)));
                }
            }

            return elements;
        }

        private static List<string> OrderedValueMemberNames(INamedTypeSymbol valueType)
        {
            // Settable instance members in declaration order: positional `data
            // struct` parameters surface as auto-properties, a hand-written
            // `struct` exposes auto-properties or fields; either maps to the
            // struct-literal field list.
            var props = valueType.GetMembers()
                .OfType<IPropertySymbol>()
                .Where(p => !p.IsStatic && !p.IsIndexer && p.GetMethod != null)
                .Select(p => p.Name)
                .ToList();
            if (props.Count > 0)
            {
                return props;
            }

            return valueType.GetMembers()
                .OfType<IFieldSymbol>()
                .Where(f => !f.IsStatic && !f.IsImplicitlyDeclared)
                .Select(f => f.Name)
                .ToList();
        }

        private GExpression TranslateCast(CastExpressionSyntax cast)
        {
            // C# explicit cast `(T)expr` maps to the canonical G# width-bearing
            // conversion-call form `T(expr)` (spec §Types and values; ADR-0115
            // §B.12). For floating→integral conversions the CLR truncates toward
            // zero, matching the C# `(int)` truncation semantics, so e.g.
            // `(int)Math.Floor(d + 0.5)` is behavior-faithful.
            ITypeSymbol targetSymbol = this.context.GetTypeInfo(cast.Type).Type;
            GTypeReference targetType = targetSymbol != null
                ? this.typeMapper.Map(targetSymbol, this.context, cast.Type.GetLocation())
                : new NamedTypeReference(cast.Type.ToString());

            return new ConversionExpression(targetType, this.TranslateExpression(cast.Expression));
        }

        private GExpression TranslateWith(WithExpressionSyntax with)
        {
            // C# `expr with { Field = value, ... }` maps to the canonical G#
            // copy/update form `expr with { Field = value, ... }` for data
            // structs / data classes (spec §Struct literals; ADR-0115 §B.4). The
            // update fields keep `=` (distinct from the `:` of a struct literal).
            var updates = new List<FieldInitializer>();
            foreach (ExpressionSyntax element in with.Initializer.Expressions)
            {
                if (element is AssignmentExpressionSyntax assignment &&
                    assignment.Left is IdentifierNameSyntax name)
                {
                    updates.Add(new FieldInitializer(
                        SanitizeIdentifier(name.Identifier.Text),
                        this.TranslateExpression(assignment.Right)));
                }
                else
                {
                    this.context.ReportUnsupported(
                        element,
                        "with-expression element is not a simple `Field = value` assignment; no canonical G# copy/update form yet (ADR-0115 §B.4).");
                }
            }

            return new WithExpression(this.TranslateExpression(with.Expression), updates);
        }

        private IReadOnlyList<GTypeReference> MapTypeArguments(GenericNameSyntax generic)
        {
            var result = new List<GTypeReference>();
            foreach (TypeSyntax argument in generic.TypeArgumentList.Arguments)
            {
                ITypeSymbol symbol = this.context.GetTypeInfo(argument).Type;
                result.Add(symbol != null
                    ? this.typeMapper.Map(symbol, this.context, argument.GetLocation())
                    : new NamedTypeReference(argument.ToString()));
            }

            return result;
        }

        private GExpression TranslateInterpolatedString(InterpolatedStringExpressionSyntax interpolated)
        {
            var parts = new List<InterpolationPart>();
            foreach (InterpolatedStringContentSyntax content in interpolated.Contents)
            {
                switch (content)
                {
                    case InterpolatedStringTextSyntax text:
                        parts.Add(InterpolationPart.Literal(text.TextToken.ValueText));
                        break;

                    case InterpolationSyntax hole:
                        string alignment = hole.AlignmentClause?.Value.ToString();
                        string format = hole.FormatClause?.FormatStringToken.ValueText;
                        parts.Add(InterpolationPart.Hole(
                            this.TranslateExpression(hole.Expression),
                            alignment,
                            format));
                        break;
                }
            }

            return new InterpolatedStringExpression(parts);
        }

        private GExpression TranslateLambda(AnonymousFunctionExpressionSyntax lambda)
        {
            var parameters = new List<Parameter>();
            ParameterListSyntax parameterList = lambda switch
            {
                ParenthesizedLambdaExpressionSyntax paren => paren.ParameterList,
                _ => null,
            };

            if (lambda is SimpleLambdaExpressionSyntax simple)
            {
                parameters.Add(this.MapLambdaParameter(simple.Parameter));
            }
            else if (parameterList != null)
            {
                foreach (ParameterSyntax parameter in parameterList.Parameters)
                {
                    parameters.Add(this.MapLambdaParameter(parameter));
                }
            }

            bool isAsync = lambda.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword);

            // A block-bodied lambda's body is its own evaluation scope: a spill
            // hoisted while translating it (issue #1731) must never leak into the
            // ENCLOSING statement's prologue (that would evaluate the operand
            // once, eagerly, at the lambda's definition instead of per
            // invocation). The ambient seam is suspended around the block body;
            // each statement inside it still opens its own fresh seam via
            // <see cref="TranslateStatement"/>. The assignment-/expression-bodied
            // branches below instead open their OWN fresh seam via
            // <see cref="WithSpillSeam"/> (rather than being suspended outright),
            // since they have no per-statement seam of their own to fall back on.
            List<GStatement> outerSpillPrologue = this.pendingSpillPrologue;
            this.pendingSpillPrologue = null;

            // Issue #1736: a lambda is its own mutability/reference-scan scope,
            // regardless of WHERE the lambda appears. `currentBodyScope` drives
            // `IsSymbolReassigned` (via `IsLocalReassigned`/`WithParameterShadows`),
            // which treats a null scope as "never reassigned" — correct only when
            // reached from a normal method/accessor body (already scoped by
            // <see cref="TranslateBody"/>). A lambda translated OUTSIDE any body —
            // a field/property initializer, a folded static-ctor RHS, a ctor
            // `base(...)`/`this(...)` argument, an attribute argument, etc. — left
            // `currentBodyScope` null, so a local declared and reassigned entirely
            // inside the lambda (e.g. `Func<int> f = () => { int i = 0; i++; return
            // i; };`) was misclassified as immutable and emitted `let i = 0`
            // followed by an illegal `i++`. Narrowing the scope to the lambda node
            // itself here — rather than only widening it at each out-of-body call
            // site — fixes every such position at once and is idempotent when the
            // lambda is already inside a normal body: the narrower scope is a
            // subset of the enclosing one that still contains the lambda's own
            // reassignments, so nothing that worked before regresses.
            SyntaxNode previousBodyScope = this.currentBodyScope;
            this.currentBodyScope = lambda;
            try
            {
                if (lambda.Body is BlockSyntax block)
                {
                    // ADR-0128 / issue #1172: a block-bodied C# lambda renders as the
                    // idiomatic G# arrow form `(params) -> { … }`. The arrow lambda's
                    // statement-block body now reaches parity with func literals and
                    // infers its return type, so no explicit return type is emitted.
                    return new LambdaExpression(
                        parameters,
                        blockBody: this.TranslateBlock(block),
                        isAsync: isAsync);
                }

                if (lambda.Body is AssignmentExpressionSyntax)
                {
                    // An assignment is statement-only in G#; an assignment-bodied lambda
                    // (`o => x = f()`) becomes a block-bodied arrow lambda. An assignment
                    // has no value, so the resulting arrow lambda is void (ADR-0128).
                    return new LambdaExpression(
                        parameters,
                        blockBody: new BlockStatement(this.WithSpillSeam(
                            () => this.TranslateExpressionStatements((ExpressionSyntax)lambda.Body).ToList()).ToList()),
                        isAsync: isAsync);
                }

                // A value-returning expression-bodied lambda (`x => x.Get() is {…}`)
                // has no statement seam of its own; open one via
                // <see cref="WithSpillSeam"/> so a nested spill (issue #1731) lands
                // here rather than being dropped. If nothing spilled, keep the
                // idiomatic arrow-expression form; otherwise the lambda must
                // become block-bodied to host the spill's `let`, ending in an
                // explicit `return`.
                var spillPrologue = new List<GStatement>();
                List<GStatement> savedSeam = this.pendingSpillPrologue;
                this.pendingSpillPrologue = spillPrologue;
                GExpression expressionBody;
                try
                {
                    expressionBody = this.TranslateExpression((ExpressionSyntax)lambda.Body);
                }
                finally
                {
                    this.pendingSpillPrologue = savedSeam;
                }

                if (spillPrologue.Count == 0)
                {
                    return new LambdaExpression(parameters, expressionBody: expressionBody, isAsync: isAsync);
                }

                var bodyStatements = new List<GStatement>(spillPrologue) { new ReturnStatement(expressionBody) };
                return new LambdaExpression(parameters, blockBody: new BlockStatement(bodyStatements), isAsync: isAsync);
            }
            finally
            {
                this.pendingSpillPrologue = outerSpillPrologue;
                this.currentBodyScope = previousBodyScope;
            }
        }

        // Shared mapping of a method/lambda result type into a G# func return type,
        // applying the `async` unwrap rule: a G# `async func` declares the UNWRAPPED
        // result, so C# `async Task` → null (void) and `async Task<T>` → `T`.
        private GTypeReference MapDelegateLikeReturnType(IMethodSymbol symbol, bool isAsync, Location location)
        {
            if (symbol.ReturnsVoid)
            {
                return null;
            }

            ITypeSymbol returnType = symbol.ReturnType;

            if (isAsync &&
                returnType is INamedTypeSymbol { Name: "Task" } task &&
                task.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
            {
                return task.IsGenericType
                    ? this.typeMapper.Map(task.TypeArguments[0], this.context, location)
                    : null;
            }

            return this.typeMapper.Map(returnType, this.context, location);
        }

        private Parameter MapLambdaParameter(ParameterSyntax parameter)
        {
            // A lambda parameter's type is inferred by Roslyn from the delegate
            // target even when the C# spelling omits it (`n => …`); the canonical
            // G# arrow lambda always names the parameter type (ADR-0074).
            if (this.context.GetDeclaredSymbol(parameter) is IParameterSymbol symbol)
            {
                return this.MapParameter(symbol, parameter);
            }

            GTypeReference type = parameter.Type != null
                ? this.MapTypeSyntax(parameter.Type)
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
            return new Parameter(SanitizeIdentifier(parameter.Identifier.Text), type);
        }

        // `typeof(IEnumerable<>)` over an unbound generic has no bound symbol for
        // the omitted type argument, so the general type mapper cannot resolve it.
        // G# has no open-generic `typeof` spelling; the canonical form is the bare
        // generic definition name (`typeof(IEnumerable)`), which parses and binds
        // to the open type.
        private GTypeReference MapTypeOfOperand(TypeSyntax type)
        {
            if (IsUnboundGeneric(type, out string unboundName))
            {
                return new NamedTypeReference(unboundName);
            }

            return this.MapTypeSyntax(type);
        }

        private static bool IsUnboundGeneric(TypeSyntax type, out string name)
        {
            name = null;
            GenericNameSyntax generic = type switch
            {
                GenericNameSyntax g => g,
                QualifiedNameSyntax { Right: GenericNameSyntax g } => g,
                _ => null,
            };

            if (generic is null ||
                !generic.TypeArgumentList.Arguments.Any(a => a is OmittedTypeArgumentSyntax))
            {
                return false;
            }

            name = generic.Identifier.Text;
            return true;
        }

        private GTypeReference MapTypeSyntax(TypeSyntax type)
        {
            ITypeSymbol symbol = this.context.GetTypeInfo(type).Type;
            return symbol != null
                ? this.typeMapper.Map(symbol, this.context, type.GetLocation())
                : new NamedTypeReference(type.ToString());
        }

        private GExpression TranslatePredefinedTypeExpression(PredefinedTypeSyntax predefined)
        {
            // A C# predefined type used as an expression receiver (`string.Concat`,
            // `int.Parse`) is a static-call target; G# resolves the BCL type name
            // (`String`, `Int32`) there, not the lowercase value keyword, so emit
            // the framework type name (ADR-0115 §B.12 receiver form).
            ITypeSymbol symbol = this.context.GetTypeInfo(predefined).Type;
            string name = symbol?.Name ?? predefined.Keyword.Text;
            return new IdentifierExpression(name);
        }

        private GExpression TranslateImplicitObjectCreation(ImplicitObjectCreationExpressionSyntax creation)
        {
            // A C# target-typed `new()` carries its concrete type only in the bound
            // model; emit the explicit constructed type (`List[T]()`) so the G#
            // construction names the type (ADR-0115 §B.7/§B.16).
            ITypeSymbol typeSymbol = this.context.GetTypeInfo(creation).Type;
            GTypeReference type = typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            var arguments = creation.ArgumentList == null
                ? new List<GExpression>()
                : this.TranslateArguments(creation.ArgumentList.Arguments);

            return this.BuildObjectCreationCore(typeSymbol, type, arguments, creation.Initializer);
        }

        private GExpression TranslateSwitchExpression(SwitchExpressionSyntax node)
        {
            GExpression subject = this.TranslateExpression(node.GoverningExpression);
            var arms = new List<SwitchArm>();

            foreach (SwitchExpressionArmSyntax arm in node.Arms)
            {
                // Issue #1730: the pattern's bindings must be installed BEFORE the
                // `when` guard is translated, since the guard can reference them
                // (`Circle { Radius: var r } when r > 0 => ...`). Translating the
                // guard first (the prior order) resolved `r` while it was still
                // out of scope.
                var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                GPattern pattern = this.TranslatePattern(arm.Pattern, bindings);

                foreach ((ISymbol symbol, GExpression replacement) in bindings)
                {
                    this.patternBindings[symbol] = replacement;
                }

                GExpression guard;
                GExpression body;
                try
                {
                    // Issue #991: C# `when` guards now have a canonical G# form.
                    guard = arm.WhenClause != null
                        ? this.TranslateExpression(arm.WhenClause.Condition)
                        : null;
                    body = this.TranslateExpression(arm.Expression);
                }
                finally
                {
                    foreach ((ISymbol symbol, _) in bindings)
                    {
                        this.patternBindings.Remove(symbol);
                    }
                }

                arms.Add(new SwitchArm(pattern, body, guard));
            }

            return new SwitchExpression(subject, arms);
        }

        private GStatement TranslateSwitchStatement(SwitchStatementSyntax node)
        {
            GExpression subject = this.TranslateExpression(node.Expression);
            var cases = new List<SwitchStatementCase>();

            foreach (SwitchSectionSyntax section in node.Sections)
            {
                // A G# switch-statement arm carries a single pattern; a C# section
                // that stacks multiple `case` labels (fall-through) has no canonical
                // G# form, so each label is emitted as its own arm. The body is
                // translated per-label (not once per section) because a pattern
                // label's bindings (issue #1730) must be installed before the body
                // is translated, and bindings can differ across stacked labels.
                var labels = section.Labels.ToList();

                foreach (SwitchLabelSyntax label in labels)
                {
                    switch (label)
                    {
                        case CasePatternSwitchLabelSyntax patternLabel:
                            var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                            GPattern pattern = this.TranslatePattern(patternLabel.Pattern, bindings);

                            // Issue #1730: install the pattern's bindings before
                            // translating the `when` guard and the case body, so
                            // both see the bound variable (`case Circle { Radius:
                            // var r } when r > 0: return r;`). The bindings are
                            // scoped to this label only.
                            foreach ((ISymbol symbol, GExpression replacement) in bindings)
                            {
                                this.patternBindings[symbol] = replacement;
                            }

                            GExpression guard;
                            BlockStatement patternBody;
                            try
                            {
                                // Issue #991: C# `when` guards now have a canonical G# form.
                                guard = patternLabel.WhenClause != null
                                    ? this.TranslateExpression(patternLabel.WhenClause.Condition)
                                    : null;
                                patternBody = this.TranslateSwitchSectionBody(section);
                            }
                            finally
                            {
                                foreach ((ISymbol symbol, _) in bindings)
                                {
                                    this.patternBindings.Remove(symbol);
                                }
                            }

                            cases.Add(new SwitchStatementCase(pattern, patternBody, guard));
                            break;

                        case CaseSwitchLabelSyntax valueLabel:
                            cases.Add(new SwitchStatementCase(
                                new ConstantPattern(this.TranslateExpression(valueLabel.Value)),
                                this.TranslateSwitchSectionBody(section)));
                            break;

                        case DefaultSwitchLabelSyntax:
                            cases.Add(new SwitchStatementCase(null, this.TranslateSwitchSectionBody(section)));
                            break;

                        default:
                            this.context.ReportUnsupported(
                                label,
                                $"switch label '{label.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                            break;
                    }
                }
            }

            return new SwitchStatement(subject, cases);
        }

        private BlockStatement TranslateSwitchSectionBody(SwitchSectionSyntax section)
        {
            var statements = new List<GStatement>();
            foreach (StatementSyntax statement in section.Statements)
            {
                // A trailing `break;` only terminates the C# section; G# arms do not
                // fall through, so the explicit break carries no meaning and is dropped.
                if (statement is BreakStatementSyntax)
                {
                    continue;
                }

                statements.AddRange(this.TranslateStatement(statement));
            }

            return new BlockStatement(statements);
        }

        private IEnumerable<GStatement> TranslateYieldStatement(YieldStatementSyntax node)
        {
            // `yield return x` maps to the G# iterator `yield x` (sample
            // TupleSequenceIterators.gs); the enclosing func's return type is
            // rewritten to `sequence[T]`. `yield break` maps to plain `break`
            // (settled fact: G# has no `yield break`; ADR-0115 §B).
            if (node.Expression == null)
            {
                return new[] { (GStatement)new BreakStatement() };
            }

            return new[] { (GStatement)new YieldStatement(this.TranslateExpression(node.Expression)) };
        }

        private GStatement TranslateForEachVariable(ForEachVariableStatementSyntax node)
        {
            // `foreach (var (a, b) in xs)` is a C# TUPLE DECONSTRUCTION over a
            // sequence whose element is a tuple. G#'s two-name `for k, v in xs`
            // form is NOT tuple deconstruction — it is index/element iteration
            // (the key is the int32 index), so emitting `for a, b in xs` would
            // bind `a` to the loop index. Instead iterate a single element and
            // deconstruct it inside the body: `for __deconN in xs { let (a, b) =
            // __deconN; <body> }` (ADR-0115 §B).
            List<string> names = new List<string>();
            CollectForEachVariableNames(node.Variable, names);

            if (names.Count >= 2)
            {
                string pair = $"__decon{this.deconCounter++}";
                BlockStatement body = this.TranslateStatementAsBlock(node.Statement);
                var statements = new List<GStatement>(body.Statements.Count + 1)
                {
                    new TupleDeconstructionStatement(
                        BindingKind.Let,
                        names,
                        new IdentifierExpression(pair)),
                };
                statements.AddRange(body.Statements);

                return new ForInStatement(
                    pair,
                    this.TranslateReceiverWithNullForgiveness(node.Expression),
                    new BlockStatement(statements),
                    isAwait: !node.AwaitKeyword.IsKind(SyntaxKind.None));
            }

            this.context.ReportUnsupported(
                node,
                "foreach tuple deconstruction with arity < 2 has no canonical G# form yet (ADR-0115 §B).");
            return new RawStatement("// unsupported: foreach variable deconstruction");
        }

        private static void CollectForEachVariableNames(ExpressionSyntax variable, List<string> names)
        {
            switch (variable)
            {
                case TupleExpressionSyntax tuple:
                    foreach (ArgumentSyntax argument in tuple.Arguments)
                    {
                        CollectForEachVariableNames(argument.Expression, names);
                    }

                    break;

                case DeclarationExpressionSyntax declaration:
                    CollectDesignationNames(declaration.Designation, names);
                    break;

                case IdentifierNameSyntax identifier:
                    names.Add(SanitizeIdentifier(identifier.Identifier.Text));
                    break;
            }
        }

        private static void CollectDesignationNames(VariableDesignationSyntax designation, List<string> names)
        {
            switch (designation)
            {
                case SingleVariableDesignationSyntax single:
                    names.Add(SanitizeIdentifier(single.Identifier.Text));
                    break;

                case DiscardDesignationSyntax:
                    names.Add("_");
                    break;

                case ParenthesizedVariableDesignationSyntax parenthesized:
                    foreach (VariableDesignationSyntax child in parenthesized.Variables)
                    {
                        CollectDesignationNames(child, names);
                    }

                    break;
            }
        }

        private GPattern TranslatePattern(
            PatternSyntax pattern,
            List<(ISymbol Symbol, GExpression Replacement)> bindings)
        {
            switch (pattern)
            {
                case ConstantPatternSyntax constant:
                    return new ConstantPattern(this.TranslateExpression(constant.Expression));

                case RelationalPatternSyntax relational:
                    return new RelationalPattern(
                        relational.OperatorToken.Text,
                        this.TranslateExpression(relational.Expression));

                case DiscardPatternSyntax:
                    // The discard arm (`_ =>`) is the G# `default:` arm.
                    return null;

                case DeclarationPatternSyntax declaration
                    when declaration.Designation is SingleVariableDesignationSyntax variable:
                    return new TypePattern(
                        SanitizeIdentifier(variable.Identifier.Text),
                        this.MapTypeSyntax(declaration.Type));

                case RecursivePatternSyntax recursive:
                    return this.TranslateRecursivePattern(recursive, bindings);

                // Issue #992: C# `and` / `or` pattern combinators map to G#
                // `and` / `or`. C# `BinaryPatternSyntax` carries an `and`/`or`
                // operator keyword.
                case BinaryPatternSyntax binary
                    when binary.OperatorToken.IsKind(SyntaxKind.AndKeyword) || binary.OperatorToken.IsKind(SyntaxKind.OrKeyword):
                    return new BinaryPattern(
                        binary.OperatorToken.IsKind(SyntaxKind.AndKeyword),
                        this.TranslatePattern(binary.Left, bindings),
                        this.TranslatePattern(binary.Right, bindings));

                // Issue #992: C# `not <pattern>` maps to G# `not <pattern>`.
                case UnaryPatternSyntax unary
                    when unary.OperatorToken.IsKind(SyntaxKind.NotKeyword):
                    return new NotPattern(this.TranslatePattern(unary.Pattern, bindings));

                case ParenthesizedPatternSyntax parenthesized:
                    return new ParenthesizedPattern(this.TranslatePattern(parenthesized.Pattern, bindings));

                default:
                    this.context.ReportUnsupported(
                        pattern,
                        $"pattern '{pattern.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                    return new DiscardPattern();
            }
        }

        private GPattern TranslateRecursivePattern(
            RecursivePatternSyntax recursive,
            List<(ISymbol Symbol, GExpression Replacement)> bindings)
        {
            // A pure property pattern (`{ A: 0, B: 0 }`) with no type maps to the
            // G# property pattern; a typed recursive pattern (`Circle { Radius: var r }`)
            // maps to a type pattern whose designator is the binding receiver.
            if (recursive.Type == null)
            {
                var fields = new List<PropertyPatternField>();
                if (recursive.PropertyPatternClause != null)
                {
                    foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
                    {
                        if (sub.NameColon == null)
                        {
                            this.context.ReportUnsupported(sub, "positional subpattern has no canonical G# form yet (ADR-0115 §B).");
                            continue;
                        }

                        fields.Add(new PropertyPatternField(
                            SanitizeIdentifier(sub.NameColon.Name.Identifier.Text),
                            this.TranslatePattern(sub.Pattern, bindings)));
                    }
                }

                return new PropertyPattern(fields);
            }

            // Typed recursive pattern: synthesize a designator named after the type
            // (`circle`), and rewrite each `Name: var x` property binding to a
            // member access on that designator (`circle.Radius`). The synthesized
            // designator is derived from the right-most identifier token of the
            // type syntax (not `Type.ToString()`, which yields an invalid
            // identifier for a qualified/generic type such as `Ns.Circle` or
            // `List<int>`), and sanitized like every other declared/synthesized
            // name so a keyword-colliding designator agrees with its references
            // (issue #1734).
            string designator = recursive.Designation is SingleVariableDesignationSyntax named
                ? SanitizeIdentifier(named.Identifier.Text)
                : SanitizeIdentifier(LowerCamel(GetRightmostTypeName(recursive.Type)));

            if (recursive.PropertyPatternClause != null)
            {
                foreach (SubpatternSyntax sub in recursive.PropertyPatternClause.Subpatterns)
                {
                    if (sub.NameColon != null &&
                        sub.Pattern is VarPatternSyntax { Designation: SingleVariableDesignationSyntax bound } &&
                        this.context.GetDeclaredSymbol(bound) is { } boundSymbol)
                    {
                        bindings.Add((
                            boundSymbol,
                            new MemberAccessExpression(
                                new IdentifierExpression(designator),
                                SanitizeIdentifier(sub.NameColon.Name.Identifier.Text))));
                    }
                    else
                    {
                        this.context.ReportUnsupported(
                            sub,
                            "typed property subpattern other than a 'var' binding has no canonical G# form yet (ADR-0115 §B).");
                    }
                }
            }

            return new TypePattern(designator, this.MapTypeSyntax(recursive.Type));
        }

        private static string LowerCamel(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }

            return char.ToLowerInvariant(name[0]) + name.Substring(1);
        }

        // Extracts the right-most simple-name identifier token from a (possibly
        // qualified/generic) type syntax, e.g. `Ns.Circle` -> "Circle",
        // `List<int>` -> "List", `Outer.Inner<T>` -> "Inner". `Type.ToString()`
        // renders the full qualified/generic text, which is not itself a valid
        // identifier and must never be used to synthesize a designator name
        // (issue #1734).
        private static string GetRightmostTypeName(TypeSyntax type)
        {
            switch (type)
            {
                case QualifiedNameSyntax qualified:
                    return GetRightmostTypeName(qualified.Right);
                case AliasQualifiedNameSyntax aliasQualified:
                    return GetRightmostTypeName(aliasQualified.Name);
                case SimpleNameSyntax simple:
                    return simple.Identifier.Text;
                default:
                    return type.ToString();
            }
        }

        private GExpression TranslateQuery(QueryExpressionSyntax query)
        {
            // G# has no query-comprehension syntax; lower the C# query to the
            // equivalent System.Linq method chain (`from … where … orderby …
            // select …` → `.Where(…).OrderBy(…).Select(…)`, ADR-0115 §B LINQ).
            FromClauseSyntax from = query.FromClause;
            string rangeVar = from.Identifier.Text;
            GExpression current = this.TranslateExpression(from.Expression);

            GTypeReference rangeType = from.Type != null
                ? this.MapTypeSyntax(from.Type)
                : (this.context.GetTypeInfo(from.Expression).Type is INamedTypeSymbol { IsGenericType: true } src
                    ? this.typeMapper.Map(src.TypeArguments[0], this.context, from.GetLocation())
                    : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType));

            current = this.LowerQueryBody(query.Body, rangeVar, rangeType, current);
            return current;
        }

        private GExpression LowerQueryBody(
            QueryBodySyntax body,
            string rangeVar,
            GTypeReference rangeType,
            GExpression current)
        {
            foreach (QueryClauseSyntax clause in body.Clauses)
            {
                switch (clause)
                {
                    case WhereClauseSyntax where:
                        current = this.QueryCall(current, "Where", rangeVar, rangeType, where.Condition);
                        break;

                    case OrderByClauseSyntax orderBy:
                        bool first = true;
                        foreach (OrderingSyntax ordering in orderBy.Orderings)
                        {
                            bool descending = ordering.AscendingOrDescendingKeyword.IsKind(SyntaxKind.DescendingKeyword);
                            string method = (first ? "OrderBy" : "ThenBy") + (descending ? "Descending" : string.Empty);
                            current = this.QueryCall(current, method, rangeVar, rangeType, ordering.Expression);
                            first = false;
                        }

                        break;

                    default:
                        this.context.ReportUnsupported(
                            clause,
                            $"query clause '{clause.Kind()}' has no canonical G# lowering yet (ADR-0115 §B).");
                        break;
                }
            }

            switch (body.SelectOrGroup)
            {
                case SelectClauseSyntax select:
                    // An identity projection (`select n`) after another clause is a
                    // no-op the C# compiler elides; keep it only when it transforms.
                    if (!(select.Expression is IdentifierNameSyntax id && id.Identifier.Text == rangeVar
                          && body.Clauses.Count > 0))
                    {
                        current = this.QueryCall(current, "Select", rangeVar, rangeType, select.Expression);
                    }

                    break;

                default:
                    this.context.ReportUnsupported(
                        body.SelectOrGroup,
                        $"query '{body.SelectOrGroup.Kind()}' has no canonical G# lowering yet (ADR-0115 §B).");
                    break;
            }

            return current;
        }

        private GExpression QueryCall(
            GExpression receiver,
            string method,
            string rangeVar,
            GTypeReference rangeType,
            ExpressionSyntax lambdaBody)
        {
            var lambda = new LambdaExpression(
                new List<Parameter> { new Parameter(SanitizeIdentifier(rangeVar), rangeType) },
                expressionBody: this.TranslateExpression(lambdaBody));
            return new InvocationExpression(
                new MemberAccessExpression(receiver, method),
                new List<GExpression> { lambda });
        }

        /// <summary>
        /// Carries the result of the T2 constructor-lift analysis (ADR-0115 §B.3):
        /// which immutable fields move to a primary-constructor parameter, which
        /// gain a field initializer, and whether the explicit <c>init</c>
        /// constructor can be dropped entirely.
        /// </summary>
        private sealed class ConstructorLift
        {
            public static readonly ConstructorLift None = new ConstructorLift();

            public ConstructorDeclarationSyntax Constructor { get; init; }

            public bool DropConstructor { get; init; }

            public IReadOnlyList<Parameter> PrimaryParameters { get; init; } = new List<Parameter>();

            public HashSet<string> FieldsAsPrimaryParameters { get; init; } = new HashSet<string>();

            public HashSet<string> PropertiesAsPrimaryParameters { get; init; } = new HashSet<string>();

            public Dictionary<string, GExpression> FieldInitializers { get; init; } =
                new Dictionary<string, GExpression>();

            /// <summary>
            /// Gets the constructor-body assignments that could not be hoisted to a
            /// field initializer because their right-hand side reads an instance
            /// member (GS0125). They are re-emitted, in source order, as a synthesized
            /// parameterless <c>init() { ... }</c> when the explicit constructor is
            /// otherwise dropped.
            /// </summary>
            public IReadOnlyList<GStatement> ResidualInitStatements { get; init; } =
                new List<GStatement>();
        }
    }
}
