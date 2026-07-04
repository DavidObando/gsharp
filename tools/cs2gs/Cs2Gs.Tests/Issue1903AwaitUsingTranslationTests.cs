// <copyright file="Issue1903AwaitUsingTranslationTests.cs" company="GSharp">
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
/// Issue #1903: a C# <c>await using</c> resource (declaration or block form)
/// was lowered to the plain G# <c>using let</c> form, silently dropping the
/// <c>await</c> and binding against <c>IDisposable.Dispose</c> instead of
/// <c>IAsyncDisposable.DisposeAsync</c> — gsc then rejects the type with
/// GS0119 for lacking a public <c>Dispose()</c>. The fix threads the C#
/// <c>await</c> keyword through to G#'s own <c>await using let</c> form
/// (ADR-0030), which binds against <c>DisposeAsync</c>. Plain (non-await)
/// <c>using</c> must keep emitting the sync form unchanged.
/// </summary>
public class Issue1903AwaitUsingTranslationTests
{
    private const string AsyncResourceType = @"
using System;
using System.Threading.Tasks;

namespace Corpus.Issue1903
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
    public void AwaitUsingDeclaration_LowersToAwaitUsingLet()
    {
        string rendered = Render(AsyncResourceType + @"
namespace Corpus.Issue1903
{
    public class Holder
    {
        public async System.Threading.Tasks.Task RunAsync()
        {
            await using var resource = new AsyncResource();
            System.Console.WriteLine(""inside"");
        }
    }
}
");

        Assert.Contains("await using let resource = AsyncResource()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void AwaitUsingBlock_LowersToAwaitUsingLet()
    {
        string rendered = Render(AsyncResourceType + @"
namespace Corpus.Issue1903
{
    public class Holder
    {
        public async System.Threading.Tasks.Task RunAsync()
        {
            await using (var resource = new AsyncResource())
            {
                System.Console.WriteLine(""inside"");
            }
        }
    }
}
");

        Assert.Contains("await using let resource = AsyncResource()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void AwaitUsingDeclaration_MultipleDeclarators_LowersEachToAwaitUsingLet()
    {
        string rendered = Render(AsyncResourceType + @"
namespace Corpus.Issue1903
{
    public class Holder
    {
        public async System.Threading.Tasks.Task RunAsync()
        {
            await using AsyncResource a = new AsyncResource(), b = new AsyncResource();
            System.Console.WriteLine(""inside"");
        }
    }
}
");

        Assert.Contains("await using let a = AsyncResource()", rendered, StringComparison.Ordinal);
        Assert.Contains("await using let b = AsyncResource()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void PlainUsingDeclaration_StillLowersToSyncUsingLet()
    {
        // Regression: a non-await `using` over a plain IDisposable resource
        // must keep emitting the sync form — the fix must not turn every
        // `using` into `await using`.
        string rendered = Render(@"
using System;

namespace Corpus.Issue1903
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
        public void Run()
        {
            using var resource = new SyncResource();
            Console.WriteLine(""inside"");
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
