// <copyright file="Issue3663DeconstructedForEachElementBridgingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Regression tests for issue #3663 — the selfmig wall in migrated
/// `Cs2Gs.Translator` (`CollectOwnedExtensions`): a Try-pattern
/// `out` variable, promoted to `T?` by the #1072/#3501 analysis, is
/// stored into a LOCAL `List<(T, …)>` and read back through a
/// deconstructing `foreach`.
///
/// #3657 widened the nested-tuple flow collectors so a local collection is a
/// declaration sink, which correctly renders the element `T?`. But a
/// deconstructing `foreach` variable has no declaration of its own on the
/// G# side — `for (a, b) in items` infers each name from the sequence's
/// element tuple — so every read of the variable became a `T?` the
/// translator still believed was a `T`: `GS0158 Cannot find member …`
/// at a dereference and `GS0154` at every non-null argument sink.
open class Issue3663DeconstructedForEachElementBridgingTests {
    /// The migrated `CollectOwnedExtensions` wall: the promoted tuple
    /// element's deconstructed reads assert `!!` at a dereference and at a
    /// non-null argument position, while the sibling untainted element stays
    /// bare.
    @Fact
    func PromotedTupleElement_TypedForEachDeconstruction_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Registry
    {
        public int Rank { get; set; }
    }

    public static class Collector
    {
        public static int Collect(IEnumerable<string> names)
        {
            var candidates = new List<(Registry Owner, string Name)>();
            foreach (string name in names)
            {
                if (!TryGetOwner(name, out Registry owner))
                {
                    continue;
                }

                candidates.Add((owner, name));
            }

            int total = 0;
            foreach ((Registry o, string n) in candidates)
            {
                total += Describe(o).Length + o.Rank + n.Length;
            }

            return total;
        }

        private static string Describe(Registry owner)
        {
            return owner.ToString();
        }

        private static bool TryGetOwner(string name, out Registry owner)
        {
            owner = null;
            if (name == null)
            {
                return false;
            }

            owner = new Registry();
            return true;
        }
    }
}`)
        Assert.True(printed.Contains("List[(Owner Registry?, Name string)]", StringComparison.Ordinal), printed)
        Assert.Contains("Describe(o!!)", printed)
        Assert.Contains("o!!.Rank", printed)
        Assert.True(printed.Contains("n.Length", StringComparison.Ordinal), printed)
    }

    /// The `var (a, b)` header spelling nests its designations differently
    /// from the explicitly typed one and must resolve to the same tuple leaf.
    @Fact
    func PromotedTupleElement_VarForEachDeconstruction_AssertsNonNull() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Registry
    {
        public int Rank { get; set; }
    }

    public static class Collector
    {
        public static int Collect(IEnumerable<string> names)
        {
            var candidates = new List<(Registry Owner, string Name)>();
            foreach (string name in names)
            {
                if (!TryGetOwner(name, out Registry owner))
                {
                    continue;
                }

                candidates.Add((owner, name));
            }

            int total = 0;
            foreach (var (o, n) in candidates)
            {
                total += o.Rank + n.Length;
            }

            return total;
        }

        private static bool TryGetOwner(string name, out Registry owner)
        {
            owner = null;
            if (name == null)
            {
                return false;
            }

            owner = new Registry();
            return true;
        }
    }
}`)
        Assert.Contains("o!!.Rank", printed)
        Assert.True(printed.Contains("n.Length", StringComparison.Ordinal), printed)
    }

    /// Precision guard: when no null ever reaches the tuple element, neither the
    /// element nor its deconstructed reads grow an assertion.
    @Fact
    func UntaintedTupleElement_ForEachDeconstruction_StaysBare() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class Registry
    {
        public int Rank { get; set; }
    }

    public static class Collector
    {
        public static int Collect(IEnumerable<string> names)
        {
            var candidates = new List<(Registry Owner, string Name)>();
            foreach (string name in names)
            {
                candidates.Add((new Registry(), name));
            }

            int total = 0;
            foreach ((Registry o, string n) in candidates)
            {
                total += o.Rank + n.Length;
            }

            return total;
        }
    }
}`)
        Assert.Contains("List[(Owner Registry, Name string)]", printed)
        Assert.DoesNotContain("o!!", printed)
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
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
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
