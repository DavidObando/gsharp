// <copyright file="Issue4988SignatureNullabilityMatrixTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GscProgram = GSharp.Compiler.Program
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

/// Issue #4988: the nullability a G# library declares must survive emit into
/// metadata at every signature position, whichever declaration path produced
/// the member. `func LoadAsync() Task[Token?];` on an interface was exported as
/// `Task[Token]` because a method without a body never minted the sequence-0
/// return row its `[Nullable]` lives on; a body-bearing method did.
///
/// The test is a round-trip contract over a matrix: every declaration kind gsc
/// emits a MethodDef / Property / Field / Event for, crossed with a set of type
/// shapes. The producer is compiled with the real driver; the positions are then
/// read back from metadata exactly as a separately compiled consumer reads a
/// project reference (`MetadataLoadContext` + the `ClrNullability` /
/// `MemberLookup` funnel readers), and checked against two oracles:
/// - the imported (cref:TypeSymbol), spelled in G# syntax, must equal the declared spelling;
/// - the effective per-position nullability bytes must equal what csc emits for the equivalent C#
/// declarations (the C# twin), which also pins the method-level context compression.
open class Issue4988SignatureNullabilityMatrixTests {
    /// The whole matrix, for a modern and a downlevel producer. A netstandard2.0
    /// producer embeds its own `NullableAttribute` / `NullableContextAttribute`
    /// (#4922), so it exercises the same plan through a different attribute
    /// binding. Data classes and inline structs are left out of the
    /// netstandard2.0 producer: their synthesized members bind to
    /// `System.HashCode`, `IsExternalInit` and `IsReadOnlyAttribute`, which
    /// netstandard2.0 does not have, through host-only references (#4993).
    /// @param targetFramework The producer's target framework.
    @Theory
    @InlineData("net10.0")
    @InlineData("netstandard2.0")
    func EveryDeclarationKind_RoundTripsEveryShape_ThroughMetadata(targetFramework string) {
        let isNetStandard = targetFramework == "netstandard2.0"
        let includeModernOnlyKinds = !isNetStandard
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_").FullName
        try {
            var coreDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                throw InvalidOperationException("the host runtime has a directory")
            let references = List[string]()
            if isNetStandard {
                let netstandard = FindNetStandardReference() ??
                    throw InvalidOperationException(
                    "could not locate a netstandard.dll reference assembly; this test must not be skipped silently."
                )
                references.Add(netstandard)
                coreDirectory = Path.GetDirectoryName(netstandard) ??
                    throw InvalidOperationException("a reference assembly has a directory")
            }
            let producerPath = CompileGSharp(
                tempDir,
                BuildGSharpProducer(includeModernOnlyKinds),
                targetFramework,
                references,
                verify: !isNetStandard
            )
            let twinPath = CompileCSharp(tempDir, BuildCSharpTwin(includeModernOnlyKinds))
            using let producerContext = LoadContext(producerPath, coreDirectory, isNetStandard)
            using let twinContext = LoadContext(
                twinPath,
                Path.GetDirectoryName(typeof(object).Assembly.Location) ??
                    throw InvalidOperationException("the host runtime has a directory"),
                false
            )
            let producer = producerContext.LoadFromAssemblyPath(producerPath)
            let twin = twinContext.LoadFromAssemblyPath(twinPath)
            let failures = List[string]()
            var checkedPositions = 0
            var failingPositions = 0
            for position in BuildPositions(includeModernOnlyKinds) {
                let reference = Resolve(twin, position)
                checkedPositions++
                // A position gsc emitted without a row at all (an unnamed or
                // missing Param row) cannot be selected; that is a failure of
                // the round trip, not of the test.
                guard let imported = TryResolve(producer, position, failures) else {
                    failingPositions++
                    continue
                }
                let failuresBefore = failures.Count
                let importedSpelling = Render(imported.ReadSymbol(), imported.ClrType)
                if importedSpelling != position.Expected {
                    failures.Add("${position.Key}: imported as '$importedSpelling', declared '${position.Expected}'")
                }
                let importedBytes = EffectiveBytes(imported)
                let referenceBytes = position.ExpectedBytes ?? EffectiveBytes(reference)
                if importedBytes != referenceBytes {
                    failures.Add("${position.Key}: gsc bytes [$importedBytes], expected (csc) bytes [$referenceBytes]")
                }
                if failures.Count != failuresBefore {
                    failingPositions++
                }
            }
            // Anti-vacuity: the matrix really was enumerated.
            Assert.True(checkedPositions > 400, "only $checkedPositions positions were checked")
            Assert.True(
                failures.Count == 0,
                "$failingPositions of $checkedPositions positions did not round-trip ($targetFramework):\n" +
                    string.Join("\n", failures)
            )
        } finally {
            TryDelete(tempDir)
        }
    }

