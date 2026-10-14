// <copyright file="Issue2542DelegateFactoryCovarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2542: factory function values may covary their return type, but their
/// parameter types remain invariant.
open class Issue2542DelegateFactoryCovarianceEmitTests {
    @Fact
    func FunctionValueAndLambda_ConcreteReturnToInterfaceFactory_Run() {
        let output = CompileAndRun(`package P

interface IProduct {
    func Name() string;
}

class Product : IProduct {
    func Name() string { return "product" }
}

func Make() Product { return Product() }
func Use(factory () -> IProduct) string { return factory().Name() }

func Main() {
    let factory () -> Product = Make
    System.Console.WriteLine(Use(factory))
    System.Console.WriteLine(Use(() -> Product()))
}`)
        Assert.Equal("product${Environment.NewLine}product${Environment.NewLine}", output)
    }

    @Fact
    func NarrowerFactoryParameter_IsRejected() {
        let (exit, diagnostics) = TryCompile(`package P

interface IAnimal { }
class Dog : IAnimal { }
class Cat : IAnimal { }

func DescribeDog(value Dog) string { return "dog" }
func Use(factory (IAnimal) -> string) string { return factory(Cat()) }

func Main() {
    let factory (Dog) -> string = DescribeDog
    System.Console.WriteLine(Use(factory))
}`)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0154", diagnostics)
    }

    shared {
        private func CompileAndRun(source string) string {
            let dir = Directory.CreateTempSubdirectory("gs_2542_run_").FullName
            try {
                let path = Path.Combine(dir, "test.gs")
                let output = Path.Combine(dir, "test.dll")
                File.WriteAllText(path, source)
                let (exit, diagnostics) = RunCompiler(path, output, "exe")
                Assert.True(exit == 0, diagnostics)
                IlVerifier.Verify(output)
                File.WriteAllText(Path.ChangeExtension(output, "runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let start = ProcessStartInfo("dotnet", "exec \"" + output + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let process = Process.Start(start)!!
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                process.WaitForExit()
                Assert.True(process.ExitCode == 0, stderr)
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(dir, recursive: true)
                } catch { }
            }
        }

        private func TryCompile(source string)(Exit int32, Diagnostics string) {
            let dir = Directory.CreateTempSubdirectory("gs_2542_compile_").FullName
            try {
                let path = Path.Combine(dir, "test.gs")
                let output = Path.Combine(dir, "test.dll")
                File.WriteAllText(path, source)
                return RunCompiler(path, output, "exe")
            } finally {
                try {
                    Directory.Delete(dir, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(source string, output string, target string)(Exit int32, Diagnostics string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exit = Program.Main(
                    []string{
                        "/out:" + output,
                        "/target:" + target,
                        "/targetframework:net10.0",
                        "/nowarn:GS9100",
                        source
                    }
                )
                return (exit, stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
