// <copyright file="Issue4054OrdinaryClrUserDefinedConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4054: same-compilation user-defined implicit conversions participate
/// in ordinary imported CLR method applicability and ranking.
/// </summary>
public class Issue4054OrdinaryClrUserDefinedConversionTests
{
    private const int RunTimeout = 60_000;

    private const string Preamble = """
        package P
        import System
        import HelperLib4054

        struct Celsius {
            var Degrees float64
        }

        func operator implicit(value Celsius) float64 {
            return value.Degrees
        }

        struct Label {
            var Text string
        }

        func operator implicit(value Label) string {
            return value.Text
        }

        struct AmbiguousValue {
            var Value int32
        }

        func operator implicit(value AmbiguousValue) string {
            return value.Value.ToString()
        }

        func operator implicit(value AmbiguousValue) DateTime {
            return DateTime(2026, 9, 8)
        }

        struct ExplicitOnly {
            var Value float64
        }

        func operator explicit(value ExplicitOnly) float64 {
            return value.Value
        }

        class LocalTarget : BaseTarget {
        }

        struct LocalRankSource : ILeft, IRight {
        }

        func operator implicit(value LocalRankSource) LeftImplementation {
            return LeftImplementation()
        }

        struct Projectable {
            var Value int32
        }

        func operator implicit(value Projectable) ProjectionTarget {
            let result = ProjectionTarget()
            result.Value = value.Value + 100
            return result
        }

        class CrossCastSource {
        }

        func operator implicit(value CrossCastSource) IDisposable {
            return DisposableValue()
        }

        struct GenericSource {
            var Text string
        }

        func operator implicit(value GenericSource) GenericBox[object] {
            return GenericBox[object](value.Text)
        }

        """;

    private const string LibrarySource = """
        using System;
        using System.Linq;

        namespace HelperLib4054;

        public static class ConversionTargets
        {
            public static double StaticValue(double value) => value;

            public static string StaticText(string value) => value;

            public static string Prefer(double value) => "double";

            public static string Prefer(object value) => "object";

            public static string PreferText(string value) => "string";

            public static string PreferText(object value) => "object";

            public static T Generic<T>(T value) => value;

            public static double Params(params double[] values) => values.Sum();

            public static double WithLambda(double value, Func<double, double> map) => map(value);

            public static double? NullableValue(double? value) => value;

            public static string GenericRank<T>(T value) => "generic";

            public static string GenericRank(double value) => "double";

            public static string GenericParamsRank<T>(params T[] values) => "generic";

            public static string GenericParamsRank(params double[] values) => "double";

            public static string StandardRank(ILeft value) => "left";

            public static string StandardRank(IRight value) => "right";

            public static string InterfaceValue(IDisposable value) => value.GetType().Name;

            public static string ParamsDisposable(params IDisposable[] values) => values[0].GetType().Name;

            public static string GenericTarget(GenericBox<object> value) => value.Value?.ToString() ?? string.Empty;

            public static string Ambiguous(string value) => "string";

            public static string Ambiguous(DateTime value) => "date";

            public static int Reject(Guid value) => 1;
        }

        public sealed class InstanceTarget
        {
            public double Value(double value) => value;

            public string Text(string value) => value;
        }

        public class BaseTarget
        {
            public double Inherited(double value) => value;
        }

        public static class TargetExtensions
        {
            public static double ExtensionValue(this InstanceTarget target, double value) => value;
        }

        public interface IConstrainedTarget
        {
            double ConstrainedValue(double value);

            double ConstrainedParams(params double[] values);

            int ConstrainedProjection(ProjectionTarget value);

            string ConstrainedInterface(ILeft value);

            string ConstrainedDisposable(IDisposable value);

            string ConstrainedAmbiguous(string value);

            string ConstrainedAmbiguous(DateTime value);
        }

        public sealed class ConstrainedTarget : IConstrainedTarget
        {
            public double ConstrainedValue(double value) => value;

            public double ConstrainedParams(params double[] values) => values.Sum();

            public int ConstrainedProjection(ProjectionTarget value) => value.Value;

            public string ConstrainedInterface(ILeft value) => value.GetType().Name;

            public string ConstrainedDisposable(IDisposable value) => value.GetType().Name;

            public string ConstrainedAmbiguous(string value) => "string";

            public string ConstrainedAmbiguous(DateTime value) => "date";
        }

        public interface IStaticConstrainedTarget<TSelf>
            where TSelf : IStaticConstrainedTarget<TSelf>
        {
            static abstract double ConstrainedStaticValue(double value);

            static abstract double ConstrainedStaticParams(params double[] values);

            static abstract double ConstrainedStaticNamed(string first, double second);

            static abstract string ConstrainedStaticAmbiguous(string value);

            static abstract string ConstrainedStaticAmbiguous(DateTime value);
        }

        public sealed class StaticConstrainedTarget : IStaticConstrainedTarget<StaticConstrainedTarget>
        {
            public static double ConstrainedStaticValue(double value) => value;

            public static double ConstrainedStaticParams(params double[] values) => values.Sum();

            public static double ConstrainedStaticNamed(string first, double second) => second;

            public static string ConstrainedStaticAmbiguous(string value) => "string";

            public static string ConstrainedStaticAmbiguous(DateTime value) => "date";
        }

        public interface IConsumer<T>
        {
            int Consume(T value);

            int ConsumeMany(params T[] values);
        }

        public interface IStaticConsumer<T>
        {
            static abstract int Consume(T value);

            static abstract int ConsumeMany(params T[] values);
        }

        public interface ILeft
        {
        }

        public interface IRight
        {
        }

        public sealed class LeftImplementation : ILeft
        {
        }

        public readonly struct ImportedRankSource : ILeft, IRight
        {
        }

        public sealed class ProjectionTarget
        {
            public int Value { get; set; }
        }

        public sealed class DisposableValue : IDisposable
        {
            public void Dispose()
            {
            }
        }

        public sealed class GenericBox<T>
        {
            public GenericBox(T value) => Value = value;

            public T Value { get; }
        }

        public static class GenericStatic<T>
        {
            public static string InterfaceValue(IDisposable value) => value.GetType().Name;
        }

        public readonly struct Fahrenheit
        {
            public Fahrenheit(double degrees) => Degrees = degrees;

            public double Degrees { get; }

            public static implicit operator double(Fahrenheit value) => value.Degrees;
        }
        """;

