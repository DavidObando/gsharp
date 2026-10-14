// <copyright file="Issue2857ExplicitGenericLambdaProjectReferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text.RegularExpressions
import Xunit

class Issue2857ExplicitGenericLambdaProjectReferenceEmitTests {
    @Theory
    @InlineData("i2857topdirect", false, false, int32(11))
    @InlineData("i2857toptransitive", true, false, int32(22))
    @InlineData("i2857funcdirect", false, true, int32(33))
    @InlineData("i2857functransitive", true, true, int32(44))
    func ExplicitGenericTypeArgument_WithTypedLambdaAcrossReference_Runs(
        packageName string,
        useIntermediateBase bool,
        useFunction bool,
        expected int32
    ) {
        let baseType = packageName + ".Base"
        let intermediateDeclaration = if useIntermediateBase {
            "open class Middle : $baseType {}"
        } else {
            ""
        }
        let derivedBase = if useIntermediateBase {
            "Middle"
        } else {
            baseType
        }
        let entryPointStart = if useFunction {
            "func Main() {"
        } else {
            ""
        }
        let entryPointEnd = if useFunction {
            "}"
        } else {
            ""
        }
        let library = (`package ` + "$packageName" + `

open class Base {
    var Value int32

    shared {
        func Make[T Base init()](configure ((T) -> void)?) T {
            let value = T()
            if let apply = configure {
                apply(value)
            }
            return value
        }
    }
}`)
        let consumer = (`package ` + "$packageName" + `use
import System

` + "$intermediateDeclaration" + `
class Derived : ` + "$derivedBase" + ` {}

` + "$entryPointStart" + `
let value = ` + "$baseType" + `.Make[Derived](
    (item Derived) -> { item.Value = ` + "$expected" + ` })
Console.WriteLine(value.Value)
` + "$entryPointEnd")
        Assert.Equal("$expected${Environment.NewLine}", CompileAndRun(library, consumer, packageName))
    }

    @Theory
    @InlineData("i2857arraytransitive", int32(1), int32(77))
    @InlineData("i2857arraydepth3", int32(3), int32(99))
    func ExplicitGenericTypeArgument_WithDelegateArrayAcrossReference_Runs(
        packageName string,
        inheritanceDepth int32,
        expected int32
    ) {
        let baseType = packageName + ".Base"
        let intermediateDeclarations = string.Join(
            "\n",
            Enumerable.Range(1, inheritanceDepth).Select(
                (
                    index int32
                ) -> "open class Middle$index : ${(if index == 1 { baseType } else { "Middle${index - 1}" })} {}"
            )
        )
        let library = (`package ` + "$packageName" + `

open class Base {
    var Value int32

    shared {
        func Make[T Base init()](configure []((T) -> void)) T {
            let value = T()
            for apply in configure {
                apply(value)
            }
            return value
        }
    }
}`)
        let consumer = (`package ` + "$packageName" + `use
import System

` + "$intermediateDeclarations" + `
class Derived : Middle` + "$inheritanceDepth" + ` {}

func Main() {
    let value = ` + "$baseType" + `.Make[Derived](
        []((Derived) -> void){
            (item Derived) -> { item.Value = ` + "$expected" + ` }
        })
    Console.WriteLine(value.Value)
}`)
        Assert.Equal("$expected${Environment.NewLine}", CompileAndRun(library, consumer, packageName))
    }

    @Theory
    @InlineData("i3178jagged2", int32(2), int32(7))
    @InlineData("i3178jagged3", int32(3), int32(8))
    func ExplicitGenericTypeArgument_WithJaggedDelegateArrayAcrossReference_Runs(
        packageName string,
        arrayDepth int32,
        expected int32
    ) {
        let libraryArrayType = string.Concat(Enumerable.Repeat("[]", arrayDepth)) + "((T) -> void)"
        let consumerDelegateType = "((Derived) -> void)"
        let consumerArrayType = string.Concat(Enumerable.Repeat("[]", arrayDepth)) + consumerDelegateType
        var callback = "(item Derived) -> { item.Value = $expected }"
        for var depth = 1; depth < arrayDepth; depth++ {
            let nestedType = string.Concat(Enumerable.Repeat("[]", depth)) + consumerDelegateType
            callback = "$nestedType{ $callback }"
        }
        let indices = string.Concat(Enumerable.Repeat("[0]", arrayDepth))
        let library = (`package ` + "$packageName" + `

open class Base {
    var Value int32

    shared {
        func Make[T Base init()](configure ` + "$libraryArrayType" + `) T {
            let value = T()
            configure` + "$indices" + `(value)
            return value
        }
    }
}`)
        let consumer = (`package ` + "$packageName" + `use
import System

class Derived : ` + "$packageName" + `.Base {}

func Main() {
    let value = ` + "$packageName" + `.Base.Make[Derived](
        ` + "$consumerArrayType" + `{ ` + "$callback" + ` })
    Console.WriteLine(value.Value)
}`)
        Assert.Equal("$expected${Environment.NewLine}", CompileAndRun(library, consumer, packageName))
    }

