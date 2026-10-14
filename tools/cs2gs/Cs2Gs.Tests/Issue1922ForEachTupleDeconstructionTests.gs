// <copyright file="Issue1922ForEachTupleDeconstructionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Regression tests for issue #1922: cs2gs used to lower a C#
/// `foreach (var (a, b) in xs)` to a hidden temp variable plus a
/// separate `let (a, b) = tmp` deconstruction statement, which then
/// failed to compile in gsc (`GS0164`) once the loop's tuple-typed
/// element resolved to a raw imported `System.ValueTuple<...>`.
/// Now that G# has a first-class deconstructing loop header
/// (`for (a, b) in xs { ... }`), a synchronous `foreach` tuple
/// deconstruction should translate directly to it instead.
open class Issue1922ForEachTupleDeconstructionTests {
    @Fact
    func ForEachTupleDeconstruction_TranslatesToFirstClassForTupleIn() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("for (name, score) in xs {", printed)
        // The old two-step lowering (hidden temp variable plus a separate
        // `let (a, b) = tmp` statement) must be gone.
        Assert.DoesNotContain("__decon", printed)
        Assert.DoesNotContain("let (name, score)", printed)
    }

    @Fact
    func ForEachTupleDeconstruction_DiscardName_TranslatesToUnderscore() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("for (name, _) in xs {", printed)
    }

    @Fact
    func KeyValuePairDeconstruction_TranslatesToCompilerSupportedForTupleIn() {
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M(Dictionary<string, int> values)
        {
            foreach (var (key, value) in values)
            {
            }
        }
    }
}`)
        Assert.Contains("for (key, value) in values {", printed)
        Assert.DoesNotContain("__decon", printed)
    }

    @Fact
    func ConcurrentDictionaryOfNestedUserGenericDeconstruction_TranslatesToCompilerSupportedForTupleIn() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Demo
{
    public sealed class JobUpdate
    {
        int Number { get; }
    }

    public sealed class C
    {
        public void M(ConcurrentDictionary<Guid, Channel<JobUpdate>> subscribers)
        {
            foreach (var (key, ch) in subscribers)
            {
                Console.WriteLine(ch.Reader.Count);
            }
        }
    }
}`)
        Assert.Contains("import System.Collections.Concurrent", printed)
        Assert.Contains("import System.Threading.Channels", printed)
        Assert.Contains("for (key, ch) in subscribers {", printed)
        Assert.Contains("ch.Reader.Count", printed)
        Assert.DoesNotContain("import System.Collections.Generic", printed)
    }

    @Fact
    func AwaitForEachTupleDeconstruction_KeepsTempPlusLetLowering() {
        // G# has no first-class `await for (a, b) in` header, so the async
        // form must keep the older temp-variable-plus-`let` lowering instead
        // of emitting syntax G# cannot parse.
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("await for nameItem", printed)
        Assert.Contains("let (name, score) = nameItem", printed)
        Assert.DoesNotContain("__decon", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
