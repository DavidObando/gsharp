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

public interface ITokenContract {
    shared {
        const Bonus float64 = 3.5
        const DefaultColumn int32 = 2
        var DefaultHolder Holder = Holder()
        var BuiltScale float64 = ITokenContract.MakeScale()
        var Handler Callback[int32] = func(x int32, c int32) int32 { return x + c }

        func MakeScale() float64 {
            return Bonus * 2
        }
    }

    prop this[row int32, column int32 = Tokens.SmallCount, pad int32 = DefaultColumn] int32 {
        get -> row + column + pad
    }

    func Apply(v float64 = Bonus, baseSize float64 = Tokens.Size) float64 {
        return v + baseSize
    }
}

public class TokenContractImpl : ITokenContract {
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
        public const MinInt int32 = -2147483648
        public const Prefix string = "tok"
        public const MissingTag string? = nil

        public func OwnUnqualified(v float64 = Size) float64 -> v
    }
}

public func UncheckedNegMin(value int64 = -Tokens.MinInt) int64 -> value
public func Qualified(value float64 = Tokens.Size) float64 -> value
public func Imported(value float64 = Size) float64 -> value
`
            let consumerSource = `package ConstantConsumer
import ConstantDefaults
import ConstantDefaults.Tokens

func LocalQualified(value float64 = Tokens.Size) float64 -> value
func LocalImported(value float64 = Size) float64 -> value
func LocalArithmetic(value float64 = Tokens.DoubleSize + 2) float64 -> value

public func RunConsumer() string {
    let iface ITokenContract = TokenContractImpl()
    let widget = Widget()
    let cbResult = ITokenContract.Handler(10)
    return "${Qualified()}:${Imported()}:${ForwardBeforeDeclaration()}:${Holder().Compute()}:${Holder.StaticCompute()}:${Tokens.OwnUnqualified()}:${iface.Apply()}:${iface[1]}:${ITokenContract.DefaultHolder.Scale}:${ITokenContract.BuiltScale}:${cbResult}:${UncheckedNegMin()}:${widget.Value}:${LocalQualified()}:${LocalImported()}:${LocalArithmetic()}"
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
                let library = loadContext.LoadFromAssemblyPath(libraryPath)
                let libProgram = library.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let qualifiedParam = libProgram.GetMethod("Qualified")!!.GetParameters().Single()
                Assert.True(qualifiedParam.IsOptional)
                Assert.True(qualifiedParam.HasDefaultValue)
                Assert.Equal(14.0, qualifiedParam.RawDefaultValue)

                let importedParam = libProgram.GetMethod("Imported")!!.GetParameters().Single()
                Assert.True(importedParam.IsOptional)
                Assert.True(importedParam.HasDefaultValue)
                Assert.Equal(14.0, importedParam.RawDefaultValue)

                let consumer = loadContext.LoadFromAssemblyPath(consumerPath)
                let consumerProgram = consumer.GetTypes().Single((type Type) -> type.Name == "<Program>")
                let runConsumer = consumerProgram.GetMethod(
                    "RunConsumer",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )!!
                let actual = Assert.IsType[string](runConsumer.Invoke(nil, nil))
                Assert.Equal(
                    "14:14:14:14:15.5:-14:7:tok-v1:nil:59.5:14:14:17.5:10:14:7:17:-2147483648:v:14:14:30",
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

class Tokens {
    shared {
        const MinInt int32 = -2147483648
    }
}

func BadCheckedNeg(value int64 = checked(-Tokens.MinInt)) int64 -> value

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
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0265")
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0102")
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
