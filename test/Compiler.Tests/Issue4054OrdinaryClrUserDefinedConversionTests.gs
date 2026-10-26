// <copyright file="Issue4054OrdinaryClrUserDefinedConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #4054: same-compilation user-defined implicit conversions participate
/// in ordinary imported CLR method applicability and ranking.
open class Issue4054OrdinaryClrUserDefinedConversionTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ObliviousExpandedParamsPreservesTheOrdinaryUserConversion(arrayElement bool) {
        let parameterType = if arrayElement {
            "double[][]"
        } else {
            "double[]"
        }
        let sum = if arrayElement {
            "values[0][0] + values[1][0]"
        } else {
            "values[0] + values[1]"
        }
        using let fixture = CSharpFixture(
            "#nullable disable\nnamespace ParamsInterop {\n" +
                "public static class Targets { public static double Sum(params " +
                parameterType +
                " values) => " +
                sum +
                "; }\n}"
        )
        let resultType = if arrayElement {
            "[]float64"
        } else {
            "float64"
        }
        let result = if arrayElement {
            "[]float64{value.Value}"
        } else {
            "value.Value"
        }
        let source = "import System\nimport ParamsInterop\nstruct Amount { var Value float64 }\n" +
            "func operator implicit(value Amount) " +
            resultType +
            " -> " +
            result +
            "\nfunc Main() { Console.Write(Targets.Sum(Amount{Value: 1.25}, Amount{Value: 2.75})) }\n"
        let appPath = Path.Combine(fixture.DirectoryPath, "App.dll")
        let log = Compile(
            fixture.DirectoryPath,
            "App.gs",
            source,
            appPath,
            "/target:exe",
            "/reference:" + fixture.AssemblyPath
        )
        Assert.True(File.Exists(appPath), log)
        Assert.Empty(ErrorIds(log))
        IlVerifier.Verify(appPath, []string{fixture.AssemblyPath})
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = fixture.DirectoryPath
        }
        start.ArgumentList.Add(appPath)
        using let process = Process.Start(start)!!
        let stderr = process.StandardError.ReadToEndAsync()
        using let stdout = MemoryStream()
        let readOutput = process.StandardOutput.BaseStream.CopyToAsync(stdout)
        if !process.WaitForExit(RunTimeout) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            Assert.Fail("ordinary params consumer timed out")
        }
        readOutput.GetAwaiter().GetResult()
        Assert.True(process.ExitCode == 0, stderr.GetAwaiter().GetResult())
        Assert.Equal(Encoding.UTF8.GetBytes("4"), stdout.ToArray())
    }

    @Theory
    @MemberData("SuccessfulCalls")
    func AUserDefinedImplicitConversionParticipatesInAnOrdinaryClrCall(
        name string,
        body string,
        expectedLines[]string
    ) -> RunAndExpect(name, body, expectedLines)

    @Fact
    func AUserDefinedImplicitConversionParticipatesInConstrainedClrDispatch() {
        const Body = `func CallConstrained[T IConstrainedTarget](target T, value Celsius) float64 {
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
    Celsius{ Degrees: 6.5 }))`
        RunAndExpect(
            "constrained-instance-and-static-methods",
            Body,
            []string{"5.75", "4", "107", "LocalRankSource", "DisposableValue", "6.25", "6", "6.5"},
            IlVerifier.KnownIssues.StaticVirtualInterface,
            "<Program>\\.(CallStaticConstrained(Params|Named)?|CallStaticGenericConsumer(Params)?)$$"
        )
    }

    @Theory
    @MemberData("RejectedCalls")
    func AnInvalidOrdinaryClrCallRemainsRejected(name string, body string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4054_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(
                tempDir,
                "App.gs",
                Preamble + body + "\n",
                appPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Equal([]string{expectedId}, ErrorIds(appLog))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 60_000

        private const Preamble string = `package P
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
`

        private const LibrarySource string = `using System;
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
}`

        /// Positive programs that compile, IL-verify, execute, and print.
        /// @returns Case name, source body, and expected stdout lines.
        func SuccessfulCalls() sequence[[]object] {
            yield[]object{"static-bcl-and-helper-methods", `Console.WriteLine(Math.Abs(Celsius{ Degrees: 0.0 - 2.5 }))
Console.WriteLine(ConversionTargets.StaticValue(Celsius{ Degrees: 3.5 }))`, []string{"2.5", "3.5"}}
            yield[]object{"instance-methods-and-value-reference-results", `let target = InstanceTarget()
Console.WriteLine(target.Value(Celsius{ Degrees: 4.5 }))
Console.WriteLine(target.Text(Label{ Text: "ready" }))`, []string{"4.5", "ready"}}
            yield[]object{"inherited-and-extension-methods", `let inherited = LocalTarget()
let extended = InstanceTarget()
Console.WriteLine(inherited.Inherited(Celsius{ Degrees: 4.75 }))
Console.WriteLine(extended.ExtensionValue(Celsius{ Degrees: 5.25 }))`, []string{"4.75", "5.25"}}
            yield[]object{"overload-competition-prefers-the-conversion-target", `Console.WriteLine(ConversionTargets.Prefer(Celsius{ Degrees: 5.5 }))
Console.WriteLine(ConversionTargets.PreferText(Label{ Text: "value" }))`, []string{"double", "string"}}
            yield[]object{"generic-and-params-calls", `Console.WriteLine(ConversionTargets.Generic[float64](Celsius{ Degrees: 6.5 }))
Console.WriteLine(ConversionTargets.Params(
    Celsius{ Degrees: 1.25 },
    Celsius{ Degrees: 2.75 }))`, []string{"6.5", "4"}}
            yield[]object{"conversion-beside-a-deferred-lambda", `Console.WriteLine(ConversionTargets.WithLambda(
    Celsius{ Degrees: 6.75 },
    x -> x + 1.0))`, []string{"7.75"}}
            yield[]object{"inferred-generic-identity-beats-a-concrete-conversion", `Console.WriteLine(ConversionTargets.GenericRank(Celsius{ Degrees: 7.0 }))
Console.WriteLine(ConversionTargets.GenericParamsRank(Celsius{ Degrees: 8.0 }))`, []string{"generic", "generic"}}
            yield[]object{"an-implicit-operator-beats-an-explicit-reference-cross-cast", `Console.WriteLine(ConversionTargets.InterfaceValue(CrossCastSource()))
Console.WriteLine(ConversionTargets.ParamsDisposable(CrossCastSource()))`, []string{
                    "DisposableValue",
                    "DisposableValue"
                }}
            yield[]object{
                "a-user-conversion-survives-the-erased-mismatch-check",
                "Console.WriteLine(ConversionTargets.GenericTarget(\n    GenericSource{ Text: \"generic-target\" }))",
                []string{"generic-target"}
            }
            yield[]object{
                "a-symbolic-generic-static-receiver-applies-the-operator",
                "Console.WriteLine(GenericStatic[Celsius].InterfaceValue(CrossCastSource()))",
                []string{"DisposableValue"}
            }
            yield[]object{"imported-conversion-control", `Console.WriteLine(ConversionTargets.StaticValue(Fahrenheit(7.5)))
Console.WriteLine(ConversionTargets.Prefer(Fahrenheit(8.5)))`, []string{"7.5", "double"}}
        }

        /// Calls that remain ambiguous or inapplicable.
        /// @returns Case name, source body, and expected diagnostic.
        func RejectedCalls() sequence[[]object] {
            yield[]object{
                "unrelated-user-defined-targets-stay-ambiguous",
                "Console.WriteLine(ConversionTargets.Ambiguous(AmbiguousValue{ Value: 1 }))",
                "GS0160"
            }
            yield[]object{
                "an-erased-object-does-not-fit-an-unrelated-parameter",
                "Console.WriteLine(ConversionTargets.Reject(Celsius{ Degrees: 2.5 }))",
                "GS0159"
            }
            yield[]object{
                "an-explicit-only-operator-does-not-make-a-call-applicable",
                "Console.WriteLine(ConversionTargets.StaticValue(ExplicitOnly{ Value: 2.5 }))",
                "GS0159"
            }
            yield[]object{
                "a-lifted-operator-is-not-admitted-before-lowering-supports-it",
                "let value Celsius? = Celsius{ Degrees: 2.5 }\nConsole.WriteLine(ConversionTargets.NullableValue(value))",
                "GS0159"
            }
            yield[]object{
                "same-compilation-standard-conversions-keep-imported-precedence",
                "Console.WriteLine(ConversionTargets.StandardRank(LocalRankSource{}))",
                "GS0160"
            }
            yield[]object{
                "imported-standard-conversion-control",
                "Console.WriteLine(ConversionTargets.StandardRank(ImportedRankSource()))",
                "GS0160"
            }
            yield[]object{"constrained-instance-ambiguity-is-reported", `func CallAmbiguous[T IConstrainedTarget](target T, value AmbiguousValue) string {
    return target.ConstrainedAmbiguous(value)
}

Console.WriteLine(CallAmbiguous(
    ConstrainedTarget(),
    AmbiguousValue{ Value: 1 }))`, "GS0160"}
            yield[]object{"constrained-static-ambiguity-is-reported", `func CallStaticAmbiguous[T IStaticConstrainedTarget[T]](value AmbiguousValue) string {
    return T.ConstrainedStaticAmbiguous(value)
}

Console.WriteLine(CallStaticAmbiguous[StaticConstrainedTarget](
    AmbiguousValue{ Value: 1 }))`, "GS0160"}
        }

        private func RunAndExpect(
            name string,
            body string,
            expectedLines[]string,
            ignoredIlVerifyErrors IEnumerable[string]? = nil,
            ignoredIlVerifyScope string? = nil
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4054_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                let appPath = Path.Combine(tempDir, "App.dll")
                let appLog = Compile(
                    tempDir,
                    "App.gs",
                    Preamble + body + "\n",
                    appPath,
                    "/target:exe",
                    "/reference:" + libPath
                )
                Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
                Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
                IlVerifier.Verify(appPath, []string{libPath}, ignoredIlVerifyErrors, ignoredIlVerifyScope)
                let (exit, output) = RunDotnet(appPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
                let lines = output
                    .Split('\n')
                    .Select((line string) -> line.TrimEnd('\r'))
                    .Where((line string) -> line.Length > 0)
                    .ToArray()
                Assert.Equal(expectedLines, lines)
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib4054",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib4054.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(tpa) {
                Enumerable.Empty[string]()
            } else {
                tpa!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}
