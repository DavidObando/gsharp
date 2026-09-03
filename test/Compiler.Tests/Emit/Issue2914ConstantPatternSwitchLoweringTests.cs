// <copyright file="Issue2914ConstantPatternSwitchLoweringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2914: constant pattern switches fold during lowering. Asserts the
/// emitted program only; the interpreter parity arm was retired with the
/// evaluator in ADR-0156 Phase 3c (#3176).
/// </summary>
public class Issue2914ConstantPatternSwitchLoweringTests
{
    private const string ArtifactSource = """
        package Issue2914.Artifacts

        import System

        class Holder {
            shared {
                public var Value int32 = 2
            }
        }

        enum Choice { A, B }

        func ReadValue() int32 {
            calls = calls + 1
            return 2
        }

        func GuardAllows() bool {
            calls = calls + 1
            return false
        }

        func Constant() int32 {
            switch 1 {
                case 1 { return 11 }
                case 2 { return 22 }
                default { return 33 }
            }
        }

        func Mutable(value int32) int32 {
            switch value {
                case 1 { return 11 }
                case 2 { return 22 }
                default { return 33 }
            }
        }

        func ThroughCall() int32 {
            switch ReadValue() {
                case 1 { return 11 }
                case 2 { return 22 }
                default { return 33 }
            }
        }

        func SharedField() int32 {
            switch Holder.Value {
                case 1 { return 11 }
                case 2 { return 22 }
                default { return 33 }
            }
        }

        func Guarded() int32 {
            switch 1 {
                case 1 when (GuardAllows()) { return 11 }
                case 1 { return 22 }
                default { return 33 }
            }
        }

        func RecordArm(value int32) int32 {
            armTrace = armTrace + value
            return value
        }

        func ArmSideEffects() int32 {
            switch 1 {
                case 1 { return RecordArm(11) }
                case 2 { return RecordArm(22) }
                default { return RecordArm(33) }
            }
        }

        func NoMatchDefault() int32 {
            switch 9 {
                case 1 { return 11 }
                case 2 { return 22 }
                default { return 33 }
            }
        }

        func NoMatchWithoutDefault() int32 {
            switch 9 {
                case 1 { return 11 }
                case 2 { return 22 }
            }

            return 33
        }

        func ExhaustiveEnum() int32 {
            switch Choice.A {
                case Choice.A { return 11 }
                case Choice.B { return 22 }
            }
        }

        func RelationalPattern() int32 {
            switch 1 {
                case > 0 { return 11 }
                default { return 33 }
            }
        }

        func Float32NaN() int32 {
            switch Single.NaN {
                case Single.NaN { return 31 }
                default { return 32 }
            }
        }

        func Float64NaN() int32 {
            switch Double.NaN {
                case Double.NaN { return 41 }
                default { return 42 }
            }
        }

        var calls = 0
        var armTrace = 0
        public var constantResult = Constant()
        public var mutableResult = Mutable(2)
        public var callResult = ThroughCall()
        public var sharedResult = SharedField()
        public var guardedResult = Guarded()
        public var sideEffectResult = ArmSideEffects()
        public var noMatchResult = NoMatchDefault()
        public var noMatchWithoutDefaultResult = NoMatchWithoutDefault()
        public var exhaustiveResult = ExhaustiveEnum()
        public var relationalResult = RelationalPattern()
        public var float32NaNResult = Float32NaN()
        public var float64NaNResult = Float64NaN()
        public var callCount = calls
        public var armTraceResult = armTrace
        """;

