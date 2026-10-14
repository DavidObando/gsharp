// <copyright file="TranslatorIngestionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Smoke tests for the Roslyn front-end ingestion (ADR-0115 §A, issue #914 step
/// 5): the in-memory and MSBuild project loaders, and the visitor-skeleton
/// entry point. These do not exercise full node mapping (steps 6–8) — they
/// assert the compilation binds, symbols resolve, and unsupported constructs are
/// recorded rather than dropped.
open class TranslatorIngestionTests {
    /// The secondary in-memory loader binds a small snippet and the semantic
    /// model resolves the class and method symbols.
    @Fact
    func InMemoryLoader_BindsAndResolvesSymbols() {
        let project = CSharpProjectLoader.LoadInMemory([](string, InlineSource string){("Point.cs", InlineSource)})
        Assert.True(
            project.BoundWithoutErrors,
            "Inline snippet should bind with no C# errors: " + string.Join(
                Environment.NewLine,
                project.ErrorDiagnostics
            )
        )
        let document = Assert.Single(project.Documents)
        let root = document.GetRoot()
        let classSyntax = root.DescendantNodes().OfType[ClassDeclarationSyntax]().Single()
        let classSymbol INamedTypeSymbol? = document.SemanticModel.GetDeclaredSymbol(classSyntax) as INamedTypeSymbol
        Assert.NotNull(classSymbol)
        Assert.Equal("Point", classSymbol!!.Name)
        Assert.Equal("Sample.Geometry", classSymbol!!.ContainingNamespace.ToDisplayString())
        let methodSyntax = root.DescendantNodes().OfType[MethodDeclarationSyntax]().Single()
        let methodSymbol IMethodSymbol? = document.SemanticModel.GetDeclaredSymbol(methodSyntax) as IMethodSymbol
        Assert.NotNull(methodSymbol)
        Assert.Equal("Describe", methodSymbol!!.Name)
        Assert.Equal(SpecialType.System_Int32, methodSymbol!!.ReturnType.SpecialType)
    }

    /// The primary (cref:CSharpProjectLoader.LoadProjectAsync(string, System.Threading.CancellationToken))
    /// opens the real `L1-Console` corpus project through
    /// (cref:Microsoft.CodeAnalysis.MSBuild.MSBuildWorkspace), binds with no
    /// C# errors, and a known program type (`Cart`) resolves.
    @Fact
    async func ProjectLoader_OpensL1ConsoleCorpusAndBinds() {
        let projectPath string? = ResolveCorpusProject("L1-Console", "L1-Console.csproj")
        let project = await CSharpProjectLoader.LoadProjectAsync(projectPath)
        Assert.True(
            project.BoundWithoutErrors,
            "L1-Console should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        Assert.NotEmpty(project.Documents)
        let cart INamedTypeSymbol? = project.Compilation.GetTypeByMetadataName("Corpus.L1.Cart")
        Assert.NotNull(cart)
        Assert.Contains(cart!!.GetMembers(), (m ISymbol) -> m.Name == "Subtotal")
    }

    /// (cref:CSharpToGSharpTranslator.TranslateDocument(LoadedDocument, TranslationContext))
    /// emits the G# frame (package + imports), maps the type with the B.10
    /// default-visibility rule (C# `public` → G# default, omitted), and
    /// translates the method body (step 7) into structured statements — no
    /// `body-pending` placeholder remains.
    @Fact
    func TranslateDocument_EmitsFrameAndTranslatesBodies() {
        let project = CSharpProjectLoader.LoadInMemory([](string, InlineSource string){("Point.cs", InlineSource)})
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translator = CSharpToGSharpTranslator()
        let unit = translator.TranslateDocument(document, context)
        Assert.Equal("Sample.Geometry", unit.Package)
        let import_ = Assert.Single(unit.Imports)
        Assert.Equal("System", import_.Name)
        let type = Assert.IsType[TypeDeclaration](Assert.Single(unit.Members))
        Assert.Equal("Point", type.Name)
        Assert.Equal(TypeDeclarationKind.Class, type.Kind)
        Assert.Equal(Visibility.Default, type.Visibility)
        // The body seam no longer defers: there is no body-pending diagnostic and
        // the `return x + 1;` body became a real return statement.
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.ConstructKind == "body-pending")
        let describe = type.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "Describe")
        let ret = Assert.IsType[ReturnStatement](Assert.Single(describe.Body!!.Statements))
        let sum = Assert.IsType[BinaryExpression](ret.Expression)
        Assert.Equal("+", sum.Operator)
    }

    shared {
        private const InlineSource string = `
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
`

        private func ResolveCorpusProject(
            projectFolder string,
            projectFile string
        ) string? -> TestFixtureSource.Resolve("tools", "cs2gs", "corpus", projectFolder, projectFile)
    }
}
