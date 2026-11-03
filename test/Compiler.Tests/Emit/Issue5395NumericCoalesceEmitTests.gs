// <copyright file="Issue5395NumericCoalesceEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System.Text
import Xunit

class Issue5395NumericCoalesceEmitTests {
    @Fact
    func AdaptedCoalesceRetainsImplicitConsumersAndCheckedCasts() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package ConversionsCoalesce5395
import System

func Return(value uint32?) uint32 -> value ?? 0
func Consume(value uint64) {
    Console.Write(value)
    Console.Write(":")
}
func Unsigned(value uint32?) {
    let assigned uint32 = value ?? 0
    Consume(assigned)
    Consume(Return(value))
    Consume(value ?? 0)
    Console.Write(cast[int64](value ?? 0))
    Console.Write(":")
    Console.Write(unchecked(cast[int32](value ?? 0)))
    Console.Write(":")
    try {
        Console.Write(checked(cast[int32](value ?? 0)))
    } catch (error OverflowException) {
        Console.Write("overflow")
    }
    Console.Write("|")
}
func Signed(value int32?) {
    Console.Write(unchecked(cast[uint64](value ?? 0u)))
    Console.Write("|")
}
func Main() {
    Unsigned(nil)
    Unsigned(4294967295u)
    Signed(nil)
    Signed(-7)
}`, "conversions-coalesce5395", true)
        IlVerifier.Verify(assembly)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "0:0:0:0:0:0|4294967295:4294967295:4294967295:4294967295:-1:overflow|0|18446744073709551609|"
            ),
            fixture.RunBytes(assembly)
        )
    }

    @Fact
    func ImportedConditionalUInt32CoalesceConvertsToUInt64Once() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace Coalesce5395;
public sealed class ThreadContract {
    public static int Selections;
    public static int Reads;
    private readonly uint id;
    public ThreadContract(uint id) { this.id = id; }
    public uint OSThreadId { get { Reads++; return id; } }
    public static ThreadContract? Select(bool present, uint id) {
        Selections++;
        return present ? new ThreadContract(id) : null;
    }
}`, "ThreadContract5395")
        let assembly = fixture.Compile(`package ConditionalCoalesce5395
import Coalesce5395
import System
import System.IO
import System.Text.Json

func Read(present bool, id uint32) {
    let selected = ThreadContract.Select(present, id)
    using let stream = MemoryStream()
    using let writer = Utf8JsonWriter(stream)
    writer.WriteStartObject()
    writer.WriteNumber("thread_id", cast[uint64](selected?.OSThreadId ?? 0))
    writer.WriteEndObject()
    writer.Flush()
    Console.OpenStandardOutput().Write(stream.ToArray())
}

func Main() {
    Read(false, 7u)
    Read(true, 0u)
    Read(true, 4294967295u)
    Console.Write("|")
    Console.Write(ThreadContract.Selections)
    Console.Write("|")
    Console.Write(ThreadContract.Reads)
}`, "conditional-coalesce5395", true, "/reference:" + contract)
        IlVerifier.Verify(assembly, []string{contract})
        Assert.Equal(
            Encoding.UTF8.GetBytes(`{"thread_id":0}{"thread_id":0}{"thread_id":4294967295}|3|2`),
            fixture.RunBytes(assembly)
        )
    }

    @Fact
    func AdaptedFallbackKeepsValueResultAndLiftedOperatorsKeepNullableResults() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`namespace Coalesce5395;
public static class ResultContract {
    public static string Kind(uint value) => "uint";
    public static string Kind(uint? value) => value.HasValue ? "uint?" : "nil";
    public static string Kind(ulong value) => "ulong";
    public static string Kind(ulong? value) => value.HasValue ? "ulong?" : "nil";
    public static string Kind(int value) => "int";
    public static string Kind(int? value) => value.HasValue ? "int?" : "nil";
}`, "ResultContract5395")
        let assembly = fixture.Compile(`package ResultCoalesce5395
import Coalesce5395
import System

func Unsigned(value uint32?) {
    Console.Write(ResultContract.Kind(value ?? 0))
    Console.Write(":")
    Console.Write(value ?? 0)
    Console.Write("|")
}
func Wide(value uint64?) {
    Console.Write(ResultContract.Kind(value ?? 0))
    Console.Write(":")
    Console.Write(value ?? 0)
    Console.Write("|")
}
func Signed(value int32?) {
    Console.Write(ResultContract.Kind(value ?? 0u))
    Console.Write(":")
    Console.Write(value ?? 0u)
    Console.Write("|")
}
func Controls(value uint32?, fallback uint32?) {
    Console.Write(ResultContract.Kind(value ?? fallback))
    Console.Write(":")
    Console.Write(ResultContract.Kind(value + 0))
    var assigned = value
    assigned += 0
    Console.Write(":")
    Console.Write(ResultContract.Kind(assigned))
    Console.Write(":")
    Console.Write((value, 9) == (0u, 9))
    Console.Write("|")
}
func Main() {
    Unsigned(nil)
    Unsigned(4294967295u)
    Wide(nil)
    Wide(18446744073709551615ul)
    Signed(nil)
    Signed(-7)
    Controls(nil, nil)
    Controls(nil, 8u)
    Controls(5u, nil)
}`, "result-coalesce5395", true, "/reference:" + contract)
        IlVerifier.Verify(assembly, []string{contract})
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "uint:0|uint:4294967295|ulong:0|ulong:18446744073709551615|int:0|int:-7|" +
                    "nil:nil:nil:False|uint?:nil:nil:False|uint?:uint?:uint?:False|"
            ),
            fixture.RunBytes(assembly)
        )
    }

    @Fact
    func AsyncNullableUInt64CoalesceConvertedToInt32ConstructorArg_VerifiesAndRuns() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Reproduction5487
