// <copyright file="Issue1017ConversionOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #1017: user-defined implicit/explicit conversion operators declared in
/// G# with the `func operator implicit/explicit (x T) U` syntax. These emit
/// CLR `op_Implicit`/`op_Explicit` special-name methods and participate
/// in conversion/overload resolution like C#.
/// Each test compiles via in-process `gsc`, IL-verifies the PE, then runs
/// under `dotnet exec` and asserts captured stdout.
open class Issue1017ConversionOperatorEmitTests {
    @Fact
    func Implicit_Conversion_Applied_At_Assignment() {
        let source = `package Test
import System

struct Celsius {
    var degrees float64
}

func operator implicit (c Celsius) float64 {
    return c.degrees
}

let c = Celsius{degrees: 100.0}
let d float64 = c
Console.WriteLine(d)`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}", output)
    }

    @Fact
    func Implicit_Conversion_Applied_At_Argument() {
        let source = `package Test
import System

struct AppleData {
    var bytes []uint8
}

func operator implicit (d AppleData) []uint8 {
    return d.bytes
}

func sumBytes(data []uint8) int32 {
    var total int32 = 0
    for var i = 0; i < data.Length; i = i + 1 {
        total = total + int32(data[i])
    }
    return total
}

let apple = AppleData{bytes: []uint8{uint8(1), uint8(2), uint8(3), uint8(4)}}
Console.WriteLine(sumBytes(apple))`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}", output)
    }

    @Fact
    func Explicit_Conversion_Applied_At_Cast() {
        let source = `package Test
import System

struct AppleData {
    var bytes []uint8
}

func operator explicit (b []uint8) AppleData {
    return AppleData{bytes: b}
}

let raw = []uint8{uint8(7), uint8(8)}
let apple = AppleData(raw)
Console.WriteLine(apple.bytes.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func Both_Implicit_And_Explicit_RoundTrip() {
        let source = `package Test
import System

struct Fahrenheit {
    var degrees float64
}

func operator implicit (f Fahrenheit) float64 {
    return f.degrees
}

func operator explicit (d float64) Fahrenheit {
    return Fahrenheit{degrees: d}
}

let f = Fahrenheit(212.0)
let raw float64 = f
Console.WriteLine(raw)
let back = Fahrenheit(raw)
Console.WriteLine(back.degrees)`
        let output = CompileAndRun(source)
        Assert.Equal("212${Environment.NewLine}212${Environment.NewLine}", output)
    }

    @Fact
    func Emits_SpecialName_Static_OpImplicit_And_OpExplicit() {
        let source = `package Test
import System

struct Celsius {
    var degrees float64
}

func operator implicit (c Celsius) float64 {
    return c.degrees
}

func operator explicit (d float64) Celsius {
    return Celsius{degrees: d}
}

let c = Celsius{degrees: 1.0}
Console.WriteLine(c.degrees)`
        let dllPath = CompileToDll(source)
        try {
            using let fs = File.OpenRead(dllPath)
            using let pe = PEReader(fs)
            let md = pe.GetMetadataReader()
            var opImplicit MethodDefinition? = nil
            var opExplicit MethodDefinition? = nil
            for handle in md.MethodDefinitions {
                let method = md.GetMethodDefinition(handle)
                let name = md.GetString(method.Name)
                if name == "op_Implicit" {
                    opImplicit = method
                } else if name == "op_Explicit" {
                    opExplicit = method
                }
            }
            Assert.True((opImplicit != nil), "op_Implicit not emitted")
            Assert.True((opExplicit != nil), "op_Explicit not emitted")
            for m in[]MethodDefinition{opImplicit!!, opExplicit!!} {
                Assert.True(m.Attributes.HasFlag(MethodAttributes.Static), "conversion op must be static")
                Assert.True(m.Attributes.HasFlag(MethodAttributes.SpecialName), "conversion op must be specialname")
                Assert.True(m.Attributes.HasFlag(MethodAttributes.HideBySig), "conversion op must be hidebysig")
                Assert.True(m.Attributes.HasFlag(MethodAttributes.Public), "conversion op must be public")
            }
        } finally {
            try {
                Directory.Delete(Path.GetDirectoryName(dllPath)!!, recursive: true)
            } catch { }
        }
    }

    shared {
        private func CompileToDll(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1017_md_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add("/nowarn:GS9100")
            args.Add(srcPath)
            let prevOut = Console.Out
            let prevErr = Console.Error
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return outPath
        }

        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`gsc/exec failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1017_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                if compileExit != 0 {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
