// <copyright file="Issue2889LambdaThunkNestedGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2889 — qualified imported generic types discarded symbolic nested
/// arguments before lambda target typing, so synthesized thunk signatures used
/// erased <c>List&lt;object&gt;</c> instead of <c>List&lt;Src&gt;</c>.
/// </summary>
public class Issue2889LambdaThunkNestedGenericTests
{
    [Fact]
    public void ImportedClrDelegates_PreserveNestedSourceShapes_VerifyAndRun()
    {
        const string source = """
            package i2889imported
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            struct Pt { var X int32 }

            class MyBox[T any] {
                let Value T
                init(value T) { Value = value }
            }

            class Holder {
                let Field System.Action[List[Src]]
                prop Property System.Action[List[Src]] { get; init; }

                init() {
                    Field = (items List[Src]) -> Console.WriteLine(items[0].N)
                    Property = (items) -> Console.WriteLine(items[0].N + 1)
                }

                func Run(items List[Src]) {
                    Field(items)
                    Property(items)
                }
            }

            func PrintMethod(items List[Src]) {
                Console.WriteLine(items[0].N)
            }

            func Main() {
                let classItems = List[Src]{ Src(10) }
                let classAction System.Action[List[Src]] =
                    (items List[Src]) -> Console.WriteLine(items[0].N)
                classAction(classItems)

                var optional System.Action[List[Src]]? = classAction
                if optional != nil {
                    optional(classItems)
                }

                var point Pt
                point.X = 12
                let pointAction System.Action[List[Pt]] =
                    (items List[Pt]) -> Console.WriteLine(items[0].X)
                pointAction(List[Pt]{ point })

                let make System.Func[List[Src]] = () -> List[Src]{ Src(13) }
                Console.WriteLine(make()[0].N)

                let pair System.Action[List[Src], Dictionary[string, Src]] =
                    (items List[Src], byName Dictionary[string, Src]) ->
                        Console.WriteLine(items[0].N + byName["x"].N)
                let byName = Dictionary[string, Src]()
                byName.Add("x", Src(7))
                pair(List[Src]{ Src(7) }, byName)

                let deep System.Action[List[List[Src]]] =
                    (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
                deep(List[List[Src]]{ List[Src]{ Src(15) } })

                let generic System.Action[List[MyBox[int32]]] =
                    (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
                generic(List[MyBox[int32]]{ MyBox[int32](16) })

                let arrayAction System.Action[[]Src] =
                    (items []Src) -> Console.WriteLine(items[0].N)
                arrayAction([]Src{ Src(17) })

                let nullableAction System.Action[List[Src?]] =
                    (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
                nullableAction(List[Src?]{ nil, Src(18) })

                let methodGroup System.Action[List[Src]] = PrintMethod
                methodGroup(List[Src]{ Src(19) })

                let inferred System.Action[List[Src]] =
                    (items) -> Console.WriteLine(items[0].N)
                inferred(List[Src]{ Src(20) })

                Holder().Run(List[Src]{ Src(21) })
            }
            """;

        Assert.Equal(
            "10\n10\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n",
            CompileAndRun(source, expectedSourceTypeName: "i2889imported.Src"));
    }

    [Fact]
    public void ImportedNamedDelegates_PreserveNestedSourceShapes_VerifyAndRun()
    {
        const string library = """
            package i2889contracts

            type ImportedSink[T any] = delegate func(value T) void
            type ImportedPair[T any, U any] = delegate func(first T, second U) void
            type ImportedFactory[T any] = delegate func() T
            """;

        const string consumer = """
            package i2889nameduse
            import System
            import System.Collections.Generic
            import i2889contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            struct Pt { var X int32 }

            class MyBox[T any] {
                let Value T
                init(value T) { Value = value }
            }

            func Print(items List[Src]) { Console.WriteLine(items[0].N) }

            func Main() {
                let classSink i2889contracts.ImportedSink[List[Src]] =
                    (items List[Src]) -> Console.WriteLine(items[0].N)
                classSink(List[Src]{ Src(70) })

                var point Pt
                point.X = 71
                let structSink i2889contracts.ImportedSink[List[Pt]] =
                    (items List[Pt]) -> Console.WriteLine(items[0].X)
                structSink(List[Pt]{ point })

                let factory i2889contracts.ImportedFactory[List[Src]] =
                    () -> List[Src]{ Src(72) }
                Console.WriteLine(factory()[0].N)

                let pair i2889contracts.ImportedPair[List[Src], Dictionary[string, Src]] =
                    (items List[Src], byName Dictionary[string, Src]) ->
                        Console.WriteLine(items[0].N + byName["x"].N)
                let byName = Dictionary[string, Src]()
                byName.Add("x", Src(36))
                pair(List[Src]{ Src(37) }, byName)

                let deep i2889contracts.ImportedSink[List[List[Src]]] =
                    (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
                deep(List[List[Src]]{ List[Src]{ Src(74) } })

                let generic i2889contracts.ImportedSink[List[MyBox[int32]]] =
                    (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
                generic(List[MyBox[int32]]{ MyBox[int32](75) })

                let arraySink i2889contracts.ImportedSink[[]Src] =
                    (items []Src) -> Console.WriteLine(items[0].N)
                arraySink([]Src{ Src(76) })

                let nullableSink i2889contracts.ImportedSink[List[Src?]] =
                    (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
                nullableSink(List[Src?]{ nil, Src(77) })

                let group i2889contracts.ImportedSink[List[Src]] = Print
                group(List[Src]{ Src(78) })

                let inferred i2889contracts.ImportedSink[List[Src]] =
                    (items) -> Console.WriteLine(items[0].N)
                inferred(List[Src]{ Src(79) })
            }
            """;

        Assert.Equal(
            "70\n71\n72\n73\n74\n75\n76\n77\n78\n79\n",
            CompileAndRun(
                consumer,
                expectedSourceTypeName: "i2889nameduse.Src",
                library: library,
                libraryAssemblyName: "i2889contracts"));
    }