    @Theory
    @InlineData("i2857arity0", int32(0), int32(22))
    @InlineData("i2857arity1", int32(1), int32(11))
    @InlineData("i2857arity2", int32(2), int32(33))
    @InlineData("i2857arity3", int32(3), int32(44))
    @InlineData("i2857arity4", int32(4), int32(55))
    func ExplicitGenericTypeArgument_WithDelegateArityAcrossReference_Runs(
        packageName string,
        arity int32,
        expected int32
    ) {
        let delegateType = if arity == 0 {
            "(() -> T)"
        } else {
            "((T${string.Concat(Enumerable.Repeat(", int32", arity - 1))}) -> void)"
        }
        let invocation = if arity == 0 {
            "return callback()"
        } else {
            (`let value = T()
callback(value` + "${string.Concat(Enumerable.Repeat(", 0", arity - 1))}" + `)
return value`)
        }
        let lambda = if arity == 0 {
            (`() -> {
    let value = Derived()
    value.Value = ` + "$expected" + `
    return value
}`)
        } else {
            (
                `(item Derived` +
                    "${string.Concat(Enumerable.Range(1, arity - 1).Select((index int32) -> ", arg$index int32"))}" +
                    `) -> {
    item.Value = ` +
                    "$expected" +
                    `
}`
            )
        }
        let library = (`package ` + "$packageName" + `

open class Base {
    var Value int32

    shared {
        func Make[T Base init()](callback ` + "$delegateType" + `) T {
            ` + "$invocation" + `
        }
    }
}`)
        let consumer = (`package ` + "$packageName" + `use
import System

open class Middle : ` + "$packageName" + `.Base {}
class Derived : Middle {}

func Main() {
    let value = ` + "$packageName" + `.Base.Make[Derived](` + "$lambda" + `)
    Console.WriteLine(value.Value)
}`)
        Assert.Equal("$expected${Environment.NewLine}", CompileAndRun(library, consumer, packageName))
    }

    @Theory
    @InlineData("i2857listdirect", false, int32(33))
    @InlineData("i2857listtransitive", true, int32(44))
    func ExplicitGenericTypeArgument_WithListOfDerivedAcrossReference_Runs(
        packageName string,
        useIntermediateBase bool,
        expected int32
    ) {
        let baseType = packageName + ".Base"
        let intermediateDeclaration = if useIntermediateBase {
            "open class Middle : $baseType {}"
        } else {
            ""
        }
        let derivedBase = if useIntermediateBase {
            "Middle"
        } else {
            baseType
        }
        let library = (`package ` + "$packageName" + `
import System.Collections.Generic

open class Base {}

class Api {
    shared {
        func Use[T Base](items List[T], result int32) int32 -> result
    }
}`)
        let consumer = (`package ` + "$packageName" + `use
import System
import System.Collections.Generic

` + "$intermediateDeclaration" + `
class Derived : ` + "$derivedBase" + ` {}

func Main() {
    let items = List[Derived]()
    items.Add(Derived())
    Console.WriteLine(` + "$packageName" + `.Api.Use[Derived](items, ` + "$expected" + `))
}`)
        Assert.Equal("$expected${Environment.NewLine}", CompileAndRun(library, consumer, packageName))
    }

    @Fact
    func ExplicitGenericTypeArgument_WithUnrelatedDelegateParameterAcrossReference_Runs() {
        const packageName = "i2857unrelateddelegate"
        let library = (`package ` + "$packageName" + `
import System
import System.Collections.Generic

open class Base {}

class Api {
    shared {
        func Use[T Base](items List[T], callback Action, result int32) int32 {
            callback()
            return result
        }
    }
}`)
        let consumer = (`package ` + "$packageName" + `use
import System
import System.Collections.Generic

class Derived : ` + "$packageName" + `.Base {}

func Main() {
    let items = List[Derived]()
    items.Add(Derived())
    let value = ` + "$packageName" + `.Api.Use[Derived](
        items,
        () -> Console.WriteLine(55),
        66)
    Console.WriteLine(value)
}`)
        Assert.Equal("55${Environment.NewLine}66${Environment.NewLine}", CompileAndRun(library, consumer, packageName))
    }

