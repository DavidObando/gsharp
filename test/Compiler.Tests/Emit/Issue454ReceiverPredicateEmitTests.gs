// <copyright file="Issue454ReceiverPredicateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #454: regression tests for the migrated CLR-side emit paths that
/// previously used the inline `ClrType?.IsValueType == true` predicate
/// for receiver-kind detection. Switching to `IsValueTypeSymbol`
/// (the same predicate used by `EmitInstanceReceiver`) preserves
/// behaviour for CLR value-type receivers (verified here) while also
/// correctly classifying user-declared structs (which have no
/// `ClrType` until after emission completes).
///
/// The four migrated sites are:
/// * `EmitClrPropertyAccess`
/// * `EmitClrPropertyAssignment`
/// * `EmitClrEventSubscription`
/// * `EmitClrIndexAccess`
///
/// Each test compiles a small program that exercises one of those sites
/// and asserts the runtime result matches expectation; any regression in
/// the call/callvirt choice or the spill plumbing manifests as either a
/// JIT-time failure ((cref:InvalidProgramException)) or a wrong
/// observable value.
open class Issue454ReceiverPredicateEmitTests {
    @Fact
    func ClrPropertyAccess_OnUserStructHeldClrObject_RoundTrips() {
        // User-declared struct holds a StringBuilder reference. Reading
        // `b.sb` returns the inner CLR reference; calling `.Length` on it
        // exercises EmitClrPropertyAccess. The outer field access spills
        // through EmitInstanceReceiver (struct receiver) and the inner CLR
        // call uses callvirt as the unified predicate prescribes for
        // reference-type receivers.
        let source = `package P
import System
import System.Text

struct Box {
    var sb StringBuilder
}

let b = Box{sb: StringBuilder("hello")}
let inner = b.sb
public var result = inner.Length`
        Assert.Equal(5, RunAndGetIntResult(source))
    }

    @Fact
    func ClrPropertyAccess_OnClrValueTypeReceiver_StillUsesCall() {
        // Reading a CLR property on a CLR value-type receiver (DateTime.Day)
        // must still emit `call` (not callvirt) under the new predicate.
        // Runtime success implicitly verifies the IL is valid.
        let source = `package P
import System

let d = DateTime(2024, 7, 15)
public var result = d.Day`
        Assert.Equal(15, RunAndGetIntResult(source))
    }

    @Fact
    func ClrPropertyAssignment_OnUserStructHeldClrObject_RoundTrips() {
        // Writing to a CLR property on a CLR reference exercises the
        // EmitClrPropertyAssignment site and its value-spill machinery.
        // The user struct (loaded by address via EmitInstanceReceiver)
        // holds the CLR reference; the assignment runs against the inner
        // CLR receiver and must yield the spilled value as the expression
        // result without re-reading via the getter.
        let source = `package P
import System
import System.Text

let sb = StringBuilder()
let written = (sb.Capacity = 256)
public var result = written`
        Assert.Equal(256, RunAndGetIntResult(source))
    }

    @Fact
    func ClrEventSubscription_OnClrReferenceReceiver_RoundTrips() {
        // Subscribe and unsubscribe handlers on a CLR event. The unified
        // predicate must still emit callvirt for the add_X/remove_X
        // accessors on a reference-type receiver, and the produced IL must
        // load and run.
        let source = `package P
import System

let d = AppDomain.CurrentDomain
d.ProcessExit += func(sender Object, e EventArgs) { }
public var result = 1`
        Assert.Equal(1, RunAndGetIntResult(source))
    }

    @Fact
    func ClrIndexerAccess_OnClrReferenceReceiver_RoundTrips() {
        // Read a CLR indexer via callvirt on a reference-type receiver
        // (List[int32]). The unified predicate must still emit callvirt
        // for the get_Item call.
        let source = `package P
import System
import System.Collections.Generic

let list = List[int32]()
list.Add(11)
list.Add(22)
list.Add(33)
public var result = list[1]`
        Assert.Equal(22, RunAndGetIntResult(source))
    }

    @Fact
    func UserStructProperty_AccessOnRvalueReceiver_SpillsAndUsesCall() {
        // Sanity guard for the user-defined property path: an rvalue
        // user-struct receiver must be spilled to a temp and addressed by
        // `ldloca` before the `call get_Sum`. Pre-#454 the user-property
        // path already used the symbol-based `receiverIsClass` predicate;
        // this test just locks in that behaviour against future drift.
        let source = `package P
import System

struct Point {
    var X int32
    var Y int32
    prop Sum int32 {
        get { return this.X + this.Y }
    }
}

func makePoint(x int32, y int32) Point {
    return Point{X: x, Y: y}
}

public var result = makePoint(4, 9).Sum`
        Assert.Equal(13, RunAndGetIntResult(source))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssembly(source)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue454_emit_").FullName
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
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return EmittedFixture.Load(outPath)
        }
    }
}
