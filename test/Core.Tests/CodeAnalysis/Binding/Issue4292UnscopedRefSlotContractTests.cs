// <copyright file="Issue4292UnscopedRefSlotContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
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
    public void UnannotatedInterfaceMethod_WithValueReturn_StillRejectsAnnotatedImplementation()
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

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
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
    [InlineData("public prop Slot int32 { get { return 0 } }")]
    [InlineData("private prop (IRefSlot) Slot int32 { get { return 0 } }")]
    public void AnnotatedInterfaceProperty_AllowsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    prop Slot int32 { get; }
}
struct Buffer : IRefSlot {
    @UnscopedRef
    " + implementation + @"
}
";

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("public prop Slot int32 { get { return 0 } }")]
    [InlineData("private prop (IRefSlot) Slot int32 { get { return 0 } }")]
    public void UnannotatedInterfaceProperty_RejectsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    prop Slot int32 { get; }
}
struct Buffer : IRefSlot {
    @UnscopedRef
    " + implementation + @"
}
";

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
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
}