    [Fact]
    public void LiteralSwitch_FoldsToSelectedArm_WhileNegativeControlsKeepDispatch()
    {
        var assembly = CompileAndRun(ArtifactSource);
        var program = GetProgram(assembly);

        Assert.Equal(11, GetField(program, "constantResult"));
        Assert.Equal(22, GetField(program, "mutableResult"));
        Assert.Equal(22, GetField(program, "callResult"));
        Assert.Equal(22, GetField(program, "sharedResult"));
        Assert.Equal(22, GetField(program, "guardedResult"));
        Assert.Equal(11, GetField(program, "sideEffectResult"));
        Assert.Equal(33, GetField(program, "noMatchResult"));
        Assert.Equal(33, GetField(program, "noMatchWithoutDefaultResult"));
        Assert.Equal(11, GetField(program, "exhaustiveResult"));
        Assert.Equal(11, GetField(program, "relationalResult"));
        Assert.Equal(32, GetField(program, "float32NaNResult"));
        Assert.Equal(42, GetField(program, "float64NaNResult"));
        Assert.Equal(2, GetField(program, "callCount"));
        Assert.Equal(11, GetField(program, "armTraceResult"));

        AssertMethodShape(program, "Constant", expectedBytes: 3, expectedBranches: 0);
        AssertMethodShape(program, "NoMatchDefault", expectedBytes: 3, expectedBranches: 0);
        AssertMethodShape(program, "NoMatchWithoutDefault", expectedBytes: 3, expectedBranches: 0);
        AssertMethodShape(program, "ExhaustiveEnum", expectedBytes: 3, expectedBranches: 0);
        AssertMethodShape(program, "Float32NaN", expectedBytes: 3, expectedBranches: 0);
        AssertMethodShape(program, "Float64NaN", expectedBytes: 3, expectedBranches: 0);
        Assert.Equal(0, GetMethodBranches(program, "ArmSideEffects"));

        AssertMethodShape(program, "Mutable", expectedBytes: 50, expectedBranches: 4);
        AssertMethodShape(program, "ThroughCall", expectedBytes: 54, expectedBranches: 4);
        AssertMethodShape(program, "SharedField", expectedBytes: 54, expectedBranches: 4);
        AssertMethodShape(program, "Guarded", expectedBytes: 60, expectedBranches: 5);
        Assert.Equal(2, GetMethodBranches(program, "RelationalPattern"));
    }

    [Fact]
    public void IssueRepro_CompilesRunsAndHasNoDispatch()
    {
        const string Source = """
            package Issue2914.Repro

            func F() int32 {
                switch 1 {
                    case 1 { return 10 }
                    case 2 { return 20 }
                }
            }

            public var result = F()
            """;

        var assembly = CompileAndRun(Source);
        var program = GetProgram(assembly);

        Assert.Equal(10, GetField(program, "result"));
        AssertMethodShape(program, "F", expectedBytes: 3, expectedBranches: 0);
    }

    [Fact]
    public void TopLevelAndFunctionSwitches_FoldAcrossDriverPositions()
    {
        const string Source = """
            package Issue2914.DriverPositions

            func F() int32 {
                switch 2 {
                    case 1 { return 11 }
                    case 2 { return 22 }
                    case 3 { return 33 }
                }
            }

            public var topResult = 0
            switch 1 {
                case 1 { topResult = 11 }
                case 2 { topResult = 22 }
                default { topResult = 33 }
            }
            public var functionResult = F()
            topResult + functionResult
            """;

        var assembly = CompileAndRun(Source);
        var program = GetProgram(assembly);
        Assert.Equal(11, GetField(program, "topResult"));
        Assert.Equal(22, GetField(program, "functionResult"));
        Assert.Equal(0, GetMethodBranches(program, "<Main>$"));
        Assert.Equal(0, GetMethodBranches(program, "F"));
    }

