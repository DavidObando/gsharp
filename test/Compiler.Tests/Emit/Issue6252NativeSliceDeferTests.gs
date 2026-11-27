// <copyright file="Issue6252NativeSliceDeferTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Tests
import System
import System.Text
import Xunit

/// Issue #6252: native-slice extension method calls must be accepted by `defer`
/// with eager operand capture, deferred invocation at scope exit, and rejection
/// of non-call block expressions.
class Issue6252NativeSliceDeferTests {
    @Fact
    func Driver_NativeSliceExtensionDefer_CapturesOperandsEagerly_AndRunsAtScopeExit() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(`import System

func (self slice[int32]) Log(value int32) {
    Console.Write("log:" + self[0].ToString() + ":" + value.ToString() + ";")
}

func (self readonly slice[int32]) LogReadOnly(value int32) {
    Console.Write("ro:" + self[0].ToString() + ":" + value.ToString() + ";")
}

func (self bytestring) LogBytes(value int32) {
    Console.Write("bs:" + self.Length.ToString() + ":" + value.ToString() + ";")
}

func Receiver() slice[int32] {
    Console.Write("recv;")
    return slice[int32]{11}
}

func Arg() int32 {
    Console.Write("arg;")
    return 7
}

func RunSlice() {
    defer Receiver().Log(Arg())
    var local = slice[int32]{22}
    defer local.Log(8)
    local = slice[int32]{99}
    let ro readonly slice[int32] = slice[int32]{33}
    defer ro.LogReadOnly(9)
    let bs bytestring = b"hi"
    defer bs.LogBytes(10)
    Console.Write("body;")
}

func Main() {
    RunSlice()
}`, "NativeSliceDefer6252", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes("recv;arg;body;bs:2:10;ro:33:9;log:22:8;log:11:7;"),
            fixture.RunBytes(program)
        )
    }

    @Fact
    func Driver_NativeSliceExtensionDefer_ThrowingReceiverOrArgument_DoesNotRegisterDefer() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(`import System

func (self slice[int32]) Log(value int32) {
    Console.Write("log:" + value.ToString() + ";")
}

func ThrowingReceiver() slice[int32] {
    Console.Write("throw-recv;")
    throw InvalidOperationException("recv")
}

func GoodReceiver() slice[int32] {
    Console.Write("good-recv;")
    return slice[int32]{1}
}

func ThrowingArg() int32 {
    Console.Write("throw-arg;")
    throw InvalidOperationException("arg")
}

func GoodArg() int32 {
    Console.Write("good-arg;")
    return 5
}

func CaseThrowingReceiver() {
    try {
        defer ThrowingReceiver().Log(GoodArg())
        Console.Write("unreachable;")
    } catch (ex InvalidOperationException) {
        Console.Write("caught:" + ex.Message + ";")
    }
}

func CaseThrowingArg() {
    try {
        defer GoodReceiver().Log(ThrowingArg())
        Console.Write("unreachable;")
    } catch (ex InvalidOperationException) {
        Console.Write("caught:" + ex.Message + ";")
    }
}

func Main() {
    CaseThrowingReceiver()
    CaseThrowingArg()
}`, "NativeSliceDeferThrow6252", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes("throw-recv;caught:recv;good-recv;throw-arg;caught:arg;"),
            fixture.RunBytes(program)
        )
    }

    @Fact
    func Driver_NativeSliceExtensionDefer_InAsyncFunction_PreservesCaptureAcrossAwait() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(`import System
import System.Threading.Tasks

func (self slice[int32]) Log(value int32) {
    Console.Write("async-log:" + self[0].ToString() + ":" + value.ToString() + ";")
}

func Receiver() slice[int32] {
    Console.Write("recv;")
    return slice[int32]{42}
}

async func RunAsync() Task {
    defer Receiver().Log(7)
    Console.Write("before-await;")
    await Task.Yield()
    Console.Write("after-await;")
}

func Main() {
    RunAsync().GetAwaiter().GetResult()
}`, "NativeSliceDeferAsync6252", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("recv;before-await;after-await;async-log:42:7;"), fixture.RunBytes(program))
    }

    @Theory
    @InlineData("defer { Log(7) }")
    @InlineData("defer { var x = 1; Log(x) }")
    @InlineData("defer s[0..1]")
    @InlineData("defer text[0..1]")
    func Driver_NonCallBlockExpressions_StillRejectedByDefer_WithGS0138(deferStatement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `func Log(value int32) {}
func Main() {
    let s = slice[int32]{1, 2}
    let text = "ab"
    ` + deferStatement + `
}`
        let (code, output) = fixture.TryCompile(source, "NativeSliceDeferReject6252", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0138", output)
    }

    @Fact
    func Driver_NativeSliceExtensionDefer_WithByRefArgument_RejectedWithGS0460() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `func (self slice[int32]) Mut(ref value int32) {}
func Receiver() slice[int32] -> slice[int32]{1}
func Main() {
    var x = 1
    defer Receiver().Mut(ref x)
}`
        let (code, output) = fixture.TryCompile(source, "NativeSliceDeferByRef6252", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0460", output)
    }
}
