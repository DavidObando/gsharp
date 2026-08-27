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

    [Fact]
    public void InstanceMethodBareCall_LocalGenericFunctionCollidingWithSiblingMember_LexicalShadowingWins()
    {
        // Regression for a Copilot review comment on PR #3588: a GENERIC
        // LOCAL function (`let Name[T] = func (...) ... { ... }`) is
        // declared into the very same scope symbol table as a package
        // function (LambdaBinder.BindGenericLocalFunctionDeclaration ->
        // Scope.TryDeclareFunction), but — unlike a real package function —
        // is built with the no-package FunctionSymbol constructor, so its
        // Package is null. The #3527 fix must key off Package != null so it
        // never redirects this call away from ordinary lexical shadowing: a
        // local function of the same name must still win over a sibling
        // instance member. If it didn't, `Helper(41)` below would silently
        // rebind to the sibling `Helper(int32)` member and return 42.
        var tree = SyntaxTree.Parse(SourceText.From("""
            package LocalFunctionShadowsMember

            class Widget {
                private func Helper(v int32) int32 { return v + 1 }

                func Run() int32 {
                    let Helper[T] = func (v T) T { return v }
                    return Helper(41)
                }
            }
            """));

        var compilation = new Compilation(tree);
        var program = compilation.BoundProgram;
        Assert.Empty(program.Diagnostics.Where(d => d.IsError));

        var widgetStruct = program.Structs.Single(s => s.Name == "Widget");
        var siblingHelper = widgetStruct.Methods.Single(m => m.Name == "Helper");
        var runMethod = widgetStruct.Methods.Single(m => m.Name == "Run");
        var body = program.Functions[runMethod];

        // Bound as a free-function call (the local function, correct) if
        // lexical shadowing wins, or as a `this.Helper(...)`
        // BoundUserInstanceCallExpression (the sibling member, the bug) if
        // it doesn't — resolve whichever shape was actually emitted so the
        // assertion below catches either outcome.
        var resolvedFunction = FindResolvedFunction(body, "Helper");
        Assert.NotNull(resolvedFunction);

        // The local function has no owning package/type at all, unlike the
        // sibling `Helper(int32)` instance member.
        Assert.Null(resolvedFunction.Package);
        Assert.NotSame(siblingHelper, resolvedFunction);
    }

    private static FunctionSymbol FindResolvedFunction(BoundStatement body, string name)
    {
        var collector = new CallCollector(name);
        collector.Visit(body);
        return collector.Result;
    }

    private sealed class CallCollector : BoundTreeWalker
    {
        private readonly string name;

        public CallCollector(string name)
        {
            this.name = name;
        }

        public FunctionSymbol Result { get; private set; }

        protected override void VisitCallExpression(BoundCallExpression node)
        {
            if (node.Function.Name == name)
            {
                Result = node.Function;
            }

            base.VisitCallExpression(node);
        }

        protected override void VisitUserInstanceCallExpression(BoundUserInstanceCallExpression node)
        {
            if (node.Method.Name == name)
            {
                Result = node.Method;
            }

            base.VisitUserInstanceCallExpression(node);
        }
    }
}
