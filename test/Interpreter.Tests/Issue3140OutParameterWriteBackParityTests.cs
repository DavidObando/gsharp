// <copyright file="Issue3140OutParameterWriteBackParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Issue #3140: evaluated user-method ref/out writes must match emitted execution.</summary>
[Collection("ConsoleIo")]
public class Issue3140OutParameterWriteBackParityTests
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
    public async Task OutParameterWriteBack_GscEvaluateAndGsiMatchEmit(
        ReceiverKind receiver,
        ArgumentShape shape)
    {
        var source = BuildSource(receiver, shape);
        var root = CreateEmptyDirectory(receiver + "-" + shape);
        try
        {
            var emitted = await RunEmittedAsync(source, CreateEmptyDirectory(root, "emit"));
            var evaluated = RunSourceDriver(
                source,
                CreateEmptyDirectory(root, "evaluate"),
                GSharp.Compiler.Program.Main,
                stripCompilerSuccess: true);
            var interpreted = RunSourceDriver(
                source,
                CreateEmptyDirectory(root, "gsi"),
                GSharp.Repl.Program.Main,
                stripCompilerSuccess: false);

            Assert.NotEmpty(emitted);
            Assert.Equal(emitted, evaluated);
            Assert.Equal(emitted, interpreted);
        }
        finally
        {
            DeleteDirectory(root);
        }
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

    private static string BuildSource(ReceiverKind receiver, ArgumentShape shape)
    {
        var spec = GetShape(shape);
        var package = $"Issue3140{receiver}{shape}";
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
            default:
                throw new ArgumentOutOfRangeException(nameof(receiver), receiver, null);
        }

        var receiverLocal = receiver switch
        {
            ReceiverKind.ClassInstance or ReceiverKind.BaseClass or ReceiverKind.GenericMethod =>
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

            {receiverLocal}
            {spec.Locals}
            {calls}
            """;
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

    private static string RunSourceDriver(
        string source,
        string directory,
        Func<string[], int> driver,
        bool stripCompilerSuccess)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        File.WriteAllText(sourcePath, source);
        var result = CaptureConsole(() => driver([sourcePath]));

        Assert.True(
            result.ExitCode == 0,
            $"driver failed ({result.ExitCode})\nstdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
        Assert.Equal(string.Empty, result.Stderr);
        return Normalize(result.Stdout, stripCompilerSuccess);
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
        Assert.NotEmpty(Assembly.Load(File.ReadAllBytes(assemblyPath)).GetTypes());

        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo);
        Assert.NotNull(process);
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("emitted program timed out");
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        Assert.True(
            process.ExitCode == 0,
            $"emitted program failed ({process.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.Equal(string.Empty, stderr);
        return Normalize(stdout, stripCompilerSuccess: false);
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
            output.Replace("\r\n", "\n", StringComparison.Ordinal)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Where(line => !stripCompilerSuccess || line != "Success."));

    private static string CreateEmptyDirectory(string name)
    {
        var parent = Path.Combine(AppContext.BaseDirectory, nameof(Issue3140OutParameterWriteBackParityTests));
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
            value.Split('\n').Select(line => prefix + line));
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
