// <copyright file="Issue3956NamedTupleGenericArgumentIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3956 / ADR-0172: tuple element names are metadata over the positional
/// shape, so a generic instantiation recovered from a CLR signature
/// (`KeyValuePair<string, ValueTuple<…>>`) and the same
/// instantiation written in G# with element NAMES are one and the same type.
/// The binder classifies the conversion between them as identity; the emitter
/// used to key its identity fast path on symbol REFERENCE equality alone and
/// fell through every structural arm to a `NotSupportedException`.
///
/// The names sit two levels deep — inside a `List`, inside a tuple,
/// inside a `KeyValuePair` — so a top-level-only fix does not pass these.
/// Every case COMPILES, ILVERIFIES and EXECUTES: an emitter defect of this kind
/// can bind clean and still produce a body the verifier or the runtime
/// rejects.
class Issue3956NamedTupleGenericArgumentIdentityTests {
    /// The shape from the issue, verbatim: a LINQ call over a dictionary whose
    /// value type is a named tuple carrying a `List` of named tuples. The
    /// return type comes back from the CLR signature unnamed, and flows into a
    /// slot whose declared type carries every name.
    @Fact
    func NestedNamedTupleGenericArgument_ClrRecoveredKeyValuePair_CompileVerifyAndRun() {
        const Source = `package Issue3956

import System
import System.Linq
import System.Collections.Generic

let blobs = Dictionary[string, (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])]()
let awaits = List[(Yield int32, Resume int32, ResumeRid int32)]()
awaits.Add((11, 22, 33))
blobs["sum2"] = (7, 9, awaits)

let only = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])]) bool {
    return kv.Key == "sum2"
})

Console.WriteLine(only.Value.Rid)
Console.WriteLine(only.Value.CatchHandlerPlusOne)
Console.WriteLine(only.Value.Awaits[0].Resume)`
        Assert.Equal(
            "7${Environment.NewLine}9${Environment.NewLine}22${Environment.NewLine}",
            CompileVerifyAndRun(Source)
        )
    }

    /// The reverse direction: the CLR-recovered UNNAMED shape is the target and
    /// the named shape is the source. Names are metadata in both directions.
    @Fact
    func NestedNamedTupleGenericArgument_NamedSourceToUnnamedTarget_CompileVerifyAndRun() {
        const Source = `package Issue3956

import System
import System.Linq
import System.Collections.Generic

let blobs = Dictionary[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]()
let awaits = List[(Yield int32, Resume int32)]()
awaits.Add((4, 5))
blobs["a"] = (1, awaits)

let only KeyValuePair[string, (int32, List[(int32, int32)])] = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]) bool {
    return kv.Key == "a"
})

Console.WriteLine(only.Value.Item1)
Console.WriteLine(only.Value.Item2[0].Item2)`
        Assert.Equal("1${Environment.NewLine}5${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    /// A NESTED-ONLY name difference: both sides spell the outer tuple's names
    /// identically and differ only inside the `List` element two levels
    /// down. A fix that compares only the top-level tuple's names passes the
    /// cases above and fails this one.
    @Fact
    func NestedNamedTupleGenericArgument_InnerNamesOnly_CompileVerifyAndRun() {
        const Source = `package Issue3956

import System
import System.Linq
import System.Collections.Generic

let blobs = Dictionary[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]()
let awaits = List[(Yield int32, Resume int32)]()
awaits.Add((6, 7))
blobs["a"] = (2, awaits)

let only KeyValuePair[string, (Rid int32, Awaits List[(int32, int32)])] = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]) bool {
    return kv.Key == "a"
})

Console.WriteLine(only.Value.Rid)
Console.WriteLine(only.Value.Awaits[0].Item1)`
        Assert.Equal("2${Environment.NewLine}6${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3956NamedTupleGenericArgumentIdentityTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3956.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths() {
                    arguments.Add("/r:" + reference)
                }
                arguments.Add(sourcePath)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$standardOut$standardError")
                IlVerifier.Verify(outputPath)
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, error)
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
