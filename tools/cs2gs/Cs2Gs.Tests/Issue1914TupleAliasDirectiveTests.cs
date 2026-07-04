// <copyright file="Issue1914TupleAliasDirectiveTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1914: a C# 12 alias-any-type <c>using</c>
/// directive whose right-hand side is a tuple type (<c>using NamePair =
/// (int Number, string Word);</c>) used to hit "using directive without a
/// resolvable name" because the import-directive step only handled the
/// <c>NameSyntax</c>-typed RHS a pre-C#12 alias always had. The directive's
/// generalized <c>NamespaceOrType</c> property covers both forms; a
/// non-name RHS has no dotted-path G# <c>import</c> line to emit, but every
/// USE of the alias still resolves through the semantic model straight to
/// its underlying type, so it needs none: the tuple alias expands to G#'s
/// positional tuple type at each reference, same as a written-out tuple
/// type would.
/// </summary>
public class Issue1914TupleAliasDirectiveTests
{
    [Fact]
    public void TupleAlias_UsedInVariableDeclaration_TranslatesToPositionalTuple()
    {
        string printed = TranslateUnit(@"
using NamePair = (int Number, string Word);

namespace Demo
{
    public class C
    {
        public void M()
        {
            NamePair pair = (1, ""a"");
        }
    }
}");

        Assert.Contains("let pair (int32, string) = (1, \"a\")", printed);
    }

    [Fact]
    public void TupleAlias_UsedInMethodSignature_TranslatesToPositionalTuple()
    {
        string printed = TranslateUnit(@"
using NamePair = (int Number, string Word);

namespace Demo
{
    public class C
    {
        public NamePair Make(NamePair seed)
        {
            return seed;
        }
    }
}");

        Assert.Contains("func Make(seed (int32, string)) (int32, string)", printed);
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
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
