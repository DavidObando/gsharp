// <copyright file="Issue2492NullableBoxedConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2492 end-to-end coverage for nullable object/interface sources
/// explicitly unboxed to nullable value types.
class Issue2492NullableBoxedConversionEmitTests {
    @Fact
    func NullableObject_ToNullableUInt32_ReflectsUnboxAnySemantics() {
        const source = `package issue2492reflection

func Convert(value object?) uint32? -> uint32?(value)`
        let assembly = CompileLibrary(source)
        let method = GetProgramMethod(assembly, "Convert")
        Assert.Equal(typeof(uint32?), method.ReturnType)
        Assert.Null(method.Invoke(nil, []object? {nil}))
        Assert.Equal(2492u, method.Invoke(nil, []object{2492u}))
        let exception = Assert.Throws[TargetInvocationException](
            func () object? {
                return method.Invoke(nil, []object{2492})
            }
        )
        Assert.IsType[InvalidCastException](exception.InnerException)
        let il = method.GetMethodBody()!!.GetILAsByteArray()!!
        Assert.Contains(uint8(0xA5), il) // unbox.any

    }

    @Fact
    func NullableObject_ToNullableImportedStruct_PropagatesNullAndValue() {
        const source = `package issue2492imported
import System

func Convert(value object?) Guid? -> Guid?(value)`
        let assembly = CompileLibrary(source)
        let method = GetProgramMethod(assembly, "Convert")
        let expected = Guid.NewGuid()
        Assert.Equal(typeof(Guid?), method.ReturnType)
        Assert.Null(method.Invoke(nil, []object? {nil}))
        Assert.Equal(expected, method.Invoke(nil, []object{expected}))
    }

    @Fact
    func NullableValueTypeAndEnumBaseSources_UnboxCompatibleNullableTargets() {
        const source = `package issue2492boxedbases
import System

func ConvertValue(value ValueType?) Guid? -> Guid?(value)
func ConvertEnum(value Enum?) DayOfWeek? -> DayOfWeek?(value)`
        let assembly = CompileLibrary(source)
        let convertValue = GetProgramMethod(assembly, "ConvertValue")
        let convertEnum = GetProgramMethod(assembly, "ConvertEnum")
        let guid = Guid.NewGuid()
        Assert.Null(convertValue.Invoke(nil, []object? {nil}))
        Assert.Equal(guid, convertValue.Invoke(nil, []object{guid}))
        Assert.Null(convertEnum.Invoke(nil, []object? {nil}))
        Assert.Equal(DayOfWeek.Friday, convertEnum.Invoke(nil, []object{DayOfWeek.Friday}))
    }

    @Fact
    func SameCompilationStructAndEnum_RoundTripThroughNullableObject() {
        const source = `package issue2492user
import System

struct Point2492(Value int32) {}
enum Color2492 { Red, Green }

func Main() {
    let pointBox object? = Point2492(7)
    let point Point2492? = Point2492?(pointBox)
    Console.WriteLine(point!!.Value)

    let colorBox object? = Color2492.Green
    let color Color2492? = Color2492?(colorBox)
    Console.WriteLine(int32(color!!))

    let missing object? = nil
    let noPoint Point2492? = Point2492?(missing)
    let noColor Color2492? = Color2492?(missing)
    Console.WriteLine(noPoint == nil)
    Console.WriteLine(noColor == nil)
}`
        Assert.Equal(
            "7${Environment.NewLine}1${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func StructConstrainedGenericNullableTarget_RoundTrips() {
        const source = `package issue2492generic
import System

func Convert[T struct](value object?) T? -> T?(value)

func Main() {
    let boxed object? = 42
    let present int32? = Convert[int32](boxed)
    Console.WriteLine(present!!)

    let missing object? = nil
    let absent int32? = Convert[int32](missing)
    Console.WriteLine(absent == nil)
}`
        Assert.Equal("42${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NullableImportedAndUserInterfaces_UnboxMatchingValues() {
        const source = `package issue2492interfaces
import System

interface IBox2492 {}
struct Box2492(Value int32) : IBox2492 {}

func FromImported(value IComparable?) int32? -> int32?(value)
func FromUser(value IBox2492?) Box2492? -> Box2492?(value)

func Main() {
    let imported IComparable? = 17
    Console.WriteLine(FromImported(imported)!!)

    let user IBox2492? = Box2492(23)
    Console.WriteLine(FromUser(user)!!.Value)
}`
        Assert.Equal("17${Environment.NewLine}23${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PatternNarrowedInterfaceSource_UsesCheckedUnboxing() {
        const source = `package issue2492pattern
import System

func Convert(value object?) int32? {
    if value is IComparable {
        return int32?(value)
    }

    return nil
}

func Main() {
    Console.WriteLine(Convert(31)!!)
    Console.WriteLine(Convert(nil) == nil)
}`
        Assert.Equal("31${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func GetProgramMethod(assembly Assembly, name string) MethodInfo {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            return program.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static) ??
                throw InvalidOperationException("Method '$name' was not emitted.")
        }

        private func CompileLibrary(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_2492_lib_").FullName
            try {
                let sourcePath = Path.Combine(tempDir, "test.gs")
                let outputPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(sourcePath, source)
                let (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "library")
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                IlVerifier.Verify(outputPath)
                return EmittedFixture.Load(outputPath)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2492_exe_").FullName
            try {
                let sourcePath = Path.Combine(tempDir, "test.gs")
                let outputPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(sourcePath, source)
                let (exitCode, stdout, stderr) = Compile(sourcePath, outputPath, "exe")
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                IlVerifier.Verify(outputPath)
                let runtimeConfig = Path.ChangeExtension(outputPath, ".runtimeconfig.json")
                if !File.Exists(runtimeConfig) {
                    File.WriteAllText(runtimeConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(runtimeConfig)
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let runtimeOutput = process.StandardOutput.ReadToEnd()
                let runtimeError = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`dotnet exec failed (` + "${process.ExitCode}" + `):
stdout:
` + "$runtimeOutput" + `
stderr:
` + "$runtimeError"))
                return runtimeOutput.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func Compile(sourcePath string, outputPath string, target string)(
            ExitCode int32,
            Stdout string,
            Stderr string
        ) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:" + target, "/targetframework:net10.0", sourcePath}
                )
                return (exitCode, stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
