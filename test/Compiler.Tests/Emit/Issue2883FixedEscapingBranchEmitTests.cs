// <copyright file="Issue2883FixedEscapingBranchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2883: escaping branches inside <c>fixed</c> bodies must remain
/// visible to definite-return analysis without changing fixed emission.
/// </summary>
public class Issue2883FixedEscapingBranchEmitTests
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
    public void BreakOutOfFixed_WithReturnAfterLoop_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2883.BreakReturn

            func F(xs []int32) int32 {
                unsafe {
                    for {
                        fixed p *int32 = xs {
                            break
                        }
                    }
                }
                return 7
            }

            public var result = F([]int32{1})
            """;

        var assembly = CompileAndRun(Source);

        Assert.Equal(7, GetField(assembly, "result"));
    }

    [Fact]
    public void BreakOutOfNestedFixed_WithReturnAfterLoop_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2883.NestedBreakReturn

            func F(xs []int32) int32 {
                unsafe {
                    for {
                        fixed p *int32 = xs {
                            fixed q *int32 = xs {
                                break
                            }
                        }
                    }
                }
                return 8
            }

            public var result = F([]int32{1})
            """;

        var assembly = CompileAndRun(Source);

        Assert.Equal(8, GetField(assembly, "result"));
    }

    [Fact]
    public void ContinueOutOfFixed_SkipsFollowingReturnAndRuns()
    {
        const string Source = """
            package Issue2883.ContinueReturn

            func F(xs []int32) int32 {
                unsafe {
                    for var i = 0; i < 2; i++ {
                        fixed p *int32 = xs {
                            continue
                        }
                        return -1
                    }
                }
                return 9
            }

            public var result = F([]int32{1})
            """;

        var assembly = CompileAndRun(Source);

        Assert.Equal(9, GetField(assembly, "result"));
    }

    [Fact]
    public void GotoOutOfFixed_ToReturningLabel_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2883.GotoReturn

            func F(xs []int32) int32 {
                unsafe {
                    fixed p *int32 = xs {
                        goto done
                    }
                }
                return -1
            done:
                return 10
            }

            public var result = F([]int32{1})
            """;

        var assembly = CompileAndRun(Source);

        Assert.Equal(10, GetField(assembly, "result"));
    }

    [Fact]
    public void BreakOutOfScope_WithReturnAfterLoop_VerifiesAndRuns()
    {
        const string Source = """
            package Issue2883.ScopeBreakReturn

            func F() int32 {
                for {
                    scope {
                        break
                    }
                }
                return 11
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(Source, fixedBody: false);

        Assert.Equal(11, GetField(assembly, "result"));
    }

    private static Assembly CompileAndRun(string source, bool fixedBody = true)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var assemblyPath = Path.Combine(
            Directory.GetCurrentDirectory(),
            $"Issue2883_{Guid.NewGuid():N}.dll");
        try
        {
            File.WriteAllBytes(assemblyPath, peStream.ToArray());
            IlVerifier.Verify(
                assemblyPath,
                additionalReferences: null,
                ignoredErrorCodes: fixedBody ? FixedIlVerifyIgnored : null);
        }
        finally
        {
            File.Delete(assemblyPath);
        }

        var assembly = Assembly.Load(peStream.ToArray());
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
