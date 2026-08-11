// <copyright file="Issue3140OutParameterWriteBackDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3140: user-method ref/out write-back across every receiver and
/// operand shape, asserted against golden values on both emitted hosts —
/// out-of-process (<c>gsc /out:</c> + <c>dotnet exec</c>) and the in-process
/// submission-mode oracle. The tree-walking evaluator and evaluator
/// SessionEngine columns retired in ADR-0156 Phase 3c (#3176).
/// </summary>
[Collection("ConsoleIo")]
public class Issue3140OutParameterWriteBackDriverTests
{
    /// <summary>Gets receiver and argument-shape matrix rows.</summary>
    /// <returns>Matrix rows.</returns>
    public static IEnumerable<object[]> ReceiverShapeMatrix()
    {
        foreach (var receiver in Enum.GetValues<ReceiverKind>())
        {
            foreach (var shape in Enum.GetValues<ArgumentShape>())
            {
                yield return new object[] { receiver, shape };
            }
        }
    }

    [Theory]
    [MemberData(nameof(ReceiverShapeMatrix))]
    public async Task OutParameterWriteBack_AgreesAcrossEmittedDrivers(
        ReceiverKind receiver,
        ArgumentShape shape)
    {
        await AssertEmittedDriverAgreementAsync(
            BuildSource(receiver, shape),
            GetExpectedOutput(shape),
            receiver + "-" + shape);
    }

    /// <summary>Gets receiver and write-back operand-kind rows.</summary>
    /// <returns>Receiver and operand-kind rows.</returns>
    public static IEnumerable<object[]> WriteBackOperandMatrix()
    {
        foreach (var receiver in Enum.GetValues<ReceiverKind>())
        {
            foreach (var operand in Enum.GetValues<OperandKind>())
            {
                yield return new object[] { receiver, operand };
            }
        }
    }

    [Theory]
    [MemberData(nameof(WriteBackOperandMatrix))]
    public async Task OutParameterWriteBack_ReceiverAndOperandKindsAgreeAcrossEmittedDrivers(
        ReceiverKind receiver,
        OperandKind operand)
    {
        await AssertEmittedDriverAgreementAsync(
            BuildOperandSource(receiver, operand),
            "91",
            receiver + "-" + operand);
    }

    /// <summary>Call receiver shape.</summary>
    public enum ReceiverKind
    {
        /// <summary>Free function.</summary>
        Free,

        /// <summary>Class shared method.</summary>
        ClassShared,

        /// <summary>Class instance method.</summary>
        ClassInstance,

        /// <summary>Struct shared method.</summary>
        StructShared,

        /// <summary>Struct instance method.</summary>
        StructInstance,

        /// <summary>Class implementation called through interface.</summary>
        Interface,

        /// <summary>Base-class method called through <c>base</c>.</summary>
        BaseClass,

        /// <summary>Generic class instance method.</summary>
        GenericMethod,

        /// <summary>Interface default method called through <c>base[IFiller]</c>.</summary>
        BaseInterface,

        /// <summary>Static interface method called through a constrained type parameter.</summary>
        ConstrainedStatic,
    }

    /// <summary>Argument shape.</summary>
    public enum ArgumentShape
    {
        /// <summary>One out argument.</summary>
        SingleOut,

        /// <summary>Two out arguments.</summary>
        MultipleOut,

        /// <summary>Out and ref arguments.</summary>
        OutAndRef,

        /// <summary>Out and normal arguments.</summary>
        OutAndNormal,

        /// <summary>Distinct assignments in conditional branches.</summary>
        ConditionalOut,
    }

    /// <summary>Caller storage kind used by a ref/out argument.</summary>
    public enum OperandKind
    {
        /// <summary>Local variable.</summary>
        Variable,

        /// <summary>Instance field.</summary>
        Field,

        /// <summary>Array element.</summary>
        Index,

        /// <summary>Dereferenced managed address.</summary>
        Dereference,
    }

    private static string BuildSource(ReceiverKind receiver, ArgumentShape shape) =>
        BuildSource(
            receiver,
            GetShape(shape),
            $"Issue3140{receiver}{shape}",
            string.Empty);

