// <copyright file="Issue5623MissingEntryPointTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.IO
import System.Reflection.PortableExecutable
import Xunit

/// Issue #5623: gsc reports GS0634 for an executable without an entry point, as C# reports CS5001.
/// Before the correction, gsc wrote the executable and the program failed at start with `MissingMethodException`.
/// The tests run the gsc process that the SDK runs.
open class Issue5623MissingEntryPointTests {
    @Theory
    @InlineData("Lowercase", "/target:exe", "lower.gs(5,6,5,10): error GS0634: ", true)
    @InlineData("ClassLowercase", "/target:exe", "lower.gs(4,10,4,14): error GS0634: ", true)
    @InlineData("StructLowercase", "/target:exe", "lower.gs(5,14,5,18): error GS0634: ", true)
    @InlineData("NoFunction", "/target:exe", "lower.gs(1,1,1,1): error GS0634: ", false)
    @InlineData("NoFunction", "/target:winexe", "lower.gs(1,1,1,1): error GS0634: ", false)
    @InlineData("Lowercase", "", "lower.gs(5,6,5,10): error GS0634: ", true)
    func Executable_WithoutEntryPoint_ReportsGs0634(shape string, target string, location string, hint bool) {
        let (exit, output, entryPoint) = Compile(Source(shape), target)
        Assert.NotEqual(0, exit)
        Assert.Contains(
            location +
                "The program has no entry point. Declare 'func Main()', write top-level statements, or set <OutputType>Library</OutputType>.",
            output,
            StringComparison.Ordinal
        )
        let hintText = " Did you mean 'Main'? Entry-point names are case-sensitive, so 'main' is not an entry point."
        if hint {
            Assert.Contains(hintText, output, StringComparison.Ordinal)
        } else {
            Assert.DoesNotContain("Did you mean", output, StringComparison.Ordinal)
        }
        Assert.Single(output.Split('\n'), (line string) -> line.Contains("GS0634", StringComparison.Ordinal))
        Assert.True(entryPoint == nil, "gsc must not leave an executable without an entry point")
    }

    // A severity override changes only the display of GS0634. gsc still writes no executable and fails.
    @Theory
    @InlineData("/gsdiag:GS0634=none")
    @InlineData("/gsdiag:GS0634=warning")
    func Executable_WithoutEntryPoint_SeverityOverride_StillFails(option string) {
        let (exit, output, entryPoint) = Compile(Source("Lowercase"), option)
        Assert.NotEqual(0, exit)
        Assert.DoesNotContain("error GS0634", output, StringComparison.Ordinal)
        Assert.True(entryPoint == nil, output)
    }

    // gsc writes no executable when another error stops the output, so GS0634 does not add a second error.
    @Fact
    func Executable_WithAnotherError_ReportsOnlyThatError() {
        let (exit, output, entryPoint) = Compile(Source("LowercaseWithError"), "/target:exe")
        Assert.NotEqual(0, exit)
        Assert.Contains("lower.gs(6,23,6,29): error GS0155: ", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0634", output, StringComparison.Ordinal)
        Assert.True(entryPoint == nil, output)
    }

    @Theory
    @InlineData("PackageMain", "/target:exe", true)
    @InlineData("ClassMain", "/target:exe", true)
    @InlineData("StructMain", "/target:exe", true)
    @InlineData("StructMainWithArgs", "/target:exe", true)
    @InlineData("TopLevel", "/target:exe", true)
    @InlineData("Lowercase", "/target:library", false)
    @InlineData("NoFunction", "/target:library", false)
    func Program_WithEntryPointOrLibrary_HasNoGs0634(shape string, target string, executable bool) {
        let (exit, output, entryPoint) = Compile(Source(shape), target)
        Assert.True(exit == 0, output)
        Assert.DoesNotContain("GS0634", output, StringComparison.Ordinal)
        Assert.True(entryPoint != nil, output)
        Assert.Equal(executable, entryPoint != 0)
    }

    shared {
        private func Source(shape string) string -> switch shape {
            case "Lowercase": `package NoEntry

import System

func main() {
    Console.WriteLine("Hello")
}
`
            case "LowercaseWithError": `package NoEntry

import System

func main() {
    let value int32 = "text"
    Console.WriteLine(value)
}
`
            case "ClassLowercase": `package NoEntry

shared class Program {
    func main(args []string) { }
}
`
            case "StructLowercase": `package NoEntry

struct Program {
    shared {
        func main() { }
    }
}
`
            case "NoFunction": `package NoEntry

class Widget { }
`
            case "PackageMain": `package NoEntry

func Main() { }
`
            case "ClassMain": `package NoEntry

shared class Program {
    func Main(args []string) { }
}
`
            case "StructMain": `package NoEntry

struct Program {
    shared {
        func Main() { }
    }
}
`
            case "StructMainWithArgs": `package NoEntry

struct Program {
    shared {
        func Main(args []string) int32 -> args.Length
    }
}
`
            case "TopLevel": `System.Console.WriteLine("Hello")
`
            default: throw ArgumentOutOfRangeException(nameof(shape), shape, nil)
        }

        // Returns the entry-point token of the written assembly, or nil when gsc wrote no assembly.
        private func Compile(source string, option string)(Exit int32, Output string, EntryPoint int32?) {
            let directory = Directory.CreateTempSubdirectory("gs5623-")
            try {
                let sourcePath = Path.Combine(directory.FullName, "lower.gs")
                File.WriteAllText(sourcePath, source)
                let assembly = Path.Combine(directory.FullName, "out", "NoEntry.dll")
                let arguments = if option.Length == 0 {
                    []string{"/out:$assembly", sourcePath}
                } else {
                    []string{"/out:$assembly", option, sourcePath}
                }
                let (exit, stdout, stderr) = ByteStringLanguageTests.RunDriver("Compiler", "gsc.dll", arguments)
                if !File.Exists(assembly) {
                    return (exit, stdout + stderr, nil)
                }
                using let stream = File.OpenRead(assembly)
                using let reader = PEReader(stream)
                return (exit, stdout + stderr, reader.PEHeaders.CorHeader!!.EntryPointTokenOrRelativeVirtualAddress)
            } finally {
                directory.Delete(recursive: true)
            }
        }
    }
}
