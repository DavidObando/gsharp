// <copyright file="Issue2843FixedDefiniteReturnEmitTests.cs" company="GSharp">
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
/// Issue #2843: a <c>fixed</c> body that returns on every path terminates the
/// enclosing control-flow path for GS0100 definite-return analysis.
/// </summary>
public class Issue2843FixedDefiniteReturnEmitTests
{
    private static readonly string[] FixedIlVerifyIgnored =
    {
        "Unverifiable",
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
        "ExpectedNumericType",
    };

    [Fact]
    public void ReturnAsSoleExitInsideFixed_EmitsAndRuns()
    {
        const string Source = """
            package Issue2843.SoleExit

            func F(xs []int32) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        return xs.Length
                    }
                }
            }

            public var result = F([]int32{1, 2, 3})
            """;

        var assembly = CompileAndRun(Source, verifyIl: true);

        Assert.Equal(3, GetField(assembly, "result"));
    }

    [Fact]
    public void ReturnInsideNestedFixed_EmitsAndRuns()
    {
        const string Source = """
            package Issue2843.Nested

            func F(xs []int32) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        fixed q *int32 = xs {
                            return xs.Length
                        }
                    }
                }
            }

            public var result = F([]int32{1, 2})
            """;

        var assembly = CompileAndRun(Source, verifyIl: true);

        Assert.Equal(2, GetField(assembly, "result"));
    }

    [Fact]
    public void FixedInsideReturningIfElse_EmitsVerifiableControlFlowAndRuns()
    {
        const string Source = """
            package Issue2843.IfElse

            func F(xs []int32, condition bool) int32 {
                unsafe {
                    if condition {
                        fixed p *int32 = xs {
                            return 1
                        }
                    } else {
                        fixed p *int32 = xs {
                            return 2
                        }
                    }
                }
            }

            public var whenTrue = F([]int32{1}, true)
            public var whenFalse = F([]int32{1}, false)
            """;

        var assembly = CompileAndRun(Source, verifyIl: true);

        Assert.Equal(1, GetField(assembly, "whenTrue"));
        Assert.Equal(2, GetField(assembly, "whenFalse"));
    }

    [Fact]
    public void ThrowAsSoleExitInsideFixed_EmitsAndRuns()
    {
        const string Source = """
            package Issue2843.Throw
            import System

            func F(xs []int32) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        throw InvalidOperationException("boom")
                    }
                }
            }

            public var result = 0
            try {
                F([]int32{1})
            } catch (ex InvalidOperationException) {
                result = 1
            }
            """;

        var assembly = CompileAndRun(Source, verifyIl: true);

        Assert.Equal(1, GetField(assembly, "result"));
    }

    [Fact]
    public void DeadCodeAfterReturningFixed_EmitsAndRuns()
    {
        const string Source = """
            package Issue2843.FixedDeadCode

            func F(xs []int32, condition bool) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        if condition {
                            return 1
                        }
                        return 2
                    }
                }
                var unreachable = 3
            }

            public var whenTrue = F([]int32{1}, true)
            public var whenFalse = F([]int32{1}, false)
            """;

        var assembly = CompileAndRun(Source, verifyIl: true);

        Assert.Equal(1, GetField(assembly, "whenTrue"));
        Assert.Equal(2, GetField(assembly, "whenFalse"));
    }

    [Fact]
    public void DeadCodeAfterReturn_EmitsAndRuns()
    {
        const string Source = """
            package Issue2843.PlainDeadCode

            func F() int32 {
                return 1
                var unreachable = 3
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(Source, verifyIl: true);

        Assert.Equal(1, GetField(assembly, "result"));
    }

    [Fact]
    public void FixedBodyWithFallthroughPath_StillReportsGs0100()
    {
        const string Source = """
            package Issue2843.Negative

            func F(xs []int32, condition bool) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        if condition {
                            return xs.Length
                        }
                    }
                }
            }
            """;

        var result = Compile(Source);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0100");
    }

    private static EmitResult Compile(string source, MemoryStream peStream = null)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream ?? new MemoryStream());
    }

    private static Assembly CompileAndRun(string source, bool verifyIl = false)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);

        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        if (verifyIl)
        {
            var assemblyPath = Path.Combine(
                Directory.GetCurrentDirectory(),
                $"Issue2843_{Guid.NewGuid():N}.dll");
            try
            {
                File.WriteAllBytes(assemblyPath, peStream.ToArray());
                IlVerifier.Verify(assemblyPath, null, FixedIlVerifyIgnored);
            }
            finally
            {
                File.Delete(assemblyPath);
            }
        }

        var assembly = EmittedFixture.Load(peStream.ToArray());
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return assembly;
    }

    private static int GetField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        return (int)program.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }
}
