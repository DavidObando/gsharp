// <copyright file="Issue1728ObjectInitializerWithCtorArgsTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #1728 — <c>new Foo(x) { Bar = 2 }</c>
/// (an object initializer combined with constructor arguments) was silently
/// dropping the <c>Bar = 2</c> member assignment: the object-initializer
/// mapping was gated on <c>!hasCtorArgs</c> and neither the struct-zip nor the
/// bare <c>BuildConstruction</c> fallback looked at the initializer, and no
/// diagnostic fired. cs2gs must now emit gsc's construction-with-initializer-
/// suffix form (<c>Target(args) { Name = value, ... }</c>, issue #522) which
/// preserves both the constructor arguments and every member assignment.
/// The same hole existed (independently) in the target-typed
/// <c>new(x) { Bar = 2 }</c> path; both now share one core method.
/// </summary>
public class Issue1728ObjectInitializerWithCtorArgsTranslationTests
{
    [Fact]
    public void ReferenceClassNoArgsObjectInitializer_EmitsConstructionSuffix()
    {
        string printed = TranslateUnit(@"
using System.Text;
namespace Demo
{
    public class C
    {
        public StringBuilder Make() => new StringBuilder { Capacity = 2 };
    }
}");

        Assert.Contains("StringBuilder()", printed);
        Assert.Contains("Capacity = 2", printed);
        Assert.DoesNotContain("StringBuilder{Capacity:", printed);
    }

    [Fact]
    public void ExplicitNew_CtorArgsPlusObjectInitializer_EmitsConstructionSuffix()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("Foo(x)", printed);
        Assert.Contains("Bar = 2", printed);
        Assert.DoesNotContain("Bar: 2", printed);
    }

    [Fact]
    public void ImplicitNew_CtorArgsPlusObjectInitializer_EmitsConstructionSuffix()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("Bar = 2", printed);
        Assert.DoesNotContain("Bar: 2", printed);
    }

    [Fact]
    public void CtorArgsPlusMultiMemberObjectInitializer_EmitsAllAssignments()
    {
        string printed = TranslateUnit(@"
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
        public Foo Make(int x) => new Foo(x) { Bar = 2, Baz = ""hi"" };
    }
}");

        Assert.Contains("Bar = 2", printed);
        Assert.Contains("Baz = \"hi\"", printed);
    }

    [Fact]
    public void CtorArgsPlusObjectInitializer_NoCtorArgsStillUsesStructLiteral()
    {
        // No-ctor-arg case must be unaffected: still the colon struct literal.
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("Bar: 2", printed);
    }

    [Fact]
    public void CtorArgsPlusNestedCollectionInitializerMember_EmitsFaithfulSuffix()
    {
        // Issue #1858 (follow-up to #1728): gsc's construction-with-
        // initializer-suffix form now carries the same target-less
        // collection-initializer carve-out as the colon struct-literal form
        // (issue #1567), so a nested `Items = { 1, 2 }` member combined with
        // constructor arguments AND another scalar member (`Bar = 2`) is
        // translated faithfully — no member is silently dropped.
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("Foo(x)", printed);
        Assert.Contains("Items = { 1, 2 }", printed);
        Assert.Contains("Bar = 2", printed);
    }

    [Fact]
    public void CtorArgsPlusNestedObjectInitializerMember_PreservesMemberAssignments()
    {
        (string printed, TranslationContext context) = TranslateUnitWithContext(@"
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
}");

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("Foo(x)", printed);
        Assert.True(
            printed.Contains("Sub = {", StringComparison.Ordinal) &&
            printed.Contains("X = 1", StringComparison.Ordinal) &&
            printed.Contains("Y = 2", StringComparison.Ordinal),
            printed);
    }

    [Fact]
    public void TargetTypedConditionalNullDelegateArm_EmitsTypedDefault()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("default(", printed);
        Assert.DoesNotContain("if service == nil { nil }", printed);
    }

    [Fact]
    public void XunitNullAssertion_DoesNotDereferenceNullableArgument()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("Assert.Null(value)", printed);
        Assert.DoesNotContain("Assert.Null(value!!)", printed);
    }

    [Fact]
    public void NullableOptionalParameter_PassedToPromotedNullableParameter_IsNotDereferenced()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("SetService(service)", printed);
        Assert.DoesNotContain("SetService(service!!)", printed);
    }

    [Fact]
    public void EntityExposedThroughDbSet_IsEmittedOpenForEfProxying()
    {
        string printed = TranslateUnit(@"
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
}");

        Assert.Contains("open class Account", printed);
        Assert.Contains("prop Alias string?", printed);
    }

    private static string TranslateUnit(string source)
    {
        (string printed, _) = TranslateUnitWithContext(source);
        return printed;
    }

    private static (string Printed, TranslationContext Context) TranslateUnitWithContext(string source)
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
