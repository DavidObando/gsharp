// <copyright file="Issue2616CharNumericPromotionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2616 emitter proof for the exact Oahu subtraction.
open class Issue2616CharNumericPromotionEmitTests {
    @Fact
    func ExactOahuKeyCharSubtraction_EmitsAndExecutesAsInt32() {
        const Source = `package Oahu.Cli.Tui
import System

func tabIndex(key ConsoleKeyInfo) int32 {
    let idx = key.KeyChar - '1'
    return idx
}`
        using let pe = MemoryStream()
        let result = Compilation(SyntaxTree.Parse(SourceText.From(Source))).Emit(pe)
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pe.Position = 0
        let context = AssemblyLoadContext("ExactOahuKeyCharSubtraction_EmitsAndExecutesAsInt32", isCollectible: true)
        try {
            let assembly = context.LoadFromStream(pe)
            let method = assembly
                .GetTypes()
                .SelectMany(
                func (t Type) IEnumerable[MethodInfo] {
                    return t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                }
            )
                .Single((m MethodInfo) -> m.Name == "tabIndex")
            Assert.Equal(4, method.Invoke(nil, []object{ConsoleKeyInfo('5', ConsoleKey.D5, false, false, false)}))
        } finally {
            context.Unload()
        }
    }

    @Fact
    func CheckedLiftedCharCompound_EmitsOverflowCheck() {
        let AssertOverflow = func (method MethodInfo, arguments ...object) {
            let exception = Assert.Throws[TargetInvocationException](
                func () object? {
                    return method.Invoke(nil, arguments)
                }
            )
            Assert.IsType[OverflowException](exception.InnerException)
        }
        const Source = `package P

func add(charValue char?) char? {
    var result = charValue
    checked {
        result += 65536
    }
    return result
}

func addOperator(charValue char?, amount uint32?) char? {
    var result = charValue
    checked {
        result += amount
    }
    return result
}

func addDecimal(charValue char?, amount decimal?) char? {
    var result = charValue
    checked {
        result += amount
    }
    return result
}`
        using let pe = MemoryStream()
        let result = Compilation(SyntaxTree.Parse(SourceText.From(Source))).Emit(pe)
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pe.Position = 0
        let context = AssemblyLoadContext("CheckedLiftedCharCompound_EmitsOverflowCheck", isCollectible: true)
        try {
            let assembly = context.LoadFromStream(pe)
            let methods = assembly.GetTypes().SelectMany(
                func (t Type) IEnumerable[MethodInfo] {
                    return t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                }
            )
            AssertOverflow(methods.Single((m MethodInfo) -> m.Name == "add"), char?('A'))
            AssertOverflow(
                methods.Single((m MethodInfo) -> m.Name == "addOperator"),
                char?('A'),
                uint32?(uint32.MaxValue)
            )
            AssertOverflow(methods.Single((m MethodInfo) -> m.Name == "addDecimal"), char?('A'), decimal?(65536m))
        } finally {
            context.Unload()
        }
    }
}
