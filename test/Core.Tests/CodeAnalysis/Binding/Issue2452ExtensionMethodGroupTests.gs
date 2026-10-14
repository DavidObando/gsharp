// <copyright file="Issue2452ExtensionMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
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
