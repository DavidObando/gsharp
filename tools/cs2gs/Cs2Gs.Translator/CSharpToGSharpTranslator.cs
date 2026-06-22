// <copyright file="CSharpToGSharpTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
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
            if (member is BaseNamespaceDeclarationSyntax ns)
            {
                foreach (MemberDeclarationSyntax nested in ns.Members)
                {
                    yield return nested;
                }
            }
            else
            {
                yield return member;
            }
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

        // The syntax node whose body is currently being translated. It bounds the
        // data-flow scan that decides whether a local is mutable (var) or
        // immutable (let) per ADR-0115 §B.3.
        private SyntaxNode currentBodyScope;

        // When translating the body of a lifted owned-value-aggregate receiver
        // method (issue #938), the implicit `this.` of a bare instance-member
        // reference must be made explicit through the receiver name (`self.`),
        // because a top-level receiver-clause `func` has no implicit receiver.
        private string currentReceiverName;

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

                cases.Add(new EnumCase(member.Identifier.Text));
            }

            return new EnumDeclaration(node.Identifier.Text, cases, MapVisibility(symbol, this.context, node));
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
                case Accessibility.ProtectedOrInternal:
                case Accessibility.ProtectedAndInternal:
                    context.Report(new TranslationDiagnostic(
                        symbol.DeclaredAccessibility.ToString(),
                        $"'{symbol.Name}' is '{symbol.DeclaredAccessibility}'; G# has no 'protected' spelling, mapped to the nearest accessibility 'internal' (ADR-0115 §B.10).",
                        node?.GetLocation(),
                        TranslationSeverity.Warning));
                    return Visibility.Internal;
                default:
                    return Visibility.Default;
            }
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

        private static bool IsIntegral(object value) =>
            value is byte or sbyte or short or ushort or int or uint or long or ulong;

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
            // A `let` field is read-only everywhere in G# (including inside `init`),
            // so a `readonly` field assigned in the constructor must instead be a
            // field initializer or a primary-constructor parameter.
            ConstructorLift lift = this.AnalyzeConstructorLift(node, symbol, kind.Value);

            var instanceMembers = new List<GMember>();
            var sharedMembers = new List<GMember>();
            foreach (MemberDeclarationSyntax member in node.Members)
            {
                foreach ((GMember translated, bool isStatic) in this.TranslateMember(member, kind.Value, lift))
                {
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

            var members = new List<GMember>(instanceMembers);
            if (sharedMembers.Count > 0)
            {
                members.Add(new SharedBlock(sharedMembers));
            }

            (GTypeReference baseType, List<GTypeReference> interfaces) = this.MapBaseClause(symbol, node, kind.Value);
            List<TypeParameter> typeParameters = this.MapTypeParameters(symbol);
            IReadOnlyList<Parameter> primaryCtor = lift.DropConstructor
                ? lift.PrimaryParameters
                : this.MapPrimaryConstructor(node);

            bool isOpen = symbol != null &&
                kind == TypeDeclarationKind.Class &&
                !symbol.IsSealed &&
                !symbol.IsStatic &&
                this.subclassedBases.Contains(symbol.OriginalDefinition);

            return new TypeDeclaration(
                kind.Value,
                node.Identifier.Text,
                typeParameters: typeParameters,
                primaryConstructorParameters: primaryCtor,
                baseType: baseType,
                interfaces: interfaces,
                members: members,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen,
                isAbstract: symbol != null && symbol.IsAbstract && kind == TypeDeclarationKind.Class,
                attributes: this.MapAttributes(node.AttributeLists));
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
            if (symbol == null || (kind != TypeDeclarationKind.Class && kind != TypeDeclarationKind.Struct))
            {
                return ConstructorLift.None;
            }

            List<ConstructorDeclarationSyntax> instanceCtors = node.Members
                .OfType<ConstructorDeclarationSyntax>()
                .Where(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword))
                .ToList();

            // A record already owns a primary constructor, and zero or many
            // instance constructors are out of scope for the L1 canonicalization.
            if (instanceCtors.Count != 1 || node is RecordDeclarationSyntax)
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

        private IEnumerable<(GMember Member, bool IsStatic)> TranslateMember(
            MemberDeclarationSyntax member,
            TypeDeclarationKind ownerKind,
            ConstructorLift lift)
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

                case PropertyDeclarationSyntax property:
                    if (lift.PropertiesAsPrimaryParameters.Contains(property.Identifier.Text))
                    {
                        break;
                    }

                    yield return this.TranslateProperty(property);
                    break;

                case ConstructorDeclarationSyntax ctor:
                    // T2: a fully-lifted constructor is dropped entirely; its field
                    // initialization moved to field initializers / primary-ctor
                    // parameters (ADR-0115 §B.3).
                    if (lift.DropConstructor && lift.Constructor == ctor)
                    {
                        break;
                    }

                    GMember built = this.TranslateConstructor(ctor);
                    if (built != null)
                    {
                        yield return (built, ctor.Modifiers.Any(SyntaxKind.StaticKeyword));
                    }

                    break;

                case BaseTypeDeclarationSyntax nestedType:
                    GMember nested = this.Visit(nestedType);
                    if (nested != null)
                    {
                        yield return (nested, true);
                    }

                    break;

                default:
                    this.context.ReportUnsupported(
                        member,
                        $"member '{member.Kind()}' has no canonical G# mapping yet (ADR-0115 §B.11).");
                    break;
            }
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
                    initializer = this.TranslateExpression(declarator.Initializer.Value);
                }

                var declaration = new FieldDeclaration(
                    binding,
                    declarator.Identifier.Text,
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
                // non-owned type (ADR-0115 §B.5).
                IParameterSymbol self = symbol.Parameters.FirstOrDefault();
                if (self != null)
                {
                    receiver = new Receiver(
                        self.Name,
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

            bool isOverride = symbol != null && symbol.IsOverride;

            // Interface members are implicitly abstract in C#; in canonical G# the
            // members of an `interface` carry no modifier (the `open` keyword is for
            // virtual/abstract members of a class). Suppress `open` for them so the
            // emitted G# round-trips (ADR-0115 §B.6).
            bool inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface;
            bool isOpen = symbol != null && (symbol.IsVirtual || symbol.IsAbstract) && !symbol.IsOverride && !inInterface;

            var method = new MethodDeclaration(
                node.Identifier.Text,
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

        private (GMember Member, bool IsStatic) TranslateProperty(PropertyDeclarationSyntax node)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            bool isStatic = symbol != null && symbol.IsStatic;

            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            List<PropertyAccessor> accessors = this.MapAccessors(node);

            bool isOverride = symbol != null && symbol.IsOverride;

            // Interface members are implicitly abstract; canonical G# interface
            // members carry no `open` modifier (ADR-0115 §B.6).
            bool inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface;
            bool isOpen = symbol != null && (symbol.IsVirtual || symbol.IsAbstract) && !symbol.IsOverride && !inInterface;

            var property = new PropertyDeclaration(
                node.Identifier.Text,
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
            // An expression-bodied property (=> expr) is a get-only computed
            // property; its body is deferred to step 7 (ADR-0115 §B.11).
            if (node.ExpressionBody != null)
            {
                return new List<PropertyAccessor>
                {
                    new PropertyAccessor(
                        AccessorKind.Get,
                        this.TranslateBody(node, $"property '{node.Identifier.Text}' getter")),
                };
            }

            if (node.AccessorList == null)
            {
                return new List<PropertyAccessor>();
            }

            IReadOnlyList<AccessorDeclarationSyntax> declared = node.AccessorList.Accessors;
            bool anyBodied = declared.Any(a => a.Body != null || a.ExpressionBody != null);
            bool hasSet = declared.Any(a =>
                a.IsKind(SyntaxKind.SetAccessorDeclaration) || a.IsKind(SyntaxKind.InitAccessorDeclaration));
            bool hasGet = declared.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));

            // A read-write auto-property (all accessors body-less, has get + set)
            // maps to the canonical auto form `prop Name T` (ADR-0115 §B.11).
            if (!anyBodied && hasGet && hasSet)
            {
                return new List<PropertyAccessor>();
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
                    // G# has no 'init' accessor (spec property grammar only allows
                    // get/set); map to 'set' and record the discovered gap.
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.InitAccessorDeclaration),
                        $"property '{node.Identifier.Text}' uses an 'init' accessor; G# has no 'init' accessor, mapped to 'set' (discovered gap, ADR-0115 §B.11).",
                        accessor.GetLocation(),
                        TranslationSeverity.Info));
                    kind = AccessorKind.Set;
                }
                else
                {
                    kind = AccessorKind.Set;
                }

                bool bodied = accessor.Body != null || accessor.ExpressionBody != null;
                BlockStatement body = bodied
                    ? this.TranslateBody(
                        accessor,
                        $"property '{node.Identifier.Text}' {kind.ToString().ToLowerInvariant()}ter")
                    : null;
                accessors.Add(new PropertyAccessor(kind, body));
            }

            return accessors;
        }

        private GMember TranslateConstructor(ConstructorDeclarationSyntax node)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            if (node.Modifiers.Any(SyntaxKind.StaticKeyword))
            {
                this.context.ReportUnsupported(
                    node,
                    "static constructors have no canonical G# form yet (ADR-0115 §B.11).");
                return null;
            }

            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);

            if (node.Initializer != null)
            {
                this.context.Report(new TranslationDiagnostic(
                    "ConstructorInitializer",
                    $"constructor on '{node.Identifier.Text}' chains to '{node.Initializer.ThisOrBaseKeyword.Text}(...)'; the chained arguments are deferred to step 7 (issue #914).",
                    node.Initializer.GetLocation(),
                    TranslationSeverity.Info));
            }

            BlockStatement body = this.TranslateBody(node, $"constructor on '{node.Identifier.Text}'");

            return new ConstructorDeclaration(
                parameters,
                body,
                baseArguments: null,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists));
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
            // `IEquatable<Self>`. Emitting the synthesized `IEquatable[Self]` base
            // clause is both redundant and rejected by the parser on a positional
            // declaration, so it is dropped here (ADR-0115 §B.4).
            bool isData = kind == TypeDeclarationKind.DataClass || kind == TypeDeclarationKind.DataStruct;
            foreach (INamedTypeSymbol iface in symbol.Interfaces)
            {
                if (isData && IsIEquatableOf(iface, symbol))
                {
                    continue;
                }

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
                flags.Add("new()");
            }

            string legacy = null;
            if (tp.ConstraintTypes.Length > 0)
            {
                legacy = tp.ConstraintTypes[0].Name;
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

            return new Parameter(symbol.Name, type, variadic, refKind, defaultValue);
        }

        private GTypeReference MapReturnType(IMethodSymbol symbol, MethodDeclarationSyntax node)
        {
            if (symbol != null)
            {
                return symbol.ReturnsVoid
                    ? null
                    : this.typeMapper.Map(symbol.ReturnType, this.context, node.ReturnType.GetLocation());
            }

            return node.ReturnType is PredefinedTypeSyntax predefined &&
                predefined.Keyword.IsKind(SyntaxKind.VoidKeyword)
                    ? null
                    : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
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

                    attributes.Add(new AttributeUse(attribute.Name.ToString(), arguments, target));
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
                return this.TranslateBodyCore(bodyOwner, description);
            }
            finally
            {
                this.currentBodyScope = previousScope;
            }
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
            }

            // No recognizable body; emit an empty parseable block.
            return new BlockStatement(new List<GStatement>());
        }

        private BlockStatement WrapExpressionBody(ExpressionSyntax expression, bool isVoid)
        {
            GExpression translated = this.TranslateExpression(expression);
            GStatement statement = isVoid
                ? new ExpressionStatement(translated)
                : new ReturnStatement(translated);
            return new BlockStatement(new List<GStatement> { statement });
        }

        private BlockStatement TranslateBlock(BlockSyntax block)
        {
            var statements = new List<GStatement>();
            foreach (StatementSyntax statement in block.Statements)
            {
                statements.AddRange(this.TranslateStatement(statement));
            }

            return new BlockStatement(statements);
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
                    return this.TranslateLocalDeclaration(local.Declaration, local.IsConst);

                case ExpressionStatementSyntax expressionStatement:
                    return new[] { this.TranslateExpressionStatement(expressionStatement.Expression) };

                case ReturnStatementSyntax ret:
                    return new[]
                    {
                        (GStatement)new ReturnStatement(
                            ret.Expression == null ? null : this.TranslateExpression(ret.Expression)),
                    };

                case IfStatementSyntax ifStatement:
                    return new[] { this.TranslateIf(ifStatement) };

                case WhileStatementSyntax whileStatement:
                    return new[]
                    {
                        (GStatement)new WhileStatement(
                            this.TranslateExpression(whileStatement.Condition),
                            this.TranslateStatementAsBlock(whileStatement.Statement)),
                    };

                case ForStatementSyntax forStatement:
                    return new[] { this.TranslateForStatement(forStatement) };

                case ForEachStatementSyntax forEach:
                    return new[]
                    {
                        (GStatement)new ForInStatement(
                            forEach.Identifier.Text,
                            this.TranslateExpression(forEach.Expression),
                            this.TranslateStatementAsBlock(forEach.Statement)),
                    };

                case ThrowStatementSyntax throwStatement:
                    return new[]
                    {
                        (GStatement)new ThrowStatement(
                            throwStatement.Expression == null
                                ? new IdentifierExpression("nil")
                                : this.TranslateExpression(throwStatement.Expression)),
                    };

                case BlockSyntax block:
                    return new[] { (GStatement)this.TranslateBlock(block) };

                case EmptyStatementSyntax:
                    return System.Array.Empty<GStatement>();

                default:
                    this.context.ReportUnsupported(
                        statement,
                        $"statement '{statement.Kind()}' has no canonical G# form yet; emitted a placeholder comment (ADR-0115 §B).");
                    return new[] { (GStatement)new RawStatement($"// unsupported: {statement.Kind()}") };
            }
        }

        private IEnumerable<GStatement> TranslateLocalDeclaration(VariableDeclarationSyntax declaration, bool isConst)
        {
            var results = new List<GStatement>();
            bool hasExplicitType = !declaration.Type.IsVar;

            foreach (VariableDeclaratorSyntax declarator in declaration.Variables)
            {
                GExpression initializer = declarator.Initializer == null
                    ? null
                    : this.TranslateExpression(declarator.Initializer.Value);

                BindingKind binding;
                if (isConst)
                {
                    binding = BindingKind.Const;
                }
                else
                {
                    var local = this.context.GetDeclaredSymbol(declarator) as ILocalSymbol;
                    binding = local != null && this.IsLocalReassigned(local)
                        ? BindingKind.Var
                        : BindingKind.Let;
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
                }

                results.Add(new LocalDeclarationStatement(
                    binding,
                    declarator.Identifier.Text,
                    type,
                    initializer));
            }

            return results;
        }

        private GStatement TranslateExpressionStatement(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case AssignmentExpressionSyntax assignment:
                    string op = assignment.OperatorToken.Text;
                    return new AssignmentStatement(
                        this.TranslateExpression(assignment.Left),
                        this.TranslateExpression(assignment.Right),
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

        private GStatement TranslateIf(IfStatementSyntax ifStatement)
        {
            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);
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

            return new IfStatement(this.TranslateExpression(ifStatement.Condition), then, elseBranch);
        }

        private GStatement TranslateForStatement(ForStatementSyntax forStatement)
        {
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

        private bool BindsTo(ExpressionSyntax expression, ILocalSymbol local)
        {
            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            return symbol != null && SymbolEqualityComparer.Default.Equals(symbol, local);
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

                case BinaryExpressionSyntax binary:
                    return new BinaryExpression(
                        this.TranslateExpression(binary.Left),
                        binary.OperatorToken.Text,
                        this.TranslateExpression(binary.Right));

                case PrefixUnaryExpressionSyntax prefix:
                    return new UnaryExpression(
                        prefix.OperatorToken.Text,
                        this.TranslateExpression(prefix.Operand));

                case ParenthesizedExpressionSyntax parenthesized:
                    return new ParenthesizedExpression(this.TranslateExpression(parenthesized.Expression));

                case InterpolatedStringExpressionSyntax interpolated:
                    return this.TranslateInterpolatedString(interpolated);

                case TupleExpressionSyntax tuple:
                    return new TupleLiteralExpression(
                        tuple.Arguments.Select(a => this.TranslateExpression(a.Expression)).ToList());

                case ElementAccessExpressionSyntax elementAccess:
                    GExpression index = elementAccess.ArgumentList.Arguments.Count > 0
                        ? this.TranslateExpression(elementAccess.ArgumentList.Arguments[0].Expression)
                        : new IdentifierExpression("nil");
                    return new IndexExpression(
                        this.TranslateExpression(elementAccess.Expression),
                        index);

                default:
                    this.context.ReportUnsupported(
                        expression,
                        $"expression '{expression.Kind()}' has no canonical G# form yet; emitted an identifier placeholder (ADR-0115 §B).");
                    return new IdentifierExpression("nil");
            }
        }

        private GExpression TranslateIdentifierName(IdentifierNameSyntax identifier)
        {
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

            return new IdentifierExpression(identifier.Identifier.Text);
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
                    return value is float or double or decimal
                        ? LiteralExpression.Float(literal.Token.Text)
                        : LiteralExpression.Int(literal.Token.Text);

                case SyntaxKind.StringLiteralExpression:
                    return LiteralExpression.String(literal.Token.ValueText);

                case SyntaxKind.CharacterLiteralExpression:
                    return LiteralExpression.Char(literal.Token.ValueText);

                case SyntaxKind.TrueLiteralExpression:
                    return LiteralExpression.Bool(true);

                case SyntaxKind.FalseLiteralExpression:
                    return LiteralExpression.Bool(false);

                case SyntaxKind.NullLiteralExpression:
                    return LiteralExpression.Null();

                default:
                    this.context.ReportUnsupported(
                        literal,
                        $"literal '{literal.Kind()}' has no canonical G# form yet; emitted nil (ADR-0115 §B.12).");
                    return LiteralExpression.Null();
            }
        }

        private GExpression TranslateMemberAccess(MemberAccessExpressionSyntax member)
        {
            GExpression target = this.TranslateExpression(member.Expression);
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

            return new MemberAccessExpression(target, memberName);
        }

        private GExpression TranslateInvocation(InvocationExpressionSyntax invocation)
        {
            GExpression target;
            IReadOnlyList<GTypeReference> typeArguments = null;

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
                .Select(a => this.TranslateExpression(a.Expression))
                .ToList();

            return new InvocationExpression(target, arguments, typeArguments);
        }

        private GExpression TranslateObjectCreation(ObjectCreationExpressionSyntax creation)
        {
            ITypeSymbol typeSymbol = this.context.GetTypeInfo(creation).Type;
            GTypeReference type = typeSymbol != null
                ? this.typeMapper.Map(typeSymbol, this.context, creation.GetLocation())
                : new NamedTypeReference(creation.Type.ToString());

            // An object initializer `new T { Field = value, ... }` (no/empty
            // constructor argument list) maps to the canonical G# struct literal
            // `T{Field: value, ...}` (spec §Struct literals; ADR-0115 §B.11).
            bool hasCtorArgs = creation.ArgumentList != null && creation.ArgumentList.Arguments.Count > 0;
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

            var arguments = creation.ArgumentList == null
                ? new List<GExpression>()
                : creation.ArgumentList.Arguments
                    .Select(a => this.TranslateExpression(a.Expression))
                    .ToList();

            // A value aggregate (`struct` / `data struct`) has no callable
            // constructor surface in G#: it is constructed with a struct literal
            // `T{Field: value, ...}` (spec §Struct literals). Map the positional C#
            // `new T(a, b)` to that literal by zipping the arguments with the
            // type's settable instance members in declaration order (ADR-0115 §B.4).
            if (typeSymbol is INamedTypeSymbol { TypeKind: TypeKind.Struct, SpecialType: SpecialType.None } valueType &&
                !valueType.IsTupleType &&
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

            // A G# construction is a call on the type name; generic types carry
            // their type arguments in brackets: `List[int32](...)` (ADR-0115 §B.7).
            if (type is NamedTypeReference named)
            {
                IReadOnlyList<GTypeReference> typeArguments = named.TypeArguments.Count > 0
                    ? named.TypeArguments
                    : null;
                return new InvocationExpression(
                    new IdentifierExpression(named.Name),
                    arguments,
                    typeArguments);
            }

            return new InvocationExpression(new IdentifierExpression(creation.Type.ToString()), arguments);
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
        }
    }
}
