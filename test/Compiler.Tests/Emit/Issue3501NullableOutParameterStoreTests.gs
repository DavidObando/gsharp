// <copyright file="Issue3501NullableOutParameterStoreTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #3501: assigning through an `out`/`ref` parameter of
/// value-type nullable type (`out x int32?`) emitted `stind.i4`
/// instead of `stobj Nullable<int32>` — NullableTypeSymbol borrows
/// the UNDERLYING type's ClrType, so the indirect-store opcode selection saw
/// a bare int (ilverify StackUnexpected; hit by the migrated Translator's
/// `TryClassifyStructInitializerValue`). Load and store indirection now
/// route value-type nullables through ldobj/stobj.
open class Issue3501NullableOutParameterStoreTests {
    @Fact
    func NullableIntOutParameter_AssignsAndReads() {
        const Source = `package Issue3501
import System

func TryPick(value int32, out ordinal int32?) bool {
    if value > 0 {
        ordinal = value
        return true
    }
    ordinal = nil
    return false
}

func Main() {
    var slot int32? = nil
    if TryPick(7, out slot) {
        Console.WriteLine(slot!!.ToString())
    }
    var missing int32? = 3
    if !TryPick(-1, out missing) {
        Console.WriteLine((missing == nil).ToString())
    }
}`
        Assert.Equal("7${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(Source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "issue3501nullout",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3501NullOut.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                var previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(outputPath)
                let assembly = EmittedFixture.Load(outputPath)
                let _ = assembly.GetTypes()
                let entryPoint = assembly.EntryPoint ??
                    throw InvalidOperationException("Emitted assembly has no entry point.")
                previousOut = Console.Out
                using let output = StringWriter()
                Console.SetOut(output)
                try {
                    entryPoint.Invoke(
                        nil,
                        if entryPoint.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(previousOut)
                }
                return output.ToString()
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
