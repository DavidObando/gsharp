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
/// | 12 | `Uri.EscapeDataString(null)` (imported non-null parameter) | `nil` (GS0154) | `default(string)` |
/// | 13 | `string.IsNullOrEmpty(null)` (`string?` parameter) and a widened parameter | `nil` | unchanged: `nil` |
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
        let printed = TranslateEnabled(("Caller.cs", `
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

    /// Row 13: the discriminators. A `string?` parameter and a parameter this
    /// change widened both accept `nil`, so the literal stays `nil`.
    @Fact
    func NullArgumentToNullableSlot_StaysNil() {
        let printed = TranslateEnabled(("Caller.cs", `
using System;
namespace Demo
{
    public class Node { }
    public static class Caller
    {
        public static int Depth(Node start, Node parent) => start == parent ? 0 : 1;
        public static bool Run(Node n) => string.IsNullOrEmpty(null) && Depth(n, null) == 0;
    }
}`))
        Assert.Contains("string.IsNullOrEmpty(nil)", printed[0])
        Assert.Contains("Depth(n, nil)", printed[0])
        Assert.DoesNotContain("default(", printed[0])
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
