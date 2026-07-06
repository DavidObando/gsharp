// <copyright file="Issue2202UnguardedTernaryArmForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2202: an UNGUARDED nullable-tainted
/// field/property arm in a ternary/switch expression whose enclosing
/// property/method return type is deliberately kept non-null (the oblivious
/// analyzer's property-contract / forwarding-exclusion guardrail, issues
/// #1354 / #2167), when a SIBLING arm is already null-guard-narrowed.
/// The original C# accepted this implicitly (oblivious), and the sibling arm
/// is already asserted; forgiving this arm too is the minimal safe assertion.
/// </summary>
public class Issue2202UnguardedTernaryArmForgivenessTranslationTests
{
    /// <summary>
    /// Positive test: mirrors the Oahu.Data `BookCommon` shape — an
    /// interface-implementing property with a ternary whose guarded arm (Book)
    /// gets `!!` via <c>IsNullGuardNarrowedFieldUse</c> and whose UNGUARDED
    /// sibling arm (Component) must also get `!!` to compile the property's
    /// non-null return type.
    /// </summary>
    [Fact]
    public void NonContractGetter_Ternary_UnguardedSiblingArm_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface ICommon { }
    public class Book : ICommon { }
    public class Component : ICommon { }

    public class Entity : ICommon
    {
        public Book Book { get; set; }
        public Component Component { get; set; }

        // Taint Book via a null-check elsewhere:
        public string BookName => Book == null ? ""none"" : Book.ToString();

        // Taint Component via a null-check elsewhere:
        public string CompName => Component == null ? ""none"" : Component.ToString();

        // The target property: non-null return (does not override/implement an
        // interface member for ICommon.Common, since ICommon has no such member).
        // The ternary returns Book (guarded by `Book == null` on the else arm)
        // and Component (unguarded).
        public ICommon Common => Book == null ? Component : Book;
    }
}");

        // Both arms must be asserted with !! for the property to compile.
        int commonPropIndex = printed.IndexOf("prop Common ICommon", StringComparison.Ordinal);
        Assert.True(commonPropIndex >= 0, "Expected to find 'prop Common ICommon' in output:\n" + printed);
        string afterCommon = printed.Substring(commonPropIndex);

        // The guarded arm (Book in else position) must be asserted.
        Assert.Contains("Book!!", afterCommon);

        // The unguarded arm (Component in if-true position) must ALSO be asserted.
        Assert.Contains("Component!!", afterCommon);
    }

    /// <summary>
    /// Positive test: same shape but with a block-bodied getter (return
    /// statement wrapping the ternary) — confirms the fix works when the
    /// conditional is not directly the arrow body.
    /// </summary>
    [Fact]
    public void NonContractGetter_BlockBodyReturn_UnguardedSiblingArm_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IItem { }
    public class Primary : IItem { }
    public class Fallback : IItem { }

    public class Container
    {
        public Primary Primary { get; set; }
        public Fallback Fallback { get; set; }

        // Taint Primary via null-check:
        public bool HasPrimary => Primary != null;

        // Taint Fallback via null-check:
        public bool HasFallback => Fallback != null;

        // Block-bodied getter returning a ternary (property, not method).
        public IItem Current
        {
            get
            {
                return Primary == null ? Fallback : Primary;
            }
        }
    }
}");

        int currentIndex = printed.IndexOf("prop Current IItem", StringComparison.Ordinal);
        Assert.True(currentIndex >= 0, "Expected to find 'prop Current IItem' in output:\n" + printed);
        string afterCurrent = printed.Substring(currentIndex);

        Assert.Contains("Primary!!", afterCurrent);
        Assert.Contains("Fallback!!", afterCurrent);
    }

    /// <summary>
    /// Negative test: an unguarded nullable-tainted field in a ternary that
    /// is NOT in a return-preserving context (the property's return type IS
    /// promoted to nullable by the analyzer) must NOT get blindly forgiven.
    /// This ensures the fix is properly scoped.
    /// </summary>
    [Fact]
    public void PromotedNullableReturnType_UnguardedArm_IsNotAsserted()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class Holder
    {
        public string X { get; set; }
        public string Y { get; set; }

        // Taint X via null-usage:
        public string TaintX => X == null ? ""default"" : X;

        // Taint Y via null-usage:
        public string TaintY => Y == null ? ""default"" : Y;

        // This property has a DIRECTLY nullable body (null literal arm in
        // another method causes Y to be tainted, and X's null-check in
        // condition ALSO taints X), so the analyzer will look at the ternary
        // and may promote. But the key test: a property whose body IS a
        // ternary where NEITHER arm is guarded for its own symbol should
        // NOT get blanket forgiveness.
        public string Unrelated()
        {
            // Y is used bare here — no guard on Y in this context.
            // This should NOT get !! because the method's return type IS
            // promoted (the method returns Y which is tainted, transitively).
            return Y;
        }
    }
}");

        // The Unrelated() method's bare return of Y should NOT get `!!` —
        // it's not in a ternary with a sibling null-guarded arm.
        int unrelatedIndex = printed.IndexOf("func Unrelated()", StringComparison.Ordinal);
        Assert.True(unrelatedIndex >= 0, "Expected to find 'func Unrelated()' in output:\n" + printed);
        string afterUnrelated = printed.Substring(unrelatedIndex);
        string unrelatedBody = afterUnrelated.Substring(0, afterUnrelated.IndexOf('\n', afterUnrelated.IndexOf('\n') + 1) + 1);
        Assert.DoesNotContain("Y!!", unrelatedBody);
    }

    /// <summary>
    /// Negative test: two unguarded nullable fields in a ternary arm where
    /// the condition does NOT null-check either field — no sibling is
    /// null-guard-narrowed, so neither arm should be blindly forgiven.
    /// </summary>
    [Fact]
    public void NoSiblingGuarded_UnguardedArms_AreNotAsserted()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public interface IVal { }
    public class Alpha : IVal { }
    public class Beta : IVal { }

    public class NoGuard
    {
        public Alpha A { get; set; }
        public Beta B { get; set; }
        public bool Flag { get; set; }

        // Taint A via null-check elsewhere:
        public bool HasA => A != null;

        // Taint B via null-check elsewhere:
        public bool HasB => B != null;

        // The condition checks `Flag`, NOT a null-check on A or B.
        // Neither arm is null-guard-narrowed → no forgiveness should fire.
        public IVal Pick => Flag ? A : B;
    }
}");

        int pickIndex = printed.IndexOf("prop Pick", StringComparison.Ordinal);
        Assert.True(pickIndex >= 0, "Expected to find 'prop Pick' in output:\n" + printed);
        string afterPick = printed.Substring(pickIndex);

        // Look at just the Pick property line(s) — neither A nor B should get !!
        // because neither is null-guard-narrowed (condition is `Flag`, not a
        // null-check on A or B).
        string pickLine = afterPick.Substring(0, afterPick.IndexOf('\n') + 1);
        Assert.DoesNotContain("A!!", pickLine);
        Assert.DoesNotContain("B!!", pickLine);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
