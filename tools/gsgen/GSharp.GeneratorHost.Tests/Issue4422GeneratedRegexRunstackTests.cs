// <copyright file="Issue4422GeneratedRegexRunstackTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using Xunit.Abstractions;
using static GSharp.GeneratorHost.Tests.StubTestSupport;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// Issue #4422: a regex that backtracks inside a loop makes the real Regex
/// generator emit <c>Utilities.StackPush(ref base.runstack!, …)</c>. cs2gs drops
/// the <c>!</c> (G# cannot spell it on a variable) and translates it to
/// <c>&amp;base.runstack</c>. Bound against the reference pack, which annotates
/// <c>RegexRunner.runstack</c> as <c>int[]?</c>, that argument was GS0154;
/// it is now accepted with GS0612, and cs2gs carries the C# author's
/// suppression across as an ADR-0175 <c>@SuppressDiagnostic("GS0612")</c> scope,
/// so the runner builds with no GS0612 left to fail a warnings-as-errors build.
/// </summary>
public class Issue4422GeneratedRegexRunstackTests
{
    private const string UserSource = @"package App

import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(""(foo|ba+r)+\\w*?baz"", RegexOptions.IgnoreCase)
        private partial func Loop() Regex;

        public func Test(s string) bool {
            return Loop().IsMatch(s)
        }
    }
}
";

    private readonly ITestOutputHelper output;

    public Issue4422GeneratedRegexRunstackTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void BacktrackingLoopRunner_BuildsAgainstTheReferencePack_WithNoGS0612()
    {
        List<(string HintName, string Source)> generated = this.Generate();
        string helpers = string.Concat(generated.Select(file => file.Source));
        Assert.Contains("StackPush(&base.runstack", helpers, StringComparison.Ordinal);
        Assert.Contains("@SuppressDiagnostic(\"GS0612\")", helpers, StringComparison.Ordinal);

        // Nothing is left for a warnings-as-errors build to promote.
        IReadOnlyList<Diagnostic> diagnostics = CompileAgainstReferencePack(generated);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void WithoutTheTranslatedSuppression_TheReferencePackReportsGS0612()
    {
        // Anti-vacuity: the reference pack really does annotate runstack, so
        // the suppression above is what removes the warning.
        List<(string HintName, string Source)> generated = this.Generate()
            .Select(file => (file.HintName, file.Source.Replace("@SuppressDiagnostic(\"GS0612\") ", string.Empty, StringComparison.Ordinal)))
            .ToList();
        Assert.DoesNotContain(generated, file => file.Source.Contains("@SuppressDiagnostic(\"GS0612\")", StringComparison.Ordinal));

        IReadOnlyList<Diagnostic> diagnostics = CompileAgainstReferencePack(generated);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0612");
    }

    private static IReadOnlyList<Diagnostic> CompileAgainstReferencePack(List<(string HintName, string Source)> generated)
    {
        var trees = new List<GsSyntaxTree> { GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs")) };
        trees.AddRange(generated.Select(file => GsSyntaxTree.Parse(SourceText.From(file.Source, file.HintName + ".gs"))));
        var combined = new Compilation(
            ReferenceResolver.WithReferences(RefPackAssemblies()),
            trees.ToArray())
        {
            IsLibrary = true,
        };

        using var peStream = new MemoryStream();
        var emit = combined.Emit(peStream);
        Assert.True(
            emit.Success,
            string.Join(Environment.NewLine, emit.Diagnostics.Select(diagnostic => diagnostic.Id + " " + diagnostic.Message)));
        return emit.Diagnostics;
    }

    private static IEnumerable<string> RefPackAssemblies()
    {
        string runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        string dotnetRoot = Directory.GetParent(runtimeDir!)?.Parent?.Parent?.FullName;
        string tfm = $"net{Environment.Version.Major}.0";
        string packsRoot = Path.Combine(dotnetRoot ?? string.Empty, "packs", "Microsoft.NETCore.App.Ref");
        string refDir = Directory.Exists(packsRoot)
            ? Directory.EnumerateDirectories(packsRoot, Environment.Version.Major + ".*")
                .OrderByDescending(directory => directory, StringComparer.Ordinal)
                .Select(directory => Path.Combine(directory, "ref", tfm))
                .FirstOrDefault(Directory.Exists)
            : null;
        Assert.True(refDir != null, $"prerequisite missing: a Microsoft.NETCore.App.Ref pack for {tfm} under '{packsRoot}'");
        return Directory.EnumerateFiles(refDir, "*.dll");
    }

    private List<(string HintName, string Source)> Generate()
    {
        var user = new Compilation(GsSyntaxTree.Parse(SourceText.From(UserSource, "User.gs")));
        GeneratorHostResult result = GeneratorHostRunner.RunFromAnalyzerPaths(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            new[] { RegexGeneratorPath() });

        Assert.Empty(result.Failures);
        Assert.Empty(result.GeneratorDiagnostics);
        Assert.NotEmpty(result.GeneratedGsFiles);
        var files = new List<(string HintName, string Source)>();
        foreach ((string hintName, string source) in result.GeneratedGsFiles)
        {
            this.output.WriteLine("// " + hintName);
            this.output.WriteLine(source);
            files.Add((hintName, source));
        }

        return files;
    }
}
