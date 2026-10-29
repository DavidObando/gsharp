// <copyright file="Issue5508NullArgumentPromotionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #5508: a C# `null!` (or `null`) ARGUMENT is the author saying "null
/// goes here". Before #4316 gsc accepted `nil` at a non-nullable class
/// parameter, so cs2gs could keep the parameter `Frame`; after #4316 that is
/// GS0155/GS0154 and, through constructor resolution, GS0214.
///
/// The shared decision is `ShouldPromoteToNullableReference` consulting
/// `ObliviousNullabilityAnalyzer.IsNullArgumentTarget`. Contract, one row per
/// shape (old output -> new output):
///
/// | # | C# (nullable enabled) | old | new |
/// | - | --- | --- | --- |
/// | 1 | `: base(header, null!)` into `Frame(Header, Frame parent)` | `parent Frame` | `parent Frame?` |
/// | 2 | `M(null)` into `M(Frame parent)` | `parent Frame` | `parent Frame?` |
/// | 3 | `Parent = parent;` after row 1/2 | `Parent Frame` | `Parent Frame?` (a bare `!!` would throw on the stored null) |
/// | 4 | `Sub(h, Frame p) : base(h, p)` + `new Sub(h, null!)` | both `Frame` | both `Frame?` |
/// | 5 | no call passes null | `parent Frame` | unchanged (discrimination) |
/// | 6 | `Parent = parent!;` (author asserts non-null) | unchanged | unchanged: no forwarding |
/// | 7 | `virtual M(Frame parent)` called with `null!` | `parent Frame` | unchanged: overrides keep the base type |
/// | 8 | `null!` passed from a SIBLING project | `parent Frame` | `parent Frame?` |
/// | 10 | `nameof(parameter)` beside a `null` argument | translator crash (default argument array) | unchanged output |
/// | 11 | `return null;` in a generated override of `Payload Read()` | `return nil` (GS0155) | `return default(Payload)` |
/// | 12 | `Uri.EscapeDataString(null)` in a generated file (imported non-null parameter) | `nil` (GS0154) | `default(string)` |
/// | 13 | `string.IsNullOrEmpty(null)` (`string?` parameter), a widened parameter, and `null` / `null!` into a non-null slot in hand-authored code | `nil` | unchanged: `nil` |
/// | 14 | `i.Filter = null;` in a generated file into a property #3676 widens | `nil` | unchanged: `nil` |
/// | 15 | `Collect(Node? model)` called with `model: null`, and a `when model != null` call of `Follow(Node model)` | `Follow(model Node)` | unchanged: `Follow(model Node)` (an annotated source is not a forward) |
/// | 16 | `return null;` in a generated override of `Payload[] Read()` | `return nil` (GS0155) | `return default([]Payload)` |
/// | 17 | `record Key(string Value) : IKey` + `new Key(null!)` (interface fixes the property) | unchanged | unchanged: the positional parameter keeps the property's contract |
/// | 18 | `Box<T>(T value)` + `new Box<string>(null!)` | unchanged | unchanged: eligibility is read off the declaration, not the substituted `string` |
/// | 19 | `null!` passed from a sibling project bound through its EMITTED reference assembly | `parent Frame` | `parent Frame?` |
/// | 20 | two unrelated projects declare the same `Demo.Frame(Header, Frame)`; only one passes `null!` | both widen | only the calling project's declaration widens |
/// | 21 | `static Node Identity(Node node) => node;` + `Identity(null!)` | `node Node` and `Node` (a `node!!` return bridge throws) | `node Node?` and `Node?` |
/// | 22 | `Run(Node n, Node value) => n.Keep(value)` (extension) + `Run(n, null!)` | `Keep`'s `value` stays `Node`; `value!!` throws | `Keep`'s `value Node?` |
/// | 23 | `Task<Node> Pass(Task<Node> task) => task;` + `Pass(null!)` | unchanged | unchanged: a task reference has no widened spelling in the return rendering |
/// | 24 | `set => stored = value;` behind a widened constructor store | field `stored Node` | field and property `Node?` |
/// | 25 | two versions of assembly `Lib` declare the same `Demo.Frame(Header, Frame)`; only v2 is called with `null!` | v1 widens too | only v2 widens (full assembly identity in the key) |
/// | 26 | `M(default(int))` into `M(object value)` | would widen `value` | unchanged: a value-type default is no null |
/// | 27 | `Library.Sink(p)` from a consumer whose `p` receives `null!`; `Sink` is bound through the emitted reference assembly | `Sink(p!!)` throws | `Sink(p)` |
/// | 9 | `Parent = parent;` into a `virtual` property | `Parent Node` | unchanged: overrides keep the base type |
open class Issue5508NullArgumentPromotionTests {
    private const FrameSource string = `
namespace Demo
{
    public class Header { }
    public abstract class Frame
    {
        public Frame(Header header, Frame parent) { Header = header; Parent = parent; }
        public Header Header { get; }
        public virtual int Version => Parent.Version.GetHashCode();
        protected Frame Parent { get; }
    }
}`

