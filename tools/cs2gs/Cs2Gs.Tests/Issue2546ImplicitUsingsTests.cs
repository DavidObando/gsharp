// <copyright file="Issue2546ImplicitUsingsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue2546ImplicitUsingsTests
{
    [Fact]
    public async Task EffectiveGlobalUsings_ImportOnlyNamespacesUsedByBareFrameworkTypes()
    {
        string projectPath = Path.Combine(
            AppContext.BaseDirectory,
            "Fixtures",
            "Issue2546ImplicitUsings",
            "Issue2546ImplicitUsings.csproj");
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);

        Assert.True(
            project.BoundWithoutErrors,
            "Fixture should bind through its SDK-generated global usings: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Contains(
            project.Compilation.SyntaxTrees,
            tree => tree.FilePath.EndsWith("GlobalUsings.g.cs", StringComparison.Ordinal));
        Assert.DoesNotContain(
            project.Documents,
            document => document.FilePath.EndsWith("GlobalUsings.g.cs", StringComparison.Ordinal));

        LoadedDocument document = Assert.Single(
            project.Documents,
            item => item.FilePath.EndsWith("Consumer.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Equal(
            new[]
            {
                "System",
                "System.Collections.Generic",
                "System.IO",
                "System.Net.Http",
                "System.Text.RegularExpressions",
                "System.Threading",
                "System.Threading.Tasks",
            },
            unit.Imports.Select(importDirective => importDirective.Name));
        Assert.DoesNotContain(unit.Imports, importDirective => importDirective.Name == "System.Globalization");
        Assert.DoesNotContain(unit.Imports, importDirective => importDirective.Name == "System.Linq");
    }
}
