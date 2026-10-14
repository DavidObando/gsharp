// <copyright file="GeneratedRegexMigrationRoundTripTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Globalization
import System.Linq
import System.Reflection
import Xunit

/// Issue #4301 (ADR-0192 follow-on 3): a C# `[GeneratedRegex]` method
/// migrated by cs2gs is a G# declaring part that the REAL Regex generator
/// implements through gsgen. Each test translates C# with cs2gs, runs the
/// generator over the G# output, compiles the result and runs it, so the
/// attribute arguments are checked by what the generated `Regex` does,
/// not by how the G# text looks.
open partial class GeneratedRegexImplementingPartTests {
    @Fact
    func MigratedGeneratedRegex_IsImplementedByTheRealGenerator_AndKeepsEveryArgument() {
        // `(?i)^i$` (InlineI) carries no culture name, so pin the current
        // culture for generation and matching: under tr-TR its IgnoreCase would
        // not fold ASCII `I`, and the assertion must not depend on the machine.
        let previous = CultureInfo.CurrentCulture
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture
        try {
            this.AssertMigratedGeneratedRegex()
        } finally {
            CultureInfo.CurrentCulture = previous
        }
    }

    private func AssertMigratedGeneratedRegex() {
        let migrated = TranslateCSharp(MigratedSource, MigratedGenerated)
        this.output.WriteLine(migrated)
        Assert.DoesNotContain("__generatedRegex_", migrated, StringComparison.Ordinal)
        Assert.Contains("private partial func OddPattern() Regex;", migrated, StringComparison.Ordinal)
        Assert.Contains("    partial func Lower() Regex;", migrated, StringComparison.Ordinal)
        let run = this.GenerateAndCompile([]string{migrated}, RegexGenerator())
        let p = run.Type("P")
        Assert.Equal("a\\d\"q\" é日本😀   \t!", cast[string](Invoke(p, "OddText")))
        Assert.Equal("IgnoreCase, ExplicitCapture", cast[string](Invoke(p, "Options")))
        Assert.Equal(1000.0, float64(Invoke(p, "MonthTimeout")))
        Assert.Equal(true, Invoke(p, "InfiniteTimeout"))
        Assert.Equal(true, Invoke(p, "MonthMatches", "2024-05"))
        Assert.Equal(false, Invoke(p, "MonthMatches", "May"))
        // Culture-sensitive IgnoreCase, which the old cached-Regex rewrite
        // reported as unsupported: under tr-TR, `i` matches dotted `\u0130` but
        // not ASCII `I`.
        Assert.Equal(true, Invoke(p, "TurkishMatches", "İ"))
        Assert.Equal(false, Invoke(p, "TurkishMatches", "I"))
        Assert.Equal(true, Invoke(p, "InlineMatches", "I"))
        // The instance method is an instance declaring part, and the
        // generator's implementation hands out one cached Regex.
        Assert.Equal(true, Invoke(p, "InstanceMatches", "abc"))
        Assert.Equal(false, Invoke(p, "InstanceMatches", "ABC"))
        Assert.Equal(true, Invoke(p, "SameInstance"))
        Assert.StartsWith(
            GeneratedPackage + ".",
            p.GetMethod("Lower", BindingFlags.Public | BindingFlags.Instance)!!.Invoke(
                Activator.CreateInstance(p),
                nil
            )!!
                .GetType().FullName,
            StringComparison.Ordinal
        )
    }

    shared {
        // `Odd` is a const: the translation re-spells it as the literal. It holds
        // a backslash, quotes, non-ASCII text, a surrogate pair and the line and
        // paragraph separators, all of which must reach the generator unchanged.
        private const MigratedSource string = `using System;
using System.Text.RegularExpressions;

namespace App;

public partial class P
{
    private const string Odd = "a\\d\"q\" \u00E9\u65E5\u672C\uD83D\uDE00 \u2028\u2029\u0085\t!";

    [GeneratedRegex(Odd)]
    private static partial Regex OddPattern();

    [GeneratedRegex(
        @"^(?<y>\d{4})-(?<m>\d{2})$",
        RegexOptions.IgnoreCase | RegexOptions.ExplicitCapture,
        matchTimeoutMilliseconds: 1000)]
    private static partial Regex Month();

    [GeneratedRegex("^infinite$", RegexOptions.None, -1)]
    private static partial Regex Infinite();

    [GeneratedRegex("^i$", RegexOptions.IgnoreCase, "tr-TR")]
    private static partial Regex TurkishI();

    [GeneratedRegex("(?i)^i$")]
    private static partial Regex InlineI();

    [GeneratedRegex("^[a-z]+$")]
    public partial Regex Lower();

    public static string OddText() => OddPattern().ToString();

    public static string Options() => Month().Options.ToString();

    public static double MonthTimeout() => Month().MatchTimeout.TotalMilliseconds;

    public static bool InfiniteTimeout() => Infinite().MatchTimeout == Regex.InfiniteMatchTimeout;

    public static bool MonthMatches(string s) => Month().IsMatch(s);

    public static bool TurkishMatches(string s) => TurkishI().IsMatch(s);

    public static bool InlineMatches(string s) => InlineI().IsMatch(s);

    public static bool InstanceMatches(string s) => new P().Lower().IsMatch(s);

    public static bool SameInstance() => object.ReferenceEquals(new P().Lower(), new P().Lower());
}
`

        // What the Regex generator hands the C# compilation; the loader drops it
        // like any `<auto-generated>` document, as a real migration does.
        private const MigratedGenerated string = `// <auto-generated/>
using System.Text.RegularExpressions;

namespace App;

partial class P
{
    private static partial Regex OddPattern() => null!;
    private static partial Regex Month() => null!;
    private static partial Regex Infinite() => null!;
    private static partial Regex TurkishI() => null!;
    private static partial Regex InlineI() => null!;
    public partial Regex Lower() => null!;
}
`

        private func TranslateCSharp(source string, generated string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("P.cs", source), ("P.g.cs", generated)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return printed
        }
    }
}
