// <copyright file="Issue4796GenericWithEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Reflection
import System.Text
import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Issue #4796: with/copy uses the actual data-class clone, not a default constructor.
class Issue4796GenericWithEmitTests {
    @Fact
    func OrdinaryLiteral_ThreeArgumentConstructorRemainsAvailable() {
        Assert.NotNull(
            typeof(BoundStructLiteralExpression).GetConstructor(
                []Type{
                    typeof(GSharp.Core.CodeAnalysis.Syntax.SyntaxNode),
                    typeof(StructSymbol),
                    typeof(ImmutableArray[BoundFieldInitializer])
                }
            )
        )
    }

    @Fact
    func ExplicitConstructorManagedField_ClonePreservesInitializedHandle() {
        using let native = CSharpFixture("public class NativeControl { }")
        let library = Compile(native.DirectoryPath, `package WithRecords
import System
public data class Holder[T any] {
    public var Location managed[T]
    public var Extra int32
    public init(value managed[T]) {
        this.Location = value
        this.Extra = 7
    }
    public func Copy() Holder[T] -> this with { Extra = 13 }
    public func Sugar() Holder[T] -> this.copy(Extra: 13)
    public func Empty() Holder[T] -> this with { }
}
public class Runner {
    public func Check() int32 {
        var value = 42
        let original = Holder[int32](managed(value))
        let copy = original.Copy()
        let sugar = original.Sugar()
        let empty = original.Empty()
        if Object.ReferenceEquals(original, copy) || Object.ReferenceEquals(original, sugar)
            || Object.ReferenceEquals(original, empty) {
            throw Exception("distinct clone")
        }
        if copy.Extra != 13 || sugar.Extra != 13 || empty.Extra != 7 || original.Extra != 7
            || *copy.Location != 42 || *sugar.Location != 42 || *empty.Location != 42 {
            throw Exception("managed clone state")
        }
        let alias = copy.Location
        *alias = 61
        if *sugar.Location != 61 || *empty.Location != 61 {
            throw Exception("managed handle identity")
        }
        return *original.Location
    }
}`, native.AssemblyPath)
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(library, []string{native.AssemblyPath})
        using let caller = CSharpFixture(`public static class Probe {
    public static int Run() => new WithRecords.Runner().Check();
}`, []PortableExecutableReference{MetadataReference.CreateFromFile(library)})
        IlVerifier.Verify(caller.AssemblyPath, []string{library, native.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(library),
            File.ReadAllBytes(caller.AssemblyPath)
        )
        let method = assemblies[2].GetType("Probe")?.GetMethod("Run") ??
            throw InvalidOperationException("Missing native oracle")
        Assert.Equal(61, method.Invoke(nil, nil))
    }

    @Theory
    @InlineData("Holder[int32]{Extra: 13}", "construction must initialize", "Holder[int32]{Extra: 13}")
    @InlineData("Holder[int32]{Extra: 13} with { }", "construction must initialize", "Holder[int32]{Extra: 13}")
    @InlineData("Holder[int32]{Location: scopedValue, Extra: 13} with { }", "cannot be stored", "scopedValue")
    @InlineData("original with { Location = scopedValue }", "cannot be stored", "scopedValue")
    @InlineData("original.copy(Location: scopedValue)", "cannot be stored", "scopedValue")
    @InlineData("original with { Location = Read(scopedValue) }", "requires a scoped parameter", "scopedValue")
    func FreshConstructionCloneSourceAndUpdates_KeepManagedSafetyDiagnostics(
        expression string,
        reason string,
        diagnosticSource string
    ) {
        using let native = CSharpFixture("public class NativeControl { }")
        let source = (`package WithRecords
public data class Holder[T any] {
    public var Location managed[T]
    public var Extra int32
    public init(value managed[T]) {
        this.Location = value
        this.Extra = 7
    }
}
public func Read(value managed[int32]) managed[int32] -> value
public func Bad(original Holder[int32], scoped scopedValue managed[int32]) Holder[int32] -> ` + "$expression")
        using let references = native.RuntimeReferences()
        let compilation = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let image = MemoryStream()
        let result = compilation.Emit(image, pdbStream: nil, refStream: nil, assemblyName: "UnsafeClone")
        Assert.False(result.Success)
        Assert.Equal(int64(0), image.Length)
        let diagnostic = Assert.Single(
            result.Diagnostics.Where(
                (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0604" && d.Message.Contains(
                    reason,
                    StringComparison.Ordinal
                )
            )
        )
        Assert.Equal(
            diagnosticSource,
            source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length)
        )
    }

