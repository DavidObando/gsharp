// <copyright file="Issue1902LinqQueryTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1902: a C# query expression's second `from` (SelectMany),
/// `let`, `join`/`join ... into` (Join/GroupJoin), and
/// `group ... by` clauses had no canonical G# lowering and reported the
/// CS2GS-GAP "query clause/query '<K>' has no canonical G# lowering
/// yet". Basic `from`/`where`/`orderby`/`select`/`into`
/// already lowered to a `.Where()/.OrderBy()/.Select()` method-call chain
/// threading a single range variable; this generalizes that same mechanism to
/// a "scope" of range variables (mirroring Roslyn's own transparent
/// identifiers, §12.19.3 of the C# spec) threaded as a positional
/// `(name1, name2, ...)` tuple whenever more than one variable is in
/// scope.
///
/// ADR-0185 (issue #4304): a multi-variable scope now binds a
/// tuple-DESTRUCTURING lambda parameter directly under the real
/// range-variable names — `((name1 T1, name2 T2, ...)) -> body` —
/// instead of the retired `__q{N}` synthetic tuple parameter plus a
/// `let (name1, name2, ...) = __qN` deconstruction prologue. The
/// assertions below were updated in the same change (this repo's practice of
/// keeping regression tests in sync rather than leaving stale assertions
/// alongside new ones).
open class Issue1902LinqQueryTranslationTests {
    @Fact
    func SecondFromClauseUsesSelectManyResultSelectorParameterType() {
        let rendered = Render(`
using System;
using System.Linq;

namespace Corpus.Issue1902
{
    public class QuerySource<T>
    {
        public TResult[] SelectMany<TCollection, TResult>(
            Func<T, TCollection[]> collectionSelector,
            Func<T, long, TResult> resultSelector,
            Func<int, string, int> unrelatedSelector = null) =>
            new[] { resultSelector(default(T), 42L) };
    }

    public class Holder
    {
        public long[] Values(QuerySource<int> source)
        {
            return (from x in source
                    from y in new[] { x }
                    select y);
        }
    }
}
`)
        Assert.Contains("(x int32, y int64)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(
            rendered,
            "The custom SelectMany result selector still requires explicit generic arguments in G#."
        )
    }

    @Fact
    func SecondFromClause_LowersToSelectManyWithTupleResultSelector() {
        let rendered = Render(`
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
`)
        Assert.Contains(
            "tens.SelectMany((t int32) -> ones, (t int32, o int32) -> {",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("return (t, o)", rendered, StringComparison.Ordinal)
        // ADR-0185: the final `select t + o` widens no further scope — its
        // lambda destructures the (t, o) tuple directly under its real
        // names, and (having no other prologue to hoist) collapses to an
        // expression body with no `__qN` / `let` deconstruction at all.
        Assert.Contains("}).Select(((t int32, o int32)) -> t + o)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func CustomOrderByProviderDoesNotReceiveEnumerableCast() {
        let rendered = Render(`#nullable enable
using System;

namespace Corpus.Issue1902
{
    public sealed class Query<T>
    {
        public Query<T> OrderBy<TKey>(Func<T, TKey> selector) => this;

        public Query<T> ThenBy<TKey>(Func<T, TKey> selector) => this;

        public Query<TResult> Select<TResult>(
            Func<T, TResult> selector) => new();
    }

    public class Holder
    {
        public Query<(string? Value, int Key)> Sort(
            Query<(string? Value, int Key)> source)
        {
            return from pair in source
                   orderby pair.Value, pair.Key
                   select pair;
        }
    }
}`)
        Assert.DoesNotContain("System.Linq.Enumerable.Cast", rendered, StringComparison.Ordinal)
        Assert.Contains(".OrderBy(", rendered, StringComparison.Ordinal)
        Assert.Contains(".ThenBy(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func LetClause_LowersToSelectWithWidenedTupleScope() {
        let rendered = Render(`
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
                          select $"{n}->{sq}";
            return squares.ToArray();
        }
    }
}
`)
        Assert.Contains("nums.Select((n int32) -> {", rendered, StringComparison.Ordinal)
        Assert.Contains("return (n, n * n)", rendered, StringComparison.Ordinal)
        // ADR-0185: both the `where sq > 4` predicate and the final `select`
        // widen no further scope — each destructures the (n, sq) tuple
        // directly under its real names and collapses to an expression body.
        Assert.Contains("}).Where(((n int32, sq int32)) -> sq > 4)", rendered, StringComparison.Ordinal)
        Assert.Contains(".Select(((n int32, sq int32)) -> \"$$n->$$sq\")", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func JoinClause_LowersToJoinWithTupleResultSelector() {
        let rendered = Render(`
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
                          select o.Name + "+" + p.Name;
            return matched.ToArray();
        }
    }
}
`)
        Assert.Contains(
            "owners.Join(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, p Pet) -> {",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("return (o, p)", rendered, StringComparison.Ordinal)
        // ADR-0185: the final `select` destructures the (o, p) tuple
        // directly under its real names — no `__qN` parameter or `let`
        // deconstruction.
        Assert.Contains("}).Select(((o Owner, p Pet)) -> o.Name + \"+\" + p.Name)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__q", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func JoinIntoClause_LowersToGroupJoinWithSequenceContinuation() {
        let rendered = Render(`
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
                         select o.Name + "=" + petGroup.Count();
            return counts.ToArray();
        }
    }
}
`)
        Assert.Contains(
            ".GroupJoin(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, petGroup sequence[Pet]) -> {",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("petGroup.Count()", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(
            rendered,
            "G# cannot yet bind the translated GroupJoin continuation and its inferred sequence element types."
        )
    }

    @Fact
    func GroupClause_LowersToGroupByWithIdentityElision() {
        let rendered = Render(`
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
`)
        Assert.Contains("nums.GroupBy((n int32) -> n % 3)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func GroupClause_WithContinuation_LowersToGroupByFollowedByScopeChain() {
        let rendered = Render(`
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
                             select g.Key + ":" + string.Join("|", g);
            return longGroups.ToArray();
        }
    }
}
`)
        Assert.Contains(".GroupBy((w string) -> w.Length)", rendered, StringComparison.Ordinal)
        Assert.Contains(".Where((g", rendered, StringComparison.Ordinal)
        Assert.Contains("g.Key > 3", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InitialFromClause_UsesBoundQuerySelectorParameterType() {
        let rendered = Render(`using System;
using System.Collections;
using System.Collections.Generic;

namespace Corpus.Issue4525
{
    public sealed class Query : IEnumerable<int>
    {
        public Result<TResult> Select<TResult>(Func<long, TResult> selector) => new();

        public IEnumerator<int> GetEnumerator()
        {
            yield return 0;
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public sealed class Result<T>
    {
    }

    public class Holder
    {
        public Result<long> Run(Query source)
        {
            return from item in source
                   select item;
        }
    }
}`)
        Assert.Contains("source.Select((item int64) -> item)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string, roundTripOnlyReason string? = nil) {
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(rendered)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(rendered, roundTripOnlyReason)
            }
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
