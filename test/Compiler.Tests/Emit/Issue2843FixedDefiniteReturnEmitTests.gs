// <copyright file="Issue2843FixedDefiniteReturnEmitTests.cs" company="GSharp">
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

/// Issue #2843: a `fixed` body that returns on every path terminates the
/// enclosing control-flow path for GS0100 definite-return analysis.
open class Issue2843FixedDefiniteReturnEmitTests {
    @Fact
    func ReturnAsSoleExitInsideFixed_EmitsAndRuns() {
        const Source = `package Issue2843.SoleExit

func F(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            return xs.Length
        }
    }
}

public var result = F([]int32{1, 2, 3})`
        let assembly = CompileAndRun(Source, verifyIl: true)
        Assert.Equal(3, GetField(assembly, "result"))
    }

    @Fact
    func ReturnInsideNestedFixed_EmitsAndRuns() {
        const Source = `package Issue2843.Nested

func F(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            fixed q *int32 = xs {
                return xs.Length
            }
        }
    }
}

public var result = F([]int32{1, 2})`
        let assembly = CompileAndRun(Source, verifyIl: true)
        Assert.Equal(2, GetField(assembly, "result"))
    }

    @Fact
    func FixedInsideReturningIfElse_EmitsVerifiableControlFlowAndRuns() {
        const Source = `package Issue2843.IfElse

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
public var whenFalse = F([]int32{1}, false)`
        let assembly = CompileAndRun(Source, verifyIl: true)
        Assert.Equal(1, GetField(assembly, "whenTrue"))
        Assert.Equal(2, GetField(assembly, "whenFalse"))
    }

    @Fact
    func ThrowAsSoleExitInsideFixed_EmitsAndRuns() {
        const Source = `package Issue2843.Throw
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
}`
        let assembly = CompileAndRun(Source, verifyIl: true)
        Assert.Equal(1, GetField(assembly, "result"))
    }

    @Fact
    func DeadCodeAfterReturningFixed_EmitsAndRuns() {
        const Source = `package Issue2843.FixedDeadCode

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
public var whenFalse = F([]int32{1}, false)`
        let assembly = CompileAndRun(Source, verifyIl: true)
        Assert.Equal(1, GetField(assembly, "whenTrue"))
        Assert.Equal(2, GetField(assembly, "whenFalse"))
    }

    @Fact
    func DeadCodeAfterReturn_EmitsAndRuns() {
        const Source = `package Issue2843.PlainDeadCode

func F() int32 {
    return 1
    var unreachable = 3
}

public var result = F()`
        let assembly = CompileAndRun(Source, verifyIl: true)
        Assert.Equal(1, GetField(assembly, "result"))
    }

    @Fact
    func FixedBodyWithFallthroughPath_StillReportsGs0100() {
        const Source = `package Issue2843.Negative

func F(xs []int32, condition bool) int32 {
    unsafe {
        fixed p *int32 = xs {
            if condition {
                return xs.Length
            }
        }
    }
}`
        let result = Compile(Source)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0100")
    }

    shared {
        private let FixedIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType",
            "ExpectedNumericType"
        }

        private func Compile(source string, peStream MemoryStream? = nil) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream ?? MemoryStream())
        }

        private func CompileAndRun(source string, verifyIl bool = false) Assembly {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            if verifyIl {
                let assemblyPath = Path.Combine(Directory.GetCurrentDirectory(), "Issue2843_${Guid.NewGuid():N}.dll")
                try {
                    File.WriteAllBytes(assemblyPath, peStream.ToArray())
                    IlVerifier.Verify(assemblyPath, nil, FixedIlVerifyIgnored)
                } finally {
                    File.Delete(assemblyPath)
                }
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

        private func GetField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            return int32(program.GetField(name, BindingFlags.Public | BindingFlags.Static)!!.GetValue(nil)!!)
        }
    }
}
