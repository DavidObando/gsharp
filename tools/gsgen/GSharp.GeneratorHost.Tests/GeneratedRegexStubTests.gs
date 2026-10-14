// <copyright file="GeneratedRegexStubTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import Cs2Gs.Translator.Loading
import GSharp.GeneratorHost
import GSharp.GeneratorHost.Tests.StubTestSupport
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Linq
import Xunit

/// ADR-0192 follow-on 2 / issue #4301: a G# `@GeneratedRegex` on a
/// `partial func` declaring part must drive the REAL
/// `System.Text.RegularExpressions.Generator` through the stub. The
/// generator accepts only a partial, parameterless, body-less method returning
/// `Regex` (else SYSLIB1043) and only a well-formed attribute (else
/// SYSLIB1040). Back-translating the generated tree to G# is out of scope here.
open class GeneratedRegexStubTests {
    @Theory
    @InlineData("\"\\\\d+\"", "\"\\\\d+\"")
    @InlineData(
        "\"^(?<y>\\\\d{4})-(?<m>\\\\d{2})$$\", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant",
        "\"^(?<y>\\\\d{4})-(?<m>\\\\d{2})$$\", (global::System.Text.RegularExpressions.RegexOptions)513"
    )
    func DeclaringPart_DrivesTheRealRegexGenerator_ToEmitTheImplementation(gsArguments string, stubArguments string) {
        let stub = StubTestSupport.Project(`
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex(` + gsArguments + `)
        private partial func Digits() Regex;
    }
}
`)
        Assert.Contains("[global::System.Text.RegularExpressions.GeneratedRegexAttribute(" + stubArguments + ")]", stub)
        let run = GeneratorRunner.RunFromAnalyzerPaths(
            stub,
            CSharpProjectLoader.RuntimeReferences(),
            []string{RegexGeneratorPath()!!}
        )
        Assert.Empty(run.Failures)
        Assert.True(
            run.GeneratorDiagnostics.Count == 0,
            "generator diagnostics:\n" + string.Join("\n", run.GeneratorDiagnostics) + `
stub:
` + stub
        )
        let generated = Assert.Single(run.Documents, (d GeneratedCsDocument) -> d.HintName == "RegexGenerator.g.cs")
        let implementation MethodDeclarationSyntax? = CSharpSyntaxTree
            .ParseText(generated.SourceText)
            .GetRoot()
            .DescendantNodes()
            .OfType[MethodDeclarationSyntax]()
            .SingleOrDefault((m MethodDeclarationSyntax) -> m.Identifier.Text == "Digits")
        Assert.True(implementation != nil, "no Digits implementation in:\n" + generated.SourceText?.ToString())
        Assert.Contains(implementation!!.Modifiers, (m SyntaxToken) -> m.Text == "partial")
        Assert.NotNull(implementation!!.ExpressionBody ?? cast[SyntaxNode](implementation!!.Body))
    }

    @Fact
    func Pattern_WithBackslashesQuotesNonAsciiAndLineSeparators_ReachesTheGeneratorExactly() {
        // G# escapes: \\ backslash, \"" quote, \u code points. The emoji is a
        // raw surrogate pair in the G# source because a G# \U escape stops at
        // U+FFFF (ADR-0046). The pattern is meaningless as a regex on purpose;
        // it only has to survive.
        let stub = StubTestSupport.Project(`
package App
import System.Text.RegularExpressions

partial class P {
    shared {
        @GeneratedRegex("a\\d\"q\" é日本` + "😀" + ` \u2028\u2029\u0085\t!")
        private partial func Odd() Regex;
    }
}
`)
        const Expected = "a\\d\"q\" é日本😀   \t!"
        let compilation = BindStub(stub)
        let tree = compilation.SyntaxTrees.Single()
        Assert.DoesNotContain(tree.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let node = tree
            .GetRoot()
            .DescendantNodes()
            .OfType[MethodDeclarationSyntax]()
            .Single((m MethodDeclarationSyntax) -> m.Identifier.Text == "Odd")
        let attribute = Assert.Single(compilation.GetSemanticModel(tree).GetDeclaredSymbol(node)!!.GetAttributes())
        let pattern = Assert.IsType[string](attribute.ConstructorArguments.Single().Value)
        Assert.Equal(Expected, pattern)
        Assert.Equal(Expected.ToCharArray(), pattern.ToCharArray())
    }
}
