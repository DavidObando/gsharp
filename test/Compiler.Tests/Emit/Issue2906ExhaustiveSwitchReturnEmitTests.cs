// <copyright file="Issue2906ExhaustiveSwitchReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2906: exhaustive closed-type switches can satisfy definite return,
/// while ordinary switch statements retain unmatched-value fallthrough.
/// Asserts the emitted program only; the interpreter parity arm was retired
/// with the evaluator in ADR-0156 Phase 3c (#3176).
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

    /// <summary>Gets exhaustive switch statements whose unmatched runtime value must fall through.</summary>
    public static IEnumerable<object[]> FallthroughCases()
    {
        yield return Case("ReturnAfterSwitch", 99, """
            import System
            func F(x DateTimeKind) int32 {
                switch x {
                    case DateTimeKind.Unspecified { return 1 }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
                return 99
            }
            public var result = F(DateTimeKind(99))
            result
            """);
        yield return Case("NonTerminalArms", 0, """
            import System
            func F(x DateTimeKind) int32 {
                var value = 0
                switch x {
                    case DateTimeKind.Unspecified { value = 1 }
                    case DateTimeKind.Utc { value = 2 }
                    case DateTimeKind.Local { value = 3 }
                }
                return value
            }
            public var result = F(DateTimeKind(99))
            result
            """);
        yield return Case("VoidFunctionContinues", 7, """
            import System
            func F(x DateTimeKind, out value int32) {
                switch x {
                    case DateTimeKind.Unspecified { value = 1 }
                    case DateTimeKind.Utc { value = 2 }
                    case DateTimeKind.Local { value = 3 }
                }
                value = 7
            }
            var result int32
            F(DateTimeKind(99), &result)
            result
            """);
        yield return Case("CapturedArmState", 0, """
            import System
            func F(x DateTimeKind) int32 {
                var value = 0
                let read = func() int32 { return value }
                switch x {
                    case DateTimeKind.Unspecified { value = 1 }
                    case DateTimeKind.Utc { value = 2 }
                    case DateTimeKind.Local { value = 3 }
                }
                return read()
            }
            public var result = F(DateTimeKind(99))
            result
            """);
        yield return Case("SealedInterfaceNil", 0, """
            sealed interface Expr { }
            class Literal : Expr { }
            func F(x Expr) int32 {
                switch x {
                    case _ is Literal { return 1 }
                }
                return 0
            }
            public var result = F(nil)
            result
            """);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void ExhaustiveSwitch_VerifiesLoadsAndRuns(string name, int expected, string source)
    {
        var assembly = CompileVerifyLoadAndRun(name, source);
        Assert.Equal(expected, GetField(assembly, "result"));
    }

    [Theory]
    [MemberData(nameof(FallthroughCases))]
    public void ExhaustiveSwitchStatement_UnmatchedValueFallsThrough(
        string name,
        int expected,
        string source)
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
                result = ex.Message == "__NON_VOID_FALLTHROUGH_GUARD__"
                    ? 7
                    : -1
            }
            """;

        var assembly = CompileVerifyLoadAndRun("Unnamed", WithGuardMessage(Source));
        Assert.Equal(7, GetField(assembly, "result"));
    }

    [Fact]
    public void ExhaustiveEnum_UnnamedValueWithFixedReturn_ThrowsDefensively()
    {
        const string Source = """
            package Issue2906.EmitUnnamedFixed
            import System
            func F(x DateTimeKind, values []int32) int32 {
                switch x {
                    case DateTimeKind.Unspecified {
                        unsafe {
                            fixed p *int32 = values {
                                return *p
                            }
                        }
                    }
                    case DateTimeKind.Utc { return 2 }
                    case DateTimeKind.Local { return 3 }
                }
            }
            public var result = 0
            try {
                F(DateTimeKind(99), []int32{7})
            } catch (ex InvalidOperationException) {
                result = ex.Message == "__NON_VOID_FALLTHROUGH_GUARD__"
                    ? 7
                    : -1
            }
            """;

        var assembly = CompileVerifyLoadAndRun(
            "UnnamedFixed",
            WithGuardMessage(Source),
            ignoredVerificationErrors: new[] { "UnmanagedPointer", "StackByRef" },
            ignoredVerificationScope: @"<Program>\.F$");
        Assert.Equal(7, GetField(assembly, "result"));
    }

    private static object[] Case(string name, int expected, string body)
        => new object[] { name, expected, $"package Issue2906.Emit{name}{Environment.NewLine}{body}" };

    private static string WithGuardMessage(string source)
        => source.Replace(
            "__NON_VOID_FALLTHROUGH_GUARD__",
            DiagnosticDescriptors.NonVoidFallthroughGuardMessage,
            StringComparison.Ordinal);

    private static Assembly CompileVerifyLoadAndRun(
        string name,
        string source,
        IEnumerable<string> ignoredVerificationErrors = null,
        string ignoredVerificationScope = null)
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
            IlVerifier.Verify(
                assemblyPath,
                ignoredErrorCodes: ignoredVerificationErrors,
                ignoredErrorScope: ignoredVerificationScope);
        }
        finally
        {
            File.Delete(assemblyPath);
        }

        var assembly = EmittedFixture.Load(bytes);
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
