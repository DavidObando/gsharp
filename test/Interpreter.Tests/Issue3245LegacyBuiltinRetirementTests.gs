// <copyright file="Issue3245LegacyBuiltinRetirementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Tests
import System
import Xunit

/// Issues #3245 / #3246: the legacy builtins `print`/`input`/`rnd`
/// and the builtin `string(T)` conversion were retired — clean cut, no
/// deprecation path, no dedicated diagnostic. An unresolved reference gets the
/// standard undefined-name error (GS0130 for the function builtins, GS0155
/// cannot-convert for the retired `string(T)` cast); CLR interop
/// (`System.Console`, `.ToString()`) is the supported story. These
/// witnesses pin the exact diagnostics via the emitted oracle, plus the
/// surviving conversions that must not regress: `string(charArray)`
/// (#1441) keeps working, and `Console.WriteLine` remains the interop
/// replacement.
@Collection("ConsoleIo")
open class Issue3245LegacyBuiltinRetirementTests {
    @Fact
    func Print_IsRetired_ReportsStandardUndefinedFunction() {
        let result = EmittedOracle.Evaluate("print(\"x\")")
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0130", diagnostic.Id)
        Assert.Equal("Function 'print' doesn't exist.", diagnostic.Message)
    }

    @Fact
    func Input_IsRetired_ReportsStandardUndefinedFunction() {
        let result = EmittedOracle.Evaluate("var a = input()")
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0130", diagnostic.Id)
        Assert.Equal("Function 'input' doesn't exist.", diagnostic.Message)
    }

    @Fact
    func Rnd_IsRetired_ReportsStandardUndefinedFunction() {
        let result = EmittedOracle.Evaluate("var b = rnd(10)")
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0130", diagnostic.Id)
        Assert.Equal("Function 'rnd' doesn't exist.", diagnostic.Message)
    }

    @Fact
    func StringOfInt_IsRetired_ReportsStandardCannotConvert() {
        let result = EmittedOracle.Evaluate("var s = string(42)")
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0155", diagnostic.Id)
        Assert.Equal("Cannot convert type 'int32' to 'string'.", diagnostic.Message)
    }

    @Fact
    func StringOfImportedClrType_IsRetired_ReportsStandardCannotConvert() {
        let result = EmittedOracle.Evaluate("import System\n" + "var y = string(Guid.NewGuid())")
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0155", diagnostic.Id)
        Assert.Equal("Cannot convert type 'System.Guid' to 'string'.", diagnostic.Message)
    }

    @Fact
    func ClrInterop_ToStringAndConsole_RemainTheSupportedStory() {
        let result = EmittedOracle.Evaluate(`import System
var y = Guid.NewGuid().ToString()
Console.WriteLine(y.Length)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("36" + Environment.NewLine, result.Output)
    }

    @Fact
    func StringFromCharArray_Issue1441Conversion_Survives() {
        let result = EmittedOracle.Evaluate(`import System
let buf = [2]char
buf[0] = 'h'
buf[1] = 'i'
Console.WriteLine(string(buf))`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hi" + Environment.NewLine, result.Output)
    }

    @Fact
    func UserFunctionNamedPrint_IsAnOrdinaryName() {
        // With the builtin gone, `print` is an ordinary identifier: a user
        // function of that name declares and calls without any builtin
        // shadowing in the root scope.
        let result = EmittedOracle.Evaluate(`import System
func print(text string) {
    Console.WriteLine(text)
}
print("hello")`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("hello" + Environment.NewLine, result.Output)
    }
}
