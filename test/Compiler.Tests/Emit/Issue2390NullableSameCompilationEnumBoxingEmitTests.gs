// <copyright file="Issue2390NullableSameCompilationEnumBoxingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2390: a nullable value type whose underlying enum is emitted in the
/// same compilation has the CLR shape `Nullable<E>`, even though
/// neither the enum nor the constructed nullable has a reflection
/// (cref:Type) during binding. Boxing conversion classification must
/// preserve that effective value-type shape, and emission must consume the
/// existing symbolic `Nullable<E>` TypeSpec token rather than the
/// underlying enum token.
open class Issue2390NullableSameCompilationEnumBoxingEmitTests {
    @Fact
    func DirectCallReturnObjectAndInterfaceConversions_RunAndVerify() {
        const source = `package i2390
import System

enum Color2390 { Red, Green, Blue }
struct Point2390(X int32) { }

interface ISource2390[T struct] {
    func Find() T?;
}

class Source2390 : ISource2390[Color2390] {
    func Find() Color2390? -> Color2390.Blue
}

func Identity(value object) object -> value
func ReturnObject(value Color2390?) object -> value
func ReturnComparable(value Color2390?) IComparable -> value

func main() {
    let present Color2390? = Color2390.Green
    let missing Color2390? = nil
    let point Point2390? = Point2390(7)

    let direct object = present
    Console.WriteLine(direct.GetType().Name)
    let boxedPoint object = point
    Console.WriteLine(boxedPoint.GetType().Name)
    Console.WriteLine(Identity(present).GetType().Name)
    Console.WriteLine(ReturnObject(present).GetType().Name)
    Console.WriteLine(ReturnObject(missing))
    Console.WriteLine(ReturnComparable(present).CompareTo(Color2390.Green))

    let source ISource2390[Color2390] = Source2390{}
    Console.WriteLine(source.Find())
}

main()`
        Assert.Equal(
            "Color2390${Environment.NewLine}Point2390${Environment.NewLine}Color2390${Environment.NewLine}Color2390${Environment.NewLine}${Environment.NewLine}0${Environment.NewLine}Blue${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ImportedGenericInterfaceCall_NullableEnumReturn_BoxesAndVerifies() {
        const csSource = `namespace Issue2390Ref;

public interface ISource<T>
    where T : struct
{
    T? Find();
}`
        const source = `package i2390imported
import System
import Issue2390Ref

enum Color2390Imported { Red, Green, Blue }

class Source2390Imported : ISource[Color2390Imported] {
    func Find() Color2390Imported? -> Color2390Imported.Blue
}

func main() {
    let source ISource[Color2390Imported] = Source2390Imported{}
    Console.WriteLine(source.Find())
}

main()`
        let reference = CompileCsReference(csSource, "Issue2390Ref")
        try {
            Assert.Equal("Blue${Environment.NewLine}", CompileAndRun(source, reference))
        } finally {
            TryDeleteDirectory(Path.GetDirectoryName(reference))
        }
    }

    @Fact
    func ReflectionInvoke_BoxMethod_PreservesNullableBoxingSemantics() {
        const source = `package i2390reflection

enum Color2390Reflection { Red, Green, Blue }

class Boxer2390 {
    func Box(value Color2390Reflection?) object -> value
}`
        let dllPath = CompileLibrary(source)
        let loadContext = AssemblyLoadContext("Issue2390Reflection", isCollectible: true)
        try {
            let assembly = loadContext.LoadFromAssemblyPath(dllPath)
            let colorType = assembly.GetType("i2390reflection.Color2390Reflection") ??
                throw InvalidOperationException("Color2390Reflection type not found.")
            let boxerType = assembly.GetType("i2390reflection.Boxer2390") ??
                throw InvalidOperationException("Boxer2390 type not found.")
            let box = boxerType.GetMethod("Box", BindingFlags.Public | BindingFlags.Instance) ??
                throw InvalidOperationException("Box method not found.")
            let boxer = Activator.CreateInstance(boxerType) ??
                throw InvalidOperationException("Could not create Boxer2390.")
            let green = Enum.ToObject(colorType, 1)
            let boxed object? = box.Invoke(boxer, []object{green})
            Assert.NotNull(boxed)
            Assert.Equal(colorType, boxed!!.GetType())
            Assert.Equal("Green", boxed!!.ToString())
            Assert.Null(box.Invoke(boxer, []object? {nil}))
        } finally {
            loadContext.Unload()
            TryDeleteDirectory(Path.GetDirectoryName(dllPath))
        }
    }

    shared {
        private func CompileAndRun(source string, additionalReference string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2390_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                if additionalReference != nil {
                    args.Add("/reference:" + additionalReference)
                }
                args.Add(srcPath)
                Compile(args)
                IlVerifier.Verify(
                    dllPath,
                    additionalReferences: if additionalReference == nil {
                        default([]?string)
                    } else {
                        []string{additionalReference}
                    }
                )
                if additionalReference != nil {
                    File.Copy(
                        additionalReference,
                        Path.Combine(tempDir, Path.GetFileName(additionalReference)),
                        overwrite: true
                    )
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(dllPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(dllPath)
                using let process = Process.Start(psi) ??
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
            let tempDir = Directory.CreateTempSubdirectory("gs_2390_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            Compile(List[string]{"/out:" + dllPath, "/target:library", "/targetframework:net10.0", srcPath})
            IlVerifier.Verify(dllPath)
            return dllPath
        }

        private func Compile(args List[string]) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }

        private func CompileCsReference(source string, assemblyName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2390_ref_").FullName
            File.WriteAllText(Path.Combine(tempDir, "Lib.cs"), source)
            File.WriteAllText(Path.Combine(tempDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <AssemblyName>` + "$assemblyName" + `</AssemblyName>
  </PropertyGroup>
</Project>`))
            RunDotnet(tempDir, "restore")
            RunDotnet(tempDir, "build", "-c", "Release", "--nologo", "--no-restore")
            let dllPath = Path.Combine(tempDir, "bin", "Release", "net10.0", assemblyName + ".dll")
            Assert.True(File.Exists(dllPath), "Reference assembly not found at $dllPath.")
            return dllPath
        }

        private func RunDotnet(workingDirectory string, args ...string) {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
            }
            for arg in args {
                psi.ArgumentList.Add(arg)
            }
            using let process = Process.Start(psi) ??
                throw InvalidOperationException("Failed to start dotnet ${string.Join(" ", args)}.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(120_000), "dotnet ${args[0]} timed out.")
            Assert.True(
                process.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (` + "${process.ExitCode}" + `).
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
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
