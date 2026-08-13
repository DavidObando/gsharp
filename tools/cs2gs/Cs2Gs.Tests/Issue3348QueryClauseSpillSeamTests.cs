// <copyright file="Issue3348QueryClauseSpillSeamTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #3348: a hoist performed while translating a LINQ
/// query CLAUSE escaped into the enclosing method body. A query clause lowers to
/// a lambda, but — unlike an explicit lambda — its body is not an
/// <c>AnonymousFunctionExpressionSyntax</c>, so neither the spill seam
/// (<c>TranslateLambda</c> suspends/reopens it) nor
/// <c>CollectEmbeddedAssignments</c> (which stops at a lambda) treated it as its
/// own evaluation scope.
/// <para>
/// Both kinds of hoist were affected — a single-evaluation spill (issue #1731)
/// and an embedded value-position assignment (issue #1723) — and both produced
/// the same two faults: the hoisted statement referenced the query's RANGE
/// VARIABLE, which is not in scope in the enclosing body (so the emitted G# did
/// not bind), and it ran once for the whole query instead of once per element.
/// </para>
/// <para>
/// The emitted G# still PARSED, so round-trip validation could not catch this.
/// Issue #3382 made binding the shared default for cs2gs translation tests via
/// <see cref="TranslationTestValidation.AssertBinds(string[])"/>.
/// </para>
/// </summary>
public class Issue3348QueryClauseSpillSeamTests
{
    // A non-trivial (member-access) scrutinee under a pattern that reads it more
    // than once is the canonical #1731 spill trigger; putting it in a query
    // clause is the #3348 reproducer.
    private const string TagNode = @"
public sealed class N { public object Tag; }
";

