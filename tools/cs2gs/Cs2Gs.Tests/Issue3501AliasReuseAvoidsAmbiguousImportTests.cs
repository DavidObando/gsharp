// <copyright file="Issue3501AliasReuseAvoidsAmbiguousImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (GS0532 family in the migrated Translator): when a C# file
/// references an aliased type (`using GSharpSyntaxFacts =
/// GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts;`) in symbol-only positions,
/// the mapper used to shorten to the bare name and synthesize a WHOLE-NAMESPACE
/// import — which made other simple names (`AssignmentExpressionSyntax`,
/// `SyntaxKind`) ambiguous between that namespace and Roslyn's, and gsc bound
/// the wrong package, surfacing as GS0532 "pattern variable not definitely
/// assigned" on the now-impossible patterns. The mapper now reuses the source
/// alias (its import is already emitted) so no namespace import is synthesized.
/// </summary>
public class Issue3501AliasReuseAvoidsAmbiguousImportTests
{
    [Fact]
    public void AliasedTypeInSymbolPosition_ReusesAliasInsteadOfNamespaceImport()
    {
        string printed = TranslateUnit(@"
using TextEncoding = System.Text.Encoding;

namespace Demo
{
    public class Writer
    {
        private readonly TextEncoding encoding = TextEncoding.UTF8;

        public TextEncoding Pick(bool wide)
        {
            TextEncoding chosen = wide ? TextEncoding.Unicode : this.encoding;
            return chosen;
        }
    }
}");

        // The alias import survives and the references reuse it...
        Assert.Contains("import TextEncoding = System.Text.Encoding", printed);
        Assert.Contains("encoding TextEncoding", printed);

        // ...so no whole-namespace import is synthesized for the alias target.
        Assert.DoesNotContain("import System.Text\n", printed, StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
