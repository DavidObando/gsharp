// <copyright file="Issue2202NullGuardNarrowedFieldForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2202: a plain null-check guard —
/// <c>if (F == null) {…} else { …F… }</c>, <c>if (F != null) { …F… }</c>, and the
/// ternary equivalents <c>F == null ? A : …F…</c> / <c>F != null ? …F… : A</c> —
/// narrows a nullable field/property <c>F</c> to non-null on the guarded branch.
/// gsc (by design, Kotlin-style smart casts) narrows only LOCALS, never
/// fields/properties, so the guarded read is rejected (GS0155/GS0156) unless
/// cs2gs inserts an explicit <c>F!!</c>. This generalizes the lazy-singleton
/// guard heuristic (issue #2164) to a plain null-check guard that does not
/// assign to the field.
/// </summary>
public class Issue2202NullGuardNarrowedFieldForgivenessTranslationTests
{
    [Fact]
    public void EqualsNullGuard_ElseBranch_AssertsNonNullFieldUse()
    {
        // `if (F == null) {...} else { return F; }` — F is provably non-null in
        // the else branch.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            if (F == null)
            {
                return ""default"";
            }
            else
            {
                return F;
            }
        }
    }
}");

        Assert.Contains("return F!!", printed);
    }

    [Fact]
    public void IsNullGuard_ElseBranch_AssertsNonNullFieldUse()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            if (F is null)
            {
                return ""default"";
            }
            else
            {
                return F;
            }
        }
    }
}");

        Assert.Contains("return F!!", printed);
    }

    [Fact]
    public void NotEqualsNullGuard_ThenBranch_AssertsNonNullFieldUse()
    {
        // `if (F != null) { return F; }` — F is provably non-null in the then
        // branch.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            if (F != null)
            {
                return F;
            }

            return ""default"";
        }
    }
}");

        Assert.Contains("return F!!", printed);
    }

    [Fact]
    public void Ternary_NullCheck_WhenFalseArm_AssertsNonNullFieldUse()
    {
        // `F == null ? "default" : F` — F is provably non-null in the
        // when-false arm.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            return F == null ? ""default"" : F;
        }
    }
}");

        Assert.Contains("F!!", printed);
    }

    [Fact]
    public void Ternary_NonNullCheck_WhenTrueArm_AssertsNonNullFieldUse()
    {
        // `F != null ? F : "default"` — F is provably non-null in the
        // when-true arm.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            return F != null ? F : ""default"";
        }
    }
}");

        Assert.Contains("F!!", printed);
    }

    [Fact]
    public void UnguardedFieldUse_IsNotAsserted()
    {
        // `F` is null-tainted (via the null-check in Guarded()), but Unguarded()
        // reads it with no dominating guard — asserting `!!` there would not be
        // provably safe, so it must stay bare (and fails to compile downstream,
        // which is the expected/documented remaining gap, not this pass's job).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Guarded()
        {
            if (F == null)
            {
                return ""default"";
            }
            else
            {
                return F;
            }
        }

        public string Unguarded()
        {
            return F;
        }
    }
}");

        Assert.Contains("return F!!", printed);

        int unguardedIndex = printed.IndexOf("func Unguarded()", StringComparison.Ordinal);
        Assert.True(unguardedIndex >= 0);
        string unguardedBody = printed.Substring(unguardedIndex);
        Assert.DoesNotContain("!!", unguardedBody);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
