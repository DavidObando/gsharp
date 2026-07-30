// <copyright file="Issue2906ExhaustiveSwitchReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2906: exhaustive closed-type switches without default arms must emit
/// a defensive no-match throw, verify, load, and execute their matched arms.
/// </summary>
public class Issue2906ExhaustiveSwitchReturnEmitTests
{
    /// <summary>Gets exhaustive switch programs and their expected result.</summary>
    public static IEnumerable<object[]> Cases()
    {
        yield return Case("OneMember", 1, """
            enum E { A }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                }
            }
            public var result = F(E.A)
            """);
        yield return Case("TwoMembers", 3, """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                }
            }
            public var result = F(E.A) + F(E.B)
            """);
        yield return Case("ManyMembers", 10, """
            enum E { A, B, C, D }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                    case E.C { return 3 }
                    case E.D { return 4 }
                }
            }
            public var result = F(E.A) + F(E.B) + F(E.C) + F(E.D)
            """);
        yield return Case("RedundantDefault", 2, """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                    default { return 3 }
                }
            }
            public var result = F(E.B)
            """);
        yield return Case("DuplicateCompleteArms", 4, """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.A { return 2 }
                    case E.B { return 3 }
                }
            }
            public var result = F(E.A) + F(E.B)
            """);
        yield return Case("OrPattern", 3, """
            enum E { A, B, C }
            func F(x E) int32 {
                switch x {
                    case E.A or E.B { return 1 }
                    case E.C { return 2 }
                }
            }
            public var result = F(E.B) + F(E.C)
            """);
        yield return Case("SealedInterface", 3, """
            sealed interface Expr { }
            class Add : Expr { }
            class Mul : Expr { }
            func F(x Expr) int32 {
                switch x {
                    case _ is Add { return 1 }
                    case _ is Mul { return 2 }
                }
            }
            public var result = F(Add()) + F(Mul())
            """);
        yield return Case("SealedClass", 3, """
            sealed class Shape { }
            class Circle : Shape { }
            class Square : Shape { }
            func F(x Shape) int32 {
                switch x {
                    case _ is Circle { return 1 }
                    case _ is Square { return 2 }
                }
            }
            public var result = F(Circle()) + F(Square())
            """);
        yield return Case("SwitchInsideTry", 2, """
            enum E { A, B }
            func F(x E) int32 {
                try {
                    switch x {
                        case E.A { return 1 }
                        case E.B { return 2 }
                    }
                } finally {
                }
            }
            public var result = F(E.B)
            """);
        yield return Case("TryInsideArms", 3, """
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A {
                        try {
                            return 1
                        } finally {
                        }
                    }
                    case E.B {
                        try {
                            return 2
                        } finally {
                        }
                    }
                }
            }
            public var result = F(E.A) + F(E.B)
            """);
        yield return Case("SwitchInsideSelect", 2, """
            import Gsharp.Extensions.Go
            enum E { A, B }
            func F(x E) int32 {
                select {
                    default {
                        switch x {
                            case E.A { return 1 }
                            case E.B { return 2 }
                        }
                    }
                }
            }
            public var result = F(E.B)
            """);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void ExhaustiveSwitch_VerifiesLoadsAndRuns(string name, int expected, string source)
    {
        var assembly = CompileVerifyLoadAndRun(name, source);
        Assert.Equal(expected, GetField(assembly, "result"));
    }

    [Fact]
    public void ExhaustiveEnum_UnnamedRuntimeValue_ThrowsDefensively()
    {
        const string Source = """
            package Issue2906.EmitUnnamed
            import System
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                }
            }
            public var result = 0
            try {
                F(E(99))
            } catch (ex InvalidOperationException) {
                result = 7
            }
            """;

        var assembly = CompileVerifyLoadAndRun("Unnamed", Source);
        Assert.Equal(7, GetField(assembly, "result"));
    }

    [Fact]
    public void ExhaustiveEnum_FollowedByCode_StillThrowsOnUnnamedValue()
    {
        const string Source = """
            package Issue2906.EmitUnnamedBeforeReturn
            import System
            enum E { A, B }
            func F(x E) int32 {
                switch x {
                    case E.A { return 1 }
                    case E.B { return 2 }
                }
                return 99
            }
            public var result = 0
            try {
                F(E(99))
            } catch (ex InvalidOperationException) {
                result = 7
            }
            """;

        var assembly = CompileVerifyLoadAndRun("UnnamedBeforeReturn", Source);
        Assert.Equal(7, GetField(assembly, "result"));
    }

    [Fact]
    public void CapturedArmState_PreservesExhaustiveEmitterMarker()
    {
        const string Source = """
            package Issue2906.EmitCaptured
            import System
            enum E { A, B }
            func F(x E) int32 {
                var value = 0
                let read = func() int32 { return value }
                switch x {
                    case E.A { value = 1 }
                    case E.B { value = 2 }
                }
                return read()
            }
            public var result = 0
            try {
                F(E(99))
            } catch (ex InvalidOperationException) {
                result = 7
            }
            """;

        var assembly = CompileVerifyLoadAndRun("Captured", Source);
        Assert.Equal(7, GetField(assembly, "result"));
    }

    private static object[] Case(string name, int expected, string body)
        => new object[] { name, expected, $"package Issue2906.Emit{name}{Environment.NewLine}{body}" };

    private static Assembly CompileVerifyLoadAndRun(string name, string source)
    {
        using var peStream = new MemoryStream();
        var result = new Compilation(SyntaxTree.Parse(SourceText.From(source))).Emit(peStream);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var bytes = peStream.ToArray();
        var assemblyPath = Path.Combine(Directory.GetCurrentDirectory(), $"Issue2906_{name}_{Guid.NewGuid():N}.dll");
        try
        {
            File.WriteAllBytes(assemblyPath, bytes);
            IlVerifier.Verify(assemblyPath);
        }
        finally
        {
            File.Delete(assemblyPath);
        }

        var assembly = Assembly.Load(bytes);
        var types = assembly.GetTypes();
        Assert.NotEmpty(types);
        var program = types.Single(type => type.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        var execution = Task.Run(
            () => entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() }));
        Assert.True(execution.Wait(TimeSpan.FromSeconds(10)), $"{name} execution timed out");
        return assembly;
    }

    private static int GetField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        return (int)program.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }
}
