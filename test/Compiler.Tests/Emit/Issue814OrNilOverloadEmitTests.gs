// <copyright file="Issue814OrNilOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #814 / ADR-0084 §L5 closing bullet — emit + IL-verify coverage
/// for the dogfooded `SequenceExtensions.FirstOrNil` /
/// `LastOrNil` / `SingleOrNil` shape: two extension overloads
/// on `(self sequence[T])`, distinguished only by a
/// `[T class]` / `[T struct]` generic-parameter constraint and
/// a return-type representation that bottoms out in `T?`. The
/// binder must pick the right overload; the emitter must close the open
/// `T?` return into a reference `T` on the class side and into
/// `Nullable<T>` on the struct side; the produced IL must
/// verify under `ilverify`.
open class Issue814OrNilOverloadEmitTests {
    @Fact
    func FirstOrNil_TwoOverloads_ClassReceiver_StringArray_PicksClassOverload() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() string { return "class" }
func (self sequence[T]) FirstOrNil[T struct]() string { return "struct" }

public var tag = ""
tag = ([]string{"a", "b"}).FirstOrNil()`
        let assembly = CompileAndRun(source)
        Assert.Equal("class", GetStringField(assembly, "tag"))
    }

    @Fact
    func FirstOrNil_TwoOverloads_StructReceiver_Int32Array_PicksStructOverload() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() string { return "class" }
func (self sequence[T]) FirstOrNil[T struct]() string { return "struct" }

public var tag = ""
tag = ([]int32{1, 2}).FirstOrNil()`
        let assembly = CompileAndRun(source)
        Assert.Equal("struct", GetStringField(assembly, "tag"))
    }

    @Fact
    func FirstOrNil_TQuestionReturn_ClassReceiver_StringArray_ReturnsHead() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

public var head = ""
head = ([]string{"alpha", "beta"}).FirstOrNil() ?? "<none>"`
        let assembly = CompileAndRun(source)
        Assert.Equal("alpha", GetStringField(assembly, "head"))
    }

    @Fact
    func FirstOrNil_TQuestionReturn_StructReceiver_Int32Array_ReturnsHead() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

public var head = 0
head = ([]int32{11, 22, 33}).FirstOrNil() ?? -1`
        let assembly = CompileAndRun(source)
        Assert.Equal(11, GetIntField(assembly, "head"))
    }

    @Fact
    func FirstOrNil_TQuestionReturn_EmptyStringArray_ReturnsNil() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

public var head = ""
head = ([]string{}).FirstOrNil() ?? "<none>"`
        let assembly = CompileAndRun(source)
        Assert.Equal("<none>", GetStringField(assembly, "head"))
    }

    @Fact
    func FirstOrNil_TQuestionReturn_EmptyInt32Array_ReturnsNil() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

public var head = 0
head = ([]int32{}).FirstOrNil() ?? -1`
        let assembly = CompileAndRun(source)
        Assert.Equal(-1, GetIntField(assembly, "head"))
    }

    @Fact
    func LastOrNil_TQuestionReturn_BothShapes_RunCorrectly() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) LastOrNil[T class]() T? {
    var last T? = nil
    for v in self { last = v }
    return last
}

func (self sequence[T]) LastOrNil[T struct]() T? {
    var last T? = nil
    for v in self { last = v }
    return last
}

public var sLast = ""
public var nLast = 0
sLast = ([]string{"a", "b", "c"}).LastOrNil() ?? "<none>"
nLast = ([]int32{10, 20, 30}).LastOrNil() ?? -1`
        let assembly = CompileAndRun(source)
        Assert.Equal("c", GetStringField(assembly, "sLast"))
        Assert.Equal(30, GetIntField(assembly, "nLast"))
    }

    @Fact
    func SingleOrNil_TQuestionReturn_BothShapes_RunCorrectly() {
        let source = `package Probe
import System
import System.Collections.Generic

func (self sequence[T]) SingleOrNil[T class]() T? {
    var only T? = nil
    var count = 0
    for v in self {
        only = v
        count = count + 1
    }
    if count == 1 { return only }
    return nil
}

func (self sequence[T]) SingleOrNil[T struct]() T? {
    var only T? = nil
    var count = 0
    for v in self {
        only = v
        count = count + 1
    }
    if count == 1 { return only }
    return nil
}

public var sSolo = ""
public var nSolo = 0
public var sNone = ""
sSolo = ([]string{"x"}).SingleOrNil() ?? "<none>"
nSolo = ([]int32{42}).SingleOrNil() ?? -1
sNone = ([]string{"a", "b"}).SingleOrNil() ?? "<none>"`
        let assembly = CompileAndRun(source)
        Assert.Equal("x", GetStringField(assembly, "sSolo"))
        Assert.Equal(42, GetIntField(assembly, "nSolo"))
        Assert.Equal("<none>", GetStringField(assembly, "sNone"))
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
            let tempDir = Directory.CreateTempSubdirectory("gs_814_").FullName
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