    private static string BuildSource(
        ReceiverKind receiver,
        ShapeSpec spec,
        string package,
        string extraDeclaration)
    {
        var method = $"func Fill({spec.Parameters}) {{\n{Indent(spec.Body, 4)}\n}}";
        string declarations;
        string target;
        var callPrefix = string.Empty;

        switch (receiver)
        {
            case ReceiverKind.Free:
                declarations = method;
                target = "Fill";
                break;
            case ReceiverKind.ClassShared:
                declarations = $"class Target {{\n    shared {{\n{Indent(method, 8)}\n    }}\n}}";
                target = "Target.Fill";
                break;
            case ReceiverKind.ClassInstance:
                declarations = $"class Target {{\n{Indent(method, 4)}\n}}";
                target = "target.Fill";
                break;
            case ReceiverKind.StructShared:
                declarations = $"struct Target {{\n    shared {{\n{Indent(method, 8)}\n    }}\n}}";
                target = "Target.Fill";
                break;
            case ReceiverKind.StructInstance:
                declarations = $"struct Target {{\n{Indent(method, 4)}\n}}";
                target = "target.Fill";
                break;
            case ReceiverKind.Interface:
                declarations =
                    $"interface Filler {{\n    func Fill({spec.Parameters});\n}}\n"
                    + $"class Target : Filler {{\n{Indent(method, 4)}\n}}";
                target = "target.Fill";
                break;
            case ReceiverKind.BaseClass:
                declarations =
                    $"open class Base {{\n{Indent(method, 4)}\n}}\n"
                    + $"class Target : Base {{\n    func Invoke({spec.Parameters}) {{\n"
                    + $"        base.Fill({spec.ForwardArguments})\n    }}\n}}";
                target = "target.Invoke";
                break;
            case ReceiverKind.GenericMethod:
                method = $"func Fill[T](marker T, {spec.Parameters}) {{\n{Indent(spec.Body, 4)}\n}}";
                declarations = $"class Target {{\n{Indent(method, 4)}\n}}";
                target = "target.Fill[string]";
                callPrefix = "\"marker\", ";
                break;
            case ReceiverKind.BaseInterface:
                declarations =
                    $"interface Filler {{\n{Indent(method, 4)}\n}}\n"
                    + $"class Target : Filler {{\n    func Fill({spec.Parameters}) {{\n"
                    + $"        base[Filler].Fill({spec.ForwardArguments})\n    }}\n}}";
                target = "target.Fill";
                break;
            case ReceiverKind.ConstrainedStatic:
                declarations =
                    $"interface Filler {{\n    shared {{\n        func Fill({spec.Parameters});\n    }}\n}}\n"
                    + $"struct Target : Filler {{\n    shared {{\n{Indent(method, 8)}\n    }}\n}}\n"
                    + $"func Invoke[T Filler](witness T, {spec.Parameters}) {{\n"
                    + $"    T.Fill({spec.ForwardArguments})\n}}";
                target = "Invoke";
                callPrefix = "Target{}, ";
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(receiver), receiver, null);
        }

        var receiverLocal = receiver switch
        {
            ReceiverKind.ClassInstance or ReceiverKind.BaseClass or ReceiverKind.GenericMethod
                or ReceiverKind.BaseInterface =>
                "var target = Target()",
            ReceiverKind.StructInstance => "var target = Target{}",
            ReceiverKind.Interface => "var target Filler = Target()",
            _ => string.Empty,
        };
        var calls = string.Join(
            Environment.NewLine,
            spec.Calls.Select(call =>
                $"{target}({callPrefix}{call.Arguments}){Environment.NewLine}{call.Output}"));

