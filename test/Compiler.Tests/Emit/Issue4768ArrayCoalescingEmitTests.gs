// <copyright file="Issue4768ArrayCoalescingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import Xunit.Abstractions
import GSharp.Compiler.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations

class Issue4768ArrayCoalescingEmitTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func NativeRoslynCoalescing_PreservesArrayTypeIdentityNullabilityAndEvaluation() {
        const expected = "MetadataReference\r\n0\r\nPortableExecutableReference\r\n1\r\nPortableExecutableReference|left|1|0|1\r\nMetadataReference|right|1|1|1\r\nMetadataReference|left|1|0|1\r\nPortableExecutableReference|right|1|1|1\r\nPortableExecutableReference|left|1|0|1\r\nMetadataReference|right|1|1|1\r\nnull|null|1|1|-1\r\nPortableExecutableReference|left|1|0|1\r\nMetadataReference|right|1|1|1\r\nPortableExecutableReference|left|1|0|1\r\nMetadataReference|right|1|1|1"
        CompareNativeAndTranslated(RoslynSource, "ArrayProbe.Driver", expected, foreign: true)
    }

    @Fact
    func DeclaredReferenceArrays_PreserveBothCoalescingDirectionsAndNullableElements() {
        CompareNativeAndTranslated(DeclaredSource, "DeclaredArrayProbe.Driver", `True
True
True
True
Derived
Derived
True
True
True
True`, foreign: false)
    }

    @Theory
    @InlineData("int[]", "object[]")
    @InlineData("int?[]", "object[]")
    @InlineData("int[]", "long[]")
    @InlineData("string[,]", "object[]")
    func IncompatibleValueArraysAndRanks_RemainRejected(left string, right string) {
        let source = "class C { object Pick($left? left, $right right) => left ?? right; }"
        let native = CreateCompilation(source, "Rejected")
        Assert.Contains(
            native.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Id == "CS0019" && source.Substring(
                diagnostic.Location.SourceSpan.Start,
                diagnostic.Location.SourceSpan.Length
            ) == "left ?? right"
        )
        let leftType = switch left {
            case "int[]": "[]?int32"
            case "int?[]": "[]?int32?"
            default: "[,]?string"
        }
        let rightType = switch right {
            case "object[]": "[]object"
            default: "[]int64"
        }
        InDirectory(
            (directory string) -> {
                let gsPath = Path.Combine(directory, "Rejected.gs")
                File.WriteAllText(gsPath, (`package Negative
func Pick(left ` + "$leftType" + `, right ` + "$rightType" + `) { var rejected = left ?? right }
`))
                let result = RunCompiler(gsPath, Path.Combine(directory, "Rejected.dll"), Array.Empty[string]())
                Assert.NotEqual(0, result.ExitCode)
                Assert.Contains("GS0129", result.Output, StringComparison.Ordinal)
                Assert.Contains("Rejected.gs(2,", result.Output, StringComparison.Ordinal)
            }
        )
    }

    @Fact
    func BareReferenceArrayCoalescing_StillRequiresExplicitCovariance() {
        InDirectory(
            (directory string) -> {
                let gsPath = Path.Combine(directory, "Invariant.gs")
                File.WriteAllText(
                    gsPath,
                    "package Invariant\r\nopen class Base { }\r\nclass Derived : Base { }\r\nfunc Pick(left []?Derived, right []Base) { var rejected = left ?? right }"
                )
                let result = RunCompiler(gsPath, Path.Combine(directory, "Invariant.dll"), Array.Empty[string]())
                Assert.NotEqual(0, result.ExitCode)
                Assert.Contains("GS0129", result.Output, StringComparison.Ordinal)
                Assert.Contains("Invariant.gs(4,", result.Output, StringComparison.Ordinal)
            }
        )
    }

    private func CompareNativeAndTranslated(source string, driverName string, expected string, foreign bool) {
        InDirectory(
            (directory string) -> {
                let extraReferences = List[string]()
                if foreign {
                    let foreignPath = Path.Combine(directory, "ArrayContract.dll")
                    EmitNative(
                        CreateCompilation(
                            ForeignSource,
                            "ArrayContract",
                            []string{typeof(MetadataReference).Assembly.Location}
                        ),
                        foreignPath
                    )
                    extraReferences.Add(foreignPath)
                    extraReferences.Add(typeof(MetadataReference).Assembly.Location)
                    extraReferences.Add(typeof(CSharpCompilation).Assembly.Location)
                }
                let native = CreateCompilation(source, "NativeProbe", extraReferences)
                let nativePath = Path.Combine(directory, "NativeProbe.dll")
                EmitNative(native, nativePath)
                let nativeOutput = RunNative(nativePath, driverName)
                Assert.Equal(expected.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine, nativeOutput)
                this.output.WriteLine("Native CLR stdout:\n" + nativeOutput)
                let tree = Assert.Single(native.SyntaxTrees)
                let document = LoadedDocument("Probe.cs", tree, native.GetSemanticModel(tree))
                for coalesce in tree
                    .GetRoot()
                    .DescendantNodes()
                    .OfType[BinaryExpressionSyntax]()
                    .Where((expression BinaryExpressionSyntax) -> expression.IsKind(SyntaxKind.CoalesceExpression)) {
                    let operation = Assert.IsAssignableFrom[ICoalesceOperation](
                        document.SemanticModel.GetOperation(coalesce)
                    )
                    this.output.WriteLine(
                        "Roslyn ?? result=${operation.Type}; value=${operation.Value.Type}; fallback=${operation.WhenNull.Type}; " +
                            "ValueConversion(identity=${operation.ValueConversion.IsIdentity}, implicit=${operation.ValueConversion.IsImplicit}, reference=${operation.ValueConversion.IsReference})"
                    )
                }
                let context = TranslationContext(native, document.SemanticModel, document.FilePath)
                let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                )
                let gsPath = Path.Combine(directory, "Translated.gs")
                let outputPath = Path.Combine(directory, "Translated.dll")
                File.WriteAllText(gsPath, translated + Environment.NewLine + "Driver.Run()" + Environment.NewLine)
                LogHash(gsPath)
                this.output.WriteLine(translated)
                let compile = RunCompiler(gsPath, outputPath, extraReferences)
                Assert.True(
                    compile.ExitCode == 0,
                    "Real gsc must accept translated native array coalescing:\n" + compile.Output
                )
                Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
                IlVerifier.Verify(outputPath, additionalReferences: extraReferences)
                this.output.WriteLine("Strict ILVerify passed without ignored errors.")
                LogHash(outputPath)
                for reference in extraReferences {
                    let destination = Path.Combine(directory, Path.GetFileName(reference))
                    if reference != destination {
                        File.Copy(reference, destination, overwrite: true)
                    }
                }
                let run = RunDotnet([]string{outputPath})
                Assert.Equal(0, run.ExitCode)
                Assert.Equal(expected.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine, run.Stdout)
                this.output.WriteLine("CLR stdout:\n" + run.Stdout)
                let assembly = EmittedFixture.Load(outputPath)
                let driver = assembly.GetType(driverName)
                Assert.NotNull(driver)
                let arrayMethods = if foreign {
                    []string{"References", "Widen", "Reverse", "NullableBoth", "Elements", "Generic"}
                } else {
                    []string{"Widen", "Reverse", "Elements", "Generic"}
                }
                for methodName in arrayMethods {
                    let method = driver!!.GetMethod(methodName)
                    Assert.NotNull(method)
                    Assert.True(method!!.ReturnType.IsSZArray)
                    Assert.Equal(
                        if foreign {
                            typeof([]MetadataReference)
                        } else {
                            assembly.GetType("DeclaredArrayProbe.Base")?.MakeArrayType()
                        },
                        method!!.ReturnType
                    )
                }
                let elements = driver!!.GetMethod("Elements")
                Assert.NotNull(elements)
                Assert.Equal(
                    NullabilityState.Nullable,
                    NullabilityInfoContext().Create(elements!!.ReturnParameter).ElementType?.ReadState
                )
                if foreign {
                    let nullableBoth = driver!!.GetMethod("NullableBoth")
                    Assert.NotNull(nullableBoth)
                    Assert.Equal(
                        NullabilityState.Nullable,
                        NullabilityInfoContext().Create(nullableBoth!!.ReturnParameter).ReadState
                    )
                } else {
                    Assert.Equal(typeof(object), driver!!.GetMethod("Boxed")?.ReturnType)
                }
                this.output.WriteLine(
                    "CLR return types: ${arrayMethods.Length} exact Base/MetadataReference SZ arrays, nullable Elements element; " +
                        (
                        if foreign {
                            "NullableBoth is nullable."
                        } else {
                            "Boxed is exactly System.Object."
                        }
                    )
                )
            }
        )
    }

    private func EmitNative(compilation CSharpCompilation, path string) {
        {
            using let stream = File.Create(path)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        LogHash(path)
    }

    private func RunCompiler(source string, outputPath string, extras IEnumerable[string])(
        ExitCode int32,
        Output string,
        Stdout string
    ) {
        let compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
        Assert.True(File.Exists(compiler), "Own-checkout gsc must be built.")
        LogHash(compiler)
        let arguments = List[string]{compiler, "/target:exe", "/targetframework:net10.0", "/out:" + outputPath}
        arguments.AddRange(RuntimeReferences().Concat(extras).Distinct().Select((path string) -> ("/r:" + path)))
        arguments.Add(source)
        this.output.WriteLine("Real driver command: dotnet " + string.Join(' ', arguments))
        let result = RunDotnet(arguments)
        this.output.WriteLine("Real driver exit: " + result.ExitCode.ToString() + "\n" + result.Output)
        return result
    }

    private func LogHash(path string) -> this.output.WriteLine(
        "sha256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) + " " + path
    )

    shared {
        private const ForeignSource string = "#nullable enable\r\nusing System;\r\nusing Microsoft.CodeAnalysis;\r\nnamespace ArrayContract;\r\npublic static class Foreign\r\n{\r\n    public static int LeftCalls;\r\n    public static int RightCalls;\r\n    public static object? LastLeft;\r\n    public static object? LastRight;\r\n    public static string RuntimePath => typeof(object).Assembly.Location;\r\n    public static void Reset()\r\n    {\r\n        LeftCalls = RightCalls = 0;\r\n        LastLeft = LastRight = null;\r\n    }\r\n    public static PortableExecutableReference[]? Left(bool present)\r\n    {\r\n        LeftCalls++;\r\n        var value = present ? new[] { MetadataReference.CreateFromFile(RuntimePath) } : null;\r\n        LastLeft = value;\r\n        return value;\r\n    }\r\n    public static MetadataReference[]? BaseLeft(bool present)\r\n    {\r\n        LeftCalls++;\r\n        var value = present ? new MetadataReference[] { MetadataReference.CreateFromFile(RuntimePath) } : null;\r\n        LastLeft = value;\r\n        return value;\r\n    }\r\n    public static MetadataReference[] Right()\r\n    {\r\n        RightCalls++;\r\n        var value = new MetadataReference[] { MetadataReference.CreateFromFile(RuntimePath) };\r\n        LastRight = value;\r\n        return value;\r\n    }\r\n    public static PortableExecutableReference[] DerivedRight()\r\n    {\r\n        RightCalls++;\r\n        var value = new[] { MetadataReference.CreateFromFile(RuntimePath) };\r\n        LastRight = value;\r\n        return value;\r\n    }\r\n    public static MetadataReference[]? NullableRight(bool present)\r\n    {\r\n        RightCalls++;\r\n        var value = present ? new MetadataReference[] { MetadataReference.CreateFromFile(RuntimePath) } : null;\r\n        LastRight = value;\r\n        return value;\r\n    }\r\n    public static PortableExecutableReference?[]? ElementsLeft(bool present)\r\n    {\r\n        LeftCalls++;\r\n        var value = present ? new PortableExecutableReference?[] { null } : null;\r\n        LastLeft = value;\r\n        return value;\r\n    }\r\n    public static MetadataReference?[] ElementsRight()\r\n    {\r\n        RightCalls++;\r\n        var value = new MetadataReference?[] { null };\r\n        LastRight = value;\r\n        return value;\r\n    }\r\n    public static void Report(MetadataReference?[]? value)\r\n    {\r\n        string type = value?.GetType().GetElementType()?.Name ?? \"null\";\r\n        string origin = value == null ? \"null\" : ReferenceEquals(value, LastLeft) ? \"left\" :\r\n            ReferenceEquals(value, LastRight) ? \"right\" : \"copy\";\r\n        Console.WriteLine($$\"{type}|{origin}|{LeftCalls}|{RightCalls}|{value?.Length ?? -1}\");\r\n    }\r\n}\r\npublic sealed class Box<T> where T : class\r\n{\r\n    private readonly T[]? value;\r\n    public Box(T[]? value) { this.value = value; }\r\n    public T[]? Get()\r\n    {\r\n        Foreign.LeftCalls++;\r\n        Foreign.LastLeft = value;\r\n        return value;\r\n    }\r\n}"
        private const RoslynSource string = "#nullable enable\r\nusing System;\r\nusing System.IO;\r\nusing System.Linq;\r\nusing Microsoft.CodeAnalysis;\r\nusing ArrayContract;\r\nnamespace ArrayProbe;\r\npublic static class Driver\r\n{\r\n    public static MetadataReference[] References(string? trustedAssemblies)\r\n    {\r\n        var references = trustedAssemblies?.Split(Path.PathSeparator)\r\n            .Where(File.Exists)\r\n            .Select(path => MetadataReference.CreateFromFile(path))\r\n            .ToArray() ?? new MetadataReference[0];\r\n        return references;\r\n    }\r\n    public static MetadataReference[] Widen(bool present) => Foreign.Left(present) ?? Foreign.Right();\r\n    public static MetadataReference[] Reverse(bool present) => Foreign.BaseLeft(present) ?? Foreign.DerivedRight();\r\n    public static MetadataReference[]? NullableBoth(bool present, bool fallback) =>\r\n        Foreign.Left(present) ?? Foreign.NullableRight(fallback);\r\n    public static MetadataReference?[] Elements(bool present) => Foreign.ElementsLeft(present) ?? Foreign.ElementsRight();\r\n    public static MetadataReference[] Generic(Box<PortableExecutableReference> box) => box.Get() ?? Foreign.Right();\r\n    public static void Run()\r\n    {\r\n        Console.WriteLine(References(null).GetType().GetElementType()?.Name);\r\n        Console.WriteLine(References(null).Length);\r\n        Console.WriteLine(References(Foreign.RuntimePath).GetType().GetElementType()?.Name);\r\n        Console.WriteLine(References(Foreign.RuntimePath).Length);\r\n        Foreign.Reset(); Foreign.Report(Widen(true));\r\n        Foreign.Reset(); Foreign.Report(Widen(false));\r\n        Foreign.Reset(); Foreign.Report(Reverse(true));\r\n        Foreign.Reset(); Foreign.Report(Reverse(false));\r\n        Foreign.Reset(); Foreign.Report(NullableBoth(true, false));\r\n        Foreign.Reset(); Foreign.Report(NullableBoth(false, true));\r\n        Foreign.Reset(); Foreign.Report(NullableBoth(false, false));\r\n        Foreign.Reset(); Foreign.Report(Elements(true));\r\n        Foreign.Reset(); Foreign.Report(Elements(false));\r\n        var present = new Box<PortableExecutableReference>(Foreign.Left(true));\r\n        Foreign.Reset(); Foreign.Report(Generic(present));\r\n        var absent = new Box<PortableExecutableReference>(null);\r\n        Foreign.Reset(); Foreign.Report(Generic(absent));\r\n    }\r\n}"
        private const DeclaredSource string = "#nullable enable\r\nusing System;\r\nnamespace DeclaredArrayProbe;\r\npublic class Base { }\r\npublic sealed class Derived : Base { }\r\npublic static class Driver\r\n{\r\n    public static Base[] Widen(Derived[]? value, Base[] fallback) => value ?? fallback;\r\n    public static Base[] Reverse(Base[]? value, Derived[] fallback) => value ?? fallback;\r\n    public static Base?[] Elements(Derived?[]? value, Base?[] fallback) => value ?? fallback;\r\n    public static Base[] Generic<T>(T[]? value, Base[] fallback) where T : Base => value ?? fallback;\r\n    public static object Boxed(Derived[]? value, Base[] fallback) => value ?? fallback;\r\n    public static void Run()\r\n    {\r\n        var derived = new Derived[] { new Derived() };\r\n        var bases = new Base[] { new Base() };\r\n        Console.WriteLine(Object.ReferenceEquals(derived, Widen(derived, bases)));\r\n        Console.WriteLine(Object.ReferenceEquals(bases, Widen(null, bases)));\r\n        Console.WriteLine(Object.ReferenceEquals(bases, Reverse(bases, derived)));\r\n        Console.WriteLine(Object.ReferenceEquals(derived, Reverse(null, derived)));\r\n        Console.WriteLine(Widen(derived, bases).GetType().GetElementType()?.Name);\r\n        Console.WriteLine(Reverse(null, derived).GetType().GetElementType()?.Name);\r\n        Console.WriteLine(Elements(null, new Base?[] { null })[0] == null);\r\n        Console.WriteLine(Object.ReferenceEquals(derived, Generic<Derived>(derived, bases)));\r\n        Console.WriteLine(Object.ReferenceEquals(bases, Generic<Derived>(null, bases)));\r\n        Console.WriteLine(Object.ReferenceEquals(derived, Boxed(derived, bases)));\r\n    }\r\n}"

        private func CreateCompilation(
            source string,
            name string,
            extras IEnumerable[string]? = nil
        ) CSharpCompilation {
            let paths = RuntimeReferences().Concat(extras ?? Array.Empty[string]()).Distinct()
            return CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, path: "Probe.cs")},
                paths.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    deterministic: true,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
        }

        private func RunNative(path string, driverName string) string {
            let driver = EmittedFixture.Load(path).GetType(driverName)
            Assert.NotNull(driver)
            let run = driver!!.GetMethod("Run")
            Assert.NotNull(run)
            using let output = StringWriter()
            let previous = Console.Out
            try {
                Console.SetOut(output)
                run!!.Invoke(nil, nil)
            } finally {
                Console.SetOut(previous)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }

        private func RunDotnet(arguments IEnumerable[string])(ExitCode int32, Output string, Stdout string) {
            let info = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                info.ArgumentList.Add(argument)
            }
            using let process = Process.Start(info) ?? throw InvalidOperationException("Could not start dotnet.")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                Assert.Fail("dotnet process timed out.")
            }
            return (
                process.ExitCode,
                stdout.Result + stderr.Result,
                stdout.Result.ReplaceLineEndings(Environment.NewLine)
            )
        }

        private func RuntimeReferences() IEnumerable[string] -> Directory.EnumerateFiles(
            Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                throw InvalidOperationException("Missing runtime directory."),
            "*.dll"
        )

        private func InDirectory(action(string) -> void) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-4768", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                action(directory)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
