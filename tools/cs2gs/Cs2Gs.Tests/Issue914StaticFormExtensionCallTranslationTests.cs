// <copyright file="Issue914StaticFormExtensionCallTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #914: a SOURCE-defined extension method
/// called in STATIC (unreduced) form <c>Owner.M&lt;T&gt;(recv, args)</c> must be
/// rewritten to the G# receiver-clause call <c>recv.M[T](args)</c>. cs2gs lifts
/// every non-enum source extension of a <c>static class</c> to a top-level
/// receiver-clause <c>func (recv R) M[…](…)</c> (ADR-0115 §B.19), which gsc
/// invokes only through the receiver form; the static-form call site would
/// otherwise resolve to a non-existent static member (GS0158). The reduced
/// instance form already binds directly and is unaffected.
/// </summary>
public class Issue914StaticFormExtensionCallTranslationTests
{
    [Fact]
    public void StaticFormExtensionCall_RewrittenToReceiverForm()
    {
        // `JsonLike.FromFile<T>(path)` — static-form generic call whose first
        // argument is the extension receiver — must become `path.FromFile[T]()`.
        string printed = Render(@"
namespace Demo
{
    public static class JsonLike
    {
        public static T FromFile<T>(this string path) where T : class, new() { return new T(); }
    }

    public class Consumer
    {
        public T Load<T>(string path) where T : class, new()
        {
            return JsonLike.FromFile<T>(path);
        }
    }
}");

        Assert.Contains("path.FromFile[T]()", printed);
        Assert.DoesNotContain("JsonLike.FromFile", printed);
    }

    [Fact]
    public void StaticFormExtensionCall_WithTrailingArguments_KeepsThemAfterReceiver()
    {
        // The first argument is the receiver; the rest follow in the receiver call:
        // `StringExt.Repeat(s, 3)` -> `s.Repeat(3)`.
        string printed = Render(@"
namespace Demo
{
    public static class StringExt
    {
        public static string Repeat(this string s, int n) { return s; }
    }

    public class Consumer
    {
        public string Run(string s)
        {
            return StringExt.Repeat(s, 3);
        }
    }
}");

        Assert.Contains("s.Repeat(3)", printed);
        Assert.DoesNotContain("StringExt.Repeat", printed);
    }

    [Fact]
    public void InstanceFormExtensionCall_Unchanged()
    {
        // The reduced instance form already binds to the receiver-clause func and
        // must be left exactly as-is (`s.Repeat(3)`), never re-qualified.
        string printed = Render(@"
namespace Demo
{
    public static class StringExt
    {
        public static string Repeat(this string s, int n) { return s; }
    }

    public class Consumer
    {
        public string Run(string s)
        {
            return s.Repeat(3);
        }
    }
}");

        Assert.Contains("s.Repeat(3)", printed);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
