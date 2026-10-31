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
/// | 28 | `set => Sink(value);` behind a widened constructor store | `Sink(Node value)` stays non-null, the setter passes a `Node?` | `Sink` widens (the setter's `value` is the property) |
/// | 29 | linked `Frame.cs` compiled by A and B; C passes `null!` through B's emitted reference assembly | A and B translate the linked file differently | A, B and C agree: `parent Frame?` |
/// | 30 | linked `Forward(Node p) => Sink(p)` compiled by A and B with `Sink` in different files; C passes `null!` to A's `Forward` through A's emitted reference | A emits `Sink(p)`, B emits `Sink(p!!)` | A and B emit the same linked file |
/// | 31 | generated `override Payload Read(string text) => null;` and a block-bodied generated getter `return null;` | `nil` (GS0155) | `default(Payload)` |
/// | 32 | generated `Enum.Parse(value: null, enumType: typeof(DayOfWeek))` (named argument) | `nil` (GS0154) | `default(string)` |
/// | 33 | A and B link `Sink.cs`; only B gets null evidence; a consumer queries A's emitted-reference parameter | consumer bridges `p!!` | no bridge (the assembly key resolves back to the source aliases) |
/// | 34 | `Node Run() => Identity(null!)` and `Node Read() => stored` after a null-seeded store | returns assert `!!` | the returns widen |
/// | 35 | `Run(Node p) => p.Ignore()` (extension, no arguments) + `Run(null!)` | `p!!` receiver throws | `Ignore`'s `this` parameter widens |
/// | 36 | generated override `T Read()` of `Base<T> where T : class` returning `null` | `nil` | `default(T)` |
/// | 37 | A and B link `State.cs`, only B stores null; C's `Node Read() => State.Stored` through A's emitted reference | `Stored!!` throws | the return widens (alias at every step) |
/// | 38 | `get => stored` / `get { return stored; }` / `Node Value => stored` behind a widened store | getter asserts `stored!!` | getter and property widen |
/// | 39 | `record Entry(Node Item)` + `new Entry(null!)` + `Read(Entry e) => e.Item` | `e.Item!!` throws | `Read` widens |
/// | 40 | emitted-reference `record Key(string Value) : IKey`; a consumer forwards a widened parameter into `new Key(p)` | no bridge | bridged: the fixed property keeps the parameter non-null |
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
        let printed = TranslateEnabled(
            "the virtual parameter keeps its non-null signature, so the hand-authored `Depth(null!)` stays `Depth(nil)`, which is GS0154 since #4316 (widening across a virtual hierarchy is #5524)",
            ("Walker.cs", `
namespace Demo
{
    public class Node { }
    public class Walker
    {
        public virtual int Depth(Node parent) => parent.GetHashCode();
        public int Run() => Depth(null!);
    }
}`)
        )
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

    /// Row 28.
    @Fact
    func CustomSetterCall_FollowsThePromotedProperty() {
        let printed = TranslateEnabled(("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        public Holder(Node node) { Stored = node; }
        public Node Stored { get; set => Sink(value); }
        private static void Sink(Node target) { }
        public static Holder Make() => new Holder(null!);
    }
}`))
        Assert.Contains("Sink(target Node?)", printed[0])
        Assert.DoesNotContain("value!!", printed[0])
    }

    /// Row 29: the three-project linked-source case.
    @Fact
    func LinkedSourceCompiledByTwoProjects_NullThroughOneEmittedReference_DecidesTheSameInBoth() {
        let a = Compile("A", NullableContextOptions.Enable, nil, ("Frame.cs", FrameSource))
        let b = Compile("B", NullableContextOptions.Enable, nil, ("Frame.cs", FrameSource))
        let image = System.IO.MemoryStream()
        Assert.True(b.Emit(image).Success)
        image.Position = 0
        let c = Compile("C", NullableContextOptions.Enable, MetadataReference.CreateFromStream(image), ("Tag.cs", `
namespace Demo
{
    public class Tag : Frame
    {
        private Tag(Header header) : base(header, null!) { }
    }
}`))
        let siblings = []CSharpCompilation{a, b, c}
        let printed = List[string]()
        for compilation in[]CSharpCompilation{a, b} {
            let tree = compilation.SyntaxTrees.Single()
            let context = TranslationContext(compilation, compilation.GetSemanticModel(tree), tree.FilePath, siblings)
            printed.Add(
                GSharpPrinter.Print(
                    CSharpToGSharpTranslator().TranslateDocument(
                        LoadedDocument(tree.FilePath, tree, compilation.GetSemanticModel(tree)),
                        context
                    )
                )
            )
        }
        Assert.Contains("parent Frame?", printed[0])
        Assert.Equal(printed[0], printed[1])
    }

    /// Row 30: an alias is followed at every step of a chain, not only at its end.
    @Fact
    func LinkedForwarder_WithSeparatelyDeclaredSinks_DecidesTheSameInBoth() {
        let forward = `
namespace Demo
{
    public class Node { }
    public static class Forwarder
    {
        public static void Forward(Node p) => Sinks.Sink(p);
    }
}`
        let a = Compile("A", NullableContextOptions.Enable, nil, ("Forward.cs", forward), ("SinkA.cs", `
namespace Demo
{
    public static class Sinks { public static void Sink(Node value) { } }
}`))
        let b = Compile("B", NullableContextOptions.Enable, nil, ("Forward.cs", forward), ("SinkB.cs", `
namespace Demo
{
    public static class Sinks { public static void Sink(Node value) { } }
}`))
        let image = System.IO.MemoryStream()
        Assert.True(a.Emit(image).Success)
        image.Position = 0
        let c = Compile("C", NullableContextOptions.Enable, MetadataReference.CreateFromStream(image), ("Go.cs", `
namespace Demo
{
    public static class Go { public static void Run() => Forwarder.Forward(null!); }
}`))
        let siblings = []CSharpCompilation{a, b, c}
        let printed = List[string]()
        for compilation in[]CSharpCompilation{a, b} {
            let tree = compilation.SyntaxTrees.First((t SyntaxTree) -> t.FilePath == "Forward.cs")
            let context = TranslationContext(compilation, compilation.GetSemanticModel(tree), tree.FilePath, siblings)
            printed.Add(
                GSharpPrinter.Print(
                    CSharpToGSharpTranslator().TranslateDocument(
                        LoadedDocument(tree.FilePath, tree, compilation.GetSemanticModel(tree)),
                        context
                    )
                )
            )
        }
        Assert.Contains("Forward(p Node?)", printed[0])
        Assert.Equal(printed[0], printed[1])
    }

    /// Row 31.
    @Fact
    func GeneratedArrowAndGetterReturningNull_EmitDefault() {
        let printed = TranslateEnabled(("Base.cs", `
namespace Demo
{
    public sealed class Payload { }
    public abstract class Converter
    {
        public abstract Payload Read(string text);
        public abstract Payload Item { get; }
    }
}`), ("Derived.cs", `// <auto-generated/>
namespace Demo
{
    public sealed class PayloadConverter : Converter
    {
        public override Payload Read(string text) => null;
        public override Payload Item { get { return null; } }
    }
}`))
        Assert.Contains("default(Payload)", printed[1])
        Assert.DoesNotContain("nil", printed[1])
    }

    /// Row 32.
    @Fact
    func GeneratedNamedNullArgument_EmitsDefaultOfParameterType() {
        let printed = TranslateEnabled(("Caller.cs", `// <auto-generated/>
using System;
namespace Demo
{
    public static class Caller
    {
        public static object Run() => Enum.Parse(value: null, enumType: typeof(DayOfWeek));
    }
}`))
        Assert.Contains("default(string)", printed[0])
    }

    /// Row 33.
    @Fact
    func EmittedReferenceQuery_ResolvesToLinkedSourceAliases() {
        let sink = `
namespace Demo
{
    public class Node { }
    public static class Library { public static void Sink(Node value) { } }
}`
        let a = Compile("A", NullableContextOptions.Enable, nil, ("Sink.cs", sink))
        let b = Compile("B", NullableContextOptions.Enable, nil, ("Sink.cs", sink), ("Feed.cs", `
namespace Demo
{
    public static class Feed { public static void Run() => Library.Sink(null!); }
}`))
        let image = System.IO.MemoryStream()
        Assert.True(a.Emit(image).Success)
        image.Position = 0
        let c = Compile("C", NullableContextOptions.Enable, MetadataReference.CreateFromStream(image), ("Forward.cs", `
namespace Demo
{
    public static class Forwarder
    {
        public static void Forward(Node? p) { Library.Sink(p); }
    }
}`))
        let tree = c.SyntaxTrees.Single()
        let context = TranslationContext(c, c.GetSemanticModel(tree), tree.FilePath, []CSharpCompilation{a, b, c})
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                LoadedDocument(tree.FilePath, tree, c.GetSemanticModel(tree)),
                context
            )
        )
        Assert.DoesNotContain("p!!", printed)
    }

    /// Row 34.
    @Fact
    func CallResultAndStorageRead_FollowThePromotedValue() {
        let printed = TranslateEnabled(("Pass.cs", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        private Node stored;
        public Holder(Node node) { stored = node; }
        public Node Read() => stored;
        public static Node Identity(Node node) => node;
        public static Node Run() => Identity(null!);
        public static Holder Make() => new Holder(null!);
    }
}`))
        Assert.Contains("func Run() Node?", printed[0])
        Assert.Contains("func Read() Node?", printed[0])
    }

    /// Row 35.
    @Fact
    func ReducedExtensionReceiverWithoutArguments_PromotesTheThisParameter() {
        let printed = TranslateEnabled(("Relay.cs", `
namespace Demo
{
    public class Node { }
    public static class Ext
    {
        public static int Ignore(this Node receiver) => 0;
    }
    public static class Relay
    {
        public static int Run(Node p) => p.Ignore();
        public static int Go() => Run(null!);
    }
}`))
        Assert.DoesNotContain("p!!", printed[0])
        Assert.Contains("receiver Node?", printed[0])
    }

    /// Row 36.
    @Fact
    func GeneratedOverrideOfClassConstrainedTypeParameter_ReturningNull_EmitsDefaultOfT() {
        let printed = TranslateEnabled(("Base.cs", `
namespace Demo
{
    public abstract class Converter<T> where T : class
    {
        public abstract T Read(string text);
    }
}`), ("Derived.cs", `// <auto-generated/>
namespace Demo
{
    public sealed class PayloadConverter<T> : Converter<T> where T : class
    {
        public override T Read(string text) => null;
    }
}`))
        Assert.Contains("default(T)", printed[1])
    }

    /// Row 37.
    @Fact
    func AssemblyKeyedIntermediate_ResolvesToLinkedSourceAtEveryStep() {
        let state = `
namespace Demo
{
    public class Node { }
    public static class State
    {
        public static Node Stored;
        public static void Set(Node n) { Stored = n; }
    }
}`
        let a = Compile("A", NullableContextOptions.Enable, nil, ("State.cs", state))
        let b = Compile("B", NullableContextOptions.Enable, nil, ("State.cs", state), ("Feed.cs", `
namespace Demo
{
    public static class Feed { public static void Run() => State.Set(null!); }
}`))
        let image = System.IO.MemoryStream()
        Assert.True(a.Emit(image).Success)
        image.Position = 0
        let c = Compile("C", NullableContextOptions.Enable, MetadataReference.CreateFromStream(image), ("Read.cs", `
namespace Demo
{
    public static class Reader { public static Node Read() => State.Stored; }
}`))
        let tree = c.SyntaxTrees.Single()
        let context = TranslationContext(c, c.GetSemanticModel(tree), tree.FilePath, []CSharpCompilation{a, b, c})
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                LoadedDocument(tree.FilePath, tree, c.GetSemanticModel(tree)),
                context
            )
        )
        Assert.DoesNotContain("Stored!!", printed)
        Assert.Contains("func Read() Node?", printed)
    }

    /// Row 38.
    @Fact
    func GettersAndExpressionBodiedProperties_FollowThePromotedStore() {
        let printed = TranslateEnabled(("Holder.cs", `
namespace Demo
{
    public class Node { }
    public class Holder
    {
        private Node stored;
        public Holder(Node node) { stored = node; }
        public Node Value => stored;
        public Node Block { get { return stored; } }
        public Node Arrow { get => stored; }
        public static Holder Make() => new Holder(null!);
    }
}`))
        Assert.Contains("Value Node?", printed[0])
        Assert.Contains("Block Node?", printed[0])
        Assert.Contains("Arrow Node?", printed[0])
        Assert.DoesNotContain("stored!!", printed[0])
    }

    /// Row 39.
    @Fact
    func PositionalRecordProperty_ReadThroughAnotherMember_FollowsTheParameter() {
        let printed = TranslateEnabled(("Entry.cs", `
namespace Demo
{
    public class Node { }
    public record Entry(Node Item);
    public static class Use
    {
        public static Entry Make() => new Entry(null!);
        public static Node Read(Entry e) => e.Item;
    }
}`))
        Assert.Contains("func Read(e Entry) Node?", printed[0])
        Assert.DoesNotContain("e.Item!!", printed[0])
    }

    /// Row 41: a local deconstructed from a promoted positional member.
    @Fact
    func DeconstructedLocalOfPromotedPositionalMember_IsAssertedOnDereference() {
        let printed = TranslateEnabled(("Entry.cs", `
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class Use
    {
        public static Entry Make() => new Entry(null!, 0);
        public static int Hash(Entry entry)
        {
            var (item, _) = entry;
            return item.GetHashCode();
        }
        public static int HashTyped(Entry entry)
        {
            (Node item, int id) = entry;
            return item.GetHashCode() + id;
        }
        public static int HashAll(System.Collections.Generic.List<Entry> entries)
        {
            var sum = 0;
            foreach ((Node item, int id) in entries)
            {
                sum += Take(item) + id;
            }
            return sum;
        }
        private static int Take(Node node) => node.GetHashCode();
    }
}`))
        Assert.DoesNotContain("item.GetHashCode()", printed[0])
        Assert.Contains("Take(item!!)", printed[0])
    }

    /// Row 40.
    @Fact
    func EmittedReferencePositionalRecordWithFixedProperty_IsNotTreatedAsWidened() {
        let library = Compile("Library", NullableContextOptions.Enable, nil, ("Key.cs", `
namespace Demo
{
    public interface IKey { string Value { get; } }
    public record Key(string Value) : IKey;
}`))
        let image = System.IO.MemoryStream()
        Assert.True(library.Emit(image).Success)
        image.Position = 0
        let consumer = Compile(
            "Consumer",
            NullableContextOptions.Enable,
            MetadataReference.CreateFromStream(image),
            ("Make.cs", `
namespace Demo
{
    public static class Make
    {
        public static Key Build(string p) => new Key(p);
        public static Key Go() => Build(null!);
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
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                LoadedDocument(tree.FilePath, tree, consumer.GetSemanticModel(tree)),
                context
            )
        )
        Assert.Contains("p!!", printed)
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
