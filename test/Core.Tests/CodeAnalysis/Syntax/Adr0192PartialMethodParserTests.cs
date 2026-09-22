// <copyright file="Adr0192PartialMethodParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0192 / issue #4301: parser-layer tests for the <c>partial</c> contextual
/// modifier on a <c>func</c> member. These cover recognition of both parts (the
/// <c>;</c>-bodied declaring part and the block-bodied implementing part), the
/// modifier's composition with <c>async</c>/<c>suspend</c>/<c>unsafe</c> in
/// either order, GS0600 for every position a partial member cannot occupy, and
/// — the load-bearing negative — that <c>partial</c> remains an ordinary
/// identifier everywhere else.
/// </summary>
public class Adr0192PartialMethodParserTests
{
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Recognition — both parts, and the modifier's composition
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void DeclaringPart_IsRecognized_WithSemicolonBodyAndNoBlockBody()
    {
        var method = SingleMethod(@"package App
partial class A {
    partial func F(x int32) string;
}
");
        Assert.True(method.IsPartial);
        Assert.True(method.HasSemicolonBody);
        Assert.Null(method.Body);
        Assert.Equal("partial", method.PartialModifier!.Text);
    }

    [Fact]
    public void ImplementingPart_IsRecognized_WithBlockBody()
    {
        var method = SingleMethod(@"package App
partial class A {
    partial func F(x int32) string { return """" }
}
");
        Assert.True(method.IsPartial);
        Assert.False(method.HasSemicolonBody);
        Assert.NotNull(method.Body);
    }

    [Fact]
    public void PartialModifier_IsIncludedInTheDeclarationSpan()
    {
        // Regression guard for the [SyntaxChildIgnore] decision: PartialModifier
        // must be a real child, so the node's span covers the token. If it were
        // ignored, the span would start at `func` and the token would drop out
        // of every tree walk that drives tooling.
        const string Source = @"package App
partial class A {
    partial func F() int32;
}
";
        var method = SingleMethod(Source);
        var text = SourceText.From(Source);
        Assert.StartsWith("partial", text.ToString(method.Span));
    }

    [Theory]
    [InlineData("partial async func F() int32 { return 1 }")]
    [InlineData("async partial func F() int32 { return 1 }")]
    [InlineData("partial unsafe func F() int32 { return 1 }")]
    [InlineData("unsafe partial func F() int32 { return 1 }")]
    [InlineData("partial unsafe async func F() int32 { return 1 }")]
    [InlineData("public partial func F() int32 { return 1 }")]
    public void PartialModifier_ComposesWithTheOtherFunctionModifiers_InEitherOrder(string member)
    {
        var method = SingleMethod($@"package App
partial class A {{
    {member}
}}
");
        Assert.True(method.IsPartial);
    }

    /// <summary>
    /// Gets all six orderings of the <c>partial</c> / colour / <c>unsafe</c>
    /// modifier run. ADR-0192 §A advertises every one as legal, so every one is
    /// tested at every call site rather than the two or three a review happened
    /// to name.
    /// </summary>
    /// <returns>The permutation data.</returns>
    public static IEnumerable<object[]> ModifierRunPermutations()
    {
        yield return new object[] { "partial async unsafe" };
        yield return new object[] { "partial unsafe async" };
        yield return new object[] { "async partial unsafe" };
        yield return new object[] { "async unsafe partial" };
        yield return new object[] { "unsafe partial async" };
        yield return new object[] { "unsafe async partial" };
    }

    [Theory]
    [MemberData(nameof(ModifierRunPermutations))]
    public void EveryModifierRunPermutation_ParsesAsAPartialInstanceMethod(string modifiers)
    {
        // Copilot review round, findings 3. Before the shared modifier-run
        // consumer, `async partial unsafe` and `unsafe partial async` — the two
        // orderings that put `partial` BETWEEN the colour modifier and
        // `unsafe` — left a stray token where `func` was expected and cascaded
        // into a dozen recovery diagnostics.
        var source = $@"package App
partial class A {{
    {modifiers} func F() int32 {{ return 1 }}
}}
";
        var diagnostics = ParseDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);

        var method = SingleMethod(source);
        Assert.True(method.IsPartial);
        Assert.True(method.IsUnsafe);
        Assert.True(method.IsAsync);
    }

    [Theory]
    [MemberData(nameof(ModifierRunPermutations))]
    public void EveryModifierRunPermutation_ParsesAsAPartialStaticMethodInASharedBlock(string modifiers)
    {
        // Copilot review round, finding 5 — the same root cause inside
        // `shared { }`, which is the path the motivating static
        // `[GeneratedRegex]` shape actually takes.
        var source = $@"package App
partial class A {{
    shared {{
        {modifiers} func F() int32 {{ return 1 }}
    }}
}}
";
        var diagnostics = ParseDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);

        var tree = Parse(source);
        var type = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var method = type.SharedBlock!.Methods.Single();
        Assert.True(method.IsPartial);
        Assert.True(method.IsUnsafe);
        Assert.True(method.IsAsync);
    }

    [Theory]
    [MemberData(nameof(ModifierRunPermutations))]
    public void EveryModifierRunPermutation_AtTopLevel_ReportsExactlyOneGS0600(string modifiers)
    {
        // Copilot review round, finding 6. `partial` is invalid on a top-level
        // `func`, but the recovery promise is ONE diagnostic — the whole
        // modifier run must be consumed so the `func` after it still parses.
        // Previously `async partial unsafe func` diagnosed `partial` and then
        // left `unsafe` behind, cascading.
        var source = $@"package App

{modifiers} func F() int32 {{ return 1 }}
";
        var diagnostics = ParseDiagnostics(source);
        Assert.Equal(1, diagnostics.Count(d => d.Id == "GS0600"));
        Assert.DoesNotContain(diagnostics, d => d.IsError && d.Id != "GS0600");

        var tree = Parse(source);
        var function = Assert.Single(tree.Root.Members.OfType<FunctionDeclarationSyntax>());
        Assert.Equal("F", function.Identifier.Text);
    }

    [Theory]
    [InlineData("prop P int32 { get { return 1 } }")]
    [InlineData("event E Action")]
    public void AccessibilityBeforeAMisplacedPartial_StillReachesTheGS0600RecoveryPath(string member)
    {
        // Copilot review round, findings 2 and 4. With `public partial prop …`
        // the accessibility lookahead stopped at `partial`, never matched
        // `prop`, and so left `public` unconsumed — which meant the misplaced-
        // `partial` rejection path never ran and the user got a field-declaration
        // cascade instead of the intended GS0600.
        var diagnostics = ParseDiagnostics($@"package App
import System

partial class A {{
    public partial {member}
}}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void AccessibilityBeforeAMisplacedPartialInASharedBlock_StillReachesTheGS0600RecoveryPath()
    {
        var diagnostics = ParseDiagnostics(@"package App

partial class A {
    shared {
        public partial prop P int32 { get { return 1 } }
    }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void AccessibilityBeforeAPartialFuncInASharedBlock_IsConsumedAsAMemberModifier()
    {
        var tree = Parse(@"package App

partial class A {
    shared {
        public partial func F() int32;
    }
}
");
        var type = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var method = type.SharedBlock!.Methods.Single();
        Assert.True(method.IsPartial);
        Assert.NotNull(method.AccessibilityModifier);
    }

    [Fact]
    public void PartialModifier_IsRecognizedInsideASharedBlock()
    {
        // The motivating scenario is static: C#'s
        // `[GeneratedRegex] private static partial Regex Foo();` translates to a
        // `partial func` inside `shared { }`.
        var tree = Parse(@"package App
partial class A {
    shared {
        partial func F() int32;
    }
}
");
        var type = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        var method = type.SharedBlock!.Methods.Single();
        Assert.True(method.IsPartial);
        Assert.True(method.HasSemicolonBody);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. `partial` stays an ordinary identifier everywhere else (ADR-0144 §A)
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PartialAsAVariableName_StillParses()
    {
        var diagnostics = ParseDiagnostics(@"package App
import System

let partial = 1
Console.WriteLine(partial)
");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialAsAFunctionName_StillParses()
    {
        var diagnostics = ParseDiagnostics(@"package App

func partial() int32 { return 1 }
");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialAsAFieldName_InsideAPartialClass_StillParses()
    {
        // `partial` here heads neither a `func` nor an aggregate keyword, so the
        // lookahead must decline it and leave it to ParseFieldDeclaration as an
        // ordinary field name.
        var diagnostics = ParseDiagnostics(@"package App

partial class A {
    var partial int32 = 1
}
");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialClass_StillParsesAsAPartialType_NotAMisplacedMemberModifier()
    {
        // The nested-type path shares the member loop with `partial func`; the
        // probe must yield to TryDetectAggregateDeclarationHead.
        var diagnostics = ParseDiagnostics(@"package App

partial class Outer {
    partial class Inner {
        var x int32 = 1
    }
}
");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0600");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. GS0600 — every position a partial member cannot occupy
    // ─────────────────────────────────────────────────────────────────────────

    [Fact]
    public void PartialOnATopLevelFunction_ReportsGS0600()
    {
        var diagnostics = ParseDiagnostics(@"package App

partial func F() int32 { return 1 }
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialOnATopLevelFunction_StillParsesTheFunction()
    {
        // Anti-cascade: the `func` after the rejected modifier must still parse
        // as a function declaration, so callers of it bind normally and the user
        // sees exactly one error.
        var tree = Parse(@"package App

partial func F() int32 { return 1 }
");
        var function = Assert.Single(tree.Root.Members.OfType<FunctionDeclarationSyntax>());
        Assert.Equal("F", function.Identifier.Text);
    }

    [Fact]
    public void PartialOnAnInterfaceMethodSignature_ReportsGS0600()
    {
        var diagnostics = ParseDiagnostics(@"package App

interface I {
    partial func F() int32;
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialOnAnInterfaceStaticVirtualSlot_ReportsGS0600()
    {
        var diagnostics = ParseDiagnostics(@"package App

interface I {
    shared {
        partial func F() int32;
    }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialInterfaceType_IsStillLegal_OnlyItsMembersAreNot()
    {
        // ADR-0144 keeps `partial interface` as a legal TYPE; ADR-0192 scopes
        // out only partial MEMBERS of an interface.
        var diagnostics = ParseDiagnostics(@"package App

partial interface I {
    func F() int32;
}
");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialOnAProperty_ReportsGS0600()
    {
        // Partial properties are a real C# 13 feature and a natural future
        // extension (ADR-0192 scope limitations), but they are not implemented:
        // the modifier must be rejected precisely rather than fall through to
        // ParseFieldDeclaration as a stray type-clause token.
        var diagnostics = ParseDiagnostics(@"package App

partial class A {
    partial prop P int32 { get { return 1 } }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialOnAnEvent_ReportsGS0600()
    {
        var diagnostics = ParseDiagnostics(@"package App
import System

partial class A {
    partial event E Action
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    [Fact]
    public void PartialOnASharedBlockField_ReportsGS0600()
    {
        var diagnostics = ParseDiagnostics(@"package App

partial class A {
    shared {
        partial var x int32 = 1
    }
}
");
        Assert.Contains(diagnostics, d => d.Id == "GS0600");
    }

    private static SyntaxTree Parse(string source) => SyntaxTree.Parse(SourceText.From(source, "Test.gs"));

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> ParseDiagnostics(string source)
        => Parse(source).Diagnostics.ToArray();

    private static FunctionDeclarationSyntax SingleMethod(string source)
    {
        var tree = Parse(source);
        var type = tree.Root.Members.OfType<StructDeclarationSyntax>().Single();
        return type.Methods.Single();
    }
}
