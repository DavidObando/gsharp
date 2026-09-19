// <copyright file="Issue1902LinqQueryTranslationTests.cs" company="GSharp">
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
/// Issue #1902: a C# query expression's second <c>from</c> (SelectMany),
/// <c>let</c>, <c>join</c>/<c>join ... into</c> (Join/GroupJoin), and
/// <c>group ... by</c> clauses had no canonical G# lowering and reported the
/// CS2GS-GAP "query clause/query '&lt;K&gt;' has no canonical G# lowering
/// yet". Basic <c>from</c>/<c>where</c>/<c>orderby</c>/<c>select</c>/<c>into</c>
/// already lowered to a <c>.Where()/.OrderBy()/.Select()</c> method-call chain
/// threading a single range variable; this generalizes that same mechanism to
/// a "scope" of range variables (mirroring Roslyn's own transparent
/// identifiers, §12.19.3 of the C# spec) threaded as a positional
/// <c>(name1, name2, ...)</c> tuple whenever more than one variable is in
/// scope.
///
/// <para>
/// ADR-0185 (issue #4304): a multi-variable scope now binds a
/// tuple-DESTRUCTURING lambda parameter directly under the real
/// range-variable names — <c>((name1 T1, name2 T2, ...)) -&gt; body</c> —
/// instead of the retired <c>__q{N}</c> synthetic tuple parameter plus a
/// <c>let (name1, name2, ...) = __qN</c> deconstruction prologue. The
/// assertions below were updated in the same change (this repo's practice of
/// keeping regression tests in sync rather than leaving stale assertions
/// alongside new ones).
/// </para>
/// </summary>
public class Issue1902LinqQueryTranslationTests
{
    [Fact]
    public void SecondFromClause_LowersToSelectManyWithTupleResultSelector()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1902
{
    public class Holder
    {
        public int[] Sums(int[] tens, int[] ones)
        {
            var sums = from t in tens
                       from o in ones
                       select t + o;
            return sums.ToArray();
        }
    }
}
");

        Assert.Contains(
            "tens.SelectMany((t int32) -> ones, (t int32, o int32) -> {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("return (t, o)", rendered, StringComparison.Ordinal);

        // ADR-0185: the final `select t + o` widens no further scope — its
        // lambda destructures the (t, o) tuple directly under its real
        // names, and (having no other prologue to hoist) collapses to an
        // expression body with no `__qN` / `let` deconstruction at all.
        Assert.Contains("}).Select(((t int32, o int32)) -> t + o)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void LetClause_LowersToSelectWithWidenedTupleScope()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1902
{
    public class Holder
    {
        public string[] Squares(int[] nums)
        {
            var squares = from n in nums
                          let sq = n * n
                          where sq > 4
                          select $""{n}->{sq}"";
            return squares.ToArray();
        }
    }
}
");

        Assert.Contains("nums.Select((n int32) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("return (n, n * n)", rendered, StringComparison.Ordinal);

        // ADR-0185: both the `where sq > 4` predicate and the final `select`
        // widen no further scope — each destructures the (n, sq) tuple
        // directly under its real names and collapses to an expression body.
        Assert.Contains("}).Where(((n int32, sq int32)) -> sq > 4)", rendered, StringComparison.Ordinal);
        Assert.Contains(".Select(((n int32, sq int32)) -> \"$n->$sq\")", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void JoinClause_LowersToJoinWithTupleResultSelector()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1902
{
    public class Owner
    {
        public int Id;
        public string Name;
    }

    public class Pet
    {
        public string Name;
        public int OwnerId;
    }

    public class Holder
    {
        public string[] Matched(Owner[] owners, Pet[] pets)
        {
            var matched = from o in owners
                          join p in pets on o.Id equals p.OwnerId
                          select o.Name + ""+"" + p.Name;
            return matched.ToArray();
        }
    }
}
");

        Assert.Contains(
            "owners.Join(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, p Pet) -> {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("return (o, p)", rendered, StringComparison.Ordinal);

        // ADR-0185: the final `select` destructures the (o, p) tuple
        // directly under its real names — no `__qN` parameter or `let`
        // deconstruction.
        Assert.Contains("}).Select(((o Owner, p Pet)) -> o.Name + \"+\" + p.Name)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void JoinIntoClause_LowersToGroupJoinWithSequenceContinuation()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1902
{
    public class Owner
    {
        public int Id;
        public string Name;
    }

    public class Pet
    {
        public string Name;
        public int OwnerId;
    }

    public class Holder
    {
        public string[] Counts(Owner[] owners, Pet[] pets)
        {
            var counts = from o in owners
                         join p in pets on o.Id equals p.OwnerId into petGroup
                         select o.Name + ""="" + petGroup.Count();
            return counts.ToArray();
        }
    }
}
");

        Assert.Contains(
            ".GroupJoin(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, petGroup sequence[Pet]) -> {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("petGroup.Count()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(
            rendered,
            "G# cannot yet bind the translated GroupJoin continuation and its inferred sequence element types.");
    }

    [Fact]
    public void GroupClause_LowersToGroupByWithIdentityElision()
    {
        string rendered = Render(@"
using System.Linq;
using System.Collections.Generic;

namespace Corpus.Issue1902
{
    public class Holder
    {
        public IEnumerable<IGrouping<int, int>> ByMod(int[] nums)
        {
            var byMod = from n in nums
                        group n by n % 3;
            return byMod;
        }
    }
}
");

        Assert.Contains("nums.GroupBy((n int32) -> n % 3)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void GroupClause_WithContinuation_LowersToGroupByFollowedByScopeChain()
    {
        string rendered = Render(@"
using System.Linq;

namespace Corpus.Issue1902
{
    public class Holder
    {
        public string[] LongGroups(string[] words)
        {
            var longGroups = from w in words
                             group w by w.Length into g
                             where g.Key > 3
                             select g.Key + "":"" + string.Join(""|"", g);
            return longGroups.ToArray();
        }
    }
}
");

        Assert.Contains(".GroupBy((w string) -> w.Length)", rendered, StringComparison.Ordinal);
        Assert.Contains(".Where((g", rendered, StringComparison.Ordinal);
        Assert.Contains("g.Key > 3", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered, string roundTripOnlyReason = null)
    {
        RoundTripResult result = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(rendered)
            : TranslationTestValidation.ValidateRoundTripOnly(rendered, roundTripOnlyReason);

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
