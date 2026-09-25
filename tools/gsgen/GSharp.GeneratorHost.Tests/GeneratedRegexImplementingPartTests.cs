// <copyright file="GeneratedRegexImplementingPartTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using Xunit.Abstractions;
using static GSharp.GeneratorHost.Tests.StubTestSupport;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0192 follow-on 2, step 3: a G# <c>@GeneratedRegex</c> declaring part
/// drives the REAL Regex generator through the stub, and the back-translated
/// <c>.g.gs</c> carries the generated implementation as a G# IMPLEMENTING part
/// (<c>partial func</c> with its body) rather than an ordinary method that
/// would leave the declaring part unimplemented (GS0609) and collide with it
/// (GS0264).
/// </summary>
public class GeneratedRegexImplementingPartTests
{
    private const string UserSourceTemplate = @"package App

import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(ARGUMENTS)
        private partial func Digits() Regex;

        public func Test(s string) bool {
            return Digits().IsMatch(s)
        }
    }
}
";

    private readonly ITestOutputHelper output;

    public GeneratedRegexImplementingPartTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    // The patterns span the generator's shapes: a simple loop, captures with
    // options, and a backtracking alternation whose C# passes
    // `ref base.runstack!` (a by-ref argument under `!`).
    [Theory]
    [InlineData(@"""\\d+""", "a1")]
    [InlineData(@"""^(?<y>\\d{4})-(?<m>\\d{2})$"", RegexOptions.IgnoreCase", "2024-05")]
    [InlineData(@"""(foo|ba+r)+\\w*?baz"", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase", "xxFOObaarQQbaz")]
    public void RealRegexGenerator_BackTranslatesToAnImplementingPart_ThatCompilesAndRuns(string arguments, string match)
    {
        string userSource = UserSourceTemplate.Replace("ARGUMENTS", arguments, StringComparison.Ordinal);
        var user = new Compilation(GsSyntaxTree.Parse(SourceText.From(userSource, "User.gs")));

        GeneratorHostResult result = GeneratorHostRunner.RunFromAnalyzerPaths(
            user,
            CSharpProjectLoader.RuntimeReferences(),
            new[] { RegexGeneratorPath() });

        Assert.Empty(result.Failures);
        Assert.Empty(result.GeneratorDiagnostics);
        (string hintName, string generated) = Assert.Single(result.GeneratedGsFiles);
        this.output.WriteLine("// " + hintName);
        this.output.WriteLine(generated);

        Assert.Contains("private partial func Digits() Regex -> Digits_0.Instance", generated, StringComparison.Ordinal);

        // Compile the user file with the .g.gs. The pairing itself must hold:
        // no lone declaring part (GS0609), no part-count mismatch (GS0610), no
        // duplicate overload (GS0264). Other diagnostics are the remaining
        // ADR-0192 follow-on 2 step-4 work (the header and namespace of the
        // generated part) and are only reported here.
        var combined = new Compilation(
            GsSyntaxTree.Parse(SourceText.From(userSource, "User.gs")),
            GsSyntaxTree.Parse(SourceText.From(generated, hintName + ".gs")))
        {
            IsLibrary = true,
        };
        List<string> errors = combined.GlobalScope.Diagnostics
            .Concat(combined.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .Select(diagnostic =>
                $"{diagnostic.Id} {diagnostic.Location.Text?.FileName}:{diagnostic.Location.StartLine + 1}: " +
                diagnostic.Message)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        foreach (string error in errors)
        {
            this.output.WriteLine(error);
        }

        Assert.DoesNotContain(errors, error => error.Contains("GS0609", StringComparison.Ordinal));
        Assert.DoesNotContain(errors, error => error.Contains("GS0610", StringComparison.Ordinal));
        Assert.DoesNotContain(errors, error => error.Contains("GS0264", StringComparison.Ordinal));

        using var peStream = new MemoryStream();
        var emit = combined.Emit(peStream);
        foreach (var diagnostic in emit.Diagnostics.Where(diagnostic => diagnostic.IsError))
        {
            this.output.WriteLine("emit: " + diagnostic.Id + " " + diagnostic.Message);
        }

        Assert.True(emit.Success);
        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext("GeneratedRegex-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        Type p = loadContext.LoadFromStream(peStream).GetTypes().Single(type => type.Name == "P");
        MethodInfo test = p.GetMethod("Test", BindingFlags.Public | BindingFlags.Static);
        Assert.Equal(true, test.Invoke(null, new object[] { match }));
        Assert.Equal(false, test.Invoke(null, new object[] { "zzz" }));
    }
}