    @Fact
    func TransitiveSlice_ToInvariantInterfaceAcrossReference_IsRejected() {
        const packageName = "i2857invariantslice"
        let library = (`package ` + "$packageName" + `
import System.Collections.Generic

open class Base {}

class Api {
    shared {
        func Fill(items IList[Base]) {}
    }
}`)
        let consumer = (`package ` + "$packageName" + `use
import ` + "$packageName" + `

open class Middle : Base {}
class Derived : Middle {}

func Main() {
    let items = []Derived{ Derived() }
    Api.Fill(items)
}`)
        let output = CompileExpectingFailure(library, consumer, packageName)
        let diagnosticIds = Regex
            .Matches(output, "\\berror (GS\\d{4}):")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()
        Assert.Equal([]string{"GS0159"}, diagnosticIds)
    }

    // Issue #3501: this shape was pinned as REJECTED (GS0159) while
    // `SatisfiesClassConstraint` could not see a source class deriving an
    // imported base — the constraint failure was the loud guard for the
    // then-unclosable delegate-in-constructed-generic. With the constraint
    // fixed the call closes, ilverifies, and runs (the configure delegate
    // observably mutates the constructed T), so the guard flips to a
    // behavior assertion.
    @Fact
    func ExplicitGenericTypeArgument_WithDelegateInConstructedGenericAcrossReference_Runs() {
        const PackageName = "i3178constructedgeneric"
        let library = (`package ` + "$PackageName" + `
import System.Collections.Generic

open class Base {
    var Value int32

    shared {
        func Make[T Base init()](configure List[((T) -> void)]) T {
            let value = T()
            configure[0](value)
            return value
        }
    }
}`)
        let consumer = (`package ` + "$PackageName" + `use
import System.Collections.Generic

class Derived : ` + "$PackageName" + `.Base {}

func Main() {
    let configure = List[((Derived) -> void)]()
    configure.Add((item Derived) -> { item.Value = 9 })
    let made = ` + "$PackageName" + `.Base.Make[Derived](configure)
    System.Console.WriteLine(made.Value)
}`)
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(library, consumer, PackageName))
    }

    shared {
        private func CompileAndRun(library string, consumer string, libraryAssemblyName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue2857ExplicitGenericLambdaProjectReferenceEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory))
            try {
                let librarySourcePath = Path.Combine(directory, libraryAssemblyName + ".gs")
                let libraryPath = Path.Combine(directory, libraryAssemblyName + ".dll")
                File.WriteAllText(librarySourcePath, library)
                Compile(
                    []string{"/out:" + libraryPath, "/target:library", "/targetframework:net10.0", librarySourcePath}
                )
                IlVerifier.Verify(libraryPath)
                let consumerSourcePath = Path.Combine(directory, "consumer.gs")
                let consumerPath = Path.Combine(directory, "consumer.dll")
                File.WriteAllText(consumerSourcePath, consumer)
                Compile(
                    []string{
                        "/out:" + consumerPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + libraryPath,
                        consumerSourcePath
                    }
                )
                IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
                AssertLoads(libraryPath, consumerPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(consumerPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(consumerPath)
                using let process = Process.Start(startInfo) ??
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
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func CompileExpectingFailure(library string, consumer string, libraryAssemblyName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue2857ExplicitGenericLambdaProjectReferenceEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory))
            try {
                let librarySourcePath = Path.Combine(directory, libraryAssemblyName + ".gs")
                let libraryPath = Path.Combine(directory, libraryAssemblyName + ".dll")
                File.WriteAllText(librarySourcePath, library)
                Compile(
                    []string{"/out:" + libraryPath, "/target:library", "/targetframework:net10.0", librarySourcePath}
                )
                let consumerSourcePath = Path.Combine(directory, "consumer.gs")
                let consumerPath = Path.Combine(directory, "consumer.dll")
                File.WriteAllText(consumerSourcePath, consumer)
                let compilation = RunCompiler(
                    []string{
                        "/out:" + consumerPath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + libraryPath,
                        consumerSourcePath
                    }
                )
                Assert.NotEqual(0, compilation.ExitCode)
                return compilation.Stdout + compilation.Stderr
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func AssertLoads(libraryPath string, consumerPath string) {
            let loadContext = AssemblyLoadContext(
                "Issue2857ExplicitGenericLambdaProjectReferenceEmitTests" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
            try {
                let library = loadContext.LoadFromAssemblyPath(libraryPath)
                loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == library.GetName()
                    .Name {
                    library
                } else {
                    default(Assembly?)
                }
                Assert.NotEmpty(library.GetTypes())
                Assert.NotEmpty(loadContext.LoadFromAssemblyPath(consumerPath).GetTypes())
            } finally {
                loadContext.Unload()
            }
        }

        private func Compile(args[]string) {
            let compilation = RunCompiler(args)
            Assert.True(compilation.ExitCode == 0, (`compile failed (` + "${compilation.ExitCode}" + `)
stdout:
` + "${compilation.Stdout}" + `
stderr:
` + "${compilation.Stderr}"))
        }

        private func RunCompiler(args[]string)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, stdout.ToString(), stderr.ToString())
        }
    }
}
