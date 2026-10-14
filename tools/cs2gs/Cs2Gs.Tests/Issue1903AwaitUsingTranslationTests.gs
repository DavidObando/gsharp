// <copyright file="Issue1903AwaitUsingTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1903: a C# `await using` resource (declaration or block form)
/// was lowered to the plain G# `using let` form, silently dropping the
/// `await` and binding against `IDisposable.Dispose` instead of
/// `IAsyncDisposable.DisposeAsync` — gsc then rejects the type with
/// GS0119 for lacking a public `Dispose()`. The fix threads the C#
/// `await` keyword through to G#'s own `await using let` form
/// (ADR-0030), which binds against `DisposeAsync`. Plain (non-await)
/// `using` must keep emitting the sync form unchanged.
open class Issue1903AwaitUsingTranslationTests {
    @Fact
    func AwaitUsingDeclaration_LowersToAwaitUsingLet() {
        let rendered = Render(AsyncResourceType + `
namespace Corpus.Issue1903
{
    public class Holder
    {
        public async System.Threading.Tasks.Task RunAsync()
        {
            await using var resource = new AsyncResource();
            System.Console.WriteLine("inside");
        }
    }
}
`)
        Assert.Contains("await using let resource = AsyncResource()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func AwaitUsingBlock_LowersToAwaitUsingLet() {
        let rendered = Render(AsyncResourceType + `
namespace Corpus.Issue1903
{
    public class Holder
    {
        public async System.Threading.Tasks.Task RunAsync()
        {
            await using (var resource = new AsyncResource())
            {
                System.Console.WriteLine("inside");
            }
        }
    }
}
`)
        Assert.Contains("await using let resource = AsyncResource()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func AwaitUsingDeclaration_MultipleDeclarators_LowersEachToAwaitUsingLet() {
        let rendered = Render(AsyncResourceType + `
namespace Corpus.Issue1903
{
    public class Holder
    {
        public async System.Threading.Tasks.Task RunAsync()
        {
            await using AsyncResource a = new AsyncResource(), b = new AsyncResource();
            System.Console.WriteLine("inside");
        }
    }
}
`)
        Assert.Contains("await using let a = AsyncResource()", rendered, StringComparison.Ordinal)
        Assert.Contains("await using let b = AsyncResource()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PlainUsingDeclaration_StillLowersToSyncUsingLet() {
        // Regression: a non-await `using` over a plain IDisposable resource
        // must keep emitting the sync form — the fix must not turn every
        // `using` into `await using`.
        let rendered = Render(`
using System;

namespace Corpus.Issue1903
{
    public sealed class SyncResource : IDisposable
    {
        public void Dispose()
        {
            Console.WriteLine("disposed");
        }
    }

    public class Holder
    {
        public void Run()
        {
            using var resource = new SyncResource();
            Console.WriteLine("inside");
        }
    }
}
`)
        Assert.Contains("using let resource = SyncResource()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("await using", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private const AsyncResourceType string = `
using System;
using System.Threading.Tasks;

namespace Corpus.Issue1903
{
    public sealed class AsyncResource : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            Console.WriteLine("disposed");
            return ValueTask.CompletedTask;
        }
    }
}
`

        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
