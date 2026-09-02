// <copyright file="Issue3067IteratorConstraintRemapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

[Collection("Issue3067Console")]
public class Issue3067IteratorConstraintRemapTests
{
    public static IEnumerable<object[]> ConstraintCases()
    {
        yield return Case(
            "class-constraint",
            "ClassValues",
            "11",
            ConstraintShape.ClassReferencesMethodParameter,
            """
            package Issue3067.ClassConstraint
            import System
            open class Box[T any] {}
            class IntBox : Box[int32] {}
            func ClassValues[T any, TBox Box[T] init()](value T) sequence[T] {
                yield value
            }
            for value in ClassValues[int32, IntBox](11) {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "interface-constraint",
            "InterfaceValues",
            "22",
            ConstraintShape.InterfaceReferencesSelf,
            """
            package Issue3067.InterfaceConstraint
            import System
            func InterfaceValues[T IComparable[T]](value T) sequence[T] {
                yield value
            }
            for value in InterfaceValues[int32](22) {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "new-constraint",
            "NewValues",
            "33",
            ConstraintShape.DefaultConstructor,
            """
            package Issue3067.NewConstraint
            import System
            func NewValues[T init()](value T) sequence[T] {
                yield value
            }
            for value in NewValues[int32](33) {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "cross-method-constraint",
            "CrossValues",
            "44",
            ConstraintShape.ClassReferencesTwoMethodParameters,
            """
            package Issue3067.CrossConstraint
            import System
            open class Pair[A any, B any] {}
            class IntStringPair : Pair[int32, string] {}
            func CrossValues[T any, U any, TBox Pair[T, U] init()](value U) sequence[U] {
                yield value
            }
            for value in CrossValues[int32, string, IntStringPair]("44") {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "generic-owner-and-method",
            "MixedValues",
            "55",
            ConstraintShape.ClassReferencesClassAndMethodParameters,
            """
            package Issue3067.GenericOwner
            import System
            open class Pair[A any, B any] {}
            class IntStringPair : Pair[int32, string] {}
            class Maker[TClass any] {
                func MixedValues[TMethod any, TBox Pair[TClass, TMethod] init()](value TMethod) sequence[TMethod] {
                    yield value
                }
            }
            for value in Maker[int32]().MixedValues[string, IntStringPair]("55") {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "nested-generic-owner",
            "NestedValues",
            "66",
            ConstraintShape.NestedOwnerAndMethod,
            """
            package Issue3067.NestedOwner
            import System
            class Outer[TOuter any] {
                struct Inner[TInner any] {
                    func NestedValues[TMethod IComparable[TMethod]](value TMethod) sequence[TMethod] {
                        yield value
                    }
                }
            }
            var inner = Outer[int32].Inner[string]{}
            for value in inner.NestedValues[int32](66) {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "enclosing-parameter-constraint",
            "EnclosingValues",
            "77",
            ConstraintShape.EnclosingParameterReferencesSelf,
            """
            package Issue3067.EnclosingConstraint
            import System
            class Owner[T IComparable[T]] {
                func EnclosingValues(value T) sequence[T] {
                    yield value
                }
            }
            for value in Owner[int32]().EnclosingValues(77) {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "non-generic-control",
            "PlainValues",
            "88",
            ConstraintShape.NonGeneric,
            """
            package Issue3067.NonGeneric
            import System
            func PlainValues(value int32) sequence[int32] {
                yield value
            }
            for value in PlainValues(88) {
                Console.WriteLine(value)
            }
            """);

        yield return Case(
            "async-iterator",
            "AsyncValues",
            "99",
            ConstraintShape.InterfaceReferencesSelf,
            """
            package Issue3067.AsyncInterfaceConstraint
            import System
            import System.Collections.Generic
            import System.Threading.Tasks
            async func AsyncValues[T IComparable[T]](value T) IAsyncEnumerable[T] {
                await Task.CompletedTask
                yield value
            }
            async func Read[T any](values IAsyncEnumerable[T]) Task[T] {
                await for value in values {
                    return value
                }
                return default(T)
            }
            Console.WriteLine(Read[int32](AsyncValues[int32](99)).GetAwaiter().GetResult())
            """);
    }

    public static IEnumerable<object[]> DriverMatrix()
    {
        foreach (var position in Enum.GetValues<SourcePosition>())
        {
            foreach (var driver in Enum.GetValues<Driver>())
            {
                yield return new object[] { position, driver };
            }
        }
    }

    [Theory]
    [MemberData(nameof(ConstraintCases))]
    public void StateMachineConstraintMetadata_ReferencesClassParameters_AndRuns(
        string name,
        string methodName,
        string expectedOutput,
        ConstraintShape shape,
        string source)
    {
        var directory = CreateDirectory(name);
        try
        {
            var assemblyPath = Compile(source, directory);
            var assembly = EmittedFixture.Load(assemblyPath);
            var types = assembly.GetTypes();
            var stateMachine = Assert.Single(
                types,
                type => type.Name.StartsWith("<" + methodName + ">d__", StringComparison.Ordinal));

            AssertConstraints(stateMachine, shape);
            Assert.Equal(expectedOutput + Environment.NewLine, Run(assemblyPath, directory));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Theory]
    [MemberData(nameof(DriverMatrix))]
    public void ConstraintRepro_PositionAndCompilerDriverMatrix_Runs(
        SourcePosition position,
        Driver driver)
    {
        var expected = position == SourcePosition.TopLevel ? "66" : "77";
        var source = position == SourcePosition.TopLevel
            ? TopLevelSource
            : InFunctionSource;
        var directory = CreateDirectory(position + "-" + driver);
        try
        {
            var sourcePath = Path.Combine(directory, "probe.gs");
            File.WriteAllText(sourcePath, source);

            if (driver == Driver.Emit)
            {
                var assemblyPath = Compile(source, directory);
                Assert.Equal(expected + Environment.NewLine, Run(assemblyPath, directory));
                return;
            }

            using var output = new StringWriter();
            var previous = Console.Out;
            Console.SetOut(output);
            try
            {
                Assert.Equal(0, Program.Main([sourcePath]));
            }
            finally
            {
                Console.SetOut(previous);
            }

            Assert.Contains(expected + Environment.NewLine, output.ToString().ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    public enum ConstraintShape
    {
        ClassReferencesMethodParameter,
        InterfaceReferencesSelf,
        DefaultConstructor,
        ClassReferencesTwoMethodParameters,
        ClassReferencesClassAndMethodParameters,
        NestedOwnerAndMethod,
        EnclosingParameterReferencesSelf,
        NonGeneric,
    }

    public enum SourcePosition
    {
        TopLevel,
        InFunction,
    }

    public enum Driver
    {
        Evaluate,
        Emit,
    }

    private const string TopLevelSource = """
        package Issue3067.MatrixTopLevel
        import System
        open class Box[T any] {}
        class IntBox : Box[int32] {}
        func Values[T any, TBox Box[T] init()](value T) sequence[T] {
            yield value
        }
        for value in Values[int32, IntBox](66) {
            Console.WriteLine(value)
        }
        """;

    private const string InFunctionSource = """
        package Issue3067.MatrixInFunction
        import System
        open class Box[T any] {}
        class IntBox : Box[int32] {}
        func Values[T any, TBox Box[T] init()](value T) sequence[T] {
            yield value
        }
        func Run() {
            for value in Values[int32, IntBox](77) {
                Console.WriteLine(value)
            }
        }
        Run()
        """;

    private static object[] Case(
        string name,
        string methodName,
        string expectedOutput,
        ConstraintShape shape,
        string source) =>
        [name, methodName, expectedOutput, shape, source];

    private static void AssertConstraints(Type stateMachine, ConstraintShape shape)
    {
        if (shape == ConstraintShape.NonGeneric)
        {
            Assert.False(stateMachine.IsGenericTypeDefinition);
            Assert.Empty(stateMachine.GetGenericArguments());
            return;
        }

        Assert.True(stateMachine.IsGenericTypeDefinition);
        var parameters = stateMachine.GetGenericArguments();
        switch (shape)
        {
            case ConstraintShape.ClassReferencesMethodParameter:
                AssertParameterNames(parameters, "T", "TBox");
                AssertConstructedConstraint(parameters[1], "Box`1", parameters[0]);
                AssertDefaultConstructor(parameters[1]);
                break;
            case ConstraintShape.InterfaceReferencesSelf:
                AssertParameterNames(parameters, "T");
                var comparable = Assert.Single(parameters[0].GetGenericParameterConstraints());
                Assert.Equal(typeof(IComparable<>), comparable.GetGenericTypeDefinition());
                Assert.Equal(parameters[0], Assert.Single(comparable.GetGenericArguments()));
                break;
            case ConstraintShape.DefaultConstructor:
                AssertParameterNames(parameters, "T");
                Assert.Empty(parameters[0].GetGenericParameterConstraints());
                AssertDefaultConstructor(parameters[0]);
                break;
            case ConstraintShape.ClassReferencesTwoMethodParameters:
                AssertParameterNames(parameters, "T", "U", "TBox");
                AssertConstructedConstraint(parameters[2], "Pair`2", parameters[0], parameters[1]);
                AssertDefaultConstructor(parameters[2]);
                break;
            case ConstraintShape.ClassReferencesClassAndMethodParameters:
                AssertParameterNames(parameters, "TClass", "TMethod", "TBox");
                AssertConstructedConstraint(parameters[2], "Pair`2", parameters[0], parameters[1]);
                AssertDefaultConstructor(parameters[2]);
                break;
            case ConstraintShape.NestedOwnerAndMethod:
                AssertParameterNames(parameters, "TOuter", "TInner", "TMethod");
                var nestedComparable = Assert.Single(parameters[2].GetGenericParameterConstraints());
                Assert.Equal(typeof(IComparable<>), nestedComparable.GetGenericTypeDefinition());
                Assert.Equal(parameters[2], Assert.Single(nestedComparable.GetGenericArguments()));
                break;
            case ConstraintShape.EnclosingParameterReferencesSelf:
                AssertParameterNames(parameters, "T");
                var enclosingComparable = Assert.Single(parameters[0].GetGenericParameterConstraints());
                Assert.Equal(typeof(IComparable<>), enclosingComparable.GetGenericTypeDefinition());
                Assert.Equal(parameters[0], Assert.Single(enclosingComparable.GetGenericArguments()));
                break;
            default:
                throw new InvalidOperationException("Unexpected constraint shape.");
        }
    }

    private static void AssertConstructedConstraint(
        Type parameter,
        string genericTypeName,
        params Type[] expectedArguments)
    {
        var constraint = Assert.Single(parameter.GetGenericParameterConstraints());
        Assert.True(constraint.IsGenericType);
        Assert.Equal(genericTypeName, constraint.GetGenericTypeDefinition().Name);
        Assert.Equal(expectedArguments, constraint.GetGenericArguments());
    }

    private static void AssertParameterNames(Type[] parameters, params string[] expected) =>
        Assert.Equal(expected, parameters.Select(parameter => parameter.Name));

    private static void AssertDefaultConstructor(Type parameter) =>
        Assert.True(
            (parameter.GenericParameterAttributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0);

    private static string Compile(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        var assemblyPath = Path.Combine(directory, "probe.dll");
        File.WriteAllText(sourcePath, source);

        Assert.Equal(
            0,
            Program.Main(
            [
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            ]));
        return assemblyPath;
    }

    private static string Run(string assemblyPath, string directory)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException("Failed to start dotnet child process.");

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new TimeoutException("dotnet child process timed out.");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static string CreateDirectory(string name) =>
        Directory.CreateDirectory(
            Path.Combine(
                AppContext.BaseDirectory,
                "issue3067",
                name + "-" + Guid.NewGuid().ToString("N"))).FullName;

    private static void DeleteDirectory(string directory)
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

[CollectionDefinition("Issue3067Console", DisableParallelization = true)]
public sealed class Issue3067ConsoleCollection
{
}
