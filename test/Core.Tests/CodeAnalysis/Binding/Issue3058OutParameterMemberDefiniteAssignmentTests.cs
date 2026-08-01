// <copyright file="Issue3058OutParameterMemberDefiniteAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3058: out-parameter definite assignment must run for every function
/// body, not only top-level functions.
/// </summary>
public class Issue3058OutParameterMemberDefiniteAssignmentTests
{
    [Fact]
    public void TopLevelFunction_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.TopLevel
            func TryIt(x int32, out r int32) bool { return true }
            """);
    }

    [Fact]
    public void ClassSharedMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.ClassShared
            class Holder {
                shared {
                    func TryIt(x int32, out r int32) bool { return true }
                }
            }
            """);
    }

    [Fact]
    public void ClassInstanceMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.ClassInstance
            class Holder {
                func TryIt(x int32, out r int32) bool { return true }
            }
            """);
    }

    [Fact]
    public void StructInstanceMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.StructInstance
            struct Holder {
                func TryIt(x int32, out r int32) bool { return true }
            }
            """);
    }

    [Fact]
    public void DataStructInstanceMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.DataStructInstance
            data struct Holder {
                func TryIt(x int32, out r int32) bool { return true }
            }
            """);
    }

    [Fact]
    public void DefaultInterfaceMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.DefaultInterface
            interface IHolder {
                func TryIt(x int32, out r int32) bool { return true }
            }
            """);
    }

    [Fact]
    public void NestedClassMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.NestedClass
            class Outer {
                class Holder {
                    func TryIt(x int32, out r int32) bool { return true }
                }
            }
            """);
    }

    [Fact]
    public void LocalFunction_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.LocalFunction
            func Outer() {
                let TryIt[T] = func (x T, out r int32) bool { return true }
            }
            """);
    }

    [Fact]
    public void Lambda_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.Lambda
            type TryDelegate = delegate func(x int32, out r int32) bool
            func Outer() {
                let tryIt TryDelegate = (x int32, out r int32) -> { return true }
            }
            """);
    }

    [Fact]
    public void GenericClassMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.GenericClass
            class Holder[T] {
                func TryIt(x T, out r int32) bool { return true }
            }
            """);
    }

    [Fact]
    public void ExtensionFunction_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.Extension
            func (s string) TryIt(x int32, out r int32) bool { return true }
            """);
    }

    [Fact]
    public void StructSharedMethod_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.StructShared
            struct Holder {
                shared {
                    func TryIt(x int32, out r int32) bool { return true }
                }
            }
            """);
    }

    [Fact]
    public void Constructor_MissingAssignment_ReportsGS0238()
    {
        AssertSingleGS0238("""
            package Issue3058.Constructor
            class Holder {
                init(out r int32) { }
            }
            """);
    }

    [Fact]
    public void ClassSharedMethod_IfElseAssignsDistinctValues_NoError()
    {
        AssertNoErrors("""
            package Issue3058.ValidSharedIfElse
            class Holder {
                shared {
                    func TryIt(cond bool, out r int32) bool {
                        if cond { r = 11 } else { r = 22 }
                        return true
                    }
                }
            }
            """);
    }

    [Fact]
    public void ClassInstanceMethod_SwitchAssignsDistinctValues_NoError()
    {
        AssertNoErrors("""
            package Issue3058.ValidInstanceSwitch
            enum Choice { A, B }
            class Holder {
                func TryIt(choice Choice, out r int32) bool {
                    switch choice {
                        case Choice.A { r = 22 }
                        case Choice.B { r = 33 }
                        default { r = 44 }
                    }
                    return true
                }
            }
            """);
    }

    [Fact]
    public void DataStructMethod_EarlyReturnAssignsDistinctValues_NoError()
    {
        AssertNoErrors("""
            package Issue3058.ValidStructReturn
            data struct Holder {
                func TryIt(cond bool, out r int32) bool {
                    if cond {
                        r = 33
                        return true
                    }

                    r = 44
                    return false
                }
            }
            """);
    }

    [Fact]
    public void StructSharedMethod_LoopPreservesAssignment_NoError()
    {
        AssertNoErrors("""
            package Issue3058.ValidSharedLoop
            struct Holder {
                shared {
                    func TryIt(limit int32, out r int32) bool {
                        r = 55
                        var i = 0
                        for i < limit {
                            r = r + 1
                            i = i + 1
                        }
                        return true
                    }
                }
            }
            """);
    }

    [Fact]
    public void ClassSharedMethod_ImportedOutCallAssignsParameter_NoError()
    {
        AssertNoErrors("""
            package Issue3058.ValidImportedOut
            import System

            enum Choice { A, B }
            class Holder {
                shared {
                    func TryIt(text string?, out choice Choice) bool {
                        if text == nil {
                            choice = Choice.A
                            return false
                        }

                        return Enum.TryParse(text, true, &choice)
                    }
                }
            }
            """);
    }

    private static EvaluationResult Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree).Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static void AssertSingleGS0238(string source)
    {
        var errors = Compile(source).Diagnostics.Where(d => d.IsError).ToArray();
        var diagnostic = Assert.Single(errors);
        Assert.Equal("GS0238", diagnostic.Id);
    }

    private static void AssertNoErrors(string source)
    {
        Assert.DoesNotContain(Compile(source).Diagnostics, d => d.IsError);
    }
}
