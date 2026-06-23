// <copyright file="Issue986BaseCallTranslationTests.cs" company="GSharp">
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
/// Issue #986: C# <c>base.M(...)</c> inside an override now maps to the
/// canonical G# base-class call form <c>base.M(...)</c> (which emits a
/// non-virtual <c>call</c> into the base implementation), replacing the
/// previous <c>nil</c> placeholder.
/// </summary>
public class Issue986BaseCallTranslationTests
{
    [Fact]
    public void BaseMethodCall_InOverride_EmitsBaseDotForm()
    {
        var source = """
            namespace Probe;

            public class Shape
            {
                public virtual string Describe() => "shape";
            }

            public class Circle : Shape
            {
                public override string Describe() => base.Describe() + " circle";
            }
            """;

        string printed = TranslateUnit(source);

        Assert.Contains("base.Describe()", printed);
        Assert.DoesNotContain("nil.Describe", printed);
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
