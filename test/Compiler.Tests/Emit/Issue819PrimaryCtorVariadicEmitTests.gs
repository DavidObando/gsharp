// <copyright file="Issue819PrimaryCtorVariadicEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Reflection

/// Issue #819 — primary-constructor parameter lists (ADR-0078) accept a
/// trailing variadic `name ...T`; the variadic parameter promotes to
/// a `[]T` auto-field of the same name, and the synthesised
/// constructor's variadic slot carries `[ParamArrayAttribute]` so a
/// C# consumer can call it with `params` semantics.
///
/// End-to-end emit checks:
/// * CompileAndRun for pack/empty/pass-through over a class with a
/// primary-ctor variadic.
/// * Reflection assertion that the emitted ctor's last parameter has
/// `[ParamArrayAttribute]`.
/// * Cross-language: a C# sibling library calls
/// `new Tags("a", "b", "c")` through `params` lowering and
/// observes the packed slice on the auto-field.
///
/// ilverify is invoked on every emitted assembly via
/// (cref:IlVerifier.Verify(string, string[], string[])).
open class Issue819PrimaryCtorVariadicEmitTests {
    @Fact
    func PrimaryCtorVariadic_Class_PacksTrailingArgs() {
        let source = `package P
import System

class Tags(name string, tags ...string) { }

var t = Tags("project", "a", "b", "c")
Console.WriteLine(t.name)
Console.WriteLine(t.tags.Length)
Console.WriteLine(t.tags[0])
Console.WriteLine(t.tags[2])`
        let output = CompileAndRun(source)
        Assert.Equal(
            "project${Environment.NewLine}3${Environment.NewLine}a${Environment.NewLine}c${Environment.NewLine}",
            output
        )
    }

