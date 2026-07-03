// <copyright file="Issue1885LockStatementTranslationTests.cs" company="GSharp">
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
/// Regression tests for issue #1885: a C# <c>lock (expr) { … }</c> statement
/// used to lower to a hand-rolled <c>Monitor.Enter</c>/try-finally/
/// <c>Monitor.Exit</c> sequence that referenced <c>Monitor</c> without ever
/// emitting <c>import System.Threading</c>, so the translated G# failed to
/// compile with GS0157. G# now has a first-class <c>lock</c> keyword with the
/// same semantics, so the translator emits it directly and no import is
/// needed at all.
/// </summary>
public class Issue1885LockStatementTranslationTests
{
    [Fact]
    public void LockStatement_TranslatesToGSharpLockKeyword_NotMonitorCalls()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Counter
    {
        private readonly object gate = new object();
        private int value;

        public void Increment()
        {
            lock (gate)
            {
                value = value + 1;
            }
        }
    }
}");

        // The G# `lock` keyword is emitted directly — no Monitor.Enter/Exit
        // hand-lowering, and (critically) no import of System.Threading is
        // needed since `lock` is a language construct, not a library call.
        Assert.Contains("lock gate {", printed);
        Assert.DoesNotContain("Monitor", printed);
        Assert.DoesNotContain("System.Threading", printed);
    }

    /// <summary>
    /// Any reference-type target — not just a field literally named <c>Gate</c>
    /// — must translate. Locking on a freshly allocated local object (a common
    /// dedicated-lock-object idiom) exercises a non-field target.
    /// </summary>
    [Fact]
    public void LockStatement_OnLocalObjectTarget_Translates()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Worker
    {
        public void Run()
        {
            object sync = new object();
            lock (sync)
            {
                System.Console.WriteLine(""in lock"");
            }
        }
    }
}");

        Assert.Contains("lock sync {", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