    [Fact]
    public void WhereClause_PatternSpill_StaysInsideTheLambda()
    {
        string printed = TranslateQuery(
            TagNode + @"
public sealed class C
{
    public System.Collections.Generic.IEnumerable<N> M(System.Collections.Generic.IEnumerable<N> xs) =>
        from x in xs where x.Tag is string s && s.Length > 0 select x;
}");

        AssertNativePatternStaysInsideLambda(printed);
    }

    [Fact]
    public void SelectClause_PatternSpill_StaysInsideTheLambda()
    {
        string printed = TranslateQuery(
            TagNode + @"
public sealed class C
{
    public System.Collections.Generic.IEnumerable<bool> M(System.Collections.Generic.IEnumerable<N> xs) =>
        from x in xs select x.Tag is string { Length: > 0 };
}");

        AssertNativePatternStaysInsideLambda(printed);
    }

    [Fact]
    public void LetClause_PatternSpill_StaysInsideTheLambda()
    {
        string printed = TranslateQuery(
            TagNode + @"
public sealed class C
{
    public System.Collections.Generic.IEnumerable<bool> M(System.Collections.Generic.IEnumerable<N> xs) =>
        from x in xs let ok = x.Tag is string { Length: > 0 } select ok;
}");

        AssertNativePatternStaysInsideLambda(printed);
    }

    [Fact]
    public void OrderByClause_PatternSpill_StaysInsideTheLambda()
    {
        string printed = TranslateQuery(
            TagNode + @"
public sealed class C
{
    public System.Collections.Generic.IEnumerable<N> M(System.Collections.Generic.IEnumerable<N> xs) =>
        from x in xs orderby x.Tag is string { Length: > 0 } select x;
}");

        AssertNativePatternStaysInsideLambda(printed);
    }

    [Fact]
    public void AdditionalFromClause_PatternSpill_StaysInsideTheLambda()
    {
        string printed = TranslateQuery(@"
public sealed class N { public System.Collections.Generic.IEnumerable<int> Items; }

public sealed class C
{
    public System.Collections.Generic.IEnumerable<int> M(System.Collections.Generic.IEnumerable<N> xs) =>
        from x in xs from i in (x.Items is { } items ? items : System.Linq.Enumerable.Empty<int>()) select i;
}");

        AssertNativePatternStaysInsideLambda(printed);
    }

    [Fact]
    public void JoinKeySelector_PatternSpill_StaysInsideTheLambda()
    {
        string printed = TranslateQuery(
            TagNode + @"
public sealed class C
{
    public System.Collections.Generic.IEnumerable<int> M(
        System.Collections.Generic.IEnumerable<N> xs,
        System.Collections.Generic.IEnumerable<bool> ys) =>
        from x in xs
        join y in ys on x.Tag is string { Length: > 0 } equals y
        select 1;
}");

        AssertNativePatternStaysInsideLambda(printed);
    }

    /// <summary>
    /// The second half of #3348: an embedded value-position assignment inside a
    /// query clause was hoisted by the ENCLOSING statement's
    /// <c>CollectEmbeddedAssignments</c> scan, emitting `last = x` before the
    /// query — where `x` does not exist — and running the write once instead of
    /// once per element.
    /// </summary>
    [Fact]
    public void WhereClause_ValuePositionAssignment_StaysInsideTheLambda()
    {
        string printed = TranslateQuery(@"
public sealed class C
{
    public System.Collections.Generic.IEnumerable<int> M(System.Collections.Generic.IEnumerable<int> xs)
    {
        int last = 0;
        return from x in xs where (last = x) > 0 select x;
    }
}");

        // The write must be inside the lambda body, not ahead of the query.
        int lambdaStart = printed.IndexOf("->", StringComparison.Ordinal);
        int writeIndex = printed.IndexOf("last = x", StringComparison.Ordinal);
        Assert.True(writeIndex >= 0, "Expected the `last = x` write to survive:\n" + printed);
        Assert.True(
            writeIndex > lambdaStart,
            "The `last = x` write must be inside the query lambda, not hoisted ahead of it:\n" + printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// Guard for the carve-out in <c>EagerQuerySources</c>: the FIRST `from`'s
    /// source is evaluated eagerly, in the enclosing scope. ADR-0161 keeps the
    /// assignment inline in that source expression.
    /// </summary>
    [Fact]
    public void FirstFromSource_ValuePositionAssignment_RemainsInline()
    {
        string printed = TranslateQuery(@"
using System.Collections.Generic;
using System.Linq;

public sealed class C
{
    public IEnumerable<int> M(IEnumerable<int> a, IEnumerable<int> b)
    {
        IEnumerable<int> chosen;
        return from x in (chosen = a) select x;
    }
}");

        int writeIndex = printed.IndexOf("chosen = a", StringComparison.Ordinal);
        int queryIndex = printed.IndexOf(".Select(", StringComparison.Ordinal);
        Assert.True(writeIndex >= 0, "Expected the `chosen = a` write to survive:\n" + printed);
        Assert.True(queryIndex < 0 || writeIndex < queryIndex, printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// A `join`'s `in` source is likewise eager — C# forbids it from referencing
    /// a range variable — so its inline assignment remains in the eager source.
    /// </summary>
    [Fact]
    public void JoinInSource_ValuePositionAssignment_RemainsInline()
    {
        string printed = TranslateQuery(@"
using System.Collections.Generic;
using System.Linq;

public sealed class C
{
    public IEnumerable<int> M(IEnumerable<int> a, IEnumerable<int> b)
    {
        IEnumerable<int> chosen;
        return from x in a
               join y in (chosen = b) on x equals y
               select x;
    }
}");

        Assert.Contains(".Join((chosen = b),", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// An explicit lambda with the same predicate was always correct (it is a real
    /// <c>AnonymousFunctionExpressionSyntax</c>, so <c>TranslateLambda</c> opened a
    /// seam). Kept as the control that isolates the fault to the query path.
    /// </summary>
    [Fact]
    public void ExplicitLambda_PatternSpill_StaysInsideTheLambda_Control()
    {
        string printed = TranslateQuery(
            TagNode + @"
public sealed class C
{
    public System.Collections.Generic.IEnumerable<N> M(System.Collections.Generic.IEnumerable<N> xs) =>
        System.Linq.Enumerable.Where(xs, x => x.Tag is string s && s.Length > 0);
}");

        AssertNativePatternStaysInsideLambda(printed);
    }

    /// <summary>
    /// A query with no hoist at all must keep the compact arrow-lambda form —
    /// the fix must not force every clause lambda to become block-bodied.
    /// </summary>
    [Fact]
    public void QueryWithoutHoist_KeepsArrowLambdaForm()
    {
        string printed = TranslateQuery(@"
using System.Collections.Generic;
using System.Linq;

public sealed class C
{
    public IEnumerable<int> M(IEnumerable<int> xs) => from x in xs where x > 0 select x;
}");

        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("return ", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    private static void AssertNativePatternStaysInsideLambda(string printed)
    {
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.Contains("->", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    private static string TranslateQuery(string source)
    {
        const string Preamble = "using System;\nusing System.Collections.Generic;\nusing System.Linq;\n\n";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", Preamble + "namespace Demo\n{\n" + source + "\n}\n") });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