import System
import System.Threading.Tasks

class Result(txid string, fee uint64, change uint64, count int32) {
    let Count int32 = count
}

func Count(present bool) uint64? {
    if present {
        return uint64(1)
    }
    return nil
}

func NarrowCount(present bool) uint32? {
    if present {
        return uint32(7)
    }
    return nil
}

async func ReadAsync(present bool) Result {
    await Task.Delay(1)
    return Result("txid", uint64(3), uint64(2), int32(Count(present) ?? 0))
}

func WidenedNullableCoalesce(present bool, fallback uint64?) int32 ->
    int32((NarrowCount(present) ?? fallback) ?? 0)

struct BoxedTag5487(Value int32) : IComparable {
    func CompareTo(other object?) int32 -> 0
}

func ChooseComparable(x int32?, y string) IComparable -> x ?? y

func ChooseSymbolicComparable(x BoxedTag5487?, y string) IComparable -> x ?? y

func ChooseTupleNullable(left (int32, string)?, right (int32, string?)?) (int32, string?)? -> left ?? right

func ChooseSymbolicTupleNullable(left (BoxedTag5487, string)?, right (BoxedTag5487, string?)?) (BoxedTag5487, string?)? -> left ?? right

func Main() {
    Console.WriteLine(ReadAsync(false).GetAwaiter().GetResult().Count)
    Console.WriteLine(ReadAsync(true).GetAwaiter().GetResult().Count)
    Console.WriteLine(WidenedNullableCoalesce(false, uint64(9)))
    Console.WriteLine(WidenedNullableCoalesce(true, uint64(9)))
    Console.WriteLine(ChooseComparable(42, "fallback"))
    Console.WriteLine(ChooseComparable(nil, "fallback"))
    Console.WriteLine(ChooseSymbolicComparable(BoxedTag5487(11), "fallback").CompareTo(nil))
    Console.WriteLine(ChooseSymbolicComparable(nil, "fallback"))
    let tuplePresent = ChooseTupleNullable((5, "ok"), (6, default(string?)))
    let tupleAbsent = ChooseTupleNullable(nil, (6, default(string?)))
    Console.WriteLine(tuplePresent!!.Item1)
    Console.WriteLine(tupleAbsent!!.Item1)
    let symPresent = ChooseSymbolicTupleNullable((BoxedTag5487(13), "ok"), (BoxedTag5487(14), default(string?)))
    let symAbsent = ChooseSymbolicTupleNullable(nil, (BoxedTag5487(14), default(string?)))
    Console.WriteLine(symPresent!!.Item1.Value)
    Console.WriteLine(symAbsent!!.Item1.Value)
}`, "reproduction-5487", true)
        IlVerifier.Verify(assembly)
        Assert.Equal(
            Encoding.UTF8.GetBytes("0\n1\n9\n7\n42\nfallback\n0\nfallback\n5\n6\n13\n14\n"),
            fixture.RunBytes(assembly)
        )
    }
}
