// <copyright file="Issue5589NullableConstantDefaultEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Compiler.Tests

/// Issue #5589: an omitted value-type `T?` argument with a non-null constant default
/// must reach the callee as a non-null `T?`. Each test verifies the IL and runs every call site.
class Issue5589NullableConstantDefaultEmitTests {
    @Fact
    func GSharpDeclaredDefaults_MaterializeNonNullValuesForGSharpAndCSharpCallers() {
        WithDirectory(
            (directory string) -> {
                let library = Path.Combine(directory, "Issue5589.Library.dll")
                EmitGSharp(GSharpLibrary, library, "Issue5589.Library", Array.Empty[string]())
                let consumer = EmitCSharp(CSharpConsumer, Path.Combine(directory, "Issue5589.Consumer.dll"), library)
                Assert.Equal(
                    "1 5 7 3 1.5 True q RightToLeft 5 nil 1/RightToLeft/2 1/LeftToRight/0.5 g:6 9 LeftToRight 1:4 b:11 sq 5 12 13/RightToLeft RightToLeft z 14:RightToLeft 15:LeftToRight" +
                        "|1 5 7 3 1.5 True q RightToLeft 5 nil",
                    Invoke(library, consumer, "Issue5589Consumer")
                )
            }
        )
    }

    @Fact
    func ImportedCSharpDefaults_MaterializeNonNullValues() {
        WithDirectory(
            (directory string) -> {
                let library = EmitCSharp(CSharpLibrary, Path.Combine(directory, "Issue5589.Imported.dll"), nil)
                let caller = Path.Combine(directory, "Issue5589.Caller.dll")
                EmitGSharp(GSharpCaller, caller, "Issue5589.Caller", []string{library})
                Assert.Equal(
                    "5 7 1.5 True q 1.5 -3 630822816000000000 High High B nil 1/B/2 1/A/0.5 9 1:4 b:11 High High/High",
                    Invoke(library, caller, "Issue5589Caller.Calls")
                )
            }
        )
    }

