// <copyright file="Issue2883FixedEscapingBranchEmitTests.cs" company="GSharp">
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

/// Issue #2883: escaping branches inside `fixed` bodies must remain
/// visible to definite-return analysis without changing fixed emission. The
/// negative test is the load-bearing regression; runtime tests guard against
/// projection over-fire and emission changes.
open class Issue2883FixedEscapingBranchEmitTests {
    @Fact
    func BreakOutOfFixed_WithoutReturn_ReportsGs0100AndEmitsNothing() {
        const Source = `package Issue2883.Break

func F(xs []int32) int32 {
    unsafe {
        for {
            fixed p *int32 = xs {
                break
            }
        }
    }
}`
        using let peStream = MemoryStream()
        let result = Compile(Source, peStream)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.False(result.Success)
        Assert.Equal("GS0100", diagnostic.Id)
        Assert.Equal(int64(0), peStream.Length)
    }

    @Fact
    func BreakOutOfFixed_WithReturnAfterLoop_VerifiesAndRuns() {
        const Source = `package Issue2883.BreakReturn

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

public var result = F([]int32{1})`
        let assembly = CompileAndRun(Source)
        Assert.Equal(7, GetField(assembly, "result"))
    }

    @Fact
    func BreakOutOfNestedFixed_WithReturnAfterLoop_VerifiesAndRuns() {
        const Source = `package Issue2883.NestedBreakReturn

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

public var result = F([]int32{1})`
        let assembly = CompileAndRun(Source)
        Assert.Equal(8, GetField(assembly, "result"))
    }

    @Fact
    func ContinueOutOfFixed_SkipsFollowingReturnAndRuns() {
        const Source = `package Issue2883.ContinueReturn

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

public var result = F([]int32{1})`
        let assembly = CompileAndRun(Source)
        Assert.Equal(9, GetField(assembly, "result"))
    }

    @Fact
    func GotoOutOfFixed_ToReturningLabel_VerifiesAndRuns() {
        const Source = `package Issue2883.GotoReturn

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

public var result = F([]int32{1})`
        let assembly = CompileAndRun(Source)
        Assert.Equal(10, GetField(assembly, "result"))
    }

    @Fact
    func BreakOutOfScope_WithReturnAfterLoop_VerifiesAndRuns() {
        const Source = `package Issue2883.ScopeBreakReturn

func F() int32 {
    for {
        scope {
            break
        }
    }
    return 11
}

public var result = F()`
        let assembly = CompileAndRun(Source, fixedBody: false)
        Assert.Equal(11, GetField(assembly, "result"))
    }

    shared {
        private func CompileAndRun(source string, fixedBody bool = true) Assembly {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            let assemblyPath = Path.Combine(Directory.GetCurrentDirectory(), "Issue2883_${Guid.NewGuid():N}.dll")
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
