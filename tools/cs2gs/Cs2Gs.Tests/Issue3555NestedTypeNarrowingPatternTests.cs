// <copyright file="Issue3555NestedTypeNarrowingPatternTests.cs" company="GSharp">
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
/// Issue #3555: a boolean-position C# pattern whose PROPERTY value is itself a
/// type-matching pattern with further subpatterns (`symbol is IParameterSymbol
/// { ContainingSymbol: IMethodSymbol { MethodKind: …, ContainingType.IsRecord:
/// true } }`) used to guard-lower over a smart-castable scrutinee into
/// unnarrowed member CHAINS (`symbol.ContainingSymbol is IMethodSymbol &&
/// symbol.ContainingSymbol.MethodKind == …`) — gsc narrows only the scrutinee
/// local, so the second read failed GS0158. Such shapes now take the native
/// pattern form.
/// </summary>
public class Issue3555NestedTypeNarrowingPatternTests
{
    [Fact]
    public void NestedTypePropertyPattern_UsesNativePatternForm()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Owner
    {
        public bool IsSpecial { get; set; }
        public string Name { get; set; } = """";
    }

    public class Member
    {
        public object Holder { get; set; } = new object();
    }

    public static class Probe
    {
        public static bool Check(object value) =>
            value is string
            || value is Member
            {
                Holder: Owner
                {
                    IsSpecial: true,
                    Name.Length: > 0,
                },
            };
    }
}");

        Assert.Contains("Holder: Owner and {", printed);
        Assert.DoesNotContain(".Holder is Owner &&", printed);
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
