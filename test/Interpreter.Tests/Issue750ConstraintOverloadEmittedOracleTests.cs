// <copyright file="Issue750ConstraintOverloadEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #750: Emitted-oracle coverage for constraint overload.
/// Traceability: ADR-0088.
/// </summary>
public class Issue750ConstraintOverloadEmittedOracleTests
{
    [Fact]
    public void OrElse_DisjointConstraints_BindCorrectlyForBothReceiverShapes()
    {
        var source = """
            import System
            import Gsharp.Extensions.Optional

            let s string? = nil
            let n int32? = nil

            Console.WriteLine(s.OrElse("default"))
            Console.WriteLine(n.OrElse(99).ToString())
            """;

        Assert.Equal($"default{Environment.NewLine}99{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void OrElse_DisjointConstraints_PresentReceiver_ReturnsValue()
    {
        var source = """
            import System
            import Gsharp.Extensions.Optional

            let s string? = "ada"
            let n int32? = 7

            Console.WriteLine(s.OrElse("default"))
            Console.WriteLine(n.OrElse(99).ToString())
            """;

        Assert.Equal($"ada{Environment.NewLine}7{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void FirstOrNil_SequenceTerminals_BindBothClassAndStructOverloads()
    {
        var source = """
            import System
            import Gsharp.Extensions.Optional
            import Gsharp.Extensions.Sequences

            let names = Sequences.Of("alpha", "beta")
            let nums = Sequences.Of(11, 22, 33)

            Console.WriteLine(names.FirstOrNil() ?? "<none>")
            Console.WriteLine(nums.FirstOrNil().OrElse(-1).ToString())
            """;

        Assert.Equal($"alpha{Environment.NewLine}11{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void LastOrNil_AndSingleOrNil_SequenceTerminals_BindBothOverloads()
    {
        var source = """
            import System
            import Gsharp.Extensions.Optional
            import Gsharp.Extensions.Sequences

            let names = Sequences.Of("alpha", "beta")
            let nums = Sequences.Of(11, 22, 33)
            let solo = Sequences.Of(42)

            Console.WriteLine(names.LastOrNil() ?? "<none>")
            Console.WriteLine(nums.LastOrNil().OrElse(-1).ToString())
            Console.WriteLine(solo.SingleOrNil().OrElse(-1).ToString())
            """;

        Assert.Equal($"beta{Environment.NewLine}33{Environment.NewLine}42{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void FlatMap_NullableReturningLambdaWithIf_RunsInEmittedOracle()
    {
        // Issue #2995: the nullable-returning FlatMap lambda contains the
        // control flow that previously reached the evaluator unlowered.
        var source = """
            import System
            import Gsharp.Extensions.Optional

            let name string? = "ada"
            let first = name.FlatMap(func(s string) string? {
                if s.Length > 0 {
                    return s.Substring(0, 1)
                }
                return nil
            })

            Console.WriteLine(first ?? "<none>")
            """;

        Assert.Equal($"a{Environment.NewLine}", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        // The Compilation.Default reference resolver enumerates
        // AppDomain.CurrentDomain.GetAssemblies() and skips assemblies that
        // were never loaded by reflection. typeof(T) is enough on most
        // runtimes, but on .NET 10's lazy test host we additionally
        // Assembly.LoadFrom() the on-disk Gsharp.Extensions.dll so the
        // assembly is unambiguously present in the host AppDomain when
        // the binder collects candidates. After issue #806 the
        // OptionalExtensions / SequenceExtensions / SequenceValueExtensions
        // C# host classes were replaced by G#-authored top-level extension
        // funcs that emit into compiler-generated `<Program>` host
        // typedefs; only `Sequences` survives as a real named class.
        _ = typeof(Gsharp.Extensions.Sequences.Sequences);

        var extPath = LocateGsharpExtensionsAssembly();
        if (extPath != null)
        {
            try { System.Reflection.Assembly.LoadFrom(extPath); } catch { }
        }

        var result = EmittedOracle.Evaluate(source);

        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        Assert.True(
            errors.Count == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }

    private static string LocateGsharpExtensionsAssembly()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(Issue750ConstraintOverloadEmittedOracleTests).Assembly.Location));
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                foreach (var cfg in new[] { "Debug", "Release" })
                {
                    var candidate = Path.Combine(dir.FullName, "out", "bin", cfg, "Gsharp.Extensions", "Gsharp.Extensions.dll");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }

                return null;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
