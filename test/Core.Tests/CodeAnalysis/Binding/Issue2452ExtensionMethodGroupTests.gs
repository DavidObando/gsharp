// <copyright file="Issue2452ExtensionMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #2452: receiver-style extension method references are method groups,
/// not property reads. Ordinary members keep precedence, while source and
/// imported extensions may be converted to delegates when no member exists.
open class Issue2452ExtensionMethodGroupTests {
    @Fact
    func SourceExtensionMethodGroups_WorkAcrossRecordClassAndInterfaceReceivers() {
        let source = `package Repro
import System

func (text string) Checksum32() uint32 -> uint32(text.Length)

interface IText { prop Text string { get; } }
interface IHasher { func Hash() uint32; }

data class Profile(AccountName string, DeviceName string)

class TextHolder : IText {
    prop Text string -> "holder"
}

class Hasher : IHasher {
    func (IHasher) Hash() uint32 -> 8u
}

func CaptureProfile(p Profile) uint32 {
    let account () -> uint32 = p.AccountName.Checksum32
    return account() + p.DeviceName.Checksum32()
}

func CaptureInterface(value IText) uint32 {
    let checksum () -> uint32 = value.Text.Checksum32
    return checksum()
}

let profile = Profile("abc", "de")
let holder IText = TextHolder()
let hasher IHasher = Hasher()
let explicitGroup () -> uint32 = hasher.Hash
Console.WriteLine(CaptureProfile(profile))
Console.WriteLine(CaptureInterface(holder))
Console.WriteLine(explicitGroup())`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func RealPropertyAndParameterlessMethods_WinOverSameNameExtension() {
        let source = `package Repro
import System

import System.Collections.Generic
import System.Linq

func (value string) Trim() string -> "extension"

open class Base {
    func Shape() int32 -> 7
}

class Host : Base {}

class PropertyHost {
    prop Shape int32 -> 11
}

let host = Host()
let inherited () -> int32 = host.Shape
let propertyHost = PropertyHost()
let textTrim () -> string = " padded ".Trim
let values = List[int32]()
values.Add(1)
Console.WriteLine(inherited())
Console.WriteLine(propertyHost.Shape)
Console.WriteLine(textTrim())
Console.WriteLine(values.Count)`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func ImportedExtensionMethodGroup_ConvertsToDelegate() {
        let source = `package Repro
import System
import System.Collections.Generic
import System.Linq

let values = List[int32]()
values.Add(1)
values.Add(2)
let items IEnumerable[int32] = values
let count () -> int32 = items.Count
Console.WriteLine(count())`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func NullForgivingAndNullConditionalExtensionReceivers_Compile() {
        let source = `package Repro
import System

func (text string) Checksum32() uint32 -> uint32(text.Length)

let maybe string? = "abc"
let checksum () -> uint32 = maybe!!.Checksum32
let conditional = maybe?.Checksum32()
Console.WriteLine(checksum())
Console.WriteLine(conditional)`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func AsyncExtensionMethodGroups_ConvertToTaskAndValueTaskDelegatesAndRun() {
        let source = `package Repro
import System
import System.Threading.Tasks

async func (value string) LengthAsync() int32 {
    await Task.Yield()
    return value.Length
}

async func (value string) DelayTextAsync() {
    await Task.Yield()
    Console.WriteLine(value)
}

async func (value string) ValueLengthAsync() ValueTask[int32] {
    await Task.Yield()
    return value.Length
}

async func (value string) ValueDelayAsync() ValueTask {
    await Task.Yield()
    Console.WriteLine("vt:" + value)
}

async func (value int32) ValueAsync() ValueTask[int32] {
    await Task.Yield()
    return value + 1
}

async func (value int32) DelayNumberAsync() {
    await Task.Yield()
    Console.WriteLine(value)
}

async func (value T) DelayIdentityAsync[T]() T {
    await Task.Yield()
    return value
}

async func (value string) ComputeAsync() int32 {
    await Task.Yield()
    return value.Length
}

async func (value string) ComputeAsync(delta int32) int32 {
    await Task.Yield()
    return value.Length + delta
}

delegate AsyncInt() Task[int32];

func MakeIdentity[T](value T) () -> Task[T] -> value.DelayIdentityAsync

func RunTask[T](step () -> Task[T]) T -> step().GetAwaiter().GetResult()

let lengthAsync async () -> int32 = "four".LengthAsync
let explicitTask () -> Task[int32] = "seven".LengthAsync
let clrFunc Func[Task[int32]] = "three".LengthAsync
let namedDelegate AsyncInt = "four".LengthAsync
let inferred = "eight".LengthAsync
let delayAsync async () -> void = "later".DelayTextAsync
let valueLengthAsync () -> ValueTask[int32] = "five".ValueLengthAsync
let valueDelayAsync () -> ValueTask = "soon".ValueDelayAsync
let intValueAsync () -> ValueTask[int32] = (9).ValueAsync
let intDelayAsync async () -> void = (10).DelayNumberAsync
let genericRef async () -> string = "echo".DelayIdentityAsync
let genericVal async () -> int32 = (6).DelayIdentityAsync
let openGenericRef = MakeIdentity("open")
let openGenericVal = MakeIdentity(21)
let overloadZero async () -> int32 = "four".ComputeAsync
let overloadOne async (int32) -> int32 = "four".ComputeAsync

Console.WriteLine(lengthAsync().GetAwaiter().GetResult())
Console.WriteLine(explicitTask().GetAwaiter().GetResult())
Console.WriteLine(clrFunc().GetAwaiter().GetResult())
Console.WriteLine(namedDelegate().GetAwaiter().GetResult())
Console.WriteLine(inferred().GetAwaiter().GetResult())
delayAsync().GetAwaiter().GetResult()
Console.WriteLine(valueLengthAsync().AsTask().GetAwaiter().GetResult())
valueDelayAsync().AsTask().GetAwaiter().GetResult()
Console.WriteLine(intValueAsync().AsTask().GetAwaiter().GetResult())
intDelayAsync().GetAwaiter().GetResult()
Console.WriteLine(genericRef().GetAwaiter().GetResult())
Console.WriteLine(genericVal().GetAwaiter().GetResult())
Console.WriteLine(openGenericRef().GetAwaiter().GetResult())
Console.WriteLine(openGenericVal().GetAwaiter().GetResult())
Console.WriteLine(overloadZero().GetAwaiter().GetResult())
Console.WriteLine(overloadOne(3).GetAwaiter().GetResult())
Console.WriteLine(RunTask("six".LengthAsync))
Console.WriteLine(RunTask((12).DelayIdentityAsync))
Console.WriteLine(Task.Run("nine".LengthAsync).GetAwaiter().GetResult())
Console.WriteLine(Task.Run((15).DelayIdentityAsync).GetAwaiter().GetResult())`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "4",
                "5",
                "5",
                "4",
                "5",
                "later",
                "4",
                "vt:soon",
                "10",
                "10",
                "echo",
                "6",
                "open",
                "21",
                "4",
                "7",
                "3",
                "12",
                "4",
                "15"
            ) +
                Environment.NewLine,
            result.Output
        )
    }

    shared {
        private func AssertCompilesWithoutErrors(source string) {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "Emit failed:\n" + string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        }
    }
}
