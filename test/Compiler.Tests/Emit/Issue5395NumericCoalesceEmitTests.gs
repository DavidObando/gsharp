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
}
