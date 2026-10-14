// <copyright file="Issue3828EmittedFixtureIsolationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #3828: an emitted test fixture must not become a reference for the
/// next in-process compilation.
/// @remarks Emit tests run gsc in-process with no `/reference:` and then load the
/// produced PE. Loading it into the default context left it visible to
/// `ReferenceResolver.BuildHostAssemblies`, so a later fixture declaring
/// the same package bound the earlier fixture's types and the compile failed
/// inside gsc — `GS0156: Cannot convert type 'P.Color' to 'Color'` in
/// `compiler-emit-remainder`, whenever class order put the colliding
/// fixture first.
open class Issue3828EmittedFixtureIsolationTests {
    /// Forces the order that made the shard fail: compile and load a fixture
    /// declaring `P.Color`, then compile a second one declaring its own
    /// `P.Color`. Before the fix the second compile fails with GS0156,
    /// because it binds the first fixture's enum; both fixtures here also run,
    /// so the isolation is proved at execution and not only at bind time.
    @Fact
    func LoadedFixture_DoesNotShadow_TheNextCompilationOfTheSamePackage() {
        let first = CompileAndLoad(FirstFixture, "first")
        let firstColor = first.GetTypes().Single((t Type) -> t.Name == "Color")
        let toInt MethodInfo? = first
            .GetTypes()
            .Single((t Type) -> t.Name == "<Program>")
            .GetMethod("ToInt", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic)
        Assert.NotNull(toInt)
        Assert.Equal(2, toInt!!.Invoke(nil, []object{Enum.ToObject(firstColor, 2)}))
        // The compile that GS0156 used to fail.
        let second = CompileAndLoad(SecondFixture, "second")
        let secondColor = second.GetTypes().Single((t Type) -> t.Name == "Color")
        let fromInt MethodInfo? = second
            .GetTypes()
            .Single((t Type) -> t.Name == "<Program>")
            .GetMethod("FromInt", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic)
        Assert.NotNull(fromInt)
        let value object? = fromInt!!.Invoke(nil, []object{1})
        Assert.NotNull(value)
        Assert.Equal(secondColor, value!!.GetType())
        Assert.Equal("Green", value!!.ToString())
        // Each fixture keeps its own enum identity; neither borrowed the other's.
        Assert.NotSame(firstColor, secondColor)
    }

    /// Pins the property `BuildHostAssemblies` keys on: a fixture loaded
    /// through the shared helper lives in a collectible context, which that
    /// scan skips. Unique assembly names would not give this — the leak, not
    /// the name, is what made a fixture ambient.
    @Fact
    func LoadedFixture_LivesInACollectibleContext_SoTheHostScanSkipsIt() {
        let assembly = CompileAndLoad(FirstFixture, "context")
        let context AssemblyLoadContext? = AssemblyLoadContext.GetLoadContext(assembly)
        Assert.NotNull(context)
        Assert.True(context!!.IsCollectible, "Emitted fixtures must load into a collectible context.")
        Assert.NotSame(AssemblyLoadContext.Default, context)
        Assert.DoesNotContain(
            AppDomain.CurrentDomain.GetAssemblies(),
            (loaded Assembly) -> object.ReferenceEquals(loaded, assembly) &&
                !(AssemblyLoadContext.GetLoadContext(loaded)?.IsCollectible ?? false)
        )
    }

    shared {
        private const FirstFixture string = `package P
import System

enum Color { Red, Green, Blue }

func ToInt(c Color) int32 {
    return int32(c)
}`

        private const SecondFixture string = `package P
import System

enum Color { Red, Green, Blue }

func FromInt(i int32) Color {
    return Color(i)
}`

        private func CompileAndLoad(source string, assemblyName string) Assembly {
            let directory = Directory.CreateTempSubdirectory("gs_issue3828_").FullName
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:library", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed for ` + "$assemblyName" + `:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return EmittedFixture.Load(outputPath)
        }
    }
}