    shared {
        private const GSharpLibrary string = `package Issue5589
import System
import System.Linq.Expressions

enum Direction { LeftToRight; RightToLeft }

class Holder {
    var Text string
    init(x int32? = 9) { Text = "$x" }
    func Pick(d Direction? = Direction.LeftToRight) string -> "$d"
    prop this[i int32, j int32? = 4] string {
        get { return "$i:$j" }
    }
}

class Box[T] {
    func Put(t T, x int64? = 11) string -> "$t:$x"
}

func (s string) Suffix(c char? = 'q') string -> s + "$c"

delegate Format(x int32? = 12) string;

data class Pair(x int32? = 13, d Direction? = Direction.RightToLeft)

interface IPick {
    func Choose(d Direction? = Direction.RightToLeft) string;
}

class Picker : IPick {
    func Choose(d Direction? = Direction.RightToLeft) string -> "$d"
}

struct Mark {
    var Text string
    init(c char? = 'z') { Text = "$c" }
}

open class ExplicitBase {
    var Text string
    init(x int32? = 14, d Direction? = Direction.RightToLeft) { Text = "$x:$d" }
}

class ExplicitDerived : ExplicitBase {
    init() : base() { }
}

open class PrimaryBase(x int32? = 15, d Direction? = Direction.LeftToRight) {
    var Text string = "$x:$d"
}

class PrimaryDerived() : PrimaryBase()

class Defaults {
    shared {
        func Read(direction Direction? = Direction.LeftToRight) int32 -> direction.HasValue ? 1 : 0
        func I32(x int32? = 5) string -> "$x"
        func I64(x int64? = 7) string -> "$x"
        func U8(x uint8? = 3) string -> "$x"
        func F64(x float64? = 1.5) string -> "$x"
        func Flag(x bool? = true) string -> "$x"
        func Letter(x char? = 'q') string -> "$x"
        func Way(x Direction? = Direction.RightToLeft) string -> "$x"
        func Widened(x int64? = 5) string -> "$x"
        func Missing(x int32? = nil) string -> if x == nil { "nil" } else { "$x" }
        func Named(a int32? = 1, b Direction? = Direction.RightToLeft, c float64? = 0.5) string -> "$a/$b/$c"
        func Generic[T](t T, x int32? = 6) string -> "$t:$x"

        func RunGSharp() string {
            let tree Expression[Func[string]] = () -> I32()
            let format Format = (x int32?) -> "$x"
            let picker IPick = Picker()
            return string.Join(" ", []string{
                "${Read()}",
                I32(),
                I64(),
                U8(),
                F64(),
                Flag(),
                Letter(),
                Way(),
                Widened(),
                Missing(),
                Named(c: 2.0),
                Named(b: Direction.LeftToRight),
                Generic("g"),
                Holder().Text,
                Holder().Pick(),
                Holder()[1],
                Box[string]().Put("b"),
                "s".Suffix(),
                tree.Compile()(),
                format(),
                "${Pair().x}/${Pair().d}",
                picker.Choose(),
                Mark().Text,
                ExplicitDerived().Text,
                PrimaryDerived().Text
            })
        }
    }
}`

        private const CSharpConsumer string = `using Issue5589;
public static class Issue5589Consumer
{
    public static string Run()
    {
        var gsharp = Defaults.RunGSharp();
        return gsharp + "|" + string.Join(" ", Defaults.Read(), Defaults.I32(), Defaults.I64(), Defaults.U8(),
            Defaults.F64(), Defaults.Flag(), Defaults.Letter(), Defaults.Way(), Defaults.Widened(), Defaults.Missing());
    }
}`

        private const CSharpLibrary string = `#nullable enable
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
namespace Issue5589Imported
{
    public enum ByteChoice : byte { Low, High }
    public enum LongChoice : long { Low, High = 5000000000 }
    public enum Plain { A, B }
    public static class Defaults
    {
        public static string I32(int? x = 5) => $"{x}";
        public static string I64(long? x = 7) => $"{x}";
        public static string F64(double? x = 1.5) => $"{x}";
        public static string Flag(bool? x = true) => $"{x}";
        public static string Letter(char? x = 'q') => $"{x}";
        public static string Money(decimal? x = 1.5m) => $"{x}";
        public static string Negative(decimal? x = -3m) => $"{x}";
        public static string Day([Optional, DateTimeConstant(630822816000000000)] DateTime? x) => $"{x?.Ticks}";
        public static string Small(ByteChoice? x = ByteChoice.High) => $"{x}";
        public static string Large(LongChoice? x = LongChoice.High) => $"{x}";
        public static string Way(Plain? x = Plain.B) => $"{x}";
        public static string Missing(int? x = null) => x is null ? "nil" : $"{x}";
        public static string Named(int? a = 1, Plain? b = Plain.B, double? c = 0.5) => $"{a}/{b}/{c}";
    }
    public class Holder
    {
        public string Text;
        public Holder(int? x = 9) { Text = $"{x}"; }
        public string this[int i, int? j = 4] => $"{i}:{j}";
    }
    public class Box<T>
    {
        public string Put(T t, long? x = 11) => $"{t}:{x}";
    }
}`

        private const GSharpCaller string = `package Issue5589Caller
import System
import System.Linq.Expressions
import Issue5589Imported

class Calls {
    shared {
        func LocalImportedEnums(small ByteChoice? = ByteChoice.High, large LongChoice? = LongChoice.High) string -> "$small/$large"

        func Run() string {
            let tree Expression[Func[string]] = () -> Defaults.Large()
            return string.Join(" ", []string{
                Defaults.I32(),
                Defaults.I64(),
                Defaults.F64(),
                Defaults.Flag(),
                Defaults.Letter(),
                Defaults.Money(),
                Defaults.Negative(),
                Defaults.Day(),
                Defaults.Small(),
                Defaults.Large(),
                Defaults.Way(),
                Defaults.Missing(),
                Defaults.Named(c: 2.0),
                Defaults.Named(b: Plain.A),
                Holder().Text,
                Holder()[1],
                Box[string]().Put("b"),
                tree.Compile()(),
                LocalImportedEnums()
            })
        }
    }
}`

        private func WithDirectory(action(string) -> void) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue5589", Guid.NewGuid().ToString("N"))
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
            var result GSharp.Core.CodeAnalysis.Compilation.EmitResult
            {
                using let output = File.Create(outputPath)
                result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            }
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
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
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func Invoke(dependency string, entry string, typeName string) string {
            let loadContext = AssemblyLoadContext("Issue5589", isCollectible: true)
            let culture = CultureInfo.CurrentCulture
            CultureInfo.CurrentCulture = CultureInfo.InvariantCulture
            try {
                using let dependencyStream = MemoryStream(File.ReadAllBytes(dependency))
                loadContext.LoadFromStream(dependencyStream)
                using let entryStream = MemoryStream(File.ReadAllBytes(entry))
                let assembly = loadContext.LoadFromStream(entryStream)
                return cast[string](
                    assembly.GetType(typeName, throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)!!
                )
            } finally {
                CultureInfo.CurrentCulture = culture
                loadContext.Unload()
            }
        }
    }
}
