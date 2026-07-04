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
/// Issue #1967: hardens the issue #1894/#1894 loud-gap coverage for
/// <c>System.Index</c>/<c>System.Range</c> at three classes of site the
/// original fix missed:
/// <list type="bullet">
/// <item><c>IsDirectIndexBracketArgument</c> did not recognise
/// <c>ImplicitElementAccessSyntax</c> (a dictionary/collection-initializer
/// element, <c>{ [^1] = v }</c>), so a valid inline from-end index there would
/// have over-gapped as if it were outside any bracket. Making this position
/// canonical in turn exposed a pre-existing <see cref="GSharpPrinter"/> bug:
/// a NON-generic zero-argument construction target
/// (<c>new IndexKeyed() { [^1] = 5 }</c>) printed its constructor call's `()`
/// away, but gsc's parser only recognises a bare `Identifier{ ... }` as a
/// STRUCT literal (`Identifier :` fields) — never as a collection initializer
/// with a `[key] = value`/`key: value` element — so the emitted G# silently
/// failed to parse. The printer now keeps the `()` whenever the target is
/// non-generic.</item>
/// <item>An Index/Range-typed local declared via a NON-declarator site —
/// <c>foreach (Index i in xs)</c>, an <c>is</c>/<c>switch</c> pattern
/// designation (<c>x is Index i</c>, <c>case Index i:</c>), an <c>out Index
/// i</c> argument, or tuple deconstruction (<c>var (i, r) = ...</c>) — bypassed
/// the declarator-only symbol check in <c>TranslateLocalDeclaration</c> and
/// would slip through with no diagnostic.</item>
/// <item>An Index/Range-typed LINQ query range variable (<c>from Index i in
/// xs</c>, a <c>let</c>/<c>join</c> binding, or a query continuation's
/// <c>into y</c>) binds an <c>IRangeVariableSymbol</c>, not an
/// <c>ILocalSymbol</c> — none of those sites have any designation syntax at
/// all, so they need their own symbol-based guard
/// (<c>ReportIfIndexOrRangeTypedRangeVariable</c>).</item>
/// </list>
/// </summary>
public class Issue1967IndexRangeHardeningTests
{
    [Fact]
    public void ImplicitElementAccess_FromEndIndexKey_StaysCanonicalNoGap()
    {
        // `{ [^1] = v }` inside a collection initializer is just as direct a
        // bracket-argument position as a real element access — must not gap
        // with the "from-end index ... outside a direct bracket" diagnostic
        // (`IsDirectIndexBracketArgument`'s `ImplicitElementAccessSyntax` gap).
        // The indexer's own `Index i` PARAMETER still independently gaps per
        // #1894 (an Index-typed parameter has no canonical G# type) — that is
        // unrelated to this check and is asserted separately below.
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
        Assert.DoesNotContain(context.Diagnostics, d => d.Message.Contains("outside a direct", StringComparison.Ordinal));
        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));

        // Issue #1967: `IsDirectIndexBracketArgument` now treats an initializer
        // element (`{ [^1] = v }`) the same as a real element access — verify
        // gsc's OWN parser actually accepts a from-end index in that position,
        // not just that the printer emitted the `^1` text (a printer-only check
        // would miss gsc silently rejecting it as unparseable G#).
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(rendered);
        Assert.True(roundTrip.Success, "Translated G# must parse. Errors:\n" +
            string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + rendered);
    }

    [Fact]
    public void ForEachIndexTypedVariable_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
        Assert.All(context.Diagnostics, d => Assert.Equal(TranslationSeverity.Unsupported, d.Severity));
    }

    [Fact]
    public void IsPatternIndexTypedDesignation_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void WhileLoopConditionIsPatternIndexTypedDesignation_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void SwitchCasePatternIndexTypedDesignation_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void SwitchExpressionArmPatternIndexTypedDesignation_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void OutIndexTypedArgument_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void TupleDeconstructionIndexTypedElement_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void TupleDeconstructionAssignment_MixedIndexTypedElement_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void QueryFromClauseIndexTypedRangeVariable_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void QueryLetClauseIndexTypedRangeVariable_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void QueryJoinClauseIndexTypedRangeVariable_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void QueryContinuationIndexTypedRangeVariable_StaysLoudGap()
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

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
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
