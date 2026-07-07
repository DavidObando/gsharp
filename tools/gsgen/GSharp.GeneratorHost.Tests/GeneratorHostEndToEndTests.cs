// <copyright file="GeneratorHostEndToEndTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0145 §B/§C: end-to-end tests for the source-generator host — project a
/// bound G# compilation to a C# stub, run a Roslyn incremental generator over
/// it, and back-translate the generated C# into a G# <c>partial</c> part that
/// augments the user's own type.
/// </summary>
public class GeneratorHostEndToEndTests
{
    private static IReadOnlyList<MetadataReference> References => CSharpProjectLoader.RuntimeReferences();

    [Fact]
    public void GeneratedPartial_BackTranslatesToGsPartialPart_ThatRoundTrips()
    {
        Compilation gs = BuildGs(@"
package App

@Obsolete
partial class Foo {
}
");

        GeneratorHostResult result = GeneratorHostRunner.Run(
            gs,
            References,
            new IIncrementalGenerator[] { new GreetingGenerator() });

        Assert.Empty(result.Failures);

        // Exactly one generated part, back-translated to G#.
        (string HintName, string GSharpSource) file = Assert.Single(result.GeneratedGsFiles);
        Assert.EndsWith(".g.cs", file.HintName);

        Assert.Contains("partial class Foo", file.GSharpSource);
        Assert.Contains("prop Greeting", file.GSharpSource);

        // The generated G# must re-parse as valid G#.
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(file.GSharpSource);
        Assert.True(roundTrip.Success, "Generated G# did not round-trip:\n" + file.GSharpSource + "\n" + string.Join("\n", roundTrip.Errors));
    }

    [Fact]
    public void GeneratedMember_BecomesVisible_ToGsCompilation()
    {
        const string UserSource = @"
package App

@Obsolete
partial class Foo {
}
";

        Compilation gs = BuildGs(UserSource);

        GeneratorHostResult result = GeneratorHostRunner.Run(
            gs,
            References,
            new IIncrementalGenerator[] { new GreetingGenerator() });

        (string HintName, string GSharpSource) generated = Assert.Single(result.GeneratedGsFiles);

        // Feed the ORIGINAL user .gs, the GENERATED .g.gs part, and a use-site
        // that reads Foo.Greeting into one G# compilation. If the generated
        // partial member is now visible to gsc, member access binds cleanly.
        const string UseSource = @"
package App

func UseGreeting(f Foo) string {
    return f.Greeting
}
";

        Compilation combined = new Compilation(
            GsSyntaxTree.Parse(SourceText.From(UserSource)),
            GsSyntaxTree.Parse(SourceText.From(generated.GSharpSource)),
            GsSyntaxTree.Parse(SourceText.From(UseSource)))
        {
            IsLibrary = true,
        };

        var errors = combined.GlobalScope.Diagnostics
            .Concat(combined.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();

        Assert.False(
            errors.Any(e => e.Message.IndexOf("Greeting", StringComparison.Ordinal) >= 0),
            "Generated member 'Greeting' was not visible to the G# compilation:\n"
                + generated.GSharpSource + "\n"
                + string.Join("\n", errors.Select(e => e.Message)));
    }

    [Fact]
    public void ThrowingGenerator_IsCrashIsolated_AndRecordedAsFailure()
    {
        Compilation gs = BuildGs(@"
package App

@Obsolete
partial class Foo {
}
");

        GeneratorHostResult result = GeneratorHostRunner.Run(
            gs,
            References,
            new IIncrementalGenerator[] { new ThrowingGenerator(), new GreetingGenerator() });

        // The throwing generator did not abort the run...
        Assert.NotEmpty(result.Failures);

        // ...and the well-behaved generator's output still came through.
        Assert.Single(result.GeneratedGsFiles);
    }

    private static Compilation BuildGs(string gsSource)
    {
        return new Compilation(GsSyntaxTree.Parse(SourceText.From(gsSource)));
    }

    /// <summary>
    /// An in-test incremental generator that mimics an attribute-driven
    /// generator: for each class marked with <c>[Obsolete]</c> (used purely as a
    /// convenient BCL marker so no custom attribute assembly is needed), it emits
    /// a <c>partial</c> augmentation carrying a <c>Greeting</c> property.
    /// </summary>
    private sealed class GreetingGenerator : IIncrementalGenerator
    {
        public void Initialize(IncrementalGeneratorInitializationContext context)
        {
            var classes = context.SyntaxProvider.ForAttributeWithMetadataName(
                "System.ObsoleteAttribute",
                predicate: static (node, _) => node is ClassDeclarationSyntax,
                transform: static (ctx, _) => (INamedTypeSymbol)ctx.TargetSymbol);

            context.RegisterSourceOutput(classes, static (spc, symbol) =>
            {
                string ns = symbol.ContainingNamespace is { IsGlobalNamespace: false } n
                    ? n.ToDisplayString()
                    : null;
                string name = symbol.Name;

                var sb = new StringBuilder();
                sb.AppendLine("#nullable enable");
                if (ns != null)
                {
                    sb.Append("namespace ").AppendLine(ns);
                    sb.AppendLine("{");
                }

                sb.Append("    partial class ").AppendLine(name);
                sb.AppendLine("    {");
                sb.Append("        public string Greeting => \"hi from \" + nameof(").Append(name).AppendLine(");");
                sb.AppendLine("    }");
                if (ns != null)
                {
                    sb.AppendLine("}");
                }

                spc.AddSource(name + ".g.cs", sb.ToString());
            });
        }
    }

    /// <summary>An in-test generator that always throws, to exercise crash isolation.</summary>
    private sealed class ThrowingGenerator : IIncrementalGenerator
    {
        public void Initialize(IncrementalGeneratorInitializationContext context)
        {
            context.RegisterSourceOutput(
                context.CompilationProvider,
                static (spc, _) => throw new InvalidOperationException("boom from ThrowingGenerator"));
        }
    }
}

