// <copyright file="Adr0192PartialMethodsBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0192 / issue #4301: binder- and emit-layer tests for partial methods.
/// These exercise <c>PartialMethodMerger</c>, the member-level pre-pass that
/// runs right after ADR-0144's <c>PartialTypeMerger</c> and collapses each
/// partial method's declaring and implementing parts into one declaration.
/// <para>
/// The load-bearing assertions are the metadata ones: a partial method must
/// emit as exactly ONE MethodDef, and an attribute written on the
/// <em>declaring</em> part must land on it. That pair is what makes the feature
/// usable by ADR-0145's generator host for the <c>[GeneratedRegex]</c> shape
/// (issue #4301), where the user writes the attributed signature and the
/// generator writes the body.
/// </para>
/// </summary>
public class Adr0192PartialMethodsBinderTests
{
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Successful merges — compile, run, and check the emitted metadata
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PartialMethodSplitAcrossTwoFiles_MergesAndRuns()
    {
        // The canonical scenario: a hand-written file declares the signature,
        // a second file (which a generator would have produced under obj/)
        // supplies the body.
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System

partial class Greeter {
    partial func Greet(name string) string;
}
",
            "Greeter.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Greeter {
    partial func Greet(name string) string {
        return ""hello, "" + name
    }
}

let g = Greeter()
System.Console.WriteLine(g.Greet(""world""))
",
            "Greeter.g.gs"));

        var output = CompileLoadInvokeCaptureStdout(
            new[] { declaringFile, implementingFile },
            "Adr0192-TwoFiles");
        Assert.Contains("hello, world", output);
    }

    [Fact]
    public void MatchingAsyncPartialMethod_MergesWithoutFalselyReportingGS0611()
    {
        // Round-7 regression: the semantic signature-binding check
        // (ValidateMergedPartialMethodSignatureBinding) originally compared
        // a raw `bindTypeClause` result for the declaring part's return type
        // against the implementing side's ALREADY async-wrapped
        // `Task[int32]` — a spurious mismatch on every matching-async
        // partial method, not just a mismatched one. Both parts here
        // consistently declare `async func … int32`, which must merge and
        // run clean.
        var diagnostics = Compile(@"package App
import System.Threading.Tasks

partial class A {
    partial async func F() int32;
}

partial class A {
    partial async func F() int32 { return 1 }
}
");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1b. Cross-file import scope — declaring/implementing parts bind against
    // their OWN file's imports, not each other's (ADR-0192 §C/§G)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void DeclaringPartAnnotation_BindsAgainstTheDeclaringFilesOwnImports()
    {
        // Positive case: the declaring file imports System.Diagnostics and
        // uses it in the ANNOTATION on the declaring part; the implementing
        // file imports System.Text and uses it, unqualified, in the BODY. The
        // two files' import sets are genuinely disjoint (neither imports the
        // other's namespace), so this only compiles if the merger truly kept
        // each half bound to its own tree rather than merging into one shared
        // scope.
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System.Diagnostics

partial class Widget {
    @Conditional(""DEBUG"")
    partial func Describe() string;
}
",
            "Widget.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System.Text

partial class Widget {
    partial func Describe() string {
        let sb = StringBuilder()
        sb.Append(""built"")
        return sb.ToString()
    }
}

let t = typeof(Widget)
let m = t.GetMethod(""Describe"")
System.Console.WriteLine(m!!.GetCustomAttributes(typeof(System.Diagnostics.ConditionalAttribute), false).Length)

let w = Widget()
System.Console.WriteLine(w.Describe())
",
            "Widget.g.gs"));

        var output = CompileLoadInvokeCaptureStdout(
            new[] { declaringFile, implementingFile },
            "Adr0192-CrossFileImports");
        Assert.Contains("1", output);
        Assert.Contains("built", output);
    }

    [Fact]
    public void DeclaringPartAnnotation_DoesNotLeakTheImplementingFilesImports()
    {
        // Negative ("no leak") twin: the SAME annotation shape as above, but
        // System.Diagnostics is now imported ONLY by the implementing file —
        // the declaring file that actually carries `@Conditional(...)` has no
        // matching import. If the merger's tree-retention were broken and the
        // declaring part's annotation bound against the (wrong) implementing
        // file's imports instead of its own, this would incorrectly compile.
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Widget {
    @Conditional(""DEBUG"")
    partial func Describe() string;
}
",
            "Widget.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System.Diagnostics

partial class Widget {
    partial func Describe() string {
        return ""built""
    }
}
",
            "Widget.g.gs"));

        using var peStream = new MemoryStream();
        var diagnostics = new Compilation(declaringFile, implementingFile) { IsLibrary = true }
            .Emit(peStream)
            .Diagnostics;
        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void DocCommentOnTheDeclaringPart_IsAttachedToTheMergedMethod()
    {
        // Copilot review round 7: the merged node PartialMethodMerger builds
        // is a NEW SyntaxNode, never present in either original part's tree
        // when DocumentationAttacher indexed doc comments by reference.
        // AttachDocumentation looking it up directly always missed, so a
        // cross-file partial method silently lost its `///` comment (and
        // the XML doc file omitted it entirely).
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Greeter {
    /// Greets someone by name.
    /// @param name the person to greet
    /// @returns the greeting
    partial func Greet(name string) string;
}
",
            "Greeter.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Greeter {
    partial func Greet(name string) string {
        return ""hello, "" + name
    }
}
",
            "Greeter.g.gs"));

        var xml = EmitDocXml(new[] { declaringFile, implementingFile }, "Adr0192-DocComment");
        Assert.Contains("Greets someone by name.", xml);
        Assert.Contains("<param name=\"name\">", xml);
        Assert.Contains("<returns>", xml);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void DocComment_BothPartsInOneTypeBlock_IsAttachedToTheMergedMethod(bool onDeclaringPart)
    {
        // Both parts in ONE type block. The tree's `///` table is built lazily
        // by walking the tree, so it must still see the original declaring
        // node however the merge is done (an in-place merge once removed it
        // before the table was built). Deliberately no `package` line:
        // attaching a package's own doc comment happens to build the table
        // early, which masked that bug.
        var declaringDoc = onDeclaringPart ? "    /// Greets someone by name.\n" : string.Empty;
        var implementingDoc = onDeclaringPart ? string.Empty : "    /// Greets someone by name.\n";
        var source = "partial class Greeter {\n"
            + declaringDoc
            + "    partial func Greet(name string) string;\n\n"
            + implementingDoc
            + "    partial func Greet(name string) string {\n        return name\n    }\n}\n";

        var xml = EmitDocXml(new[] { SyntaxTree.Parse(SourceText.From(source, "Greeter.gs")) }, "Adr0192-DocSingleBlock");
        Assert.Contains("Greets someone by name.", xml);
    }

    [Fact]
    public void TypeDocComment_OnALoneTypeWithAPartialMethod_IsKept()
    {
        // A type that declares a partial method now binds through a copy of
        // its declaration (the merger no longer mutates the parsed tree), and
        // `///` comments are indexed by node reference — so the TYPE's own
        // comment must still be found through the copy.
        var source = "package App\n\n/// A friendly greeter.\npartial class Greeter {\n"
            + "    partial func Greet(name string) string;\n"
            + "    partial func Greet(name string) string {\n        return name\n    }\n}\n";

        var xml = EmitDocXml(new[] { SyntaxTree.Parse(SourceText.From(source, "Greeter.gs")) }, "Adr0192-TypeDoc");
        Assert.Contains("A friendly greeter.", xml);
    }

    [Fact]
    public void DocCommentOnTheImplementingPartOnly_IsStillAttachedToTheMergedMethod()
    {
        // Copilot review round 8: round 7's fix only ever recovered a
        // declaring-part doc comment — its fallback to the ordinary lookup
        // on the merged node itself could never have found an
        // implementing-only comment either, since the merged node is
        // (like the declaring part) never indexed by DocumentationAttacher.
        // Needs its own explicit ImplementingPart-based recovery path.
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Greeter {
    partial func Greet(name string) string;
}
",
            "Greeter.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Greeter {
    /// Greets someone by name.
    /// @param name the person to greet
    /// @returns the greeting
    partial func Greet(name string) string {
        return ""hello, "" + name
    }
}
",
            "Greeter.g.gs"));

        var xml = EmitDocXml(new[] { declaringFile, implementingFile }, "Adr0192-DocCommentImplementingOnly");
        Assert.Contains("Greets someone by name.", xml);
        Assert.Contains("<param name=\"name\">", xml);
        Assert.Contains("<returns>", xml);
    }

    [Fact]
    public void SameSpellingResolvesToTwoDifferentTypesAcrossFiles_ReportsGS0611()
    {
        // Copilot review round 7: the declaring part's signature was only
        // ever compared as normalized TEXT, never actually bound. `Timer`
        // spells the same in both files but the declaring file imports
        // `System.Timers` (`System.Timers.Timer`) while the implementing
        // file imports `System.Threading` (`System.Threading.Timer`) — two
        // genuinely unrelated CLR types. The merge used to adopt the
        // implementing file's resolution silently; it must now disagree.
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System.Timers

partial class Widget {
    partial func Make(t Timer) int32;
}
",
            "Widget.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System.Threading

partial class Widget {
    partial func Make(t Timer) int32 { return 1 }
}
",
            "Widget.g.gs"));

        var diagnostics = EmitDiagnostics(new[] { declaringFile, implementingFile });
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    // Copilot review round 12: the declaring part's constraints, parameter
    // annotations, and default values were compared only as text and never
    // bound, so a name that doesn't resolve in the DECLARING file went
    // unreported whenever the implementing file imported it. Each case below
    // imports the namespace only in the implementing file. (Not `System`: G#
    // makes it visible without an import, which would make the test vacuous.)
    [Theory]
    [InlineData(
        "partial func F[T IStructuralEquatable](x T) int32",
        "System.Collections",
        "IStructuralEquatable")]
    [InlineData(
        "partial func F(@AllowNull x string) int32",
        "System.Diagnostics.CodeAnalysis",
        "AllowNull")]
    [InlineData(
        "partial func F(x int32 = Timeout.Infinite) int32",
        "System.Threading",
        "Timeout")]
    public void NameUnresolvedOnlyInTheDeclaringFile_IsReported(string signature, string importedOnlyByImplementation, string name)
    {
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            $"package App\n\npartial class A {{\n    {signature};\n}}\n",
            "A.gs"));
        var implementingFile = SyntaxTree.Parse(SourceText.From(
            $"package App\nimport {importedOnlyByImplementation}\n\npartial class A {{\n    {signature} {{ return 1 }}\n}}\n",
            "A.g.gs"));

        var diagnostics = EmitDiagnostics(new[] { declaringFile, implementingFile });
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains(name, StringComparison.Ordinal) && d.Location.Text.FileName == "A.gs");

        var bothImport = EmitDiagnostics(new[]
        {
            SyntaxTree.Parse(SourceText.From($"package App\nimport {importedOnlyByImplementation}\n\npartial class A {{\n    {signature};\n}}\n", "A.gs")),
            implementingFile,
        });
        Assert.DoesNotContain(bothImport, d => d.IsError);
    }

    [Fact]
    public void ParameterAnnotationArgumentResolvingDifferently_ReportsGS0611()
    {
        // Copilot review round 13: annotations were compared by attribute type
        // only. `typeof(Timer)` is the same text in both files but names
        // System.Timers.Timer in one and System.Threading.Timer in the other.
        static SyntaxTree Part(string timerNamespace, string body, string file) => SyntaxTree.Parse(SourceText.From(
            $"package App\nimport System.ComponentModel\nimport {timerNamespace}\n\npartial class A {{\n    partial func F(@TypeConverter(typeof(Timer)) x int32) int32{body}\n}}\n",
            file));

        var differs = EmitDiagnostics(new[]
        {
            Part("System.Timers", ";", "A.gs"),
            Part("System.Threading", " { return 1 }", "A.g.gs"),
        });
        Assert.Contains(differs, d => d.Id == "GS0611" && d.Message.Contains("annotations", StringComparison.Ordinal));

        var same = EmitDiagnostics(new[]
        {
            Part("System.Threading", ";", "A.gs"),
            Part("System.Threading", " { return 1 }", "A.g.gs"),
        });
        Assert.DoesNotContain(same, d => d.IsError);
    }

    [Theory]
    [InlineData("interface IFoo {\n    func Bar() int32;\n}\n\npartial class C : IFoo {\n    partial func (IFoo) Bar() int32;\n    partial func (IFoo) Bar() int32 { return 1 }\n}\n")]
    [InlineData("partial class C {\n    partial func (c C) M() int32;\n    partial func (c C) M() int32 { return 1 }\n}\n")]
    public void ExplicitInterfaceOrReceiverClausePartialMethod_ReportsGS0607(string members)
    {
        // Copilot review round 13: ADR-0192 §F lists these shapes as
        // unsupported, but a matching pair used to merge and bind. Each part
        // is now rejected, and nothing else cascades.
        var diagnostics = Compile("package App\n\n" + members);
        Assert.Equal(2, diagnostics.Count(d => d.Id == "GS0607"));
        Assert.DoesNotContain(diagnostics, d => d.IsError && d.Id != "GS0607");
    }

    [Fact]
    public void ConversionOperatorPairedWithAnOrdinaryEscapedMethod_ReportsGS0611()
    {
        // Copilot review round 12: `operator implicit` and an escaped
        // `$op_Implicit` share a grouping key, and the merge took whichever
        // form the implementing part used.
        var diagnostics = Compile(@"package App

partial class A {
    partial func operator implicit (x A) int32;
}

partial class A {
    partial func $op_Implicit(x A) int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611" && d.Message.Contains("conversion-operator form", StringComparison.Ordinal));

        var matching = Compile(@"package App

partial class A {
    partial func operator implicit (x A) int32;
}

partial class A {
    partial func operator implicit (x A) int32 { return 1 }
}
");
        Assert.DoesNotContain(matching, d => d.IsError);
    }

    [Fact]
    public void DeclaringSideTypeIsTotallyUnresolved_ReportsOnlyTheUndefinedTypeDiagnostic()
    {
        // Complement: when the declaring side's type doesn't resolve to
        // ANYTHING (no import at all), bindTypeClause's own "type not found"
        // diagnostic already names the exact problem — this check's
        // TypeSymbol.Error guard must not pile a second, less precise GS0611
        // on top of it.
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Widget {
    partial func Make() StringBuilder;
}
",
            "Widget.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System.Text

partial class Widget {
    partial func Make() StringBuilder {
        return StringBuilder()
    }
}
",
            "Widget.g.gs"));

        var diagnostics = EmitDiagnostics(new[] { declaringFile, implementingFile });
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0611");
        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void ImplementingPartBody_DoesNotLeakTheDeclaringFilesImports()
    {
        // Negative ("no leak") twin for the BODY side: System.Text is now
        // imported ONLY by the declaring file — the implementing file whose
        // BODY actually reads `StringBuilder` unqualified has no matching
        // import. If the merged node's body bound against the (wrong)
        // declaring file's imports instead of its own implementing file's,
        // this would incorrectly compile.
        var declaringFile = SyntaxTree.Parse(SourceText.From(
            @"package App
import System.Text

partial class Widget {
    partial func Describe() string;
}
",
            "Widget.gs"));

        var implementingFile = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class Widget {
    partial func Describe() string {
        let sb = StringBuilder()
        sb.Append(""built"")
        return sb.ToString()
    }
}
",
            "Widget.g.gs"));

        using var peStream = new MemoryStream();
        var diagnostics = new Compilation(declaringFile, implementingFile) { IsLibrary = true }
            .Emit(peStream)
            .Diagnostics;
        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void StaticPartialMethodInSharedBlock_MergesAndRuns()
    {
        // The motivating C# shape is STATIC —
        // `[GeneratedRegex] private static partial Regex Foo();` — so the
        // `shared { }` path is the one that actually has to work, not just the
        // instance path.
        var source = @"package App
import System

partial class Config {
    shared {
        partial func Version() int32;
    }
}

partial class Config {
    shared {
        partial func Version() int32 {
            return 7
        }
    }
}

Console.WriteLine(Config.Version())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-StaticShared");
        Assert.Contains("7", output);
    }

    [Fact]
    public void PartialMethod_EmitsExactlyOneMethodDef()
    {
        // The whole point of the merge. Two parts in, one method out.
        var source = @"package App

partial class Greeter {
    partial func Greet(name string) string;
}

partial class Greeter {
    partial func Greet(name string) string {
        return name
    }
}
";
        var methodNames = EmittedMethodNames(source, "Greeter");
        Assert.Equal(1, methodNames.Count(n => n == "Greet"));
    }

    [Fact]
    public void AttributeOnTheDeclaringPart_LandsOnTheMergedMethod()
    {
        // The load-bearing property for issue #4301: the generator-written
        // implementing part must not have to restate the attribute the user
        // wrote on the declaring part, and the attribute must still reach the
        // one emitted method. Asserted through real reflection on the loaded
        // assembly, not by inspecting the syntax tree.
        var source = @"package App
import System

partial class Marked {
    @Obsolete(""use Next"")
    partial func Legacy() int32;
}

partial class Marked {
    partial func Legacy() int32 {
        return 1
    }
}

let t = typeof(Marked)
let m = t.GetMethod(""Legacy"")
Console.WriteLine(m!!.GetCustomAttributes(typeof(ObsoleteAttribute), false).Length)
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-DeclaringAttribute");
        Assert.Contains("1", output);
    }

    [Fact]
    public void AttributesOnBothParts_AreUnioned()
    {
        // C#'s rule for partial methods is "the combined attributes of the
        // defining and implementing declarations", and ADR-0144 §C already
        // unions annotations across type parts. ADR-0192 matches both.
        var source = @"package App
import System

partial class Marked {
    @Obsolete(""use Next"")
    partial func Legacy() int32;
}

partial class Marked {
    @System.Diagnostics.Conditional(""DEBUG"")
    partial func Legacy() int32 {
        return 1
    }
}

let t = typeof(Marked)
let m = t.GetMethod(""Legacy"")
Console.WriteLine(m!!.GetCustomAttributes(typeof(ObsoleteAttribute), false).Length)
Console.WriteLine(m!!.GetCustomAttributes(typeof(System.Diagnostics.ConditionalAttribute), false).Length)
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-UnionedAttributes");
        var lines = NonEmptyLines(output);
        Assert.Equal(new[] { "1", "1" }, lines);
    }

    [Fact]
    public void BothPartsInOneDeclaration_Merge()
    {
        // C# allows both parts in the same partial-type declaration, and so
        // must G# — the merge runs over every declaration, not only the ones
        // PartialTypeMerger actually combined.
        var source = @"package App
import System

partial class A {
    partial func F() int32;

    partial func F() int32 {
        return 5
    }
}

Console.WriteLine(A().F())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-OneDeclaration");
        Assert.Contains("5", output);
    }

    [Fact]
    public void PartialMethodsThatAreDistinctOverloads_AreNotPairedWithEachOther()
    {
        // The grouping key includes parameter TYPES. Keying on the name alone
        // would pair `F(int32)`'s declaring part with `F(string)`'s
        // implementing part and then report a signature conflict the user
        // never wrote.
        var source = @"package App
import System

partial class A {
    partial func F(x int32) int32;
    partial func F(x string) string;
}

partial class A {
    partial func F(x int32) int32 { return x + 1 }
    partial func F(x string) string { return x + ""!"" }
}

let a = A()
Console.WriteLine(a.F(1))
Console.WriteLine(a.F(""z""))
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-Overloads");
        var lines = NonEmptyLines(output);
        Assert.Equal(new[] { "2", "z!" }, lines);
    }

    [Fact]
    public void PartialOverloadsDifferingOnlyByRefKind_AreNotPairedWithEachOther()
    {
        // Copilot review round, finding 1. The grouping key was built from the
        // parameter's TYPE CLAUSE text alone, so `F(x int32)` and
        // `F(ref x int32)` hashed identically and were merged into one
        // 2-declaring/2-implementing group that then reported a spurious
        // GS0610. Ref-kind is part of overload identity — `BoundScope.
        // FunctionSignaturesEqual` treats it so — and must be part of the key.
        // Asserted on diagnostics + emitted metadata rather than by calling
        // both overloads: G# overload resolution independently treats a call
        // like `a.F(1)` as ambiguous between `F(int32)` and `F(ref int32)`,
        // which is a pre-existing trait of overload resolution and not what
        // this test is about. What matters here is that the two declarations
        // stay SEPARATE partial methods — each correctly paired with its own
        // implementing part — and that two distinct methods reach metadata.
        var source = @"package App

partial class A {
    partial func F(x int32) int32;
    partial func F(ref x int32) int32;
}

partial class A {
    partial func F(x int32) int32 { return x + 1 }
    partial func F(ref x int32) int32 { return x + 2 }
}
";
        var diagnostics = Compile(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0610");
        Assert.DoesNotContain(diagnostics, d => d.IsError);

        // Two parts in, two parts in — one merged method each, not one group.
        Assert.Equal(2, EmittedMethodNames(source, "A").Count(n => n == "F"));
    }

    [Fact]
    public void PartialOverloadsDifferingOnlyByVariadicMarker_AreNotPairedWithEachOther()
    {
        // Same defect class as the ref-kind case: a variadic `...int32`
        // parameter binds to a different effective type than a scalar `int32`,
        // but its type-clause text is identical, so the ellipsis marker must
        // also be part of the grouping key.
        var source = @"package App
import System

partial class A {
    partial func F(x int32) int32;
    partial func F(xs ...int32) int32;
}

partial class A {
    partial func F(x int32) int32 { return x + 1 }
    partial func F(xs ...int32) int32 { return xs.Length + 100 }
}

let a = A()
Console.WriteLine(a.F(1))
Console.WriteLine(a.F(7, 8, 9))
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-VariadicOverloads");
        Assert.Equal(new[] { "2", "103" }, NonEmptyLines(output));
    }

    [Fact]
    public void PartialMethodInANestedPartialType_Merges()
    {
        var source = @"package App
import System

partial class Outer {
    partial class Inner {
        partial func F() int32;
    }
}

partial class Outer {
    partial class Inner {
        partial func F() int32 { return 3 }
    }
}

Console.WriteLine(Outer.Inner().F())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-Nested");
        Assert.Contains("3", output);
    }

    [Fact]
    public void AccessibilityStatedOnOnlyTheDeclaringPart_IsCarriedOntoTheMergedMethod()
    {
        // ADR-0192 follows ADR-0144 §C's rule for type parts: a part may omit
        // accessibility, and the effective accessibility is whatever the other
        // part states. `private` here must actually take effect — if the merged
        // node dropped the declaring part's modifier the method would default
        // to public and this would emit a PUBLIC method.
        var source = @"package App

partial class A {
    private partial func Secret() int32;
}

partial class A {
    partial func Secret() int32 { return 1 }
}
";
        var visibility = EmittedMethodVisibility(source, "A", "Secret");
        Assert.Equal(MethodAttributes.Private, visibility);
    }

    [Fact]
    public void PartialMethodOnAPartialStruct_Merges()
    {
        var source = @"package App
import System

partial struct S {
    partial func F() int32;
}

partial struct S {
    partial func F() int32 { return 9 }
}

var s = S{}
Console.WriteLine(s.F())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-Struct");
        Assert.Contains("9", output);
    }

    [Fact]
    public void GenericPartialMethod_Merges()
    {
        var source = @"package App
import System

partial class A {
    partial func Echo[T any](value T) T;
}

partial class A {
    partial func Echo[T any](value T) T { return value }
}

Console.WriteLine(A().Echo(11))
";
        var output = CompileLoadInvokeCaptureStdout(source, "Adr0192-Generic");
        Assert.Contains("11", output);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. The zero-implementation rule (GS0609) — G#'s deliberate divergence
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void UnimplementedVoidPartialMethod_ReportsGS0609_RatherThanBeingElided()
    {
        // C# silently elides an unimplemented `void` partial method and every
        // call to it. G# does not: an unsatisfied body-less declaration is an
        // error here, consistent with how every other body-less G# declaration
        // is treated (ADR-0086 §1 / GS0325).
        var diagnostics = Compile(@"package App

partial class A {
    partial func OnChanged();
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0609");
    }

    [Fact]
    public void UnimplementedNonVoidPartialMethod_ReportsGS0609()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0609");
    }

    [Fact]
    public void UnimplementedPartialMethod_DoesNotAlsoReportGS0325OrGS0388()
    {
        // Anti-cascade. A body-less `func` is otherwise either a P/Invoke stub
        // (GS0325 when it is not) or an abstract member (GS0388 when the class
        // is not `open`). Neither is the user's actual mistake here, and a
        // partial declaring part must not collect them on top of GS0609.
        var instanceDiagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}
");
        Assert.Contains(instanceDiagnostics, d => d.Id == "GS0609");
        Assert.DoesNotContain(instanceDiagnostics, d => d.Id == "GS0325");
        Assert.DoesNotContain(instanceDiagnostics, d => d.Id == "GS0388");

        var staticDiagnostics = Compile(@"package App

partial class A {
    shared {
        partial func F() int32;
    }
}
");
        Assert.Contains(staticDiagnostics, d => d.Id == "GS0609");
        Assert.DoesNotContain(staticDiagnostics, d => d.Id == "GS0325");
    }

    [Fact]
    public void ImplementedPartialMethod_ReportsNoPartialDiagnostics()
    {
        // The complement of the tests above: proves the checks were made
        // precise rather than fired unconditionally on any `partial func`.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}

partial class A {
    partial func F() int32 { return 1 }
}
");
        Assert.DoesNotContain(diagnostics, d => d.Id.StartsWith("GS060", StringComparison.Ordinal));
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0325");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0388");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Part-shape and placement diagnostics (GS0608, GS0610)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PartialMethodInANonPartialType_ReportsGS0608()
    {
        var diagnostics = Compile(@"package App

class A {
    partial func F() int32;
    partial func F() int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0608");
    }

    [Fact]
    public void EscapedIdentifierDeclaringPart_MatchesThePlainIdentifierImplementingPart()
    {
        // Copilot review round 6: MethodKey.For used to key on
        // Identifier.Text, which keeps the ADR-0170 `$` escape marker, while
        // every other name comparison in the binder uses ValueText (`$F` and
        // `F` are the same identifier). A declaring `$F` and an implementing
        // plain `F` therefore hashed to two DIFFERENT keys and were treated
        // as two unrelated, unmatched declarations — GS0609 ("no
        // implementation") for the declaring part, GS0610 ("wrong part
        // count") for the implementing part, AND a GS0264 duplicate-overload
        // cascade on top — instead of being merged as one method.
        var diagnostics = Compile(@"package App

partial class A {
    partial func $F() int32;
    partial func F() int32 { return 1 }
}
");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void UnimplementedPartialMethodInANonPartialType_ReportsBothGS0608AndGS0609()
    {
        // Copilot review round 4: GS0608 was only checked inside the
        // well-formed-pair branch, so a lone declaring part in a non-partial
        // type reported GS0609 alone — even though the ADR's table says ANY
        // partial method in a non-partial type gets GS0608, regardless of how
        // many parts it has.
        var diagnostics = Compile(@"package App

class A {
    partial func F() int32;
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0608");
        Assert.Contains(diagnostics, d => d.Id == "GS0609");
    }

    [Fact]
    public void PartCountMismatchInANonPartialType_ReportsBothGS0608AndGS0610()
    {
        var diagnostics = Compile(@"package App

class A {
    partial func F() int32;
    partial func F() int32;
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0608");
        Assert.Contains(diagnostics, d => d.Id == "GS0610");
    }

    [Fact]
    public void TwoImplementingParts_ReportGS0610()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32 { return 1 }
}

partial class A {
    partial func F() int32 { return 2 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0610");
    }

    [Fact]
    public void TwoImplementingParts_DoNotAlsoReportADuplicateOverloadSignature()
    {
        // Anti-cascade: the merger keeps ONE surviving part so the existing
        // duplicate-overload check (GS0264) does not fire a second, less
        // informative error on top of GS0610. GS0610 itself is reported at
        // each offending part, so the user sees both locations.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32 { return 1 }
}

partial class A {
    partial func F() int32 { return 2 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0610");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0264");
    }

    [Fact]
    public void TwoDeclaringParts_ReportGS0610()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}

partial class A {
    partial func F() int32;
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0610");
    }

    [Fact]
    public void ImplementingPartWithNoDeclaringPart_ReportsGS0610()
    {
        // A lone `partial func` with a body is not a complete partial method:
        // G# requires the declaring/implementing pair (C# CS0759's analogue).
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0610");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Signature-consistency diagnostics (GS0611)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PartsWithDifferentReturnTypes_ReportGS0611()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}

partial class A {
    partial func F() string { return """" }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void PartsWithDifferentStringLiteralDefaultValues_ReportGS0611()
    {
        // Copilot review round 5: NormalizeNodeText used to strip ALL
        // whitespace from the raw source slice before comparing, including
        // whitespace INSIDE a literal's own text — so `"a b"` and `"ab"`
        // compared equal and the mismatch was silently accepted (the
        // implementing part's default value would have won). The fix
        // compares each leaf token's own exact text instead of raw
        // whitespace-stripped source, so the difference inside the literal
        // is no longer erased.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F(s string = ""a b"") int32;
}

partial class A {
    partial func F(s string = ""ab"") int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void PartsWithSameStringLiteralDefaultValue_DoNotReportGS0611()
    {
        // Complement: whitespace BETWEEN tokens (here, around `=`) must still
        // be ignored — only whitespace INSIDE a literal's own text is
        // significant.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F(s string =    ""a b"") int32;
}

partial class A {
    partial func F(s string=""a b"") int32 { return 1 }
}
");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void EscapedGenericTypeParameter_PairsWithThePlainSpelling()
    {
        // Copilot review round 8: `MethodKey.For` stored/matched
        // type-parameter names by raw `Text` (keeping the ADR-0170 `$`
        // marker), and `SubstituteTypeParameters` scanned raw source text
        // with no awareness of `$` at all — so a declaring `Echo[$T](value
        // $T) $T;` and an implementing `Echo[T](value T) T { … }` split into
        // two unmatched groups (GS0609 + GS0610 + a GS0264 cascade) despite
        // `$T` and `T` being the same identifier everywhere else in the
        // binder. Even after fixing the grouping key, ValidateConsistency's
        // own type-parameter-list/return-type text comparison independently
        // needed the same `$`-unescaping fix, or the correctly-grouped pair
        // would still spuriously report GS0611.
        var diagnostics = Compile(@"package App

partial class A {
    partial func Echo[$T](value $T) $T;
}

partial class A {
    partial func Echo[T](value T) T { return value }
}
");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void DifferentTypeParameterNames_ReportExactlyOneError()
    {
        // Copilot review round 9: after the syntax-level GS0611 for `[T]` vs
        // `[U]`, the semantic signature check re-bound the declaring side's
        // `T` with only `U` in scope and piled an unrelated "type doesn't
        // exist" error on top. Once the syntax check has failed, the
        // semantic check must stand down.
        var diagnostics = Compile(@"package App

partial class A {
    partial func Echo[T](value T) T;
}

partial class A {
    partial func Echo[U](value U) U { return value }
}
");
        Assert.Equal(1, diagnostics.Count(d => d.IsError));
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void OmittedDeclaringReturnType_AgainstAnInferredObjectBody_ReportsGS0611()
    {
        // Copilot review round 10: the semantic return-type comparison was
        // skipped whenever the declaring part omitted a type. Both parts'
        // type TEXT is empty here, so the syntax check agrees too — but the
        // implementing `-> object { … }` body infers a non-void return
        // (InferAnonymousClassLiteralReturnType). An omitted declaring type
        // is `void` and must be compared as such.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F();
}

partial class A {
    partial func F() -> object { let Secret = 42 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void OmittedReturnTypeOnBothParts_WithAnOrdinaryBody_MergesClean()
    {
        // Complement: omitted-on-both with a plain block body is genuinely
        // void on both sides and must not start reporting GS0611.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F();
}

partial class A {
    partial func F() { }
}
");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void TextuallyDifferentReturnTypes_ReportGS0611ExactlyOnce()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}

partial class A {
    partial func F() string { return """" }
}
");
        Assert.Equal(1, diagnostics.Count(d => d.Id == "GS0611"));
    }

    [Fact]
    public void EscapedGenericTypeParameter_WithATrulyDifferentName_StillReportsGS0611()
    {
        // Complement: `$T` vs `$U` (or `$T` vs `U`) are genuinely different
        // type-parameter names once unescaped, and must still disagree —
        // unescaping must not collapse every generic partial method into
        // one group regardless of its actual type-parameter names.
        var diagnostics = Compile(@"package App

partial class A {
    partial func Echo[$T](value $T) $T;
}

partial class A {
    partial func Echo[U](value U) U { return value }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void PartsWithDifferentParameterNames_ReportGS0611()
    {
        // Stricter than C#, which only warns (CS8826): a G# caller may pass the
        // argument by name, so the two parts would disagree about the method's
        // public surface.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F(x int32) int32;
}

partial class A {
    partial func F(y int32) int32 { return y }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void PartsWithDifferentAsyncColor_ReportGS0611()
    {
        // G# diverges from C# here: `async` changes the return type callers
        // see (ADR-0023), so it is part of the signature both parts must state.
        var diagnostics = Compile(@"package App
import System.Threading.Tasks

partial class A {
    partial func F() int32;
}

partial class A {
    partial async func F() int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void PartsWithConflictingStatedAccessibility_ReportGS0611()
    {
        var diagnostics = Compile(@"package App

partial class A {
    public partial func F() int32;
}

partial class A {
    private partial func F() int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void PartsWhereOnlyOneStatesAccessibility_DoNotReportGS0611()
    {
        // The complement: "agree where stated" must not degenerate into
        // "must both state".
        var diagnostics = Compile(@"package App

partial class A {
    private partial func F() int32;
}

partial class A {
    partial func F() int32 { return 1 }
}
");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void ParameterAnnotationOnOnlyOnePart_ReportsGS0611()
    {
        // ADR-0192 §D: a parameter's annotations are part of what both parts
        // must state, because the merged node takes the implementing part's
        // parameter nodes verbatim and a parameter annotation such as
        // `@AllowNull` is part of the contract callers see. This DIVERGES from
        // C#, which unions parameter attributes across the two parts — the
        // divergence is deliberate and documented, and this test pins it so a
        // future relaxation is a conscious change rather than an accident.
        var diagnostics = Compile(@"package App
import System.Diagnostics.CodeAnalysis

partial class A {
    partial func F(@AllowNull x string) int32;
}

partial class A {
    partial func F(x string) int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    [Fact]
    public void ParameterAnnotationOnBothParts_DoesNotReportGS0611()
    {
        // The complement: restating the annotation on both parts is accepted,
        // so the rule above is "must match", not "must be absent".
        var diagnostics = Compile(@"package App
import System.Diagnostics.CodeAnalysis

partial class A {
    partial func F(@AllowNull x string) int32;
}

partial class A {
    partial func F(@AllowNull x string) int32 { return 1 }
}
");

        // Asserted as "no errors at all", not merely "no GS0611": if `@AllowNull`
        // on a parameter did not bind (wrong import, unsupported target), a
        // GS0611-free result would be vacuously true and this test would prove
        // nothing about the rule it claims to pin.
        Assert.DoesNotContain(
            diagnostics,
            d => d.IsError);
    }

    [Fact]
    public void PartsWithDifferentTypeParameterNames_ReportGS0611()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func Echo[T any](value T) T;
}

partial class A {
    partial func Echo[U any](value U) U { return value }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0611");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Rebinding — a syntax tree outlives one compilation, so binding the
    //    same trees again (or with other files added/removed) must behave
    //    exactly like a first bind
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void BindingTheSameSyntaxTreeTwice_ProducesTheSameResult()
    {
        // A well-formed pair across two blocks binds clean both times.
        var tree = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class A {
    partial func F() int32;
}

partial class A {
    partial func F() int32 { return 1 }
}
",
            "Test.gs"));

        var first = EmitDiagnostics(tree);
        var second = EmitDiagnostics(tree);
        Assert.DoesNotContain(first, d => d.IsError);
        Assert.DoesNotContain(second, d => d.IsError);
    }

    [Fact]
    public void BindingTheSameSyntaxTreeTwice_TwoDeclaringParts_ReportsTheSameGS0610BothTimes()
    {
        // Recovery from a part-count mismatch keeps one surviving part and
        // drops the other to avoid a GS0102 cascade. The second bind of the
        // same single-block tree must still report GS0610 at both parts, not
        // GS0609 for a lone survivor (Copilot review rounds 5 and 8).
        var tree = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class A {
    partial func F() int32;
    partial func F() int32;
}
",
            "Test.gs"));

        var first = EmitDiagnostics(tree);
        var second = EmitDiagnostics(tree);
        Assert.Contains(first, d => d.Id == "GS0610");
        Assert.DoesNotContain(first, d => d.Id == "GS0609");
        Assert.Contains(second, d => d.Id == "GS0610");
        Assert.DoesNotContain(second, d => d.Id == "GS0609");

        // Copilot review round 8: the first bind reports GS0610 once PER
        // PART (two, here), and a true fixed point means the SECOND bind
        // reports the same COUNT — not just the same diagnostic ID at a
        // single, collapsed location.
        Assert.Equal(
            first.Count(d => d.Id == "GS0610"),
            second.Count(d => d.Id == "GS0610"));
    }

    [Fact]
    public void BindingTheSameSyntaxTreeTwice_TwoImplementingParts_ReportsTheSameGS0610CountsBothTimes()
    {
        // The mirror shape: the survivor here is an IMPLEMENTING part (has a
        // body), so without the marker the second bind would see a lone
        // implementing part with no declaring sibling and re-report GS0610
        // with the WRONG counts (0 declaring, 1 implementing) instead of the
        // true original (0 declaring, 2 implementing).
        var tree = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class A {
    partial func F() int32 { return 1 }
    partial func F() int32 { return 2 }
}
",
            "Test.gs"));

        var first = EmitDiagnostics(tree);
        var second = EmitDiagnostics(tree);
        Assert.Contains(first, d => d.Id == "GS0610" && d.Message.Contains("0 declaring part(s) and 2 implementing part(s)"));
        Assert.Contains(second, d => d.Id == "GS0610" && d.Message.Contains("0 declaring part(s) and 2 implementing part(s)"));

        // Copilot review round 8: same fixed-point-by-count requirement as
        // the two-declaring-parts test above.
        Assert.Equal(
            first.Count(d => d.Id == "GS0610"),
            second.Count(d => d.Id == "GS0610"));
    }

    [Fact]
    public void ReusedTree_AThirdPartAddedByAnotherFile_IsCountedWithTheOriginalTwo()
    {
        // Copilot review round 11: the merger used to rewrite a lone type's
        // member list in place. After a first compilation merged the pair in
        // `a1`, a later compilation that reused that unchanged tree (the
        // language server does, for full rebuilds) saw only the merged node,
        // so a third part added by another file was grouped on its own.
        var a1 = SyntaxTree.Parse(SourceText.From(
            "package App\n\npartial class A {\n    partial func F() int32;\n    partial func F() int32 { return 1 }\n}\n",
            "A1.gs"));
        Assert.DoesNotContain(EmitDiagnostics(new[] { a1 }), d => d.IsError);

        var a2 = SyntaxTree.Parse(SourceText.From(
            "package App\n\npartial class A {\n    partial func F() int32;\n}\n",
            "A2.gs"));
        var diagnostics = EmitDiagnostics(new[] { a1, a2 });

        Assert.Equal(3, diagnostics.Count(d => d.Id == "GS0610" && d.Message.Contains("2 declaring part(s) and 1 implementing part(s)")));
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0609");
    }

    [Fact]
    public void ReusedTree_ASiblingFileRemoved_ReportsTheCurrentShapeNotTheOldOne()
    {
        // Copilot review round 11: recovery used to leave a marker on the
        // surviving part's syntax node, recording the group's old shape and
        // locations. Compiling again with the sibling file removed replayed
        // GS0610 "2 declaring, 0 implementing" at the removed file's location,
        // although the current source is a single unimplemented declaration.
        var a1 = SyntaxTree.Parse(SourceText.From("package App\n\npartial class A {\n    partial func F() int32;\n}\n", "A1.gs"));
        var a2 = SyntaxTree.Parse(SourceText.From("package App\n\npartial class A {\n    partial func F() int32;\n}\n", "A2.gs"));
        Assert.Equal(2, EmitDiagnostics(new[] { a1, a2 }).Count(d => d.Id == "GS0610"));

        var alone = EmitDiagnostics(new[] { a1 });
        Assert.DoesNotContain(alone, d => d.Id == "GS0610");
        Assert.Contains(alone, d => d.Id == "GS0609");
    }

    [Fact]
    public void GenericOverloadsOverQualifiedTypeNames_AreNotConflated()
    {
        // Copilot review round 11: the grouping key substituted type-parameter
        // names by raw text, which also rewrote the member segment of a
        // qualified name — `F[T](x Types.T)` and `F[U](x Types.U)` both keyed
        // as `Types.!0`, so these two correct overloads collapsed into one
        // two-declaring/two-implementing group and reported GS0610.
        var diagnostics = Compile(@"package App

class Types {
    class T { }
    class U { }
}

partial class A {
    partial func F[T](x Types.T) int32;
    partial func F[T](x Types.T) int32 { return 1 }
    partial func F[U](x Types.U) int32;
    partial func F[U](x Types.U) int32 { return 2 }
}
");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void BindingTwice_MalformedPartsSplitAcrossTwoFiles_ReportsTheSameDiagnosticsBothTimes(bool bothImplementing)
    {
        // Copilot review round 10: with the malformed parts in two separate
        // `partial class` blocks, PartialTypeMerger rebuilds the type from
        // the untouched originals on every bind, so the siblings the first
        // bind "dropped" are back. The survivor's marker used to make it
        // replay on its own while the siblings were regrouped without it —
        // GS0609 appeared on the second bind (two declaring parts), or
        // GS0610 with the wrong counts (two implementing parts).
        var part = bothImplementing ? "partial func F() int32 { return 1 }" : "partial func F() int32;";
        var first = SyntaxTree.Parse(SourceText.From($"package App\n\npartial class A {{\n    {part}\n}}\n", "A1.gs"));
        var second = SyntaxTree.Parse(SourceText.From($"package App\n\npartial class A {{\n    {part}\n}}\n", "A2.gs"));

        static string[] Shape(IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> ds)
            => ds.Where(d => d.IsError).Select(d => d.Id + "|" + d.Message).OrderBy(x => x, StringComparer.Ordinal).ToArray();

        var firstBind = Shape(EmitDiagnostics(new[] { first, second }));
        var secondBind = Shape(EmitDiagnostics(new[] { first, second }));

        Assert.Equal(2, firstBind.Count(x => x.StartsWith("GS0610|", StringComparison.Ordinal)));
        Assert.Equal(firstBind, secondBind);
    }

    [Fact]
    public void BindingTheSameSyntaxTreeTwice_WellFormedPairInANonPartialType_ReportsGS0608BothTimes()
    {
        // GS0608 does not block the merge, so the second bind of the same
        // single-block tree must report it again rather than silently
        // succeeding (Copilot review round 6).
        var tree = SyntaxTree.Parse(SourceText.From(
            @"package App

class A {
    partial func F() int32;
    partial func F() int32 { return 1 }
}
",
            "Test.gs"));

        var first = EmitDiagnostics(tree);
        var second = EmitDiagnostics(tree);
        Assert.Contains(first, d => d.Id == "GS0608");
        Assert.Contains(second, d => d.Id == "GS0608");
    }

    [Fact]
    public void BindingTheSameSyntaxTreeTwice_PartsDisagree_ReportsGS0611BothTimes()
    {
        // The other half of the same bug: ValidateConsistency reports GS0611
        // but the merge still proceeds. On a second bind, the DeclaringPart
        // guard would otherwise skip re-deriving anything from the
        // already-merged node — silently turning this real compile error
        // into success too.
        var tree = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class A {
    partial func F() int32;
    partial func F() string { return """" }
}
",
            "Test.gs"));

        var first = EmitDiagnostics(tree);
        var second = EmitDiagnostics(tree);
        Assert.Contains(first, d => d.Id == "GS0611");
        Assert.Contains(second, d => d.Id == "GS0611");
    }

    [Fact]
    public void BindingTheSameSyntaxTreeTwice_SingleDeclarationBothParts_ProducesTheSameResult()
    {
        // Both parts in ONE `partial class` block: PartialTypeMerger hands back
        // the parsed node itself, so this is the shape where an in-place merge
        // would leak into the second bind (a spurious GS0610 "found 0
        // declaring part(s) and 1 implementing part(s)").
        var tree = SyntaxTree.Parse(SourceText.From(
            @"package App

partial class A {
    partial func F() int32;
    partial func F() int32 { return 1 }
}
",
            "Test.gs"));

        var first = EmitDiagnostics(tree);
        var second = EmitDiagnostics(tree);
        Assert.DoesNotContain(first, d => d.IsError);
        Assert.DoesNotContain(second, d => d.IsError);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private static string[] NonEmptyLines(string output) => output
        .Split('\n')
        .Select(line => line.TrimEnd('\r'))
        .Where(line => line.Length > 0)
        .ToArray();

    private static IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Compile(string source)
        => EmitDiagnostics(SyntaxTree.Parse(SourceText.From(source, "Test.gs")));

    private static IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> EmitDiagnostics(SyntaxTree tree)
    {
        using var peStream = new MemoryStream();
        return new Compilation(tree)
        {
            IsLibrary = true,
        }.Emit(peStream).Diagnostics.ToArray();
    }

    private static IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> EmitDiagnostics(SyntaxTree[] trees)
    {
        using var peStream = new MemoryStream();
        return new Compilation(trees)
        {
            IsLibrary = true,
        }.Emit(peStream).Diagnostics.ToArray();
    }

    /// <summary>Emits <paramref name="trees"/> and returns the produced XML documentation file's text.</summary>
    private static string EmitDocXml(SyntaxTree[] trees, string assemblyName)
    {
        var compilation = new Compilation(trees) { IsLibrary = true };
        using var peStream = new MemoryStream();
        using var docStream = new MemoryStream();
        var result = compilation.Emit(peStream, pdbStream: null, refStream: null, docStream, assemblyName);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        return System.Text.Encoding.UTF8.GetString(docStream.ToArray());
    }

    /// <summary>Emits <paramref name="source"/> and returns the method names on <paramref name="typeName"/>'s TypeDef.</summary>
    private static string[] EmittedMethodNames(string source, string typeName)
    {
        using var peStream = new MemoryStream();
        var result = new Compilation(SyntaxTree.Parse(SourceText.From(source, "Test.gs")))
        {
            IsLibrary = true,
        }.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var metadata = peReader.GetMetadataReader();
        var typeDef = metadata.TypeDefinitions
            .Select(metadata.GetTypeDefinition)
            .Single(t => metadata.GetString(t.Name) == typeName);
        return typeDef.GetMethods()
            .Select(handle => metadata.GetString(metadata.GetMethodDefinition(handle).Name))
            .ToArray();
    }

    /// <summary>Emits <paramref name="source"/> and returns the CLR visibility bits of one method.</summary>
    private static MethodAttributes EmittedMethodVisibility(string source, string typeName, string methodName)
    {
        using var peStream = new MemoryStream();
        var result = new Compilation(SyntaxTree.Parse(SourceText.From(source, "Test.gs")))
        {
            IsLibrary = true,
        }.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var metadata = peReader.GetMetadataReader();
        var typeDef = metadata.TypeDefinitions
            .Select(metadata.GetTypeDefinition)
            .Single(t => metadata.GetString(t.Name) == typeName);
        var methodDef = typeDef.GetMethods()
            .Select(metadata.GetMethodDefinition)
            .Single(m => metadata.GetString(m.Name) == methodName);
        return methodDef.Attributes & MethodAttributes.MemberAccessMask;
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
        => CompileLoadInvokeCaptureStdout(new[] { SyntaxTree.Parse(SourceText.From(source)) }, contextName);

    private static string CompileLoadInvokeCaptureStdout(SyntaxTree[] trees, string contextName)
    {
        using var peStream = new MemoryStream();
        var compilation = new Compilation(trees);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
