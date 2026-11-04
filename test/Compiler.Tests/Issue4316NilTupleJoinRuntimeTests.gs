// <copyright file="Issue4316NilTupleJoinRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #4316: tuple arms that hold a `nil` element join element by element, and the joined value
/// runs as the arms say. Each arm's condition runs once, the arm that runs supplies the value, and
/// an expression that produces `nil` still runs its effects when the `nil` lands in a `T?` slot.
/// @remarks Mutation witnesses: with `ConversionClassifier.TryConvertEachResult` declining every
/// source, the nested and switch-element rows fail with GS9998; with the old `nil`-to-`T?`
/// lowering (no per-result conversion, the whole expression replaced by `default(T?)`), the effect
/// counts read 0.
open class Issue4316NilTupleJoinRuntimeTests {
    /// The joined tuples hold the values of the arm that ran, and every effect runs exactly once.
    @Fact
    func NilTupleJoins_RunEachArmOnceAndKeepEffects() {
        let output = CompileAndRun(`package main
import System

class Ctr {
    var n int32
}

class AlwaysEqualBox {
    shared {
        public operator ==(a AlwaysEqualBox?, b AlwaysEqualBox?) bool -> true
        public operator !=(a AlwaysEqualBox?, b AlwaysEqualBox?) bool -> false
    }
}

class Token {
    public var v string
    public init(v string) {
        this.v = v
    }
    shared {
        public implicit operator Token(s string?) Token -> Token(s ?? "<nil>")
    }
}

func Tick(ctr Ctr, b bool) bool {
    ctr.n++
    return b
}

func Nested(ctr Ctr, c bool, i int32) (string?, int32) {
    let t = Tick(ctr, c) ? ("x", 1) : (Tick(ctr, i == 0) ? (nil, 2) : (nil, 3))
    return t
}

func InBlock(c bool, i int32) (string?, int32) {
    let t = if c {
        ("a", 1)
    } else {
        let n = 2
        switch i {
            case 0: (nil, n)
            default: (nil, 3)
        }
    }
    return t
}

func Targeted(ctr Ctr, d bool) (int32?, int32) {
    let t (int32?, int32) = (if d {
        Tick(ctr, true)
        nil
    } else {
        nil
    }, 2)
    return t
}

func Untargeted(ctr Ctr, c bool, d bool) (int32?, int32) {
    let t = c ? (1, 1) : (if d {
        Tick(ctr, true)
        nil
    } else {
        nil
    }, 2)
    return t
}

func Count(ctr Ctr, i int32) int32 {
    ctr.n++
    return i
}

func SwitchElement(ctr Ctr, c bool, i int32) (int32?, int32) {
    let t = c ? (1, 1) : (switch Count(ctr, i) {
        default: nil
    }, 2)
    return t
}

func CoalesceElement(ctr Ctr, c bool, i int32) (int32?, int32) {
    let t = c ? (1, 1) : (nil ?? (switch Count(ctr, i) {
        default: nil
    }), 2)
    return t
}

func CoalesceEffects(ctr Ctr, c bool, i int32, j int32) (int32?, int32) {
    let t = c ? (1, 1) : ((switch Count(ctr, i) {
        default: nil
    }) ?? (switch Count(ctr, j) {
        default: (nil, 2)
    }))
    return t
}

func PartiallyUnresolved(c bool, d bool, i int32) (string?, string?) {
    let a = c ? ("a", "b") : (d ? (nil, "c") : (nil, nil))
    let b = c ? ("a", "b") : (switch i {
        case 0: (nil, "c")
        case 1: (nil, nil)
        default: (nil, "d")
    })
    let standalone = d ? (nil, "e") : (nil, nil)
    let (da, db) = d ? (nil, "f") : (nil, nil)
    let f = () -> d ? (nil, "g") : (nil, nil)
    let projected = (d ? (nil, "h") : (nil, nil)).Item2
    let eq = (d ? (nil, "x") : (nil, nil)) == (default(object?), default(string?))
    let liveBox AlwaysEqualBox? = AlwaysEqualBox()
    let eqLeftNil = (nil, 0) == (liveBox, 0)
    let eqRightNil = (liveBox, 0) == (nil, 0)
    let neqLeftNil = (nil, 0) != (liveBox, 0)
    let neqRightNil = (liveBox, 0) != (nil, 0)
    var pair (string?, string?) = ("p", "q")
    var num = 0
    pair, num = d ? ((nil, "x"), 1) : ((nil, nil), 2)
    var tok = Token("init")
    tok, num = (nil, 7)
    let boxed object = (d ? (nil, "x") : (nil, nil))
    let multiT, let multiN = d ? (nil, "x") : (nil, nil), 0
    let swExpr = switch (d ? (nil, "x") : (nil, nil)) {
        default: 1
    }
    var swStmt = 0
    switch (d ? (nil, "x") : (nil, nil)) {
        default {
            swStmt = 1
        }
    }
    (switch i {
        case 0: (nil, "x")
        default: (nil, nil)
    })
    let multiRet = (flag bool) -> {
        if flag {
            return (AlwaysEqualBox(), 1)
        }
        return (nil, 2)
    }
    let nullableTupleRet = (aFlag bool, bFlag bool) -> {
        if aFlag {
            return bFlag ? (nil, "x") : (nil, nil)
        }
        return nil
    }
    let widenedNullableTuple (string?, int64)? = (nil, 1)
    return if standalone.Item1 == nil &&
        da == nil &&
        (db != nil || !d) &&
        f().Item1 == nil &&
        (projected != nil || !d) &&
        (eq == !d) &&
        !eqLeftNil &&
        !eqRightNil &&
        neqLeftNil &&
        neqRightNil &&
        pair.Item1 == nil &&
        tok.v == "<nil>" &&
        num == 7 &&
        boxed != nil &&
        multiT.Item1 == nil &&
        multiN == 0 &&
        swExpr == 1 &&
        swStmt == 1 &&
        multiRet(false).Item1 == nil &&
        nullableTupleRet(false, true) == nil &&
        nullableTupleRet(true, true) != nil &&
        widenedNullableTuple != nil {
        (a.Item2, b.Item2)
    } else {
        ("bad", "bad")
    }
}

func Main() {
    let ctr = Ctr()
    let a = Nested(ctr, false, 0)
    let b = Nested(ctr, true, 0)
    let d = Nested(ctr, false, 5)
    Console.WriteLine("nested ${a.Item1 == nil} ${a.Item2} ${b.Item1} ${b.Item2} ${d.Item2} ticks=${ctr.n}")
    let e = InBlock(false, 0)
    let f = InBlock(true, 0)
    let g = InBlock(false, 9)
    Console.WriteLine("block ${e.Item1 == nil} ${e.Item2} ${f.Item1} ${g.Item2}")
    ctr.n = 0
    let h = Targeted(ctr, true)
    Console.WriteLine("targeted ${h.Item1 == nil} ${h.Item2} ticks=${ctr.n}")
    ctr.n = 0
    let k = Untargeted(ctr, false, true)
    Console.WriteLine("untargeted ${k.Item1 == nil} ${k.Item2} ticks=${ctr.n}")
    ctr.n = 0
    let m = SwitchElement(ctr, false, 4)
    Console.WriteLine("switch ${m.Item1 == nil} ${m.Item2} ticks=${ctr.n}")
    ctr.n = 0
    let p = CoalesceElement(ctr, false, 4)
    Console.WriteLine("coalesce ${p.Item1 == nil} ${p.Item2} ticks=${ctr.n}")
    ctr.n = 0
    let q = CoalesceEffects(ctr, false, 4, 7)
    Console.WriteLine("coalesce-effects ${q.Item1 == nil} ${q.Item2} ticks=${ctr.n}")
    let r = PartiallyUnresolved(false, true, 0)
    let s = PartiallyUnresolved(false, false, 1)
    Console.WriteLine("partial ${r.Item1} ${r.Item2} ${s.Item1 == nil} ${s.Item2 == nil}")
}
`)
        Assert.Contains("nested True 2 x 1 3 ticks=5", output)
        Assert.Contains("block True 2 a 3", output)
        Assert.Contains("targeted True 2 ticks=1", output)
        Assert.Contains("untargeted True 2 ticks=1", output)
        Assert.Contains("switch True 2 ticks=1", output)
        Assert.Contains("coalesce True 2 ticks=1", output)
        Assert.Contains("coalesce-effects True 2 ticks=2", output)
        Assert.Contains("partial c c True True", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_4316_run_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "gsc failed:\n" + "$stdoutWriter" + "\n" + "$stderrWriter")
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdoutTask = proc.StandardOutput.ReadToEndAsync()
                let stderrTask = proc.StandardError.ReadToEndAsync()
                if !proc.WaitForExit(30_000) {
                    try {
                        proc.Kill(entireProcessTree: true)
                    } catch (InvalidOperationException) {
                        // The process exited between the timeout and the kill.

                    }
                    Assert.Fail("dotnet exec timed out")
                }
                let stdout = stdoutTask.GetAwaiter().GetResult()
                let stderr = stderrTask.GetAwaiter().GetResult()
                Assert.True(proc.ExitCode == 0, "exited ${proc.ExitCode}\n" + stdout + "\n" + stderr)
                return stdout
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }
    }
}