    @Fact
    func PrimaryCtorVariadic_Class_EmptyTrailing_ProducesEmptySlice() {
        let source = `package P
import System

class Tags(name string, tags ...string) { }

var t = Tags("only")
Console.WriteLine(t.name)
Console.WriteLine(t.tags.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("only${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func PrimaryCtorVariadic_Class_PassThrough_PreservesIdentity() {
        let source = `package P
import System

class Tags(name string, tags ...string) { }

var arr = []string{"one", "two"}
var t = Tags("x", arr)
arr[0] = "ONE"
Console.WriteLine(t.tags[0])
Console.WriteLine(t.tags[1])`
        let output = CompileAndRun(source)
        Assert.Equal("ONE${Environment.NewLine}two${Environment.NewLine}", output)
    }

    @Fact
    func PrimaryCtorVariadic_Generic_InfersElementType() {
        let source = `package P
import System

class Box[T](first T, rest ...T) { }

var b = Box[int32](1, 2, 3, 4)
Console.WriteLine(b.first)
Console.WriteLine(b.rest.Length)
Console.WriteLine(b.rest[0])
Console.WriteLine(b.rest[2])`
        let output = CompileAndRun(source)
        Assert.Equal(
            "1${Environment.NewLine}3${Environment.NewLine}2${Environment.NewLine}4${Environment.NewLine}",
            output
        )
    }

    @Fact
    func PrimaryCtorVariadic_DataClass_PacksTrailingArgs() {
        let source = `package P
import System

data class Tags(name string, tags ...string)

var t = Tags("project", "a", "b")
Console.WriteLine(t.name)
Console.WriteLine(t.tags.Length)`
        let output = CompileAndRun(source)
        Assert.Equal("project${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func PrimaryCtorVariadic_OnlyVariadic_PacksAll() {
        let source = `package P
import System

class Words(values ...string) { }

var w = Words("a", "b", "c", "d")
Console.WriteLine(w.values.Length)
Console.WriteLine(w.values[3])`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}d${Environment.NewLine}", output)
    }

    @Fact
    func PrimaryCtorVariadic_CtorParameter_HasParamArrayAttribute_ForCSharpInterop() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue819_paramarray_").FullName
        try {
            let gsSrc = Path.Combine(tempDir, "lib.gs")
            let gsDll = Path.Combine(tempDir, "GsPrimaryCtorVariadicLib.dll")
            File.WriteAllText(gsSrc, `package GsPrimaryCtorVariadicLib

public class Tags(name string, tags ...string) { }

public data class Names(prefix string, items ...string)`)
            CompileLibrary(gsSrc, gsDll)
            IlVerifier.Verify(gsDll)
            let asm = EmittedFixture.Load(gsDll)
            let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
            // class Tags(name string, tags ...string)
            let tagsType = asm.GetTypes().Single((t Type) -> t.Name == "Tags")
            let tagsCtor = tagsType.GetConstructors(flags).Single((c ConstructorInfo) -> c.GetParameters().Length == 2)
            let tagsParams = tagsCtor.GetParameters()
            Assert.False(
                HasParamArray(tagsParams[0]),
                "Primary-ctor fixed leading param must NOT carry [ParamArrayAttribute]."
            )
            Assert.True(HasParamArray(tagsParams[1]), "Primary-ctor variadic param must carry [ParamArrayAttribute].")
            Assert.Equal("System.String[]", tagsParams[1].ParameterType.FullName)
            // Auto-field is the same []T type.
            let tagsField FieldInfo? = tagsType.GetField("tags", flags)
            Assert.NotNull(tagsField)
            Assert.Equal("System.String[]", tagsField!!.FieldType.FullName)
            // data class Names(prefix string, items ...string)
            let namesType = asm.GetTypes().Single((t Type) -> t.Name == "Names")
            let namesCtor = namesType.GetConstructors(flags).Single(
                (c ConstructorInfo) -> c.GetParameters().Length == 2
            )
            let namesParams = namesCtor.GetParameters()
            Assert.False(
                HasParamArray(namesParams[0]),
                "Data-class primary-ctor fixed leading param must NOT carry [ParamArrayAttribute]."
            )
            Assert.True(
                HasParamArray(namesParams[1]),
                "Data-class primary-ctor variadic param must carry [ParamArrayAttribute]."
            )
            Assert.Equal("System.String[]", namesParams[1].ParameterType.FullName)
            // Sanity: invoke the synthesised ctor with the C#-style expanded array.
            let instance = tagsCtor.Invoke([]object{"p", []string{"a", "b", "c"}})
            let observed[]?string = cast[[]string](tagsField!!.GetValue(instance)!!)
            Assert.Equal([]string{"a", "b", "c"}, observed)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func PrimaryCtorVariadic_CSharpConsumer_UsesParamsLowering() {
        // C# sibling calls `new Tags("a", "b", "c")` -- depends on
        // [ParamArrayAttribute] being emitted on the trailing primary-ctor
        // param of the generated class.
        let sibling = `using GsPrimaryCtorVariadicLib;

namespace Probe.CSharp
{
    public static class Probe
    {
        public static int CountTags(Tags t) => t.tags.Length;
        public static string FirstTag(Tags t) => t.tags[0];

        public static Tags MakeViaParams()
        {
            // params lowering: caller writes individual args.
            return new Tags("x", "alpha", "beta", "gamma");
        }
    }
}`
        let gsource = `package Probe.Tests
import Probe.CSharp
import System

var t = Probe.MakeViaParams()
Console.WriteLine(t.name)
Console.WriteLine(Probe.CountTags(t))
Console.WriteLine(Probe.FirstTag(t))`
        let output = CompileAndRunWithGsLibAndSiblingCs(gsLibName: "GsPrimaryCtorVariadicLib", gsLibSource: `package GsPrimaryCtorVariadicLib

public class Tags(name string, tags ...string) { }`, csSiblingSource: sibling, csSiblingName: "Probe.CSharp", gsSource: gsource)
        Assert.Equal("x${Environment.NewLine}3${Environment.NewLine}alpha${Environment.NewLine}", output)
    }

    shared {
        private func HasParamArray(p ParameterInfo) bool -> p.GetCustomAttributesData().Any(
            (a CustomAttributeData) -> a.AttributeType.FullName == "System.ParamArrayAttribute"
        )

        private func CompileLibrary(gsSrc string, gsDll string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + gsDll, "/target:library", "/targetframework:net10.0", gsSrc}
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
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue819_emit_").FullName
            try {
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
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithGsLibAndSiblingCs(
            gsLibName string,
            gsLibSource string,
            csSiblingSource string,
            csSiblingName string,
            gsSource string
        ) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue819_xlang_").FullName
            try {
                // (1) Compile G# library that declares the primary-ctor variadic
                //     type the C# sibling will consume.
                let gsLibSrc = Path.Combine(tempDir, "lib.gs")
                let gsLibDll = Path.Combine(tempDir, gsLibName + ".dll")
                File.WriteAllText(gsLibSrc, gsLibSource)
                CompileLibrary(gsLibSrc, gsLibDll)
                IlVerifier.Verify(gsLibDll)
                // (2) Build the C# sibling project that references the G# library
                //     and calls the synthesised ctor via params lowering.
                let csDir = Path.Combine(tempDir, "csref")
                Directory.CreateDirectory(csDir)
                File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csSiblingSource)
                File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>` + "$csSiblingName" + `</AssemblyName>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
    <EnforceCodeStyleInBuild>false</EnforceCodeStyleInBuild>
    <NoWarn>$(NoWarn);CS1591</NoWarn>
    <DocumentationFile></DocumentationFile>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="` + "$gsLibName" + `">
      <HintPath>` + "$gsLibDll" + `</HintPath>
    </Reference>
  </ItemGroup>
</Project>`))
                RunDotnet(csDir, "restore")
                RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
                let csDll = Path.Combine(csDir, "bin", "Release", "net10.0", csSiblingName + ".dll")
                Assert.True(File.Exists(csDll), "sibling assembly not found at $csDll")
                // (3) Compile a G# executable that references both libraries.
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gsSource)
                let gscArgs = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + csDll,
                    "/reference:" + gsLibDll
                }
                for reference in TrustedPlatformAssemblies() {
                    gscArgs.Add("/reference:" + reference)
                }
                gscArgs.Add("/nowarn:GS9100")
                gscArgs.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(gscArgs.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                File.Copy(csDll, Path.Combine(tempDir, Path.GetFileName(csDll)), overwrite: true)
                IlVerifier.Verify(outPath, additionalReferences: []string{csDll, gsLibDll})
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunDotnet(workingDir string, args ...string) string {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for a in args {
                psi.ArgumentList.Add(a)
            }
            using let proc = Process.Start(psi) ??
                throw InvalidOperationException("failed to start dotnet ${string.Join(" ", args)}")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (exit ` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
            return stdout
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
