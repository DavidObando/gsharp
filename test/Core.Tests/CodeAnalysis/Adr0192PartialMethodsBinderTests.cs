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
Console.WriteLine(m.GetCustomAttributes(typeof(ObsoleteAttribute), false).Length)
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
Console.WriteLine(m.GetCustomAttributes(typeof(ObsoleteAttribute), false).Length)
Console.WriteLine(m.GetCustomAttributes(typeof(System.Diagnostics.ConditionalAttribute), false).Length)
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
    // 2. The zero-implementation rule (GS0602) — G#'s deliberate divergence
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void UnimplementedVoidPartialMethod_ReportsGS0602_RatherThanBeingElided()
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
        Assert.Contains(diagnostics, d => d.Id == "GS0602");
    }

    [Fact]
    public void UnimplementedNonVoidPartialMethod_ReportsGS0602()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0602");
    }

    [Fact]
    public void UnimplementedPartialMethod_DoesNotAlsoReportGS0325OrGS0388()
    {
        // Anti-cascade. A body-less `func` is otherwise either a P/Invoke stub
        // (GS0325 when it is not) or an abstract member (GS0388 when the class
        // is not `open`). Neither is the user's actual mistake here, and a
        // partial declaring part must not collect them on top of GS0602.
        var instanceDiagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}
");
        Assert.Contains(instanceDiagnostics, d => d.Id == "GS0602");
        Assert.DoesNotContain(instanceDiagnostics, d => d.Id == "GS0325");
        Assert.DoesNotContain(instanceDiagnostics, d => d.Id == "GS0388");

        var staticDiagnostics = Compile(@"package App

partial class A {
    shared {
        partial func F() int32;
    }
}
");
        Assert.Contains(staticDiagnostics, d => d.Id == "GS0602");
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
    // 3. Part-shape and placement diagnostics (GS0601, GS0603)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PartialMethodInANonPartialType_ReportsGS0601()
    {
        var diagnostics = Compile(@"package App

class A {
    partial func F() int32;
    partial func F() int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0601");
    }

    [Fact]
    public void TwoImplementingParts_ReportGS0603()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32 { return 1 }
}

partial class A {
    partial func F() int32 { return 2 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0603");
    }

    [Fact]
    public void TwoImplementingParts_DoNotAlsoReportADuplicateOverloadSignature()
    {
        // Anti-cascade: the merger keeps ONE surviving part so the existing
        // duplicate-overload check (GS0264) does not fire a second, less
        // informative error on top of GS0603. GS0603 itself is reported at
        // each offending part, so the user sees both locations.
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32 { return 1 }
}

partial class A {
    partial func F() int32 { return 2 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0603");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0264");
    }

    [Fact]
    public void TwoDeclaringParts_ReportGS0603()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}

partial class A {
    partial func F() int32;
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0603");
    }

    [Fact]
    public void ImplementingPartWithNoDeclaringPart_ReportsGS0603()
    {
        // A lone `partial func` with a body is not a complete partial method:
        // G# requires the declaring/implementing pair (C# CS0759's analogue).
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0603");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Signature-consistency diagnostics (GS0604)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PartsWithDifferentReturnTypes_ReportGS0604()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func F() int32;
}

partial class A {
    partial func F() string { return """" }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0604");
    }

    [Fact]
    public void PartsWithDifferentParameterNames_ReportGS0604()
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
        Assert.Contains(diagnostics, d => d.Id == "GS0604");
    }

    [Fact]
    public void PartsWithDifferentAsyncColor_ReportGS0604()
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
        Assert.Contains(diagnostics, d => d.Id == "GS0604");
    }

    [Fact]
    public void PartsWithConflictingStatedAccessibility_ReportGS0604()
    {
        var diagnostics = Compile(@"package App

partial class A {
    public partial func F() int32;
}

partial class A {
    private partial func F() int32 { return 1 }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0604");
    }

    [Fact]
    public void PartsWhereOnlyOneStatesAccessibility_DoNotReportGS0604()
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
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0604");
    }

    [Fact]
    public void ParameterAnnotationOnOnlyOnePart_ReportsGS0604()
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
        Assert.Contains(diagnostics, d => d.Id == "GS0604");
    }

    [Fact]
    public void ParameterAnnotationOnBothParts_DoesNotReportGS0604()
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
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0604");
    }

    [Fact]
    public void PartsWithDifferentTypeParameterNames_ReportGS0604()
    {
        var diagnostics = Compile(@"package App

partial class A {
    partial func Echo[T any](value T) T;
}

partial class A {
    partial func Echo[U any](value U) U { return value }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0604");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Idempotency — the merger mutates shared syntax trees in place
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void BindingTheSameSyntaxTreeTwice_ProducesTheSameResult()
    {
        // PartialMethodMerger normalizes a declaration in place, so the second
        // bind of the same tree sees an already-merged method. Without the
        // DeclaringPart idempotency guard that method would look like a lone
        // implementing part and report a spurious GS0603.
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
