// <copyright file="Issue2893ConstructorAccessibilityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Regression coverage for issue #2893.
class Issue2893ConstructorAccessibilityEmitTests {
    @Fact
    func NonPublicExplicitConstructors_EmitDeclaredAccessibility() {
        Verify(
            (types[]Type) -> {
                AssertConstructorVisibility(types, "Issue2893.InternalCtor", MethodAttributes.Assembly, typeof(int32))
                AssertConstructorVisibility(types, "Issue2893.ProtectedCtor", MethodAttributes.Family, typeof(int32))
                AssertConstructorVisibility(types, "Issue2893.PrivateCtor", MethodAttributes.Private, typeof(int32))
                AssertConstructorVisibility(
                    types,
                    "Issue2893.FuncInitInternal",
                    MethodAttributes.Assembly,
                    typeof(int32)
                )
                AssertConstructorVisibility(types, "Issue2893.ConvenienceCtor", MethodAttributes.Private, typeof(int32))
                AssertConstructorVisibility(
                    types,
                    "Issue2893.Outer+NestedPrivate",
                    MethodAttributes.Private,
                    typeof(int32)
                )
                AssertConstructorVisibility(
                    types,
                    "Issue2893.GenericPrivate`1",
                    MethodAttributes.Private,
                    typeof(int32)
                )
                AssertConstructorVisibility(types, "Issue2893.DataPrivate", MethodAttributes.Private, typeof(int32))
                AssertConstructorVisibility(types, "Issue2893.StructPrivate", MethodAttributes.Private, typeof(int32))
            }
        )
    }

    @Fact
    func PublicDefaultAndStaticConstructors_RemainUnchanged() {
        Verify(
            (types[]Type) -> {
                AssertConstructorVisibility(types, "Issue2893.PublicCtor", MethodAttributes.Public, typeof(int32))
                AssertConstructorVisibility(types, "Issue2893.DefaultCtor", MethodAttributes.Public, typeof(int32))
                AssertConstructorVisibility(types, "Issue2893.SynthesizedDefault", MethodAttributes.Public)
                AssertConstructorVisibility(types, "Issue2893.PrimaryCtor", MethodAttributes.Public, typeof(int32))
                let staticInitializer ConstructorInfo? = types.Single(
                    (type Type) -> type.FullName == "Issue2893.StaticInitializer"
                )
                    .TypeInitializer
                Assert.NotNull(staticInitializer)
                Assert.Equal(
                    MethodAttributes.Private,
                    staticInitializer!!.Attributes & MethodAttributes.MemberAccessMask
                )
                Assert.True(staticInitializer!!.IsStatic)
            }
        )
    }

    shared {
        private const Source string = `package Issue2893
import System

class PublicCtor {
    var Value int32
    public init(value int32) { Value = value }
}

class InternalCtor {
    internal init(value int32) {}
}

open class ProtectedCtor {
    protected init(value int32) {}
}

class PrivateCtor {
    private init(value int32) {}
}

class DefaultCtor {
    var Value int32
    init(value int32) { Value = value }
}

class FuncInitInternal {
    internal func init(value int32) {}
}

class ConvenienceCtor {
    public init(value int32, other int32) {}
    private convenience init(value int32) { init(value, 0) }
}

class Outer {
    class NestedPrivate {
        private init(value int32) {}
    }
}

class GenericPrivate[T] {
    private init(value int32) {}
}

data class DataPrivate {
    private init(value int32) {}
}

struct StructPrivate {
    private init(value int32) {}
}

class SynthesizedDefault {
    var Value int32 = 33
}

class PrimaryCtor(value int32) {}

class StaticInitializer {
    shared {
        var Value int32
        init { Value = 44 }
        func Read() int32 -> Value
    }
}

func Main() {
    Console.WriteLine(PublicCtor(11).Value)
    Console.WriteLine(DefaultCtor(22).Value)
    Console.WriteLine(SynthesizedDefault().Value)
    Console.WriteLine(PrimaryCtor(34).value)
    Console.WriteLine(StaticInitializer.Read())
}`

        private func Verify(assertions([]Type) -> void) {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue2893ConstructorAccessibilityEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let assemblyPath = Compile(Source, directory)
                IlVerifier.Verify(assemblyPath)
                let assembly = EmittedFixture.Load(assemblyPath)
                let types = assembly.GetTypes()
                Assert.Equal(16, types.Length)
                assertions(types)
                Assert.Equal(
                    "11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}34${Environment.NewLine}44${Environment.NewLine}",
                    Run(assemblyPath, directory)
                )
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func Compile(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "Program.gs")
            let assemblyPath = Path.Combine(directory, "Program.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return assemblyPath
        }

        private func AssertConstructorVisibility(
            types[]Type,
            typeName string,
            expected MethodAttributes,
            parameterTypes ...Type
        ) {
            let type = types.Single((candidate Type) -> candidate.FullName == typeName)
            let constructor ConstructorInfo? = type.GetConstructor(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly,
                binder: nil,
                parameterTypes,
                modifiers: nil
            )
            Assert.NotNull(constructor)
            Assert.Equal(expected, constructor!!.Attributes & MethodAttributes.MemberAccessMask)
        }

        private func Run(assemblyPath string, directory string) string {
            let runtimeConfigPath = Path.ChangeExtension(assemblyPath, "runtimeconfig.json")
            File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(runtimeConfigPath)
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start emitted program.")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            Assert.True(process.WaitForExit(30_000), "Emitted program timed out.")
            Assert.True(process.ExitCode == 0, (`emitted program exited ` + "${process.ExitCode}" + `
stdout:
` + "${stdout.Result}" + `
stderr:
` + "${stderr.Result}"))
            return stdout.Result.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
