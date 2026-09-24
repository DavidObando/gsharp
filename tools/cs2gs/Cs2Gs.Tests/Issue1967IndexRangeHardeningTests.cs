// <copyright file="Issue1967IndexRangeHardeningTests.cs" company="GSharp">
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
/// Issue #1967 hardened the issue #1894 loud-gap coverage for
/// <c>System.Index</c>/<c>System.Range</c> at every non-declarator binding
/// site: <c>foreach</c> variables, <c>is</c>/<c>switch</c> pattern
/// designations, <c>out</c> arguments, tuple deconstruction, LINQ query range
/// variables, and collection-initializer elements (<c>{ [^1] = v }</c>).
/// ADR-0187 / issue #4350 made Index/Range first-class G# values, so each of
/// those sites now translates directly and the printed G# must bind.
/// </summary>
public class Issue1967IndexRangeHardeningTests
{
    [Fact]
    public void ImplicitElementAccess_FromEndIndexKey_TranslatesWithoutGap()
    {
        // `{ [^1] = v }` inside a collection initializer, against an indexer
        // whose parameter is `Index`: both translate directly (ADR-0187).
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("^1", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        // Verify gsc's OWN parser and binder accept a from-end index in the
        // initializer-element position and the Index-typed indexer parameter,
        // not just that the printer emitted the `^1` text.
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(rendered);
        Assert.True(roundTrip.Success, "Translated G# must parse. Errors:\n" +
            string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + rendered);
    }

    [Fact]
    public void ForEachIndexTypedVariable_TranslatesWithoutGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void IsPatternIndexTypedDesignation_TranslatesWithoutGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void WhileLoopConditionIsPatternIndexTypedDesignation_TranslatesWithoutGap()
    {
        // A loop-condition `is`-pattern is hoisted through a SEPARATE code path
        // (HoistLoopConditionClauseCore) that never calls TranslateIsPattern.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void SwitchCasePatternIndexTypedDesignation_TranslatesWithoutGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void SwitchExpressionArmPatternIndexTypedDesignation_TranslatesWithoutGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void OutIndexTypedArgument_TranslatesWithoutGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void TupleDeconstructionIndexTypedElement_TranslatesWithoutGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void TupleDeconstructionAssignment_MixedIndexTypedElement_TranslatesWithoutGap()
    {
        // `(x, Index i) = ...` — the mixed-tuple-assignment declaration path
        // (LowerTupleAssignment), distinct from the all-`var` declaration path
        // above.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void QueryFromClauseIndexTypedRangeVariable_TranslatesWithoutGap()
    {
        // `from Index i in xs` binds `i` as an `IRangeVariableSymbol`, not an
        // `ILocalSymbol` — a designation-only check would miss it entirely.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void QueryLetClauseIndexTypedRangeVariable_TranslatesWithoutGap()
    {
        // `let i = ^n` binds `i` (an Index) via `LowerLetClause`, inferred from
        // the `let` expression's own type rather than a source collection.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void QueryJoinClauseIndexTypedRangeVariable_TranslatesWithoutGap()
    {
        // `join y in ys on ...` with `ys : List<Index>` infers `y`'s type from
        // the inner sequence's element type (no explicit `Index` in the clause
        // itself) — exercises the source-inferred path in `LowerJoinClause`.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    [Fact]
    public void QueryContinuationIndexTypedRangeVariable_TranslatesWithoutGap()
    {
        // `select ^n into i` re-starts the query scope with `i : Index` — the
        // continuation's range variable type is inferred from the preceding
        // `select`'s projected expression type, not any declarator/designation.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        AssertTranslatesAndBinds(project);
    }

    private static void AssertTranslatesAndBinds(LoadedCSharpProject project)
    {
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(rendered);
        Assert.True(roundTrip.Success, "Translated G# must bind. Errors:\n" +
            string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + rendered);
    }
}
