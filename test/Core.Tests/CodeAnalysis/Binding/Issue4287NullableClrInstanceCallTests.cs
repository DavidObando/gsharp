// <copyright file="Issue4287NullableClrInstanceCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4287: a call to an imported/CLR instance method (e.g.
/// <c>System.String.ToUpper</c>) through a nullable receiver (<c>string?</c>)
/// compiled with zero diagnostics and threw an unattributed
/// <see cref="NullReferenceException"/> at runtime — no narrowing/goto/
/// control-flow needed, a plain direct call reproduced it. A call to a
/// user-defined instance method through a nullable receiver was already
/// correctly rejected with GS0159 ("... receiver ... may be nil").
/// <para>
/// Root cause: <c>NullableTypeSymbol.ClrType</c> is defined (see its
/// constructor) to equal the underlying type's own <c>ClrType</c> directly —
/// never null for an imported/CLR type such as <c>string</c>. The existing
/// "receiver may be nil" fallback in
/// <c>ExpressionBinder.Calls.Invocation.cs</c>'s <c>BindAccessorCall</c> only
/// ran when <c>effectiveReceiverType.ClrType</c> was null (true for a
/// G#-declared type during binding, never true for an imported type), so
/// member lookup against a nullable CLR receiver resolved directly against
/// the underlying type with no nil check at all.
/// </para>
/// <para>
/// The fix adds a second check, gated on the receiver actually being a
/// reference-typed <c>NullableTypeSymbol</c> whose underlying type carries a
/// real CLR type (a value-typed nullable, e.g. <c>int32?</c>, is unaffected —
/// its own <c>Nullable&lt;T&gt;</c> instance members, like
/// <c>ToString</c>/<c>GetValueOrDefault</c>, are inherently null-safe to call
/// directly). It first defers to the exact same extension-method resolution
/// the general path already performs later in the method (so an extension
/// explicitly declared to accept a nilable receiver, e.g. <c>func (s
/// string?) OrEmpty() string</c>, keeps working unguarded), and only then
/// probes for an applicable member on the non-nullable underlying type,
/// reporting the same GS0159 diagnostic the user-defined-type path already
/// reports when one exists.
/// </para>
/// </summary>
public class Issue4287NullableClrInstanceCallTests
{
    [Fact]
    public void FiledRepro_NullableStringReceiver_ReportsMayBeNil()
    {
        // Verbatim shape from the filed issue. Before the fix this compiled
        // with ZERO diagnostics and threw NullReferenceException at runtime
        // (Demo.Holder.Use()) when run; RED against the pre-fix binder.
        var result = Evaluate(@"
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string {
        return this.name.ToUpper()
    }
}
let h = Holder(nil)
h.Use()
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("ToUpper", StringComparison.Ordinal));
        Assert.Null(result.UnhandledException);
    }

    [Fact]
    public void UnknownMemberOnNullableReceiver_StillReportsPlainCannotFindFunction()
    {
        // A genuinely missing member must keep the plain "Cannot find
        // function" message, not the nil-specific one — the applicability
        // probe added for #4287 must return false, not swallow this
        // diagnostic into the nil-check branch.
        var result = Evaluate(@"
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string {
        return this.name.NoSuchMethod()
    }
}
let h = Holder(nil)
h.Use()
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find function NoSuchMethod", StringComparison.Ordinal));
        Assert.DoesNotContain(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
    }

    [Fact]
    public void ImportedGenericCollection_NullableReceiver_ReportsMayBeNil()
    {
        // Broader CLR coverage than System.String: a nullable-receiver call
        // into an imported generic collection's instance method must be
        // caught the same way.
        var result = Evaluate(@"
class Holder {
    let items System.Collections.Generic.List[int32]?
}
func Use(h Holder) {
    h.items.Add(1)
}
Use(Holder{items: nil})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Add", StringComparison.Ordinal));
    }

    [Fact]
    public void UserDefinedMethod_NullableReceiver_StillReportsMayBeNil()
    {
        // Pure regression check: the pre-existing behavior for a
        // user-defined instance method through a nullable receiver (which
        // already worked before #4287) must be unaffected.
        var result = Evaluate(@"
class Animal { func Speak() string { return ""hi"" } }
class Holder { let pet Animal? }
func Use(h Holder) string { return h.pet.Speak() }
Use(Holder{pet: nil})
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
    }

    [Fact]
    public void NonNullableReceiver_PlainClrCall_CompilesCleanly()
    {
        var result = Evaluate(@"
func Shout() string {
    let s string = ""abc""
    return s.ToUpper()
}
Shout()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ABC", result.Value);
    }

    [Fact]
    public void NullConditionalAccess_NullableClrReceiver_CompilesCleanly()
    {
        var result = Evaluate(@"
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string? {
        return this.name?.ToUpper()
    }
}
Holder(nil).Use()
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfLetNarrowedReceiver_NullableClrReceiver_CompilesCleanly()
    {
        var result = Evaluate(@"
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string {
        if let n = this.name {
            return n.ToUpper()
        }
        return ""none""
    }
}
Holder(""abc"").Use()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ABC", result.Value);
    }

    [Fact]
    public void NullAssertedReceiver_NullableClrReceiver_CompilesCleanly()
    {
        var result = Evaluate(@"
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string {
        return this.name!!.ToUpper()
    }
}
Holder(""abc"").Use()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ABC", result.Value);
    }

    [Fact]
    public void SmartCastNarrowedReceiver_NullableClrReceiver_CompilesCleanly()
    {
        var result = Evaluate(@"
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string {
        if this.name != nil {
            return this.name.ToUpper()
        }
        return ""none""
    }
}
Holder(""abc"").Use()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ABC", result.Value);
    }

    [Fact]
    public void ValueTypeNullableReceiver_OwnInstanceMember_CompilesCleanly()
    {
        // Nullable<T>'s own instance members (ToString/GetValueOrDefault/...)
        // are inherently null-safe to call directly; this class of receiver
        // is deliberately unaffected by the #4287 fix.
        var result = Evaluate(@"
func Use() int32 {
    let x int32? = 5
    return x.GetValueOrDefault()
}
Use()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void ExtensionDeclaredOnNullableReceiverType_CompilesCleanlyWithoutNarrowing()
    {
        // An extension explicitly declared to accept a nilable receiver must
        // stay callable unguarded — this is the false-positive the first
        // version of the #4287 fix introduced and this test guards against.
        var result = Evaluate(@"
func (s string?) OrEmpty() string { return s ?? """" }
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string {
        return this.name.OrEmpty()
    }
}
Holder(nil).Use()
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(string.Empty, result.Value);
    }

    [Fact]
    public void ExtensionDeclaredOnNonNullableUnderlyingType_NullableReceiver_ReportsMayBeNil()
    {
        // The mirror image: an extension declared for the NON-nullable
        // underlying type still requires the receiver to be proven non-nil
        // first, exactly like an own-surface CLR instance member.
        var result = Evaluate(@"
func (s string) Shout() string { return s.ToUpper() }
class Holder {
    let name string?
    init(n string?) { this.name = n }
    func Use() string {
        return this.name.Shout()
    }
}
Holder(nil).Use()
");

        Assert.Contains(result.Diagnostics, d => d.Message.Contains("may be nil", StringComparison.Ordinal));
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Shout", StringComparison.Ordinal));
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
