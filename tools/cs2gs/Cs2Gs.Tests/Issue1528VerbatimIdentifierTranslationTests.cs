// <copyright file="Issue1528VerbatimIdentifierTranslationTests.cs" company="GSharp">
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
/// Issue #1528: a C# verbatim identifier whose bare name collides with a G#
/// reserved word (e.g. <c>@default</c>, a field literally named <c>default</c>)
/// must be sanitized consistently at every emission site. The declaration path
/// already routed through <c>SanitizeIdentifier</c> (emitting <c>default_</c>),
/// but two <c>TranslateIdentifierName</c> qualifier paths (implicit-receiver and
/// bare-static-member) and the <c>GenericNameSyntax</c>-as-expression paths
/// emitted the raw identifier text, so a bare <c>@default</c> reference became the
/// unparsable <c>TreeDecomposition.@default</c> (GS0005: unexpected AtToken) and
/// mismatched its own <c>default_</c> declaration. All reference sites must now
/// sanitize to <c>default_</c>.
/// </summary>
public class Issue1528VerbatimIdentifierTranslationTests
{
    private const string Source = @"
namespace Corpus.Issue1528
{
    public class Holder<T>
        where T : new()
    {
        private static Holder<T> @default;

        public static Holder<T> Instance()
        {
            if (@default is null)
            {
                @default = new Holder<T>();
            }

            return @default;
        }
    }
}
";

    [Fact]
    public void VerbatimKeywordStaticFieldReference_IsSanitizedConsistently()
    {
        string rendered = Render();

        // The declaration and every reference use the sanitized `default_` name.
        Assert.Contains("default_", rendered, StringComparison.Ordinal);

        // The unparsable verbatim/keyword forms never leak into the output.
        Assert.DoesNotContain("@default", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".default ", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".default\n", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void SanitizedOutput_RoundTripParses()
    {
        string rendered = Render();

        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Holder.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
