// <copyright file="Issue1967IndexRangeHardeningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1967: hardens the issue #1894/#1894 loud-gap coverage for
/// <c>System.Index</c>/<c>System.Range</c> at two classes of site the original
/// fix missed:
/// <list type="bullet">
/// <item><c>IsDirectIndexBracketArgument</c> did not recognise
/// <c>ImplicitElementAccessSyntax</c> (a dictionary/collection-initializer
/// element, <c>{ [^1] = v }</c>), so a valid inline from-end index there would
/// have over-gapped as if it were outside any bracket.</item>
/// <item>An Index/Range-typed local declared via a NON-declarator site —
/// <c>foreach (Index i in xs)</c>, an <c>is</c>/<c>switch</c> pattern
/// designation (<c>x is Index i</c>, <c>case Index i:</c>), an <c>out Index
/// i</c> argument, or tuple deconstruction (<c>var (i, r) = ...</c>) — bypassed
/// the declarator-only symbol check in <c>TranslateLocalDeclaration</c> and
/// would slip through with no diagnostic.</item>
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
