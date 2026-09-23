// <copyright file="GeneratedRegexStubTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using static GSharp.GeneratorHost.Tests.StubTestSupport;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0192 follow-on 2 / issue #4301: a G# <c>@GeneratedRegex</c> on a
/// <c>partial func</c> declaring part must drive the REAL
/// <c>System.Text.RegularExpressions.Generator</c> through the stub. The
/// generator accepts only a partial, parameterless, body-less method returning
/// <c>Regex</c> (else SYSLIB1043) and only a well-formed attribute (else
/// SYSLIB1040). Back-translating the generated tree to G# is out of scope here.
/// </summary>
public class GeneratedRegexStubTests
{
    [Theory]
    [InlineData(@"""\\d+""", "\"\\\\d+\"")]
    [InlineData(
        @"""^(?<y>\\d{4})-(?<m>\\d{2})$"", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant",
        "\"^(?<y>\\\\d{4})-(?<m>\\\\d{2})$\", (global::System.Text.RegularExpressions.RegexOptions)513")]
    public void DeclaringPart_DrivesTheRealRegexGenerator_ToEmitTheImplementation(string gsArguments, string stubArguments)
    {
        var stub = Project(@"
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(" + gsArguments + @")
        private partial func Digits() Regex;
    }
}
");
        Assert.Contains("[global::System.Text.RegularExpressions.GeneratedRegexAttribute(" + stubArguments + ")]", stub);

        GeneratorRunResult run = GeneratorRunner.RunFromAnalyzerPaths(
            stub,
            CSharpProjectLoader.RuntimeReferences(),
            new[] { RegexGeneratorPath() });

        Assert.Empty(run.Failures);
        Assert.True(
            run.GeneratorDiagnostics.Count == 0,
            "generator diagnostics:\n" + string.Join("\n", run.GeneratorDiagnostics) + "\nstub:\n" + stub);

        var generated = Assert.Single(run.Documents, d => d.HintName == "RegexGenerator.g.cs");
        var implementation = CSharpSyntaxTree.ParseText(generated.SourceText).GetRoot()
            .DescendantNodes()
            .OfType<MethodDeclarationSyntax>()
            .SingleOrDefault(m => m.Identifier.Text == "Digits");
        Assert.True(implementation != null, "no Digits implementation in:\n" + generated.SourceText);
        Assert.Contains(implementation.Modifiers, m => m.Text == "partial");
        Assert.NotNull(implementation.ExpressionBody ?? (SyntaxNode)implementation.Body);
    }
}