    /// Row 1 (Oahu `Id3Tag.cs:8`).
    @Fact
    func NullForgivenConstructorArgument_PromotesParameter() {
        let printed = TranslateEnabled(("Frame.cs", FrameSource), ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        private Tag(Header header) : base(header, null!) { }
        public static Tag Create(Header header) => new Tag(header);
    }
}`))
        Assert.Contains("parent Frame?", printed[0])
        Assert.Contains("base(header, nil)", printed[1])
    }

    /// Row 3: the stored slot must follow, or the bridge would throw.
    @Fact
    func PromotedParameter_StoredIntoProperty_PromotesProperty() {
        let printed = TranslateEnabled(("Frame.cs", FrameSource), ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        private Tag(Header header) : base(header, null!) { }
    }
}`))
        Assert.Contains("prop Parent Frame?", printed[0].Replace("  ", " "))
    }

    /// Row 2.
    @Fact
    func PlainNullMethodArgument_PromotesParameter() {
        let printed = TranslateEnabled(("Walker.cs", `
namespace Demo
{
    public class Node { }
    public static class Walker
    {
        public static int Depth(Node start, Node parent) => start == parent ? 0 : 1;
        public static int Run(Node n) => Depth(n, null);
    }
}`))
        Assert.Contains("parent Node?", printed[0])
        Assert.DoesNotContain("start Node?", printed[0])
    }

    /// Row 4: forwarding through a subclass constructor.
    @Fact
    func ForwardedParameter_PromotesCalleeParameter() {
        let printed = TranslateEnabled(("Frame.cs", FrameSource), ("Sub.cs", `
namespace Demo
{
    public class Sub : Frame
    {
        public Sub(Header h, Frame p) : base(h, p) { }
    }
    public static class Make
    {
        public static Sub Root(Header h) => new Sub(h, null!);
    }
}`))
        Assert.Contains("parent Frame?", printed[0])
        Assert.Contains("p Frame?", printed[1])
    }

    /// Row 5: evidence-driven, not a blanket widening.
    @Fact
    func NoNullArgument_StaysNonNullable() {
        let printed = TranslateEnabled(("Frame.cs", FrameSource), ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        public Tag(Header header, Frame parent) : base(header, parent) { }
    }
}`))
        Assert.Contains("parent Frame", printed[0])
        Assert.DoesNotContain("parent Frame?", printed[0])
        Assert.DoesNotContain("Parent Frame?", printed[0])
    }

    /// Row 6: `parent!` is the author's assertion, not a forward.
    @Fact
    func NullForgivenForward_DoesNotPromoteStoredSlot() {
        let printed = TranslateEnabled(("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        public Holder(Node node) { Stored = node!; }
        public Node Stored { get; }
        public static Holder Make() => new Holder(null!);
    }
}`))
        Assert.Contains("node Node?", printed[0])
        Assert.DoesNotContain("Stored Node?", printed[0].Replace("  ", " "))
    }

    /// Row 7: a virtual member does not own a signature its overrides share.
    @Fact
    func VirtualMethodParameter_IsNotPromoted() {
        let printed = TranslateEnabled(("Walker.cs", `
namespace Demo
{
    public class Node { }
    public class Walker
    {
        public virtual int Depth(Node parent) => parent.GetHashCode();
        public int Run() => Depth(null!);
    }
}`))
        Assert.DoesNotContain("parent Node?", printed[0])
    }

    /// Row 9: a virtual property is not repainted by forwarding either.
    @Fact
    func PromotedParameter_StoredIntoVirtualProperty_DoesNotPromoteProperty() {
        let printed = TranslateEnabled(("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        public Holder(Node node) { Stored = node; }
        public virtual Node Stored { get; }
        public static Holder Make() => new Holder(null!);
    }
}`))
        Assert.Contains("node Node?", printed[0])
        Assert.DoesNotContain("Stored Node?", printed[0].Replace("  ", " "))
    }

    /// Row 10: `nameof(node)` is an invocation SYNTAX with a parameter-named
    /// argument but binds to no call; the Oahu migration crashed on it.
    @Fact
    func NameofOfParameter_BesideNullArgument_DoesNotCrash() {
        let printed = TranslateEnabled(("Holder.cs", `
using System;
namespace Demo
{
    public class Node { }
    public class Holder
    {
        public Holder(Node node) { Name = nameof(node); Stored = node; }
        public string Name { get; }
        public Node Stored { get; }
        public static Holder Make() => new Holder(null!);
    }
}`))
        Assert.Contains("node Node?", printed[0])
    }

    /// Row 11 (`Issue3676GeneratedCodeNullabilityTests.
    /// GeneratedFileOverride_ReturningNull_KeepsBaseSignature`): the override
    /// cannot become `Payload?`, so the null goes in as `default(Payload)`.
    @Fact
    func GeneratedOverride_ReturningNull_EmitsDefaultOfDeclaredType() {
        let printed = TranslateEnabled(("Base.cs", `
namespace Demo
{
    public sealed class Payload { }
    public abstract class Converter
    {
        public abstract Payload Read(string text);
    }
}`), ("Derived.cs", `// <auto-generated/>
namespace Demo
{
    public sealed class PayloadConverter : Converter
    {
        public override Payload Read(string text)
        {
            return null;
        }
    }
}`))
        Assert.Contains("override func Read(text string) Payload", printed[1])
        Assert.DoesNotContain("Payload?", printed[1])
        Assert.Contains("return default(Payload)", printed[1])
        Assert.DoesNotContain("return nil", printed[1])
    }

    /// Row 12: a call into an imported parameter the metadata declares non-null.
    @Fact
    func NullArgumentToImportedNonNullParameter_EmitsDefaultOfParameterType() {
        let printed = TranslateEnabled(("Caller.cs", `// <auto-generated/>
using System;
namespace Demo
{
    public static class Caller
    {
        public static string Run() => Uri.EscapeDataString(null);
    }
}`))
        Assert.Contains("default(string)", printed[0])
    }

    /// Row 15 (Adr0169 GSA0005 parity, `RewriterClonePreservationAnalyzer`): a
    /// parameter that is ALREADY `T?` is neither a seed nor a forwarding source.
    @Fact
    func AnnotatedParameter_PassedNull_DoesNotWidenWhatItForwardsTo() {
        let printed = TranslateEnabled(("Walker.cs", `
namespace Demo
{
    public class Node { public int Id { get; } }
    public static class Walker
    {
        public static int Collect(Node? model, int depth)
        {
            if (model != null)
            {
                return Follow(model, depth);
            }
            return depth;
        }

        public static int Follow(Node model, int depth) => model.Id + depth;

        public static int Start() => Collect(model: null, depth: 0);
    }
}`))
        Assert.Contains("Follow(model Node, depth int32)", printed[0])
        Assert.DoesNotContain("model Node?, depth int32) int32 -> model", printed[0])
    }

    /// Row 14: a slot that a promotion widens keeps `nil` even in a generated file.
    @Fact
    func GeneratedFile_NullIntoWidenedSlot_StaysNil() {
        let printed = TranslateEnabled(("Item.cs", `// <auto-generated/>
namespace Demo
{
    public class Item
    {
        public string Filter { get; set; }
    }
    public static class Maker
    {
        public static Item Make()
        {
            var item = new Item();
            item.Filter = null;
            return item;
        }
    }
}`))
        Assert.Contains("Filter string?", printed[0])
        Assert.Contains("item.Filter = nil", printed[0])
        Assert.DoesNotContain("default(", printed[0])
    }

    /// Row 13: the discriminators. A `string?` parameter and a parameter this
    /// change widened both accept `nil`, so the literal stays `nil`.
    @Fact
    func NullArgumentToNullableSlot_StaysNil() {
        let printed = TranslateEnabled(
            "Round-trip only: the plain null into an imported non-null parameter is an explicit error by design.",
            ("Caller.cs", `
using System;
namespace Demo
{
    public class Node { }
    public static class Caller
    {
        public static int Depth(Node start, Node parent) => start == parent ? 0 : 1;
        public static bool Run(Node n) => string.IsNullOrEmpty(null) && Depth(n, null) == 0;
        public static string Plain() => Uri.EscapeDataString(null);
        public static string Forgiven() => Uri.EscapeDataString(null!);
    }
}`)
        )
        Assert.Contains("string.IsNullOrEmpty(nil)", printed[0])
        Assert.Contains("Depth(n, nil)", printed[0])

        Assert.Contains("EscapeDataString(nil)", printed[0])
        Assert.DoesNotContain("default(", printed[0])
    }

    /// Row 16: every non-nullable mapped shape takes the typed default.
    @Fact
    func GeneratedOverride_ReturningNullArray_EmitsDefaultOfArrayType() {
        let printed = TranslateEnabled(("Base.cs", `
namespace Demo
{
    public sealed class Payload { }
    public abstract class Converter
    {
        public abstract Payload[] Read(string text);
    }
}`), ("Derived.cs", `// <auto-generated/>
namespace Demo
{
    public sealed class PayloadConverter : Converter
    {
        public override Payload[] Read(string text)
        {
            return null;
        }
    }
}`))
        Assert.Contains("return default([]Payload)", printed[1])
    }

    /// Row 17: the positional parameter and its synthesized property are one declaration.
    @Fact
    func PositionalRecordParameter_WhoseInterfacePropertyIsFixed_IsNotPromoted() {
        let printed = TranslateEnabled(
            "Round-trip only: the interface fixes the property, so the null argument stays an explicit error (#5524).",
            ("Key.cs", `
namespace Demo
{
    public interface IKey { string Value { get; } }
    public record Key(string Value) : IKey;
    public static class Make
    {
        public static Key Empty() => new Key(null!);
    }
}`)
        )
        Assert.DoesNotContain("Value string?", printed[0])
    }

    /// Row 18: `Box<string>(string)` is a constructed view of a bare `T` parameter.
    @Fact
    func GenericConstructorParameter_BareTypeParameter_IsNotPromotedThroughTheSubstitution() {
        let printed = TranslateEnabled(("Box.cs", `
namespace Demo
{
    public class Box<T>
    {
        public Box(T value) { Value = value; }
        public T Value { get; }
    }
    public static class Make
    {
        public static Box<string> Empty() => new Box<string>(null!);
    }
}`))
        Assert.DoesNotContain("value T?", printed[0])
        Assert.DoesNotContain("Value T?", printed[0])
    }

    /// Row 19: the call is bound through the library's EMITTED reference assembly.
    @Fact
    func NullArgumentThroughEmittedReferenceAssembly_PromotesDeclaringProjectParameter() {
        let library = Compile("Library", NullableContextOptions.Enable, nil, ("Frame.cs", FrameSource))
        let image = System.IO.MemoryStream()
        Assert.True(library.Emit(image).Success)
        image.Position = 0
        let consumer = Compile(
            "Consumer",
            NullableContextOptions.Enable,
            MetadataReference.CreateFromStream(image),
            ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        private Tag(Header header) : base(header, null!) { }
    }
}`)
        )
        let tree = library.SyntaxTrees.Single()
        let context = TranslationContext(
            library,
            library.GetSemanticModel(tree),
            tree.FilePath,
            []CSharpCompilation{library, consumer}
        )
        let unit = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(tree.FilePath, tree, library.GetSemanticModel(tree)),
            context
        )
        Assert.Contains("parent Frame?", GSharpPrinter.Print(unit))
    }

    /// Row 20: an unrelated project with the same fully qualified declaration is not evidence.
    @Fact
    func SameDocumentationId_InUnrelatedProject_DoesNotWidenThisProjectsDeclaration() {
        let library = Compile("Library", NullableContextOptions.Enable, nil, ("Frame.cs", FrameSource))
        let other = Compile("Other", NullableContextOptions.Enable, nil, ("OtherFrame.cs", FrameSource), ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        private Tag(Header header) : base(header, null!) { }
    }
}`))
        let tree = library.SyntaxTrees.Single()
        let context = TranslationContext(
            library,
            library.GetSemanticModel(tree),
            tree.FilePath,
            []CSharpCompilation{library, other}
        )
        let unit = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(tree.FilePath, tree, library.GetSemanticModel(tree)),
            context
        )
        Assert.DoesNotContain("parent Frame?", GSharpPrinter.Print(unit))
    }

    /// Row 21: the returned parameter widens the return, so the bridge does not throw.
    @Fact
    func ReturnedPromotedParameter_PromotesTheReturn() {
        let printed = TranslateEnabled(("Pass.cs", `
namespace Demo
{
    public class Node { }
    public static class Pass
    {
        public static Node Identity(Node node) => node;
        public static Node Run() => Identity(null!);
    }
}`))
        Assert.Contains("func Identity(node Node?) Node?", printed[0])
        Assert.DoesNotContain("node!!", printed[0])
    }

    /// Row 22: a reduced extension call maps its parameters back to the declaration.
    @Fact
    func ForwardedIntoReducedExtensionParameter_PromotesTheExtensionParameter() {
        let printed = TranslateEnabled(("Relay.cs", `
namespace Demo
{
    public class Node { }
    public static class Ext
    {
        public static void Keep(this Node receiver, Node value) { }
    }
    public static class Relay
    {
        public static void Run(Node n, Node value) => n.Keep(value);
        public static void Go(Node n) => Run(n, null!);
    }
}`))
        Assert.Contains("value Node?", printed[0])
        Assert.DoesNotContain("value!!", printed[0])
        Assert.DoesNotContain("Keep(n, value)!!", printed[0])
    }

    /// Row 23.
    @Fact
    func TaskReferenceParameter_PassedNull_IsNotPromoted() {
        let printed = TranslateEnabled(
            "Round-trip only: a task reference has no widened spelling here, so the null stays an explicit error.",
            ("Pass.cs", `
using System.Threading.Tasks;
namespace Demo
{
    public class Node { }
    public static class Pass
    {
        public static Task<Node> Through(Task<Node> task) => task;
        public static Task<Node> Run() => Through(null!);
    }
}`)
        )
        Assert.DoesNotContain("Task[Node]?", printed[0])
    }

    /// Row 24.
    @Fact
    func CustomSetterStore_FollowsThePromotedProperty() {
        let printed = TranslateEnabled(("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        private Node stored;
        public Holder(Node node) { Stored = node; }
        public Node Stored { get => stored; set => stored = value; }
        public static Holder Make() => new Holder(null!);
    }
}`))
        Assert.Contains("Stored Node?", printed[0])
        Assert.Contains("stored Node?", printed[0])
        Assert.DoesNotContain("value!!", printed[0])
    }

    /// Row 25.
    @Fact
    func SameNamedAssemblyOfAnotherVersion_IsNotTheDeclaringProject() {
        let version1 = Compile(
            "Lib",
            NullableContextOptions.Enable,
            nil,
            ("Frame.cs", FrameSource),
            ("V.cs", "[assembly: System.Reflection.AssemblyVersion(\"1.0.0.0\")]")
        )
        let version2 = Compile(
            "Lib",
            NullableContextOptions.Enable,
            nil,
            ("Frame2.cs", FrameSource),
            ("V.cs", "[assembly: System.Reflection.AssemblyVersion(\"2.0.0.0\")]"),
            ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        private Tag(Header header) : base(header, null!) { }
    }
}`)
        )
        let tree = version1.SyntaxTrees.First()
        let context = TranslationContext(
            version1,
            version1.GetSemanticModel(tree),
            tree.FilePath,
            []CSharpCompilation{version1, version2}
        )
        let unit = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(tree.FilePath, tree, version1.GetSemanticModel(tree)),
            context
        )
        Assert.DoesNotContain("parent Frame?", GSharpPrinter.Print(unit))
    }

    /// Row 26.
    @Fact
    func BoxedValueTypeDefault_IsNotNullEvidence() {
        let printed = TranslateEnabled(("Boxer.cs", `
namespace Demo
{
    public static class Boxer
    {
        public static int Count(object value) => value.GetHashCode();
        public static int Run() => Count(default(int));
    }
}`))
        Assert.DoesNotContain("value object?", printed[0])
    }

    /// Row 27.
    @Fact
    func ForwardIntoSiblingEmittedReferenceAssembly_DoesNotBridgeWithAThrowingAssertion() {
        let library = Compile("Library", NullableContextOptions.Enable, nil, ("Sink.cs", `
namespace Demo
{
    public class Node { }
    public static class Library
    {
        public static void Sink(Node value) { }
        public static void Feed() => Sink(null!);
    }
}`))
        let image = System.IO.MemoryStream()
        Assert.True(library.Emit(image).Success)
        image.Position = 0
        let consumer = Compile(
            "Consumer",
            NullableContextOptions.Enable,
            MetadataReference.CreateFromStream(image),
            ("Forward.cs", `
namespace Demo
{
    public static class Forwarder
    {
        public static void Forward(Node p) { Library.Sink(p); }
        public static void Go() => Forward(null!);
    }
}`)
        )
        let tree = consumer.SyntaxTrees.Single()
        let context = TranslationContext(
            consumer,
            consumer.GetSemanticModel(tree),
            tree.FilePath,
            []CSharpCompilation{library, consumer}
        )
        let unit = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(tree.FilePath, tree, consumer.GetSemanticModel(tree)),
            context
        )
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("Forward(p Node?)", printed)
        Assert.DoesNotContain("p!!", printed)
    }

    /// Row 8: the null argument lives in another project of the run.
    @Fact
    func NullArgumentFromSiblingProject_PromotesDeclaringProjectParameter() {
        let library = Compile("Library", NullableContextOptions.Enable, nil, ("Frame.cs", FrameSource))
        let consumer = Compile("Consumer", NullableContextOptions.Enable, library.ToMetadataReference(), ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        private Tag(Header header) : base(header, null!) { }
    }
}`))
        let tree = library.SyntaxTrees.Single()
        let context = TranslationContext(
            library,
            library.GetSemanticModel(tree),
            tree.FilePath,
            []CSharpCompilation{library, consumer}
        )
        let unit = CSharpToGSharpTranslator().TranslateDocument(
            LoadedDocument(tree.FilePath, tree, library.GetSemanticModel(tree)),
            context
        )
        Assert.Contains("parent Frame?", GSharpPrinter.Print(unit))
    }

    private func Compile(
        name string,
        nullable NullableContextOptions,
        reference MetadataReference?,
        sources ...(Path string, Source string)
    ) CSharpCompilation {
        let trees = sources.Select(
            (source(Path string, Source string)) -> CSharpSyntaxTree.ParseText(
                source.Source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: source.Path
            )
        )
            .ToArray()
        var references = CSharpProjectLoader.RuntimeReferences().ToList()
        if reference != nil {
            references.Add(reference)
        }
        return CSharpCompilation.Create(
            name,
            trees,
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(nullable)
        )
    }

    private func TranslateEnabled(sources ...(Path string, Source string))[]string -> TranslateEnabled(
        roundTripOnlyReason: nil,
        sources
    )

    private func TranslateEnabled(roundTripOnlyReason string?, sources ...(Path string, Source string))[]string {
        let trees = sources.Select(
            (source(Path string, Source string)) -> CSharpSyntaxTree.ParseText(
                source.Source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: source.Path
            )
        )
            .ToArray()
        let compilation = CSharpCompilation.Create(
            "Snippet",
            trees,
            CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let documents = trees.Select(
            (tree SyntaxTree) -> LoadedDocument(tree.FilePath, tree, compilation.GetSemanticModel(tree))
        )
            .ToArray()
        let printed = List[string]()
        for document in documents {
            let context = TranslationContext(
                compilation,
                document.SemanticModel,
                document.FilePath,
                []CSharpCompilation{compilation}
            )
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            printed.Add(GSharpPrinter.Print(unit))
        }
        let result RoundTripResult? = if roundTripOnlyReason == nil {
            TranslationTestValidation.AssertBinds(printed.ToArray())
        } else {
            TranslationTestValidation.ValidateRoundTripOnly(printed[0], roundTripOnlyReason)
        }
        Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + string.Join(`
----
`, printed))
        return printed.ToArray()
    }
}
