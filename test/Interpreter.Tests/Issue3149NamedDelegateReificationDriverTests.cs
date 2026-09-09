// <copyright file="Issue3149NamedDelegateReificationDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Non-generic named-delegate fixture imported by the G# consumer.</summary>
public delegate int Issue3149Greeter(string value);

/// <summary>Generic named-delegate fixture imported by the G# consumer.</summary>
/// <typeparam name="T">Delegate argument type.</typeparam>
public delegate int Issue3149Mapper<T>(T value);

/// <summary>Mixed overloads whose second parameter selects open or closed candidate.</summary>
public static class Issue3149MixedDelegateOverloads
{
    /// <summary>Returns the closed named delegate.</summary>
    public static Issue3149Greeter Choose(Issue3149Greeter callback, string marker) => callback;

    /// <summary>Returns the inferred open-generic delegate.</summary>
    public static Func<T, int> Choose<T>(Func<T, int> callback, int marker) => callback;
}

/// <summary>Imported type argument for <see cref="Issue3149Mapper{T}"/>.</summary>
public sealed class Issue3149Item
{
    /// <summary>Initializes a new instance of the <see cref="Issue3149Item"/> class.</summary>
    /// <param name="value">Stored value.</param>
    public Issue3149Item(int value) => Value = value;

    /// <summary>Gets the stored value.</summary>
    public int Value { get; }
}