    /// <summary>Positive programs that compile, IL-verify, execute, and print.</summary>
    /// <returns>Case name, source body, and expected stdout lines.</returns>
    public static IEnumerable<object[]> SuccessfulCalls()
    {
        yield return new object[]
        {
            "static-bcl-and-helper-methods",
            """
            Console.WriteLine(Math.Abs(Celsius{ Degrees: 0.0 - 2.5 }))
            Console.WriteLine(ConversionTargets.StaticValue(Celsius{ Degrees: 3.5 }))
            """,
            new[] { "2.5", "3.5" },
        };

        yield return new object[]
        {
            "instance-methods-and-value-reference-results",
            """
            let target = InstanceTarget()
            Console.WriteLine(target.Value(Celsius{ Degrees: 4.5 }))
            Console.WriteLine(target.Text(Label{ Text: "ready" }))
            """,
            new[] { "4.5", "ready" },
        };

        yield return new object[]
        {
            "inherited-and-extension-methods",
            """
            let inherited = LocalTarget()
            let extended = InstanceTarget()
            Console.WriteLine(inherited.Inherited(Celsius{ Degrees: 4.75 }))
            Console.WriteLine(extended.ExtensionValue(Celsius{ Degrees: 5.25 }))
            """,
            new[] { "4.75", "5.25" },
        };

        yield return new object[]
        {
            "overload-competition-prefers-the-conversion-target",
            """
            Console.WriteLine(ConversionTargets.Prefer(Celsius{ Degrees: 5.5 }))
            Console.WriteLine(ConversionTargets.PreferText(Label{ Text: "value" }))
            """,
            new[] { "double", "string" },
        };

        yield return new object[]
        {
            "generic-and-params-calls",
            """
            Console.WriteLine(ConversionTargets.Generic[float64](Celsius{ Degrees: 6.5 }))
            Console.WriteLine(ConversionTargets.Params(
                Celsius{ Degrees: 1.25 },
                Celsius{ Degrees: 2.75 }))
            """,
            new[] { "6.5", "4" },
        };

        yield return new object[]
        {
            "conversion-beside-a-deferred-lambda",
            """
            Console.WriteLine(ConversionTargets.WithLambda(
                Celsius{ Degrees: 6.75 },
                x -> x + 1.0))
            """,
            new[] { "7.75" },
        };

        yield return new object[]
        {
            "inferred-generic-identity-beats-a-concrete-conversion",
            """
            Console.WriteLine(ConversionTargets.GenericRank(Celsius{ Degrees: 7.0 }))
            Console.WriteLine(ConversionTargets.GenericParamsRank(Celsius{ Degrees: 8.0 }))
            """,
            new[] { "generic", "generic" },
        };

        yield return new object[]
        {
            "an-implicit-operator-beats-an-explicit-reference-cross-cast",
            """
            Console.WriteLine(ConversionTargets.InterfaceValue(CrossCastSource()))
            Console.WriteLine(ConversionTargets.ParamsDisposable(CrossCastSource()))
            """,
            new[] { "DisposableValue", "DisposableValue" },
        };

        yield return new object[]
        {
            "a-user-conversion-survives-the-erased-mismatch-check",
            """
            Console.WriteLine(ConversionTargets.GenericTarget(
                GenericSource{ Text: "generic-target" }))
            """,
            new[] { "generic-target" },
        };

        yield return new object[]
        {
            "a-symbolic-generic-static-receiver-applies-the-operator",
            """
            Console.WriteLine(GenericStatic[Celsius].InterfaceValue(CrossCastSource()))
            """,
            new[] { "DisposableValue" },
        };

        yield return new object[]
        {
            "imported-conversion-control",
            """
            Console.WriteLine(ConversionTargets.StaticValue(Fahrenheit(7.5)))
            Console.WriteLine(ConversionTargets.Prefer(Fahrenheit(8.5)))
            """,
            new[] { "7.5", "double" },
        };
    }