        return $"""
            package {package}
            import System

            {declarations}

            {extraDeclaration}

            {receiverLocal}
            {spec.Locals}
            {calls}
            """;
    }

    private static string BuildOperandSource(ReceiverKind receiver, OperandKind operand)
    {
        var (declaration, locals, argument, output) = operand switch
        {
            OperandKind.Variable => (
                string.Empty,
                "var value = 101",
                "&value",
                "value"),
            OperandKind.Field => (
                "class Holder { var Value int32 }",
                "let holder = Holder{}\nholder.Value = 102",
                "&holder.Value",
                "holder.Value"),
            OperandKind.Index => (
                string.Empty,
                "var values = []int32{101, 104}",
                "&values[1]",
                "values[1]"),
            OperandKind.Dereference => (
                string.Empty,
                "var value = 105",
                "&*(&value)",
                "value"),
            _ => throw new ArgumentOutOfRangeException(nameof(operand), operand, null),
        };

        var spec = new ShapeSpec(
            "out value int32",
            "value = 91",
            locals,
            "&value",
            [new(argument, $"Console.WriteLine({output})")]);
        return BuildSource(
            receiver,
            spec,
            $"Issue3140Operand{receiver}{operand}",
            declaration);
    }

    private static ShapeSpec GetShape(ArgumentShape shape) => shape switch
    {
        ArgumentShape.SingleOut => new(
            "out first int32",
            "first = 11",
            "var first = 101",
            "&first",
            [new("&first", "Console.WriteLine(first)")]),
        ArgumentShape.MultipleOut => new(
            "out first int32, out second int32",
            "first = 21\nsecond = 22",
            "var first = 201\nvar second = 202",
            "&first, &second",
            [new("&first, &second", "Console.WriteLine(first)\nConsole.WriteLine(second)")]),
        ArgumentShape.OutAndRef => new(
            "out first int32, ref second int32",
            "first = 31\nsecond = second + 4",
            "var first = 301\nvar second = 33",
            "&first, &second",
            [new("&first, &second", "Console.WriteLine(first)\nConsole.WriteLine(second)")]),
        ArgumentShape.OutAndNormal => new(
            "out first int32, input int32",
            "first = input + 1",
            "var first = 401\nlet input = 43",
            "&first, input",
            [new("&first, input", "Console.WriteLine(first)")]),
        ArgumentShape.ConditionalOut => new(
            "flag bool, out first int32",
            "if flag {\n    first = 51\n} else {\n    first = 52\n}",
            "var firstTrue = 501\nvar firstFalse = 502",
            "flag, &first",
            [
                new("true, &firstTrue", "Console.WriteLine(firstTrue)"),
                new("false, &firstFalse", "Console.WriteLine(firstFalse)"),
            ]),
        _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, null),
    };

    private static string GetExpectedOutput(ArgumentShape shape) => shape switch
    {
        ArgumentShape.SingleOut => "11",
        ArgumentShape.MultipleOut => "21\n22",
        ArgumentShape.OutAndRef => "31\n37",
        ArgumentShape.OutAndNormal => "44",
        ArgumentShape.ConditionalOut => "51\n52",
        _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, null),
    };

    private static async Task AssertEmittedDriverAgreementAsync(string source, string expected, string name)
    {
        var root = CreateEmptyDirectory(name);
        try
        {
            var emitted = await RunEmittedAsync(source, CreateEmptyDirectory(root, "emit"));
            var inProcess = RunEmittedOracle(source);

            Assert.Equal(expected, emitted);
            Assert.NotEmpty(emitted);
            Assert.Equal(emitted, inProcess);
        }
        finally
        {
            DeleteDirectory(root);
        }
    }

    private static string RunEmittedOracle(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
        Assert.True(
            errors.Length == 0,
            "oracle evaluation failed:\n" + string.Join("\n", errors.Select(error => error.ToString())));
        Assert.Equal(string.Empty, result.ErrorOutput);
        return Normalize(result.Output, stripCompilerSuccess: false);
    }

    private static async Task<string> RunEmittedAsync(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        var assemblyPath = Path.Combine(directory, "probe.dll");
        File.WriteAllText(sourcePath, source);
        var compile = CaptureConsole(
            () => GSharp.Compiler.Program.Main(
                ["/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath]));

        Assert.True(
            compile.ExitCode == 0,
            $"emit failed ({compile.ExitCode})\nstdout:\n{compile.Stdout}\nstderr:\n{compile.Stderr}");
        Assert.Equal(string.Empty, compile.Stderr);
        CollectibleAssembly.Inspect(assemblyPath, assembly => Assert.NotEmpty(assembly.GetTypes()));

        var result = await DotnetProcess.RunAsync(
            directory,
            [
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            ]);
        Assert.True(
            result.ExitCode == 0,
            $"emitted program failed ({result.ExitCode})\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        Assert.Equal(string.Empty, result.StandardError);
        return Normalize(result.StandardOutput, stripCompilerSuccess: false);
    }

    private static DriverResult CaptureConsole(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return new DriverResult(action(), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string Normalize(string output, bool stripCompilerSuccess) =>
        string.Join(
            "\n",
            output.ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
                .Where(line => !stripCompilerSuccess || line != "Success."));

    private static string CreateEmptyDirectory(string name)
    {
        var parent = Path.Combine(AppContext.BaseDirectory, nameof(Issue3140OutParameterWriteBackDriverTests));
        return CreateEmptyDirectory(parent, name + "-" + Guid.NewGuid().ToString("N"));
    }

    private static string CreateEmptyDirectory(string parent, string name)
    {
        var path = Path.Combine(parent, name);
        Directory.CreateDirectory(path);
        Assert.Empty(Directory.EnumerateFileSystemEntries(path));
        return path;
    }

    private static void DeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static string Indent(string value, int spaces)
    {
        var prefix = new string(' ', spaces);
        return string.Join(
            Environment.NewLine,
            value.Split(Environment.NewLine).Select(line => prefix + line));
    }

    private sealed record ShapeSpec(
        string Parameters,
        string Body,
        string Locals,
        string ForwardArguments,
        CallSpec[] Calls);

    private sealed record CallSpec(string Arguments, string Output);

    private readonly record struct DriverResult(int ExitCode, string Stdout, string Stderr);
}
