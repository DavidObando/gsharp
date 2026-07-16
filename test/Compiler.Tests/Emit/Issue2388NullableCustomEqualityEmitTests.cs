// <copyright file="Issue2388NullableCustomEqualityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2388 — real-assembly, IL-verification and runtime-execution level
/// regression coverage for <c>Nullable&lt;T&gt;</c> comparisons where the
/// underlying <c>T</c> has custom equality/ordering. Before the fix,
/// <c>ClrOperatorResolution</c>'s CLR <c>op_*</c> lookup (Stream C) matched
/// on <see cref="TypeSymbol.ClrType"/>, which for a
/// <c>NullableTypeSymbol</c>-wrapped value type is already the UNDERLYING
/// CLR type (see <c>NullableTypeSymbol</c>'s constructor). So
/// <c>DateTime? == DateTime?</c> "successfully" resolved
/// <c>DateTime.op_Equality(DateTime, DateTime)</c> while leaving the bound
/// operands <c>Nullable&lt;DateTime&gt;</c>-typed, and the emitter naively
/// pushed both raw <c>Nullable&lt;T&gt;</c> operands and called the resolved
/// method directly — producing invalid IL (ilverify
/// <c>StackUnexpected</c>: found <c>Nullable&lt;DateTime&gt;</c>, expected
/// <c>DateTime</c>). A parallel same-compilation-struct gap (Stream D)
/// reported a false compile-time GS0129 for <c>T? == T?</c> instead, because
/// the struct-operator lookup never unwrapped the nullable wrapper before
/// checking <c>is StructSymbol</c>.
///
/// These tests cover both root causes end to end: a real BCL value type with
/// custom equality (<c>DateTime</c>), a real BCL value type with equality
/// only (<c>Guid</c>, no ordering operators), a REAL, separately
/// C#-compiled ("imported") struct with custom equality (mirroring an
/// EF Core / Oahu-style strongly-typed-ID sibling), and a same-compilation
/// G# struct's user-defined operator (Stream D), plus negative/regression
/// controls proving the fix is scoped correctly.
/// </summary>
public class Issue2388NullableCustomEqualityEmitTests
{
    [Fact]
    public void DateTimeNullable_Equality_EqualValues_ReturnsTrueAndVerifies()
    {
        var source = """
            package DtEqPkg
            import System

            let a DateTime? = DateTime(2020, 1, 1)
            let b DateTime? = DateTime(2020, 1, 1)
            Console.WriteLine(a == b)
            """;

        Assert.Equal("True\n", CompileAndRun(source));
    }

    [Fact]
    public void DateTimeNullable_Equality_DifferentValues_ReturnsFalse()
    {
        var source = """
            package DtEqNePkg
            import System

            let a DateTime? = DateTime(2020, 1, 1)
            let b DateTime? = DateTime(2021, 1, 1)
            Console.WriteLine(a == b)
            """;

        Assert.Equal("False\n", CompileAndRun(source));
    }

