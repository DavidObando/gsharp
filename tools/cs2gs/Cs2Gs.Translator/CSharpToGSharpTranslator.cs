// <copyright file="CSharpToGSharpTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

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

        HashSet<INamedTypeSymbol> openBases = CollectSubclassedBaseTypes(context.Compilation);
        var visitor = new DeclarationVisitor(context, new CSharpTypeMapper(), openBases);

        // T3 (ADR-0115 §B.1/§B.11): the C# program entry point and its enclosing
        // static class become top-level G#. The entry `Main` body translates to
        // top-level statements (the program entry in G# is top-level statements,
        // not a `Main` method) and the sibling static methods become top-level
        // `func`s — never a `shared { }` block.
        IMethodSymbol entryPoint = context.Compilation.GetEntryPoint(default);
        INamedTypeSymbol entryType = entryPoint?.ContainingType;

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

    private static HashSet<INamedTypeSymbol> CollectSubclassedBaseTypes(Compilation compilation)
    {
        var bases = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
        foreach (INamedTypeSymbol type in EnumerateNamedTypes(compilation.GlobalNamespace))
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
                context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.UsingDirective),
                    $"'using static {name}' has no direct G# member-hoisting form; emitted as a plain import (ADR-0115 §B.1).",
                    directive.GetLocation(),
                    TranslationSeverity.Warning));
            }

            imports.Add(new ImportDirective(name, alias));
        }

        return imports;
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

        // C# post-increment/decrement (`i++`, `i--`) sub-expressions that the
        // surrounding statement seam has hoisted into trailing `i++` statements
        // (G# models inc/dec as statements, not expressions; spec §Statements).
        // While a node is in this set, `TranslateExpression` renders it as a bare
        // read of its operand (the pre-increment value).
        private readonly HashSet<SyntaxNode> suppressedPostfix =
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
            HashSet<INamedTypeSymbol> subclassedBases)
        {
            this.context = context;
            this.typeMapper = typeMapper;
            this.subclassedBases = subclassedBases;
            this.entryType = context.Compilation.GetEntryPoint(default)?.ContainingType;
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

        private static GExpression MapConstantDefault(IParameterSymbol symbol)
        {
            object value = symbol.ExplicitDefaultValue;
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
                    return LiteralExpression.Float(d.ToString(CultureInfo.InvariantCulture));
                case float f:
                    return LiteralExpression.Float(f.ToString(CultureInfo.InvariantCulture));
                default:
                    return IsIntegral(value)
                        ? LiteralExpression.Int(System.Convert.ToString(value, CultureInfo.InvariantCulture))
                        : null;
            }
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

            this.CollectStaticFieldInitializers(node);

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

            this.staticFieldInitializers.Clear();

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
            bool isOpen = symbol != null &&
                kind == TypeDeclarationKind.Class &&
                !symbol.IsStatic &&
                ((!symbol.IsSealed && this.subclassedBases.Contains(symbol.OriginalDefinition))
                    || HasProtectedMember(symbol));

            // G# has no `abstract` class modifier (the keyword is not recognized by
            // the parser); a C# `abstract class`/`abstract record` therefore maps to
            // an `open class` — subclassable but without enforced non-instantiation
            // (ADR-0115 §B.4). The abstractness is intentionally dropped.
            bool wasAbstract = symbol != null && symbol.IsAbstract && kind == TypeDeclarationKind.Class;
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
                node.Identifier.Text,
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
                    // GS0159; e.g. `buffer = AllocateArray[T](InputBufferSize)` where
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
                primaryParameters.Add(new Parameter(target.Name, type));
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
                else if (declarator.Initializer != null)
                {
                    initializer = this.CoerceConstantToUnsigned(
                        declarator.Initializer.Value,
                        this.TranslateExpression(declarator.Initializer.Value));
                }
                else if (symbol != null &&
                    this.staticFieldInitializers.TryGetValue(symbol, out GExpression staticLifted))
                {
                    // The field's value comes from a folded `static` constructor
                    // (`static T() { Field = value; }`), which G# has no form for.
                    initializer = staticLifted;
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
                    receiver = new Receiver(
                        SanitizeIdentifier(self.Name),
                        this.typeMapper.Map(self.Type, this.context, node.GetLocation()));
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
            bool inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface;
            bool isOpen = symbol != null && !inInterface && !symbol.IsSealed &&
                (symbol.IsVirtual || symbol.IsAbstract || isOverride) &&
                this.IsTypeEmittedOpen(symbol.ContainingType);

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
                attributes: this.MapAttributes(node.AttributeLists));

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
                attributes: this.MapAttributes(node.AttributeLists));

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

            var method = new MethodDeclaration(
                $"operator {kindKeyword}",
                parameters: parameters,
                returnType: returnType,
                body: body,
                attributes: this.MapAttributes(node.AttributeLists));

            // The conversion operator has no receiver clause, so it stays an
            // in-body member of the owning type (returning IsStatic=false routes it
            // to the instance-member list in VisitAggregate, which the parser
            // accepts directly in the type body).
            return (method, false);
        }

        private (GMember Member, bool IsStatic) TranslateProperty(PropertyDeclarationSyntax node)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            bool isStatic = symbol != null && symbol.IsStatic;

            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            List<PropertyAccessor> accessors = this.MapAccessors(node);

            bool isOverride = symbol != null && symbol.IsOverride && !OverridesExternalBaseProperty(symbol);

            // Interface members are implicitly abstract; canonical G# interface
            // members carry no `open` modifier (ADR-0115 §B.6).
            bool inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface;
            bool isOpen = symbol != null && !inInterface && !symbol.IsSealed &&
                (symbol.IsVirtual || symbol.IsAbstract || isOverride) &&
                this.IsTypeEmittedOpen(symbol.ContainingType);

            var property = new PropertyDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                type,
                accessors: accessors,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapAttributes(node.AttributeLists));

            return (property, isStatic);
        }

        private List<PropertyAccessor> MapAccessors(PropertyDeclarationSyntax node)
        {
            return this.MapAccessors(node, $"property '{node.Identifier.Text}'");
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
                ? symbol.Parameters.Select(this.MapParameter).ToList()
                : this.MapParameterList(node.ParameterList);

            List<PropertyAccessor> accessors = this.MapAccessors(node, "indexer 'this[]'");

            bool isOverride = symbol != null && symbol.IsOverride && !OverridesExternalBaseProperty(symbol);
            bool inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface;
            bool isOpen = symbol != null && !inInterface && !symbol.IsSealed &&
                (symbol.IsVirtual || symbol.IsAbstract || isOverride) &&
                this.IsTypeEmittedOpen(symbol.ContainingType);

            var property = new PropertyDeclaration(
                "this",
                type,
                accessors: accessors,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapAttributes(node.AttributeLists),
                indexerParameters: indexParameters);

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
                accessors.Add(new PropertyAccessor(kind, body));
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
                if (this.IsFoldableStaticConstructor(node))
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
                    baseArguments = node.Initializer.ArgumentList.Arguments
                        .Select(a => this.TranslateArgument(a))
                        .ToList();
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
                    node.Initializer.ArgumentList.Arguments.Select(a => this.TranslateArgument(a)).ToList()));
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
        private void CollectStaticFieldInitializers(TypeDeclarationSyntax node)
        {
            foreach (MemberDeclarationSyntax member in node.Members)
            {
                if (member is not ConstructorDeclarationSyntax ctor ||
                    !ctor.Modifiers.Any(SyntaxKind.StaticKeyword) ||
                    !this.IsFoldableStaticConstructor(ctor) ||
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

        private bool IsFoldableStaticConstructor(ConstructorDeclarationSyntax node)
        {
            if (node.Body == null)
            {
                return node.ExpressionBody == null;
            }

            foreach (StatementSyntax statement in node.Body.Statements)
            {
                if (statement is not ExpressionStatementSyntax expressionStatement ||
                    expressionStatement.Expression is not AssignmentExpressionSyntax assignment ||
                    !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) ||
                    this.context.GetSymbolInfo(assignment.Left).Symbol is not IFieldSymbol { IsStatic: true })
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

            if (tp.HasValueTypeConstraint)
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

            return new TypeParameter(tp.Name, legacy, flags, variance);
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

                return source.Select(this.MapParameter).ToList();
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
                    parameters.Add(this.MapParameter(symbol));
                }
            }

            return parameters;
        }

        private Parameter MapParameter(IParameterSymbol symbol)
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

            GExpression defaultValue = null;
            if (symbol.HasExplicitDefaultValue)
            {
                defaultValue = MapConstantDefault(symbol);
                if (defaultValue == null && symbol.ExplicitDefaultValue != null)
                {
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.EqualsValueClause),
                        $"parameter '{symbol.Name}' has a default value that is not a simple literal; the default is omitted for now (deferred to step 7).",
                        symbol.Locations.FirstOrDefault(),
                        TranslationSeverity.Info));
                }
            }

            return new Parameter(SanitizeIdentifier(symbol.Name), type, variadic, refKind, defaultValue);
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

        private GExpression MapAttributeArgumentValue(AttributeArgumentSyntax argument)
        {
            Optional<object> constant = this.context.SemanticModel.GetConstantValue(argument.Expression);
            if (constant.HasValue)
            {
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
                // the statement seam rather than wrapping the value.
                return new BlockStatement(this.TranslateExpressionStatements(expression).ToList());
            }

            return new BlockStatement(this.WithHoistedPostfix(
                expression,
                () => new GStatement[] { new ReturnStatement(this.TranslateExpression(expression)) }).ToList());
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

        private IEnumerable<GStatement> TranslateStatement(StatementSyntax statement)
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
                    return new[]
                    {
                        (GStatement)new ReturnStatement(
                            ret.Expression == null ? null : this.TranslateExpression(ret.Expression)),
                    };

                case IfStatementSyntax ifStatement:
                    return this.TranslateIfStatements(ifStatement).ToArray();

                case WhileStatementSyntax whileStatement:
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
                    return new[]
                    {
                        (GStatement)new ForInStatement(
                            SanitizeIdentifier(forEach.Identifier.Text),
                            this.TranslateReceiverWithNullForgiveness(forEach.Expression),
                            this.TranslateStatementAsBlock(forEach.Statement)),
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
                GExpression initializer = declarator.Initializer == null
                    ? null
                    : this.CoerceConstantToUnsigned(
                        declarator.Initializer.Value,
                        this.TranslateExpression(declarator.Initializer.Value));

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
                // type is inferred (ADR-0115 §B.3).
                GTypeReference type = null;
                if (initializer == null && hasExplicitType)
                {
                    ITypeSymbol typeSymbol = this.context.GetTypeInfo(declaration.Type).Type;
                    type = typeSymbol != null
                        ? this.typeMapper.Map(typeSymbol, this.context, declaration.Type.GetLocation())
                        : null;

                    // Issue #1072: a non-nullable reference/array local that is
                    // null-checked or null-assigned in its scope is really nullable.
                    if (this.context.GetDeclaredSymbol(declarator) is ILocalSymbol localSymbol)
                    {
                        type = this.PromoteIfUsedAsNullable(type, localSymbol);
                    }
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

            // C# null-coalescing `a ?? b`: the left is a nullable numeric, the
            // right must match the left's *underlying* (non-nullable) numeric type
            // (a `??` is not a symmetric arithmetic promotion of both sides). Only
            // apply this when both sides are numeric; mixed reference cases such as
            // `Task<T>? ?? Task` flow through unchanged.
            if (op == "??")
            {
                return this.TranslateNullCoalescing(binary, left, right);
            }

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

        // C# `a ?? b` where `a` is a nullable numeric: G# requires `b` to match
        // the underlying numeric type of `a`, otherwise GS0129. Coerce the right
        // operand to the left's underlying (non-nullable) type when they differ.
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
                ITypeSymbol leftUnderlyingType = UnwrapNullable(leftType);
                right = this.CoerceOperandTo(right, leftUnderlyingType);
            }

            return new BinaryExpression(left, "??", right);
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

            var catches = new List<CatchClause>();
            foreach (CatchClauseSyntax catchClause in node.Catches)
            {
                string variableName = null;
                GTypeReference exceptionType = null;
                if (catchClause.Declaration != null)
                {
                    ITypeSymbol typeSymbol = this.context.GetTypeInfo(catchClause.Declaration.Type).Type;
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
                    catches.Add(new CatchClause(variableName, exceptionType, this.TranslateBlock(catchClause.Block)));
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
                        this.TranslateExpression(assignment.Left),
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

                if (assignment.Right is AssignmentExpressionSyntax)
                {
                    // `a = b = c` → `b = c` then `a = b`. G# assignment is a
                    // statement, so the chain is flattened innermost-first.
                    return this.FlattenChainedAssignment(assignment);
                }
            }

            return this.WithHoistedPostfix(
                expression,
                () => new[] { this.TranslateExpressionStatement(expression) });
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
            var lefts = new List<(GExpression Target, string Op)>();
            ExpressionSyntax current = assignment;
            while (current is AssignmentExpressionSyntax link &&
                link.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                lefts.Add((this.TranslateExpression(link.Left), link.OperatorToken.Text));
                current = link.Right;
            }

            GExpression rhs = this.TranslateExpression(current);
            var statements = new List<GStatement>();
            for (int i = lefts.Count - 1; i >= 0; i--)
            {
                statements.Add(new AssignmentStatement(lefts[i].Target, rhs, lefts[i].Op));
                rhs = lefts[i].Target;
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
            // `try { body } finally { Monitor.Exit(x) }` (ADR-0115 §B).
            GExpression target = this.TranslateExpression(lockStatement.Expression);

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

            LambdaExpression lambda;
            if (localFunction.Body != null)
            {
                lambda = new LambdaExpression(parameters, blockBody: this.WithParameterShadows(localFunction, this.TranslateBlock(localFunction.Body)), isAsync: isAsync, returnType: returnType, isFunctionLiteral: true);
            }
            else if (localFunction.ExpressionBody != null)
            {
                lambda = new LambdaExpression(
                    parameters,
                    blockBody: new BlockStatement(this.TranslateExpressionStatements(localFunction.ExpressionBody.Expression).ToList()),
                    isAsync: isAsync,
                    returnType: returnType,
                    isFunctionLiteral: true);
            }
            else
            {
                lambda = new LambdaExpression(parameters, blockBody: new BlockStatement(new List<GStatement>()), isAsync: isAsync, returnType: returnType, isFunctionLiteral: true);
            }

            return new LocalFunctionStatement(localFunction.Identifier.Text, lambda);
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

            // Only hoist when the pattern variable escapes the then-block. If it is
            // used solely inside the guarded block the existing smart cast (rewriting
            // `t` to the receiver) is correct and avoids an unnecessary local.
            if (this.context.GetDeclaredSymbol(single) is not ILocalSymbol patternSymbol ||
                !this.IsSymbolReferencedOutside(patternSymbol, ifStatement.Statement))
            {
                return false;
            }

            string localName = SanitizeIdentifier(single.Identifier.Text);
            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            GTypeReference targetType = this.MapTypeSyntax(typeSyntax);

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
                _ => reference,
            };
        }

        private GStatement TranslateIf(IfStatementSyntax ifStatement)
        {
            // Translate the condition first so any `x is T t` declaration pattern
            // registers its Kotlin-style smart-cast binding before the guarded
            // block is translated; the binding is scoped to the then-block only.
            var bindingsBefore = new HashSet<ISymbol>(this.patternBindings.Keys, SymbolEqualityComparer.Default);
            GExpression condition = GuardBlockCondition(this.TranslateExpression(ifStatement.Condition));

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

            return new IfStatement(condition, then, elseBranch);
        }

        private GStatement TranslateForStatement(ForStatementSyntax forStatement)
        {
            int declaratorCount = forStatement.Declaration?.Variables.Count ?? 0;

            // G#'s `for` carries a SINGLE init clause and a SINGLE incrementor, so
            // a C-style `for` with multiple declarators/initializers or multiple
            // incrementors cannot be represented directly. Lower those to a block
            // + `while` so every init runs once up front and every incrementor runs
            // at the end of each iteration (issue #914).
            if (declaratorCount > 1 ||
                forStatement.Initializers.Count > 1 ||
                forStatement.Incrementors.Count > 1)
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

        /// <summary>
        /// Lowers a C-style <c>for</c> that has more than one initializer/declarator
        /// or more than one incrementor — neither of which fits G#'s single-init,
        /// single-incrementor <c>for</c> — into an equivalent block + <c>while</c>:
        /// all inits run once before the loop, the body runs each iteration, then
        /// every incrementor runs at the end of the body (issue #914).
        /// </summary>
        /// <remarks>
        /// Fidelity caveat: in C# the incrementors also run when the body executes a
        /// loop-targeting <c>continue</c>; in this while-lowering the trailing
        /// incrementors are SKIPPED on <c>continue</c>. The decoder loops this fix
        /// targets do not use a loop-level <c>continue</c>, so the lowering is
        /// faithful for them; a warning would be required to generalise this.
        /// </remarks>
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

            GExpression condition = forStatement.Condition == null
                ? LiteralExpression.Bool(true)
                : GuardBlockCondition(this.TranslateExpression(forStatement.Condition));

            var bodyStatements = new List<GStatement>(
                this.TranslateStatementAsBlock(forStatement.Statement).Statements);

            foreach (ExpressionSyntax inc in forStatement.Incrementors)
            {
                bodyStatements.AddRange(this.TranslateExpressionStatements(inc));
            }

            outer.Add(new WhileStatement(condition, new BlockStatement(bodyStatements)));

            return new BlockStatement(outer);
        }

        private bool IsLocalReassigned(ILocalSymbol local)
        {
            SyntaxNode scope = this.currentBodyScope;
            if (scope == null)
            {
                return false;
            }

            foreach (SyntaxNode node in scope.DescendantNodes())
            {
                switch (node)
                {
                    case AssignmentExpressionSyntax assignment
                        when this.BindsTo(assignment.Left, local):
                        return true;

                    case PostfixUnaryExpressionSyntax postfix
                        when (postfix.IsKind(SyntaxKind.PostIncrementExpression)
                                || postfix.IsKind(SyntaxKind.PostDecrementExpression))
                            && this.BindsTo(postfix.Operand, local):
                        return true;

                    case PrefixUnaryExpressionSyntax prefix
                        when (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                                || prefix.IsKind(SyntaxKind.PreDecrementExpression))
                            && this.BindsTo(prefix.Operand, local):
                        return true;
                }
            }

            return false;
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
        private GTypeReference PromoteIfUsedAsNullable(GTypeReference type, ISymbol symbol)
        {
            if (type == null || type.IsNullable)
            {
                return type;
            }

            return this.IsPromotedToNullableReference(symbol) ? MakeNullable(type) : type;
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
                ILocalSymbol l => l.Type,
                IParameterSymbol p => p.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true }
                || declared.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
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
                    return new IdentifierExpression(generic.Identifier.Text);

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
                        tuple.Arguments.Select(a => this.TranslateExpression(a.Expression)).ToList());

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
                        ? this.TranslateExpression(elementAccess.ArgumentList.Arguments[0].Expression)
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
                    return new IfExpression(
                        this.TranslateExpression(conditional.Condition),
                        this.TranslateExpression(conditional.WhenTrue),
                        this.TranslateExpression(conditional.WhenFalse));

                case QueryExpressionSyntax query:
                    return this.TranslateQuery(query);

                case ImplicitObjectCreationExpressionSyntax implicitCreation:
                    return this.TranslateImplicitObjectCreation(implicitCreation);

                case PredefinedTypeSyntax predefinedType:
                    return this.TranslatePredefinedTypeExpression(predefinedType);

                case ConditionalAccessExpressionSyntax conditionalAccess:
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
                    // An assignment used in value position (`a = b = c`, or an
                    // assignment lambda body that reached here). G# models
                    // assignment as a statement; the in-expression form has no
                    // canonical value, so emit the assigned value and let the
                    // enclosing statement seam re-materialise the write.
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

        private GExpression TranslateIsPattern(IsPatternExpressionSyntax isPattern)
        {
            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            return this.TranslatePatternTest(receiver, isPattern.Pattern);
        }

        private GExpression TranslatePatternTest(GExpression receiver, PatternSyntax pattern)
        {
            switch (pattern)
            {
                case ConstantPatternSyntax constant
                    when constant.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                    // `x is null` → `x == nil`.
                    return new BinaryExpression(receiver, "==", LiteralExpression.Null());

                case ConstantPatternSyntax constant:
                    // `x is 0` / `x is "moov"` / `x is true`. G# `is` only tests a
                    // type, so a constant pattern lowers to an equality test
                    // (ADR-0115 §B).
                    return new BinaryExpression(
                        receiver,
                        "==",
                        this.TranslateExpression(constant.Expression));

                case RelationalPatternSyntax relational:
                    // `x is > 0` → `x > 0`.
                    return new BinaryExpression(
                        receiver,
                        relational.OperatorToken.Text,
                        this.TranslateExpression(relational.Expression));

                case DeclarationPatternSyntax declaration:
                    // `x is T t` → the boolean test `x is T`; the binder `t` is a
                    // Kotlin-style smart cast of `x` inside the guarded block, so
                    // references to `t` are rewritten to `x` (ADR-0069).
                    if (declaration.Designation is SingleVariableDesignationSyntax single &&
                        this.context.GetDeclaredSymbol(single) is { } boundSymbol)
                    {
                        this.patternBindings[boundSymbol] = receiver;
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
                    return this.TranslateRecursivePatternTest(receiver, recursive);

                case UnaryPatternSyntax unary when unary.IsKind(SyntaxKind.NotPattern):
                    return this.TranslateNotPatternTest(receiver, unary.Pattern);

                case BinaryPatternSyntax binaryPattern
                    when binaryPattern.OperatorToken.IsKind(SyntaxKind.OrKeyword)
                        || binaryPattern.OperatorToken.IsKind(SyntaxKind.AndKeyword):
                    // `x is 11 or 12` → `x == 11 || x == 12`;
                    // `x is A and B` → `(x is A) && (x is B)`.
                    bool isOr = binaryPattern.OperatorToken.IsKind(SyntaxKind.OrKeyword);
                    return new BinaryExpression(
                        this.TranslatePatternTest(receiver, binaryPattern.Left),
                        isOr ? "||" : "&&",
                        this.TranslatePatternTest(receiver, binaryPattern.Right));

                case ParenthesizedPatternSyntax parenthesized:
                    return new ParenthesizedExpression(
                        this.TranslatePatternTest(receiver, parenthesized.Pattern));

                default:
                    this.context.ReportUnsupported(
                        pattern,
                        $"is-pattern '{pattern.Kind()}' has no canonical G# form yet (ADR-0115 §B).");
                    return new BinaryExpression(receiver, "!=", LiteralExpression.Null());
            }
        }

        private GExpression TranslateNotPatternTest(GExpression receiver, PatternSyntax inner)
        {
            switch (inner)
            {
                case ConstantPatternSyntax constant
                    when constant.Expression.IsKind(SyntaxKind.NullLiteralExpression):
                    // `x is not null` → `x != nil`.
                    return new BinaryExpression(receiver, "!=", LiteralExpression.Null());

                case ConstantPatternSyntax constant:
                    // `x is not 6` → `x != 6`.
                    return new BinaryExpression(
                        receiver,
                        "!=",
                        this.TranslateExpression(constant.Expression));

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
                        new ParenthesizedExpression(this.TranslatePatternTest(receiver, inner)));
            }
        }

        private GExpression TranslateRecursivePatternTest(GExpression receiver, RecursivePatternSyntax recursive)
        {
            // Bind the designator (`is { } x`, `is Circle c`) to the receiver so
            // later references read the matched value (ADR-0069 smart cast).
            BindPatternDesignation(recursive.Designation, receiver);

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

            // `new T[n]` (runtime/constant length, no initializer) → the canonical
            // zero-initialised allocation `System.GC.AllocateArray[T](n)`, which
            // returns a `T[]` of length `n` (the Go-style `make([]T, n)` form is a
            // documented gsc gap, ADR-0083).
            GExpression length = creation.Type.RankSpecifiers.Count > 0 &&
                creation.Type.RankSpecifiers[0].Sizes.Count > 0 &&
                creation.Type.RankSpecifiers[0].Sizes[0] is { } sizeExpr &&
                !sizeExpr.IsKind(SyntaxKind.OmittedArraySizeExpression)
                ? this.TranslateExpression(sizeExpr)
                : LiteralExpression.Int("0");

            return new InvocationExpression(
                new MemberAccessExpression(
                    new MemberAccessExpression(new IdentifierExpression("System"), "GC"),
                    "AllocateArray"),
                new List<GExpression> { length },
                new List<GTypeReference> { elementType });
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
                        identifier.Identifier.Text);
                }
            }

            return new IdentifierExpression(SanitizeIdentifier(identifier.Identifier.Text));
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
                        return LiteralExpression.Float(this.ToFloatLiteralText(literal.Token.Text));
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
                    // The target-typed `default` literal maps to the bare G#
                    // `default`, whose type is supplied by the surrounding context
                    // (ADR-0100).
                    return new DefaultValueExpression();

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

        private string ToFloatLiteralText(string text)
        {
            // A plain integer spelling (`30`) needs a fractional part so the G#
            // lexer classifies it as float64; an already-float spelling is kept.
            return text.IndexOfAny(new[] { '.', 'e', 'E' }) >= 0 ? text : text + ".0";
        }

        private GExpression TranslateMemberAccess(MemberAccessExpressionSyntax member)
        {
            // Member access on a bare-identifier element access (`values[i].M`)
            // previously hit a G# parser ambiguity (#942); that gap is now fixed,
            // so the construct translates through the normal member-access path.
            GExpression target = this.TranslateReceiverWithNullForgiveness(member.Expression);
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

            if (this.ReceiverNeedsNullForgiveness(recv))
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
                extArgs.AddRange(invocation.ArgumentList.Arguments.Select(a => this.TranslateArgument(a)));
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
                target = new IdentifierExpression(generic.Identifier.Text);
                typeArguments = this.MapTypeArguments(generic);
            }
            else if (invocation.Expression is MemberAccessExpressionSyntax member
                && member.Name is GenericNameSyntax memberGeneric)
            {
                target = new MemberAccessExpression(
                    this.TranslateExpression(member.Expression),
                    memberGeneric.Identifier.Text);
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
                    memberBindingGeneric.Identifier.Text);
                typeArguments = this.MapTypeArguments(memberBindingGeneric);
            }
            else if (invocation.Expression is IdentifierNameSyntax bareName &&
                this.context.GetSymbolInfo(bareName).Symbol is IMethodSymbol { IsStatic: true } staticMethod &&
                staticMethod.ContainingType is { TypeKind: TypeKind.Class or TypeKind.Struct } owner &&
                !owner.IsImplicitlyDeclared &&
                !SymbolEqualityComparer.Default.Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition))
            {
                // A C# bare sibling static call (`Round(value, 2)`) carries an
                // implicit type qualifier. A G# `shared` method body has no
                // implicit type scope, so the call must be qualified through the
                // owning type (`Geometry.Round(value, 2)`); see ADR-0115 §B.18.
                target = new MemberAccessExpression(
                    new IdentifierExpression(owner.Name),
                    staticMethod.Name);
            }
            else
            {
                target = this.TranslateExpression(invocation.Expression);
            }

            var arguments = invocation.ArgumentList.Arguments
                .Select(a => this.TranslateArgument(a))
                .ToList();

            return new InvocationExpression(target, arguments, typeArguments);
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
            ownerName = original.ContainingType?.Name;
            methodName = original.Name;
            return ownerName != null;
        }

        /// <summary>
        /// Translates a single C# call argument, honoring <c>out</c>/<c>ref</c>
        /// argument forms (ADR-0115 §B; sample <c>TryParseOutVar.gs</c>): an
        /// <c>out</c>/<c>ref</c> argument naming a pre-declared variable maps to
        /// the address-of form <c>&amp;x</c>, an inline <c>out var x</c> maps to
        /// <c>out var x</c>, and an <c>out _</c> discard maps to <c>out _</c>.
        /// </summary>
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
            if (this.ReceiverNeedsNullForgiveness(argument.Expression))
            {
                return new NonNullAssertionExpression(this.TranslateExpression(argument.Expression));
            }

            // OD-T2: a C# integer literal implicitly converted to an unsigned
            // parameter (e.g. `base(4)` where the parameter is `byte`) must be
            // emitted as a typed G# literal (`uint8(4)`); G# performs no implicit
            // signed→unsigned constant conversion at the call site (GS0214/GS0156).
            return this.CoerceConstantToUnsigned(
                argument.Expression,
                this.TranslateExpression(argument.Expression));
        }

        private GExpression TranslateObjectCreation(ObjectCreationExpressionSyntax creation)
        {
            ITypeSymbol typeSymbol = this.context.GetTypeInfo(creation).Type;
            GTypeReference type = typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
                : new NamedTypeReference(creation.Type.ToString());

            bool hasCtorArgs = creation.ArgumentList != null && creation.ArgumentList.Arguments.Count > 0;

            var arguments = creation.ArgumentList == null
                ? new List<GExpression>()
                : creation.ArgumentList.Arguments
                    .Select(a => this.TranslateArgument(a))
                    .ToList();

            // A C# collection initializer maps to the canonical G# collection
            // initializer `Target{ ... }` (ADR-0117, issue #479). This covers
            // `new List<int>{1, 2, 3}` (bare elements), `new Dictionary<K,V>{ {k, v} }`
            // (complex element initializers → `k: v` pairs), and
            // `new Dictionary<K,V>{ ["k"] = v }` (indexer entries). The construction
            // target carries any constructor arguments, matching
            // `new(StringComparer.OrdinalIgnoreCase){ ... }`.
            if (creation.Initializer != null &&
                this.TryTranslateCollectionInitializer(creation, type, arguments, out GExpression collectionInitializer))
            {
                return collectionInitializer;
            }

            // An object initializer `new T { Field = value, ... }` (no/empty
            // constructor argument list) maps to the canonical G# struct literal
            // `T{Field: value, ...}` (spec §Struct literals; ADR-0115 §B.11).
            if (creation.Initializer != null &&
                creation.Initializer.IsKind(SyntaxKind.ObjectInitializerExpression) &&
                !hasCtorArgs)
            {
                var fieldInitializers = new List<FieldInitializer>();
                foreach (ExpressionSyntax element in creation.Initializer.Expressions)
                {
                    if (element is AssignmentExpressionSyntax assignment &&
                        assignment.Left is IdentifierNameSyntax name)
                    {
                        fieldInitializers.Add(new FieldInitializer(
                            name.Identifier.Text,
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

            // A source-defined value aggregate (`struct` / `data struct`) has no
            // callable constructor surface in G#: it is constructed with a struct
            // literal `T{Field: value, ...}` (spec §Struct literals). Map the
            // positional C# `new T(a, b)` to that literal by zipping the arguments
            // with the type's settable instance members in declaration order
            // (ADR-0115 §B.4). Imported/BCL structs (e.g. `Guid`, `DateTime`,
            // `Span<T>` — all `SpecialType.None`) DO expose real constructors that
            // G# can call directly (`Guid(bytes, true)`), so they must fall through
            // to a constructor call rather than be zipped into a bogus literal over
            // the type's *properties*.
            if (typeSymbol is INamedTypeSymbol { TypeKind: TypeKind.Struct, SpecialType: SpecialType.None } valueType &&
                !valueType.IsTupleType &&
                !valueType.DeclaringSyntaxReferences.IsEmpty &&
                arguments.Count > 0)
            {
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

            return BuildConstruction(type, arguments, creation);
        }

        /// <summary>
        /// Builds the canonical G# construction expression for a C# <c>new</c>:
        /// a call on the type name carrying any bracket type arguments
        /// (<c>List[int32](...)</c>, ADR-0115 §B.7).
        /// </summary>
        private static GExpression BuildConstruction(GTypeReference type, IReadOnlyList<GExpression> arguments, ObjectCreationExpressionSyntax creation)
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

            return new InvocationExpression(new IdentifierExpression(creation.Type.ToString()), arguments);
        }

        /// <summary>
        /// Maps a constructed type's G# name to a callable construction callee.
        /// The G# alias <c>object</c> is a keyword, not a function, so constructing
        /// a <see cref="object"/> (<c>new object()</c> / target-typed <c>new()</c>)
        /// must spell the qualified type name <c>System.Object</c> instead (OD-T3,
        /// otherwise GS0130 "Function 'object' doesn't exist").
        /// </summary>
        private static string ConstructionCalleeName(string typeName) =>
            typeName == "object" ? "System.Object" : typeName;

        /// <summary>
        /// Attempts to translate a C# collection initializer into a canonical G#
        /// collection initializer (ADR-0117). Returns <see langword="false"/> when
        /// the initializer is not a collection initializer (e.g. a plain object
        /// initializer), leaving the caller's other mappings to apply.
        /// </summary>
        private bool TryTranslateCollectionInitializer(
            ObjectCreationExpressionSyntax creation,
            GTypeReference type,
            IReadOnlyList<GExpression> arguments,
            out GExpression result)
        {
            result = null;
            InitializerExpressionSyntax initializer = creation.Initializer;

            bool isCollectionInitializer = initializer.IsKind(SyntaxKind.CollectionInitializerExpression);
            bool isIndexedObjectInitializer = initializer.IsKind(SyntaxKind.ObjectInitializerExpression) &&
                initializer.Expressions.Count > 0 &&
                initializer.Expressions.All(e =>
                    e is AssignmentExpressionSyntax { Left: ImplicitElementAccessSyntax });

            if (!isCollectionInitializer && !isIndexedObjectInitializer)
            {
                return false;
            }

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
                        return false;
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
                        return false;
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

            GExpression construction = BuildConstruction(type, arguments, creation);
            result = new CollectionInitializerExpression(construction, elements);
            return true;
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
                        name.Identifier.Text,
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
                    blockBody: new BlockStatement(this.TranslateExpressionStatements((ExpressionSyntax)lambda.Body).ToList()),
                    isAsync: isAsync);
            }

            return new LambdaExpression(
                parameters,
                expressionBody: this.TranslateExpression((ExpressionSyntax)lambda.Body),
                isAsync: isAsync);
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
                return this.MapParameter(symbol);
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

        // The set of hard G# keywords (Cs2Gs.Compiler SyntaxFacts.GetKeywordKind).
        // A C# identifier that collides with one of these cannot be emitted bare; it
        // is suffixed with `_` consistently at every declaration and reference site.
        private static string SanitizeIdentifier(string name)
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
                : creation.ArgumentList.Arguments
                    .Select(a => this.TranslateArgument(a))
                    .ToList();

            // A source-defined value aggregate is constructed with a composite
            // literal; a reference type — or an imported/BCL struct with a real
            // constructor — with a call on the (bracketed-generic) type name.
            if (typeSymbol is INamedTypeSymbol { TypeKind: TypeKind.Struct, SpecialType: SpecialType.None } valueType &&
                !valueType.IsTupleType &&
                !valueType.DeclaringSyntaxReferences.IsEmpty &&
                creation.Initializer == null)
            {
                List<string> targetNames = OrderedValueMemberNames(valueType);
                if (targetNames.Count == arguments.Count && arguments.Count > 0)
                {
                    var fieldInitializers = new List<FieldInitializer>();
                    for (int i = 0; i < arguments.Count; i++)
                    {
                        fieldInitializers.Add(new FieldInitializer(targetNames[i], arguments[i]));
                    }

                    return new CompositeLiteralExpression(type, fieldInitializers);
                }
            }

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

        private GExpression TranslateSwitchExpression(SwitchExpressionSyntax node)
        {
            GExpression subject = this.TranslateExpression(node.GoverningExpression);
            var arms = new List<SwitchArm>();

            foreach (SwitchExpressionArmSyntax arm in node.Arms)
            {
                // Issue #991: C# `when` guards now have a canonical G# form.
                GExpression guard = arm.WhenClause != null
                    ? this.TranslateExpression(arm.WhenClause.Condition)
                    : null;

                var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                GPattern pattern = this.TranslatePattern(arm.Pattern, bindings);

                foreach ((ISymbol symbol, GExpression replacement) in bindings)
                {
                    this.patternBindings[symbol] = replacement;
                }

                GExpression body;
                try
                {
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
                // G# form, so each label is emitted as its own arm sharing the body.
                var labels = section.Labels.ToList();
                BlockStatement body = this.TranslateSwitchSectionBody(section);

                foreach (SwitchLabelSyntax label in labels)
                {
                    switch (label)
                    {
                        case CasePatternSwitchLabelSyntax patternLabel:
                            var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
                            GPattern pattern = this.TranslatePattern(patternLabel.Pattern, bindings);

                            // Issue #991: C# `when` guards now have a canonical G# form.
                            GExpression guard = patternLabel.WhenClause != null
                                ? this.TranslateExpression(patternLabel.WhenClause.Condition)
                                : null;
                            cases.Add(new SwitchStatementCase(pattern, body, guard));
                            break;

                        case CaseSwitchLabelSyntax valueLabel:
                            cases.Add(new SwitchStatementCase(
                                new ConstantPattern(this.TranslateExpression(valueLabel.Value)),
                                body));
                            break;

                        case DefaultSwitchLabelSyntax:
                            cases.Add(new SwitchStatementCase(null, body));
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
            // `foreach ((a, b) in xs)` / `foreach (var (a, b) in xs)` map to the
            // G# two-name iteration `for a, b in xs` (ForInStatement key/value form;
            // ADR-0115 §B). Tuple element names are collected from the designation.
            List<string> names = new List<string>();
            CollectForEachVariableNames(node.Variable, names);

            if (names.Count == 2)
            {
                return new ForInStatement(
                    names[0],
                    names[1],
                    this.TranslateReceiverWithNullForgiveness(node.Expression),
                    this.TranslateStatementAsBlock(node.Statement));
            }

            this.context.ReportUnsupported(
                node,
                "foreach tuple deconstruction with arity != 2 has no canonical G# form yet (ADR-0115 §B).");
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
                        variable.Identifier.Text,
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
                            sub.NameColon.Name.Identifier.Text,
                            this.TranslatePattern(sub.Pattern, bindings)));
                    }
                }

                return new PropertyPattern(fields);
            }

            // Typed recursive pattern: synthesize a designator named after the type
            // (`circle`), and rewrite each `Name: var x` property binding to a
            // member access on that designator (`circle.Radius`).
            string designator = recursive.Designation is SingleVariableDesignationSyntax named
                ? named.Identifier.Text
                : LowerCamel(recursive.Type.ToString());

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
                                sub.NameColon.Name.Identifier.Text)));
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
                new List<Parameter> { new Parameter(rangeVar, rangeType) },
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
