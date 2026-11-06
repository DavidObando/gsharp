// <copyright file="Issue5714OptionalInAndDefaultValueEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree

class Issue5714OptionalInAndDefaultValueEmitTests {
    @Theory
    @InlineData("Defaults.Enum()", "B")
    @InlineData("Defaults.NullableEnum()", "B")
    @InlineData("Defaults.Missing()", "nil")
    @InlineData("Defaults.Integer()", "7")
    @InlineData("Defaults.Money()", "1.25")
    @InlineData("Defaults.Day()", "0")
    @InlineData("Defaults.DateConstant()", "630822816000000000")
    @InlineData("Defaults.Struct()", "0")
    @InlineData("Defaults.Text()", "hi")
    @InlineData("Defaults.Generic[int32]()", "0")
    @InlineData("Defaults.Generic[string]()", "nil")
    @InlineData("Defaults.Zero[Point]()", "zero")
    @InlineData("Defaults.ZeroVariadic[Point]()", "zero:0")
    @InlineData("Defaults.ZeroVariadic[Point](tail: []int32{1, 2})", "zero:2")
    @InlineData(`"${GenericHolder[Point]().Value.X}"`, "0")
    @InlineData(`"${DerivedGeneric().Value.X}"`, "0")
    @InlineData("GenericApi[Point]().Read()", "zero")
    @InlineData("GenericApi[Point].Static()", "zero")
    @InlineData("GenericApi[Point]()[1]", "1:zero")
    @InlineData("Api().Read()", "7")
    @InlineData("Api().ReadExtension()", "B")
    @InlineData("Defaults.Named(last: 9)", "7:9")
    @InlineData("Defaults.Variadic() + \"|\" + Defaults.Variadic(tail: []int32{1, 2})", "7:0|7:2")
    @InlineData("Defaults.Readonly()", "7")
    @InlineData("Holder()[1]", "1:B:7:1.25:0:0")
    @InlineData("Holder().Text", "B:7:1.25:0:0")
    @InlineData("Derived().Text", "B:7:1.25:0:0")
    @InlineData("DerivedVariadic().Text", "7:0")
    @InlineData("GenericHolder[int32]().Text", "0")
    func ImportedReadonlyDefaults_AreValuesPassedByAddress(call string, expected string) {
        WithDirectory(
            (directory string) -> {
                let library = EmitCSharp(ImportedLibrary, Path.Combine(directory, "Issue5714.Imported.dll"), nil)
                let caller = Path.Combine(directory, "Issue5714.Caller.dll")
                EmitGSharp(`package Issue5714Caller
import System
import Issue5714Imported
struct Point { var X int32 }
` + (
                        if call == "Derived().Text" {
                            `class Derived : Holder {
    init() : base() { }
}
`
                        } else if call == `"${DerivedGeneric().Value.X}"` {
                            `class DerivedGeneric : GenericHolder[Point] {
    init() : base() { }
}
`
                        } else if call == "DerivedVariadic().Text" {
                            `class DerivedVariadic : VariadicBase {
    init() : base() { }
}
`
                        } else {
                            ""
                        }
                    ) + `
class Calls {
    shared {
        func Run() string -> ` + call + `
    }
}`, caller, "Issue5714.Caller", []string{library})
                Assert.Equal(expected, Invoke(library, caller, "Issue5714Caller.Calls"))
            }
        )
    }

    @Fact
    func UnderlyingValueDefaults_ArePresentAndNullableDefaultsStayMissing() {
        WithDirectory(
            (directory string) -> {
                let library = Path.Combine(directory, "Issue5714.Defaults.dll")
                EmitGSharp(SourceDefaults, library, "Issue5714.Defaults", Array.Empty[string]())
                let referenceLibrary = Path.Combine(directory, "ref", "Issue5714.Defaults.dll")
                let consumer = EmitCSharp(`public static class Consumer {
    public static string Run() => Issue5714.Defaults.Run() + "|" +
        Issue5714.Defaults.Integer() + ":" + Issue5714.Defaults.Enum() + ":" +
        Issue5714.Defaults.Missing() + ":" + Issue5714.Defaults.Money();
}`, Path.Combine(directory, "Issue5714.Consumer.dll"), referenceLibrary)
                Assert.Equal(
                    "True:0|True:0|False|True:0|True:0|False|True:0|True:0|True:0:True:0:False:True:0",
                    Invoke(library, consumer, "Consumer")
                )
                let importedCaller = Path.Combine(directory, "Issue5714.Reimport.dll")
                EmitGSharp(`package Issue5714Reimport
import Issue5714
class Calls {
    shared {
        func Run() string -> "${Defaults.Integer()}|${Defaults.Enum()}|${Defaults.Missing()}|${Defaults.Money()}"
    }
}`, importedCaller, "Issue5714.Reimport", []string{referenceLibrary})
                Assert.Equal("True:0|True:0|False|True:0", Invoke(library, importedCaller, "Issue5714Reimport.Calls"))
            }
        )
    }

    @Fact
    func UnrepresentableOrMismatchedNullableDefaults_ReportGS0265() {
        const source = `package InvalidDefaults
import System
struct Point { var X int32 }
func PointDefault(x Point? = default(Point)) bool -> x.HasValue
func DateDefault(x DateTime? = default(DateTime)) bool -> x.HasValue
func NullableToValue(x int32 = default(int32?)) int32 -> x
`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue5714.Invalid")
        Assert.False(result.Success)
        let diagnostics = result
            .Diagnostics
            .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0265")
            .ToArray()
        Assert.Equal(3, diagnostics.Length)
        Assert.Equal(3, diagnostics[0].Location.StartLine)
        Assert.Equal(4, diagnostics[1].Location.StartLine)
        Assert.Equal(5, diagnostics[2].Location.StartLine)
    }

