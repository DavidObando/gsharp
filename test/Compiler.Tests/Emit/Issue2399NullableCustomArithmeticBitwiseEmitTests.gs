// <copyright file="Issue2399NullableCustomArithmeticBitwiseEmitTests.cs" company="GSharp">
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
import Xunit

/// Issue #2399: same-compilation value structs with custom arithmetic and
/// bitwise operators lift over `Nullable<T>` using CLR nullable
/// semantics. Present operands unwrap and call the emitted `op_*` method;
/// any missing operand propagates a missing nullable result.
open class Issue2399NullableCustomArithmeticBitwiseEmitTests {
    @Fact
    func ArithmeticBitwiseAndShiftOperators_LiftRunAndVerify() {
        const source = `package Issue2399Runtime
import System

struct Word2399(Value int32) { }

func (left Word2399) operator +(right Word2399) Word2399 {
    return Word2399(left.Value + right.Value)
}
func (left Word2399) operator -(right Word2399) Word2399 {
    return Word2399(left.Value - right.Value)
}
func (left Word2399) operator *(right Word2399) Word2399 {
    return Word2399(left.Value * right.Value)
}
func (left Word2399) operator /(right Word2399) Word2399 {
    return Word2399(left.Value / right.Value)
}
func (left Word2399) operator %(right Word2399) Word2399 {
    return Word2399(left.Value % right.Value)
}
func (left Word2399) operator &(right Word2399) Word2399 {
    return Word2399(left.Value & right.Value)
}
func (left Word2399) operator |(right Word2399) Word2399 {
    return Word2399(left.Value | right.Value)
}
func (left Word2399) operator ^(right Word2399) Word2399 {
    return Word2399(left.Value ^ right.Value)
}
func (left Word2399) operator <<(count int32) Word2399 {
    return Word2399(left.Value << count)
}
func (left Word2399) operator >>(count int32) Word2399 {
    return Word2399(left.Value >> count)
}

let left Word2399? = Word2399(12)
let right Word2399? = Word2399(10)
let missing Word2399? = nil
let shift int32? = 2
let missingShift int32? = nil

Console.WriteLine((left + right)!!.Value)
Console.WriteLine((left - right)!!.Value)
Console.WriteLine((left * right)!!.Value)
Console.WriteLine((left / right)!!.Value)
Console.WriteLine((left % right)!!.Value)
Console.WriteLine((left & right)!!.Value)
Console.WriteLine((left | right)!!.Value)
Console.WriteLine((left ^ right)!!.Value)
Console.WriteLine((left << shift)!!.Value)
Console.WriteLine((left >> shift)!!.Value)

Console.WriteLine(left + missing == nil)
Console.WriteLine(left & missing == nil)
Console.WriteLine(left << missingShift == nil)

Console.WriteLine((left + Word2399(1))!!.Value)
Console.WriteLine((Word2399(1) + right)!!.Value)`
        Assert.Equal(
            "22${Environment.NewLine}2${Environment.NewLine}120${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}8${Environment.NewLine}14${Environment.NewLine}6${Environment.NewLine}48${Environment.NewLine}3${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}13${Environment.NewLine}11${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func LiftedApiAndOperatorMetadata_UseNullableResultShapeAndVerify() {
        const source = `package Issue2399Metadata

struct Word2399Metadata(Value int32) { }

func (left Word2399Metadata) operator +(right Word2399Metadata) Word2399Metadata {
    return Word2399Metadata(left.Value + right.Value)
}

func (left Word2399Metadata) operator &(right Word2399Metadata) Word2399Metadata {
    return Word2399Metadata(left.Value & right.Value)
}

func Add2399(left Word2399Metadata?, right Word2399Metadata?) Word2399Metadata? -> left + right
func And2399(left Word2399Metadata?, right Word2399Metadata?) Word2399Metadata? -> left & right`
        let dllPath = CompileLibrary(source)
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                throw InvalidOperationException("Runtime directory not found.")
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let metadataContext = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let assembly = metadataContext.LoadFromAssemblyPath(dllPath)
            let word = assembly.GetType("Issue2399Metadata.Word2399Metadata") ??
                throw InvalidOperationException("Word2399Metadata type not found.")
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            AssertOperatorMetadata(word, "op_Addition")
            AssertOperatorMetadata(word, "op_BitwiseAnd")
            AssertLiftedApiMetadata(program, "Add2399", word)
            AssertLiftedApiMetadata(program, "And2399", word)
        } finally {
            TryDeleteDirectory(Path.GetDirectoryName(dllPath))
        }
    }

    shared {
        private func AssertOperatorMetadata(word Type, methodName string) {
            let method = word.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static) ??
                throw InvalidOperationException("$methodName not found.")
            Assert.True(method.IsSpecialName)
            Assert.Equal(word, method.ReturnType)
            Assert.Equal(
                []Type{word, word},
                method.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType)
            )
        }

        private func AssertLiftedApiMetadata(program Type, methodName string, word Type) {
            let method = program.GetMethod(
                methodName,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            ) ??
                throw InvalidOperationException("$methodName not found.")
            AssertNullableOf(method.ReturnType, word)
            for parameter in method.GetParameters() {
                AssertNullableOf(parameter.ParameterType, word)
            }
        }

        private func AssertNullableOf(type Type, underlying Type) {
            Assert.True(type.IsGenericType)
            Assert.Equal("System.Nullable`1", type.GetGenericTypeDefinition().FullName)
            Assert.Equal(underlying, type.GetGenericArguments()[0])
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2399_run_").FullName
            try {
                let dllPath = Compile(source, tempDir, isLibrary: false)
                IlVerifier.Verify(dllPath)
                let processInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                processInfo.ArgumentList.Add("exec")
                processInfo.ArgumentList.Add("--runtimeconfig")
                processInfo.ArgumentList.Add(Path.ChangeExtension(dllPath, ".runtimeconfig.json"))
                processInfo.ArgumentList.Add(dllPath)
                using let process = Process.Start(processInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                TryDeleteDirectory(tempDir)
            }
        }

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2399_lib_").FullName
            let dllPath = Compile(source, tempDir, isLibrary: true)
            IlVerifier.Verify(dllPath)
            return dllPath
        }

        private func Compile(source string, tempDir string, isLibrary bool) string {
            let sourcePath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + dllPath,
                if isLibrary {
                    "/target:library"
                } else {
                    "/target:exe"
                },
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                sourcePath
            }
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return dllPath
        }

        private func TryDeleteDirectory(directory string?) {
            try {
                if directory != nil && Directory.Exists(directory) {
                    Directory.Delete(directory, recursive: true)
                }
            } catch { }
        }
    }
}
