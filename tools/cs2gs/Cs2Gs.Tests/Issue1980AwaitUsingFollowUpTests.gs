// <copyright file="Issue1980AwaitUsingFollowUpTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

/// Issue #1980: non-blocking follow-ups from the #1978 (#1903) Opus review.
/// 1. Covers the await-using BLOCK-with-EXPRESSION form
/// `await using (expr) { }` (no declaration) — the synthetic
/// discard resource must still thread `isAwait` through to the emitted
/// `await using let _`.
/// 2. Confirms a plain `using` declaration inside an `async`
/// method, with no `await` prefix, still emits the sync
/// `using let` form — async context alone must not set
/// `isAwait`.
/// 3. Issue #2103: same negative case as #2, but for the
/// `using (expr) { }` BLOCK form, which exercises
/// `TranslateUsingStatement`'s own `UsingStatementSyntax`
/// branch directly (as opposed to `TranslateLocalDeclaration`).
open class Issue1980AwaitUsingFollowUpTests {
    @Fact
    func AwaitUsingBlock_ExpressionForm_LowersToAwaitUsingLet() {
        let rendered = Render(AsyncResourceType + `
namespace Corpus.Issue1980
{
    public class Holder
    {
        private static AsyncResource Create() => new AsyncResource();

        public async System.Threading.Tasks.Task RunAsync()
        {
            await using (Create())
            {
                System.Console.WriteLine("inside");
            }
        }
    }
}
`)
        Assert.Contains("await using let _", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__using", rendered, StringComparison.Ordinal)
        Assert.Contains("Create()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PlainUsingDeclaration_InAsyncMethodWithoutAwait_StillLowersToSyncUsingLet() {
        // Regression: being inside an `async` method must not, by itself,
        // cause a non-await `using` to be lowered to `await using let` —
        // only the explicit `await` keyword on the `using` selects the
        // async-disposal form.
        let rendered = Render(`
using System;

namespace Corpus.Issue1980
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
        public async System.Threading.Tasks.Task RunAsync()
        {
            using var resource = new SyncResource();
            System.Console.WriteLine("inside");
            await System.Threading.Tasks.Task.Yield();
        }
    }
}
`)
        Assert.Contains("using let resource = SyncResource()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("await using", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PlainUsingBlock_ExpressionForm_InAsyncMethodWithoutAwait_StillLowersToSyncUsingLet() {
        // Issue #2103: regression for TranslateUsingStatement's own
        // UsingStatementSyntax (statement-block) branch — as opposed to the
        // TranslateLocalDeclaration path already covered above. Being inside
        // an `async` method must not, by itself, cause a non-await
        // `using (expr) { }` block to be lowered to `await using let`.
        let rendered = Render(`
using System;

namespace Corpus.Issue1980
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
        private static SyncResource Create() => new SyncResource();

        public async System.Threading.Tasks.Task RunAsync()
        {
            using (Create())
            {
                System.Console.WriteLine("inside");
            }

            await System.Threading.Tasks.Task.Yield();
        }
    }
}
`)
        Assert.Contains("using let _", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__using", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("await using", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NestedUsingBlock_ExpressionForms_DisposeRepeatedDiscardsInOrder() {
        let rendered = Render(`
using System;

namespace Corpus.Issue1980
{
    public sealed class Resource : IDisposable
    {
        public static string Disposals = "";
        private readonly string name;

        public Resource(string name)
        {
            this.name = name;
        }

        public void Dispose() { Disposals += name; }
    }

    public sealed class Holder
    {
        public static string Run()
        {
            using (new Resource("outer"))
            using (new Resource("inner"))
            {
            }

            return Resource.Disposals;
        }
    }
}
`)
        Assert.Equal(2, rendered.Split("using let _ = Resource(", StringSplitOptions.None).Length - 1)
        Assert.DoesNotContain("__using", rendered, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Holder.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("innerouter", result.Value)
    }

    shared {
        private const AsyncResourceType string = `
using System;
using System.Threading.Tasks;

namespace Corpus.Issue1980
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
