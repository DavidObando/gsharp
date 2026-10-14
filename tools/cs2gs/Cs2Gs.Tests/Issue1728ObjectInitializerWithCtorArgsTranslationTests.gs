// <copyright file="Issue1728ObjectInitializerWithCtorArgsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translator-fidelity tests for issue #1728 — `new Foo(x) { Bar = 2 }`
/// (an object initializer combined with constructor arguments) was silently
/// dropping the `Bar = 2` member assignment: the object-initializer
/// mapping was gated on `!hasCtorArgs` and neither the struct-zip nor the
/// bare `BuildConstruction` fallback looked at the initializer, and no
/// diagnostic fired. cs2gs must now emit gsc's construction-with-initializer-
/// suffix form (`Target(args) { Name = value, ... }`, issue #522) which
/// preserves both the constructor arguments and every member assignment.
/// The same hole existed (independently) in the target-typed
/// `new(x) { Bar = 2 }` path; both now share one core method.
open class Issue1728ObjectInitializerWithCtorArgsTranslationTests {
    @Fact
    func ImportedReferenceClassNoArgsObjectInitializer_EmitsCompositeLiteral() {
        let printed = TranslateUnit(`
using System.Text;
namespace Demo
{
    public class C
    {
        public StringBuilder Make() => new StringBuilder { Capacity = 2 };
    }
}`)
        Assert.Contains("StringBuilder{Capacity: 2}", printed)
        Assert.DoesNotContain("StringBuilder(){", printed)
    }

    @Fact
    func ExplicitNew_CtorArgsPlusObjectInitializer_EmitsConstructionSuffix() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Foo
    {
        public int X { get; }
        public int Bar { get; set; }
        public Foo(int x) { X = x; }
    }

    public class C
    {
        public Foo Make(int x) => new Foo(x) { Bar = 2 };
    }
}`)
        Assert.Contains("Foo(x)", printed)
        Assert.Contains("Bar = 2", printed)
        Assert.DoesNotContain("Bar: 2", printed)
    }

    @Fact
    func ImplicitNew_CtorArgsPlusObjectInitializer_EmitsConstructionSuffix() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Foo
    {
        public int X { get; }
        public int Bar { get; set; }
        public Foo(int x) { X = x; }
    }

    public class C
    {
        public Foo Make(int x) { Foo f = new(x) { Bar = 2 }; return f; }
    }
}`)
        Assert.Contains("Bar = 2", printed)
        Assert.DoesNotContain("Bar: 2", printed)
    }

    @Fact
    func CtorArgsPlusMultiMemberObjectInitializer_EmitsAllAssignments() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Foo
    {
        public int X { get; }
        public int Bar { get; set; }
        public string Baz { get; set; }
        public Foo(int x) { X = x; }
    }

    public class C
    {
        public Foo Make(int x) => new Foo(x) { Bar = 2, Baz = "hi" };
    }
}`)
        Assert.Contains("Bar = 2", printed)
        Assert.Contains("Baz = \"hi\"", printed)
    }

    @Fact
    func CtorArgsPlusObjectInitializer_NoCtorArgsStillUsesStructLiteral() {
        // No-ctor-arg case must be unaffected: still the colon struct literal.
        let printed = TranslateUnit(`
namespace Demo
{
    public class Foo
    {
        public int Bar { get; set; }
    }

    public class C
    {
        public Foo Make() => new Foo { Bar = 2 };
    }
}`)
        Assert.Contains("Bar: 2", printed)
    }

    @Fact
    func CtorArgsPlusNestedCollectionInitializerMember_EmitsFaithfulSuffix() {
        // Issue #1858 (follow-up to #1728): gsc's construction-with-
        // initializer-suffix form now carries the same target-less
        // collection-initializer carve-out as the colon struct-literal form
        // (issue #1567), so a nested `Items = { 1, 2 }` member combined with
        // constructor arguments AND another scalar member (`Bar = 2`) is
        // translated faithfully — no member is silently dropped.
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public class Foo
    {
        public int X { get; }
        public int Bar { get; set; }
        public List<int> Items { get; } = new();
        public Foo(int x) { X = x; }
    }

    public class C
    {
        public Foo Make(int x) => new Foo(x) { Items = { 1, 2 }, Bar = 2 };
    }
}`)
        Assert.Contains("Foo(x)", printed)
        Assert.Contains("Items = { 1, 2 }", printed)
        Assert.Contains("Bar = 2", printed)
    }

    @Fact
    func CtorArgsPlusNestedObjectInitializerMember_PreservesMemberAssignments() {
        let (printed, context) = TranslateUnitWithContext(`
namespace Demo
{
    public class Sub
    {
        public int X { get; set; }
        public int Y { get; set; }
    }

    public class Foo
    {
        public int X { get; }
        public Sub Sub { get; } = new Sub();
        public Foo(int x) { X = x; }
    }

    public class C
    {
        public Foo Make(int x) => new Foo(x) { Sub = { X = 1, Y = 2 } };
    }
}`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("Foo(x)", printed)
        Assert.True(
            printed.Contains("Sub = {", StringComparison.Ordinal) && printed.Contains(
                "X = 1",
                StringComparison.Ordinal
            ) &&
                printed.Contains("Y = 2", StringComparison.Ordinal),
            printed
        )
    }

    @Fact
    func TargetTypedConditionalNullDelegateArm_EmitsTypedDefault() {
        let printed = TranslateUnit(`
namespace Demo
{
    public interface IService { }

    public class Screen
    {
        public Screen(System.Func<IService>? factory) { }
    }

    public class C
    {
        public Screen Make(IService? service) =>
            new Screen(service is null ? null : () => service);
    }
}`)
        Assert.Contains("default(", printed)
        Assert.DoesNotContain("if service == nil { nil }", printed)
    }

    @Fact
    func XunitNullAssertion_DoesNotDereferenceNullableArgument() {
        let printed = TranslateUnit(`
namespace Xunit
{
    public static class Assert
    {
        public static void Null(object? value) { }
    }
}

namespace Demo
{
    public class C
    {
        public void Check(string? value) => Xunit.Assert.Null(value);
    }
}`)
        Assert.Contains("Assert.Null(value)", printed)
        Assert.DoesNotContain("Assert.Null(value!!)", printed)
    }

    @Fact
    func NullableOptionalParameter_PassedToPromotedNullableParameter_IsNotDereferenced() {
        let printed = TranslateUnit(`
#nullable disable
namespace Demo
{
    public interface IService { }

    public class C
    {
        public C(IService service = null)
        {
            SetService(service);
        }

        public void SetService(IService service)
        {
            if (service is null) { }
        }
    }
}`)
        Assert.Contains("SetService(service)", printed)
        Assert.DoesNotContain("SetService(service!!)", printed)
    }

    @Fact
    func EntityExposedThroughDbSet_IsEmittedOpenForEfProxying() {
        let printed = TranslateUnit(`
namespace Microsoft.EntityFrameworkCore
{
    public class DbSet<T> { }
}

namespace Demo
{
    using Microsoft.EntityFrameworkCore;

    public class Account
    {
        public int Id { get; set; }
        public string Alias { get; set; }
    }

    public class Context
    {
        public DbSet<Account> Accounts { get; set; }
    }
}`)
        Assert.Contains("open class Account", printed)
        Assert.Contains("prop Alias string?", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let (printed, _) = TranslateUnitWithContext(source)
            return printed
        }

        private func TranslateUnitWithContext(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context)
        }
    }
}
