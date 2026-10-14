// <copyright file="GeneratorHostEndToEndTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import System
import System.Collections.Generic
import System.Linq
import System.Text
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import Xunit
import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis
import GSharp.GeneratorHost
import System.Threading

/// ADR-0145 §B/§C: end-to-end tests for the source-generator host — project a
/// bound G# compilation to a C# stub, run a Roslyn incremental generator over
/// it, and back-translate the generated C# into a G# `partial` part that
/// augments the user's own type.
open class GeneratorHostEndToEndTests {
    @Fact
    func GeneratedPartial_BackTranslatesToGsPartialPart_ThatRoundTrips() {
        let gs = BuildGs(`
package App

@Obsolete
partial class Foo {
}
`)
        let result = GeneratorHostRunner.Run(gs, References, []IIncrementalGenerator{GreetingGenerator()})
        Assert.Empty(result.Failures)
        // Exactly one generated part, back-translated to G#.
        let file = Assert.Single(result.GeneratedGsFiles)
        Assert.EndsWith(".g.cs", file.HintName)
        Assert.Contains("partial class Foo", file.GSharpSource)
        Assert.Contains("prop Greeting", file.GSharpSource)
        // The generated G# must re-parse as valid G#.
        let roundTrip = GSharpRoundTrip.Validate(file.GSharpSource)
        Assert.True(
            roundTrip.Success,
            "Generated G# did not round-trip:\n" + file.GSharpSource + "\n" + string.Join("\n", roundTrip.Errors)
        )
    }

    @Fact
    func GeneratedMember_BecomesVisible_ToGsCompilation() {
        const UserSource = `
package App

@Obsolete
partial class Foo {
}
`
        let gs = BuildGs(UserSource)
        let result = GeneratorHostRunner.Run(gs, References, []IIncrementalGenerator{GreetingGenerator()})
        let generated = Assert.Single(result.GeneratedGsFiles)
        // Feed the ORIGINAL user .gs, the GENERATED .g.gs part, and a use-site
        // that reads Foo.Greeting into one G# compilation. If the generated
        // partial member is now visible to gsc, member access binds cleanly.
        const UseSource = `
package App

func UseGreeting(f Foo) string {
    return f.Greeting
}
`
        let combined = Compilation(
            GsSyntaxTree.Parse(SourceText.From(UserSource)),
            GsSyntaxTree.Parse(SourceText.From(generated.GSharpSource)),
            GsSyntaxTree.Parse(SourceText.From(UseSource))
        ){IsLibrary = true}
        let errors = combined
            .GlobalScope
            .Diagnostics
            .Concat(combined.BoundProgram.Diagnostics)
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToList()
        Assert.False(
            errors.Any(
                (e GSharp.Core.CodeAnalysis.Diagnostic) -> e.Message.IndexOf("Greeting", StringComparison.Ordinal) >= 0
            ),
            "Generated member 'Greeting' was not visible to the G# compilation:\n" +
                generated.GSharpSource +
                "\n" +
                string.Join("\n", errors.Select((e GSharp.Core.CodeAnalysis.Diagnostic) -> e.Message))
        )
    }

    @Fact
    func ThrowingGenerator_IsCrashIsolated_AndRecordedAsFailure() {
        let gs = BuildGs(`
package App

@Obsolete
partial class Foo {
}
`)
        let result = GeneratorHostRunner.Run(
            gs,
            References,
            []IIncrementalGenerator{ThrowingGenerator(), GreetingGenerator()}
        )
        // The throwing generator did not abort the run...
        Assert.NotEmpty(result.Failures)
        // ...and the well-behaved generator's output still came through.
        Assert.Single(result.GeneratedGsFiles)
    }

    /// An in-test incremental generator that mimics an attribute-driven
    /// generator: for each class marked with `[Obsolete]` (used purely as a
    /// convenient BCL marker so no custom attribute assembly is needed), it emits
    /// a `partial` augmentation carrying a `Greeting` property.
    private class GreetingGenerator : IIncrementalGenerator {
        func Initialize(context IncrementalGeneratorInitializationContext) {
            let classes = context.SyntaxProvider.ForAttributeWithMetadataName(
                "System.ObsoleteAttribute",
                predicate: (
                    node Microsoft.CodeAnalysis.SyntaxNode,
                    _ CancellationToken
                ) -> node is ClassDeclarationSyntax,
                transform: (ctx GeneratorAttributeSyntaxContext, _ CancellationToken) -> cast[INamedTypeSymbol](
                    ctx.TargetSymbol
                )
            )
            context.RegisterSourceOutput(
                classes,
                (spc SourceProductionContext, symbol INamedTypeSymbol) -> {
                    let ns string? = if symbol.ContainingNamespace is {IsGlobalNamespace: false} n {
                        n.ToDisplayString()
                    } else {
                        default(string?)
                    }
                    let name = symbol.Name
                    let sb = StringBuilder()
                    sb.AppendLine("#nullable enable")
                    if ns != nil {
                        sb.Append("namespace ").AppendLine(ns)
                        sb.AppendLine("{")
                    }
                    sb.Append("    partial class ").AppendLine(name)
                    sb.AppendLine("    {")
                    sb.Append("        public string Greeting => \"hi from \" + nameof(").Append(name).AppendLine(");")
                    sb.AppendLine("    }")
                    if ns != nil {
                        sb.AppendLine("}")
                    }
                    spc.AddSource(name + ".g.cs", sb.ToString())
                }
            )
        }
    }

    /// An in-test generator that always throws, to exercise crash isolation.
    private class ThrowingGenerator : IIncrementalGenerator {
        func Initialize(context IncrementalGeneratorInitializationContext) {
            context.RegisterSourceOutput(
                context.CompilationProvider,
                (spc SourceProductionContext, _ Microsoft.CodeAnalysis.Compilation) -> throw InvalidOperationException(
                    "boom from ThrowingGenerator"
                )
            )
        }
    }

    shared {
        private prop References IReadOnlyList[MetadataReference] -> CSharpProjectLoader.RuntimeReferences()

        private func BuildGs(gsSource string) Compilation {
            return Compilation(GsSyntaxTree.Parse(SourceText.From(gsSource)))
        }
    }
}
