// <copyright file="CSharpToGSharpTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
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
/// This is the <b>step-5 skeleton</b>: it fully builds the trivial file frame —
/// the <c>package</c> from the C# namespace and the <c>import</c> block from the
/// <c>using</c> directives (ADR-0115 §B.1) — and lays down the dispatch seams for
/// type and member declarations. The real node mapping (bodies, expressions,
/// statements) is steps 6–8; every construct not yet mapped is recorded as a
/// structured <see cref="TranslationDiagnostic"/> on the
/// <see cref="TranslationContext"/> rather than being silently dropped.
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
    /// <returns>The G# compilation unit (trivial frame + declaration shells).</returns>
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
    /// <returns>The G# compilation unit (trivial frame + declaration shells).</returns>
    public CompilationUnit TranslateDocument(LoadedDocument document, TranslationContext context)
    {
        CompilationUnitSyntax root = document.GetRoot();

        string package = this.ResolvePackage(root, context);
        IReadOnlyList<ImportDirective> imports = this.TranslateImports(root, context);

        var visitor = new DeclarationVisitor(context);
        var members = new List<GNode>();
        foreach (MemberDeclarationSyntax member in EnumerateTopLevelDeclarations(root))
        {
            GMember translated = visitor.Visit(member);
            if (translated is not null)
            {
                members.Add(translated);
            }
        }

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

    private static Visibility MapVisibility(ISymbol symbol)
    {
        if (symbol is null)
        {
            return Visibility.Default;
        }

        switch (symbol.DeclaredAccessibility)
        {
            case Accessibility.Public:
                return Visibility.Public;
            case Accessibility.Private:
                return Visibility.Private;
            case Accessibility.Internal:
                return Visibility.Internal;
            default:
                return Visibility.Default;
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
    /// The step-5 declaration dispatcher: a <see cref="CSharpSyntaxVisitor{TResult}"/>
    /// that builds the shell of each type declaration (kind, name, visibility) and
    /// records an unsupported-construct diagnostic for every member it does not yet
    /// translate. Steps 6–8 replace the per-member <c>ReportUnsupported</c> calls
    /// with real <see cref="GMember"/> construction.
    /// </summary>
    private sealed class DeclarationVisitor : CSharpSyntaxVisitor<GMember>
    {
        private readonly TranslationContext context;

        public DeclarationVisitor(TranslationContext context)
        {
            this.context = context;
        }

        public override GMember VisitClassDeclaration(ClassDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitStructDeclaration(StructDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitRecordDeclaration(RecordDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitInterfaceDeclaration(InterfaceDeclarationSyntax node) => this.VisitAggregate(node);

        public override GMember VisitEnumDeclaration(EnumDeclarationSyntax node)
        {
            ISymbol symbol = this.context.GetDeclaredSymbol(node);
            this.context.ReportUnsupported(
                node,
                $"enum '{node.Identifier.Text}' body translation is not yet implemented (step 6–8).");
            return new EnumDeclaration(
                node.Identifier.Text,
                new List<EnumCase>(),
                MapVisibility(symbol));
        }

        public override GMember VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            this.context.ReportUnsupported(
                node,
                $"method '{node.Identifier.Text}' translation is not yet implemented (step 6–8).");
            return null;
        }

        public override GMember VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
        {
            this.context.ReportUnsupported(
                node,
                $"constructor '{node.Identifier.Text}' translation is not yet implemented (step 6–8).");
            return null;
        }

        public override GMember VisitPropertyDeclaration(PropertyDeclarationSyntax node)
        {
            this.context.ReportUnsupported(
                node,
                $"property '{node.Identifier.Text}' translation is not yet implemented (step 6–8).");
            return null;
        }

        public override GMember VisitFieldDeclaration(FieldDeclarationSyntax node)
        {
            this.context.ReportUnsupported(
                node,
                "field declaration translation is not yet implemented (step 6–8).");
            return null;
        }

        public override GMember DefaultVisit(SyntaxNode node)
        {
            this.context.ReportUnsupported(
                node,
                $"'{node.Kind()}' has no step-5 translation; recorded for triage (ADR-0115 §B).");
            return null;
        }

        private GMember VisitAggregate(TypeDeclarationSyntax node)
        {
            TypeDeclarationKind? kind = MapAggregateKind(node);
            if (kind is null)
            {
                this.context.ReportUnsupported(node, $"unsupported aggregate kind '{node.Kind()}'.");
                return null;
            }

            ISymbol symbol = this.context.GetDeclaredSymbol(node);

            // Step 5 builds only the type shell (kind + name + visibility); member
            // bodies are recorded as unsupported until steps 6–8 implement them.
            var members = new List<GMember>();
            foreach (MemberDeclarationSyntax member in node.Members)
            {
                GMember translated = this.Visit(member);
                if (translated is not null)
                {
                    members.Add(translated);
                }
            }

            return new TypeDeclaration(
                kind.Value,
                node.Identifier.Text,
                members: members,
                visibility: MapVisibility(symbol));
        }
    }
}
