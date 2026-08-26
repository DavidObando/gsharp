// <copyright file="Issue3501YieldSeamBridgingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (GS0155 yield family): a `yield` is a value seam against the
/// iterator's element type, exactly like an argument against its parameter — a
/// promoted-nullable value flowing into a non-null element needs the same `!!`
/// bridge the argument path inserts, both for scalar yields
/// (`yield Canonical(called)` where the callee returns `T?`) and per-element
/// for tuple literals (`yield (tryOutVar, true)` against `(Base, bool)`).
/// </summary>
public class Issue3501YieldSeamBridgingTests
{
    [Fact]
    public void Oblivious_TupleYieldWithPromotedElement_BridgesPerElement()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return ""x"";
        }

        public IEnumerable<(string Name, bool Flag)> Rows()
        {
            var candidate = Find(true);
            yield return (candidate, true);
        }
    }
}");

        Assert.Contains("Find(b bool) string?", printed);
        Assert.Contains("yield (candidate!!, true)", printed);
    }

    [Fact]
    public void Oblivious_ScalarYieldOfPromotedCall_Bridges()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return ""x"";
        }

        public IEnumerable<int> Lengths()
        {
            yield return Find(true).Length;
        }
    }
}");

        Assert.Contains("Find(true)!!.Length", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

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
