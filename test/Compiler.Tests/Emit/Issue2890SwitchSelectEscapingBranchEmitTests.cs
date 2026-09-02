// <copyright file="Issue2890SwitchSelectEscapingBranchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2890: arm-aware definite-return projection must reject escaping
/// switch/select branches without changing switch/select emission.
/// </summary>
public class Issue2890SwitchSelectEscapingBranchEmitTests
{
    [Fact]
    public void BreakOutOfPatternSwitchArm_ReportsGs0100AndEmitsNothing()
    {
        const string Source = """
            package Issue2890.EmitSwitchBreak

            func F(x int32) int32 {
                outer: for {
                    switch x {
                        default { break outer }
                    }
                }
            }
            """;

        AssertOnlyGs0100AndNoEmission(Source);
    }

    [Fact]
    public void BreakOutOfSelectArm_ReportsGs0100AndEmitsNothing()
    {
        const string Source = """
            package Issue2890.EmitSelectBreak
            import Gsharp.Extensions.Go

            func F() int32 {
                outer: for {
                    select {
                        default { break outer }
                    }
                }
            }
            """;

        AssertOnlyGs0100AndNoEmission(Source);
    }

    [Fact]
    public void SelectWhoseEveryArmReturns_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2890.EmitSelectReturns
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                select {
                    case ch <- 1 { return 11 }
                    case <-ch { return 12 }
                    default { return 13 }
                }
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(11, GetField(assembly, "result"));
    }

    [Fact]
    public void TotalDiscardSwitchWhoseArmReturns_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2890.EmitDiscardReturns

            func F(x int32) int32 {
                switch x {
                    case _ { return x + 1 }
                }
            }

            public var result = F(7)
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(8, GetField(assembly, "result"));
    }

    [Fact]
    public void SelectWithoutDefaultWhoseEveryArmReturns_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2890.EmitSelectNoDefaultReturns
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                ch <- 12
                select {
                    case ch <- 1 { return 11 }
                    case let value = <-ch { return value }
                }
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(12, GetField(assembly, "result"));
    }

    [Fact]
    public void SelectWhoseEveryArmThrows_VerifiesLoadsAndThrows()
    {
        const string Source = """
            package Issue2890.EmitSelectThrows
            import System
            import Gsharp.Extensions.Go

            func F() int32 {
                let ch = make(chan int32, 1)
                select {
                    case ch <- 1 { throw Exception("send") }
                    case <-ch { throw Exception("receive") }
                    default { throw Exception("default") }
                }
            }

            public var result = F()
            """;

        var exception = Assert.Throws<TargetInvocationException>(() => CompileAndRun(Source));
        Assert.IsType<Exception>(exception.InnerException);
    }

    [Fact]
    public void SwitchArmContainingReturningSelect_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2890.EmitSwitchSelectReturns
            import Gsharp.Extensions.Go

            func F(x int32) int32 {
                let ch = make(chan int32, 1)
                switch x {
                    case 1 {
                        select {
                            case ch <- 1 { return 1 }
                            default { return 2 }
                        }
                    }
                    default { return 3 }
                }
            }

            public var result = F(1)
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(1, GetField(assembly, "result"));
    }

    [Fact]
    public void PatternSwitchWhoseEveryArmReturns_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2890.EmitSwitchReturnsGuard

            func F(x int32) int32 {
                switch x {
                    case 1 { return 1 }
                    default { return 2 }
                }
            }

            public var result = F(2)
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(2, GetField(assembly, "result"));
    }

    [Fact]
    public void CompletingSwitchArmFollowedByReturn_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2890.EmitSwitchThenReturnGuard

            func F(x int32) int32 {
                switch x {
                    case 1 { }
                    default { return 1 }
                }

                return 2
            }

            public var result = F(1) + F(0)
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(3, GetField(assembly, "result"));
    }

    [Fact]
    public void TypePatternSwitchWhoseEveryArmReturns_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2890.EmitTypePatternGuard

            func F(value object) int32 {
                switch value {
                    case _ is string { return 1 }
                    default { return 2 }
                }
            }

            public var result = F("text") + F(7)
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(3, GetField(assembly, "result"));
    }

    private static void AssertOnlyGs0100AndNoEmission(string source)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        var diagnostic = Assert.Single(result.Diagnostics.Where(candidate => candidate.IsError));
        var expectedStart = source.IndexOf("F(", StringComparison.Ordinal);

        Assert.False(result.Success);
        Assert.Equal("GS0100", diagnostic.Id);
        Assert.Equal(expectedStart, diagnostic.Location.Span.Start);
        Assert.Equal(1, diagnostic.Location.Span.Length);
        Assert.Equal("F", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.Equal(0, peStream.Length);
    }

    private static Assembly CompileAndRun(string source)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var assemblyPath = Path.Combine(
            Directory.GetCurrentDirectory(),
            $"Issue2890_{Guid.NewGuid():N}.dll");
        try
        {
            File.WriteAllBytes(assemblyPath, peStream.ToArray());
            IlVerifier.Verify(assemblyPath);
        }
        finally
        {
            File.Delete(assemblyPath);
        }

        var assembly = EmittedFixture.Load(peStream.ToArray());
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return assembly;
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static int GetField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        return (int)program.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }
}
