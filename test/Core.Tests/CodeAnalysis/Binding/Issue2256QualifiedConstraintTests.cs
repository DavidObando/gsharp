// <copyright file="Issue2256QualifiedConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2256: cs2gs fully-qualifies type references, so a generic-math
/// constraint <c>where TCallback : INewSplitCallback&lt;TCallback&gt;</c> is
/// emitted as the G# constraint <c>[TCallback Oahu.Decrypt.INewSplitCallback[TCallback]]</c>.
/// Three gsc bugs combined to block this: (1) the parser rejected a dotted
/// type-parameter constraint (GS0005), (2) a reference-set qualified generic
/// type name failed to resolve (GS0113), and (3) a same-compilation
/// package-qualified source type failed to resolve (GS0113 / GS0157). These
/// tests pin the fixes.
/// </summary>
public class Issue2256QualifiedConstraintTests
{
    [Fact]
    public void DottedConstraint_Parses_WithoutDiagnostics()
    {
        const string source = """
            package P
            import System
            func Max[T System.IComparable[T]](a T, b T) T {
                if a.CompareTo(b) > 0 { return a }
                return b
            }
            """;

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var tp = FindFirstTypeParameter(tree);
        Assert.Equal("T", tp.Identifier.Text);
        Assert.NotNull(tp.ConstraintType);
        Assert.Equal("System", tp.Constraint.Text);
        Assert.Equal("System.IComparable", tp.ConstraintType.DottedName);
    }

    [Fact]
    public void SamePackage_QualifiedGenericSourceType_AsAnnotation_Binds()
    {
        const string source = """
            package A.B
            import System

            interface IFoo[T] {
                func Baz(x T) T;
            }

            func UseGen(f A.B.IFoo[int32]) int32 -> f.Baz(3)
            """;

        var compilation = Compile(source);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void SamePackage_QualifiedNonGenericSourceType_Binds()
    {
        const string source = """
            package A.B
            import System

            interface IPlain {
                func Bar(x int32) int32;
            }

            func UsePlain(f A.B.IPlain) int32 -> f.Bar(3)
            """;

        var compilation = Compile(source);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void SelfReferentialQualifiedCrtpConstraint_InPackage_Binds()
    {
        const string source = """
            package Oahu.Decrypt
            import System

            interface INewSplitCallback[TCallback] {
                func OnSplit(x TCallback) TCallback;
            }

            func Register[TCallback Oahu.Decrypt.INewSplitCallback[TCallback]](c TCallback, v TCallback) TCallback -> c.OnSplit(v)
            """;

        var compilation = Compile(source);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedSourceType_ConstructorCall_InExpression_Binds()
    {
        // cs2gs fully-qualifies constructor calls; the package prefix on a
        // same-compilation source type is redundant and must be peeled.
        const string source = """
            package Oahu.Decrypt
            import System

            class Mp4Operation[T] {
                func Hello() int32 -> 42
            }

            func Make() Oahu.Decrypt.Mp4Operation[int32] -> Oahu.Decrypt.Mp4Operation[int32]()
            """;

        var compilation = Compile(source);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedSourceType_StaticCallOnGenericType_InExpression_Binds()
    {
        // `Ns.Type[Args].StaticMethod(...)`: the generic type receiver parses as
        // an index expression, and the package prefix is redundant on a source
        // type. Fix 4b peels the prefix and binds the static call by simple name.
        const string source = """
            package Oahu.Decrypt
            import System

            class Mp4Operation[T] {
                shared {
                    func FromCompleted(x int32, y T?) Oahu.Decrypt.Mp4Operation[T] -> Oahu.Decrypt.Mp4Operation[T]()
                }
                func Hello() int32 -> 42
            }

            func Make() Oahu.Decrypt.Mp4Operation[int32] -> Oahu.Decrypt.Mp4Operation[int32].FromCompleted(3, nil)
            """;

        var compilation = Compile(source);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree) { IsLibrary = true };
    }

    private static TypeParameterSyntax FindFirstTypeParameter(SyntaxTree tree)
    {
        TypeParameterSyntax found = null;
        Walk(tree.Root);
        return found;

        void Walk(SyntaxNode node)
        {
            if (found != null)
            {
                return;
            }

            if (node is TypeParameterSyntax tp)
            {
                found = tp;
                return;
            }

            foreach (var c in node.GetChildren())
            {
                Walk(c);
            }
        }
    }
}
