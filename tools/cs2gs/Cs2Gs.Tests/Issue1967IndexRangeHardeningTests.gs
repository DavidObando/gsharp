// <copyright file="Issue1967IndexRangeHardeningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1967 hardened the issue #1894 loud-gap coverage for
/// `System.Index`/`System.Range` at every non-declarator binding
/// site: `foreach` variables, `is`/`switch` pattern
/// designations, `out` arguments, tuple deconstruction, LINQ query range
/// variables, and collection-initializer elements (`{ [^1] = v }`).
/// ADR-0187 / issue #4350 made Index/Range first-class G# values, so each of
/// those sites now translates directly and the printed G# must bind.
open class Issue1967IndexRangeHardeningTests {
    @Fact
    func ImplicitElementAccess_FromEndIndexKey_TranslatesWithoutGap() {
        // `{ [^1] = v }` inside a collection initializer, against an indexer
        // whose parameter is `Index`: both translate directly (ADR-0187).
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class IndexKeyed
    {
        public int this[Index i]
        {
            get => 0;
            set { }
        }
    }

    public class Holder
    {
        public void Make()
        {
            var h = new IndexKeyed { [^1] = 5 };
        }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("^1", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        // Verify gsc's OWN parser and binder accept a from-end index in the
        // initializer-element position and the Index-typed indexer parameter,
        // not just that the printer emitted the `^1` text.
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
        Assert.True(
            roundTrip!!.Success,
            "Translated G# must parse. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + rendered
        )
    }

    @Fact
    func ForEachIndexTypedVariable_TranslatesWithoutGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
using System.Collections.Generic;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public void Run(List<Index> xs)
        {
            foreach (Index i in xs)
            {
                Console.WriteLine(i.Value);
            }
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func IsPatternIndexTypedDesignation_TranslatesWithoutGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public int Get(int[] a, object o)
        {
            if (o is Index i)
            {
                return a[i];
            }

            return 0;
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func WhileLoopConditionIsPatternIndexTypedDesignation_TranslatesWithoutGap() {
        // A loop-condition `is`-pattern is hoisted through a SEPARATE code path
        // (HoistLoopConditionClauseCore) that never calls TranslateIsPattern.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public void Run(object o)
        {
            while (o is Index i)
            {
                o = null;
            }
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func SwitchCasePatternIndexTypedDesignation_TranslatesWithoutGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public int Get(int[] a, object o)
        {
            switch (o)
            {
                case Index i:
                    return a[i];
                default:
                    return 0;
            }
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func SwitchExpressionArmPatternIndexTypedDesignation_TranslatesWithoutGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public int Get(int[] a, object o) => o switch
        {
            Index i => a[i],
            _ => 0,
        };
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func OutIndexTypedArgument_TranslatesWithoutGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class Holder
    {
        private static void TryGetIndex(out Index i) => i = ^1;

        public int Get(int[] a)
        {
            TryGetIndex(out Index i);
            return a[i];
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func TupleDeconstructionIndexTypedElement_TranslatesWithoutGap() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class Holder
    {
        private static (Index, int) Make() => (^1, 2);

        public int Get(int[] a)
        {
            var (i, n) = Make();
            return a[i] + n;
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func TupleDeconstructionAssignment_MixedIndexTypedElement_TranslatesWithoutGap() {
        // `(x, Index i) = ...` — the mixed-tuple-assignment declaration path
        // (LowerTupleAssignment), distinct from the all-`var` declaration path
        // above.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1967
{
    public class Holder
    {
        private static (int, Index) Make() => (2, ^1);

        public int Get(int[] a)
        {
            int n;
            (n, Index i) = Make();
            return a[i] + n;
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func QueryFromClauseIndexTypedRangeVariable_TranslatesWithoutGap() {
        // `from Index i in xs` binds `i` as an `IRangeVariableSymbol`, not an
        // `ILocalSymbol` — a designation-only check would miss it entirely.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
using System.Collections.Generic;
using System.Linq;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public IEnumerable<Index> Run(List<Index> xs)
        {
            return from Index i in xs select i;
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func QueryLetClauseIndexTypedRangeVariable_TranslatesWithoutGap() {
        // `let i = ^n` binds `i` (an Index) via `LowerLetClause`, inferred from
        // the `let` expression's own type rather than a source collection.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
using System.Linq;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public int Get(int[] xs)
        {
            var q = from n in xs let i = ^n select xs[i];
            return q.First();
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func QueryJoinClauseIndexTypedRangeVariable_TranslatesWithoutGap() {
        // `join y in ys on ...` with `ys : List<Index>` infers `y`'s type from
        // the inner sequence's element type (no explicit `Index` in the clause
        // itself) — exercises the source-inferred path in `LowerJoinClause`.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
using System.Collections.Generic;
using System.Linq;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public IEnumerable<Index> Run(List<int> xs, List<Index> ys)
        {
            return from x in xs
                   join y in ys on x equals y.GetOffset(10)
                   select y;
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    @Fact
    func QueryContinuationIndexTypedRangeVariable_TranslatesWithoutGap() {
        // `select ^n into i` re-starts the query scope with `i : Index` — the
        // continuation's range variable type is inferred from the preceding
        // `select`'s projected expression type, not any declarator/designation.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
using System.Collections.Generic;
using System.Linq;
namespace Corpus.Issue1967
{
    public class Holder
    {
        public IEnumerable<Index> Run(int[] xs)
        {
            return from n in xs
                   select ^n into i
                   select i;
        }
    }
}
`)})
        AssertTranslatesAndBinds(project)
    }

    shared {
        private func AssertTranslatesAndBinds(project LoadedCSharpProject) {
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let rendered = GSharpPrinter.Print(unit)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                roundTrip!!.Success,
                "Translated G# must bind. Errors:\n" + string.Join("\n", roundTrip!!.Errors) + `

Printed:
` + rendered
            )
        }
    }
}
