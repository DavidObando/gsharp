// <copyright file="Issue2388NullableCustomEqualityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2388 — real-assembly, IL-verification and runtime-execution level
/// regression coverage for `Nullable<T>` comparisons where the
/// underlying `T` has custom equality/ordering. Before the fix,
/// `ClrOperatorResolution`'s CLR `op_*` lookup (Stream C) matched
/// on (cref:TypeSymbol.ClrType), which for a
/// `NullableTypeSymbol`-wrapped value type is already the UNDERLYING
/// CLR type (see `NullableTypeSymbol`'s constructor). So
/// `DateTime? == DateTime?` "successfully" resolved
/// `DateTime.op_Equality(DateTime, DateTime)` while leaving the bound
/// operands `Nullable<DateTime>`-typed, and the emitter naively
/// pushed both raw `Nullable<T>` operands and called the resolved
/// method directly — producing invalid IL (ilverify
/// `StackUnexpected`: found `Nullable<DateTime>`, expected
/// `DateTime`). A parallel same-compilation-struct gap (Stream D)
/// reported a false compile-time GS0129 for `T? == T?` instead, because
/// the struct-operator lookup never unwrapped the nullable wrapper before
/// checking `is StructSymbol`.
///
/// These tests cover both root causes end to end: a real BCL value type with
/// custom equality (`DateTime`), a real BCL value type with equality
/// only (`Guid`, no ordering operators), a REAL, separately
/// C#-compiled ("imported") struct with custom equality (mirroring an
/// EF Core / Oahu-style strongly-typed-ID sibling), and a same-compilation
/// G# struct's user-defined operator (Stream D), plus negative/regression
/// controls proving the fix is scoped correctly.
open class Issue2388NullableCustomEqualityEmitTests {
    @Fact
    func DateTimeNullable_Equality_EqualValues_ReturnsTrueAndVerifies() {
        let source = `package DtEqPkg
import System

let a DateTime? = DateTime(2020, 1, 1)
let b DateTime? = DateTime(2020, 1, 1)
Console.WriteLine(a == b)`
        Assert.Equal("True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DateTimeNullable_Equality_DifferentValues_ReturnsFalse() {
        let source = `package DtEqNePkg
import System

let a DateTime? = DateTime(2020, 1, 1)
let b DateTime? = DateTime(2021, 1, 1)
Console.WriteLine(a == b)`
        Assert.Equal("False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DateTimeNullable_Inequality_ReturnsExpected() {
        let source = `package DtNeqPkg
import System

let a DateTime? = DateTime(2020, 1, 1)
let b DateTime? = DateTime(2021, 1, 1)
let c DateTime? = DateTime(2020, 1, 1)
Console.WriteLine(a != b)
Console.WriteLine(a != c)`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DateTimeNullable_HasValueMismatch_EqualityIsFalse_InequalityIsTrue() {
        let source = `package DtMismatchPkg
import System

let a DateTime? = DateTime(2020, 1, 1)
let n DateTime? = nil
Console.WriteLine(a == n)
Console.WriteLine(n == a)
Console.WriteLine(a != n)
Console.WriteLine(n != a)`
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func DateTimeNullable_BothNil_EqualityIsTrue_InequalityIsFalse() {
        let source = `package DtBothNilPkg
import System

let a DateTime? = nil
let b DateTime? = nil
Console.WriteLine(a == b)
Console.WriteLine(a != b)`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Theory
    @InlineData("<", true)
    @InlineData("<=", true)
    @InlineData(">", false)
    @InlineData(">=", false)
    func DateTimeNullable_Ordering_AllFourOperators_ReturnsCorrectResult(op string, expected bool) {
        let source = (`package DtOrdPkg
import System

let a DateTime? = DateTime(2020, 1, 1)
let b DateTime? = DateTime(2021, 1, 1)
Console.WriteLine(a ` + "$op" + ` b)`)
        Assert.Equal(
            if expected {
                "True${Environment.NewLine}"
            } else {
                "False${Environment.NewLine}"
            },
            CompileAndRun(source)
        )
    }

    @Fact
    func DateTimeNullable_Ordering_AnyMissingOperand_IsFalse() {
        let source = `package DtOrdNilPkg
import System

let a DateTime? = DateTime(2020, 1, 1)
let n DateTime? = nil
Console.WriteLine(a < n)
Console.WriteLine(n < a)
Console.WriteLine(n < n)`
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func DateTimeNullable_MixedModeAgainstNonNullable_BothOrders_ReturnTrue() {
        let source = `package DtMixedPkg
import System

let a DateTime? = DateTime(2020, 1, 1)
let b DateTime = DateTime(2020, 1, 1)
Console.WriteLine(a == b)
Console.WriteLine(b == a)`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GuidNullable_EqualityAndInequality_ReturnCorrectResults() {
        let source = `package GuidEqPkg
import System

let g1 Guid? = Guid.Empty
let g2 Guid? = Guid.Empty
let g3 Guid? = nil
Console.WriteLine(g1 == g2)
Console.WriteLine(g1 == g3)
Console.WriteLine(g1 != g3)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func SameCompilationStruct_NullableEquality_StreamD_ReturnsCorrectResults() {
        // Directly-related deferred-work control called out by the issue:
        // a same-compilation struct's user-defined operator (Stream D) is
        // resolved via TypeMemberModel against the (TypeBuilder-backed,
        // ClrType-less) StructSymbol — before the fix this reported a
        // compile-time GS0129 for `Meters? == Meters?` because the lookup
        // never unwrapped the nullable wrapper.
        let source = `package MetersEqPkg

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
Console.WriteLine(n == n)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ClosedGenericSameCompilationStruct_LiftedComparison_RunsAndVerifies() {
        let source = `package GenericComparisonPkg

struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator ==(right Box[T]) bool -> left.Rank == right.Rank
func (left Box[T]) operator <(right Box[T]) bool -> left.Rank < right.Rank

let low Box[string]? = Box[string]{Value: "low", Rank: 1}
let same Box[string]? = Box[string]{Value: "same", Rank: 1}
let high Box[string]? = Box[string]{Value: "high", Rank: 2}
let missing Box[string]? = nil

Console.WriteLine(low == same)
Console.WriteLine(low == missing)
Console.WriteLine(missing == missing)
Console.WriteLine(low < high)
Console.WriteLine(low < missing)`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ClosedGenericSameCompilationStruct_LiftedArithmeticReturningPrimitive_RunsAndVerifies() {
        let source = `package GenericPrimitiveArithmeticPkg

struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator +(right Box[T]) int32 -> left.Rank + right.Rank

let left Box[string]? = Box[string]{Value: "left", Rank: 20}
let right Box[string]? = Box[string]{Value: "right", Rank: 22}
let missing Box[string]? = nil
Console.WriteLine((left + right)!!)
Console.WriteLine(left!! + right!!)
Console.WriteLine(left + missing == nil)`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ClosedGenericSameCompilationStruct_LiftedArithmeticReturningGenericStruct_RunsAndVerifies() {
        let source = `package GenericStructArithmeticPkg

struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator +(right Box[T]) Box[T] {
    return Box[T]{Value: left.Value, Rank: left.Rank + right.Rank}
}

let left Box[string]? = Box[string]{Value: "kept", Rank: 20}
let right Box[string]? = Box[string]{Value: "ignored", Rank: 22}
let missing Box[string]? = nil
Console.WriteLine((left + right)!!.Value)
Console.WriteLine((left + right)!!.Rank)
Console.WriteLine(left + missing == nil)`
        Assert.Equal(
            "kept${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func SameCompilationStruct_WithoutUserOperator_NullableEquality_StillReportsGS0129() {
        let (exitCode, stdout, _) = TryCompile(`package PlainNoOpPkg

struct Plain(Value float64) {
}

func F(a Plain?, b Plain?) bool {
    return a == b
}`)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0129", stdout)
    }

    @Fact
    func CSharpImportedStructWithCustomEquality_NullableComparison_RunsAndVerifies() {
        // The issue's explicit "small C# sibling struct" ask: a REAL,
        // separately C#-compiled struct (mirroring an EF Core / Oahu-style
        // strongly-typed-ID or value object) with custom `==`/`!=`,
        // consumed as `Nullable<T>` from G# exactly like the DateTime/Guid
        // BCL cases above but through the imported-metadata path.
        let libraryPath = EmitCSharpLibrary(
            "CSharpImportedStructWithCustomEquality_NullableComparison_RunsAndVerifies",
            `namespace Lib
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
}`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumerAssemblyName = "Issue2388Emit.Consumer"
        let consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll")
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Demo
import Lib
import System

func Eq(a Meters?, b Meters?) bool {
    return a == b
}
func NotEq(a Meters?, b Meters?) bool {
    return a != b
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(consumerPath)
            let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: consumerAssemblyName)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        // One context for both: the consumer's methods are invoked with
        // instances of the library's types, which requires a single
        // identity for them.
        let loaded2388 = EmittedFixture.LoadTogether(libraryPath, consumerPath)
        let libraryAsm = loaded2388[0]
        let consumerAsm = loaded2388[1]
        let metersType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Meters")
        let programType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let eqMethod MethodInfo? = programType.GetMethod(
            "Eq",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
        )
        let neqMethod MethodInfo? = programType.GetMethod(
            "NotEq",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
        )
        Assert.NotNull(eqMethod)
        Assert.NotNull(neqMethod)
        let nullableMetersType = typeof(Nullable[_]).MakeGenericType(metersType)
        let m1 object? = Activator.CreateInstance(metersType, 1.0)
        let m2 object? = Activator.CreateInstance(metersType, 1.0)
        let m3 object? = Activator.CreateInstance(metersType, 2.0)
        let n object? = Activator.CreateInstance(nullableMetersType)
        Assert.Equal(
            true,
            eqMethod!!.Invoke(nil, []object{WrapNullable(nullableMetersType, m1), WrapNullable(nullableMetersType, m2)})
        )
        Assert.Equal(
            false,
            eqMethod!!.Invoke(nil, []object{WrapNullable(nullableMetersType, m1), WrapNullable(nullableMetersType, m3)})
        )
        Assert.Equal(false, eqMethod!!.Invoke(nil, []object{WrapNullable(nullableMetersType, m1), n}))
        Assert.Equal(true, neqMethod!!.Invoke(nil, []object{WrapNullable(nullableMetersType, m1), n}))
    }

    shared {
        private func WrapNullable(nullableType Type, value object?) object {
            return Activator.CreateInstance(nullableType, value)!!
        }

        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2388_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        internal func TryCompile(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2388_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (compileExit, compileOut.ToString(), compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func LibraryDirectory() string {
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue2388Emit")
            Directory.CreateDirectory(dir)
            return dir
        }

        private func EmitCSharpLibrary(caseName string, csharpSource string) string {
            let outputDir = Path.Combine(LibraryDirectory(), caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "CSharpLib2388.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "CSharpLib2388",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
