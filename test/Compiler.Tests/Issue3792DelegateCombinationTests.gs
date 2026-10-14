// <copyright file="Issue3792DelegateCombinationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3792: delegate combination lowers through Delegate.Combine/Remove.
open class Issue3792DelegateCombinationTests {
    /// Compiles, IL-verifies, executes, and checks each case.
    @Theory
    @MemberData("Cases")
    func DelegateCombination_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3792_").FullName
        try {
            let sourcePath = Path.Combine(tempDir, "Program.gs")
            let outputPath = Path.Combine(tempDir, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(sourcePath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(compileExit == 0, (`gsc failed for '` + "$name" + `':
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outputPath)
            let (exitCode, output) = RunDotnet(outputPath)
            Assert.True(exitCode == 0, (`'` + "$name" + `' exited ` + "$exitCode" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets executable delegate-combination cases.
        func Cases() sequence[[]object] {
            yield[]object{"imported-local-and-expression", `package P
import System

func First() { Console.WriteLine("first") }
func Second() { Console.WriteLine("second") }

let first Action = First
let second Action = Second
let pair = first + second
pair()
let removed = pair - first
removed?()

let leftNil = nil + first
leftNil()
let rightNil = first + nil
rightNil()

var callbacks Action? = nil
callbacks += nil
callbacks += first
callbacks += second
callbacks -= nil
callbacks -= first
callbacks?()
callbacks -= second
Console.WriteLine(callbacks == nil)`, []string{"first", "second", "second", "first", "first", "second", "True"}}
            yield[]object{"structural-local", `package P
import System

let first (() -> void) = () -> Console.WriteLine("structural-first")
let second (() -> void) = () -> Console.WriteLine("structural-second")
var callbacks (() -> void)? = nil
callbacks = callbacks + first
callbacks += second
callbacks?()
callbacks -= first
callbacks?()
callbacks = callbacks - second
Console.WriteLine(callbacks == nil)`, []string{"structural-first", "structural-second", "structural-second", "True"}}
            yield[]object{"named-field-and-property", `package P
import System

delegate Handler(value string);

func First(value string) { Console.WriteLine("first:" + value) }
func Second(value string) { Console.WriteLine("second:" + value) }

class Box {
    var Field Handler? = nil
    prop Property Handler? { get; set; }

    func Add(value Handler) {
        Field += value
        Property += value
    }

    func Remove(value Handler) {
        Field -= value
        Property -= value
    }
}

let first Handler = First
let second Handler = Second
let box = Box()
box.Add(first)
box.Add(second)
box.Field?("field")
box.Property?("property")
box.Remove(first)
box.Field?("field-removed")
box.Property?("property-removed")`, []string{
                    "first:field",
                    "second:field",
                    "first:property",
                    "second:property",
                    "second:field-removed",
                    "second:property-removed"
                }}
            yield[]object{"source-and-clr-method-groups", `package P
import System

func Print(value string) { Console.WriteLine("source:" + value) }
func Print(value int32) { Console.WriteLine(value) }

let seed Action[string] = (value string) -> Console.WriteLine("seed:" + value)
let source = seed + Print
let clr = source + Console.WriteLine
clr("value")
var callbacks Action[string]? = seed
callbacks += Print
callbacks += Console.WriteLine
callbacks -= Print
callbacks?("compound")`, []string{"seed:value", "source:value", "value", "seed:compound", "compound"}}
        }

        private func RunDotnet(assemblyPath string)(ExitCode int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(tpa) {
                Enumerable.Empty[string]()
            } else {
                tpa!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}