    /// <summary>Calls that remain ambiguous or inapplicable.</summary>
    /// <returns>Case name, source body, and expected diagnostic.</returns>
    public static IEnumerable<object[]> RejectedCalls()
    {
        yield return new object[]
        {
            "unrelated-user-defined-targets-stay-ambiguous",
            """
            Console.WriteLine(ConversionTargets.Ambiguous(AmbiguousValue{ Value: 1 }))
            """,
            "GS0160",
        };

        yield return new object[]
        {
            "an-erased-object-does-not-fit-an-unrelated-parameter",
            """
            Console.WriteLine(ConversionTargets.Reject(Celsius{ Degrees: 2.5 }))
            """,
            "GS0159",
        };

        yield return new object[]
        {
            "an-explicit-only-operator-does-not-make-a-call-applicable",
            """
            Console.WriteLine(ConversionTargets.StaticValue(ExplicitOnly{ Value: 2.5 }))
            """,
            "GS0159",
        };

        yield return new object[]
        {
            "a-lifted-operator-is-not-admitted-before-lowering-supports-it",
            """
            let value Celsius? = Celsius{ Degrees: 2.5 }
            Console.WriteLine(ConversionTargets.NullableValue(value))
            """,
            "GS0159",
        };

        yield return new object[]
        {
            "same-compilation-standard-conversions-keep-imported-precedence",
            """
            Console.WriteLine(ConversionTargets.StandardRank(LocalRankSource{}))
            """,
            "GS0160",
        };

        yield return new object[]
        {
            "imported-standard-conversion-control",
            """
            Console.WriteLine(ConversionTargets.StandardRank(ImportedRankSource()))
            """,
            "GS0160",
        };

        yield return new object[]
        {
            "constrained-instance-ambiguity-is-reported",
            """
            func CallAmbiguous[T IConstrainedTarget](target T, value AmbiguousValue) string {
                return target.ConstrainedAmbiguous(value)
            }

            Console.WriteLine(CallAmbiguous(
                ConstrainedTarget(),
                AmbiguousValue{ Value: 1 }))
            """,
            "GS0160",
        };

        yield return new object[]
        {
            "constrained-static-ambiguity-is-reported",
            """
            func CallStaticAmbiguous[T IStaticConstrainedTarget[T]](value AmbiguousValue) string {
                return T.ConstrainedStaticAmbiguous(value)
            }

            Console.WriteLine(CallStaticAmbiguous[StaticConstrainedTarget](
                AmbiguousValue{ Value: 1 }))
            """,
            "GS0160",
        };
    }

    [Theory]
    [MemberData(nameof(SuccessfulCalls))]
    public void AUserDefinedImplicitConversionParticipatesInAnOrdinaryClrCall(
        string name,
        string body,
        string[] expectedLines)
        => RunAndExpect(name, body, expectedLines);

