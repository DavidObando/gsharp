// <copyright file="ManagedReferenceInitializationPlanReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Gsharp.Concurrency;
using Gsharp.Values;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceInitializationPlanReviewTests
{
    private const string GoSource = """
        package PlannedConstructorGo
        import System
        class Primary {
            var Result chan[int32] = {
                var value = 1
                let saved = managed(value)
                let result = chan[int32](1)
                go func () { result <- *saved }()
                result
            }
        }
        class Explicit {
            var Result chan[int32] = chan[int32](1)
            init() {
                var value = 2
                let saved = managed(value)
                go func () { Result <- *saved }()
            }
        }
        class Convenience {
            var Result chan[int32] = chan[int32](1)
            init(marker int32) { }
            convenience init() {
                init(0)
                var value = 3
                let saved = managed(value)
                go func () { Result <- *saved }()
            }
        }
        class Probe {
            shared {
                func Run() int32 {
                    let primary = Primary()
                    let explicit = Explicit()
                    let convenience = Convenience()
                    return <-primary.Result + <-explicit.Result + <-convenience.Result
                }
            }
        }
        """;

    private const string LambdaSource = """
        package MixedConstructorInitializers
        class Holder {
            var Reader () -> int32 = func () int32 { return 40 }
            init(marker int32) { }
            convenience init() {
                init(0)
                var value = 1
                let saved = managed(value)
            }
            shared {
                var StaticReader () -> int32 = func () int32 { return 2 }
            }
        }
        class Probe {
            shared {
                func Run() int32 { return Holder(1).Reader() + Holder.StaticReader() }
            }
        }
        """;

    [Fact]
    public void PlannedPrimaryExplicitAndConvenienceConstructorsDiscoverGoStatements()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            GoSource + "\nfunc Main() { Console.WriteLine(Probe.Run()) }\n",
            "PlannedConstructorGo",
            executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("6\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(GoSource, 0, false)]
    [InlineData(LambdaSource, 42, true)]
    public void InitializationPlansRemainCompleteAcrossRepeatedEmitAndRefout(string source, int expected, bool execute)
    {
        using var references = ReferenceResolver.WithRuntimeReferences(new[]
        {
            typeof(ManagedRef<>).Assembly.Location,
            typeof(Chan<>).Assembly.Location,
        });
        var compilation = new Compilation(references, SyntaxTree.Parse(source)) { IsLibrary = true };
        Assert.Empty(compilation.BoundProgram.Diagnostics);
        foreach (var refout in new[] { false, true })
        {
            using var pe = new MemoryStream();
            using var reference = new MemoryStream();
            var result = compilation.Emit(pe, null, refout ? reference : null);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            if (execute)
            {
                var assembly = EmittedFixture.Load(pe.ToArray());
                Assert.Equal(expected, assembly.GetType("MixedConstructorInitializers.Probe")!.GetMethod("Run")!.Invoke(null, null));
            }

            if (refout)
            {
                Assert.True(reference.Length > 0);
            }
        }
    }
}
