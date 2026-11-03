// <copyright file="Issue5586ConstOptionalParameterDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Regression coverage for issue #5586: named compile-time constants (qualified,
/// unqualified, static-imported, forward-referenced, and cross-assembly) are
/// accepted as optional parameter defaults while non-const static fields still
/// report GS0265.
open class Issue5586ConstOptionalParameterDefaultEmitTests {
    @Fact
    func NamedConstDefaults_SameAndCrossAssembly_CompileVerifyAndRoundTrip() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5586-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let librarySource = `package ConstantDefaults
import ConstantDefaults.Tokens

public func ForwardBeforeDeclaration(
    value float64 = Tokens.Size,
    imported float64 = Size,
    shifted float64 = Size + 1.5,
    negated float64 = -Size,
    small uint8 = SmallCount,
    tag string = Prefix + "-v1",
    missing string? = MissingTag
) string -> "${value}:${imported}:${shifted}:${negated}:${small}:${tag}:${missing ?? "nil"}"

public class Holder(Scale float64 = Size) {
    public func Compute(
        a float64 = Size,
        b float64 = Tokens.DoubleSize,
        c float64 = ITokenContract.Bonus
    ) float64 -> Scale + a + b + c

    shared {
        public func StaticCompute(v float64 = Size) float64 -> v
    }
}

public delegate Callback[T](item T, count int32 = Tokens.SmallCount) int32;

public interface IGenericContract[T] {
    func Run(item T, count int32 = Tokens.SmallCount) int32 {
        return count
    }
}

public interface ITokenContract {
    shared {
        const Bonus float64 = 3.5
        const DefaultColumn int32 = 2
        private const Secret int32 = 19
        var DefaultHolder Holder = Holder()
        var BuiltScale float64 = ITokenContract.MakeScale()
        var Handler Callback[int32] = func(x int32, c int32) int32 { return x + c }
        var GenericRef IGenericContract[int32] = GenericContractImpl()

        func MakeScale() float64 {
            return Bonus * 2
        }
    }

    prop this[row int32, column int32 = Tokens.SmallCount, pad int32 = DefaultColumn] int32 {
        get -> row + column + pad
    }

    func Apply(v float64 = Bonus, baseSize float64 = Tokens.Size, secret int32 = ITokenContract.Secret) float64 {
        return v + baseSize + float64(secret)
    }
}

public class GenericContractImpl : IGenericContract[int32] {
}

public class TokenContractImpl : ITokenContract {
}

public class OuterWithNestedIface {
    shared {
        public const OuterBonus int32 = 11
    }

    public interface INested {
        func Read(v int32 = OuterBonus) int32 {
            return v
        }
    }

    public class NestedImpl : INested {
    }
}

public class Widget {
    public var Value string

    shared {
        public const Prefix string = "v"
    }

    public init(value string = Widget.Prefix) {
        Value = value
    }
}

public class Tokens {
    shared {
        public const Size float64 = 14
        public const DoubleSize float64 = Size * 2
        public const SmallCount int32 = 7
        public const OverflowByte int32 = 257
        public const MinInt int32 = -2147483648
        public const Prefix string = "tok"
        public const MissingTag string? = nil

        public func OwnUnqualified(v float64 = Size) float64 -> v
    }
}

public func UncheckedNegMin(value int64 = unchecked(-Tokens.MinInt)) int64 -> value
public func ConvertedByte(b uint8 = uint8(Tokens.OverflowByte), i int32 = uint8(Tokens.OverflowByte)) string -> "${b}:${i}"
public func NullableCasts(
    lit int32? = cast[int32?](1),
    named int32? = cast[int32?](Tokens.SmallCount),
    narrow uint8? = cast[uint8?](Tokens.OverflowByte)
) string -> "${lit ?? -1}:${named ?? -1}:${narrow ?? uint8(0)}"
public func Qualified(value float64 = Tokens.Size) float64 -> value
public func Imported(value float64 = Size) float64 -> value
`
            let consumerSource = `package ConstantConsumer
import ConstantDefaults
import ConstantDefaults.Tokens

func LocalQualified(value float64 = Tokens.Size) float64 -> value
func LocalImported(value float64 = Size) float64 -> value
func LocalArithmetic(value float64 = Tokens.DoubleSize + 2) float64 -> value
func LocalUncheckedNegMin(value int64 = unchecked(-Tokens.MinInt)) int64 -> value
func LocalConvertedByte(i int32 = uint8(Tokens.OverflowByte)) int32 -> i
func LocalNullableCast(x int32? = cast[int32?](1), y int32? = cast[int32?](Tokens.SmallCount)) string -> "${x ?? -1}:${y ?? -1}"

public func RunConsumer() string {
    let iface ITokenContract = TokenContractImpl()
    let nestedIface OuterWithNestedIface.INested = OuterWithNestedIface.NestedImpl()
    let widget = Widget()
    let cbResult = ITokenContract.Handler(10)
    let gResult = ITokenContract.GenericRef.Run(0)
    return "${Qualified()}:${Imported()}:${ForwardBeforeDeclaration()}:${Holder().Compute()}:${Holder.StaticCompute()}:${Tokens.OwnUnqualified()}:${iface.Apply()}:${iface[1]}:${ITokenContract.DefaultHolder.Scale}:${ITokenContract.BuiltScale}:${cbResult}:${gResult}:${nestedIface.Read()}:${UncheckedNegMin()}:${ConvertedByte()}:${NullableCasts()}:${widget.Value}:${LocalQualified()}:${LocalImported()}:${LocalArithmetic()}:${LocalUncheckedNegMin()}:${LocalConvertedByte()}:${LocalNullableCast()}"
}
`
            let libraryPath = CompileAssembly(
                directory,
                "ConstantDefaults",
                librarySource,
                isLibrary: true,
                Array.Empty[string]()
            )
            let consumerPath = CompileAssembly(
                directory,
                "ConstantConsumer",
                consumerSource,
                isLibrary: true,
                []string{libraryPath}
            )
            let loadContext = AssemblyLoadContext("Issue5586", isCollectible: true)
            try {
                using let libraryStream = MemoryStream(File.ReadAllBytes(libraryPath))
                using let consumerStream = MemoryStream(File.ReadAllBytes(consumerPath))
                let library = loadContext.LoadFromStream(libraryStream)
                let libProgram = library.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let qualifiedParam = libProgram.GetMethod("Qualified")!!.GetParameters().Single()
                Assert.True(qualifiedParam.IsOptional)
                Assert.True(qualifiedParam.HasDefaultValue)
                Assert.Equal(14.0, qualifiedParam.RawDefaultValue)

                let importedParam = libProgram.GetMethod("Imported")!!.GetParameters().Single()
                Assert.True(importedParam.IsOptional)
                Assert.True(importedParam.HasDefaultValue)
                Assert.Equal(14.0, importedParam.RawDefaultValue)

                let consumer = loadContext.LoadFromStream(consumerStream)
                let consumerProgram = consumer.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let runConsumer = consumerProgram.GetMethod(
                    "RunConsumer",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )!!
                let actual = Assert.IsType[string](runConsumer.Invoke(nil, nil))
                Assert.Equal(
                    "14:14:14:14:15.5:-14:7:tok-v1:nil:59.5:14:14:36.5:10:14:7:17:7:11:-2147483648:1:1:1:7:1:v:14:14:30:-2147483648:1:1:7",
                    actual
                )
            } finally {
                loadContext.Unload()
            }
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    @Fact
    func NonConstSharedVarAndLetFields_StillReportGS0265() {
        const source = `package ConstantDefaults
import ConstantDefaults.Tokens

class Tokens {
    shared {
        var MutableSize float64 = 14
        let ReadOnlySize float64 = 14
    }
}

func BadMutable(value float64 = Tokens.MutableSize) float64 -> value
func BadReadOnly(value float64 = ReadOnlySize) float64 -> value
`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue5586.Invalid")
        Assert.False(result.Success)
        let gs0265 = result.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.Id == "GS0265").ToArray()
        Assert.Equal(2, gs0265.Length)
        Assert.Equal(10, gs0265[0].Location.StartLine)
        Assert.Equal(11, gs0265[1].Location.StartLine)
    }

    @Fact
    func CheckedOverflowNegationAndInterfaceFieldMethodCollision_ReportExpectedDiagnostics() {
        const source = `package ConstantDefaults
import ConstantDefaults.Tokens

class Tokens {
    shared {
        const MinInt int32 = -2147483648
        const OverflowByte int32 = 257
    }
}

func BadCheckedNeg(value int64 = checked(-Tokens.MinInt)) int64 -> value
func BadCheckedConvInt(value int32 = checked(uint8(Tokens.OverflowByte))) int32 -> value
func BadCheckedConvFloat(value float64 = checked(uint8(Tokens.OverflowByte))) float64 -> value
func BadCheckedNullableConv(value uint8? = checked(cast[uint8?](Tokens.OverflowByte))) uint8? -> value

class Outer {
    shared {
        const N int32 = 1
    }

    class Inner {
        var N int32
        func M(x int32 = N) int32 -> x
    }
}

class ShadowImported {
    var MinInt int32
    func M(x int32 = MinInt) int32 -> x
}

interface ICollide {
    shared {
        var F int32
        func F() int32 {
            return 1
        }
    }
}
`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(
            output,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue5586.CheckedAndCollision"
        )
        Assert.False(result.Success)
        let gs0265 = result.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.Id == "GS0265").ToArray()
        Assert.Equal(4, gs0265.Length)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0102")
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0125" && diagnostic.Message.Contains("'N'")
        )
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0125" && diagnostic.Message.Contains("'MinInt'")
        )
    }

    shared {
        private func CompileAssembly(
            directory string,
            name string,
            source string,
            isLibrary bool,
            references IReadOnlyList[string]
        ) string {
            let sourcePath = Path.Combine(directory, name + ".gs")
            let outputPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let target = if isLibrary {
                "/target:library"
            } else {
                "/target:exe"
            }
            let arguments = List[string]{"/out:" + outputPath, target, "/targetframework:net10.0"}
            for reference in references {
                arguments.Add("/r:" + reference)
            }
            arguments.Add(sourcePath)
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var exitCode int32
            try {
                exitCode = Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exitCode == 0, "gsc failed (${exitCode}):\n${stdoutWriter}\n${stderrWriter}")
            Assert.True(File.Exists(outputPath))
            IlVerifier.Verify(outputPath, additionalReferences: references)
            return outputPath
        }
    }
}