    [Fact]
    public void SourceNamedAndFunctionTypeControls_PreserveNestedSourceShapes_VerifyAndRun()
    {
        const string source = """
            package i2889controls
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            struct Pt { var X int32 }

            class MyBox[T any] {
                let Value T
                init(value T) { Value = value }
            }

            type Sink[T any] = delegate func(value T) void
            type PairSink[T any, U any] = delegate func(first T, second U) void
            type Factory[T any] = delegate func() T

            func PrintNamed(items List[Src]) { Console.WriteLine(items[0].N) }
            func PrintBare(items List[Src]) { Console.WriteLine(items[0].N) }

            class NamedHolder {
                let Field Sink[List[Src]]
                prop Property Sink[List[Src]] { get; init; }

                init() {
                    Field = (items List[Src]) -> Console.WriteLine(items[0].N)
                    Property = (items) -> Console.WriteLine(items[0].N + 1)
                }

                func Run(items List[Src]) {
                    Field(items)
                    Property(items)
                }
            }

            class BareHolder {
                let Field (List[Src]) -> void
                prop Property (List[Src]) -> void { get; init; }

                init() {
                    Field = (items List[Src]) -> Console.WriteLine(items[0].N)
                    Property = (items) -> Console.WriteLine(items[0].N + 1)
                }

                func Run(items List[Src]) {
                    Field(items)
                    Property(items)
                }
            }

            func Main() {
                let named Sink[List[Src]] =
                    (items List[Src]) -> Console.WriteLine(items[0].N)
                named(List[Src]{ Src(30) })

                var namedPoint Pt
                namedPoint.X = 32
                let namedStruct Sink[List[Pt]] =
                    (items List[Pt]) -> Console.WriteLine(items[0].X)
                namedStruct(List[Pt]{ namedPoint })

                let namedFactory Factory[List[Src]] = () -> List[Src]{ Src(33) }
                Console.WriteLine(namedFactory()[0].N)

                let namedPair PairSink[List[Src], Dictionary[string, Src]] =
                    (items List[Src], byName Dictionary[string, Src]) ->
                        Console.WriteLine(items[0].N + byName["x"].N)
                let namedByName = Dictionary[string, Src]()
                namedByName.Add("x", Src(17))
                namedPair(List[Src]{ Src(17) }, namedByName)

                let namedDeep Sink[List[List[Src]]] =
                    (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
                namedDeep(List[List[Src]]{ List[Src]{ Src(35) } })

                let namedGeneric Sink[List[MyBox[int32]]] =
                    (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
                namedGeneric(List[MyBox[int32]]{ MyBox[int32](36) })

                let namedArray Sink[[]Src] =
                    (items []Src) -> Console.WriteLine(items[0].N)
                namedArray([]Src{ Src(37) })

                let namedNullable Sink[List[Src?]] =
                    (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
                namedNullable(List[Src?]{ nil, Src(38) })

                let namedGroup Sink[List[Src]] = PrintNamed
                namedGroup(List[Src]{ Src(39) })
                let namedInferred Sink[List[Src]] =
                    (items) -> Console.WriteLine(items[0].N)
                namedInferred(List[Src]{ Src(40) })
                NamedHolder().Run(List[Src]{ Src(41) })

                let bare (List[Src]) -> void =
                    (items List[Src]) -> Console.WriteLine(items[0].N)
                bare(List[Src]{ Src(50) })

                var barePoint Pt
                barePoint.X = 52
                let bareStruct (List[Pt]) -> void =
                    (items List[Pt]) -> Console.WriteLine(items[0].X)
                bareStruct(List[Pt]{ barePoint })

                let bareFactory () -> List[Src] = () -> List[Src]{ Src(53) }
                Console.WriteLine(bareFactory()[0].N)

                let barePair (List[Src], Dictionary[string, Src]) -> void =
                    (items List[Src], byName Dictionary[string, Src]) ->
                        Console.WriteLine(items[0].N + byName["x"].N)
                let bareByName = Dictionary[string, Src]()
                bareByName.Add("x", Src(27))
                barePair(List[Src]{ Src(27) }, bareByName)

                let bareDeep (List[List[Src]]) -> void =
                    (items List[List[Src]]) -> Console.WriteLine(items[0][0].N)
                bareDeep(List[List[Src]]{ List[Src]{ Src(55) } })

                let bareGeneric (List[MyBox[int32]]) -> void =
                    (items List[MyBox[int32]]) -> Console.WriteLine(items[0].Value)
                bareGeneric(List[MyBox[int32]]{ MyBox[int32](56) })

                let bareArray ([]Src) -> void =
                    (items []Src) -> Console.WriteLine(items[0].N)
                bareArray([]Src{ Src(57) })

                let bareNullable (List[Src?]) -> void =
                    (items List[Src?]) -> Console.WriteLine(items[1]!!.N)
                bareNullable(List[Src?]{ nil, Src(58) })

                let bareGroup (List[Src]) -> void = PrintBare
                bareGroup(List[Src]{ Src(59) })
                let bareInferred (List[Src]) -> void =
                    (items) -> Console.WriteLine(items[0].N)
                bareInferred(List[Src]{ Src(60) })
                BareHolder().Run(List[Src]{ Src(61) })

                let importedPin System.Action[List[Src]] =
                    (items List[Src]) -> Console.WriteLine(items[0].N)
                importedPin(List[Src]{ Src(63) })
            }
            """;

        Assert.Equal(
            "30\n32\n33\n34\n35\n36\n37\n38\n39\n40\n41\n42\n"
            + "50\n52\n53\n54\n55\n56\n57\n58\n59\n60\n61\n62\n63\n",
            CompileAndRun(source, expectedSourceTypeName: "i2889controls.Src"));
    }

