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
        //
        // PR #4277 review fix: gsc's own stability rule (see
        // src/Core/CodeAnalysis/Binding/SmartCastStability.cs,
        // IsStableProperty) only narrows a get-only/init-only, non-virtual
        // auto-property — a settable `{ get; set; }` property is never
        // narrowed by gsc even in the same-condition case, so this fixture
        // was changed from `{ get; set; }` to `{ get; }` to actually match
        // what gsc narrows (see GuardedSettableProperty_SameConditionAnd_StillAsserts
        // below for the settable case this predicate must NOT suppress).
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token { public string? AccessToken { get; } }
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
        // PR #4277 review fix: get-only, matching the same reasoning as
        // GuardedNullableProperty_SameConditionAnd_DoesNotAssert above.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token { public string? AccessToken { get; } }
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
        // PR #4277 review fix: get-only, matching the same reasoning as
        // GuardedNullableProperty_SameConditionAnd_DoesNotAssert above.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Token { public string AccessToken { get; } }
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
    public void GuardedSettableProperty_SameConditionAnd_StillAsserts()
    {
        // PR #4277 review fix (Copilot finding, High): gsc's stability rule
        // (SmartCastStability.IsStableProperty) never narrows a settable
        // (non-init) auto-property, even guarded in the SAME `&&` condition —
        // narrowing it here would be unsound (another thread, or a later
        // change to this method, could observe two different values across
        // the two reads) and would not match what gsc itself does, so
        // suppressing `!!` would risk GS0158 in the translated output.
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

        Assert.Contains("t.AccessToken!!.StartsWith(\"stub\")", printed);
    }

    [Fact]
    public void GuardedVirtualProperty_SameConditionAnd_StillAsserts()
    {
        // PR #4277 review fix: an overridable (virtual) property could
        // return a different value on a second dispatch even with an
        // unchanged backing field — gsc's stability rule excludes it, and so
        // must this predicate.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token
    {
        public virtual string? AccessToken { get; }
    }
    public class C
    {
        public bool F(Token t) =>
            t.AccessToken is not null && t.AccessToken.StartsWith(""stub"");
    }
}");

        Assert.Contains("t.AccessToken!!.StartsWith(\"stub\")", printed);
    }

    [Fact]
    public void GuardedComputedProperty_SameConditionAnd_StillAsserts()
    {
        // PR #4277 review fix: a computed (expression-bodied) getter is not
        // idempotent storage — it may return a fresh value (or null) on its
        // second evaluation even though the first proved non-null. gsc's
        // stability rule requires a plain auto-property; this predicate must
        // match.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token
    {
        private string? backing;
        public string? AccessToken => backing;
    }
    public class C
    {
        public bool F(Token t) =>
            t.AccessToken is not null && t.AccessToken.StartsWith(""stub"");
    }
}");

        Assert.Contains("t.AccessToken!!.StartsWith(\"stub\")", printed);
    }

    [Fact]
    public void DifferentInstances_SamePropertySymbol_SameConditionAnd_StillAsserts()
    {
        // PR #4277 review fix (Copilot finding, High): `a.AccessToken` and
        // `b.AccessToken` bind to the SAME property symbol but denote
        // DIFFERENT receiver instances — matching by symbol alone (the
        // pre-fix behaviour) wrongly treated `b`'s use as guarded by `a`'s
        // null check. The property is deliberately get-only here so the
        // stability restriction alone would not already reject this case —
        // this test pins the receiver-PATH comparison specifically.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Token { public string? AccessToken { get; } }
    public class C
    {
        public bool F(Token a, Token b) =>
            a.AccessToken is not null && b.AccessToken.StartsWith(""stub"");
    }
}");

        Assert.Contains("b.AccessToken!!.StartsWith(\"stub\")", printed);
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

    [Fact]
    public void GuardedProperty_SameConditionOr_RootItselfNullForgiven_StillAssertsOnMember()
    {
        // PR #4277 review fix (live-CI-confirmed): reproduces the hot-core
        // guard regression this predicate caused in
        // src/Core/CodeAnalysis/Binding/StatementBinder.Loops.cs's
        // IsLockableReferenceType — `type.ClrType == null || !type.ClrType.IsValueType`.
        // `type` is a defensively-checked, non-nullable-DECLARED parameter in
        // an oblivious (no `#nullable`) file, so cs2gs itself asserts `type!!`
        // at every dereference (the pre-existing, unrelated "promoted
        // nullable receiver" rule). `ClrType` is otherwise a perfectly
        // stable get-only, non-virtual property, and both operands denote
        // the SAME `type.ClrType` path — so without this fix this predicate
        // would ALSO suppress `!!` on `.ClrType`, leaving
        // `type!!.ClrType.IsValueType`. gsc's own SmartCastStability only
        // recognises a bare variable as a stable-path ROOT: once `type` is
        // itself emitted as `type!!` (a BoundUnaryExpression, not a bare
        // variable), the chain hanging off it is no longer a stable path at
        // all, and gsc genuinely cannot narrow `.ClrType` — dropping its `!!`
        // there produced the real GS0158 ('Cannot find member IsValueType')
        // this test pins against regressing.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class TypeSymbol
    {
        public System.Type ClrType { get; }
    }
    public class C
    {
        private static bool IsLockable(TypeSymbol type)
        {
            if (type == null) return true;
            return type.ClrType == null || !type.ClrType.IsValueType;
        }
    }
}");

        Assert.Contains("type!!.ClrType!!.IsValueType", printed);
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
