// <copyright file="Issue1980AwaitUsingFollowUpTests.cs" company="GSharp">
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
/// Issue #1980: non-blocking follow-ups from the #1978 (#1903) Opus review.
/// 1. Covers the await-using BLOCK-with-EXPRESSION form
///    <c>await using (expr) { }</c> (no declaration) — the synthetic
///    <c>__using</c> local must still thread <c>isAwait</c> through to the
///    emitted <c>await using let</c>.
/// 2. Confirms a plain <c>using</c> declaration inside an <c>async</c>
///    method, with no <c>await</c> prefix, still emits the sync
///    <c>using let</c> form — async context alone must not set
///    <c>isAwait</c>.
/// </summary>
public class Issue1980AwaitUsingFollowUpTests
{
    private const string AsyncResourceType = @"
using System;
using System.Threading.Tasks;

namespace Corpus.Issue1980
{
    public sealed class AsyncResource : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            Console.WriteLine(""disposed"");
            return ValueTask.CompletedTask;
        }
    }
}
";

    [Fact]
    public void AwaitUsingBlock_ExpressionForm_LowersToAwaitUsingLet()
    {
        string rendered = Render(AsyncResourceType + @"
namespace Corpus.Issue1980
{
    public class Holder
    {
        private static AsyncResource Create() => new AsyncResource();

        public async System.Threading.Tasks.Task RunAsync()
        {
            await using (Create())
            {
                System.Console.WriteLine(""inside"");
            }
        }
    }
}
");

        Assert.Contains("await using let __using", rendered, StringComparison.Ordinal);
        Assert.Contains("Create()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void PlainUsingDeclaration_InAsyncMethodWithoutAwait_StillLowersToSyncUsingLet()
    {
        // Regression: being inside an `async` method must not, by itself,
        // cause a non-await `using` to be lowered to `await using let` —
        // only the explicit `await` keyword on the `using` selects the
        // async-disposal form.
        string rendered = Render(@"
using System;

namespace Corpus.Issue1980
{
    public sealed class SyncResource : IDisposable
    {
        public void Dispose()
        {
            Console.WriteLine(""disposed"");
        }
    }

    public class Holder
    {
        public async System.Threading.Tasks.Task RunAsync()
        {
            using var resource = new SyncResource();
            System.Console.WriteLine(""inside"");
            await System.Threading.Tasks.Task.Yield();
        }
    }
}
");

        Assert.Contains("using let resource = SyncResource()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("await using", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
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
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
