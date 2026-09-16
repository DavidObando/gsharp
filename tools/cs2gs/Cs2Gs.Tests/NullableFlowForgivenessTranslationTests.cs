// <copyright file="NullableFlowForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for the nullable-flow non-null assertion rule
/// (issue #914, GS0158 / GS0116): C# narrows a guarded nullable property/field
/// chain to non-null with flow analysis (<c>if (o.Child == null) return;</c>),
/// but G# follows Kotlin-style smart-casts that narrow only local variables,
/// never property/field-access chains. So a member or element access whose
/// receiver is a <em>declared</em>-nullable reference that Roslyn has
/// flow-proven non-null is emitted with G#'s postfix non-null assertion
/// (<c>recv!!.Member</c> / <c>recv!![i]</c>), re-establishing the fact the guard
/// already proved. For an unguarded declared-nullable field/property receiver
/// the assertion is likewise emitted, since G# cannot narrow such chains and a
/// bare access would be GS0158 (matching C#'s NRE-if-null runtime semantics).
/// The negative tests pin the precision guards so a stray assertion is never
/// emitted on a non-nullable, static, or already-asserted receiver.
/// </summary>
public class NullableFlowForgivenessTranslationTests
{
    [Fact]
    public void GuardedNullableProperty_MemberAccess_EmitsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class Outer { public Inner? Child => null; }
    public class C
    {
        public int F(Outer o)
        {
            if (o.Child == null) return 0;
            return o.Child.Value;
        }
    }
}");

        Assert.Contains("o.Child!!.Value", printed);
    }

    [Fact]
    public void GuardedNullableField_ElementAccess_EmitsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        private int[]? arr;
        public int F()
        {
            if (arr == null) return 0;
            return arr[0];
        }
    }
}");

        Assert.Contains("arr!![0]", printed);
    }

    [Fact]
    public void UnguardedNullableProperty_MemberAccess_EmitsNonNullAssertion()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class Outer { public Inner? Child => null; }
    public class C
    {
        public int F(Outer o)
        {
            return o.Child.Value;
        }
    }
}");

        // Even without a guard, the receiver `o.Child` is a declared-nullable
        // PROPERTY. G# smart-casts only local variables, never property/field
        // chains, so a bare `o.Child.Value` would be GS0158. The receiver rule
        // emits `o.Child!!.Value`, faithfully preserving C#'s NRE-if-null
        // semantics (C# itself only warns here, CS8602).
        Assert.Contains("o.Child!!.Value", printed);
    }

    [Fact]
    public void NonNullableProperty_MemberAccess_DoesNotAssert()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class Outer { public Inner Child => new Inner(); }
    public class C
    {
        public int F(Outer o)
        {
            return o.Child.Value;
        }
    }
}");

        // The receiver is declared non-nullable, so it never needs an assertion.
        Assert.DoesNotContain("!!", printed);
        Assert.Contains("o.Child.Value", printed);
    }

    [Fact]
    public void StaticMemberAccess_DoesNotAssert()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public int F()
        {
            return System.Environment.ProcessId;
        }
    }
}");

        Assert.DoesNotContain("!!", printed);
    }

    [Fact]
    public void GuardedNullableProperty_SameConditionAnd_DoesNotAssert()
    {
        // Issue #4262 follow-up (cs2gs nullability investigation): gsc DOES
        // narrow a field/property/member-access-chain receiver guarded by a
        // null check combined via `&&` in the SAME boolean expression, unlike
        // the statement-crossing guard above (an `if`-body) — confirmed
        // directly against the compiler. cs2gs asserted `!!` here regardless,
        // even though the C# source itself carries no `!`; verbatim shape of
        // Oahu.Core/Profile.cs (issue #4262's own corpus).
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token { public string? AccessToken { get; set; } }
    public class C
    {
        public bool F(Token t) =>
            t.AccessToken is not null && t.AccessToken.StartsWith(""stub"");
    }
}");

        Assert.Contains("t.AccessToken.StartsWith(\"stub\")", printed);
        Assert.DoesNotContain("!!", printed);
    }

    [Fact]
    public void GuardedNullableProperty_SameConditionOr_DoesNotAssert()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token { public string? AccessToken { get; set; } }
    public class C
    {
        public bool F(Token t) =>
            !(t.AccessToken is null || !t.AccessToken.StartsWith(""stub""));
    }
}");

        Assert.Contains("t.AccessToken.StartsWith(\"stub\")", printed);
        Assert.DoesNotContain("!!", printed);
    }

    [Fact]
    public void GuardedNullableProperty_SameConditionAnd_ObliviousCompilation_DoesNotAssert()
    {
        // The oblivious counterpart: Roslyn's own flow state is empty for an
        // oblivious compilation, so this same-condition guard is detected
        // purely syntactically, exactly like the real Oahu.Core (which has
        // no `<Nullable>` element at all) — verified against the compiler.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Token { public string AccessToken { get; set; } }
    public class C
    {
        public bool F(Token t) =>
            t.AccessToken != null && t.AccessToken.StartsWith(""stub"");
    }
}");

        Assert.Contains("t.AccessToken.StartsWith(\"stub\")", printed);
        Assert.DoesNotContain("!!", printed);
    }

    [Fact]
    public void UnrelatedGuard_SameConditionAnd_StillAsserts()
    {
        // Precision guard: the left operand null-checks a DIFFERENT
        // property, so the right operand's receiver is not narrowed and must
        // still assert.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token { public string? AccessToken { get; set; } public string? RefreshToken { get; set; } }
    public class C
    {
        public bool F(Token t) =>
            t.RefreshToken is not null && t.AccessToken.StartsWith(""stub"");
    }
}");

        Assert.Contains("t.AccessToken!!.StartsWith(\"stub\")", printed);
    }

    [Fact]
    public void GuardInCondition_UseInFollowingStatement_StillAsserts()
    {
        // Precision guard: the same-condition rule only reaches the
        // IMMEDIATE `&&`/`||` sibling — it must not treat a guard as
        // narrowing a LATER, separate statement's use of the same field/
        // property, since gsc genuinely cannot narrow a field/property that
        // far (only the pre-existing statement-crossing rules — themselves
        // unaffected by this change — ever assert `false` there, via a
        // DIFFERENT, syntactic guard-detection path).
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token { public string? AccessToken { get; set; } }
    public class C
    {
        public bool F(Token t)
        {
            bool guarded = t.AccessToken is not null && t.AccessToken.StartsWith(""x"");
            return guarded && t.AccessToken.StartsWith(""stub"");
        }
    }
}");

        Assert.Contains("t.AccessToken!!.StartsWith(\"stub\")", printed);
    }

    [Fact]
    public void AlreadyNullForgiving_MemberAccess_DoesNotDoubleAssert()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Inner { public int Value; }
    public class Outer { public Inner? Child => null; }
    public class C
    {
        public int F(Outer o)
        {
            return o.Child!.Value;
        }
    }
}");

        // The C# null-forgiving `expr!` already lowers to a single `!!`; the
        // flow-forgiveness rule must not stack a second assertion onto it.
        Assert.Contains("o.Child!!.Value", printed);
        Assert.DoesNotContain("!!!", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
