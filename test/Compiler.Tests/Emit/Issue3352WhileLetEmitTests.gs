// <copyright file="Issue3352WhileLetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Emit/runtime coverage for issue #3352 / ADR-0163.
class Issue3352WhileLetEmitTests {
    @Fact
    func ConditionReevaluatesAndContinueAndBreakUseLoopTargets() {
        let assembly = CompileAndInvokeEntry(`package P

public var calls = 0
public var trace = ""

func Next() string? {
    calls = calls + 1
    if calls == 1 { return "skip" }
    if calls == 2 { return "keep" }
    if calls == 3 { return "stop" }
    return nil
}

while let value = Next() {
    if value == "skip" { continue }
    trace = trace + value
    if value == "stop" { break }
}`)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        Assert.Equal(3, ReadStatic[int32](program, "calls"))
        Assert.Equal("keepstop", ReadStatic[string](program, "trace"))
    }

    @Fact
    func NaturalTerminationPerformsFailingConditionEvaluation() {
        let assembly = CompileAndInvokeEntry(`package P

public var calls = 0
public var trace = ""

func Next() string? {
    calls = calls + 1
    if calls <= 2 { return calls.ToString() }
    return nil
}

while let value = Next() {
    trace = trace + value
}`)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        Assert.Equal(3, ReadStatic[int32](program, "calls"))
        Assert.Equal("12", ReadStatic[string](program, "trace"))
    }

    @Fact
    func MultipleBindingsReevaluateBeforeEachCombinedTest() {
        let assembly = CompileAndInvokeEntry(`package P

public var firstCalls = 0
public var secondCalls = 0
public var trace = ""

func First() string? {
    firstCalls = firstCalls + 1
    if firstCalls == 1 { return "A" }
    return nil
}

func Second() string? {
    secondCalls = secondCalls + 1
    return "B"
}

while let left = First(), let right = Second() {
    trace = trace + left + right
}`)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        Assert.Equal("AB", ReadStatic[string](program, "trace"))
        Assert.Equal(2, ReadStatic[int32](program, "firstCalls"))
        Assert.Equal(2, ReadStatic[int32](program, "secondCalls"))
    }

    @Fact
    func NestedBindingsShadowAndRestoreOuterBinding() {
        let assembly = CompileAndInvokeEntry(`package P

public var outerCalls = 0
public var innerCalls = 0
public var trace = ""

func NextOuter() string? {
    outerCalls = outerCalls + 1
    if outerCalls == 1 { return "A" }
    return nil
}

func NextInner() string? {
    innerCalls = innerCalls + 1
    if innerCalls <= 2 { return innerCalls.ToString() }
    return nil
}

while let value = NextOuter() {
    trace = trace + value
    while let value = NextInner() {
        trace = trace + value
    }
    trace = trace + value
}`)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        Assert.Equal("A12A", ReadStatic[string](program, "trace"))
        Assert.Equal(2, ReadStatic[int32](program, "outerCalls"))
        Assert.Equal(3, ReadStatic[int32](program, "innerCalls"))
    }

    @Fact
    func LabeledContinueAndBreakTargetOuterWhileLet() {
        let assembly = CompileAndInvokeEntry(`package P

public var outerCalls = 0
public var innerCalls = 0
public var trace = ""

func NextOuter() string? {
    outerCalls = outerCalls + 1
    if outerCalls == 1 { return "A" }
    if outerCalls == 2 { return "B" }
    return nil
}

func NextInner() string? {
    innerCalls = innerCalls + 1
    return "inner"
}

outer: while let outerValue = NextOuter() {
    trace = trace + outerValue
    while let innerValue = NextInner() {
        if outerValue == "A" { continue outer }
        break outer
    }
    trace = trace + "unreached"
}`)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        Assert.Equal("AB", ReadStatic[string](program, "trace"))
        Assert.Equal(2, ReadStatic[int32](program, "outerCalls"))
        Assert.Equal(2, ReadStatic[int32](program, "innerCalls"))
    }

    @Fact
    func AwaitedInitializerReevaluatesAcrossSuspensions() {
        let assembly = CompileAndInvokeEntry(`package P

import System.Threading.Tasks

public var calls = 0
public var trace = ""

func Next() string? {
    calls = calls + 1
    if calls <= 2 { return calls.ToString() }
    return nil
}

async func Run() string {
    var result = ""
    while let value = await Task.FromResult(Next()) {
        result = result + value
    }
    return result
}

trace = Run().Result`)
        let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        Assert.Equal(3, ReadStatic[int32](program, "calls"))
        Assert.Equal("12", ReadStatic[string](program, "trace"))
    }

    shared {
        private func ReadStatic[T](type Type, name string) T {
            let field FieldInfo? = type.GetField(
                name,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(field)
            return T(field!!.GetValue(nil)!!)
        }

        private func CompileAndInvokeEntry(source string) Assembly {
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3352-emit", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let sourcePath = Path.Combine(workDir, "test.gs")
                let outputPath = Path.Combine(workDir, "test.dll")
                File.WriteAllText(sourcePath, source)
                let args = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    sourcePath
                }
                let exitCode = Program.Main(args.ToArray())
                Assert.Equal(0, exitCode)
                IlVerifier.Verify(outputPath)
                let assembly = EmittedFixture.Load(outputPath)
                let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let entry MethodInfo? = program.GetMethod(
                    "<Main>$$",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                Assert.NotNull(entry)
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
                return assembly
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch { }
            }
        }
    }
}
