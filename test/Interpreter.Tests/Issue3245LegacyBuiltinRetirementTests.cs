// <copyright file="Issue3245LegacyBuiltinRetirementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issues #3245 / #3246: the legacy builtins <c>print</c>/<c>input</c>/<c>rnd</c>
/// and the builtin <c>string(T)</c> conversion were retired — clean cut, no
/// deprecation path, no dedicated diagnostic. An unresolved reference gets the
/// standard undefined-name error (GS0130 for the function builtins, GS0155
/// cannot-convert for the retired <c>string(T)</c> cast); CLR interop
/// (<c>System.Console</c>, <c>.ToString()</c>) is the supported story. These
/// witnesses pin the exact diagnostics via the emitted oracle, plus the
/// surviving conversions that must not regress: <c>string(charArray)</c>
/// (#1441) keeps working, and <c>Console.WriteLine</c> remains the interop
/// replacement.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3245LegacyBuiltinRetirementTests
{
    [Fact]
    public void Print_IsRetired_ReportsStandardUndefinedFunction()
    {
        var result = EmittedOracle.Evaluate("print(\"x\")");

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0130", diagnostic.Id);
        Assert.Equal("Function 'print' doesn't exist.", diagnostic.Message);
    }

    [Fact]
    public void Input_IsRetired_ReportsStandardUndefinedFunction()
    {
        var result = EmittedOracle.Evaluate("var a = input()");

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0130", diagnostic.Id);
        Assert.Equal("Function 'input' doesn't exist.", diagnostic.Message);
    }

    [Fact]
    public void Rnd_IsRetired_ReportsStandardUndefinedFunction()
    {
        var result = EmittedOracle.Evaluate("var b = rnd(10)");

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0130", diagnostic.Id);
        Assert.Equal("Function 'rnd' doesn't exist.", diagnostic.Message);
    }

    [Fact]
    public void StringOfInt_IsRetired_ReportsStandardCannotConvert()
    {
        var result = EmittedOracle.Evaluate("var s = string(42)");

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0155", diagnostic.Id);
        Assert.Equal("Cannot convert type 'int32' to 'string'.", diagnostic.Message);
    }

    [Fact]
    public void StringOfImportedClrType_IsRetired_ReportsStandardCannotConvert()
    {
        var result = EmittedOracle.Evaluate(
            "import System\n" +
            "var y = string(Guid.NewGuid())");

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0155", diagnostic.Id);
        Assert.Equal("Cannot convert type 'System.Guid' to 'string'.", diagnostic.Message);
    }

    [Fact]
    public void ClrInterop_ToStringAndConsole_RemainTheSupportedStory()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            var y = Guid.NewGuid().ToString()
            Console.WriteLine(y.Length)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("36" + Environment.NewLine, result.Output);
    }

    [Fact]
    public void StringFromCharArray_Issue1441Conversion_Survives()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            let buf = [2]char
            buf[0] = 'h'
            buf[1] = 'i'
            Console.WriteLine(string(buf))
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi" + Environment.NewLine, result.Output);
    }

    [Fact]
    public void UserFunctionNamedPrint_IsAnOrdinaryName()
    {
        // With the builtin gone, `print` is an ordinary identifier: a user
        // function of that name declares and calls without any builtin
        // shadowing in the root scope.
        var result = EmittedOracle.Evaluate("""
            import System
            func print(text string) {
                Console.WriteLine(text)
            }
            print("hello")
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("hello" + Environment.NewLine, result.Output);
    }
}
