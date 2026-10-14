// <copyright file="DocCommentAttachmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import Xunit

/// ADR-0179 phase 7b regression suite: formatted output must still COMPILE.
///
/// The defect that produced this file is the reason it does not test
/// idempotence. `gsfmt` split the accessibility modifier off `init` — emitting
/// `private`, a blank line, then `init(...)` — which detaches the preceding
/// `///` block from the declaration it documents and makes gsc report GS0227
/// "documentation comment is not attached to a declaration". That output was a
/// perfectly STABLE fixed point: `gsfmt --check` over all 3,905 files of the
/// migrated tree was clean, and every `Cs2Gs.Tests` assertion still passed.
/// It just did not compile, and six of the eight PR-guard apps failed on it.
///
/// The lesson, and the contract of this file: a formatter invariant that only
/// says "formatting twice changes nothing" cannot see a fixed point that is the
/// WRONG one. These tests therefore bind and emit the formatted text and assert
/// on the diagnostics, which is the property the gate actually depends on.
class DocCommentAttachmentTests {
    /// Formatting a documented member must not detach its `///` block:
    /// the formatted text has to bind and emit without GS0227.
    /// @param name The shape's name, for test output.
    /// @param source The source to format and then compile.
    /// @param keyword The declaration keyword; unused here, see the sibling test.
    @Theory
    @MemberData("DocumentedMembers")
    func FormattedDocumentedMember_CompilesWithoutFloatingDocComment(name string, source string, keyword string) {
        let result = GSharpFormatter.Format(SourceText.From(source, name + ".gs"))
        Assert.Empty(result.Diagnostics)
        let formatted = result.Text!!.ToString()
        let diagnostics = CompileDiagnostics(formatted, name)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == FloatingDocumentationComment)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
    }

    /// The structural half of the same property, asserted directly so a failure
    /// names the cause rather than only the symptom: the line right after the
    /// `///` block must carry the declaration keyword. Asserting on the
    /// KEYWORD rather than merely on "the next line is not blank" is what makes
    /// this catch the real defect — the split emitted `private` on that line and
    /// pushed `init` past a blank line, so a non-blank check passes on output
    /// that does not compile.
    /// @param name The shape's name, for test output.
    /// @param source The source to format.
    /// @param keyword The declaration keyword that must stay on the documented line.
    @Theory
    @MemberData("DocumentedMembers")
    func FormattedDocumentedMember_KeepsDeclarationOnTheDocumentedLine(name string, source string, keyword string) {
        let result = GSharpFormatter.Format(SourceText.From(source, name + ".gs"))
        Assert.Empty(result.Diagnostics)
        let lines = result.Text!!.ToString().Split('\n')
        var documented = 0
        for var i = 0; i < lines.Length - 1; i++ {
            if !lines[i].TrimStart().StartsWith("///", StringComparison.Ordinal) {
                continue
            }
            documented++
            Assert.True(
                lines[i + 1].Contains(keyword, StringComparison.Ordinal),
                "'$name': the line after the doc comment is '${lines[i + 1]}', which does not carry " +
                    "'$keyword' — the declaration has been split away from the comment that " +
                    (`documents it.
` + "${result.Text}")
            )
        }
        Assert.Equal(1, documented)
    }

    shared {
        /// The diagnostic a detached `///` block produces.
        private const FloatingDocumentationComment string = "GS0227"

        /// Gets one documented member per declaration keyword that can carry an
        /// accessibility modifier. Each shape needs a PRECEDING member in the same
        /// type: the break the formatter inserts is a member boundary, so a lone
        /// documented declaration never reproduced the defect.
        func DocumentedMembers() TheoryData[string, string, string] {
            let data = TheoryData[string, string, string]()
            for shape in Shapes() {
                data.Add(shape.Name, shape.Source, shape.Keyword)
            }
            return data
        }

        /// Binds and emits [`formatted`](paramref) and returns every
        /// diagnostic the compiler produced. Emission goes to a
        /// (cref:MemoryStream) rather than to disk, and it is the emit path
        /// specifically because `DocumentationValidator` — the only thing that
        /// reports GS0227 — runs there and nowhere else.
        private func CompileDiagnostics(formatted string, name string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(formatted, name + ".gs"))
            let compilation = Compilation(tree)
            using let pe = MemoryStream()
            return compilation.Emit(pe, pdbStream: nil, refStream: nil, docStream: nil).Diagnostics
        }

        /// The shapes. `init` is the one that regressed, and every accessibility
        /// modifier regressed with it, so all three are covered rather than one;
        /// the rest are the sibling declaration keywords, probed here so that the
        /// next node whose `Span` forgets its own modifiers is caught by this
        /// file rather than by the nightly gate.
        private func Shapes() sequence[(Name string, Source string, Keyword string)] {
            yield Shape("private init", Member("private init(a string, b int32) { }"), "init")
            yield Shape("internal init", Member("internal init(a string, b int32) { }"), "init")
            yield Shape("public init", Member("public init(a string, b int32) { }"), "init")
            yield Shape(
                "private convenience init",
                Member("private convenience init(a string, b int32) { init(a) }"),
                "convenience init"
            )
            yield Shape("private func", Member("private func Helper() int32 -> 1"), "func")
            yield Shape("private prop", Member("private prop Value int32 -> 1"), "prop")
            yield Shape("private var", Member("private var field int32 = 0"), "var")
            yield Shape("private let", Member("private let bound int32 = 0"), "let")
            yield Shape("private class", Member("private class Nested { }"), "class")
            yield Shape("private struct", Member("private struct NestedStruct { }"), "struct")
            yield Shape("private interface", Member("private interface INested { }"), "interface")
            yield Shape("private enum", Member("private enum NestedEnum { A }"), "enum")
            yield Shape("deinit", Member("deinit { }"), "deinit")
        }

        /// Wraps one documented member in a type that already has a member before
        /// it, which is what makes the member boundary the formatter breaks at
        /// exist at all.
        private func Member(declaration string) string -> "package P\n" +
            "\n" +
            "class T {\n" +
            "    init(seed string) { }\n" +
            "\n" +
            "    /// Documents the member below.\n" +
            "    " +
            declaration +
            "\n" +
            "}\n"

        private func Shape(name string, source string, keyword string)(Name string, Source string, Keyword string) -> (
            name,
            source,
            keyword
        )
    }
}
