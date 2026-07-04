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
/// <item>the synthesized transparent-identifier tuple parameter name
/// (<c>__qN</c>) now guards against colliding with a user-declared range
/// variable literally named <c>__q0</c>/etc.;</item>
/// <item>previously-untested query-clause combinations (join after a
/// preceding <c>let</c>, a join continuing a <c>group ... into</c>, and a
/// scope with more than 3 range variables) are locked in with regression
/// tests.</item>
/// </list>
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
    public void QueryScope_WithUserLocalNamed__q0_DoesNotCollideWithSynthesizedTupleParam()
    {
        // A user local literally named `__q0` sits alongside the query so the
        // synthesized tuple parameter (which would otherwise also start at
        // `__q0`) must be bumped past it.
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

        Assert.DoesNotContain("let (n, sq) = __q0", rendered, StringComparison.Ordinal);
        Assert.Contains("let (n, sq) = __q1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
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
        Assert.Contains(
            "}).Join(customers, (__q0 (Order, int32)) -> {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("let (o, taxed) = __q0", rendered, StringComparison.Ordinal);
        Assert.Contains("return o.CustomerId", rendered, StringComparison.Ordinal);
        Assert.Contains("(c Customer) -> c.Id", rendered, StringComparison.Ordinal);
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

        Assert.Contains("sales.GroupBy((s Sale) -> s.RegionId, (s Sale) -> s.Amount)", rendered, StringComparison.Ordinal);
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

        Assert.Contains("}).Select((__q0 (int32, int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("let (a, b) = __q0", rendered, StringComparison.Ordinal);
        Assert.Contains("}).Select((__q1 (int32, int32, int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("let (a, b, c) = __q1", rendered, StringComparison.Ordinal);
        Assert.Contains("}).Select((__q2 (int32, int32, int32, int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("let (a, b, c, d) = __q2", rendered, StringComparison.Ordinal);
        Assert.Contains("return a + b + c + d", rendered, StringComparison.Ordinal);
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
