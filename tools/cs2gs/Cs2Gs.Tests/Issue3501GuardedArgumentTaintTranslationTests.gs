// <copyright file="Issue3501GuardedArgumentTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import System
import System.IO
import System.Linq
import Xunit

/// Issue #3501 (Oahu-gate regression guard): a local/parameter read that a
/// syntactic null-check guard proves non-null at a CONSTRUCTOR argument must
/// not propagate its declaration's taint into the parameter. The canonical
/// shape is Oahu's `if (prod is null) { continue; } pairs.Add(new(prod,
/// comp))` — `prod`'s producer can return null, but the creation-site read is
/// guarded, and tainting the record's positional parameter widened the data
/// shape (`Product` → `Product?` on the positional property) for every
/// consumer, including deconstruction locals whose dereferences are not
/// receiver-bridged. Ordinary METHOD arguments deliberately keep the
/// promotion-consolidation behavior (see PromotionConsolidationTests).
open class Issue3501GuardedArgumentTaintTranslationTests {
    @Fact
    func Oblivious_EarlyExitGuardedCreationArgument_DoesNotTaintPositionalParameter() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return "x";
        }

        public void Run(IEnumerable<bool> flags)
        {
            var pairs = new List<Pair>();
            foreach (var flag in flags)
            {
                var value = Find(flag);
                if (value is null)
                {
                    continue;
                }

                pairs.Add(new(value, 1));
            }
        }
    }

    public record Pair(string Name, int Rank);
}`)
        // `value` itself is tainted (Find can return null)...
        Assert.Contains("Find(b bool) string?", printed)
        // ...but the guarded creation-site read must not widen the record's
        // positional data shape.
        Assert.Contains("Pair(Name string,", printed)
    }

    @Fact
    func Oblivious_UnguardedCreationArgument_StillTaintsPositionalParameter() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return "x";
        }

        public void Run()
        {
            var pairs = new List<Pair> { new(Find(true), 1) };
        }
    }

    public record Pair(string Name, int Rank);
}`)
        Assert.Contains("Pair(Name string?,", printed)
    }

    @Fact
    func Oblivious_MutableCreationArguments_StillTaintPositionalParameters() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        private static void Clear(out object value) => value = null;

        public void Run(bool repeat)
        {
            var loopValue = new object();
            while (repeat)
            {
                _ = new LoopPair(loopValue);
                loopValue = null;
                repeat = false;
            }

            var outValue = new object();
            Clear(out outValue);
            _ = new OutPair(outValue);
        }
    }

    public record LoopPair(object Value);
    public record OutPair(object Value);
}`)
        Assert.Contains("LoopPair(Value object?", printed)
        Assert.Contains("OutPair(Value object?", printed)
    }

    @Fact
    func Oblivious_UserDefinedCreationConversion_StillTaintsPositionalParameter() {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3501-user-conversion",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contracts = CSharpProjectLoader.LoadInMemory([](string, string){("Contracts.cs", `#nullable enable
namespace Demo.Contracts;
public sealed class Source { }
public sealed class Target
{
    public static implicit operator Target?(Source value) => null;
}`)})
            let assemblyPath = Path.Combine(directory, "Contracts.dll")
            let emitted = contracts.Compilation.Emit(assemblyPath)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Consumer.cs", `#nullable disable
using Demo.Contracts;
namespace Demo.Consumer;
public static class C
{
    public static Pair Create()
    {
        Target value = new Source();
        return new Pair(value);
    }
}
public record Pair(Target Value);`)}, CSharpProjectLoader
                    .RuntimeReferences()
                    .Append(MetadataReference.CreateFromFile(assemblyPath))
                    .ToArray())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.Contains("Pair(Value Target?", printed)
            using let references = ReferenceResolver.WithReferences([]string{assemblyPath})
            TranslationTestValidation.AssertBinds(references, printed)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
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