    [Fact]
    public void LambdaAndGenericLocalFunction_UseTheirIndependentLoweringPaths()
    {
        const string Source = """
            package Issue2914.LocalFunctions

            func Run() int32 {
                let Lambda = func () int32 {
                    switch 1 {
                        case 1 { return 11 }
                        case 2 { return 12 }
                    }
                }
                let Generic[T] = func (value T) int32 {
                    switch 2 {
                        case 1 { return 21 }
                        case 2 { return 22 }
                    }
                }
                return Lambda() + Generic(0)
            }

            public var result = Run()
            result
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(33, GetField(GetProgram(assembly), "result"));
    }

    [Fact]
    public void MutableCapture_RemainsRuntimeDispatched()
    {
        const string Source = """
            package Issue2914.MutableCapture

            func Run() int32 {
                var value = 1
                let Read = func () int32 {
                    switch value {
                        case 1 { return 11 }
                        case 2 { return 22 }
                        default { return 33 }
                    }
                }
                value = 2
                return Read()
            }

            public var result = Run()
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(22, GetField(GetProgram(assembly), "result"));
        var invoke = assembly.GetTypes()
            .Single(type => type.Name.StartsWith("<closure_", StringComparison.Ordinal))
            .GetMethod("Invoke", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!;
        var il = invoke.GetMethodBody()!.GetILAsByteArray()!;
        Assert.Equal(60, il.Length);
        Assert.Equal(4, CountBranches(il));
    }

    [Fact]
    public void NoMatchingArmWithoutDefault_StillReportsGs0100()
    {
        const string Source = """
            package Issue2914.NoMatch

            func F() int32 {
                switch 9 {
                    case 1 { return 11 }
                    case 2 { return 22 }
                }
            }
            """;

        var (result, emittedLength) = Compile(Source);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0100");
        Assert.Equal(0, emittedLength);
    }

    [Fact]
    public void BindingDiagnostics_RemainUnchangedBeforeLowering()
    {
        const string NonExhaustiveEnum = """
            package Issue2914.Diagnostics.Exhaustiveness

            enum Choice { A, B }

            func F() {
                switch Choice.A {
                    case Choice.A { }
                }
            }
            """;
        const string IncompatibleCase = """
            package Issue2914.Diagnostics.CaseType

            func F() {
                switch 1 {
                    case "one" { }
                }
            }
            """;

        var (exhaustivenessResult, exhaustivenessLength) = Compile(NonExhaustiveEnum);
        var (caseResult, caseLength) = Compile(IncompatibleCase);

        Assert.Contains(exhaustivenessResult.Diagnostics, diagnostic => diagnostic.Id == "GS0178");
        Assert.Contains(caseResult.Diagnostics, diagnostic => diagnostic.Id == "GS0171");
        Assert.Equal(0, exhaustivenessLength);
        Assert.Equal(0, caseLength);
    }

    private static Assembly CompileAndRun(string source)
    {
        using var peStream = new MemoryStream();
        var result = CreateCompilation(source).Emit(peStream);
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var bytes = peStream.ToArray();
        var assemblyPath = Path.Combine(Directory.GetCurrentDirectory(), $"Issue2914_{Guid.NewGuid():N}.dll");
        try
        {
            File.WriteAllBytes(assemblyPath, bytes);
            IlVerifier.Verify(assemblyPath);
        }
        finally
        {
            File.Delete(assemblyPath);
        }

        var assembly = EmittedFixture.Load(bytes);
        _ = assembly.GetTypes();
        var program = GetProgram(assembly);
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return assembly;
    }

    private static (EmitResult Result, long EmittedLength) Compile(string source)
    {
        using var peStream = new MemoryStream();
        var result = CreateCompilation(source).Emit(peStream);
        return (result, peStream.Length);
    }

    private static Compilation CreateCompilation(string source)
        => new(SyntaxTree.Parse(SourceText.From(source)));

    private static Type GetProgram(Assembly assembly)
        => assembly.GetTypes().Single(type => type.Name == "<Program>");

    private static int GetField(Type program, string name)
        => (int)program.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;

    private static void AssertMethodShape(Type program, string name, int expectedBytes, int expectedBranches)
    {
        var method = program.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        var il = method.GetMethodBody()!.GetILAsByteArray()!;
        Assert.Equal(expectedBytes, il.Length);
        Assert.Equal(expectedBranches, CountBranches(il));
    }

    private static int GetMethodBranches(Type program, string name)
    {
        var method = program.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        return CountBranches(method.GetMethodBody()!.GetILAsByteArray()!);
    }

    private static int CountBranches(byte[] il)
        => IlInstructionReader.Read(il).Count(instruction =>
            instruction.OpCode.FlowControl is FlowControl.Branch or FlowControl.Cond_Branch);
}
