// <copyright file="Issue660InlineDataNilEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.ObjectModel
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #660: verifies that `nil` in `@InlineData` compiles
/// correctly when the corresponding method parameter is a nullable
/// reference type, and that the attribute blob contains the expected
/// null reference.
open class Issue660InlineDataNilEmitTests {
    @Fact
    func NilInInlineData_WithNullableParam_Compiles_And_EmitsNull() {
        // Case 1: @InlineData(nil, ...) with string? parameter → success
        let source = `package Probe.Tests
import Xunit

class Tests {
    @Theory
    @InlineData(nil, "abc", false)
    @InlineData("abc", "abc", true)
    func Equal_Compare(a string?, b string, expected bool) {
        Assert.Equal(expected, a == b)
    }
}`
        let assembly = CompileToAssembly(source)
        let testsType = assembly.GetTypes().Single((t Type) -> t.Name == "Tests")
        let method MethodInfo? = testsType.GetMethod(
            "Equal_Compare",
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic
        )
        Assert.NotNull(method)
        // Verify InlineData attributes are emitted
        let inlineDataAttrs = method!!
            .GetCustomAttributesData()
            .Where((d CustomAttributeData) -> d.AttributeType.Name == "InlineDataAttribute")
            .ToList()
        Assert.Equal(2, inlineDataAttrs.Count)
        // The first InlineData should have null as first element in the object[] blob
        let firstArgs = inlineDataAttrs[0].ConstructorArguments
        Assert.Single(firstArgs)
        let firstArray ReadOnlyCollection[CustomAttributeTypedArgument]? = firstArgs[0].Value as ReadOnlyCollection[
            CustomAttributeTypedArgument
        ]
        Assert.NotNull(firstArray)
        Assert.Equal(3, firstArray!!.Count)
        Assert.Null(firstArray!![0].Value) // nil → null in the blob
        Assert.Equal("abc", firstArray!![1].Value)
    }

    @Fact
    func NilInInlineData_WithNonNullableParam_Reports_GS0274() {
        // Case 2: @InlineData(nil, ...) with non-nullable string → GS0274
        let source = `package Probe.Tests
import Xunit

class Tests {
    @Theory
    @InlineData(nil, "abc", false)
    func Equal_Compare(a string, b string, expected bool) {
        Assert.Equal(expected, a == b)
    }
}`
        let (exitCode, stdout, stderr) = CompileRaw(source)
        let output = stdout + stderr
        Assert.Contains("GS0274", output)
        Assert.Contains("nil", output)
        Assert.Contains("string?", output)
    }

    @Fact
    func NullIdentifier_InInlineData_Reports_GS0273() {
        // Case 3: @InlineData(null, ...) → GS0273 suggesting nil
        let source = `package Probe.Tests
import Xunit

class Tests {
    @Theory
    @InlineData(null, "abc", false)
    func Equal_Compare(a string?, b string, expected bool) {
        Assert.Equal(expected, a == b)
    }
}`
        let (exitCode, stdout, stderr) = CompileRaw(source)
        let output = stdout + stderr
        Assert.Contains("GS0273", output)
        Assert.Contains("nil", output)
    }

    shared {
        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue660_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return EmittedFixture.Load(outPath)
        }

        private func CompileRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue660_diag_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, compileOut.ToString(), compileErr.ToString())
        }
    }
}