    /// The issue's own scenario, through the real driver on both sides: a
    /// consumer compiled against the producer DLL sees the interface's
    /// `Task[Token?]` result as `Token?`, so `!!` on it is needed (no
    /// GS0536), and returning it as a non-null `Token` is rejected. The
    /// delegate `Invoke` row is the same defect on another path.
    @Fact
    func Consumer_SeesTheNullableResultOfABodylessInterfaceMethod_AcrossAReference() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_consumer_").FullName
        try {
            let libraryPath = CompileGSharp(tempDir, ContractSource, "net10.0", List[string](), verify: true)
            let asserted = CompileConsumer(tempDir, libraryPath, AssertingConsumerSource)
            Assert.True(asserted.ExitCode == 0, "the consumer must compile:\n" + asserted.Output)
            Assert.DoesNotContain("GS0536", asserted.Output, StringComparison.Ordinal)
            let interfaceMisuse = CompileConsumer(tempDir, libraryPath, InterfaceMisuseSource)
            Assert.True(
                interfaceMisuse.ExitCode != 0,
                "IStore.LoadAsync() must read back as Task[Token?]:\n" + interfaceMisuse.Output
            )
            let delegateMisuse = CompileConsumer(tempDir, libraryPath, DelegateMisuseSource)
            Assert.True(
                delegateMisuse.ExitCode != 0,
                "Loader.Invoke must read back as returning Token?:\n" + delegateMisuse.Output
            )
        } finally {
            TryDelete(tempDir)
        }
    }

    /// A generic method's `[NullableContext]` is also what C# reads for its
    /// type parameters' constraints, which gsc does not stamp (#4996). So a
    /// `T class` method keeps the type's context however its signature
    /// votes: under `[NullableContext(2)]` C# would import `where T : class?`
    /// and stop warning on a nullable type argument. Checked through a real C#
    /// consumer, for a bodyless interface method and for a method with a body
    /// (whose majority-`2` context used to do exactly that).
    @Fact
    func CSharpConsumer_KeepsTheClassConstraintOfGenericMethods() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_constraint_").FullName
        try {
            let libraryPath = CompileGSharp(tempDir, GenericConstraintSource, "net10.0", List[string](), verify: true)
            let references = ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Concat([]string{libraryPath})
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                "ConstraintConsumer",
                []SyntaxTree{CSharpSyntaxTree.ParseText(GenericConstraintConsumerSource)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let diagnostics = compilation.GetDiagnostics()
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            let constraintWarnings = diagnostics.Where((d Diagnostic) -> d.Id == "CS8634").ToArray()
            Assert.True(
                constraintWarnings.Length == 2,
                "both `Pick[string?]` calls must violate `T class`:\n" + string.Join("\n", diagnostics)
            )
        } finally {
            TryDelete(tempDir)
        }
    }

    /// Emit stays byte-for-byte reproducible with every signature routed
    /// through the plan.
    @Fact
    func ProducerEmit_IsDeterministic() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue4988_det_").FullName
        try {
            let source = BuildGSharpProducer(true)
            let first = File.ReadAllBytes(
                CompileGSharp(Path.Combine(tempDir, "a"), source, "net10.0", List[string](), verify: false)
            )
            let second = File.ReadAllBytes(
                CompileGSharp(Path.Combine(tempDir, "b"), source, "net10.0", List[string](), verify: false)
            )
            Assert.Equal(first, second)
        } finally {
            TryDelete(tempDir)
        }
    }

    shared {
        private let AllMembers BindingFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly

        private let Shapes[]Issue4988Shape = []Issue4988Shape{
            Issue4988Shape("Token?", "Token?"),
            Issue4988Shape("Task[Token?]", "Task<Token?>"),
            Issue4988Shape("[]Token?", "Token?[]"),
            Issue4988Shape("[]?Token", "Token[]?"),
            Issue4988Shape("Dictionary[string, Token?]", "Dictionary<string, Token?>"),
            Issue4988Shape("Task[List[Token?]]", "Task<List<Token?>>"),
            Issue4988Shape("int32?", "int?"),
            Issue4988Shape("(Token?, int32)", "(Token?, int)"),
            Issue4988Shape("KeyValuePair[string, Token?]", "KeyValuePair<string, Token?>"),
            Issue4988Shape("Token", "Token"),
            Issue4988Shape("List[Token?]?", "List<Token?>?"),
            Issue4988Shape("string", "string")
        }

        private func IsTaskShape(shape Issue4988Shape) bool -> shape.GSharp.StartsWith(
            "Task[",
            StringComparison.Ordinal
        )

        private func BuildGSharpProducer(includeModernOnlyKinds bool) string {
            let g = StringBuilder()
            g.AppendLine("package Matrix")
            g.AppendLine()
            g.AppendLine("import System")
            g.AppendLine("import System.Collections.Generic")
            g.AppendLine("import System.Threading.Tasks")
            g.AppendLine()
            g.AppendLine("class Token {}")
            g.AppendLine()
            g.AppendLine("interface IFace {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("    func Abs$i(p $t) $t;")
                g.AppendLine("    func Dim$i(p $t) $t { return p }")
                g.AppendLine("    prop Prop$i $t { get; set; }")
                g.AppendLine("    event Ev$i Action[$t]")
            }
            g.AppendLine("    func Gen[T](p T) T;")
            g.AppendLine("    func GenClass[T class](p T?) T?;")
            g.AppendLine("    func GenStruct[T struct](p T?) T?;")
            g.AppendLine("    prop this[key string?] Task[Token?] { get; }")
            g.AppendLine("}")
            g.AppendLine()
            g.AppendLine("sealed interface IStatic[TSelf] {")
            g.AppendLine("    shared {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("        func Sva$i(p $t) $t;")
                g.AppendLine("        func SvaDefault$i(p $t) $t { return p }")
            }
            g.AppendLine("    }")
            g.AppendLine("}")
            g.AppendLine()
            g.AppendLine("open class Base {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("    open func Abs$i(p $t) $t;")
                g.AppendLine("    open func Virt$i(p $t) $t { return p }")
            }
            g.AppendLine("}")
            g.AppendLine()
            g.AppendLine("class Impl {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("    var Field$i $t")
                g.AppendLine("    prop Auto$i $t { get; set; }")
                g.AppendLine("    event Ev$i Action[$t]")
                g.AppendLine("    func Method$i(p $t) $t { return p }")
                if !IsTaskShape(Shapes[i]) {
                    g.AppendLine("    async func Async$i(p $t) $t { return p }")
                }
            }
            g.AppendLine("    shared {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("        func Static$i(p $t) $t { return p }")
                g.AppendLine("        prop StaticAuto$i $t { get; set; }")
            }
            g.AppendLine("    }")
            g.AppendLine("}")
            g.AppendLine()
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                g.AppendLine("delegate Del$i(p $t) $t;")
                g.AppendLine("class Ctor$i {")
                g.AppendLine("    init(p $t) {")
                g.AppendLine("    }")
                g.AppendLine("}")
                g.AppendLine("class Conv$i {}")
                g.AppendLine("func operator explicit(value $t) Conv$i { return Conv$i() }")
                g.AppendLine("func (t Token) Ext$i(p $t) $t { return p }")
                if includeModernOnlyKinds {
                    g.AppendLine("inline struct Inl$i(V $t)")
                }
                if includeModernOnlyKinds {
                    g.AppendLine("data class Rec$i(V $t)")
                }
            }
            g.AppendLine()
            g.AppendLine("partial class Part {")
            g.AppendLine("    partial func Declared(x Token?) Task[Token?];")
            g.AppendLine("}")
            g.AppendLine("partial class Part {")
            g.AppendLine("    partial func Declared(x Token?) Task[Token?] { return Task.FromResult[Token?](x) }")
            g.AppendLine("}")
            g.AppendLine()
            if includeModernOnlyKinds {
                g.AppendLine("data class GenRec[T](V T)")
            }
            g.AppendLine("class Obl {")
            g.AppendLine("    @Oblivious func ObliviousMethod(p string) string { return p }")
            g.AppendLine("    @Oblivious prop ObliviousProp string { get; set; }")
            g.AppendLine("}")
            return g.ToString()
        }

        private func BuildCSharpTwin(includeModernOnlyKinds bool) string {
            let c = StringBuilder()
            c.AppendLine("#nullable enable")
            c.AppendLine("using System;")
            c.AppendLine("using System.Collections.Generic;")
            c.AppendLine("using System.Threading.Tasks;")
            c.AppendLine("namespace Matrix;")
            c.AppendLine("public class Token {}")
            c.AppendLine("public interface IFace {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    $t Abs$i($t p);")
                c.AppendLine("    $t Dim$i($t p) { return p; }")
                c.AppendLine("    $t Prop$i { get; set; }")
                c.AppendLine("    event Action<$t> Ev$i;")
            }
            c.AppendLine("    T Gen<T>(T p);")
            c.AppendLine("    T? GenClass<T>(T? p) where T : class;")
            c.AppendLine("    T? GenStruct<T>(T? p) where T : struct;")
            c.AppendLine("    Task<Token?> this[string? key] { get; }")
            c.AppendLine("}")
            c.AppendLine("public interface IStatic<TSelf> {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    static abstract $t Sva$i($t p);")
                c.AppendLine("    static virtual $t SvaDefault$i($t p) { return p; }")
            }
            c.AppendLine("}")
            c.AppendLine("public abstract class Base {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    public abstract $t Abs$i($t p);")
                c.AppendLine("    public virtual $t Virt$i($t p) { return p; }")
            }
            c.AppendLine("}")
            c.AppendLine("public class Impl {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    public $t Field$i = default!;")
                c.AppendLine("    public $t Auto$i { get; set; } = default!;")
                c.AppendLine("    public event Action<$t> Ev$i = default!;")
                c.AppendLine("    public $t Method$i($t p) { return p; }")
                if !IsTaskShape(Shapes[i]) {
                    c.AppendLine("    public async Task<$t> Async$i($t p) { await Task.Yield(); return p; }")
                }
                c.AppendLine("    public static $t Static$i($t p) { return p; }")
                c.AppendLine("    public static $t StaticAuto$i { get; set; } = default!;")
            }
            c.AppendLine("}")
            c.AppendLine("public static class Program {")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("    public static $t Ext$i(this Token t, $t p) { return p; }")
            }
            c.AppendLine("}")
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].CSharp
                c.AppendLine("public delegate $t Del$i($t p);")
                c.AppendLine("public class Ctor$i { public Ctor$i($t p) {} }")
                c.AppendLine(
                    "public class Conv$i { public static explicit operator Conv$i($t value) { return new Conv$i(); } }"
                )
                if includeModernOnlyKinds {
                    c.AppendLine(
                        "public struct Inl$i { public readonly $t V; public Inl$i($t V) { this.V = V; } " +
                            "public void Deconstruct(out $t V) { V = this.V; } " +
                            "public override bool Equals(object? obj) { return false; } " +
                            "public override int GetHashCode() { return 0; } }"
                    )
                }
                if includeModernOnlyKinds {
                    c.AppendLine("public record class Rec$i($t V);")
                }
            }
            c.AppendLine("public partial class Part {")
            c.AppendLine("    public partial Task<Token?> Declared(Token? x);")
            c.AppendLine("}")
            c.AppendLine("public partial class Part {")
            c.AppendLine("    public partial Task<Token?> Declared(Token? x) { return Task.FromResult<Token?>(x); }")
            c.AppendLine("}")
            if includeModernOnlyKinds {
                c.AppendLine("public record class GenRec<T>(T V);")
            }
            c.AppendLine("public class Obl {")
            c.AppendLine("#nullable disable")
            c.AppendLine("    public string ObliviousMethod(string p) { return p; }")
            c.AppendLine("    public string ObliviousProp { get; set; }")
            c.AppendLine("#nullable enable")
            c.AppendLine("}")
            return c.ToString()
        }

        private func BuildPositions(includeModernOnlyKinds bool) List[Issue4988Position] {
            let positions = List[Issue4988Position]()
            let AddChecked = func (
                typeName string,
                kind Issue4988PositionKind,
                member string,
                index int32,
                selector string?,
                expected string,
                expectedBytes string?
            ) {
                let slot = switch kind {
                    case Issue4988PositionKind.Return: "ret"
                    case Issue4988PositionKind.Parameter: "p$index"
                    default: "${kind}"
                }
                positions.Add(
                    Issue4988Position(
                        "$typeName.$member[$slot]",
                        typeName,
                        kind,
                        member,
                        index,
                        selector,
                        expected,
                        expectedBytes
                    )
                )
            }
            let Add = func (
                typeName string,
                kind Issue4988PositionKind,
                member string,
                index int32,
                selector string?,
                expected string
            ) {
                AddChecked(typeName, kind, member, index, selector, expected, nil)
            }
            let AddMethod = func (
                typeName string,
                member string,
                parameterIndex int32,
                returned string,
                parameter string
            ) {
                Add(typeName, Issue4988PositionKind.Return, member, -1, nil, returned)
                Add(typeName, Issue4988PositionKind.Parameter, member, parameterIndex, nil, parameter)
            }
            let AddProperty = func (typeName string, name string, type string) {
                Add(typeName, Issue4988PositionKind.Property, name, -1, nil, type)
                Add(typeName, Issue4988PositionKind.Return, "get_$name", -1, nil, type)
                Add(typeName, Issue4988PositionKind.Parameter, "set_$name", 0, nil, type)
            }
            let AddEvent = func (typeName string, name string, handler string) {
                Add(typeName, Issue4988PositionKind.Event, name, -1, nil, handler)
                Add(typeName, Issue4988PositionKind.Parameter, "add_$name", 0, nil, handler)
                Add(typeName, Issue4988PositionKind.Parameter, "remove_$name", 0, nil, handler)
            }
            for var i = 0; i < Shapes.Length; i++ {
                let t = Shapes[i].GSharp
                let handler = "Action[$t]"
                AddMethod("IFace", "Abs$i", 0, t, t)
                AddMethod("IFace", "Dim$i", 0, t, t)
                AddProperty("IFace", "Prop$i", t)
                AddEvent("IFace", "Ev$i", handler)
                AddMethod("IStatic`1", "Sva$i", 0, t, t)
                AddMethod("IStatic`1", "SvaDefault$i", 0, t, t)
                AddMethod("Base", "Abs$i", 0, t, t)
                AddMethod("Base", "Virt$i", 0, t, t)
                Add("Impl", Issue4988PositionKind.Field, "Field$i", -1, nil, t)
                AddProperty("Impl", "Auto$i", t)
                Add("Impl", Issue4988PositionKind.Field, "<Auto$i>k__BackingField", -1, nil, t)
                AddEvent("Impl", "Ev$i", handler)
                Add("Impl", Issue4988PositionKind.Field, "Ev$i", -1, nil, handler)
                AddMethod("Impl", "Method$i", 0, t, t)
                if !IsTaskShape(Shapes[i]) {
                    AddMethod("Impl", "Async$i", 0, "Task[$t]", t)
                }
                AddMethod("Impl", "Static$i", 0, t, t)
                AddProperty("Impl", "StaticAuto$i", t)
                AddMethod("Del$i", "Invoke", 0, t, t)
                Add("Ctor$i", Issue4988PositionKind.Parameter, ".ctor", 0, "p", t)
                // gsc hosts a conversion on a source type it involves, which for
                // `Token` is `Token`; csc on the declaring class. Find it anywhere.
                Add("*", Issue4988PositionKind.Return, "op_Explicit", -1, "Conv$i", "Conv$i")
                Add("*", Issue4988PositionKind.Parameter, "op_Explicit", 0, "Conv$i", t)
                AddMethod("*", "Ext$i", 1, t, t)
                if includeModernOnlyKinds {
                    let inline = "Inl$i"
                    Add(inline, Issue4988PositionKind.Parameter, ".ctor", 0, "V", t)
                    Add(inline, Issue4988PositionKind.Field, "V", -1, nil, t)
                    Add(inline, Issue4988PositionKind.Parameter, "Deconstruct", 0, nil, t)
                    Add(inline, Issue4988PositionKind.Parameter, "Equals", 0, "Object", "object?")
                }
                if includeModernOnlyKinds {
                    let record = "Rec$i"
                    Add(record, Issue4988PositionKind.Parameter, ".ctor", 0, "V", t)
                    AddProperty(record, "V", t)
                    Add(record, Issue4988PositionKind.Parameter, "Deconstruct", 0, nil, t)
                    Add(record, Issue4988PositionKind.Parameter, "op_Equality", 0, nil, "$record?")
                    Add(record, Issue4988PositionKind.Parameter, "op_Equality", 1, nil, "$record?")
                    Add(record, Issue4988PositionKind.Parameter, "op_Inequality", 0, nil, "$record?")
                    Add(record, Issue4988PositionKind.Parameter, "op_Inequality", 1, nil, "$record?")
                }
            }
            AddMethod("IFace", "Gen", 0, "T", "T")
            AddMethod("IFace", "GenClass", 0, "T?", "T?")
            AddMethod("IFace", "GenStruct", 0, "T?", "T?")
            Add("IFace", Issue4988PositionKind.Property, "Item", -1, nil, "Task[Token?]")
            AddMethod("IFace", "get_Item", 0, "Task[Token?]", "string?")
            AddMethod("Part", "Declared", 0, "Task[Token?]", "Token?")
            if includeModernOnlyKinds {
                // A generic data class's synthesized members refer to the open
                // type itself: its `T` slot must stay `T` under the `?`.
                let generic = "GenRec`1"
                Add(generic, Issue4988PositionKind.Parameter, ".ctor", 0, "V", "T")
                AddProperty(generic, "V", "T")
                Add(generic, Issue4988PositionKind.Parameter, "Deconstruct", 0, nil, "T")
                // csc builds a record's own type for these members with
                // oblivious type arguments, so its bytes read `[2, 0]`. The
                // declared `T` is `1`, which gsc emits (and already emitted for
                // `Equals` before #4988), so the bytes are pinned here instead.
                AddChecked(generic, Issue4988PositionKind.Parameter, "Equals", 0, "GenRec`1", "GenRec[T]?", "2,1")
                for operatorName in[]string{"op_Equality", "op_Inequality"} {
                    AddChecked(generic, Issue4988PositionKind.Parameter, operatorName, 0, nil, "GenRec[T]?", "2,1")
                    AddChecked(generic, Issue4988PositionKind.Parameter, operatorName, 1, nil, "GenRec[T]?", "2,1")
                }
            }
            AddMethod("Obl", "ObliviousMethod", 0, "string!", "string!")
            AddProperty("Obl", "ObliviousProp", "string!")
            return positions
        }

        private func TryResolve(
            assembly Assembly,
            position Issue4988Position,
            failures List[string]
        ) Issue4988ResolvedPosition? {
            try {
                return Resolve(assembly, position)
            } catch (e InvalidOperationException) {
                failures.Add("${position.Key}: not found in the gsc output (${e.Message})")
                return nil
            }
        }

        private func Resolve(assembly Assembly, position Issue4988Position) Issue4988ResolvedPosition {
            let FindType = func (name string) Type {
                return assembly.GetType("Matrix.$name") ??
                    throw InvalidOperationException("${position.Key}: type Matrix.$name not found")
            }
            let FindMethod = func () MethodBase {
                if position.Member == ".ctor" {
                    return FindType(position.TypeName).GetConstructors(AllMembers).Single(
                        (c ConstructorInfo) -> c.GetParameters()
                            .Length > 0 &&
                            c
                            .GetParameters()[0]
                            .Name == position.Selector
                    )
                }
                let candidates = if position.TypeName == "*" {
                    assembly.GetTypes().SelectMany((t Type) -> t.GetMethods(AllMembers)).ToArray()
                } else {
                    FindType(position.TypeName).GetMethods(AllMembers)
                }
                let Selected = func (m MethodInfo) bool {
                    if position.Selector == nil {
                        return true
                    }
                    if position.TypeName == "*" {
                        return m.ReturnType.Name == position.Selector
                    }
                    let parameters = m.GetParameters()
                    return parameters.Length > 0 && parameters[0].ParameterType.Name == position.Selector
                }
                let matches = candidates.Where((m MethodInfo) -> m.Name == position.Member && Selected(m)).ToArray()
                if matches.Length != 1 {
                    throw InvalidOperationException("${position.Key}: expected one method, found ${matches.Length}")
                }
                return matches[0]
            }
            switch position.Kind {
                case Issue4988PositionKind.Return {
                    let method = cast[MethodInfo](FindMethod())
                    return Issue4988ResolvedPosition(
                        method.ReturnType,
                        method.ReturnParameter,
                        method,
                        () -> ClrNullability.GetReturnTypeSymbol(method)
                    )
                }
                case Issue4988PositionKind.Parameter {
                    let method = FindMethod()
                    let parameter = method.GetParameters()[position.Index]
                    return Issue4988ResolvedPosition(
                        parameter.ParameterType,
                        parameter,
                        method,
                        () -> ClrNullability.GetParameterTypeSymbol(parameter)
                    )
                }
                case Issue4988PositionKind.Property {
                    let property = FindType(position.TypeName).GetProperty(position.Member, AllMembers) ??
                        throw InvalidOperationException("${position.Key}: property not found")
                    return Issue4988ResolvedPosition(
                        property.PropertyType,
                        property,
                        property,
                        () -> ClrNullability.GetPropertyTypeSymbol(property)
                    )
                }
                case Issue4988PositionKind.Field {
                    let field = FindType(position.TypeName).GetField(position.Member, AllMembers) ??
                        throw InvalidOperationException("${position.Key}: field not found")
                    return Issue4988ResolvedPosition(
                        field.FieldType,
                        field,
                        field,
                        () -> ClrNullability.GetFieldTypeSymbol(field)
                    )
                }
                default {
                    let ev = FindType(position.TypeName).GetEvent(position.Member, AllMembers) ??
                        throw InvalidOperationException("${position.Key}: event not found")
                    let handler = ev.EventHandlerType ??
                        throw InvalidOperationException("${position.Key}: event has no handler type")
                    return Issue4988ResolvedPosition(
                        handler,
                        ev,
                        ev,
                        () -> MemberLookup.GetClrEventHandlerTypeSymbol(ev)
                    )
                }
            }
        }

        /// The bytes a reader sees at a position once scalar and context forms
        /// are expanded: the position's own `[Nullable]`, else the nearest
        /// enclosing `[NullableContext]`. Absent metadata reads as `0`.
        private func EffectiveBytes(position Issue4988ResolvedPosition) string {
            let type = if position.ClrType.IsByRef {
                position.ClrType.GetElementType() ??
                    throw InvalidOperationException("a by-ref type has an element type")
            } else {
                position.ClrType
            }
            let flags = ClrNullability.ReadNullableFlags(position.Declaration, position.Enclosing)
            return string.Join(",", ClrNullability.ExpandNullableFlags(type, flags, uint8(0)))
        }

        /// Spells an imported (cref:TypeSymbol) in G# syntax, descending
        /// through the funnel accessors so every nested `?` / `!` the
        /// reader produced is shown (SymbolDisplay deliberately hides nested
        /// reference `?`).
        private func Render(symbol TypeSymbol, clr Type) string {
            if clr.IsByRef {
                let element = clr.GetElementType() ??
                    throw InvalidOperationException("a by-ref type has an element type")
                return if symbol is ByRefTypeSymbol byRef {
                    Render(byRef.PointeeType, element)
                } else {
                    Render(symbol, element)
                }
            }
            if clr.IsGenericType && !clr.IsGenericTypeDefinition && clr.GetGenericTypeDefinition()
                .FullName == "System.Nullable`1" {
                let inner = if symbol is NullableTypeSymbol nullableValue {
                    nullableValue.UnderlyingType
                } else {
                    symbol
                }
                return Render(inner, clr.GetGenericArguments()[0]) + "?"
            }
            if symbol is NullableTypeSymbol nullable {
                return if clr.IsArray {
                    "[]?" + RenderElement(nullable.UnderlyingType, clr)
                } else {
                    Render(nullable.UnderlyingType, clr) + "?"
                }
            }
            if symbol is PlatformTypeSymbol platform {
                return if clr.IsArray {
                    "[]!" + RenderElement(platform.UnderlyingType, clr)
                } else {
                    Render(platform.UnderlyingType, clr) + "!"
                }
            }
            if clr.IsArray {
                return "[]" + RenderElement(symbol, clr)
            }
            if clr.IsGenericParameter {
                return clr.Name
            }
            let arguments = if clr.IsGenericType {
                clr.GetGenericArguments()
            } else {
                Type.EmptyTypes
            }
            if symbol is TupleTypeSymbol tuple {
                let elements = List[string]()
                for var i = 0; i < tuple.ElementTypes.Length; i++ {
                    elements.Add(Render(tuple.ElementTypes[i], arguments[i]))
                }
                return "(" + string.Join(", ", elements) + ")"
            }
            if arguments.Length > 0 && clr.IsGenericTypeDefinition {
                // The open type referring to itself (`R[T]` inside `R[T]`): its
                // arguments are its own parameters.
                return GenericName(clr) + "[" + string.Join(", ", arguments.Select((a Type) -> a.Name)) + "]"
            }
            if arguments.Length > 0 {
                let rendered = List[string]()
                for var i = 0; i < arguments.Length; i++ {
                    rendered.Add(RenderArgument(symbol, i, arguments[i]))
                }
                return GenericName(clr) + "[" + string.Join(", ", rendered) + "]"
            }
            return SimpleName(clr)
        }

        private func RenderArgument(symbol TypeSymbol, index int32, clr Type) string {
            if symbol is NullabilityAnnotatedTypeSymbol annotated {
                return Render(annotated.GetTypeArgumentSymbol(index), clr)
            }
            if symbol is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
                return Render(imported.TypeArguments[index], clr)
            }
            // An argument with no nullability positions (`int32?` in
            // `Action[int32?]`) carries nothing to read back: spell its CLR shape.
            if ClrNullability.CountNullabilityBytes(clr) == 0 {
                return RenderValueType(clr)
            }
            // No per-argument information survived at all.
            return "<${SimpleName(clr)}: no nullability>"
        }

        private func RenderValueType(clr Type) string {
            if clr.IsGenericType && clr.GetGenericTypeDefinition().FullName == "System.Nullable`1" {
                return RenderValueType(clr.GetGenericArguments()[0]) + "?"
            }
            return SimpleName(clr)
        }

        private func RenderElement(symbol TypeSymbol, arrayClr Type) string {
            let element = arrayClr.GetElementType() ??
                throw InvalidOperationException("an array type has an element type")
            return switch symbol {
                case annotated is NullabilityAnnotatedTypeSymbol: Render(
                    ClrNullability.SymbolFromFlagsOffset(element, annotated.NullableFlags, 1),
                    element
                )
                case slice is SliceTypeSymbol: Render(slice.ElementType, element)
                case array is ArrayTypeSymbol: Render(array.ElementType, element)
                default: "<${SimpleName(element)}: no nullability>"
            }
        }

        private func GenericName(clr Type) string {
            let name = clr.Name
            let tick = name.IndexOf('`')
            return if tick < 0 {
                name
            } else {
                name.Substring(0, tick)
            }
        }

        private func SimpleName(clr Type) string -> switch clr.FullName {
            case "System.String": "string"
            case "System.Int32": "int32"
            case "System.Object": "object"
            case "System.Boolean": "bool"
            default: GenericName(clr)
        }

        private func CompileGSharp(
            directory string,
            source string,
            targetFramework string,
            references List[string],
            verify bool
        ) string {
            Directory.CreateDirectory(directory)
            let srcPath = Path.Combine(directory, "producer.gs")
            let outPath = Path.Combine(directory, "Producer.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:library", "/targetframework:" + targetFramework}
            for reference in references {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            let (exit, output) = RunDriver(args)
            Assert.True(exit == 0, "gsc failed compiling the producer:\n" + output)
            if verify {
                IlVerifier.Verify(outPath)
            }
            return outPath
        }

        private func CompileConsumer(directory string, libraryPath string, source string)(
            ExitCode int32,
            Output string
        ) {
            let srcPath = Path.Combine(directory, "consumer.gs")
            let outPath = Path.Combine(directory, "Consumer.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/reference:" + libraryPath,
                srcPath
            }
            return RunDriver(args)
        }

        private func RunDriver(args List[string])(int32, string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = GscProgram.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (exit, "stdout:\n$compileOut\nstderr:\n$compileErr")
        }

        private func CompileCSharp(directory string, source string) string {
            let outPath = Path.Combine(directory, "Twin.dll")
            let references = ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Twin",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let result = compilation.Emit(outPath)
            Assert.True(
                result.Success,
                "the C# twin failed to compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return outPath
        }

        private func LoadContext(assemblyPath string, coreDirectory string, isNetStandard bool) MetadataLoadContext {
            let resolver = PathAssemblyResolver(
                Directory.GetFiles(coreDirectory, "*.dll").Concat([]string{assemblyPath})
            )
            return MetadataLoadContext(
                resolver,
                if isNetStandard {
                    "netstandard"
                } else {
                    "System.Private.CoreLib"
                }
            )
        }

        /// The netstandard2.0 contract: the NETStandard.Library 2.0 package's
        /// reference assembly when the NuGet cache has it, otherwise the SDK's
        /// NETStandard.Library.Ref pack (as Issue4921HostFallbackEmbeddableAttributeTests does).
        private func FindNetStandardReference() string? {
            let packages = Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".nuget",
                "packages"
            )
            let packageRoot = Path.Combine(packages, "netstandard.library")
            if Directory.Exists(packageRoot) {
                let packaged string? = Directory
                    .GetFiles(packageRoot, "netstandard.dll", SearchOption.AllDirectories)
                    .Where(
                    (p string) -> p.Contains(Path.Combine("build", "netstandard2.0", "ref"), StringComparison.Ordinal)
                )
                    .OrderByDescending((p string) -> p, StringComparer.Ordinal)
                    .FirstOrDefault()
                if packaged != nil {
                    return packaged
                }
            }
            var dotnetRoot string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            while dotnetRoot != nil && !Directory.Exists(Path.Combine(dotnetRoot, "packs")) {
                dotnetRoot = Path.GetDirectoryName(dotnetRoot)
            }
            if dotnetRoot == nil {
                return nil
            }
            let packRoot = Path.Combine(dotnetRoot, "packs", "NETStandard.Library.Ref")
            if !Directory.Exists(packRoot) {
                return nil
            }
            return Directory
                .GetFiles(packRoot, "netstandard.dll", SearchOption.AllDirectories)
                .OrderByDescending((p string) -> p, StringComparer.Ordinal)
                .FirstOrDefault()
        }

        private func TryDelete(directory string) {
            try {
                if Directory.Exists(directory) {
                    Directory.Delete(directory, recursive: true)
                }
            } catch {
                // Best-effort cleanup.

            }
        }

        private const GenericConstraintSource string = `package Generic

interface IGen {
    func Pick[T class](p T?, q string?) T?;
}

class Gen {
    func Pick[T class](p T?, q string?) T? {
        return p
    }
}
`

        private const GenericConstraintConsumerSource string = `#nullable enable
public static class Use {
    public static void Run(Generic.IGen face, Generic.Gen gen) {
        face.Pick<string?>(null, null);
        gen.Pick<string?>(null, null);
    }
}
`

        private const ContractSource string = `package Contract

import System.Threading.Tasks

class Token {}

interface IStore {
    func LoadAsync() Task[Token?];
}

delegate Loader() Token?;
`

        private const AssertingConsumerSource string = `package Consumer

import Contract

async func Read(store IStore) Token {
    let loaded = await store.LoadAsync()
    return loaded!!
}

func Call(loader Loader) Token {
    let loaded = loader()
    return loaded!!
}
`

        private const InterfaceMisuseSource string = `package Consumer

import Contract

async func Read(store IStore) Token {
    return await store.LoadAsync()
}
`

        private const DelegateMisuseSource string = `package Consumer

import Contract

func Call(loader Loader) Token {
    return loader()
}
`
    }
}

/// One type shape: its G# spelling (also the expected imported spelling)
/// and its C# spelling.
internal data class Issue4988Shape(GSharp string, CSharp string)

internal enum Issue4988PositionKind {
    Return,
    Parameter,
    Property,
    Field,
    Event
}

/// One signature position to check. A `TypeName` of `*` searches
/// every type (extension methods and conversions live on a compiler-chosen
/// host type). `Selector` picks among constructors by their first parameter's
/// name, among `*` methods by their return type's name, and among other
/// overloads by their first parameter's type name.
internal data class Issue4988Position(
    Key string,
    TypeName string,
    Kind Issue4988PositionKind,
    Member string,
    Index int32,
    Selector string?,
    Expected string,
    ExpectedBytes string?
)

/// A position resolved in one assembly.
internal data class Issue4988ResolvedPosition(
    ClrType Type,
    Declaration ICustomAttributeProvider,
    Enclosing MemberInfo,
    ReadSymbol() -> TypeSymbol
)
