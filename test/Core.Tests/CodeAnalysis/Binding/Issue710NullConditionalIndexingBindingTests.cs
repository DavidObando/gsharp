// <copyright file="Issue710NullConditionalIndexingBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #710 / ADR-0073: binder-level coverage for <c>a?[i]</c>
/// null-conditional indexing. Validates the new diagnostics
/// (GS0300 non-nullable receiver, GS0301 assignment-LHS rejection),
/// the lifting rule (T → T?, T? → T?), and chain composition with
/// <c>?.</c>.
/// </summary>
public class Issue710NullConditionalIndexingBindingTests
{
    [Fact]
    public void Accepts_NullableSlice_Receiver()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var a []?int32 = nil
                var x = a?[0]
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Accepts_NullableMap_Receiver()
    {
        var diagnostics = Bind("""
            package P
            import System.Collections.Generic
            func F() {
                var d Dictionary[string, int32]? = nil
                var x = d?["k"]
            }
            """);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Result_Is_Nullable_Form_Of_Element_Type()
    {
        // `a?[0]` where a is `[]?int32` (slice of int32, nullable slice)
        // should give `int32?` for the read result.
        var program = BindProgramFor("""
            package P
            func F() int32? {
                var a []?int32 = nil
                return a?[0]
            }
            """);
        Assert.Empty(program.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void Chained_NullConditional_Member_Then_Index_Binds()
    {
        // `a?.b?[i]` must compose two null-conditional captures without error
        // when the type chain supports it.
        var diagnostics = Bind("""
            package P
            class Holder {
                var Data []?int32
            }
            func F() {
                var h Holder? = Holder{Data: []int32{1, 2, 3}}
                var x = h?.Data?[0]
            }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void Reports_GS0300_When_Receiver_Is_NonNullable_Slice()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var a []int32 = []int32{1, 2, 3}
                var x = a?[0]
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0300");
    }

    [Fact]
    public void GS0300_Is_A_Warning_Not_An_Error()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var a []int32 = []int32{1, 2, 3}
                var x = a?[0]
            }
            """);
        var diag = diagnostics.Single(d => d.Id == "GS0300");
        Assert.Equal(DiagnosticSeverity.Warning, diag.Severity);
    }

    [Fact]
    public void Reports_GS0301_When_NullConditionalIndex_Is_Assignment_LHS()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var a []?int32 = nil
                a?[0] = 1
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0301");
    }

    [Fact]
    public void Reports_GS0301_When_NullConditionalIndex_Is_CompoundAssignment_LHS()
    {
        var diagnostics = Bind("""
            package P
            func F() {
                var a []?int32 = nil
                a?[0] += 1
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0301");
    }

    [Fact]
    public void Reports_Invalid_Target_When_NullConditionalIndex_Is_NullCoalescingAssignment_LHS()
    {
        // `a?[0] ??= 1` lands in the ??= statement path; the binder rejects
        // the unrecognized lvalue shape with GS0299.
        var diagnostics = Bind("""
            package P
            func F() {
                var a []?int32 = nil
                a?[0] ??= 1
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0299" || d.Id == "GS0301");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any(d => d.IsError))
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any(d => d.IsError))
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }

    private static BoundProgram BindProgramFor(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return Binder.BindProgram(globalScope);
    }
}