    @Fact
    func CloneSource_RemainsVisitedByBoundTreeWalkers() {
        let type = StructSymbol(
            "Holder",
            ImmutableArray[FieldSymbol].Empty,
            GSharp.Core.CodeAnalysis.Symbols.Accessibility.Public,
            declaration: nil,
            packageName: "WithRecords",
            isData: true,
            isInline: false,
            isClass: true
        )
        let source = BoundDefaultExpression(nil, type)
        let clone = BoundStructLiteralExpression(nil, type, ImmutableArray[BoundFieldInitializer].Empty, source)
        let walker = SourceVisitWalker(source)
        walker.VisitExpression(clone)
        Assert.Equal(1, walker.SourceVisits)
    }

    @Theory
    @InlineData("int32", "int", "42", true)
    @InlineData("string", "string", "\"payload\"", true)
    @InlineData("int32", "int", "42", false)
    @InlineData("string", "string", "\"payload\"", false)
    func SourceBase_WithAndCopy_PreserveStateAndLexicalEvaluation(
        gsharpType string,
        csharpType string,
        payload string,
        generic bool
    ) {
        using let native = CSharpFixture(`#nullable enable
namespace Native {
    public static class Trace {
        public static int Initializations;
        public static int Bases;
        public static string Events = "";
        public static object Identity() { Initializations++; return new object(); }
        public static int Base(int value) { Bases++; return value; }
        public static void Receive() { Events += "R;"; }
        public static int Update(int value) { Events += value + ";"; return value; }
    }
}`)
        let parameter = if generic {
            "[T any]"
        } else {
            ""
        }
        let argument = if generic {
            "[T]"
        } else {
            ""
        }
        let memberType = if generic {
            "T"
        } else {
            gsharpType
        }
        let source = (`package WithRecords
import Native
import System.Threading.Tasks

public open data class Root` + "$parameter" + `(BaseValue int32) {
    public var State int32
    public var Payload ` + "$memberType" + `
    public let Anchor object = Trace.Identity()
    public func CopyRoot(value int32) Root` + "$argument" + ` {
        return this with { State = value }
    }
}
public open class Middle` + "$parameter" + `(Value int32) : Root` + "$argument" + `(Value) {
    public var MiddleState int32
}
public data class Leaf` + "$parameter" + `(Extra int32, Other int32) : Middle` + "$argument" + `(Trace.Base(0)) {
    private func Receiver() Leaf` + "$argument" + ` {
        Trace.Receive()
        return this
    }
    public func Copy(value int32) Leaf` + "$argument" + ` {
        return this.Receiver() with { Other = Trace.Update(21), Extra = Trace.Update(value) }
    }
    public func Sugar(value int32) Leaf` + "$argument" + ` {
        return this.Receiver().copy(Other: Trace.Update(21), Extra: Trace.Update(value))
    }
    public async func CopyAsync(value int32) Leaf` + "$argument" + ` {
        await Task.Yield()
        return this.Receiver() with { Other = Trace.Update(21), Extra = Trace.Update(value) }
    }
    public func Empty() Leaf` + "$argument" + ` -> this with { }
}`)
        let library = Compile(native.DirectoryPath, source, native.AssemblyPath)
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(library, []string{native.AssemblyPath})
        let constructed = if generic {
            "<" + csharpType + ">"
        } else {
            ""
        }
        using let caller = CSharpFixture((`#nullable enable
using Native;
using WithRecords;
public static class Probe {
    private static void Check(bool condition) {
        if (!condition) throw new System.Exception("copy contract");
    }
    public static string Run() {
        var original = new Leaf` + "$constructed" + `(7, 8) {
            State = 31, MiddleState = 41, Payload = ` + "$payload" + `, BaseValue = 51
        };
        var anchor = original.Anchor;
        var operations = new System.Func<Leaf` + "$constructed" + `> [] {
            () => original.Copy(13), () => original.Sugar(13),
            () => original.CopyAsync(13).GetAwaiter().GetResult(),
            () => original with { Other = Trace.Update(21), Extra = Trace.Update(13) }
        };
        for (var index = 0; index < operations.Length; index++) {
            Trace.Events = "";
            var copy = operations[index]();
            Check(copy.GetType() == typeof(Leaf` + "$constructed" + `));
            Check(!object.ReferenceEquals(copy, original));
            Check(copy.Extra == 13 && copy.Other == 21 && original.Extra == 7 && original.Other == 8);
            Check(copy.State == 31 && copy.MiddleState == 41 && copy.BaseValue == 51);
            Check(original.State == 31 && original.MiddleState == 41 && original.BaseValue == 51);
            Check(object.Equals(copy.Payload, original.Payload));
            Check(typeof(` + "$csharpType" + `).IsValueType || object.ReferenceEquals(copy.Payload, original.Payload));
            Check(object.ReferenceEquals(copy.Anchor, anchor));
            Check(Trace.Events == (index == 3 ? "21;13;" : "R;21;13;"));
            Check(Trace.Initializations == 1 && Trace.Bases == 1);
        }
        var fromBase = original.CopyRoot(61);
        Check(fromBase.GetType() == typeof(Leaf` + "$constructed" + `) && !object.ReferenceEquals(original, fromBase));
        var leaf = (Leaf` + "$constructed" + `)fromBase;
        Check(leaf.Extra == 7 && leaf.Other == 8 && leaf.State == 61 && original.State == 31);
        Check(leaf.MiddleState == 41 && leaf.BaseValue == 51 && object.ReferenceEquals(leaf.Anchor, anchor));
        Check(Trace.Initializations == 1 && Trace.Bases == 1);
        var empty = original.Empty();
        Check(!object.ReferenceEquals(empty, original) && empty.GetType() == original.GetType());
        Check(empty.Extra == 7 && empty.Other == 8 && empty.State == 31 && empty.MiddleState == 41 && empty.BaseValue == 51);
        Check(object.ReferenceEquals(empty.Anchor, anchor));
        Check(Trace.Initializations == 1 && Trace.Bases == 1);
        return "distinct|state|identity|once|order|runtime-type";
    }
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(native.AssemblyPath),
                MetadataReference.CreateFromFile(library)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{library, native.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(library),
            File.ReadAllBytes(caller.AssemblyPath)
        )
        let probe = assemblies[2].GetType("Probe", throwOnError: true) ??
            throw InvalidOperationException("Missing native caller")
        let run = probe.GetMethod("Run", BindingFlags.Public | BindingFlags.Static) ??
            throw InvalidOperationException("Missing native oracle")
        Assert.Equal("distinct|state|identity|once|order|runtime-type", run.Invoke(nil, nil))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ObjectRootAndImportedNativeRecord_CopyWithoutReinitializing(imported bool) {
        using let native = CSharpFixture(`#nullable enable
namespace Native {
    public static class Trace {
        public static int Count;
        public static object Identity() { Count++; return new object(); }
    }
    public record Row<T>(T Value, int Extra) {
        public object Anchor { get; } = Trace.Identity();
    }
}`)
        let source = if imported {
            `package WithRecords
import Native
public class Caller {
    public func Copy(value Row[string]) Row[string] -> value with { Extra = 13 }
}`
        } else {
            `package WithRecords
import Native
public data class Row[T any](Value T, Extra int32) {
    public let Anchor object = Trace.Identity()
}
public class Caller[A any, B any] {
    public func Copy(value Row[B]) Row[B] -> value with { Extra = 13 }
}`
        }
        let library = Compile(native.DirectoryPath, source, native.AssemblyPath)
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(library, []string{native.AssemblyPath})
        let rowNamespace = if imported {
            "Native"
        } else {
            "WithRecords"
        }
        let construction = if imported {
            "Caller"
        } else {
            "Caller<int, string>"
        }
        using let caller = CSharpFixture((`#nullable enable
public static class Probe {
    public static string Run() {
        var original = new ` + "$rowNamespace" + `.Row<string>("payload", 7);
        var copy = new WithRecords.` + "$construction" + `().Copy(original);
        if (copy.GetType() != original.GetType() || object.ReferenceEquals(copy, original)
            || !object.ReferenceEquals(copy.Value, original.Value)
            || !object.ReferenceEquals(copy.Anchor, original.Anchor)
            || copy.Extra != 13 || original.Extra != 7 || Native.Trace.Count != 1)
            throw new System.Exception("object-root clone contract");
        return "distinct|readonly|once";
    }
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(native.AssemblyPath),
                MetadataReference.CreateFromFile(library)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{library, native.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(library),
            File.ReadAllBytes(caller.AssemblyPath)
        )
        let method = assemblies[2].GetType("Probe")?.GetMethod("Run") ??
            throw InvalidOperationException("Missing native oracle")
        Assert.Equal("distinct|readonly|once", method.Invoke(nil, nil))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedMarkerWithoutAccessibleClone_ReportsLocatedDiagnosticAndNoOutput(privateClone bool) {
        using let native = CSharpFixture(`[assembly: System.Reflection.AssemblyMetadata("GSharp.TypeSemantics", "33554434|class|1|")]
namespace Native {
    public class Broken {
        public int Value;
        private Broken Clone___() => this;
    }
}`)
        if privateClone {
            // C# cannot spell the reserved CLR clone name. Rename only its
            // equal-length heap entry, retaining Roslyn's private method body.
            let imageBytes = File.ReadAllBytes(native.AssemblyPath)
            let oldName = Encoding.UTF8.GetBytes("Clone___\u0000")
            let offset = imageBytes.AsSpan().IndexOf(oldName)
            Assert.True(offset >= 0)
            Assert.Equal(offset, imageBytes.AsSpan().LastIndexOf(oldName))
            Encoding.UTF8.GetBytes("<Clone>$$\u0000").CopyTo(imageBytes, offset)
            File.WriteAllBytes(native.AssemblyPath, imageBytes)
            let clone MethodInfo? = native
                .Load()
                .GetType("Native.Broken")
                ?.GetMethod("<Clone>$$", BindingFlags.Instance | BindingFlags.NonPublic)
            Assert.NotNull(clone)
            Assert.True(clone!!.IsPrivate)
        }
        const source = `package WithRecords
import Native
public func Copy(value Broken) Broken -> value with { Value = 1 }`
        using let references = native.RuntimeReferences()
        let compilation = GsCompilation(references, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let image = MemoryStream()
        let result = compilation.Emit(image, pdbStream: nil, refStream: nil, assemblyName: "BrokenConsumer")
        Assert.False(result.Success)
        Assert.Equal(int64(0), image.Length)
        let diagnostic = Assert.Single(
            result.Diagnostics.Where(
                (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message.Contains("<Clone>$$", StringComparison.Ordinal)
            )
        )
        Assert.Equal("GS0158", diagnostic.Id)
        Assert.Equal("with", source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length))
    }

    private class SourceVisitWalker : BoundTreeWalker {
        private let source BoundExpression

        init(source BoundExpression) {
            this.source = source
        }

        prop SourceVisits int32 {
            get;
            private set;
        }

        override func VisitExpression(node BoundExpression) {
            if object.ReferenceEquals(node, this.source) {
                this.SourceVisits++
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func Compile(directory string, source string, references ...string) string {
            let sourcePath = Path.Combine(directory, "Records.gs")
            let output = Path.Combine(directory, "Records.dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{
                "/target:library",
                "/targetframework:net10.0",
                "/assemblyname:Records",
                "/out:" + output
            }
            for reference in references {
                arguments.Add("/r:" + reference)
            }
            arguments.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                let exit = Program.Main(arguments.ToArray())
                Assert.True(exit == 0, (`gsc exited ` + "$exit" + `
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(File.Exists(output), stdout.ToString() + Environment.NewLine + stderr.ToString())
            return output
        }
    }
}
