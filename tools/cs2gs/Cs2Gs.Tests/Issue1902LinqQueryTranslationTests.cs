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
/// scope — since G# lambdas bind only a single parameter and has no anonymous
/// types, a multi-variable scope becomes one synthesized <c>__qN</c> tuple
/// parameter destructured via a <c>let (name1, name2, ...) = __qN</c>
/// statement at the top of a block-bodied lambda.
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
        Assert.Contains("}).Select((__q0 (int32, int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("let (t, o) = __q0", rendered, StringComparison.Ordinal);
        Assert.Contains("return t + o", rendered, StringComparison.Ordinal);
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
        Assert.Contains("}).Where((__q0 (int32, int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("let (n, sq) = __q0", rendered, StringComparison.Ordinal);
        Assert.Contains("return sq > 4", rendered, StringComparison.Ordinal);
        Assert.Contains("}).Select((__q1 (int32, int32)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("let (n, sq) = __q1", rendered, StringComparison.Ordinal);
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
        Assert.Contains("}).Select((__q0 (Owner, Pet)) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("let (o, p) = __q0", rendered, StringComparison.Ordinal);
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
            "owners.GroupJoin(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, petGroup sequence[Pet]) -> {",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains("petGroup.Count()", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
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

        Assert.Contains("words.GroupBy((w string) -> w.Length)", rendered, StringComparison.Ordinal);
        Assert.Contains(".Where((g", rendered, StringComparison.Ordinal);
        Assert.Contains("g.Key > 3", rendered, StringComparison.Ordinal);
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
