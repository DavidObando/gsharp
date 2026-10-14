// <copyright file="Issue836IteratorTryFinallyEmitTests.cs" company="GSharp">
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

/// Issue #836 — end-to-end emit + IL-verify coverage for iterator
/// state machines whose user body contains `try`/`finally`
/// around `yield`. Asserts both the runtime behaviour (full
/// enumeration runs the finally once, early-break runs the finally
/// during Dispose) and that the synthesized state machine passes
/// `dotnet-ilverify` on net10.0.
open class Issue836IteratorTryFinallyEmitTests {
    @Fact
    func Iterator_TryFinally_FullEnumeration_RunsFinallyOnce() {
        let source = `package Probe
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 10
        yield 20
    } finally {
        Console.WriteLine("dispose")
    }
}

public var sum = 0
public var disposeMarker = ""
for v in gen() {
    sum = sum + v
}
disposeMarker = "ok"`
        let assembly = CompileAndRun(source)
        Assert.Equal(30, GetIntField(assembly, "sum"))
        Assert.Equal("ok", GetStringField(assembly, "disposeMarker"))
    }

    @Fact
    func Iterator_TryFinally_EarlyBreak_RunsFinallyOnDispose() {
        let source = `package Probe
import System
import System.Collections.Generic

public var finallyRan = 0
public var seen = 0

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
        yield 3
    } finally {
        finallyRan = finallyRan + 1
    }
}

for v in gen() {
    seen = seen + 1
    if v == 1 {
        break
    }
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(1, GetIntField(assembly, "seen"))
        Assert.Equal(1, GetIntField(assembly, "finallyRan"))
    }

    @Fact
    func Iterator_NestedTryFinally_EarlyBreak_RunsInnerThenOuter() {
        let source = `package Probe
import System
import System.Collections.Generic

public var trace = ""

func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
            yield 2
        } finally {
            trace = trace + "I"
        }
    } finally {
        trace = trace + "O"
    }
}

for v in gen() {
    if v == 1 {
        break
    }
}`
        let assembly = CompileAndRun(source)
        Assert.Equal("IO", GetStringField(assembly, "trace"))
    }

    @Fact
    func Iterator_TryFinally_FullEnumeration_FinallyExactlyOnce() {
        let source = `package Probe
import System
import System.Collections.Generic

public var finallyRan = 0

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
        yield 3
    } finally {
        finallyRan = finallyRan + 1
    }
}

for v in gen() {
    // consume
}`
        let assembly = CompileAndRun(source)
        Assert.Equal(1, GetIntField(assembly, "finallyRan"))
    }

    shared {
        private func CompileAndRun(source string) Assembly {
            let outPath = CompileToFile(source, target: "exe")
            let assembly = EmittedFixture.Load(outPath)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
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

        private func CompileToFile(source string, target string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_836_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func GetIntField(assembly Assembly, name string) int32 {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let field FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return int32(field!!.GetValue(nil)!!)
        }

        private func GetStringField(assembly Assembly, name string) string? {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let field FieldInfo? = program.GetField(name, BindingFlags.Public | BindingFlags.Static)
            return cast[string](field!!.GetValue(nil)!!)
        }
    }
}
