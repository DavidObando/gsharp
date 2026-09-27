// <copyright file="Issue4292UnscopedRefSlotContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #4292: definition-side <c>@UnscopedRef</c> slot contracts.</summary>
public class Issue4292UnscopedRefSlotContractTests
{
    [Theory]
    [InlineData("")]
    [InlineData("private func (IRefSlot) Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    public void AnnotatedInterfaceMethod_AllowsAnnotatedImplementation(string explicitImplementation)
    {
        var implementation = explicitImplementation.Length == 0
            ? "public func Slot(ref fallback int32) ref int32 { return ref this.Value }"
            : explicitImplementation;
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    func Slot(ref fallback int32) ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    " + implementation + @"
}
";

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("public func Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    [InlineData("private func (IRefSlot) Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    public void UnannotatedInterfaceMethod_RejectsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    func Slot(ref fallback int32) ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    " + implementation + @"
}
";

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Contains(
            "implemented member 'IRefSlot.Slot' does not have this attribute",
            diagnostic.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void AnnotatedInterfaceMethod_AllowsImplementationToRemoveContract()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    func Slot(ref value int32) ref int32;
}
struct Buffer : IRefSlot {
    public func Slot(ref value int32) ref int32 { return ref value }
}
";

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UnannotatedInterfaceMethod_WithValueReturnAndNoAdditionalParameter_IsIrrelevant()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IValue {
    func Get() int32;
}
struct Value : IValue {
    @UnscopedRef
    public func Get() int32 { return 0 }
}
";

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void SameSignatureWithoutImplementedInterface_RemainsLegal()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    func Slot(ref fallback int32) ref int32;
}
struct Buffer {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
";

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void StructOverride_WithIrrelevantReturn_DoesNotReportPlacementDiagnostic()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
struct Buffer {
    @UnscopedRef
    override func ToString() string { return ""Buffer"" }
}
";

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("public prop Slot Span[int32] { set { } }")]
    [InlineData("private prop (IRefSlot) Slot Span[int32] { set { } }")]
    public void AnnotatedInterfaceProperty_AllowsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    prop Slot Span[int32] { set; }
}
ref struct Buffer : IRefSlot {
    @UnscopedRef
    " + implementation + @"
}
";

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("public prop Slot Span[int32] { set { } }")]
    [InlineData("private prop (IRefSlot) Slot Span[int32] { set { } }")]
    public void UnannotatedInterfaceProperty_RejectsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    prop Slot Span[int32] { set; }
}
ref struct Buffer : IRefSlot {
    @UnscopedRef
    " + implementation + @"
}
";

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Contains(
            "implemented property 'IRefSlot.Slot'",
            diagnostic.Message,
            StringComparison.Ordinal);
        Assert.Contains("does not have this attribute", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("", "", false)]
    [InlineData("ref other int32", "", true)]
    [InlineData("in other int32", "", true)]
    [InlineData("out other int32", "other = 0", true)]
    [InlineData("view Span[int32]", "", true)]
    public void RefReturn_RelevanceRequiresAnAdditionalParameter(
        string parameters,
        string bodyPrefix,
        bool expectContractDiagnostic)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    func Slot(" + parameters + @") ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    public func Slot(" + parameters + @") ref int32 {
        " + bodyPrefix + @"
        return ref this.Value
    }
}
";

        Assert.Equal(expectContractDiagnostic, Bind(source).Any(d => d.Id == "GS0590"));
    }

    [Theory]
    [InlineData("ref view Span[int32]", "", true)]
    [InlineData("scoped ref view Span[int32]", "", false)]
    [InlineData("scoped out view Span[int32]", "view = default(Span[int32])", true)]
    [InlineData("out view Span[int32]", "view = default(Span[int32])", false)]
    [InlineData("out view Span[int32], in other int32", "view = default(Span[int32])", true)]
    public void RefStructParameter_RelevanceMatchesCSharp(
        string parameters,
        string body,
        bool expectContractDiagnostic)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IStore {
    func Store(" + parameters + @");
}
struct Buffer : IStore {
    @UnscopedRef
    public func Store(" + parameters + @") {
        " + body + @"
    }
}
";

        Assert.Equal(expectContractDiagnostic, Bind(source).Any(d => d.Id == "GS0590"));
    }

    [Fact]
    public void OneImplementationOfMultipleUnannotatedSlots_ReportsOnce()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IA { func Slot(ref fallback int32) ref int32; }
interface IB { func Slot(ref fallback int32) ref int32; }
struct Buffer : IA, IB {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
";