    [Fact]
    public void AUserDefinedImplicitConversionParticipatesInConstrainedClrDispatch()
    {
        const string Body = """
            func CallConstrained[T IConstrainedTarget](target T, value Celsius) float64 {
                return target.ConstrainedValue(value)
            }

            func CallConstrainedParams[T IConstrainedTarget](target T, first Celsius, second Celsius) float64 {
                return target.ConstrainedParams(first, second)
            }

            func CallConstrainedProjection[T IConstrainedTarget](target T, value Projectable) int32 {
                return target.ConstrainedProjection(value)
            }

            func CallConstrainedInterface[T IConstrainedTarget](target T, value LocalRankSource) string {
                return target.ConstrainedInterface(value)
            }

            func CallConstrainedDisposable[T IConstrainedTarget](target T, value CrossCastSource) string {
                return target.ConstrainedDisposable(value)
            }

            func CallGenericConsumer[T IConsumer[Celsius]](target T, value Celsius) int32 {
                return target.Consume(value)
            }

            func CallGenericConsumerParams[T IConsumer[Celsius]](target T, first Celsius, second Celsius) int32 {
                return target.ConsumeMany(first, second)
            }

            func CallStaticConstrained[T IStaticConstrainedTarget[T]](value Celsius) float64 {
                return T.ConstrainedStaticValue(value)
            }

            func CallStaticConstrainedParams[T IStaticConstrainedTarget[T]](first Celsius, second Celsius) float64 {
                return T.ConstrainedStaticParams(first, second)
            }

            func CallStaticConstrainedNamed[T IStaticConstrainedTarget[T]](value Celsius) float64 {
                return T.ConstrainedStaticNamed(second: value, first: "named")
            }

            func CallStaticGenericConsumer[T IStaticConsumer[Celsius]](value Celsius) int32 {
                return T.Consume(value)
            }

            func CallStaticGenericConsumerParams[T IStaticConsumer[Celsius]](first Celsius, second Celsius) int32 {
                return T.ConsumeMany(first, second)
            }

            Console.WriteLine(CallConstrained(
                ConstrainedTarget(),
                Celsius{ Degrees: 5.75 }))
            Console.WriteLine(CallConstrainedParams(
                ConstrainedTarget(),
                Celsius{ Degrees: 1.25 },
                Celsius{ Degrees: 2.75 }))
            Console.WriteLine(CallConstrainedProjection(
                ConstrainedTarget(),
                Projectable{ Value: 7 }))
            Console.WriteLine(CallConstrainedInterface(
                ConstrainedTarget(),
                LocalRankSource{}))
            Console.WriteLine(CallConstrainedDisposable(
                ConstrainedTarget(),
                CrossCastSource()))
            Console.WriteLine(CallStaticConstrained[StaticConstrainedTarget](
                Celsius{ Degrees: 6.25 }))
            Console.WriteLine(CallStaticConstrainedParams[StaticConstrainedTarget](
                Celsius{ Degrees: 2.5 },
                Celsius{ Degrees: 3.5 }))
            Console.WriteLine(CallStaticConstrainedNamed[StaticConstrainedTarget](
                Celsius{ Degrees: 6.5 }))
            """;

        RunAndExpect(
            "constrained-instance-and-static-methods",
            Body,
            new[] { "5.75", "4", "107", "LocalRankSource", "DisposableValue", "6.25", "6", "6.5" },
            IlVerifier.KnownIssues.StaticVirtualInterface,
            @"<Program>\.(CallStaticConstrained(Params|Named)?|CallStaticGenericConsumer(Params)?)$");
    }

    [Theory]
    [MemberData(nameof(RejectedCalls))]
    public void AnInvalidOrdinaryClrCallRemainsRejected(
        string name,
        string body,
        string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4054_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(
                tempDir,
                "App.gs",
                Preamble + body + "\n",
                appPath,
                "/target:exe",
                "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Equal(new[] { expectedId }, ErrorIds(appLog));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void RunAndExpect(
        string name,
        string body,
        string[] expectedLines,
        IEnumerable<string> ignoredIlVerifyErrors = null,
        string ignoredIlVerifyScope = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4054_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "App.dll");
            var appLog = Compile(
                tempDir,
                "App.gs",
                Preamble + body + "\n",
                appPath,
                "/target:exe",
                "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(
                appPath,
                new[] { libPath },
                ignoredIlVerifyErrors,
                ignoredIlVerifyScope);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] ErrorIds(string log)
        => Regex.Matches(log, @"error (GS[0-9]{4})")
            .Select(match => match.Groups[1].Value)
            .ToArray();

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib4054",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib4054.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

    private static string Compile(
        string dir,
        string fileName,
        string source,
        string outPath,
        params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(tpa)
            ? Enumerable.Empty<string>()
            : tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
