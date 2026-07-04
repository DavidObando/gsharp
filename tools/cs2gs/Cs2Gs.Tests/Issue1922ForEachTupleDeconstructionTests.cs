// <copyright file="Issue1922ForEachTupleDeconstructionTests.cs" company="GSharp">
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
/// Regression tests for issue #1922: cs2gs used to lower a C#
/// <c>foreach (var (a, b) in xs)</c> to a hidden temp variable plus a
/// separate <c>let (a, b) = tmp</c> deconstruction statement, which then
/// failed to compile in gsc (<c>GS0164</c>) once the loop's tuple-typed
/// element resolved to a raw imported <c>System.ValueTuple&lt;...&gt;</c>.
/// Now that G# has a first-class deconstructing loop header
/// (<c>for (a, b) in xs { ... }</c>), a synchronous <c>foreach</c> tuple
/// deconstruction should translate directly to it instead.
/// </summary>
public class Issue1922ForEachTupleDeconstructionTests
{
    [Fact]
    public void ForEachTupleDeconstruction_TranslatesToFirstClassForTupleIn()
    {
        string printed = TranslateUnit(@"
using System;
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M(List<(string Name, int Score)> xs)
        {
            foreach (var (name, score) in xs)
            {
                Console.WriteLine(name);
            }
        }
    }
}");

        Assert.Contains("for (name, score) in xs {", printed);

        // The old two-step lowering (hidden temp variable plus a separate
        // `let (a, b) = tmp` statement) must be gone.
        Assert.DoesNotContain("__decon", printed);
        Assert.DoesNotContain("let (name, score)", printed);
    }

    [Fact]
    public void ForEachTupleDeconstruction_DiscardName_TranslatesToUnderscore()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M(List<(string, int)> xs)
        {
            foreach (var (name, _) in xs)
            {
            }
        }
    }
}");

        Assert.Contains("for (name, _) in xs {", printed);
    }

    [Fact]
    public void AwaitForEachTupleDeconstruction_KeepsTempPlusLetLowering()
    {
        // G# has no first-class `await for (a, b) in` header, so the async
        // form must keep the older temp-variable-plus-`let` lowering instead
        // of emitting syntax G# cannot parse.
        string printed = TranslateUnit(@"
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Demo
{
    public sealed class C
    {
        public async Task M(IAsyncEnumerable<(string Name, int Score)> xs)
        {
            await foreach (var (name, score) in xs)
            {
            }
        }
    }
}");

        Assert.Contains("await for __decon", printed);
        Assert.Contains("let (name, score) = __decon", printed);
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
