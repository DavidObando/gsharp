// <copyright file="Issue2546ImplicitUsingsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

open class Issue2546ImplicitUsingsTests {
    @Fact
    async func EffectiveGlobalUsings_ImportOnlyNamespacesUsedByBareFrameworkTypes() {
        let projectPath string? = TestFixtureSource.Resolve(
            "tools",
            "cs2gs",
            "Cs2Gs.Tests",
            "Fixtures",
            "Issue2546ImplicitUsings",
            "Issue2546ImplicitUsings.csproj"
        )
        let project = await CSharpProjectLoader.LoadProjectAsync(projectPath)
        Assert.True(
            project.BoundWithoutErrors,
            "Fixture should bind through its SDK-generated global usings: " + string.Join(
                Environment.NewLine,
                project.ErrorDiagnostics
            )
        )
        Assert.Contains(
            project.Compilation.SyntaxTrees,
            (tree SyntaxTree) -> tree.FilePath.EndsWith("GlobalUsings.g.cs", StringComparison.Ordinal)
        )
        Assert.DoesNotContain(
            project.Documents,
            (document LoadedDocument) -> document.FilePath.EndsWith("GlobalUsings.g.cs", StringComparison.Ordinal)
        )
        let document = Assert.Single(
            project.Documents,
            (item LoadedDocument) -> item.FilePath.EndsWith("Consumer.cs", StringComparison.Ordinal)
        )
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.Equal(
            []string{
                "System",
                "System.Collections.Generic",
                "System.IO",
                "System.Net.Http",
                "System.Text.RegularExpressions",
                "System.Threading",
                "System.Threading.Tasks"
            },
            unit.Imports.Select((importDirective ImportDirective) -> importDirective.Name)
        )
        Assert.DoesNotContain(
            unit.Imports,
            (importDirective ImportDirective) -> importDirective.Name == "System.Globalization"
        )
        Assert.DoesNotContain(unit.Imports, (importDirective ImportDirective) -> importDirective.Name == "System.Linq")
    }
}
