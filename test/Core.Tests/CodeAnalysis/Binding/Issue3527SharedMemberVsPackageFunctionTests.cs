// <copyright file="Issue3527SharedMemberVsPackageFunctionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3527: inside a <c>shared</c> member body, an unqualified call whose
/// name collides with a same-named PACKAGE-level function must still resolve
/// to the enclosing type's own (possibly private) <c>shared</c> sibling
/// method — mirroring the qualified <c>Type.Method(...)</c> spelling and the
/// existing bare-call resolution for the no-collision case (issue #1585).
/// Before the fix, <see cref="OverloadResolution.OverloadResolver.BindCallExpression"/>
/// treated ANY same-named symbol found via <c>Scope.TryLookupSymbol</c> — not
/// just an extension function (issue #1566) — as a reason to skip the
/// implicit-static-self / implicit-this member lookup entirely, so the
/// same-named package function silently won with no diagnostic.
/// </summary>
public class Issue3527SharedMemberVsPackageFunctionTests
{
    [Fact]
    public void SharedMethodBareCall_PrefersOwnSharedSibling_OverSameNamedPackageFunction()
    {
        // The exact repro from the issue: a package-level `check` function
        // and a private shared `check` method on `Checks` collide by simple
        // name. The bare call inside `Run` must bind the type's own method.
        var helperTree = SyntaxTree.Parse(SourceText.From("""
            package FindingSharedMemberNameResolution

            func check() {
            }
            """));
        var mainTree = SyntaxTree.Parse(SourceText.From("""
            package FindingSharedMemberNameResolution

            class Checks {
              shared {
                private var count int32

                private func check() {
                  count++
                }

                public func Run() int32 {
                  check()
                  return count
                }
              }
            }
            """));

        var compilation = new Compilation(helperTree, mainTree);
        var program = compilation.BoundProgram;
        Assert.Empty(program.Diagnostics.Where(d => d.IsError));

        var checksStruct = program.Structs.Single(s => s.Name == "Checks");
        var runMethod = checksStruct.StaticMethods.Single(m => m.Name == "Run");
        var body = program.Functions[runMethod];

        var callStatement = (BoundExpressionStatement)body.Statements[0];
        var call = Assert.IsType<BoundCallExpression>(callStatement.Expression);

        // A package-level free function has no owning type; the shared
        // sibling's StaticOwnerType is the enclosing `Checks` struct.
        Assert.Same(checksStruct, call.Function.StaticOwnerType);
        Assert.True(call.Function.IsStatic);
    }

    [Fact]
    public void SharedMethodBareCall_NoCollision_StillResolvesOwnSharedSibling()
    {
        // Negative control mirroring issue #1585: with no package-level
        // homonym at all, the bare call already resolved correctly. This
        // guards against the #3527 fix breaking the non-colliding case.
        var tree = SyntaxTree.Parse(SourceText.From("""
            package NoCollision

            class Checks {
              shared {
                private var count int32

                private func check() {
                  count++
                }

                public func Run() int32 {
                  check()
                  return count
                }
              }
            }
            """));

        var compilation = new Compilation(tree);
        var program = compilation.BoundProgram;
        Assert.Empty(program.Diagnostics.Where(d => d.IsError));

        var checksStruct = program.Structs.Single(s => s.Name == "Checks");
        var runMethod = checksStruct.StaticMethods.Single(m => m.Name == "Run");
        var body = program.Functions[runMethod];

        var callStatement = (BoundExpressionStatement)body.Statements[0];
        var call = Assert.IsType<BoundCallExpression>(callStatement.Expression);

        Assert.Same(checksStruct, call.Function.StaticOwnerType);
    }
}
