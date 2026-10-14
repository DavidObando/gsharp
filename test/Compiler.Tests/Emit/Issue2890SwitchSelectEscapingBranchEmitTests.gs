// <copyright file="Issue2890SwitchSelectEscapingBranchEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis

/// Issue #2890: arm-aware definite-return projection must reject escaping
/// switch/select branches without changing switch/select emission.
open class Issue2890SwitchSelectEscapingBranchEmitTests {
    @Fact
    func BreakOutOfPatternSwitchArm_ReportsGs0100AndEmitsNothing() {
        const Source = `package Issue2890.EmitSwitchBreak

func F(x int32) int32 {
    outer: for {
        switch x {
            default { break outer }
        }
    }
}`
        AssertOnlyGs0100AndNoEmission(Source)
    }

    @Fact
    func BreakOutOfSelectArm_ReportsGs0100AndEmitsNothing() {
        const Source = `package Issue2890.EmitSelectBreak

func F() int32 {
    outer: for {
        select {
            default { break outer }
        }
    }
}`
        AssertOnlyGs0100AndNoEmission(Source)
    }

    @Fact
    func SelectWhoseEveryArmReturns_VerifiesAndRuns() {
        const Source = `package Issue2890.EmitSelectReturns

func F() int32 {
    let ch = chan[int32](1)
    select {
        case ch <- 1 { return 11 }
        case <-ch { return 12 }
        default { return 13 }
    }
}

public var result = F()`
        let assembly = CompileAndRun(Source)
        Assert.Equal(11, GetField(assembly, "result"))
    }

    @Fact
    func TotalDiscardSwitchWhoseArmReturns_VerifiesAndRuns() {
        const Source = `package Issue2890.EmitDiscardReturns

func F(x int32) int32 {
    switch x {
        case _ { return x + 1 }
    }
}

public var result = F(7)`
        let assembly = CompileAndRun(Source)
        Assert.Equal(8, GetField(assembly, "result"))
    }

    @Fact
    func SelectWithoutDefaultWhoseEveryArmReturns_VerifiesAndRuns() {
        const Source = `package Issue2890.EmitSelectNoDefaultReturns

func F() int32 {
    let ch = chan[int32](1)
    ch <- 12
    select {
        case ch <- 1 { return 11 }
        case let value = <-ch { return value }
    }
}

public var result = F()`
        let assembly = CompileAndRun(Source)
        Assert.Equal(12, GetField(assembly, "result"))
    }

    @Fact
    func SelectWhoseEveryArmThrows_VerifiesLoadsAndThrows() {
        const Source = `package Issue2890.EmitSelectThrows
import System

func F() int32 {
    let ch = chan[int32](1)
    select {
        case ch <- 1 { throw Exception("send") }
        case <-ch { throw Exception("receive") }
        default { throw Exception("default") }
    }
}

public var result = F()`
        let exception = Assert.Throws[TargetInvocationException](
            func () object? {
                return CompileAndRun(Source)
            }
        )
        Assert.IsType[Exception](exception.InnerException)
    }

    @Fact
    func SwitchArmContainingReturningSelect_VerifiesAndRuns() {
        const Source = `package Issue2890.EmitSwitchSelectReturns

func F(x int32) int32 {
    let ch = chan[int32](1)
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

public var result = F(1)`
        let assembly = CompileAndRun(Source)
        Assert.Equal(1, GetField(assembly, "result"))
    }

    @Fact
    func PatternSwitchWhoseEveryArmReturns_VerifiesAndRuns() {
        const Source = `package Issue2890.EmitSwitchReturnsGuard

func F(x int32) int32 {
    switch x {
        case 1 { return 1 }
        default { return 2 }
    }
}

public var result = F(2)`
        let assembly = CompileAndRun(Source)
        Assert.Equal(2, GetField(assembly, "result"))
    }

    @Fact
    func CompletingSwitchArmFollowedByReturn_VerifiesAndRuns() {
        const Source = `package Issue2890.EmitSwitchThenReturnGuard

func F(x int32) int32 {
    switch x {
        case 1 { }
        default { return 1 }
    }

    return 2
}

public var result = F(1) + F(0)`
        let assembly = CompileAndRun(Source)
        Assert.Equal(3, GetField(assembly, "result"))
    }

    @Fact
    func TypePatternSwitchWhoseEveryArmReturns_VerifiesAndRuns() {
        const Source = `package Issue2890.EmitTypePatternGuard

func F(value object) int32 {
    switch value {
        case _ is string { return 1 }
        default { return 2 }
    }
}

public var result = F("text") + F(7)`
        let assembly = CompileAndRun(Source)
        Assert.Equal(3, GetField(assembly, "result"))
    }

    shared {
        private func AssertOnlyGs0100AndNoEmission(source string) {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            let diagnostic = Assert.Single(result.Diagnostics.Where((candidate Diagnostic) -> candidate.IsError))
            let expectedStart = source.IndexOf("F(", StringComparison.Ordinal)
            Assert.False(result.Success)
            Assert.Equal("GS0100", diagnostic.Id)
            Assert.Equal(expectedStart, diagnostic.Location.Span.Start)
            Assert.Equal(1, diagnostic.Location.Span.Length)
            Assert.Equal("F", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
            Assert.Equal(int64(0), peStream.Length)
        }

        private func CompileAndRun(source string) Assembly {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            let assemblyPath = Path.Combine(Directory.GetCurrentDirectory(), "Issue2890_${Guid.NewGuid():N}.dll")
            try {
                File.WriteAllBytes(assemblyPath, peStream.ToArray())
                IlVerifier.Verify(assemblyPath)
            } finally {
                File.Delete(assemblyPath)
            }
            let assembly = EmittedFixture.Load(peStream.ToArray())
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return assembly
        }

        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func GetField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            return int32(program.GetField(name, BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!)
        }
    }
}
