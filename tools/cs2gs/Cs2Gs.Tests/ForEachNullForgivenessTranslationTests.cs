// <copyright file="ForEachNullForgivenessTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for `foreach` over a nullable receiver. G#
/// smart-casts narrow only LOCAL variables, not field/property chains, so a
/// declared-nullable (or #1072-promoted) field iterated inside a null guard —
/// which C# flow analysis proves non-null — must be rendered with an explicit
/// <c>!!</c> on the iterable, otherwise gsc rejects `for x in field` with
/// GS0116 ("is not indexable"). A plainly non-null iterable keeps no assertion.
/// </summary>
public class ForEachNullForgivenessTranslationTests
{
    [Fact]
    public void ForEachOverNullCheckedField_AssertsIterable()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        private uint[]? offsets;
        public void Sum()
        {
            if (offsets != null)
            {
                foreach (var o in offsets)
                {
                    System.Console.WriteLine(o);
                }
            }
        }
    }
}");

        // The field is promoted to a nullable array and the guarded iteration
        // asserts non-null on the iterable.
        Assert.Contains("for o in offsets!!", printed);
    }

    [Fact]
    public void ForEachOverNonNullField_NoAssertion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private uint[] offsets = new uint[4];
        public void Sum()
        {
            foreach (var o in offsets)
            {
                System.Console.WriteLine(o);
            }
        }
    }
}");

        Assert.Contains("for o in offsets ", printed);
        Assert.DoesNotContain("offsets!!", printed);
    }

    [Fact]
    public void NullCheckedFieldAsArgument_AssertsArgument()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        private string? text;
        private static int Len(string s) => s.Length;
        public int M()
        {
            if (text == null)
            {
                return 0;
            }
            else
            {
                return Len(text);
            }
        }
    }
}");

        // The `string?` field is flow-proven non-null in the else branch and is
        // passed to a `string` parameter, so the argument carries `!!`.
        Assert.Contains("Len(text!!)", printed);
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

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