    [Fact]
    public void DateTimeNullable_Inequality_ReturnsExpected()
    {
        var source = """
            package DtNeqPkg
            import System

            let a DateTime? = DateTime(2020, 1, 1)
            let b DateTime? = DateTime(2021, 1, 1)
            let c DateTime? = DateTime(2020, 1, 1)
            Console.WriteLine(a != b)
            Console.WriteLine(a != c)
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void DateTimeNullable_HasValueMismatch_EqualityIsFalse_InequalityIsTrue()
    {
        var source = """
            package DtMismatchPkg
            import System

            let a DateTime? = DateTime(2020, 1, 1)
            let n DateTime? = nil
            Console.WriteLine(a == n)
            Console.WriteLine(n == a)
            Console.WriteLine(a != n)
            Console.WriteLine(n != a)
            """;

        Assert.Equal("False\nFalse\nTrue\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void DateTimeNullable_BothNil_EqualityIsTrue_InequalityIsFalse()
    {
        var source = """
            package DtBothNilPkg
            import System

            let a DateTime? = nil
            let b DateTime? = nil
            Console.WriteLine(a == b)
            Console.WriteLine(a != b)
            """;

        Assert.Equal("True\nFalse\n", CompileAndRun(source));
    }

    [Theory]
    [InlineData("<", true)]
    [InlineData("<=", true)]
    [InlineData(">", false)]
    [InlineData(">=", false)]
    public void DateTimeNullable_Ordering_AllFourOperators_ReturnsCorrectResult(string op, bool expected)
    {
        var source = $$"""
            package DtOrdPkg
            import System

            let a DateTime? = DateTime(2020, 1, 1)
            let b DateTime? = DateTime(2021, 1, 1)
            Console.WriteLine(a {{op}} b)
            """;

        Assert.Equal(expected ? "True\n" : "False\n", CompileAndRun(source));
    }

    [Fact]
    public void DateTimeNullable_Ordering_AnyMissingOperand_IsFalse()
    {
        var source = """
            package DtOrdNilPkg
            import System

            let a DateTime? = DateTime(2020, 1, 1)
            let n DateTime? = nil
            Console.WriteLine(a < n)
            Console.WriteLine(n < a)
            Console.WriteLine(n < n)
            """;

        Assert.Equal("False\nFalse\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void DateTimeNullable_MixedModeAgainstNonNullable_BothOrders_ReturnTrue()
    {
        var source = """
            package DtMixedPkg
            import System

            let a DateTime? = DateTime(2020, 1, 1)
            let b DateTime = DateTime(2020, 1, 1)
            Console.WriteLine(a == b)
            Console.WriteLine(b == a)
            """;

        Assert.Equal("True\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void GuidNullable_EqualityAndInequality_ReturnCorrectResults()
    {
        var source = """
            package GuidEqPkg
            import System

            let g1 Guid? = Guid.Empty
            let g2 Guid? = Guid.Empty
            let g3 Guid? = nil
            Console.WriteLine(g1 == g2)
            Console.WriteLine(g1 == g3)
            Console.WriteLine(g1 != g3)
            """;

        Assert.Equal("True\nFalse\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void SameCompilationStruct_NullableEquality_StreamD_ReturnsCorrectResults()
    {
        // Directly-related deferred-work control called out by the issue:
        // a same-compilation struct's user-defined operator (Stream D) is
        // resolved via TypeMemberModel against the (TypeBuilder-backed,
        // ClrType-less) StructSymbol — before the fix this reported a
        // compile-time GS0129 for `Meters? == Meters?` because the lookup
        // never unwrapped the nullable wrapper.
        var source = """
            package MetersEqPkg

            struct Meters(Value float64) {
            }

            func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
            func (a Meters) operator !=(b Meters) bool -> !(a == b)

            let a Meters? = Meters{Value: 1.0}
            let b Meters? = Meters{Value: 1.0}
            let c Meters? = Meters{Value: 2.0}
            let n Meters? = nil
            Console.WriteLine(a == b)
            Console.WriteLine(a == c)
            Console.WriteLine(a != c)
            Console.WriteLine(a == n)
            Console.WriteLine(n == n)
            """;

        Assert.Equal("True\nFalse\nTrue\nFalse\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void SameCompilationStruct_WithoutUserOperator_NullableEquality_StillReportsGS0129()
    {
        var (exitCode, stdout, _) = TryCompile("""
            package PlainNoOpPkg

            struct Plain(Value float64) {
            }

            func F(a Plain?, b Plain?) bool {
                return a == b
            }
            """);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0129", stdout);
    }

    [Fact]
    public void CSharpImportedStructWithCustomEquality_NullableComparison_RunsAndVerifies()
    {
        // The issue's explicit "small C# sibling struct" ask: a REAL,
        // separately C#-compiled struct (mirroring an EF Core / Oahu-style
        // strongly-typed-ID or value object) with custom `==`/`!=`,
        // consumed as `Nullable<T>` from G# exactly like the DateTime/Guid
        // BCL cases above but through the imported-metadata path.
        var libraryPath = EmitCSharpLibrary(
            nameof(CSharpImportedStructWithCustomEquality_NullableComparison_RunsAndVerifies),
            """
            namespace Lib
            {
                public readonly struct Meters
                {
                    public double Value { get; }
                    public Meters(double value) => Value = value;
                    public static bool operator ==(Meters a, Meters b) => System.Math.Abs(a.Value - b.Value) < 0.0001;
                    public static bool operator !=(Meters a, Meters b) => !(a == b);
                    public override bool Equals(object obj) => obj is Meters m && m == this;
                    public override int GetHashCode() => Value.GetHashCode();
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumerAssemblyName = "Issue2388Emit.Consumer";
        var consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll");
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Demo
                import Lib
                import System

                func Eq(a Meters?, b Meters?) bool {
                    return a == b
                }
                func NotEq(a Meters?, b Meters?) bool {
                    return a != b
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(consumerPath))
        {
            var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: consumerAssemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var libraryAsm = Assembly.LoadFrom(libraryPath);
        var consumerAsm = Assembly.LoadFrom(consumerPath);
        var metersType = libraryAsm.GetTypes().Single(t => t.Name == "Meters");
        var programType = consumerAsm.GetTypes().Single(t => t.Name == "<Program>");

        var eqMethod = programType.GetMethod("Eq", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        var neqMethod = programType.GetMethod("NotEq", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(eqMethod);
        Assert.NotNull(neqMethod);

        var nullableMetersType = typeof(Nullable<>).MakeGenericType(metersType);
        var m1 = Activator.CreateInstance(metersType, 1.0);
        var m2 = Activator.CreateInstance(metersType, 1.0);
        var m3 = Activator.CreateInstance(metersType, 2.0);
        var n = Activator.CreateInstance(nullableMetersType);

        Assert.Equal(true, eqMethod!.Invoke(null, new[] { WrapNullable(nullableMetersType, m1), WrapNullable(nullableMetersType, m2) }));
        Assert.Equal(false, eqMethod.Invoke(null, new[] { WrapNullable(nullableMetersType, m1), WrapNullable(nullableMetersType, m3) }));
        Assert.Equal(false, eqMethod.Invoke(null, new[] { WrapNullable(nullableMetersType, m1), n }));
        Assert.Equal(true, neqMethod!.Invoke(null, new[] { WrapNullable(nullableMetersType, m1), n }));
    }

    private static object WrapNullable(Type nullableType, object value)
    {
        return Activator.CreateInstance(nullableType, value)!;
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2388_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            return (proc.ExitCode, stdout.Replace("\r\n", "\n"), stderr.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int ExitCode, string Stdout, string Stderr) TryCompile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2388_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (compileExit, compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string LibraryDirectory()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue2388Emit");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string EmitCSharpLibrary(string caseName, string csharpSource)
    {
        var outputDir = Path.Combine(LibraryDirectory(), caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "CSharpLib2388.dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "CSharpLib2388",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
