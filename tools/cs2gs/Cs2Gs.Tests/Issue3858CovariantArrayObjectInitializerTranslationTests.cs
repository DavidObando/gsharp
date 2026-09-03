// <copyright file="Issue3858CovariantArrayObjectInitializerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3858 (the <c>test/Sdk.Tests</c> self-migration wall): a C#
/// object-initializer member is an ASSIGNMENT position, so C# applies the same
/// implicit array-covariance conversion there it applies to a plain assignment
/// (<c>Compile = new[] { new TaskItem("Program.gs") }</c> into an
/// <c>ITaskItem[]</c> property). Issue #3685 taught the translator to spell that
/// upcast as <c>cast[[]Base](expr)</c> — G# slices are invariant by design
/// (#2516) — but only at the argument / return / local-initializer /
/// assignment-statement positions; the two object-initializer member builders
/// dropped the conversion, and gsc reported GS0156 on every site.
/// </summary>
public class Issue3858CovariantArrayObjectInitializerTranslationTests
{
    [Fact]
    public void CovariantArray_ObjectInitializerMember_EmitsExplicitCast()
    {
        // The wall's exact shape, with `IComparable`/`string` standing in for
        // `ITaskItem`/`TaskItem`: a DERIVED-element array assigned to a member
        // whose type has the BASE element, through an imported interface.
        string rendered = Render(@"
using System;

namespace Corpus.Issue3858
{
    public class Holder
    {
        public IComparable[] Items { get; set; }
    }

    public static class Maker
    {
        public static Holder Make(string[] names)
        {
            return new Holder { Items = names };
        }
    }
}
");

        Assert.Contains("Items: cast[[]IComparable](names)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CovariantArray_ConstructionWithInitializerSuffix_EmitsExplicitCast()
    {
        // The `new T(args) { Field = value }` form is built by a second,
        // independent member loop (issue #1728) — it needed the same fix.
        string rendered = Render(@"
using System;

namespace Corpus.Issue3858
{
    public class Holder
    {
        public Holder(int capacity) { }

        public IComparable[] Items { get; set; }
    }

    public static class Maker
    {
        public static Holder Make(string[] names)
        {
            return new Holder(1) { Items = names };
        }
    }
}
");

        Assert.Contains("Items = cast[[]IComparable](names)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CovariantArray_ObjectInitializerFieldMember_EmitsExplicitCast()
    {
        // Fields take the same path as properties, and an inline `new[] { … }`
        // (the literal shape every failing Sdk.Tests site uses) is the operand,
        // not a named local.
        string rendered = Render(@"
using System;

namespace Corpus.Issue3858
{
    public class Holder
    {
        public IComparable[] Items;
    }

    public static class Maker
    {
        public static Holder Make()
        {
            return new Holder { Items = new[] { ""alpha"" } };
        }
    }
}
");

        Assert.Contains("cast[[]IComparable](", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SameElementArray_ObjectInitializerMember_IsNotWrapped()
    {
        // No conversion happens, so the member value must stay bare — the guard
        // that keeps the cast off every array-typed initializer in the corpus.
        string rendered = Render(@"
using System;

namespace Corpus.Issue3858
{
    public class Holder
    {
        public string[] Items { get; set; }
    }

    public static class Maker
    {
        public static Holder Make(string[] names)
        {
            return new Holder { Items = names };
        }
    }
}
");

        Assert.Contains("Items: names", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("cast[", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ValueElementArray_ObjectInitializerMember_IsNotWrapped()
    {
        // Anti-vacuity: C# array covariance is REFERENCE-element-only —
        // `int[] -> object[]` is not a conversion C# performs at all, so a
        // value-element array flowing into an `int[]` member must not acquire a
        // cast (and no `[]int32 -> []object` upcast may be manufactured here).
        string rendered = Render(@"
namespace Corpus.Issue3858
{
    public class Holder
    {
        public int[] Values { get; set; }
    }

    public static class Maker
    {
        public static Holder Make(int[] values)
        {
            return new Holder { Values = values };
        }
    }
}
");

        Assert.Contains("Values: values", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("cast[", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse and bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