/// <summary>
/// Issue #3149: lambdas flowing through imported erased generic slots retain
/// their declared named-delegate type.
/// </summary>
[Collection("ConsoleIo")]
public sealed class Issue3149NamedDelegateReificationDriverTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MixedOpenAndClosedCandidates_ReifySelectedDelegateAcrossDrivers(bool selectOpen)
    {
        var suffix = selectOpen ? "Open" : "Closed";
        var consumerPackage = "Issue3149Mixed" + suffix;
        var directory = CreateEmptyTestDirectory("Mixed" + suffix);
        try
        {
            var referencePath = typeof(Issue3149Greeter).Assembly.Location;
            File.Copy(referencePath, Path.Combine(directory, Path.GetFileName(referencePath)));
            var statements = selectOpen
                ? """
                    let callback = Issue3149MixedDelegateOverloads.Choose((value string) -> value.Length + 50, 1)
                    Console.WriteLine(callback.GetType().FullName)
                    Console.WriteLine(callback!!("abc"))
                    """
                : """
                    let callbacks = List[Issue3149Greeter]()
                    callbacks.Add((value string) -> value.Length + 40)
                    let callback = callbacks[0]
                    Console.WriteLine(callback.GetType().FullName)
                    Console.WriteLine(callback("abc"))
                    """;
            var sourcePath = WriteSource(
                directory,
                "consumer.gs",
                $$"""
                package {{consumerPackage}}
                import System
                import System.Collections.Generic
                import GSharp.Interpreter.Tests
                import GSharp.Interpreter.Tests.Issue3149Mixed

                public class Probe {
                    shared {
                        public func Run() {
                            {{statements}}
                        }
                    }
                }

                Probe.Run()
                """);
            var expectedOutput = selectOpen
                ? $"{typeof(Func<string, int>).FullName}{Environment.NewLine}53{Environment.NewLine}"
                : $"{typeof(Issue3149Greeter).FullName}{Environment.NewLine}43{Environment.NewLine}";

            var bare = RunCompiler("/nowarn:GS9100", "/r:" + referencePath, sourcePath);
            var assemblyPath = Path.Combine(directory, consumerPackage + ".dll");
            var emitCompile = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + assemblyPath,
                "/r:" + referencePath,
                sourcePath);
            var emitted = emitCompile.ExitCode == 0
                ? await RunAssemblyAsync(directory, assemblyPath)
                : emitCompile;
            var script = RunScriptDriver(sourcePath);

            var failures = new List<string>();
            CheckBareDriver(bare, expectedOutput, failures);
            CheckDriver("gsc /out:", emitted, expectedOutput, failures);
            CheckDriver("gsi", script, expectedOutput, failures);
            Assert.True(failures.Count == 0, string.Join("\n\n", failures));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    /// <summary>
    /// Issue #4130 regression: a driver that exits 0 with the right program
    /// output must still pass even when it also prints a legitimate
    /// WARNING-severity diagnostic. This is deliberately independent of the
    /// self-hosting nondeterminism that originally surfaced the bug —
    /// GS0536 ("Redundant '!!'", reported by ExpressionBinder's
    /// <c>ReportNullAssertionIfRedundant</c>) fires unconditionally whenever
    /// <c>!!</c> is applied to a statically non-nullable value, so a plain
    /// <c>int</c> reproduces the same "warning alongside a successful run"
    /// shape deterministically under the *native* compiler, with no need to
    /// reproduce the self-hosted build that #4130 actually hit. Before
    /// #4130's fix to <see cref="CheckDriver"/>, this test fails because the
    /// warning's text pollutes the bare driver's stdout / breaks the
    /// exact-output-equality check.
    /// </summary>
    [Fact]
    public void BareDriverWarning_RedundantNullAssertion_DoesNotFailDriverCheck()
    {
        var directory = CreateEmptyTestDirectory("RedundantBangBang");
        try
        {
            var sourcePath = WriteSource(
                directory,
                "warn.gs",
                """
                import System
                let value = 41
                Console.WriteLine(value!! + 1)
                """);

            var bare = RunCompiler(sourcePath);

            // The warning must actually have fired — otherwise this test
            // would pass whether or not #4130's CheckDriver fix is present,
            // and would not be discriminating between the two.
            Assert.Contains("GS0536", bare.StandardOutput, StringComparison.Ordinal);

            var failures = new List<string>();
            CheckBareDriver(bare, "42" + Environment.NewLine, failures);
            Assert.True(failures.Count == 0, string.Join("\n\n", failures));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SingleCandidateNamedDelegateThroughErasedListSlot_AllDriversReifyAndInvoke(bool generic)
    {
        var suffix = generic ? "Generic" : "NonGeneric";
        var consumerPackage = "Issue3149Consumer" + suffix;
        var directory = CreateEmptyTestDirectory(suffix);
        try
        {
            var referencePath = typeof(Issue3149Greeter).Assembly.Location;
            var copiedReferencePath = Path.Combine(directory, Path.GetFileName(referencePath));
            File.Copy(referencePath, copiedReferencePath);
            var consumerSource = CreateConsumerSource(consumerPackage, generic);
            Assert.DoesNotContain("import GSharp.Interpreter.Tests.Issue3149Mixed", consumerSource, StringComparison.Ordinal);
            var sourcePath = WriteSource(
                directory,
                "consumer.gs",
                consumerSource);
            var expectedOutput = generic
                ? $"{typeof(Issue3149Mapper<>).FullName}{Environment.NewLine}{typeof(Issue3149Item).FullName}{Environment.NewLine}24{Environment.NewLine}"
                : $"{typeof(Issue3149Greeter).FullName}{Environment.NewLine}13{Environment.NewLine}";

            var bare = RunCompiler(
                "/nowarn:GS9100",
                "/r:" + referencePath,
                sourcePath);

            var assemblyPath = Path.Combine(directory, consumerPackage + ".dll");
            var emitCompile = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + assemblyPath,
                "/r:" + referencePath,
                sourcePath);
            var emitted = emitCompile.ExitCode == 0
                ? await RunAssemblyAsync(directory, assemblyPath)
                : emitCompile;

            var script = RunScriptDriver(sourcePath);

            var inspection = emitCompile.ExitCode == 0
                ? InspectProducedDelegate(
                    copiedReferencePath,
                    assemblyPath,
                    consumerPackage,
                    generic)
                : InspectionResult.Failed("emit compilation failed");

            AssertAllResults(
                bare,
                emitted,
                script,
                inspection,
                expectedOutput,
                generic);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static string CreateConsumerSource(string consumerPackage, bool generic) =>
        generic
            ? $$"""
                package {{consumerPackage}}
                import System
                import System.Collections.Generic
                import GSharp.Interpreter.Tests

                public class Probe {
                    shared {
                        public func Create() Issue3149Mapper[Issue3149Item] {
                            let callbacks = List[Issue3149Mapper[Issue3149Item]]()
                            callbacks.Add((value Issue3149Item) -> value.Value + 20)
                            return callbacks[0]
                        }

                        public func Run() {
                            let callback = Create()
                            let callbackType = callback.GetType()
                            Console.WriteLine(callbackType.GetGenericTypeDefinition().FullName)
                            Console.WriteLine(callbackType.GetGenericArguments()[0].FullName)
                            Console.WriteLine(callback(Issue3149Item(4)))
                        }
                    }
                }

                Probe.Run()
                """
            : $$"""
                package {{consumerPackage}}
                import System
                import System.Collections.Generic
                import GSharp.Interpreter.Tests

                public class Probe {
                    shared {
                        public func Create() Issue3149Greeter {
                            let callbacks = List[Issue3149Greeter]()
                            callbacks.Add((value string) -> value.Length + 10)
                            return callbacks[0]
                        }

                        public func Run() {
                            let callback = Create()
                            Console.WriteLine(callback.GetType().FullName)
                            Console.WriteLine(callback("abc"))
                        }
                    }
                }

                Probe.Run()
                """;

    private static InspectionResult InspectProducedDelegate(
        string referencePath,
        string assemblyPath,
        string consumerPackage,
        bool generic)
    {
        try
        {
            Assert.NotEmpty(typeof(Issue3149Greeter).Assembly.GetTypes());

            var loadContext = new AssemblyLoadContext(
                "Issue3149_" + Guid.NewGuid().ToString("N"),
                isCollectible: true);
            try
            {
                var library = loadContext.LoadFromAssemblyPath(referencePath);
                loadContext.Resolving += (_, name) =>
                {
                    if (name.Name == library.GetName().Name)
                    {
                        return library;
                    }

                    var dependencyPath = Path.Combine(AppContext.BaseDirectory, name.Name + ".dll");
                    return File.Exists(dependencyPath)
                        ? loadContext.LoadFromAssemblyPath(dependencyPath)
                        : null;
                };

                var consumer = loadContext.LoadFromAssemblyPath(assemblyPath);
                Assert.NotEmpty(consumer.GetTypes());
                var probe = consumer.GetType(consumerPackage + ".Probe")
                    ?? throw new InvalidOperationException("Emitted Probe type was not found.");
                var create = probe.GetMethod(
                    "Create",
                    BindingFlags.Public | BindingFlags.Static)
                    ?? throw new InvalidOperationException("Emitted Probe.Create method was not found.");
                var value = create.Invoke(null, null) as Delegate
                    ?? throw new InvalidOperationException("Probe.Create did not return a delegate.");
                var actualType = value.GetType();
                var actualDefinition = actualType.IsGenericType
                    ? actualType.GetGenericTypeDefinition().FullName
                    : actualType.FullName;
                var actualArgument = generic
                    ? actualType.GetGenericArguments()[0].FullName
                    : null;
                var invocationArgument = generic
                    ? Activator.CreateInstance(
                        library.GetType(typeof(Issue3149Item).FullName!)
                            ?? throw new InvalidOperationException("Imported Item type was not found."),
                        4)
                    : "abc";
                var invocationResult = value.DynamicInvoke(invocationArgument);

                return new InspectionResult(
                    actualDefinition,
                    actualArgument,
                    invocationResult,
                    null);
            }
            finally
            {
                loadContext.Unload();
            }
        }
        catch (Exception ex)
        {
            return InspectionResult.Failed(ex.ToString());
        }
    }

    private static void AssertAllResults(
        DriverResult bare,
        DriverResult emitted,
        DriverResult script,
        InspectionResult inspection,
        string expectedOutput,
        bool generic)
    {
        var failures = new List<string>();
        CheckBareDriver(bare, expectedOutput, failures);
        CheckDriver("gsc /out:", emitted, expectedOutput, failures);
        CheckDriver("gsi", script, expectedOutput, failures);

        var expectedDefinition = generic
            ? typeof(Issue3149Mapper<>).FullName
            : typeof(Issue3149Greeter).FullName;
        var expectedArgument = generic ? typeof(Issue3149Item).FullName : null;
        if (!string.Equals(inspection.ActualDefinition, expectedDefinition, StringComparison.Ordinal)
            || !string.Equals(
                inspection.ActualArgument,
                expectedArgument,
                StringComparison.Ordinal)
            || !Equals(inspection.InvocationResult, generic ? 24 : 13)
            || inspection.Error != null)
        {
            failures.Add(
                "delegate inspection failed:"
                + $"\n  expected type: {expectedDefinition}"
                + $"\n  actual type: {inspection.ActualDefinition ?? "<none>"}"
                + $"\n  expected argument: {expectedArgument ?? "<none>"}"
                + $"\n  actual argument: {inspection.ActualArgument ?? "<none>"}"
                + $"\n  invocation: {inspection.InvocationResult ?? "<none>"}"
                + $"\n  error: {inspection.Error ?? "<none>"}");
        }

        Assert.True(failures.Count == 0, string.Join("\n\n", failures));
    }

    private static void CheckBareDriver(
        DriverResult result,
        string expectedOutput,
        List<string> failures) =>
        CheckDriver("gsc", result, expectedOutput + "Success.\n", failures);

    // Issue #4130: bare `gsc` and `gsi` both document that a *successful*
    // run may still print diagnostics — bare `gsc`'s ExecuteInMemory
    // (src/Compiler/Program.cs) prints warnings to stdout ahead of its
    // "Success." trailer, and gsi's RunScript (src/Repl/Program.cs) always
    // "renders [diagnostics] to standard error, the program's output
    // streams straight through" regardless of severity. Neither driver's
    // success contract is "diagnostic-free" — it is "exit code 0", which
    // both already gate on the absence of an ERROR-severity diagnostic
    // (ExecuteInMemory returns non-zero when `effective.Any(d => d.IsError)`;
    // RunScript returns 1 when `!result.Success`). Requiring the raw
    // stdout/stderr text to be byte-for-byte diagnostic-free — as this check
    // did before #4130 — turns a legitimate warning into a false "driver
    // failed", which is exactly what happened here: the reified open-generic
    // delegate case (`selectOpen: true`) triggers GS0536 ("Redundant '!!':
    // the value is already non-null here") on `callback!!("abc")` under a
    // self-hosted gsc whose nullability inference for the mixed open/closed
    // overload is tighter than the native compiler's, even though the actual
    // program output — the whole point of this test — is unaffected. Strip
    // the compiler's own diagnostic blocks (recognisable by
    // TextWriterExtensions.WriteDiagnostics's fixed shape) before comparing,
    // so a driver that exits 0 with the right program output only fails here
    // when its OWN output is actually wrong.
    private static void CheckDriver(
        string name,
        DriverResult result,
        string expectedOutput,
        List<string> failures)
    {
        var actualOutput = StripDiagnosticNoise(result.StandardOutput);
        var actualError = StripDiagnosticNoise(result.StandardError);

        if (result.ExitCode != 0
            || !string.Equals(Normalize(actualOutput), expectedOutput, StringComparison.Ordinal)
            || actualError.Length != 0)
        {
            failures.Add(
                $"{name} failed:"
                + $"\n  exit: {result.ExitCode}"
                + $"\n  stdout:\n{Normalize(result.StandardOutput)}"
                + $"\n  stderr:\n{result.StandardError}");
        }
    }

    // Matches one full TextWriterExtensions.WriteDiagnostics dump: one or
    // more diagnostic entries, each a blank separator line followed by
    // either a located header ("<file>(sl,sc,el,ec): <severity> <id>:
    // <message>") plus its one-line source snippet, or a location-less
    // header ("<severity> <id>: <message>") alone — then the single extra
    // blank line WriteDiagnostics always appends after the last entry.
    // Matching (and removing) the run as one unit, rather than per-line,
    // keeps that shared trailing blank line from being left behind as
    // stray whitespace once the diagnostics themselves are stripped.
    private static readonly Regex CompilerDiagnosticsBlock = new(
        @"(?:\r?\n(?:.*\(\d+,\d+,\d+,\d+\):\ (?:error|warning|info)\ [A-Za-z0-9]+:\ .*\r?\n.*\r?\n" +
        @"|(?:error|warning|info)\ [A-Za-z0-9]+:\ .*\r?\n))+\r?\n",
        RegexOptions.Compiled);

    private static string StripDiagnosticNoise(string text) =>
        string.IsNullOrEmpty(text) ? text : CompilerDiagnosticsBlock.Replace(text, string.Empty);

    private static DriverResult RunCompiler(params string[] arguments) =>
        Capture(() => GSharp.Compiler.Program.Main(arguments));

    private static DriverResult RunScriptDriver(string sourcePath) =>
        Capture(() => GSharp.Repl.Program.Main(new[] { sourcePath }));

    private static DriverResult Capture(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                return new DriverResult(action(), stdout.ToString(), stderr.ToString());
            }
            catch (Exception ex)
            {
                return new DriverResult(-1, stdout.ToString(), stderr + ex.ToString());
            }
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static async Task<DriverResult> RunAssemblyAsync(string directory, string assemblyPath)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        File.WriteAllText(
            runtimeConfigPath,
            """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        try
        {
            var result = await DotnetProcess.RunAsync(
                directory,
                ["exec", "--runtimeconfig", runtimeConfigPath, assemblyPath]);
            return new DriverResult(
                result.ExitCode,
                result.StandardOutput,
                result.StandardError);
        }
        catch (Exception ex)
        {
            return new DriverResult(-1, string.Empty, ex.ToString());
        }
    }

    private static string WriteSource(string directory, string fileName, string source)
    {
        var path = Path.Combine(directory, fileName);
        File.WriteAllText(path, source);
        return path;
    }

    private static string CreateEmptyTestDirectory(string suffix)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue3149_" + suffix + "_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
        return directory;
    }

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

    private static string Normalize(string value) =>
        value.ReplaceLineEndings(Environment.NewLine);

    private sealed record DriverResult(int ExitCode, string StandardOutput, string StandardError);

    private sealed record InspectionResult(
        string ActualDefinition,
        string ActualArgument,
        object InvocationResult,
        string Error)
    {
        public static InspectionResult Failed(string error) =>
            new(null, null, null, error);
    }
}
