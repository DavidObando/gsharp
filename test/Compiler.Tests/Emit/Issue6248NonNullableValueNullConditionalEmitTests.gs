// <copyright file="Issue6248NonNullableValueNullConditionalEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.Text
import Xunit

/// Issue #6248: non-nullable value-type receivers in null-conditional accesses
/// (`?.` / `?[]`) must verify strictly under ILVerify and execute their
/// member/index access once without a `brtrue` over a struct slot or a falsy
/// zero-value branch.
class Issue6248NonNullableValueNullConditionalEmitTests {
    @Fact
    func Repro_NonNullableNativeSliceVoidExtension_VerifiesAndRuns() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
func (self slice[int32]) Keep() { Console.Write("m") }
func Receiver() slice[int32] -> slice[int32]{1}
Receiver()?.Keep()`
        let program = fixture.Compile(source, "Repro6248", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("m"), fixture.RunBytes(program))
    }

    @Fact
    func NonNullableNativeSlice_MethodPropertyChainIndexAndNullableControls_VerifyAndRun() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System

var calls = 0

func (self slice[int32]) Keep() { Console.Write("m") }
func (self slice[int32]) Get() int32 -> self[0] + 10
func (self readonly slice[int32]) ReadFirst() int32 -> self[0]

func NextSlice() slice[int32] {
    calls++
    return slice[int32]{7, 8}
}

class Holder {
    var Items slice[int32] = slice[int32]{3, 4}
}

func Run() {
    let directLen int32? = NextSlice()?.Length
    let directGet int32? = NextSlice()?.Get()
    let chainedRo int32? = NextSlice()?.AsReadOnly()?.Length
    let chainedRoGet int32? = NextSlice()?.AsReadOnly()?.ReadFirst()
    let viaHolder int32? = Holder()?.Items?.Length
    Holder()?.Items?.Keep()
    Console.Write("|")
    Console.Write(directLen)
    Console.Write("|")
    Console.Write(directGet)
    Console.Write("|")
    Console.Write(chainedRo)
    Console.Write("|")
    Console.Write(chainedRoGet)
    Console.Write("|")
    Console.Write(viaHolder)
    Console.Write("|")
    Console.Write(calls)

    let present slice[int32]? = slice[int32]{5}
    let absent slice[int32]? = nil
    present?.Keep()
    absent?.Keep()
    Console.Write("|")
    Console.Write(present?.Length ?? -1)
    Console.Write("|")
    Console.Write(absent?.Length ?? -1)
    Console.Write("|")
    Console.Write(present?[0] ?? -1)
    Console.Write("|")
    Console.Write(absent?[0] ?? -1)
}
Run()`
        let program = fixture.Compile(source, "SliceMatrix6248", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("m|2|17|2|7|2|4m|1|-1|5|-1"), fixture.RunBytes(program))
    }

    @Fact
    func NonNullableNativeSlice_NullConditionalIndex_EmitsGS0300_VerifiesAndRuns() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
var calls = 0
func Next() slice[int32] {
    calls++
    return slice[int32]{42, 99}
}
let hit int32? = Next()?[1]
Console.Write(hit)
Console.Write("|")
Console.Write(calls)`
        let (code, output) = fixture.TryCompile(source, "SliceIndex6248", executable: true)
        Assert.Equal(0, code)
        Assert.Contains("warning GS0300", output, StringComparison.Ordinal)
        let program = System.IO.Path.Combine(fixture.Directory, "SliceIndex6248.dll")
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("99|1"), fixture.RunBytes(program))
    }

    @Fact
    func SiblingNonNullableValueAndReferenceReceivers_VerifyAndRun() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System

enum ZeroEnum {
    Zero;
    One
}

struct PairStruct {
    var Value int32
    var Items []int32
    func Keep() { Console.Write("s:" + Value.ToString()) }
    func Get() int32 -> Value
}

class RefBox {
    var Label string = "ref"
    func Get() string -> Label
}

func (self bytestring) KeepBytes() { Console.Write("b:" + self.Length.ToString()) }

func CheckStructGeneric[T struct](value T) string -> value?.ToString() ?? "nil"

shared class P {
    func Main() {
        let bs = b"hi"
        bs?.KeepBytes()
        Console.Write("|")
        Console.Write(bs?.Length ?? -1)
        Console.Write("|")

        let fixedArr [3]int32 = [3]int32{4, 5, 6}
        Console.Write(fixedArr?.Length ?? -1)
        Console.Write("|")
        Console.Write(fixedArr?[1] ?? -1)
        Console.Write("|")

        var ps = PairStruct{Value: 0, Items: []int32{1, 2}}
        ps?.Keep()
        Console.Write("|")
        Console.Write(ps?.Value ?? -1)
        Console.Write("|")
        Console.Write(ps?.Get() ?? -1)
        Console.Write("|")
        ps?.Items[0] = 9
        Console.Write(ps.Items[0])
        Console.Write("|")

        let zeroInt int32 = 0
        let falseBool bool = false
        let zeroEnum = ZeroEnum.Zero
        Console.Write(zeroInt?.ToString() ?? "NIL")
        Console.Write("|")
        Console.Write(falseBool?.ToString() ?? "NIL")
        Console.Write("|")
        Console.Write(zeroEnum?.ToString() ?? "NIL")
        Console.Write("|")

        let tup = (0, "ok")
        Console.Write(tup?.Item1 ?? -1)
        Console.Write("|")
        Console.Write(tup?.1 ?? "NIL")
        Console.Write("|")

        let sp = span[int32]([]int32{10, 20})
        sp?.Clear()
        Console.Write(sp?.Length ?? -1)
        Console.Write("|")
        Console.Write(sp[0])
        Console.Write("|")

        let rb = RefBox()
        Console.Write(rb?.Get() ?? "NIL")
        Console.Write("|")
        Console.Write("abc"?.Length ?? -1)
        Console.Write("|")
        Console.Write(CheckStructGeneric[int32](0))
    }
}`
        let (code, output) = fixture.TryCompile(source, "Siblings6248", executable: true)
        Assert.Equal(0, code)
        Assert.Contains("warning GS0300", output, StringComparison.Ordinal)
        let program = System.IO.Path.Combine(fixture.Directory, "Siblings6248.dll")
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes("b:2|2|3|5|s:0|0|0|9|0|False|Zero|0|ok|2|0|ref|3|0"),
            fixture.RunBytes(program)
        )
    }

    @Fact
    func AsyncNonNullableValueReceivers_SpillVerifyAndRun() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Threading.Tasks

func (self slice[int32]) KeepAsync(suffix string) {
    Console.Write(self[0].ToString() + suffix)
}

func (self slice[int32]) AddAt(index int32, delta int32) int32 -> self[index] + delta

func GetSliceAsync() Task[slice[int32]] -> Task.FromResult(slice[int32]{5, 6})

async func RunAsync() Task[string] {
    (await GetSliceAsync())?.KeepAsync(":")
    let a int32? = (await GetSliceAsync())?.Length
    let b int32? = slice[int32]{5, 6}?.AddAt(0, await Task.FromResult(3))
    let z int32 = 0
    let c string? = z?.ToString().PadLeft(await Task.FromResult(2), '0')
    slice[int32]{7}?.KeepAsync(await Task.FromResult("!"))
    return "${a}|${b}|${c}"
}

Console.Write(RunAsync().GetAwaiter().GetResult())`
        let program = fixture.Compile(source, "Async6248", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("5:7!2|8|00"), fixture.RunBytes(program))
    }
}
