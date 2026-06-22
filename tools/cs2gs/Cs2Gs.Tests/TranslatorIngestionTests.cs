// <copyright file="TranslatorIngestionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Smoke tests for the Roslyn front-end ingestion (ADR-0115 §A, issue #914 step
/// 5): the in-memory and MSBuild project loaders, and the visitor-skeleton
/// entry point. These do not exercise full node mapping (steps 6–8) — they
/// assert the compilation binds, symbols resolve, and unsupported constructs are
/// recorded rather than dropped.
/// </summary>
public class TranslatorIngestionTests
{
    private const string InlineSource = @"
using System;

namespace Sample.Geometry
{
    public class Point
    {
        public int Describe(int x)
        {
            return x + 1;
        }
    }
}
";

    /// <summary>
    /// The secondary in-memory loader binds a small snippet and the semantic
    /// model resolves the class and method symbols.
    /// </summary>
    [Fact]
    public void InMemoryLoader_BindsAndResolvesSymbols()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Point.cs", InlineSource) });

        Assert.True(
            project.BoundWithoutErrors,
            "Inline snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var root = document.GetRoot();

        ClassDeclarationSyntax classSyntax = root.DescendantNodes()
            .OfType<ClassDeclarationSyntax>()
            .Single();
        var classSymbol = document.SemanticModel.GetDeclaredSymbol(classSyntax) as INamedTypeSymbol;
        Assert.NotNull(classSymbol);
        Assert.Equal("Point", classSymbol.Name);
        Assert.Equal("Sample.Geometry", classSymbol.ContainingNamespace.ToDisplayString());

        MethodDeclarationSyntax methodSyntax = root.DescendantNodes()
            .OfType<MethodDeclarationSyntax>()
            .Single();
        var methodSymbol = document.SemanticModel.GetDeclaredSymbol(methodSyntax) as IMethodSymbol;
        Assert.NotNull(methodSymbol);
        Assert.Equal("Describe", methodSymbol.Name);
        Assert.Equal(SpecialType.System_Int32, methodSymbol.ReturnType.SpecialType);
    }

    /// <summary>
    /// The primary <see cref="CSharpProjectLoader.LoadProjectAsync(string, System.Threading.CancellationToken)"/>
    /// opens the real <c>L1-Console</c> corpus project through
    /// <see cref="Microsoft.CodeAnalysis.MSBuild.MSBuildWorkspace"/>, binds with no
    /// C# errors, and a known program type (<c>Cart</c>) resolves.
    /// </summary>
    [Fact]
    public async Task ProjectLoader_OpensL1ConsoleCorpusAndBinds()
    {
        string projectPath = ResolveCorpusProject("L1-Console", "L1-Console.csproj");

        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);

        Assert.True(
            project.BoundWithoutErrors,
            "L1-Console should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.NotEmpty(project.Documents);

        INamedTypeSymbol cart = project.Compilation.GetTypeByMetadataName("Corpus.L1.Cart");
        Assert.NotNull(cart);
        Assert.Contains(cart.GetMembers(), m => m.Name == "Subtotal");
    }

    /// <summary>
    /// <see cref="CSharpToGSharpTranslator.TranslateDocument(LoadedDocument, TranslationContext)"/>
    /// emits the G# frame (package + imports), maps the type with the B.10
    /// default-visibility rule (C# <c>public</c> → G# default, omitted), and routes
    /// the not-yet-translated method body through the deferred body seam as a
    /// structured <c>body-pending</c> Info diagnostic (never silently dropped).
    /// </summary>
    [Fact]
    public void TranslateDocument_EmitsFrameAndRecordsPendingBodies()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Point.cs", InlineSource) });
        LoadedDocument document = Assert.Single(project.Documents);

        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        var translator = new CSharpToGSharpTranslator();

        CompilationUnit unit = translator.TranslateDocument(document, context);

        Assert.Equal("Sample.Geometry", unit.Package);
        ImportDirective import = Assert.Single(unit.Imports);
        Assert.Equal("System", import.Name);

        TypeDeclaration type = Assert.IsType<TypeDeclaration>(Assert.Single(unit.Members));
        Assert.Equal("Point", type.Name);
        Assert.Equal(TypeDeclarationKind.Class, type.Kind);
        Assert.Equal(Visibility.Default, type.Visibility);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Info &&
                d.ConstructKind == "body-pending" &&
                d.Message.Contains("Describe"));
    }

    private static string ResolveCorpusProject(string projectFolder, string projectFile)
    {
        // Walk up from the test assembly location until the cs2gs corpus is found,
        // so the test is independent of the working directory / build layout.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(
                dir.FullName, "tools", "cs2gs", "corpus", projectFolder, projectFile);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new FileNotFoundException(
            $"Could not locate corpus project '{projectFolder}/{projectFile}' above {AppContext.BaseDirectory}.");
    }
}
