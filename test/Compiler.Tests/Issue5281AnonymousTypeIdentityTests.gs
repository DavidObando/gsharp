// <copyright file="Issue5281AnonymousTypeIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #5281: an anonymous object literal bound in a top-level statement and one bound in a
/// function body used separate caches that both counted from 0, so the assembly held two TypeDefs
/// named `<>AnonymousType0` and the same shape spelled in both places became two types. The body
/// pass now continues the declaration pass's cache.
/// @remarks Each test was red before the change: the duplicate-name assertion failed on the
/// three-shape program, and the same-shape program emitted two types.
open class Issue5281AnonymousTypeIdentityTests {
    /// Three different shapes, one at top level and two in bodies, get three distinct names.
    @Fact
    func DifferentShapesAtTopLevelAndInBodies_GetUniqueTypeNames() {
        const source = `package Probe

import System

var top = object { let T int32 = 1 }

func F1() int32 {
    let a = object { let X int32 = 1; let Y = "a" }
    return a.X
}

func F2() string {
    let b = object { let P string = "p" }
    return b.P
}

Console.WriteLine(top.T.ToString() + F1().ToString() + F2())
`
        let names = CompileVerifyAndRun("different", source, "11p")
        Assert.Equal(
            []string{"Probe.<>AnonymousType0", "Probe.<>AnonymousType1", "Probe.<>AnonymousType2"},
            names.Where((n string) -> n.Contains("<>AnonymousType", StringComparison.Ordinal)).ToArray()
        )
    }

    /// The same shape at top level and in a body is one type.
    @Fact
    func SameShapeAtTopLevelAndInBody_IsOneType() {
        const source = `package Probe

import System

var top = object { let T int32 = 1 }

func F1() int32 {
    let a = object { let T int32 = 2 }
    return a.T
}

Console.WriteLine(top.T.ToString() + F1().ToString())
`
        let names = CompileVerifyAndRun("same", source, "12")
        Assert.Equal(
            []string{"Probe.<>AnonymousType0"},
            names.Where((n string) -> n.Contains("<>AnonymousType", StringComparison.Ordinal)).ToArray()
        )
    }

    /// A `data object` and a plain object with the same members stay separate types with separate names.
    @Fact
    func DataAndPlainObjectsWithTheSameMembers_StayDistinct() {
        const source = `package Probe

import System

var plain = object { let T int32 = 1 }
var record = data object { let T int32 = 1 }

func F1() int32 {
    let a = data object { let T int32 = 3 }
    return a.T
}

Console.WriteLine(plain.T.ToString() + record.T.ToString() + F1().ToString())
`
        let names = CompileVerifyAndRun("datavsplain", source, "113")
        Assert.Equal(
            []string{"Probe.<>AnonymousType0", "Probe.<>AnonymousType1"},
            names.Where((n string) -> n.Contains("<>AnonymousType", StringComparison.Ordinal)).ToArray()
        )
    }

    shared {
        /// Compiles, asserts every TypeDef name is unique, verifies the IL, runs the program and checks stdout.
        /// @returns The full names of every TypeDef in the emitted assembly.
        private func CompileVerifyAndRun(name string, source string, expected string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_5281_").FullName
            try {
                let appPath = Path.Combine(tempDir, name + ".dll")
                let (exit, log) = Compile(tempDir, source, appPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must compile. Log:
` + "$log"))
                let names = List[string]()
                {
                    using let stream = File.OpenRead(appPath)
                    using let pe = PEReader(stream)
                    let reader = pe.GetMetadataReader()
                    for handle in reader.TypeDefinitions {
                        let type = reader.GetTypeDefinition(handle)
                        names.Add(reader.GetString(type.Namespace) + "." + reader.GetString(type.Name))
                    }
                }
                let duplicates = names.GroupBy((n string) -> n).Where((g IGrouping[string, string]) -> g.Count() > 1)
                    .Select((g IGrouping[string, string]) -> g.Key)
                    .ToArray()
                Assert.Empty(duplicates)
                IlVerifier.Verify(appPath)
                let (runExit, output) = RunDotnet(appPath)
                Assert.True(runExit == 0, (`'` + "$name" + `' must run. Exit ` + "$runExit" + `:
` + "$output"))
                Assert.Equal(expected, output.Trim())
                return names
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func Compile(dir string, source string, outPath string)(Exit int32, Log string) {
            let srcPath = Path.Combine(dir, Path.GetFileNameWithoutExtension(outPath) + ".gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exit, compileOut.ToString() + compileErr.ToString())
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