    private static string CompileAndRun(
        string source,
        string expectedSourceTypeName,
        string library = null,
        string libraryAssemblyName = null)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2889_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string libraryPath = null;
            if (library != null)
            {
                var librarySourcePath = Path.Combine(directory, libraryAssemblyName + ".gs");
                libraryPath = Path.Combine(directory, libraryAssemblyName + ".dll");
                File.WriteAllText(librarySourcePath, library);
                Compile(
                [
                    "/out:" + libraryPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    librarySourcePath,
                ]);
                IlVerifier.Verify(libraryPath);
            }

            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            var args = new List<string>
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            if (libraryPath != null)
            {
                args.Add("/nowarn:GS9100");
                args.Add("/r:" + libraryPath);
            }

            args.Add(sourcePath);
            Compile(args.ToArray());
            IlVerifier.Verify(
                assemblyPath,
                libraryPath != null ? new[] { libraryPath } : null);
            AssertLambdaSignatures(assemblyPath, expectedSourceTypeName, libraryPath);

            var runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
            if (!File.Exists(runtimeConfigPath))
            {
                File.WriteAllText(runtimeConfigPath, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(runtimeConfigPath);
            startInfo.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exec exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void AssertLambdaSignatures(
        string assemblyPath,
        string expectedSourceTypeName,
        string libraryPath)
    {
        var loadContext = new AssemblyLoadContext(
            "Issue2889_" + Guid.NewGuid().ToString("N"),
            isCollectible: true);
        if (libraryPath != null)
        {
            loadContext.Resolving += (_, name) =>
                string.Equals(name.Name, Path.GetFileNameWithoutExtension(libraryPath), StringComparison.Ordinal)
                    ? loadContext.LoadFromAssemblyPath(libraryPath)
                    : null;
        }

        try
        {
            var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
            var signatures = assembly
                .GetTypes()
                .SelectMany(type => type.GetMethods(
                    BindingFlags.Public
                    | BindingFlags.NonPublic
                    | BindingFlags.Static
                    | BindingFlags.Instance))
                .Where(method => method.Name.Contains("<lambda", StringComparison.Ordinal))
                .Select(method =>
                    method.ReturnType + "("
                    + string.Join(",", method.GetParameters().Select(parameter => parameter.ParameterType))
                    + ")")
                .ToArray();

            Assert.NotEmpty(signatures);
            var rendered = string.Join("\n", signatures);
            Assert.Contains(
                "System.Collections.Generic.List`1[" + expectedSourceTypeName + "]",
                rendered,
                StringComparison.Ordinal);
            Assert.DoesNotContain(
                "System.Collections.Generic.List`1[System.Object]",
                rendered,
                StringComparison.Ordinal);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static void Compile(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int exitCode;
        try
        {
            exitCode = Program.Main(args);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
    }
}
