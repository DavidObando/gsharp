// <copyright file="Issue1100GenericMemberOnUserTypeArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1100: emitting a member access (method call / field access /
/// constructor) on a constructed BCL generic type whose type argument is a
/// same-compilation user type — e.g. `Queue[Entry]` with `Entry`
/// declared in the same assembly — aborted compilation with
/// `GS9998: NotSupportedException: TypeBuilder generic instantiation does not
/// support resolving members`.
///
/// Root cause: (cref:GSharp.Core.CodeAnalysis.Symbols.FunctionTypeSymbol)
/// closed the host-runtime open delegate definition over type arguments loaded
/// by the reference resolver's `MetadataLoadContext`; mixing reflection
/// contexts made `Type.MakeGenericType` return a
/// `System.Reflection.Emit.TypeBuilderInstantiation`, and every subsequent
/// reflection probe (binding-time convertibility checks, emit member
/// resolution) threw (cref:NotSupportedException). The fix surfaces a
/// null (symbolic) CLR type for such unusable instantiations, and the binder
/// recovers the symbolic generic-method return type so `Queue[Entry].Dequeue()`
/// binds to `Entry` rather than erasing to `object`.
///
/// These tests compile, IL-verify, and run the minimal repro end to end,
/// proving emit no longer throws.
open class Issue1100GenericMemberOnUserTypeArgEmitTests {
    @Fact
    func QueueOfUserType_EnqueueDequeueCount_EmitsAndRuns() {
        let source = `package P
import System
import System.Collections.Generic

class Entry {
    var Value int32
    init(value int32) {
        Value = value
    }
}

class C {
    let q Queue[Entry] = Queue[Entry]()

    func add(e Entry) {
        q.Enqueue(e)
    }

    func count() int32 {
        return q.Count
    }

    func drainSum() int32 {
        var total = 0
        while q.Count > 0 {
            let x = q.Dequeue()
            total = total + x.Value
        }
        return total
    }
}

var c = C()
c.add(Entry(10))
c.add(Entry(20))
c.add(Entry(12))
Console.WriteLine(c.count())
Console.WriteLine(c.drainSum())
Console.WriteLine(c.count())`
        Assert.Equal("3${Environment.NewLine}42${Environment.NewLine}0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ListOfUserType_AddIndexCount_EmitsAndRuns() {
        // Exercises a second constructed BCL generic (List[T]) member-access
        // family (Add / indexer / Count) over a same-compilation user type.
        let source = `package P
import System
import System.Collections.Generic

class Item {
    var Id int32
    init(id int32) {
        Id = id
    }
}

class Bag {
    let items List[Item] = List[Item]()

    func push(i Item) {
        items.Add(i)
    }

    func first() Item {
        return items[0]
    }

    func size() int32 {
        return items.Count
    }
}

var b = Bag()
b.push(Item(7))
b.push(Item(9))
var head = b.first()
Console.WriteLine(head.Id)
Console.WriteLine(b.size())`
        Assert.Equal("7${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Issue1401_QueueAndListOfUserStructAndClass_EmitAndRun() {
        let source = `package P
import System
import System.Collections.Generic

data struct StructEntry(Id int32)

class ClassEntry {
    var Id int32
    init(id int32) {
        Id = id
    }
}

class C {
    let structs Queue[StructEntry] = Queue[StructEntry]()
    let classes List[ClassEntry] = List[ClassEntry]()

    func run() int32 {
        structs.Enqueue(StructEntry{Id: 5})
        structs.Enqueue(StructEntry{Id: 6})
        classes.Add(ClassEntry(7))
        classes.Add(ClassEntry(8))

        let a = structs.Dequeue()
        let b = structs.Dequeue()
        return a.Id + b.Id + classes[0].Id + classes[1].Id + structs.Count + classes.Count
    }
}

Console.WriteLine(C().run())`
        Assert.Equal("28${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DelegateVariableClosedOverUserClass_Invoke_EmitsAndRuns() {
        let source = `package P
import System

class Entry {
    var Value int32
    init(value int32) {
        Value = value
    }
}

class C {
    func run() int32 {
        var seen = 0
        let f (Entry) -> void = (e Entry) -> seen = e.Value
        f(Entry(42))
        return seen
    }
}

Console.WriteLine(C().run())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1100_emit_").FullName
            try {
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
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