        Assert.Single(Bind(source), d => d.Id == "GS0590");
    }

    [Fact]
    public void DistinctIncompatibleImplementations_ReportSeparately()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlots {
    func First(ref fallback int32) ref int32;
    func Second(ref fallback int32) ref int32;
}
struct Buffer : IRefSlots {
    var Value int32

    @UnscopedRef
    public func First(ref fallback int32) ref int32 { return ref this.Value }

    @UnscopedRef
    public func Second(ref fallback int32) ref int32 { return ref this.Value }
}
";

        Assert.Equal(2, Bind(source).Count(d => d.Id == "GS0590"));
    }

    [Fact]
    public void ImportedInterfaceContracts_AreReadFromMethodMetadata()
    {
        var rejected = BindWithFixtures(@"
package P
import System.Diagnostics.CodeAnalysis
import GSharp.Core.Tests.Fixtures
struct Buffer : Issue4292ImportedInterface {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
");
        Assert.Single(rejected, d => d.Id == "GS0590");

        var accepted = BindWithFixtures(@"
package P
import System.Diagnostics.CodeAnalysis
import GSharp.Core.Tests.Fixtures
struct Buffer : Issue4292ImportedAnnotatedInterface {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
");
        Assert.Empty(accepted);
    }

    [Fact]
    public void ImportedSymbolicGenericInterface_EnforcesContract()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import GSharp.Core.Tests.Fixtures
class Token { }
struct Buffer : Issue4292ImportedGenericInterface[Token] {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32, value Token) ref int32 { return ref this.Value }
}
";

        var diagnostic = Assert.Single(BindWithFixtures(source), d => d.Id == "GS0590");
        Assert.Contains("Issue4292ImportedGenericInterface", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedRefProperty_WithoutAdditionalParameter_IsIrrelevant()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import GSharp.Core.Tests.Fixtures
struct Buffer : Issue4292ImportedRefProperty {
    var Value int32

    @UnscopedRef
    public prop Slot ref int32 { get { return ref this.Value } }
}
";

        Assert.Empty(BindWithFixtures(source));
    }

    [Fact]
    public void ImportedIndexerGetterContract_IsEnforced()
    {
        const string implementation = """
            ref struct Buffer : $INTERFACE$ {
                var Value int32

                @UnscopedRef
                public prop this[view Issue4292RefValue] ref int32 {
                    get { return ref this.Value }
                }
            }
            """;
        var prefix = """
            package P
            import System
            import System.Diagnostics.CodeAnalysis
            import GSharp.Core.Tests.Fixtures
            """;

        Assert.Empty(BindWithFixtures(
            prefix + Environment.NewLine + implementation.Replace(
                "$INTERFACE$",
                "Issue4292ImportedGetterIndexer",
                StringComparison.Ordinal)));
        Assert.Single(
            BindWithFixtures(
                prefix + Environment.NewLine + implementation.Replace(
                    "$INTERFACE$",
                    "Issue4292ImportedUnannotatedIndexer",
                    StringComparison.Ordinal)),
            d => d.Id == "GS0590");
    }

    [Fact]
    public void ImportedSetterOnlyContract_IsReadFromSetterMetadata()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import GSharp.Core.Tests.Fixtures
ref struct Buffer : Issue4292ImportedSetterProperty {
    @UnscopedRef
    public prop Slot Issue4292RefValue { set { } }
}
";

        Assert.Empty(BindWithFixtures(source));
    }

    [Fact]
    public void ImportedSetterOnlyContract_IsReadFromPropertyMetadata()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import GSharp.Core.Tests.Fixtures
ref struct Buffer : Issue4292ImportedPropertyAnnotatedSetter {
    @UnscopedRef
    public prop Slot Issue4292RefValue { set { } }
}
";

        Assert.Empty(BindWithFixtures(source));
    }

    [Fact]
    public void InvalidClassPlacement_SuppressesImportedOverrideContractDiagnostic()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import GSharp.Core.Tests.Fixtures
class Derived : Issue4292ImportedBase, Issue4292ImportedInterface {
    @UnscopedRef
    override func Slot(ref fallback int32) ref int32 { return ref fallback }
}
";

        var diagnostic = Assert.Single(BindWithFixtures(source), d => d.Id == "GS0590");
        Assert.Contains("requires a struct instance member", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("overridden member", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("implemented member", diagnostic.Message, StringComparison.Ordinal);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }

    private static ImmutableArray<Diagnostic> BindWithFixtures(string source)
    {
        var fixturePath = typeof(GSharp.Core.Tests.Fixtures.Issue4292ImportedInterface).Assembly.Location;
        using var resolver = ReferenceResolver.WithReferences(new[] { fixturePath });
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            resolver);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver);
        return tree.Diagnostics
            .Concat(globalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
