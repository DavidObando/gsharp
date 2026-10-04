// <copyright file="Issue4768ArrayCoalescingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4768ArrayCoalescingEmitTests
{
    private const string ForeignSource = """
        #nullable enable
        using System;
        using Microsoft.CodeAnalysis;
        namespace ArrayContract;
        public static class Foreign
        {
            public static int LeftCalls;
            public static int RightCalls;
            public static object? LastLeft;
            public static object? LastRight;
            public static string RuntimePath => typeof(object).Assembly.Location;
            public static void Reset()
            {
                LeftCalls = RightCalls = 0;
                LastLeft = LastRight = null;
            }
            public static PortableExecutableReference[]? Left(bool present)
            {
                LeftCalls++;
                var value = present ? new[] { MetadataReference.CreateFromFile(RuntimePath) } : null;
                LastLeft = value;
                return value;
            }
            public static MetadataReference[]? BaseLeft(bool present)
            {
                LeftCalls++;
                var value = present ? new MetadataReference[] { MetadataReference.CreateFromFile(RuntimePath) } : null;
                LastLeft = value;
                return value;
            }
            public static MetadataReference[] Right()
            {
                RightCalls++;
                var value = new MetadataReference[] { MetadataReference.CreateFromFile(RuntimePath) };
                LastRight = value;
                return value;
            }
            public static PortableExecutableReference[] DerivedRight()
            {
                RightCalls++;
                var value = new[] { MetadataReference.CreateFromFile(RuntimePath) };
                LastRight = value;
                return value;
            }
            public static MetadataReference[]? NullableRight(bool present)
            {
                RightCalls++;
                var value = present ? new MetadataReference[] { MetadataReference.CreateFromFile(RuntimePath) } : null;
                LastRight = value;
                return value;
            }
            public static PortableExecutableReference?[]? ElementsLeft(bool present)
            {
                LeftCalls++;
                var value = present ? new PortableExecutableReference?[] { null } : null;
                LastLeft = value;
                return value;
            }
            public static MetadataReference?[] ElementsRight()
            {
                RightCalls++;
                var value = new MetadataReference?[] { null };
                LastRight = value;
                return value;
            }
            public static void Report(MetadataReference?[]? value)
            {
                string type = value?.GetType().GetElementType()?.Name ?? "null";
                string origin = value == null ? "null" : ReferenceEquals(value, LastLeft) ? "left" :
                    ReferenceEquals(value, LastRight) ? "right" : "copy";
                Console.WriteLine($"{type}|{origin}|{LeftCalls}|{RightCalls}|{value?.Length ?? -1}");
            }
        }
        public sealed class Box<T> where T : class
        {
            private readonly T[]? value;
            public Box(T[]? value) { this.value = value; }
            public T[]? Get()
            {
                Foreign.LeftCalls++;
                Foreign.LastLeft = value;
                return value;
            }
        }
        """;

    private const string RoslynSource = """
        #nullable enable
        using System;
        using System.IO;
        using System.Linq;
        using Microsoft.CodeAnalysis;
        using ArrayContract;
        namespace ArrayProbe;
        public static class Driver
        {
            public static MetadataReference[] References(string? trustedAssemblies)
            {
                var references = trustedAssemblies?.Split(Path.PathSeparator)
                    .Where(File.Exists)
                    .Select(path => MetadataReference.CreateFromFile(path))
                    .ToArray() ?? new MetadataReference[0];
                return references;
            }
            public static MetadataReference[] Widen(bool present) => Foreign.Left(present) ?? Foreign.Right();
            public static MetadataReference[] Reverse(bool present) => Foreign.BaseLeft(present) ?? Foreign.DerivedRight();
            public static MetadataReference[]? NullableBoth(bool present, bool fallback) =>
                Foreign.Left(present) ?? Foreign.NullableRight(fallback);
            public static MetadataReference?[] Elements(bool present) => Foreign.ElementsLeft(present) ?? Foreign.ElementsRight();
            public static MetadataReference[] Generic(Box<PortableExecutableReference> box) => box.Get() ?? Foreign.Right();
            public static void Run()
            {
                Console.WriteLine(References(null).GetType().GetElementType()?.Name);
                Console.WriteLine(References(null).Length);
                Console.WriteLine(References(Foreign.RuntimePath).GetType().GetElementType()?.Name);
                Console.WriteLine(References(Foreign.RuntimePath).Length);
                Foreign.Reset(); Foreign.Report(Widen(true));
                Foreign.Reset(); Foreign.Report(Widen(false));
                Foreign.Reset(); Foreign.Report(Reverse(true));
                Foreign.Reset(); Foreign.Report(Reverse(false));
                Foreign.Reset(); Foreign.Report(NullableBoth(true, false));
                Foreign.Reset(); Foreign.Report(NullableBoth(false, true));
                Foreign.Reset(); Foreign.Report(NullableBoth(false, false));
                Foreign.Reset(); Foreign.Report(Elements(true));
                Foreign.Reset(); Foreign.Report(Elements(false));
                var present = new Box<PortableExecutableReference>(Foreign.Left(true));
                Foreign.Reset(); Foreign.Report(Generic(present));
                var absent = new Box<PortableExecutableReference>(null);
                Foreign.Reset(); Foreign.Report(Generic(absent));
            }
        }
        """;

    private const string DeclaredSource = """
        #nullable enable
        using System;
        namespace DeclaredArrayProbe;
        public class Base { }
        public sealed class Derived : Base { }
        public static class Driver
        {
            public static Base[] Widen(Derived[]? value, Base[] fallback) => value ?? fallback;
            public static Base[] Reverse(Base[]? value, Derived[] fallback) => value ?? fallback;
            public static Base?[] Elements(Derived?[]? value, Base?[] fallback) => value ?? fallback;
            public static Base[] Generic<T>(T[]? value, Base[] fallback) where T : Base => value ?? fallback;
            public static object Boxed(Derived[]? value, Base[] fallback) => value ?? fallback;
            public static void Run()
            {
                var derived = new Derived[] { new Derived() };
                var bases = new Base[] { new Base() };
                Console.WriteLine(Object.ReferenceEquals(derived, Widen(derived, bases)));
                Console.WriteLine(Object.ReferenceEquals(bases, Widen(null, bases)));
                Console.WriteLine(Object.ReferenceEquals(bases, Reverse(bases, derived)));
                Console.WriteLine(Object.ReferenceEquals(derived, Reverse(null, derived)));
                Console.WriteLine(Widen(derived, bases).GetType().GetElementType()?.Name);
                Console.WriteLine(Reverse(null, derived).GetType().GetElementType()?.Name);
                Console.WriteLine(Elements(null, new Base?[] { null })[0] == null);
                Console.WriteLine(Object.ReferenceEquals(derived, Generic<Derived>(derived, bases)));
                Console.WriteLine(Object.ReferenceEquals(bases, Generic<Derived>(null, bases)));
                Console.WriteLine(Object.ReferenceEquals(derived, Boxed(derived, bases)));
            }
        }
        """;

    private readonly ITestOutputHelper output;

    public Issue4768ArrayCoalescingEmitTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void NativeRoslynCoalescing_PreservesArrayTypeIdentityNullabilityAndEvaluation()
    {
        const string expected = """
            MetadataReference
            0
            PortableExecutableReference
            1
            PortableExecutableReference|left|1|0|1
            MetadataReference|right|1|1|1
            MetadataReference|left|1|0|1
            PortableExecutableReference|right|1|1|1
            PortableExecutableReference|left|1|0|1
            MetadataReference|right|1|1|1
            null|null|1|1|-1
            PortableExecutableReference|left|1|0|1
            MetadataReference|right|1|1|1
            PortableExecutableReference|left|1|0|1
            MetadataReference|right|1|1|1
            """;
        CompareNativeAndTranslated(RoslynSource, "ArrayProbe.Driver", expected, foreign: true);
    }

    [Fact]
    public void DeclaredReferenceArrays_PreserveBothCoalescingDirectionsAndNullableElements()
    {
        CompareNativeAndTranslated(
            DeclaredSource,
            "DeclaredArrayProbe.Driver",
            "True\nTrue\nTrue\nTrue\nDerived\nDerived\nTrue\nTrue\nTrue\nTrue",
            foreign: false);
    }

    [Theory]
    [InlineData("int[]", "object[]")]
    [InlineData("int?[]", "object[]")]
    [InlineData("int[]", "long[]")]
    [InlineData("string[,]", "object[]")]
    public void IncompatibleValueArraysAndRanks_RemainRejected(string left, string right)
    {
        string source = $"class C {{ object Pick({left}? left, {right} right) => left ?? right; }}";
        var native = CreateCompilation(source, "Rejected");
        Assert.Contains(native.GetDiagnostics(), diagnostic =>
            diagnostic.Id == "CS0019" && source.Substring(diagnostic.Location.SourceSpan.Start, diagnostic.Location.SourceSpan.Length) == "left ?? right");

        string leftType = left switch
        {
            "int[]" => "[]?int32",
            "int?[]" => "[]?int32?",
            _ => "[,]?string",
        };
        string rightType = right switch
        {
            "object[]" => "[]object",
            _ => "[]int64",
        };
        InDirectory(directory =>
        {
            string gsPath = Path.Combine(directory, "Rejected.gs");
            File.WriteAllText(gsPath, $"package Negative\nfunc Pick(left {leftType}, right {rightType}) {{ var rejected = left ?? right }}\n");
            var result = RunCompiler(gsPath, Path.Combine(directory, "Rejected.dll"), Array.Empty<string>());
            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains("GS0129", result.Output, StringComparison.Ordinal);
            Assert.Contains("Rejected.gs(2,", result.Output, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void BareReferenceArrayCoalescing_StillRequiresExplicitCovariance()
    {
        InDirectory(directory =>
        {
            string gsPath = Path.Combine(directory, "Invariant.gs");
            File.WriteAllText(gsPath, """
                package Invariant
                open class Base { }
                class Derived : Base { }
                func Pick(left []?Derived, right []Base) { var rejected = left ?? right }
                """);
            var result = RunCompiler(gsPath, Path.Combine(directory, "Invariant.dll"), Array.Empty<string>());
            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains("GS0129", result.Output, StringComparison.Ordinal);
            Assert.Contains("Invariant.gs(4,", result.Output, StringComparison.Ordinal);
        });
    }

    private void CompareNativeAndTranslated(string source, string driverName, string expected, bool foreign)
    {
        InDirectory(directory =>
        {
            var extraReferences = new List<string>();
            if (foreign)
            {
                string foreignPath = Path.Combine(directory, "ArrayContract.dll");
                EmitNative(CreateCompilation(ForeignSource, "ArrayContract", new[] { typeof(MetadataReference).Assembly.Location }), foreignPath);
                extraReferences.Add(foreignPath);
                extraReferences.Add(typeof(MetadataReference).Assembly.Location);
                extraReferences.Add(typeof(CSharpCompilation).Assembly.Location);
            }

            var native = CreateCompilation(source, "NativeProbe", extraReferences);
            string nativePath = Path.Combine(directory, "NativeProbe.dll");
            EmitNative(native, nativePath);
            string nativeOutput = RunNative(nativePath, driverName);
            Assert.Equal(expected.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine, nativeOutput);
            this.output.WriteLine("Native CLR stdout:\n" + nativeOutput);

            var tree = Assert.Single(native.SyntaxTrees);
            var document = new LoadedDocument("Probe.cs", tree, native.GetSemanticModel(tree));
            foreach (var coalesce in tree.GetRoot().DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.BinaryExpressionSyntax>()
                         .Where(expression => expression.IsKind(SyntaxKind.CoalesceExpression)))
            {
                var operation = Assert.IsAssignableFrom<Microsoft.CodeAnalysis.Operations.ICoalesceOperation>(document.SemanticModel.GetOperation(coalesce));
                this.output.WriteLine($"Roslyn ?? result={operation.Type}; value={operation.Value.Type}; fallback={operation.WhenNull.Type}; " +
                    $"ValueConversion(identity={operation.ValueConversion.IsIdentity}, implicit={operation.ValueConversion.IsImplicit}, reference={operation.ValueConversion.IsReference})");
            }

            var context = new TranslationContext(native, document.SemanticModel, document.FilePath);
            string translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            string gsPath = Path.Combine(directory, "Translated.gs");
            string outputPath = Path.Combine(directory, "Translated.dll");
            File.WriteAllText(gsPath, translated + Environment.NewLine + "Driver.Run()" + Environment.NewLine);
            LogHash(gsPath);
            this.output.WriteLine(translated);
            var compile = RunCompiler(gsPath, outputPath, extraReferences);
            Assert.True(compile.ExitCode == 0, "Real gsc must accept translated native array coalescing:\n" + compile.Output);
            Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
            IlVerifier.Verify(outputPath, additionalReferences: extraReferences);
            this.output.WriteLine("Strict ILVerify passed without ignored errors.");
            LogHash(outputPath);
            foreach (string reference in extraReferences)
            {
                string destination = Path.Combine(directory, Path.GetFileName(reference));
                if (reference != destination)
                {
                    File.Copy(reference, destination, overwrite: true);
                }
            }

            var run = RunDotnet(new[] { outputPath });
            Assert.Equal(0, run.ExitCode);
            Assert.Equal(expected.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine, run.Stdout);
            this.output.WriteLine("CLR stdout:\n" + run.Stdout);
            var assembly = GSharp.Tests.EmittedFixture.Load(outputPath);
            var driver = assembly.GetType(driverName);
            Assert.NotNull(driver);
            string[] arrayMethods = foreign
                ? new[] { "References", "Widen", "Reverse", "NullableBoth", "Elements", "Generic" }
                : new[] { "Widen", "Reverse", "Elements", "Generic" };
            foreach (string methodName in arrayMethods)
            {
                var method = driver.GetMethod(methodName);
                Assert.NotNull(method);
                Assert.True(method.ReturnType.IsSZArray);
                Assert.Equal(
                    foreign ? typeof(MetadataReference[]) : assembly.GetType("DeclaredArrayProbe.Base")?.MakeArrayType(),
                    method.ReturnType);
            }

            var elements = driver.GetMethod("Elements");
            Assert.NotNull(elements);
            Assert.Equal(NullabilityState.Nullable, new NullabilityInfoContext().Create(elements.ReturnParameter).ElementType?.ReadState);
            if (foreign)
            {
                var nullableBoth = driver.GetMethod("NullableBoth");
                Assert.NotNull(nullableBoth);
                Assert.Equal(NullabilityState.Nullable, new NullabilityInfoContext().Create(nullableBoth.ReturnParameter).ReadState);
            }
            else
            {
                Assert.Equal(typeof(object), driver.GetMethod("Boxed")?.ReturnType);
            }

            this.output.WriteLine($"CLR return types: {arrayMethods.Length} exact Base/MetadataReference SZ arrays, nullable Elements element; " +
                (foreign ? "NullableBoth is nullable." : "Boxed is exactly System.Object."));
        });
    }

    private static CSharpCompilation CreateCompilation(string source, string name, IEnumerable<string>? extras = null)
    {
        var paths = RuntimeReferences().Concat(extras ?? Array.Empty<string>()).Distinct();
        return CSharpCompilation.Create(
            name,
            new[] { CSharpSyntaxTree.ParseText(source, path: "Probe.cs") },
            paths.Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, deterministic: true, nullableContextOptions: NullableContextOptions.Enable));
    }

    private void EmitNative(CSharpCompilation compilation, string path)
    {
        using (var stream = File.Create(path))
        {
            var result = compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        LogHash(path);
    }

    private static string RunNative(string path, string driverName)
    {
        var driver = GSharp.Tests.EmittedFixture.Load(path).GetType(driverName);
        Assert.NotNull(driver);
        var run = driver.GetMethod("Run");
        Assert.NotNull(run);
        using var output = new StringWriter();
        var previous = Console.Out;
        try
        {
            Console.SetOut(output);
            run.Invoke(null, null);
        }
        finally
        {
            Console.SetOut(previous);
        }

        return output.ToString().ReplaceLineEndings(Environment.NewLine);
    }

    private (int ExitCode, string Output, string Stdout) RunCompiler(string source, string outputPath, IEnumerable<string> extras)
    {
        string compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"));
        Assert.True(File.Exists(compiler), "Own-checkout gsc must be built.");
        LogHash(compiler);
        var arguments = new List<string>
        {
            compiler, "/target:exe", "/targetframework:net10.0", "/out:" + outputPath,
        };
        arguments.AddRange(RuntimeReferences().Concat(extras).Distinct().Select(path => "/r:" + path));
        arguments.Add(source);
        this.output.WriteLine("Real driver command: dotnet " + string.Join(' ', arguments));
        var result = RunDotnet(arguments);
        this.output.WriteLine("Real driver exit: " + result.ExitCode + "\n" + result.Output);
        return result;
    }

    private static (int ExitCode, string Output, string Stdout) RunDotnet(IEnumerable<string> arguments)
    {
        var info = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }

        using var process = Process.Start(info) ?? throw new InvalidOperationException("Could not start dotnet.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("dotnet process timed out.");
        }

        return (process.ExitCode, stdout.Result + stderr.Result, stdout.Result.ReplaceLineEndings(Environment.NewLine));
    }

    private static IEnumerable<string> RuntimeReferences() =>
        Directory.EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location) ?? throw new InvalidOperationException("Missing runtime directory."), "*.dll");

    private void LogHash(string path) =>
        this.output.WriteLine("sha256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) + " " + path);

    private static void InDirectory(Action<string> action)
    {
        string directory = Path.Combine(AppContext.BaseDirectory, "issue-4768", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            action(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