    shared {
        private const ImportedLibrary string = `#nullable enable
using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
namespace Issue5714Imported {
    public enum Choice : byte { A, B }
    public struct CustomStruct { public int Value; }
    public static class Defaults {
        public static string Enum(in Choice x = Choice.B) => $"{x}";
        public static string NullableEnum(in Choice? x = Choice.B) => $"{x}";
        public static string Missing(in Choice? x = null) => x.HasValue ? $"{x}" : "nil";
        public static string Integer(in int x = 7) => $"{x}";
        public static string Money(in decimal x = 1.25m) => $"{x}";
        public static string Day(in DateTime x = default) => $"{x.Ticks}";
        public static string DateConstant([Optional, DateTimeConstant(630822816000000000)] in DateTime x) => $"{x.Ticks}";
        public static string Struct(in CustomStruct x = default) => $"{x.Value}";
        public static string Text(in string? x = "hi") => x ?? "nil";
        public static string Generic<T>(in T x = default!) => x is null ? "nil" : x.ToString()!;
        public static string Zero<T>(in T x = default!) => EqualityComparer<T>.Default.Equals(x, default!) ? "zero" : "nonzero";
        public static string ZeroVariadic<T>(in T x = default!, params int[] tail) => $"{Zero(x)}:{tail.Length}";
        public static string Named(in int x = 7, int last = 8) => $"{x}:{last}";
        public static string Variadic(in int x = 7, params int[] tail) => $"{x}:{tail.Length}";
        public static string Readonly(ref readonly int x = 7) => $"{x}";
        public static string ReadExtension(this Api api, in Choice x = Choice.B) => $"{x}";
    }
    public class Holder {
        public string Text;
        public Holder(in Choice? c = Choice.B, in int i = 7, in decimal d = 1.25m,
            in DateTime dt = default, in CustomStruct s = default) {
            Text = $"{c}:{i}:{d}:{dt.Ticks}:{s.Value}";
        }
        public string this[int n, in Choice? c = Choice.B, in int i = 7, in decimal d = 1.25m,
            in DateTime dt = default, in CustomStruct s = default] => $"{n}:{c}:{i}:{d}:{dt.Ticks}:{s.Value}";
    }
    public class GenericHolder<T> {
        public string Text;
        public T Value;
        public GenericHolder(in T value = default!) { Value = value; Text = value is null ? "nil" : value.ToString()!; }
    }
    public class Api {
        public string Read(in int x = 7) => $"{x}";
    }
    public class GenericApi<T> {
        public string Read(in T x = default!) => Defaults.Zero(x);
        public static string Static(in T x = default!) => Defaults.Zero(x);
        public string this[int i, in T x = default!] => $"{i}:{Defaults.Zero(x)}";
    }
    public class VariadicBase {
        public string Text;
        public VariadicBase(in int x = 7, params int[] tail) { Text = $"{x}:{tail.Length}"; }
    }
}`

        private const SourceDefaults string = `package Issue5714

enum Choice { A; B }

class Holder {
    var Text string
    init(x int32? = default(int32)) { Text = "${x.HasValue}:$x" }
    prop this[i int32, x int32? = default(int32)] string {
        get { return "${x.HasValue}:$x" }
    }
}

delegate Read(x int32? = default(int32)) string;

class Defaults {
    shared {
        func Integer(x int32? = default(int32)) string -> "${x.HasValue}:$x"
        func Enum(x Choice? = default(Choice)) string -> "${x.HasValue}:${int32(x ?? Choice.B)}"
        func Missing(x int32? = default(int32?)) bool -> x.HasValue
        func Money(x decimal? = default(decimal)) string -> "${x.HasValue}:$x"
        func Run() string {
            let local Read = (x int32?) -> "${x.HasValue}:$x"
            return "${Integer()}|${Enum()}|${Missing()}|${Holder().Text}|${Holder()[1]}|${Missing(default(int32?))}|${local()}|${Money()}"
        }
    }
}`

        private func WithDirectory(action(string) -> void) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue5714", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                action(directory)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func EmitGSharp(source string, outputPath string, assemblyName string, references[]string) {
            using let resolver = ReferenceResolver.WithReferences(references)
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            let referenceDirectory = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(outputPath)!!, "ref"))
            {
                using let output = File.Create(outputPath)
                using let reference = File.Create(Path.Combine(referenceDirectory.FullName, assemblyName + ".dll"))
                let result = compilation.Emit(output, pdbStream: nil, refStream: reference, assemblyName: assemblyName)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(outputPath, additionalReferences: references)
        }

        private func EmitCSharp(source string, outputPath string, reference string?) string {
            var references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            if reference != nil {
                references = references.Append(MetadataReference.CreateFromFile(reference))
            }
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(outputPath),
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func Invoke(dependency string, entry string, typeName string) string {
            let context = AssemblyLoadContext("Issue5714", isCollectible: true)
            let culture = CultureInfo.CurrentCulture
            CultureInfo.CurrentCulture = CultureInfo.InvariantCulture
            try {
                using let dependencyStream = MemoryStream(File.ReadAllBytes(dependency))
                context.LoadFromStream(dependencyStream)
                using let entryStream = MemoryStream(File.ReadAllBytes(entry))
                let assembly = context.LoadFromStream(entryStream)
                return cast[string](
                    assembly.GetType(typeName, throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)!!
                )
            } finally {
                CultureInfo.CurrentCulture = culture
                context.Unload()
            }
        }
    }
}
