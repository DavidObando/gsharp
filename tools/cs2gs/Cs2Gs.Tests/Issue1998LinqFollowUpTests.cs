// <copyright file="Issue1998LinqFollowUpTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1998 (follow-ups from the #1902/#1997 Opus review):
/// <list type="number">
/// <item>a query scope that grows past G#'s 7-element tuple arity cap now
/// reports a precise, actionable <see cref="TranslationDiagnostic"/> instead
/// of silently emitting a tuple shape that would only surface as an opaque
/// GS0159 much later at G# bind time;</item>
/// <item>previously-untested query-clause combinations (join after a
/// preceding <c>let</c>, a join continuing a <c>group ... into</c>, and a
/// scope with more than 3 range variables) are locked in with regression
/// tests.</item>
/// </list>
///
/// <para>
/// ADR-0185 (issue #4304) retired the second item above: the synthesized
/// <c>__qN</c> tuple-parameter name — and the collision-avoidance loop
/// bumping it past a colliding user local — no longer exist, because a
/// multi-variable scope now binds a tuple-DESTRUCTURING lambda parameter
/// directly under its real range-variable names
/// (<c>((name1 T1, name2 T2, ...)) -&gt; body</c>). The former regression
/// test for that collision-avoidance loop
/// (<c>QueryScope_WithUserLocalNamed__q0_DoesNotCollideWithSynthesizedTupleParam</c>)
/// tested a mechanism that no longer exists and was removed rather than
/// updated; a same-name collision between a range variable and an outer
/// local is now an ordinary identifier collision, resolved the same way
/// this translator already resolves every other such collision
/// (<c>EmittedName</c>/<c>SanitizeIdentifier</c>).
/// </para>
/// </summary>
public class Issue1998LinqFollowUpTests
{
    [Fact]
    public void QueryScope_GrowingPastSevenRangeVariables_ReportsPreciseDiagnostic()
    {
        // Eight range variables in scope by the final `let` (n plus 7 lets):
        // exceeds G#'s 7-element tuple arity cap.
        string source = @"
using System.Linq;

namespace Corpus.Issue1998
{
    public class Holder
    {
        public int[] Sums(int[] nums)
        {
            var q = from n in nums
                    let a = n + 1
                    let b = n + 2
                    let c = n + 3
                    let d = n + 4
                    let e = n + 5
                    let f = n + 6
                    let g = n + 7
                    select n + a + b + c + d + e + f + g;
            return q.ToArray();
        }
    }
}
";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Source.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        TranslationDiagnostic diagnostic = Assert.Single(context.Diagnostics);
        Assert.Equal(TranslationSeverity.Unsupported, diagnostic.Severity);
        Assert.Contains("8 range variables", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("7 elements", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void QueryScope_WithUserLocalNamed__q0_NoLongerSynthesizesAnyQName()
    {
        // ADR-0185: the mechanism this test used to lock in (a user local
        // literally named `__q0` forcing the synthesized tuple-parameter
        // counter to bump past it) is retired along with `__q{N}` itself —
        // the destructured parameter now binds under the REAL range-variable
        // names (`n`, `sq`), so a user local named `__q0` has nothing of
        // this translator's own making left to collide with at all.
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1998
{
    public class Holder
    {
        public int[] Sums(int[] nums)
        {
            int __q0 = 41;
            var q = from n in nums
                    let sq = n * n
                    where sq > __q0
                    select n + sq;
            return q.ToArray();
        }
    }
}
");

        // The user's own `__q0` local is untouched (declared, then
        // referenced once) — every `__q` occurrence left is one THEY wrote,
        // none of them a synthesized tuple-parameter name.
        Assert.Contains("let __q0 = 41", rendered, StringComparison.Ordinal);
        Assert.Contains("((n int32, sq int32)) -> sq > __q0", rendered, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(rendered, "__q"));
        AssertRoundTripParses(rendered);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    [Fact]
    public void JoinAfterLetClause_WidensThreeElementScope_LowersToJoinWithTupleResultSelector()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1998
{
    public class Order
    {
        public int CustomerId;
        public int Amount;
    }

    public class Customer
    {
        public int Id;
        public string Name;
    }

    public class Holder
    {
        public string[] Receipts(Order[] orders, Customer[] customers)
        {
            var receipts = from o in orders
                           let taxed = o.Amount + o.Amount / 10
                           join c in customers on o.CustomerId equals c.Id
                           select c.Name + "":"" + taxed;
            return receipts.ToArray();
        }
    }
}
");

        Assert.Contains(
            "orders.Select((o Order) -> {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("return (o, o.Amount + o.Amount / 10)", rendered, StringComparison.Ordinal);

        // ADR-0185: the outer key selector destructures the widened (o,
        // taxed) scope directly under its real names — no `__qN` parameter
        // or `let` deconstruction.
        Assert.Contains(
            "}).Join(customers, ((o Order, taxed int32)) -> o.CustomerId, (c Customer) -> c.Id, ((o Order, taxed int32), c Customer) -> {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("return (o, taxed, c)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void GroupClauseContinuation_FollowedByJoin_LowersToGroupByThenJoin()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1998
{
    public class Sale
    {
        public int RegionId;
        public int Amount;
    }

    public class Region
    {
        public int Id;
        public string Name;
    }

    public class Holder
    {
        public string[] Totals(Sale[] sales, Region[] regions)
        {
            var totals = from s in sales
                         group s.Amount by s.RegionId into g
                         join r in regions on g.Key equals r.Id
                         select r.Name + ""="" + g.Sum();
            return totals.ToArray();
        }
    }
}
");

        Assert.Contains(".GroupBy((s Sale) -> s.RegionId, (s Sale) -> s.Amount)", rendered, StringComparison.Ordinal);
        Assert.Contains(".Join(regions,", rendered, StringComparison.Ordinal);
        Assert.Contains("g.Sum()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void QueryScope_WithMoreThanThreeRangeVariables_WidensTupleAcrossMultipleLets()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1998
{
    public class Holder
    {
        public int[] Combined(int[] nums)
        {
            var q = from a in nums
                    let b = a + 1
                    let c = a + 2
                    let d = a + 3
                    select a + b + c + d;
            return q.ToArray();
        }
    }
}
");

        // ADR-0185: each successive `let` widens the scope by one more
        // element; every intermediate Select's lambda destructures the
        // scope-so-far directly under its real names (no `__qN` parameter
        // or `let` deconstruction at any width), and the FINAL select — which
        // widens no further — collapses all the way to an expression body.
        Assert.Contains("}).Select(((a int32, b int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("return (a, b, a + 2)", rendered, StringComparison.Ordinal);
        Assert.Contains("}).Select(((a int32, b int32, c int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("return (a, b, c, a + 3)", rendered, StringComparison.Ordinal);
        Assert.Contains("}).Select(((a int32, b int32, c int32, d int32)) -> a + b + c + d)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void OrderByThenByClause_OverWidenedScope_DestructuresDirectlyNoQName()
    {
        // ADR-0185's clause table: orderby/thenby was not otherwise covered
        // by an existing test with a widened (> 1 variable) scope. Both key
        // selectors here run over the two-element (n, sq) scope a preceding
        // `let` widened.
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1998
{
    public class Holder
    {
        public int[] Sorted(int[] nums)
        {
            var sorted = from n in nums
                         let sq = n * n
                         orderby sq descending, n
                         select n + sq;
            return sorted.ToArray();
        }
    }
}
");

        Assert.Contains(".OrderByDescending(((n int32, sq int32)) -> sq)", rendered, StringComparison.Ordinal);
        Assert.Contains(".ThenBy(((n int32, sq int32)) -> n)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

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
